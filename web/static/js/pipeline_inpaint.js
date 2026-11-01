/**
 * pipeline_inpaint.js — 인페인팅 파이프라인 모듈
 *
 * 원본 이미지를 업로드하고 캔버스에 마스크를 직접 그려서
 * VAEEncodeForInpaint를 통해 인페인팅을 수행한다.
 *
 * ── 마스크 흐름 ──
 *  1) 원본 이미지 선택 → <img id="inpaint-canvas-bg"> 에 미리보기
 *  2) <canvas id="inpaint-mask-canvas"> 에 흰색 브러시로 마스크 드로잉
 *  3) 생성 직전 자동 업로드 (또는 버튼으로 미리 업로드) → /upload/image
 *  4) LoadImage(원본) + LoadImageMask(마스크) → VAEEncodeForInpaint
 *
 * HTML에 필요한 요소 (index.html에 추가):
 *  #toggle-inpaint           체크박스
 *  #inpaint-image-input      file input (원본 이미지)
 *  #inpaint-mask-canvas      <canvas> — 마스크 드로잉 영역
 *  #inpaint-canvas-bg        <img>    — 원본 이미지 미리보기 (캔버스 뒤에 겹침)
 *  #inpaint-brush-size       range/number, 기본 30
 *  #inpaint-brush-hardness   range/number, 0~1, 기본 0.85
 *  #inpaint-clear-mask       button — 마스크 초기화
 *  #inpaint-upload-mask-btn  button — 마스크 미리 업로드 (선택)
 *  #inpaint-mask-status      span   — 마스크 업로드 상태 표시
 *  #inpaint-denoise          range/number, 기본 0.75
 *  #inpaint-grow-mask        number, 기본 6
 *  #inpaint-upload-status    span   — 원본 이미지 업로드 상태
 *  #inpaint-image-name       span   — 원본 파일명 표시
 *  #inpaint-preview-wrap     div    — 미리보기 래퍼
 *  #inpaint-preview-img      img    — 원본 미리보기
 *  #inpaint-image-clear      button — 원본 이미지 초기화
 */

/* ────────────────────────────────────────────
   1. 업로드 헬퍼
   ──────────────────────────────────────────── */

/**
 * File 또는 Blob을 ComfyUI /upload/image 로 전송.
 * @param {File|Blob} fileOrBlob
 * @param {string} [filename]  Blob 전송 시 사용할 파일명
 * @returns {Promise<string>}  서버 측 파일명
 */
async function uploadInpaintImage(fileOrBlob, filename) {
    const formData = new FormData();
    if (fileOrBlob instanceof File) {
        formData.append("image", fileOrBlob);
    } else {
        formData.append("image", fileOrBlob, filename || "inpaint_mask.png");
    }
    formData.append("type", "input");
    formData.append("overwrite", "true");

    const res = await fetch("/upload/image", { method: "POST", body: formData });
    if (!res.ok) throw new Error(`Inpaint 이미지 업로드 실패 (HTTP ${res.status})`);
    const data = await res.json();
    if (!data.name) throw new Error("Inpaint 업로드 응답에 name이 없습니다.");
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}
window.uploadInpaintImage = uploadInpaintImage;

/* ────────────────────────────────────────────
   2. 캔버스 마스크 드로잉
   ──────────────────────────────────────────── */

(function initInpaintCanvas() {
    let painting = false;
    let lastX = 0, lastY = 0;

    function getCanvas() { return document.getElementById('inpaint-mask-canvas'); }
    function getBrushSize() {
        return parseFloat(document.getElementById('inpaint-brush-size')?.value || '30');
    }
    function getBrushHardness() {
        return parseFloat(document.getElementById('inpaint-brush-hardness')?.value || '0.85');
    }

    function loadImageToCanvas(file) {
        if (!file) return;
        const url = URL.createObjectURL(file);
        const bgImg = document.getElementById('inpaint-canvas-bg');
        if (bgImg) bgImg.src = url;

        const img = new Image();
        img.onload = () => {
            const canvas = getCanvas();
            if (!canvas) return;
            canvas.width  = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
            window._inpaintUploadedMaskName = null;
            const maskStatus = document.getElementById('inpaint-mask-status');
            if (maskStatus) maskStatus.textContent = '';
        };
        img.src = url;
    }
    window._inpaintLoadImageToCanvas = loadImageToCanvas;

    function drawAt(canvas, x, y, size, hardness) {
        const ctx = canvas.getContext('2d');
        const r = size / 2;
        const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
        const hardStop = Math.min(hardness * 0.95, 0.99);
        grad.addColorStop(0,         'rgba(255,255,255,1)');
        grad.addColorStop(hardStop,  'rgba(255,255,255,1)');
        grad.addColorStop(1,         'rgba(255,255,255,0)');
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    }

    function canvasPos(canvas, e) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width  / rect.width;
        const scaleY = canvas.height / rect.height;
        const src = e.touches ? e.touches[0] : e;
        return {
            x: (src.clientX - rect.left) * scaleX,
            y: (src.clientY - rect.top)  * scaleY
        };
    }

    function onPointerDown(e) {
        e.preventDefault();
        painting = true;
        const canvas = getCanvas();
        if (!canvas) return;
        const { x, y } = canvasPos(canvas, e);
        lastX = x; lastY = y;
        drawAt(canvas, x, y, getBrushSize(), getBrushHardness());
        window._inpaintUploadedMaskName = null;
    }

    function onPointerMove(e) {
        if (!painting) return;
        e.preventDefault();
        const canvas = getCanvas();
        if (!canvas) return;
        const { x, y } = canvasPos(canvas, e);
        const dist  = Math.hypot(x - lastX, y - lastY);
        const steps = Math.max(1, Math.ceil(dist / (getBrushSize() * 0.2)));
        for (let i = 1; i <= steps; i++) {
            const ix = lastX + (x - lastX) * i / steps;
            const iy = lastY + (y - lastY) * i / steps;
            drawAt(canvas, ix, iy, getBrushSize(), getBrushHardness());
        }
        lastX = x; lastY = y;
        window._inpaintUploadedMaskName = null;
    }

    function onPointerUp() { painting = false; }

    function bindCanvasEvents() {
        const canvas = getCanvas();
        if (!canvas || canvas._inpaintBound) return;
        canvas._inpaintBound = true;
        canvas.addEventListener('mousedown',  onPointerDown, { passive: false });
        canvas.addEventListener('mousemove',  onPointerMove, { passive: false });
        canvas.addEventListener('mouseup',    onPointerUp);
        canvas.addEventListener('mouseleave', onPointerUp);
        canvas.addEventListener('touchstart', onPointerDown, { passive: false });
        canvas.addEventListener('touchmove',  onPointerMove, { passive: false });
        canvas.addEventListener('touchend',   onPointerUp);
    }

    function bindUI() {
        const fileInput = document.getElementById('inpaint-image-input');

        fileInput?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            window._inpaintUploadedName = null;
            window._inpaintUploadedMaskName = null;
            loadImageToCanvas(file);
            const nameEl = document.getElementById('inpaint-image-name');
            if (nameEl) nameEl.textContent = file.name;
            const statusEl = document.getElementById('inpaint-upload-status');
            if (statusEl) statusEl.textContent = '⏳ 생성 시 자동 업로드됩니다';
            const previewWrap = document.getElementById('inpaint-preview-wrap');
            if (previewWrap) previewWrap.style.display = 'block';
            const previewImg = document.getElementById('inpaint-preview-img');
            if (previewImg) previewImg.src = URL.createObjectURL(file);
            const clearBtn = document.getElementById('inpaint-image-clear');
            if (clearBtn) clearBtn.style.display = 'inline-block';
        });

        document.getElementById('inpaint-image-clear')?.addEventListener('click', () => {
            window._inpaintUploadedName = null;
            window._inpaintUploadedMaskName = null;
            if (fileInput) fileInput.value = '';
            const nameEl    = document.getElementById('inpaint-image-name');
            if (nameEl) nameEl.textContent = '선택된 파일 없음';
            const statusEl  = document.getElementById('inpaint-upload-status');
            if (statusEl) statusEl.textContent = '';
            const previewWrap = document.getElementById('inpaint-preview-wrap');
            if (previewWrap) previewWrap.style.display = 'none';
            const previewImg = document.getElementById('inpaint-preview-img');
            if (previewImg) previewImg.src = '';
            const bgImg     = document.getElementById('inpaint-canvas-bg');
            if (bgImg) bgImg.src = '';
            const canvas    = getCanvas();
            if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
            const maskStatus = document.getElementById('inpaint-mask-status');
            if (maskStatus) maskStatus.textContent = '';
            const clearBtn  = document.getElementById('inpaint-image-clear');
            if (clearBtn) clearBtn.style.display = 'none';
        });

        document.getElementById('inpaint-clear-mask')?.addEventListener('click', () => {
            const canvas = getCanvas();
            if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
            window._inpaintUploadedMaskName = null;
            const maskStatus = document.getElementById('inpaint-mask-status');
            if (maskStatus) maskStatus.textContent = '';
        });

        document.getElementById('inpaint-upload-mask-btn')?.addEventListener('click', async () => {
            const maskStatus = document.getElementById('inpaint-mask-status');
            if (maskStatus) maskStatus.textContent = '⏳ 마스크 업로드 중...';
            try {
                const name = await exportAndUploadMask();
                if (maskStatus) maskStatus.textContent = `✅ 마스크 업로드 완료: ${name}`;
            } catch (e) {
                if (maskStatus) maskStatus.textContent = `❌ 마스크 업로드 실패: ${e.message}`;
            }
        });

        bindCanvasEvents();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindUI);
    } else {
        bindUI();
    }
})();

/* ────────────────────────────────────────────
   3. 마스크 내보내기 + 업로드
   ──────────────────────────────────────────── */

/**
 * 캔버스를 흑백 PNG로 변환(투명→검정, 흰색 브러시→흰색) 후 업로드.
 * ComfyUI LoadImageMask channel:"red" 기준
 *   흰색(255) = 마스킹(재생성), 검정(0) = 보존
 *
 * @returns {Promise<string>} 업로드된 마스크 파일명
 */
async function exportAndUploadMask() {
    const canvas = document.getElementById('inpaint-mask-canvas');
    if (!canvas) throw new Error("마스크 캔버스를 찾을 수 없습니다.");

    const flat = document.createElement('canvas');
    flat.width  = canvas.width;
    flat.height = canvas.height;
    const ctx   = flat.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, flat.width, flat.height);
    ctx.drawImage(canvas, 0, 0);

    return new Promise((resolve, reject) => {
        flat.toBlob(async (blob) => {
            if (!blob) { reject(new Error("마스크 PNG 변환 실패")); return; }
            try {
                const name = await uploadInpaintImage(blob, `inpaint_mask_${Date.now()}.png`);
                window._inpaintUploadedMaskName = name;
                resolve(name);
            } catch (e) { reject(e); }
        }, 'image/png');
    });
}
window.exportAndUploadMask = exportAndUploadMask;

/* ────────────────────────────────────────────
   4. 파이프라인 적용
   ──────────────────────────────────────────── */

/**
 * 인페인팅 파이프라인을 워크플로우에 적용.
 * KSampler의 latent_image 입력을 VAEEncodeForInpaint 출력으로 교체한다.
 *
 * @param {Object}   promptData        워크플로우 JSON (딥카피본)
 * @param {Function} findNodeIdByTitle 노드 타이틀로 ID를 검색하는 함수
 * @returns {Promise<void>}
 */
async function applyInpaintPipeline(promptData, findNodeIdByTitle) {
    const isOn = document.getElementById('toggle-inpaint')?.checked;
    if (!isOn) return;

    const ksamplerId = findNodeIdByTitle(promptData, "[Main] KSampler");
    const ckptId     = findNodeIdByTitle(promptData, "[Main] ckpt loader");
    if (!ksamplerId || !ckptId) {
        console.warn("[Inpaint] 필요한 노드를 찾지 못해 파이프라인을 건너뜁니다.");
        return;
    }

    /* 원본 이미지 업로드 */
    let imageName = window._inpaintUploadedName;
    const fileInput = document.getElementById('inpaint-image-input');
    if (!imageName && fileInput?.files?.[0]) {
        imageName = await uploadInpaintImage(fileInput.files[0]);
        window._inpaintUploadedName = imageName;
        const statusEl = document.getElementById('inpaint-upload-status');
        if (statusEl) statusEl.textContent = '✅ 업로드 완료';
    }
    if (!imageName) {
        console.warn("[Inpaint] 업로드된 원본 이미지가 없어 파이프라인을 건너뜁니다.");
        return;
    }

    /* 마스크 업로드
       캐시가 있으면 재사용 → 없으면 캔버스에서 생성
       캔버스가 비어있으면 전체 화이트 폴백 (이미지 전체 재생성) */
    let maskName = window._inpaintUploadedMaskName;
    if (!maskName) {
        const canvas  = document.getElementById('inpaint-mask-canvas');
        const isEmpty = canvas ? isMaskCanvasEmpty(canvas) : true;

        if (isEmpty) {
            console.warn("[Inpaint] 마스크가 비어있습니다. 전체 영역을 마스킹합니다.");
            maskName = await createAndUploadFullMask(canvas?.width || 1024, canvas?.height || 1024);
        } else {
            maskName = await exportAndUploadMask();
        }
        const maskStatus = document.getElementById('inpaint-mask-status');
        if (maskStatus) maskStatus.textContent = `✅ 마스크: ${maskName}`;
    }

    const denoise    = parseFloat(document.getElementById('inpaint-denoise')?.value  || '0.75');
    const growMaskBy = parseInt(document.getElementById('inpaint-grow-mask')?.value  || '6', 10);

    /* ── 인페인팅 전용 모델 교체 ──
       #inpaint-checkpoint 드롭다운에서 값이 선택됐으면(비어있지 않으면)
       [Main] ckpt loader 노드의 ckpt_name을 해당 모델로 덮어쓴다.
       값이 없거나 "(메인 모델과 동일)" 이면 메인 모델 그대로 유지. */
    const inpaintCkpt = document.getElementById('inpaint-checkpoint')?.value;
    if (inpaintCkpt && inpaintCkpt !== '__main__') {
        if (promptData[ckptId]?.inputs) {
            promptData[ckptId].inputs.ckpt_name = inpaintCkpt;
        }
    }

    /* 노드 신설 */
    promptData["inpaint_loadimage_001"] = {
        inputs: { image: imageName, upload: "image" },
        class_type: "LoadImage",
        _meta: { title: "[Inpaint] Load Image" }
    };

    // LoadImageMask: channel "red" — 흰색=마스킹, 검정=보존
    promptData["inpaint_loadmask_001"] = {
        inputs: { image: maskName, channel: "red", upload: "image" },
        class_type: "LoadImageMask",
        _meta: { title: "[Inpaint] Load Mask" }
    };

    const customVaeId = "vae_custom_001";
    const vaeSource   = promptData[customVaeId] ? [customVaeId, 0] : [ckptId, 2];

    promptData["inpaint_vaeencode_001"] = {
        inputs: {
            pixels:       ["inpaint_loadimage_001", 0],
            vae:          vaeSource,
            mask:         ["inpaint_loadmask_001",  0],
            grow_mask_by: growMaskBy
        },
        class_type: "VAEEncodeForInpaint",
        _meta: { title: "[Inpaint] VAE Encode For Inpaint" }
    };

    if (promptData[ksamplerId]?.inputs) {
        promptData[ksamplerId].inputs.latent_image = ["inpaint_vaeencode_001", 0];
        promptData[ksamplerId].inputs.denoise      = denoise;
    }
    // [Main] Latent Image(EmptyLatentImage)는 참조 없으므로 ComfyUI가 자동 제외
}
window.applyInpaintPipeline = applyInpaintPipeline;

/* ────────────────────────────────────────────
   5. 유틸리티
   ──────────────────────────────────────────── */

function isMaskCanvasEmpty(canvas) {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0) return false;
    }
    return true;
}

async function createAndUploadFullMask(w, h) {
    const c   = document.createElement('canvas');
    c.width   = w; c.height = h;
    c.getContext('2d').fillRect(0, 0, w, h); // 기본 fillStyle = black → fillStyle 먼저 설정
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    return new Promise((resolve, reject) => {
        c.toBlob(async (blob) => {
            if (!blob) { reject(new Error("전체 마스크 PNG 생성 실패")); return; }
            try { resolve(await uploadInpaintImage(blob, `inpaint_mask_full_${Date.now()}.png`)); }
            catch (e) { reject(e); }
        }, 'image/png');
    });
}
