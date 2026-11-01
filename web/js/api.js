/**
 * api.js — 백엔드 API 통신 래퍼 및 공용 데이터 로딩 함수
 * 모든 fetch 호출을 API 객체로 일원화하여 에러 처리를 캡슐화합니다.
 * 갤러리 카드 렌더링, 드롭다운 로딩, 파일 탐색기, 메타데이터 뷰어 등
 * 여러 탭에서 공통으로 사용하는 서버 통신 함수를 포함합니다.
 */

const API = {
    /**
     * 공통 HTTP 요청 래퍼. 에러 시 alert 표시 후 throw.
     * ZIP 응답은 Blob, 그 외는 JSON으로 자동 파싱하여 반환.
     */
    async request(url, options = {}) {
        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                let errorMsg = `HTTP Error: ${response.status}`;
                try {
                    const errData = await response.json();
                    errorMsg = errData.message || errorMsg;
                } catch (e) { }
                throw new Error(errorMsg);
            }
            const contentType = response.headers.get("content-type");
            if (contentType && contentType.includes("application/zip")) {
                return await response.blob();
            }
            return await response.json();
        } catch (error) {
            console.error(`[API 통신 오류] ${url}:`, error);
            alert(`서버 통신 중 오류가 발생했습니다.\n${error.message}`);
            throw error;
        }
    },

    /** GET 요청 숏컷 */
    async get(url) {
        return this.request(url, { method: 'GET' });
    },

    /**
     * POST 요청 숏컷.
     * @param {boolean} isFormData - true이면 FormData 그대로, false이면 JSON.stringify 처리
     */
    async post(url, body, isFormData = false) {
        const options = {
            method: 'POST',
            body: isFormData ? body : JSON.stringify(body)
        };
        if (!isFormData) {
            options.headers = { 'Content-Type': 'application/json' };
        }
        return this.request(url, options);
    }
};

window.API = API;

/* 로라 옵션 HTML을 전역으로 공유 (ui_manager.js의 addLoraRow에서 참조) */
window.loraOptionsHTML = "";

/* ──────────────────────────────────────────────
   체크포인트/로라 카드 목록 렌더링
   ────────────────────────────────────────────── */

/** 체크포인트 또는 로라 카드 그리드를 서버에서 불러와 렌더링 */
async function fetchGallery(type) {
    const container = document.getElementById(`${type === 'checkpoints' ? 'checkpoint' : 'lora'}-gallery`);
    if (!container || container.innerHTML !== '로딩 중...') return;
    try {
        const data = await API.get(`/assetmanager/api/${type}`);
        container.innerHTML = data[type].map(item => {
            const safeName = encodeURIComponent(item.name).replace(/'/g, "%27");
            const safeTitle = item.name.replace(/"/g, '&quot;');
            return `
            <div class="card" style="cursor: pointer;" onclick="showModelInfo('${type}', decodeURIComponent('${safeName}'))" title="클릭하여 ${safeTitle} 상세 정보 보기">
                ${item.image_url ? `<img src="${item.image_url}" loading="lazy">` : `<div class="no-image">No Preview</div>`}
                <div class="info">${item.name}</div>
            </div>
            `;
        }).join('');
    } catch (e) { container.innerHTML = '<p>서버 통신 오류 발생</p>'; }
}

/* ──────────────────────────────────────────────
   생성 탭 드롭다운 로딩 (체크포인트, 로라, 보조 모델)
   ────────────────────────────────────────────── */

/** 생성 탭의 모든 드롭다운(select)을 서버 데이터로 채움 */
async function loadDropdowns() {
    try {
        const dataCp = await API.get('/assetmanager/api/checkpoints');
        document.getElementById('gen-checkpoint').innerHTML = dataCp.checkpoints.map(i => `<option value="${i.name}">${i.name}</option>`).join('');
    } catch (e) { console.error("체크포인트 로드 실패", e); }

    try {
        const dataLora = await API.get('/assetmanager/api/loras');
        window.loraOptionsHTML = dataLora.loras.map(i => `<option value="${i.name}">${i.name}</option>`).join('');
    } catch (e) { console.error("로라 로드 실패", e); }

    try {
        const dataModels = await API.get('/assetmanager/api/models');

        /**
         * <option> HTML 생성 헬퍼.
         * Impact Pack 등 일부 노드는 역슬래시 대신 슬래시(/) 경로를 요구하므로
         * forceForwardSlash 옵션으로 변환 여부를 제어한다.
         */
        const buildOptions = (list, forceForwardSlash = false) => {
            if (!list || list.length === 0) return `<option value="">설치된 모델 없음</option>`;
            return list.map(m => {
                const display = m.split('/').pop().split('\\').pop();
                const safeValue = forceForwardSlash ? m.replace(/\\/g, '/') : m;
                return `<option value="${safeValue}">${display}</option>`;
            }).join('');
        };

        const upscaleSelect = document.getElementById('upscale-model');
        if (upscaleSelect) upscaleSelect.innerHTML = buildOptions(dataModels.upscale, false);

        const faceSelect = document.getElementById('detailer-face-model');
        if (faceSelect) faceSelect.innerHTML = buildOptions(dataModels.bbox, true);

        const eyeSelect = document.getElementById('detailer-eye-model');
        let eyeHtml = buildOptions(dataModels.bbox, true);
        if (eyeHtml.replace(/<option value="">설치된 모델 없음<\/option>/g, '') === "") {
            eyeHtml = `<option value="">설치된 모델 없음</option>`;
        }
        if (eyeSelect) eyeSelect.innerHTML = eyeHtml;

        const mouthSelect = document.getElementById('detailer-mouth-model');
        if (mouthSelect) mouthSelect.innerHTML = buildOptions(dataModels.bbox, true);

        const handSelect = document.getElementById('detailer-hand-model');
        if (handSelect) handSelect.innerHTML = buildOptions(dataModels.bbox, true);
    } catch (e) { console.error("보조 모델 로드 실패", e); }
}

/* ──────────────────────────────────────────────
   파일 탐색기 열기
   ────────────────────────────────────────────── */

/** 이미지의 실제 폴더를 OS 파일 탐색기에서 연다 */
async function openFolder() {
    document.getElementById('context-menu').style.display = 'none';
    if (!window.currentTargetImg || !window.currentTargetImg.filename) return;
    try {
        const decodedFile = decodeURIComponent(window.currentTargetImg.filename);
        const decodedSub = decodeURIComponent(window.currentTargetImg.subfolder);
        await API.get(`/assetmanager/api/open_folder?filename=${encodeURIComponent(decodedFile)}&subfolder=${encodeURIComponent(decodedSub)}`);
    } catch (e) { console.error("폴더 열기 실패", e); }
}

/* ──────────────────────────────────────────────
   이미지 메타데이터 모달 (우클릭 → 이미지 속성 보기)
   ────────────────────────────────────────────── */

/**
 * 이미지 파일의 내장 워크플로우 데이터를 파싱하여 모달에 표시.
 * 체크포인트, 로라, 프롬프트, 업스케일러, 디테일러 정보를 추출한다.
 */
async function showImageProperties() {
    document.getElementById('context-menu').style.display = 'none';
    if (!window.currentTargetImg || !window.currentTargetImg.filename) return;
    try {
        const decodedFile = decodeURIComponent(window.currentTargetImg.filename);
        const decodedSub = decodeURIComponent(window.currentTargetImg.subfolder);
        const data = await API.get(`/assetmanager/api/image_metadata?filename=${encodeURIComponent(decodedFile)}&subfolder=${encodeURIComponent(decodedSub)}`);

        if (data.status === "success" && data.prompt) {
            const promptData = data.prompt;

            /** 워크플로우 노드를 _meta.title로 검색하는 헬퍼 */
            const findNodeByTitle = (title) => {
                const node = Object.entries(promptData).find(([id, n]) => n._meta?.title === title);
                return node ? node[1] : null;
            };

            const textPromptNode = findNodeByTitle("[Main] Text Prompt");
            const pos = textPromptNode?.inputs?.pos || "정보 없음";
            const neg = textPromptNode?.inputs?.neg || "정보 없음";
            const model = findNodeByTitle("[Main] ckpt loader")?.inputs?.ckpt_name || "정보 없음";

            /** 노드 참조 배열을 실제 값으로 해석하는 헬퍼 */
            const resolveValue = (val, key) => {
                if (Array.isArray(val) && val.length === 2) {
                    const refNode = promptData[val[0]];
                    if (!refNode) return val;
                    /* 출력 인덱스가 0이면 inputs.value 또는 해당 key를 탐색 */
                    if (refNode.inputs) {
                        if (refNode.inputs.value !== undefined) return refNode.inputs.value;
                        if (key && refNode.inputs[key] !== undefined) return refNode.inputs[key];
                        /* JPS Sampler Scheduler: 인덱스 0=sampler_name, 1=scheduler */
                        if (val[1] === 0 && refNode.inputs.sampler_name !== undefined) return refNode.inputs.sampler_name;
                        if (val[1] === 1 && refNode.inputs.scheduler !== undefined) return refNode.inputs.scheduler;
                    }
                    return val;
                }
                return val;
            };

            const ksampler = findNodeByTitle("[Main] KSampler");
            const seed = ksampler?.inputs?.seed || "정보 없음";

            /* Steps: KSampler → [Main] Step 노드 순으로 탐색 */
            let steps = resolveValue(ksampler?.inputs?.steps, 'steps');
            if (steps === undefined || steps === null) {
                steps = findNodeByTitle("[Main] Step")?.inputs?.value || "정보 없음";
            }

            /* CFG: KSampler → [Main] CFG 노드 순으로 탐색 */
            let cfg = resolveValue(ksampler?.inputs?.cfg, 'cfg');
            if (cfg === undefined || cfg === null) {
                cfg = findNodeByTitle("[Main] CFG")?.inputs?.value || "정보 없음";
            }

            const sampler = resolveValue(ksampler?.inputs?.sampler_name, 'sampler_name') || "정보 없음";
            const scheduler = resolveValue(ksampler?.inputs?.scheduler, 'scheduler') || "정보 없음";

            const latent = findNodeByTitle("[Main] Latent Image");
            const dimensions = latent?.inputs?.dimensions || "정보 없음";

            /* 로라 정보 동적 탐색 */
            let loraHtml = '';
            Object.values(promptData).forEach(node => {
                if (node.class_type === "Power Lora Loader (rgthree)" || node.class_type === "LoraLoader") {
                    for (let i = 1; i <= 10; i++) {
                        const lora = node.inputs[`lora_${i}`];
                        if (lora && lora.on !== false && lora.lora !== "None") {
                            loraHtml += `<div style="margin-left: 10px; color: #bbb;">- ${lora.lora} (Weight: ${lora.strength})</div>`;
                        }
                    }
                }
            });
            if (!loraHtml) loraHtml = "적용된 로라 없음";

            /* 업스케일러 정보 */
            let upscaleHtml = "업스케일러 꺼짐";
            const upscaleRatio = findNodeByTitle("[Upscaler] Ratio");
            const upscaleModelNode = findNodeByTitle("[Upscaler] Model Loader");
            if (upscaleRatio || upscaleModelNode) {
                const upModel = upscaleModelNode?.inputs?.model_name || "Unknown Model";
                const upScale = upscaleRatio?.inputs?.scale_by ? `${parseFloat(upscaleRatio.inputs.scale_by).toFixed(2)}배` : "Unknown 배율";
                upscaleHtml = `모델: ${upModel} | ${upScale}`;
            }

            /* 디테일러 정보 */
            let detailerHtml = [];
            const dTypes = [
                { title: "Face", prefix: "Face" },
                { title: "Eye", prefix: "Eye" },
                { title: "Mouth", prefix: "Mouth" },
                { title: "Hand", prefix: "Hand" }
            ];
            dTypes.forEach(t => {
                const dModel = findNodeByTitle(`[Detailer] ${t.prefix} Detailer Model(BBOX)`);
                if (dModel) {
                    detailerHtml.push(`<div><b>${t.title}</b>: ${dModel.inputs.model_name}</div>`);
                }
            });
            if (detailerHtml.length === 0) detailerHtml = ["디테일러 꺼짐"];

            /* 모달 HTML 렌더링 */
            document.getElementById('metadata-body').innerHTML = `
                <div style="max-height: 60vh; overflow-y: auto; padding-right: 10px;">
                    <div class="meta-group"><span class="meta-title">체크포인트 (Model)</span><div class="meta-text">${model}</div></div>
                    <div class="meta-group"><span class="meta-title">로라 (LoRA)</span><div class="meta-text" style="font-size: 0.9em; line-height: 1.5;">${loraHtml}</div></div>
                    <div class="meta-group"><span class="meta-title">해상도 (Dimensions)</span><div class="meta-text">${dimensions}</div></div>
                    
                    <div class="meta-group"><span class="meta-title">생성 설정 (Generation Params)</span>
                        <div class="meta-text" style="font-size: 0.9em; line-height: 1.5; color: #ccc;">
                            <b>Steps:</b> ${steps} | <b>CFG:</b> ${cfg} | <b>Seed:</b> ${seed}<br>
                            <b>Sampler:</b> ${sampler} | <b>Scheduler:</b> ${scheduler}
                        </div>
                    </div>
                    
                    <div class="meta-group"><span class="meta-title">긍정 프롬프트 (Positive)</span><div class="meta-text">${pos}</div></div>
                    <div class="meta-group"><span class="meta-title">부정 프롬프트 (Negative)</span><div class="meta-text">${neg}</div></div>
                    
                    <div class="meta-group"><span class="meta-title">후처리 (Post-Processing)</span>
                        <div class="meta-text" style="font-size: 0.9em; line-height: 1.5; color: #ccc; background: rgba(0,0,0,0.2); padding: 8px; border-radius: 4px;">
                            <div style="margin-bottom: 5px;"><b>업스케일(Upscale):</b> ${upscaleHtml}</div>
                            <div><b>디테일러(Detailers):</b> <div style="margin-left: 10px;">${detailerHtml.join('')}</div></div>
                        </div>
                    </div>
                </div>
            `;
            document.getElementById('metadata-modal').style.display = 'flex';
        } else {
            alert("이 이미지에는 메타데이터가 없거나 읽을 수 없습니다.");
        }
    } catch (e) { console.error("메타데이터 가져오기 실패", e); }
}