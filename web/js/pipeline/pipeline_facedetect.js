/**
 * pipeline_facedetect.js — YOLOv8-face (ONNX Runtime Web) 기반 자동 얼굴 마스킹
 *
 * ── 다운로드 필요 파일 (2개) ──
 *   1) ONNX Runtime Web (로컬):
 *      https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort.min.js
 *      https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort-wasm-simd.wasm
 *      → web/js/ort.min.js
 *      → web/js/ort-wasm-simd.wasm
 *
 *   2) YOLOv8-face 모델:
 *      https://github.com/akanametov/yolo-face/releases/download/v0.0.0/yolov8n-face.onnx
 *      → web/models/yolov8-face/yolov8n-face.onnx
 *      (경량 n 버전: 6MB, 정확도 충분)
 *      더 높은 정확도 원하면 yolov8s-face.onnx (22MB) 사용
 *
 * ── 서버 경로 (실제 프로젝트 구조에 맞춤: static 없음) ──
 *   ORT_JS_URL   : /assetmanager/js/ort.min.js
 *   ORT_WASM_URL : /assetmanager/js/  (wasm 파일 위치 디렉토리)
 *   MODEL_URL    : /assetmanager/models/yolov8-face/yolov8n-face.onnx
 */

(function () {
    let _session = null;
    let _sessionLoading = false;

    // ── 커스텀 YOLO11 (다중 클래스 신체 부위 감지) ──
    let _customSession = null;
    let _customSessionLoading = false;
    let _lastCustomDetections = null;

    // ── 손/팔/발 전용 세션 ──
    let _handSession = null;
    let _handSessionLoading = false;
    let _feetSession = null;
    let _feetSessionLoading = false;

    let _lastDetections = null;
    let _lastImageEl    = null;
    let _maskMode = 'face';

    const ORT_JS_URL  = '/assetmanager/static/js/ort.min.js';
    const ORT_WASM_DIR = '/assetmanager/static/js/';
    const MODEL_URL   = '/assetmanager/static/models/yolov8-face/yolov8n-face.onnx';

    // ⚙️ 커스텀 YOLO11 모델 경로
    const CUSTOM_MODEL_URL = '/assetmanager/static/models/yolov8-face/yolo11m.onnx';

    // 손/팔/발 전용 모델 — 모델 확보 후 경로 교체
    const HAND_MODEL_URL = '/assetmanager/static/models/yolov8-face/yolov8n-hand.onnx';
    const FEET_MODEL_URL = '/assetmanager/static/models/yolov8-face/yolov8n-feet.onnx';

    // 감지할 클래스 인덱스 (0-based) — 5클래스 모델 [1, 9, 8400]
    // Class 3 = 하체, Class 4 = 골반
    const TARGET_CLASSES = [3, 4];
    // 손/팔: 단일 클래스 모델이면 [0], 다중이면 맞게 수정
    const HAND_CLASSES = [0];
    const FEET_CLASSES = [0];
    const CUSTOM_CONF_THRESH = 0.30;   // 커스텀 모델 confidence 임계값
    const CUSTOM_NMS_THRESH  = 0.45;   // NMS IoU 임계값

    // YOLOv8-face 입력 크기 (모델 고정값)
    const INPUT_W = 640;
    const INPUT_H = 640;

    /* ──────────────────────────────────────
       1. ORT + 모델 로드
       ────────────────────────────────────── */

    async function loadModel() {
        if (_session) return;
        if (_sessionLoading) {
            await new Promise(resolve => {
                const t = setInterval(() => { if (_session) { clearInterval(t); resolve(); } }, 100);
            });
            return;
        }
        _sessionLoading = true;

        setStatus('⏳ ORT 로딩 중...');
        await loadScript(ORT_JS_URL);

        // wasm 파일 위치 지정 (ort.min.js와 같은 디렉토리)
        ort.env.wasm.wasmPaths = ORT_WASM_DIR;

        setStatus('⏳ 모델 로딩 중...');
        _session = await ort.InferenceSession.create(MODEL_URL, {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all',
        });

        console.log('[FaceDetect] 모델 로드 완료. 입력:', _session.inputNames, '출력:', _session.outputNames);
        _sessionLoading = false;
    }

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
            const s = document.createElement('script');
            s.src = src;
            s.onload  = resolve;
            s.onerror = () => reject(new Error(`스크립트 로드 실패: ${src}`));
            document.head.appendChild(s);
        });
    }

    async function loadCustomModel() {
        if (_customSession) return;
        if (_customSessionLoading) {
            await new Promise(resolve => {
                const t = setInterval(() => { if (_customSession) { clearInterval(t); resolve(); } }, 100);
            });
            return;
        }
        _customSessionLoading = true;

        setStatus('⏳ ORT 로딩 중...');
        await loadScript(ORT_JS_URL);
        ort.env.wasm.wasmPaths = ORT_WASM_DIR;

        setStatus('⏳ 커스텀 모델 로딩 중...');
        _customSession = await ort.InferenceSession.create(CUSTOM_MODEL_URL, {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all',
        });

        console.log('[CustomYOLO] 모델 로드 완료. 입력:', _customSession.inputNames, '출력:', _customSession.outputNames);
        _customSessionLoading = false;
    }

    /* ──────────────────────────────────────
       2. 얼굴 감지
       ────────────────────────────────────── */

    async function detectAndMask() {
        const canvas = document.getElementById('inpaint-mask-canvas');
        const bgImg  = document.getElementById('inpaint-canvas-bg');

        const imgSrc = bgImg?.src || '';
        if (!imgSrc || imgSrc === window.location.href) {
            setStatus('❌ 먼저 원본 이미지를 선택해 주세요.');
            return;
        }
        if (!canvas) {
            setStatus('❌ 마스크 캔버스를 찾을 수 없습니다.');
            return;
        }

        try {
            setStatus('⏳ 모델 로딩 중...');
            await loadModel();
            setStatus('⏳ 얼굴 감지 중...');

            const imgEl = await createImageElement(bgImg.src);
            _lastImageEl = imgEl;

            const detections = await runYOLO(imgEl);

            if (!detections || detections.length === 0) {
                setStatus('⚠️ 얼굴을 감지하지 못했습니다. 직접 그려주세요.');
                return;
            }

            _lastDetections = detections;

            if (canvas.width  !== imgEl.naturalWidth ||
                canvas.height !== imgEl.naturalHeight) {
                canvas.width  = imgEl.naturalWidth;
                canvas.height = imgEl.naturalHeight;
            }

            drawMaskFromDetections(canvas, detections, imgEl, _maskMode);
            setStatus(`✅ ${detections.length}개 얼굴 감지 완료 — 부위 버튼으로 영역을 바꿀 수 있습니다`);
            window._inpaintUploadedMaskName = null;
            updateActiveBtn(_maskMode);

        } catch (e) {
            console.error('[FaceDetect]', e);
            setStatus(`❌ 오류: ${e.message}`);
        }
    }

    /* ──────────────────────────────────────
       3. YOLOv8-face 추론
       ────────────────────────────────────── */

    async function runYOLO(imgEl) {
        const W = imgEl.naturalWidth;
        const H = imgEl.naturalHeight;

        // ── 전처리: letterbox → Float32 tensor ──
        const { tensor, padX, padY, scale } = preprocess(imgEl);

        const inputName = _session.inputNames[0];
        const feeds = { [inputName]: new ort.Tensor('float32', tensor, [1, 3, INPUT_H, INPUT_W]) };

        const results = await _session.run(feeds);
        const outputName = _session.outputNames[0];
        const output = results[outputName].data;   // Float32Array
        const outShape = results[outputName].dims;  // [1, 5, 8400] or [1, 8400, 5]

        console.log('[FaceDetect] output shape:', outShape);

        // YOLOv8 출력: [1, 5, 8400] → 5 = cx,cy,w,h,conf
        // (face 클래스 하나뿐이므로 클래스 score 없음)
        const numDet  = outShape[2];  // 8400
        const stride  = outShape[1];  // 5

        const detections = [];
        for (let i = 0; i < numDet; i++) {
            const conf = output[4 * numDet + i];   // confidence
            if (conf < 0.35) continue;

            // cx, cy, w, h — 640x640 기준
            const cx = output[0 * numDet + i];
            const cy = output[1 * numDet + i];
            const bw = output[2 * numDet + i];
            const bh = output[3 * numDet + i];

            // letterbox 역변환 → 원본 좌표
            const x0 = ((cx - bw / 2) - padX) / scale;
            const y0 = ((cy - bh / 2) - padY) / scale;
            const x1 = ((cx + bw / 2) - padX) / scale;
            const y1 = ((cy + bh / 2) - padY) / scale;

            detections.push({ x0, y0, x1, y1, conf });
        }

        // NMS
        const kept = nms(detections, 0.45);

        console.log('[FaceDetect] NMS 후 얼굴 수:', kept.length,
            kept.map(d => `conf=${d.conf.toFixed(2)} x=${d.x0.toFixed(0)} y=${d.y0.toFixed(0)} w=${(d.x1-d.x0).toFixed(0)} h=${(d.y1-d.y0).toFixed(0)}`));

        return kept.map(d => ({
            box: {
                xMin:   Math.max(0, d.x0),
                yMin:   Math.max(0, d.y0),
                width:  Math.min(d.x1 - d.x0, W),
                height: Math.min(d.y1 - d.y0, H),
            },
            score: d.conf
        }));
    }

    /* ── 전처리: letterbox + CHW float32 ── */
    function preprocess(imgEl) {
        const W = imgEl.naturalWidth;
        const H = imgEl.naturalHeight;

        const scale = Math.min(INPUT_W / W, INPUT_H / H);
        const newW  = Math.round(W * scale);
        const newH  = Math.round(H * scale);
        const padX  = (INPUT_W - newW) / 2;
        const padY  = (INPUT_H - newH) / 2;

        // 오프스크린 캔버스에 letterbox 그리기
        const cvs = document.createElement('canvas');
        cvs.width  = INPUT_W;
        cvs.height = INPUT_H;
        const ctx = cvs.getContext('2d');
        ctx.fillStyle = '#7f7f7f';   // 회색 패딩 (YOLO 기본)
        ctx.fillRect(0, 0, INPUT_W, INPUT_H);
        ctx.drawImage(imgEl, padX, padY, newW, newH);

        const imageData = ctx.getImageData(0, 0, INPUT_W, INPUT_H).data;

        // RGBA → RGB CHW (채널 우선), 0~1 정규화
        const tensor = new Float32Array(3 * INPUT_W * INPUT_H);
        const pixels = INPUT_W * INPUT_H;
        for (let i = 0; i < pixels; i++) {
            tensor[0 * pixels + i] = imageData[i * 4 + 0] / 255;  // R
            tensor[1 * pixels + i] = imageData[i * 4 + 1] / 255;  // G
            tensor[2 * pixels + i] = imageData[i * 4 + 2] / 255;  // B
        }

        return { tensor, padX, padY, scale };
    }

    /* ── Non-Maximum Suppression ── */
    function nms(dets, iouThresh) {
        dets.sort((a, b) => b.conf - a.conf);
        const kept = [];
        const used = new Uint8Array(dets.length);
        for (let i = 0; i < dets.length; i++) {
            if (used[i]) continue;
            kept.push(dets[i]);
            for (let j = i + 1; j < dets.length; j++) {
                if (used[j]) continue;
                if (iou(dets[i], dets[j]) > iouThresh) used[j] = 1;
            }
        }
        return kept;
    }

    function iou(a, b) {
        const ix0 = Math.max(a.x0, b.x0), iy0 = Math.max(a.y0, b.y0);
        const ix1 = Math.min(a.x1, b.x1), iy1 = Math.min(a.y1, b.y1);
        const inter = Math.max(0, ix1 - ix0) * Math.max(0, iy1 - iy0);
        if (inter === 0) return 0;
        const aArea = (a.x1-a.x0)*(a.y1-a.y0);
        const bArea = (b.x1-b.x0)*(b.y1-b.y0);
        return inter / (aArea + bArea - inter);
    }

    async function loadHandModel() {
        if (_handSession) return;
        if (_handSessionLoading) {
            await new Promise(resolve => {
                const t = setInterval(() => { if (_handSession) { clearInterval(t); resolve(); } }, 100);
            });
            return;
        }
        _handSessionLoading = true;
        setStatus('⏳ 손/팔 모델 로딩 중...');
        await loadScript(ORT_JS_URL);
        ort.env.wasm.wasmPaths = ORT_WASM_DIR;
        _handSession = await ort.InferenceSession.create(HAND_MODEL_URL, {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all',
        });
        console.log('[HandYOLO] 모델 로드 완료');
        _handSessionLoading = false;
    }

    async function loadFeetModel() {
        if (_feetSession) return;
        if (_feetSessionLoading) {
            await new Promise(resolve => {
                const t = setInterval(() => { if (_feetSession) { clearInterval(t); resolve(); } }, 100);
            });
            return;
        }
        _feetSessionLoading = true;
        setStatus('⏳ 발 모델 로딩 중...');
        await loadScript(ORT_JS_URL);
        ort.env.wasm.wasmPaths = ORT_WASM_DIR;
        _feetSession = await ort.InferenceSession.create(FEET_MODEL_URL, {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all',
        });
        console.log('[FeetYOLO] 모델 로드 완료');
        _feetSessionLoading = false;
    }

    /* ──────────────────────────────────────
       3-b. 커스텀 YOLO11 추론 (다중 클래스)
            출력 형식: [1, num_classes+4, 8400]
            앞 4행: cx, cy, w, h
            이후 행: 클래스별 confidence
       ────────────────────────────────────── */

    async function runCustomYOLO(imgEl, session, targetClasses) {
        const W = imgEl.naturalWidth;
        const H = imgEl.naturalHeight;

        const { tensor, padX, padY, scale } = preprocess(imgEl);

        const inputName = session.inputNames[0];
        const feeds = { [inputName]: new ort.Tensor('float32', tensor, [1, 3, INPUT_H, INPUT_W]) };

        const results = await session.run(feeds);
        const outputName = session.outputNames[0];
        const output   = results[outputName].data;   // Float32Array
        const outShape = results[outputName].dims;    // [1, num_cls+4, 8400]

        console.log('[CustomYOLO] output shape:', outShape);

        // outShape: [1, rows, 8400]
        // rows = 4 (bbox) + num_classes
        const numDet    = outShape[2];          // 8400
        const numRows   = outShape[1];          // 4 + num_classes
        const numCls    = numRows - 4;

        const detections = [];

        for (let i = 0; i < numDet; i++) {
            const cx = output[0 * numDet + i];
            const cy = output[1 * numDet + i];
            const bw = output[2 * numDet + i];
            const bh = output[3 * numDet + i];

            // 각 클래스 confidence 확인 → TARGET_CLASSES만 통과
            let bestConf  = -1;
            let bestClass = -1;
            for (let c = 0; c < numCls; c++) {
                const conf = output[(4 + c) * numDet + i];
                if (targetClasses.includes(c) && conf > bestConf) {
                    bestConf  = conf;
                    bestClass = c;
                }
            }

            if (bestConf < CUSTOM_CONF_THRESH) continue;

            // letterbox 역변환 → 원본 좌표
            const x0 = ((cx - bw / 2) - padX) / scale;
            const y0 = ((cy - bh / 2) - padY) / scale;
            const x1 = ((cx + bw / 2) - padX) / scale;
            const y1 = ((cy + bh / 2) - padY) / scale;

            detections.push({ x0, y0, x1, y1, conf: bestConf, cls: bestClass });
        }

        // NMS (클래스별로 적용)
        const kept = nmsMultiClass(detections, CUSTOM_NMS_THRESH);

        console.log('[CustomYOLO] NMS 후 감지 수:', kept.length,
            kept.map(d => `cls=${d.cls} conf=${d.conf.toFixed(2)} x=${d.x0.toFixed(0)} y=${d.y0.toFixed(0)}`));

        return kept.map(d => ({
            box: {
                xMin:   Math.max(0, d.x0),
                yMin:   Math.max(0, d.y0),
                width:  Math.min(d.x1 - d.x0, W),
                height: Math.min(d.y1 - d.y0, H),
            },
            score: d.conf,
            cls:   d.cls,
        }));
    }

    /* 클래스별 NMS */
    function nmsMultiClass(dets, iouThresh) {
        // 클래스별로 분리해서 각각 NMS 적용 후 합치기
        const byClass = {};
        dets.forEach(d => {
            if (!byClass[d.cls]) byClass[d.cls] = [];
            byClass[d.cls].push(d);
        });
        const result = [];
        Object.values(byClass).forEach(clsDets => {
            nms(clsDets, iouThresh).forEach(d => result.push(d));
        });
        return result;
    }

    /* ── 커스텀 YOLO11 감지 → 마스킹 진입점 ── */
    async function detectAndMaskPelvis() {
        const canvas = document.getElementById('inpaint-mask-canvas');
        const bgImg  = document.getElementById('inpaint-canvas-bg');

        const imgSrc = bgImg?.src || '';
        if (!imgSrc || imgSrc === window.location.href) {
            setStatus('❌ 먼저 원본 이미지를 선택해 주세요.');
            return;
        }
        if (!canvas) {
            setStatus('❌ 마스크 캔버스를 찾을 수 없습니다.');
            return;
        }

        try {
            setStatus('⏳ 커스텀 모델 로딩 중...');
            await loadCustomModel();
            setStatus('⏳ 하체/골반 감지 중...');

            const imgEl = await createImageElement(bgImg.src);
            _lastImageEl = imgEl;

            const detections = await runCustomYOLO(imgEl, _customSession, TARGET_CLASSES);
            _lastCustomDetections = detections;

            if (!detections || detections.length === 0) {
                setStatus('⚠️ 하체/골반 영역을 감지하지 못했습니다. 직접 그려주세요.');
                return;
            }

            if (canvas.width  !== imgEl.naturalWidth ||
                canvas.height !== imgEl.naturalHeight) {
                canvas.width  = imgEl.naturalWidth;
                canvas.height = imgEl.naturalHeight;
            }

            drawCustomMask(canvas, detections, imgEl);
            setStatus(`✅ ${detections.length}개 영역 감지 완료 (Class 3/4)`);
            window._inpaintUploadedMaskName = null;
            updateActiveBtn('pelvis');

        } catch (e) {
            console.error('[CustomYOLO]', e);
            if (e.message && e.message.includes('fetch')) {
                setStatus(`❌ 모델 파일을 찾을 수 없습니다: ${CUSTOM_MODEL_URL}`);
            } else {
                setStatus(`❌ 오류: ${e.message}`);
            }
        }
    }

    /* ── 손/팔 감지 → 마스킹 ── */
    async function detectAndMaskHands() {
        const label = '손/팔';
        await _detectAndMaskWithModel(
            HAND_MODEL_URL, _handSession, loadHandModel,
            HAND_CLASSES, label, 'hands',
            (sess) => { _handSession = sess; }
        );
    }

    /* ── 팔 감지 → 손과 같은 모델 사용, 박스 상단 확장으로 팔 영역 포함 ── */
    async function detectAndMaskArms() {
        await _detectAndMaskWithModel(
            HAND_MODEL_URL, _handSession, loadHandModel,
            HAND_CLASSES, '팔', 'arms',
            (sess) => { _handSession = sess; },
            { expandTop: 3.0 }   // 손 박스 위로 3배 확장 → 팔 포함
        );
    }

    /* ── 발 감지 → 마스킹 ── */
    async function detectAndMaskFeet() {
        await _detectAndMaskWithModel(
            FEET_MODEL_URL, _feetSession, loadFeetModel,
            FEET_CLASSES, '발', 'feet',
            (sess) => { _feetSession = sess; }
        );
    }

    /* 공통 감지+마스킹 헬퍼 */
    async function _detectAndMaskWithModel(modelUrl, session, loaderFn, classes, label, btnKey, sessionSetter, opts) {
        const canvas = document.getElementById('inpaint-mask-canvas');
        const bgImg  = document.getElementById('inpaint-canvas-bg');
        const imgSrc = bgImg?.src || '';
        if (!imgSrc || imgSrc === window.location.href) {
            setStatus('❌ 먼저 원본 이미지를 선택해 주세요.');
            return;
        }
        try {
            setStatus(`⏳ ${label} 모델 로딩 중...`);
            await loaderFn();
            // loaderFn 실행 후 세션이 채워졌을 수 있으므로 최신 참조 사용
            const activeSession = session || (btnKey === 'hands' || btnKey === 'arms' ? _handSession : _feetSession);
            setStatus(`⏳ ${label} 감지 중...`);
            const imgEl = await createImageElement(bgImg.src);
            _lastImageEl = imgEl;
            const detections = await runCustomYOLO(imgEl, activeSession, classes);
            if (!detections || detections.length === 0) {
                setStatus(`⚠️ ${label} 영역을 감지하지 못했습니다. 직접 그려주세요.`);
                return;
            }
            if (canvas.width !== imgEl.naturalWidth || canvas.height !== imgEl.naturalHeight) {
                canvas.width  = imgEl.naturalWidth;
                canvas.height = imgEl.naturalHeight;
            }
            // opts.expandTop: 박스 위쪽으로 N배 확장 (팔 모드)
            const expanded = opts?.expandTop
                ? detections.map(d => ({
                    ...d,
                    box: {
                        ...d.box,
                        yMin:   Math.max(0, d.box.yMin - d.box.height * opts.expandTop),
                        height: d.box.height * (1 + opts.expandTop),
                    }
                  }))
                : detections;
            drawCustomMask(canvas, expanded, imgEl);
            setStatus(`✅ ${detections.length}개 ${label} 영역 감지 완료`);
            window._inpaintUploadedMaskName = null;
            updateActiveBtn(btnKey);
        } catch (e) {
            console.error(`[${label}YOLO]`, e);
            if (e.message?.includes('fetch') || e.message?.includes('404') || e.message?.includes('load')) {
                setStatus(`❌ ${label} 모델 파일 없음: ${modelUrl} — 모델을 해당 경로에 넣어주세요`);
            } else {
                setStatus(`❌ ${label} 감지 오류: ${e.message}`);
            }
        }
    }

    /* 감지된 박스를 흰색 마스크로 그리기 */
    function drawCustomMask(canvas, detections, imgEl) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const scaleX = canvas.width  / imgEl.naturalWidth;
        const scaleY = canvas.height / imgEl.naturalHeight;

        detections.forEach(det => {
            const box = det.box;
            const w   = Math.abs(box.width)  * scaleX;
            const h   = Math.abs(box.height) * scaleY;
            const x   = box.xMin * scaleX;
            const y   = box.yMin * scaleY;
            const cx  = x + w / 2;
            const cy  = y + h / 2;
            const rx  = Math.max(1, w / 2 * 1.05);
            const ry  = Math.max(1, h / 2 * 1.05);

            drawSoftRect(ctx, x, y, w, h, 18);
        });
    }



    function drawMaskFromDetections(canvas, detections, imgEl, mode) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const scaleX = canvas.width  / imgEl.naturalWidth;
        const scaleY = canvas.height / imgEl.naturalHeight;

        detections.forEach(det => {
            if (mode === 'face') drawFaceMask(ctx, det, scaleX, scaleY);
            else                 drawHeadMask(ctx, det, scaleX, scaleY);
        });
    }

    function drawFaceMask(ctx, det, scaleX, scaleY) {
        const box = det.box;
        const w   = Math.abs(box.width);
        const h   = Math.abs(box.height);
        const cx  = (box.xMin + w / 2) * scaleX;
        const cy  = (box.yMin + h / 2) * scaleY;
        const rx  = Math.max(1, (w / 2) * scaleX * 1.15);
        const ry  = Math.max(1, (h / 2) * scaleY * 1.20);

        ctx.save();
        ctx.filter = 'blur(14px)';
        ctx.fillStyle = 'rgba(255,255,255,1)';
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.filter = 'blur(4px)';
        ctx.fillStyle = 'rgba(255,255,255,1)';
        ctx.beginPath();
        ctx.ellipse(cx, cy, Math.max(1, rx * 0.85), Math.max(1, ry * 0.85), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    function drawHeadMask(ctx, det, scaleX, scaleY) {
        const box = det.box;
        const w   = Math.abs(box.width);
        const h   = Math.abs(box.height);
        const cx  = (box.xMin + w / 2) * scaleX;
        const cy  = (box.yMin + h / 2) * scaleY;
        const rx  = (w / 2) * scaleX;
        const ry  = (h / 2) * scaleY;

        const finalRx  = Math.max(1, rx + rx * 0.55);
        const finalRyT = ry + ry * 1.20;
        const finalRyB = ry + ry * 0.25;
        const avgRy    = Math.max(1, (finalRyT + finalRyB) / 2);
        const offY     = (finalRyT - finalRyB) / 2;

        ctx.save();
        ctx.filter = 'blur(22px)';
        ctx.fillStyle = 'rgba(255,255,255,1)';
        ctx.beginPath();
        ctx.ellipse(cx, cy - offY, finalRx, avgRy, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.filter = 'blur(8px)';
        ctx.fillStyle = 'rgba(255,255,255,1)';
        ctx.beginPath();
        ctx.ellipse(cx, cy - offY, Math.max(1, finalRx * 0.9), Math.max(1, avgRy * 0.9), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    /* ──────────────────────────────────────
       5. 모드 전환 + 신체 부위 마스킹
       ────────────────────────────────────── */

    function switchMode(mode) {
        _maskMode = mode;
        if (_lastDetections && _lastImageEl) {
            const canvas = document.getElementById('inpaint-mask-canvas');
            if (canvas) {
                applyBodyPartMask(mode, canvas, _lastDetections, _lastImageEl);
                window._inpaintUploadedMaskName = null;
            }
        } else {
            setStatus('⚠️ 먼저 "얼굴 감지"를 실행하세요 (얼굴 기반 모드)');
        }
        updateActiveBtn(mode);
    }

    function updateModeButtons() {
        updateActiveBtn(_maskMode);
    }

    /* 얼굴 박스 기준 신체 부위 마스킹
       전신 높이 = 얼굴 높이 × 9 로 추정, 각 부위는 전신 비율로 계산 */
    function applyBodyPartMask(part, canvas, detections, imgEl) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const W = canvas.width, H = canvas.height;
        const scaleX = W / imgEl.naturalWidth;
        const scaleY = H / imgEl.naturalHeight;

        detections.forEach(det => {
            const box = det.box;
            const fx  = box.xMin * scaleX;
            const fy  = box.yMin * scaleY;
            const fw  = Math.abs(box.width)  * scaleX;
            const fh  = Math.abs(box.height) * scaleY;
            const fcx = fx + fw / 2;

            // 전신 추정: 머리꼭대기~발끝
            const bodyTop    = fy - fh * 1.5;
            const bodyHeight = fh * 9;

            // 부위별 전신 비율 (yTop ~ yBot)
            const zones = {
                face:  { ellipse: true, yTop: 0.17, yBot: 0.27, rx: fw * 0.55, ry: fh * 0.60 },
                head:  { ellipse: true, yTop: 0.00, yBot: 0.22, rx: fw * 0.75, ry: fh * 1.10 },
                neck:  { yTop: 0.22, yBot: 0.30 },
                chest: { yTop: 0.30, yBot: 0.50 },
                waist: { yTop: 0.48, yBot: 0.60 },
                lower: { yTop: 0.58, yBot: 0.75 },
                legs:  { yTop: 0.70, yBot: 1.00 },
            };
            const zone = zones[part];
            if (!zone) return;

            const zTop = bodyTop + bodyHeight * zone.yTop;
            const zBot = bodyTop + bodyHeight * zone.yBot;
            const zh   = zBot - zTop;
            const zcy  = zTop + zh / 2;

            if (zone.ellipse) {
                drawSoftEllipse(ctx, fcx, zcy, zone.rx, zone.ry, 12);
            } else {
                const halfW = Math.min(fw * 1.0, W / 2);
                drawSoftRect(ctx, Math.max(0, fcx - halfW), zTop,
                             Math.min(W, fcx + halfW) - Math.max(0, fcx - halfW), zh, 20);
            }
        });

        window._inpaintUploadedMaskName = null;
        const labels = { face:'😊 얼굴', head:'🗣 머리', neck:'목·쇄골',
                         chest:'가슴', waist:'허리', lower:'하체', legs:'다리' };
        setStatus(`✅ ${labels[part] || part} 마스킹 완료 (${detections.length}명 기준)`);
    }

    function drawSoftEllipse(ctx, cx, cy, rx, ry, blur) {
        ctx.save();
        ctx.filter = `blur(${blur}px)`;
        ctx.fillStyle = 'rgba(255,255,255,1)';
        ctx.beginPath();
        ctx.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        ctx.save();
        ctx.filter = `blur(${Math.max(2, blur * 0.25)}px)`;
        ctx.fillStyle = 'rgba(255,255,255,1)';
        ctx.beginPath();
        ctx.ellipse(cx, cy, Math.max(1, rx * 0.8), Math.max(1, ry * 0.8), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    function drawSoftRect(ctx, x, y, w, h, blur) {
        const r = Math.min(w, h) * 0.15;
        ctx.save();
        ctx.filter = `blur(${blur}px)`;
        ctx.fillStyle = 'rgba(255,255,255,1)';
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, r);
        ctx.fill();
        ctx.restore();
        ctx.save();
        ctx.filter = `blur(${Math.max(2, blur * 0.3)}px)`;
        ctx.fillStyle = 'rgba(255,255,255,1)';
        const pw = w * 0.85, ph = h * 0.85;
        ctx.beginPath();
        ctx.roundRect(x + (w - pw) / 2, y + (h - ph) / 2, pw, ph, r);
        ctx.fill();
        ctx.restore();
    }

    /* 비율 기반 존 마스킹 (얼굴 감지 불필요) */
    function applyZoneMask(zone) {
        const canvas = document.getElementById('inpaint-mask-canvas');
        if (!canvas || canvas.width === 0) {
            setStatus('❌ 먼저 원본 이미지를 선택해 주세요.');
            return;
        }
        const W = canvas.width, H = canvas.height;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, W, H);

        const defs = {
            upper:  [0, 0, 1, 0.55],
            lower:  [0, 0.45, 1, 0.55],
            center: [0.1, 0.30, 0.8, 0.40],
            bg:     [0, 0, 1, 1],
            left:   [0, 0, 0.5, 1],
            right:  [0.5, 0, 0.5, 1],
        };
        const d = defs[zone];
        if (!d) return;

        if (zone === 'bg') {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, W, H);
        } else {
            drawSoftRect(ctx, d[0] * W, d[1] * H, d[2] * W, d[3] * H, 28);
        }

        window._inpaintUploadedMaskName = null;
        const labels = { upper:'상반신', lower:'하반신', center:'중앙', bg:'전체', left:'왼쪽', right:'오른쪽' };
        setStatus(`✅ ${labels[zone]} 영역 마스킹 완료`);
        updateActiveBtn(zone);
    }

    /* 활성 버튼 하이라이트 */
    const _allBtnIds = [
        'inpaint-face-mode-face','inpaint-face-mode-head',
        'inpaint-body-neck','inpaint-body-chest','inpaint-body-waist',
        'inpaint-body-lower','inpaint-body-legs',
        'inpaint-zone-upper','inpaint-zone-lower','inpaint-zone-center',
        'inpaint-zone-bg','inpaint-zone-left','inpaint-zone-right',
        'inpaint-custom-pelvis','inpaint-custom-hands',
        'inpaint-custom-arms','inpaint-custom-feet',
    ];
    function updateActiveBtn(key) {
        _allBtnIds.forEach(id => document.getElementById(id)?.classList.remove('active'));
        const idMap = {
            face:'inpaint-face-mode-face', head:'inpaint-face-mode-head',
            neck:'inpaint-body-neck', chest:'inpaint-body-chest',
            waist:'inpaint-body-waist', lower:'inpaint-body-lower', legs:'inpaint-body-legs',
            upper:'inpaint-zone-upper', lower_zone:'inpaint-zone-lower',
            center:'inpaint-zone-center', bg:'inpaint-zone-bg',
            left:'inpaint-zone-left', right:'inpaint-zone-right',
            pelvis:'inpaint-custom-pelvis',
            hands:'inpaint-custom-hands',
            arms:'inpaint-custom-arms',
            feet:'inpaint-custom-feet',
        };
        const targetId = idMap[key] ?? `inpaint-zone-${key}`;
        document.getElementById(targetId)?.classList.add('active');
    }

    /* ──────────────────────────────────────
       6. 유틸리티
       ────────────────────────────────────── */

    function setStatus(msg) {
        const el = document.getElementById('inpaint-face-status');
        if (el) el.textContent = msg;
        console.log('[FaceDetect]', msg);
    }

    function createImageElement(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload  = () => resolve(img);
            img.onerror = () => {
                const img2 = new Image();
                img2.onload  = () => resolve(img2);
                img2.onerror = () => reject(new Error('이미지 로드 실패'));
                img2.src = src;
            };
            img.src = src;
        });
    }

    /* ──────────────────────────────────────
       7. DOM 바인딩
       ────────────────────────────────────── */

    function bindUI() {
        document.getElementById('inpaint-autoface-btn')
            ?.addEventListener('click', detectAndMask);

        // 커스텀 YOLO11 — 하체/골반 감지 버튼
        document.getElementById('inpaint-custom-pelvis')
            ?.addEventListener('click', detectAndMaskPelvis);

        // 손/팔/발 감지 버튼
        document.getElementById('inpaint-custom-hands')
            ?.addEventListener('click', detectAndMaskHands);
        document.getElementById('inpaint-custom-arms')
            ?.addEventListener('click', detectAndMaskArms);
        document.getElementById('inpaint-custom-feet')
            ?.addEventListener('click', detectAndMaskFeet);

        // 얼굴 감지 기반 부위 버튼
        document.getElementById('inpaint-face-mode-face')
            ?.addEventListener('click', () => switchMode('face'));
        document.getElementById('inpaint-face-mode-head')
            ?.addEventListener('click', () => switchMode('head'));
        ['neck','chest','waist','lower','legs'].forEach(part => {
            document.getElementById(`inpaint-body-${part}`)
                ?.addEventListener('click', () => {
                    if (!_lastDetections?.length) {
                        setStatus('⚠️ 먼저 🎯 얼굴 감지를 실행하세요.');
                        return;
                    }
                    applyBodyPartMask(part, document.getElementById('inpaint-mask-canvas'),
                                      _lastDetections, _lastImageEl);
                    updateActiveBtn(part);
                });
        });

        // 비율 기반 존 버튼
        ['upper','lower','center','bg','left','right'].forEach(zone => {
            document.getElementById(`inpaint-zone-${zone}`)
                ?.addEventListener('click', () => applyZoneMask(zone));
        });

        updateModeButtons();

        // 해상도 동기화 버튼
        document.getElementById('inpaint-sync-size-btn')?.addEventListener('click', () => {
            const sel = document.getElementById('adv-dimensions');
            if (!sel) return;
            const match = sel.value.match(/(\d+)\s*[xX×]\s*(\d+)/);
            if (!match) return;
            const w = parseInt(match[1]), h = parseInt(match[2]);
            const wEl = document.getElementById('inpaint-img-width');
            const hEl = document.getElementById('inpaint-img-height');
            if (wEl) wEl.value = w;
            if (hEl) hEl.value = h;
            setStatus(`📐 크기 동기화: ${w} × ${h}`);
        });

        // 이미지 선택 시 실제 크기 자동 입력
        document.getElementById('inpaint-image-input')?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = () => {
                const wEl = document.getElementById('inpaint-img-width');
                const hEl = document.getElementById('inpaint-img-height');
                if (wEl) wEl.value = img.naturalWidth;
                if (hEl) hEl.value = img.naturalHeight;
                URL.revokeObjectURL(url);
            };
            img.src = url;
        }, true);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindUI);
    } else {
        bindUI();
    }

    document.addEventListener('DOMContentLoaded', () => {
        document.getElementById('inpaint-image-input')
            ?.addEventListener('change', () => {
                _lastDetections = null;
                _lastImageEl    = null;
                setStatus('');
            });
    });

})();
