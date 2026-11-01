/**
 * generate.js — 이미지 생성 및 대기열 관리 모듈
 * ComfyUI 워크플로우 기반의 이미지 생성(단일/배치)과
 * 웹소켓을 통한 실시간 진행률·라이브 프리뷰 처리를 담당합니다.
 * 동적 파이프라인(업스케일/디테일러/검열)의 조합 및
 * 배치 큐 관리 UI도 이 모듈에서 제어합니다.
 */

let jobQueue = [];

/* ComfyUI sessionStorage clientId 재사용 — 같은 ID로 연결해야 바이너리 프리뷰 수신 가능 */
window.clientId = sessionStorage.getItem('clientId') || Math.random().toString(36).substring(2, 15);

/* HTTPS(Cloudflare 터널 등) 환경에서는 wss://, 그 외에는 ws:// 자동 선택 */
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
try {
    window.ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws?clientId=${window.clientId}`);
} catch (e) {
    console.error("[AssetManager] WebSocket 연결 실패:", e);
    window.ws = { addEventListener: () => { }, removeEventListener: () => { }, send: () => { } };
}

/* ──────────────────────────────────────────────
   temp 파일 폴링 기반 라이브 프리뷰
   [Main] Image Preview 노드가 생성하는 temp 이미지를
   1초마다 폴링하여 뷰어에 표시한다.
   ────────────────────────────────────────────── */
window._previewPoller = null;
window._lastPreviewFilename = null;

function startPreviewPolling() {
    stopPreviewPolling();
    window._previewPoller = setInterval(async () => {
        try {
            const qRes = await fetch('/queue');
            if (!qRes.ok) return;
            const qData = await qRes.json();
            const running = qData.queue_running;
            if (!running || running.length === 0) return;

            const promptId = running[0][1];

            /* WebSocket에서 파일명을 받은 경우 (executed 이벤트) 즉시 표시 */
            if (window._knownTempFilename) {
                const src = `/view?filename=${encodeURIComponent(window._knownTempFilename)}&type=temp&subfolder=&t=${Date.now()}`;
                _showPreviewImage(src);
                return;
            }

            /* history에서 출력 이미지 확인 (PreviewImage 노드 완료 시) */
            const hRes = await fetch(`/history/${promptId}`);
            if (!hRes.ok) return;
            const hData = await hRes.json();
            const entry = hData[promptId];
            if (!entry || !entry.outputs) return;

            for (const nodeOutput of Object.values(entry.outputs)) {
                if (!nodeOutput.images || nodeOutput.images.length === 0) continue;
                const img = nodeOutput.images[0];
                if (img.filename === window._lastPreviewFilename) continue;
                window._lastPreviewFilename = img.filename;
                const subfolder = (img.subfolder || '').replace(/\\/g, '/');
                const src = `/view?filename=${encodeURIComponent(img.filename)}&type=${img.type}&subfolder=${encodeURIComponent(subfolder)}&t=${Date.now()}`;
                _showPreviewImage(src);
                return;
            }
        } catch (e) { /* 폴링 중 에러 무시 */ }
    }, 800);
}

function _showPreviewImage(src) {
    const imgEl = document.getElementById('live-preview-img');
    const placeholder = document.getElementById('live-preview-placeholder');
    if (!imgEl) return;
    if (placeholder) placeholder.style.display = 'none';
    imgEl.style.display = 'block';
    imgEl.src = src;
}

function stopPreviewPolling() {
    if (window._previewPoller) {
        clearInterval(window._previewPoller);
        window._previewPoller = null;
    }
    window._lastPreviewFilename = null;
    window._knownTempFilename = null;
}

/** state_manager.js에서 저장된 큐 데이터를 복원하기 위한 브릿지 함수 */
function restoreJobQueue(savedQueue) {
    jobQueue = savedQueue;
    renderJobQueue();
}

/** state_manager.js의 getCurrentState에서 현재 큐 데이터를 읽어가기 위한 getter */
function getJobQueue() {
    return jobQueue;
}

window.globalNodeTitleMap = {};
window.currentStepText = "이미지를 생성하는 중";

/* ──────────────────────────────────────────────
   웹소켓 실시간 이벤트 처리 (진행률, 라이브 프리뷰, 결과 수신)
   ────────────────────────────────────────────── */

window.ws.binaryType = "arraybuffer";

window.ws.onmessage = function (event) {
    /* 바이너리 데이터: 라이브 프리뷰 썸네일 (ComfyUI Preview Format) */
    if (event.data instanceof ArrayBuffer) {
        const view = new DataView(event.data);
        const eventType = view.getUint32(0);
        if (eventType === 1) {
            const imageFormat = view.getUint32(4);
            const mimeType = imageFormat === 2 ? "image/png" : "image/jpeg";
            const imageBlob = new Blob([event.data.slice(8)], { type: mimeType });
            const imageUrl = URL.createObjectURL(imageBlob);

            if (window.isStandaloneExecution) {
                const imgEl = document.getElementById('censor-preview-img');
                if (imgEl) {
                    imgEl.src = imageUrl;
                    if (imgEl.dataset.prevUrl) URL.revokeObjectURL(imgEl.dataset.prevUrl);
                    imgEl.dataset.prevUrl = imageUrl;
                }
            } else {
                document.getElementById('live-preview-placeholder').style.display = 'none';
                const imgEl = document.getElementById('live-preview-img');
                imgEl.style.display = 'block';
                imgEl.src = imageUrl;
                if (imgEl.dataset.prevUrl) {
                    URL.revokeObjectURL(imgEl.dataset.prevUrl);
                }
                imgEl.dataset.prevUrl = imageUrl;
            }
        }
        return;
    }

    /* JSON 텍스트 데이터 */
    if (typeof event.data === "string") {
        const data = JSON.parse(event.data);

        /* 단독검열기 모드 중에는 Generate 탭 UI를 건드리지 않고 리턴 */
        if (window.isStandaloneExecution) {
            return;
        }

        /* 생성 시작 (UI 리셋 + 프리뷰 폴링 시작) */
        if (data.type === 'execution_start' && data.data && data.data.prompt_id) {
            document.getElementById('live-status-text').innerText = `🚀 렌더링 큐 배정됨...`;
            document.getElementById('live-status-text').style.color = '#FF9800';
            document.getElementById('live-preview-placeholder').style.display = 'block';
            document.getElementById('live-preview-img').style.display = 'none';
            document.getElementById('progress-container').style.display = 'none';
            document.getElementById('progress-bar').style.width = '0%';
            startPreviewPolling();
        }

        /* 노드 실행 시작 (상태 텍스트를 현재 실행 중인 노드에 맞게 갱신) */
        if (data.type === 'executing' && data.data && data.data.node) {
            const nodeId = data.data.node;
            const title = window.globalNodeTitleMap[nodeId];
            if (title) {
                if (title.includes("Upscale")) window.currentStepText = "업스케일링을 하는 중";
                else if (title.includes("Face Detailer")) window.currentStepText = "얼굴 디테일링을 하는 중";
                else if (title.includes("Eye Detailer")) window.currentStepText = "눈 디테일링을 하는 중";
                else if (title.includes("Mouth Detailer")) window.currentStepText = "입 디테일링을 하는 중";
                else if (title.includes("Hand Detailer")) window.currentStepText = "손 디테일링을 하는 중";
                else if (title.includes("[Censor]")) window.currentStepText = "검열 처리를 하는 중";
                else if (title.includes("KSampler")) window.currentStepText = "이미지를 생성하는 중";
                else if (title.includes("VAE")) window.currentStepText = "이미지를 디코딩하는 중";
                else if (title.includes("Save")) window.currentStepText = "이미지를 저장하는 중";

                document.getElementById('live-status-text').innerText = `🔄 ${window.currentStepText}...`;
                document.getElementById('live-status-text').style.color = '#FF9800';
            }
        }

        /* 진행률 업데이트 — progress(구버전) / progress_state(신버전) 둘 다 처리 */
        if (data.type === 'progress') {
            const progress = data.data.value; const max = data.data.max;
            document.getElementById('progress-container').style.display = 'block';
            document.getElementById('progress-bar').style.width = ((progress / max) * 100) + '%';
            document.getElementById('live-status-text').innerText = `🔄 ${window.currentStepText}... (${progress} / ${max})`;
        }

        if (data.type === 'progress_state' && data.data && data.data.nodes) {
            const nodes = data.data.nodes;
            let totalValue = 0, totalMax = 0, hasRunning = false;
            for (const nodeData of Object.values(nodes)) {
                if (nodeData.state === 'running') {
                    hasRunning = true;
                    totalValue = nodeData.value || 0;
                    totalMax = nodeData.max || 1;
                }
            }
            if (hasRunning && totalMax > 0) {
                document.getElementById('progress-container').style.display = 'block';
                document.getElementById('progress-bar').style.width = ((totalValue / totalMax) * 100) + '%';
                document.getElementById('live-status-text').innerText = `🔄 ${window.currentStepText}... (${totalValue} / ${totalMax})`;
                document.getElementById('live-status-text').style.color = '#FF9800';
            }
        }

        /* 생성 완료: 히스토리 스택에 결과 이미지 추가 */
        if (data.type === 'executed' && data.data.output && data.data.output.images) {
            const images = data.data.output.images;
            if (images.length > 0) {
                const imgInfo = images[0];
                const fixedSubfolder = (imgInfo.subfolder || '').replace(/\\/g, '/');
                const imgSrc = `/view?filename=${encodeURIComponent(imgInfo.filename)}&type=${imgInfo.type}&subfolder=${encodeURIComponent(fixedSubfolder)}&t=${new Date().getTime()}`;

                /* PreviewImage(temp) 노드 완료 시 → 뷰어에 즉시 표시하고 파일명 캐시 */
                if (imgInfo.type === 'temp') {
                    window._knownTempFilename = imgInfo.filename;
                    _showPreviewImage(imgSrc);
                    return;  /* SaveImage 완료 이벤트를 기다림 */
                }

                /* SaveImage(output) 노드 완료 시 → 폴링 중지 + 최종 이미지 표시 + 히스토리 추가 */
                stopPreviewPolling();
                document.getElementById('progress-container').style.display = 'none';
                document.getElementById('progress-bar').style.width = '0%';
                document.getElementById('live-status-text').innerText = `✅ 작업 완료`;
                document.getElementById('live-status-text').style.color = '#4CAF50';

                _showPreviewImage(imgSrc);

                const stack = document.getElementById('history-stack');
                if (stack.innerHTML.includes('아직 생성된 이미지가 없습니다')) stack.innerHTML = '';

                const item = document.createElement('div');
                item.className = 'history-item';
                const filePath = imgInfo.subfolder ? imgInfo.subfolder + '/' + imgInfo.filename : 'output/' + imgInfo.filename;

                const safeFilename = imgInfo.filename.replace(/'/g, "%27");
                const safeSubfolder = (imgInfo.subfolder || '').replace(/'/g, "%27").replace(/\\/g, "/");

                item.innerHTML = `
                    <div style="width: 100%; aspect-ratio: 1; overflow: hidden; border-radius: 6px;">
                        <img src="${imgSrc}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 6px; cursor: pointer; border: 1px solid #444;" onclick="openLightbox('${imgSrc}')" oncontextmenu="openContextMenu(event, '${safeFilename}', '${safeSubfolder}')">
                    </div>
                    <div class="file-name" style="margin-top: 5px; font-size: 0.9em; font-weight: bold; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${imgInfo.filename}">${imgInfo.filename}</div>
                    <div class="file-path" style="font-size: 0.8em; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${filePath}">${filePath}</div>
                `;
                stack.prepend(item);
            }
        }

        /* 생성 중지 */
        if (data.type === 'execution_interrupted') {
            stopPreviewPolling();
            document.getElementById('progress-container').style.display = 'none';
            document.getElementById('live-status-text').innerText = '⏹ 생성이 중지되었습니다';
            document.getElementById('live-status-text').style.color = '#ff5555';
        }
    }  /* end: if (typeof event.data === "string") */
};

/* ──────────────────────────────────────────────
   워크플로우 템플릿 로딩
   ────────────────────────────────────────────── */

window.baseWorkflow = null;

/** 서버에서 워크플로우 JSON을 불러온다 */
async function fetchWorkflowTemplate() {
    try {
        const data = await API.get('/assetmanager/api/workflow');
        if (data.status === 'success') {
            window.baseWorkflow = data.workflow;
        } else {
            console.error("Workflow JSON 로드 실패:", data.message);
        }
    } catch (e) {
        console.error("fetchWorkflowTemplate 에러:", e);
    }
}

fetchWorkflowTemplate();

/** 워크플로우 내에서 노드 타이틀로 해당 노드 ID를 검색 */
window.findNodeIdByTitle = function (workflow, targetTitle) {
    const entry = Object.entries(workflow).find(([id, node]) => node._meta && node._meta.title === targetTitle);
    return entry ? entry[0] : null;
};

/* ──────────────────────────────────────────────
   단일 생성 (버튼 클릭 → 즉시 실행)
   ────────────────────────────────────────────── */

/** 단일 모드: 현재 프롬프트로 이미지를 1장 생성 */
async function generateImage() {
    const pos = document.getElementById('base-pos').value;
    const neg = document.getElementById('base-neg').value;
    executeGeneration(pos, neg, "AssetManager_Output");
}

/* ──────────────────────────────────────────────
   배치 생성 (큐 전체를 순차 실행)
   ────────────────────────────────────────────── */

/** 배치 모드: 대기열의 모든 작업을 경로 템플릿에 따라 순차 생성 */
async function startBatchGeneration() {
    if (jobQueue.length === 0) return alert("대기열에 작업이 없습니다.");

    const template = document.getElementById('path-template').value;

    for (const job of jobQueue) {
        let finalPath = template;
        Object.entries(job.labels).forEach(([key, val]) => {
            finalPath = finalPath.replace(`[${key}]`, val);
        });

        const fullPos = document.getElementById('base-pos').value + (job.fullPrompt.length > 0 ? ", " + job.fullPrompt.join(', ') : "");
        const fullNeg = document.getElementById('base-neg').value;

        for (let i = 0; i < job.repeatCount; i++) {
            await executeGeneration(fullPos, fullNeg, finalPath);
        }
    }
}

/* ──────────────────────────────────────────────
   공통 이미지 생성 통신 로직 (핵심)
   ────────────────────────────────────────────── */

/**
 * 워크플로우 JSON을 복제하여 UI 설정값을 적용한 후 ComfyUI /prompt API로 전송.
 * 업스케일러/디테일러/검열 파이프라인을 동적으로 연결하고,
 * 웹소켓을 통해 실행 완료 시점을 감지하여 Promise를 resolve한다.
 */
async function executeGeneration(posPrompt, negPrompt, filenamePrefix) {
    if (!window.baseWorkflow) {
        alert("Workflow.json 파일이 로드되지 않았습니다. 잠시 후 다시 시도해주세요.");
        return;
    }

    document.getElementById('progress-container').style.display = 'block';
    document.getElementById('progress-bar').style.width = '0%';
    document.getElementById('live-preview-placeholder').style.display = 'block';
    document.getElementById('live-preview-img').style.display = 'none';

    window.currentStepText = "작업을 준비하는 중";
    document.getElementById('live-status-text').innerText = '⏳ 서버에 전송 중...';

    const promptData = JSON.parse(JSON.stringify(window.baseWorkflow));

    /* 노드 타이틀 → ID 매핑 캐시 구축 */
    window.globalNodeTitleMap = {};
    for (const [id, node] of Object.entries(promptData)) {
        if (node._meta && node._meta.title) {
            window.globalNodeTitleMap[id] = node._meta.title;
        }
    }

    /* UI 값 → 워크플로우 노드에 매핑 */
    const ckptId = findNodeIdByTitle(promptData, "[Main] ckpt loader");
    const promptId = findNodeIdByTitle(promptData, "[Main] Text Prompt");
    const ksamplerId = findNodeIdByTitle(promptData, "[Main] KSampler");
    const loraId = findNodeIdByTitle(promptData, "[Main] Lora Loader");
    const upscalerSamplerId = findNodeIdByTitle(promptData, "[Upscaler] KSampler");
    const imageSaveId = findNodeIdByTitle(promptData, "[Main] Image Save");
    const vaeDecodeId = findNodeIdByTitle(promptData, "[Main] VAE decode");

    if (ckptId) promptData[ckptId].inputs.ckpt_name = document.getElementById('gen-checkpoint').value;
    if (promptId) {
        promptData[promptId].inputs.pos = posPrompt || "1girl, masterpiece";
        promptData[promptId].inputs.neg = negPrompt || "worst quality";
    }

    /* ── 고급 설정 → 워크플로우 노드에 주입 ── */
    const stepNodeId = findNodeIdByTitle(promptData, "[Main] Step");
    const cfgNodeId = findNodeIdByTitle(promptData, "[Main] CFG");
    const samplerSchedulerNodeId = findNodeIdByTitle(promptData, "[Main] Sampler, Scheduler");
    const latentNodeId = findNodeIdByTitle(promptData, "[Main] Latent Image");

    const advSteps = parseInt(document.getElementById('adv-steps')?.value || '28', 10);
    const advCfg = parseFloat(document.getElementById('adv-cfg')?.value || '5');
    const advSampler = document.getElementById('adv-sampler')?.value || 'euler_ancestral';
    const advScheduler = document.getElementById('adv-scheduler')?.value || 'normal';
    const advDimensions = document.getElementById('adv-dimensions')?.value || '1024 x 1024  (square)';

    if (stepNodeId) promptData[stepNodeId].inputs.value = advSteps;
    if (cfgNodeId) promptData[cfgNodeId].inputs.value = advCfg;
    if (samplerSchedulerNodeId) {
        promptData[samplerSchedulerNodeId].inputs.sampler_name = advSampler;
        promptData[samplerSchedulerNodeId].inputs.scheduler = advScheduler;
    }
    if (latentNodeId) promptData[latentNodeId].inputs.dimensions = advDimensions;

    /* 시드 처리: 랜덤 체크 시 난수 생성, 해제 시 사용자 지정 시드 사용 */
    const isSeedRandom = document.getElementById('adv-seed-random')?.checked !== false;
    const userSeed = document.getElementById('adv-seed')?.value;
    const seedValue = (isSeedRandom || !userSeed) ? Math.floor(Math.random() * 10000000000000000) : parseInt(userSeed, 10);

    if (ksamplerId) promptData[ksamplerId].inputs.seed = seedValue;
    if (upscalerSamplerId) {
        promptData[upscalerSamplerId].inputs.seed = seedValue;
        /* 업스케일러 Steps UI 값 반영 (노드 109) */
        const upscaleSteps = parseInt(document.getElementById('upscale-steps')?.value || '10', 10);
        promptData[upscalerSamplerId].inputs.steps = upscaleSteps;
    }

    /* [Main] Image Preview 노드는 삭제하지 않고 유지 — temp 폴더에 프리뷰 파일 생성용 */
    const previewMainId = findNodeIdByTitle(promptData, "[Main] Image Preview");

    /* 로라 설정 적용 (Power Lora Loader rgthree 형식) */
    if (loraId) {
        const loraItems = document.querySelectorAll('#selected-loras .lora-item');
        delete promptData[loraId].inputs["lora_1"];
        if (loraItems.length > 0) {
            loraItems.forEach((item, index) => {
                promptData[loraId].inputs[`lora_${index + 1}`] = {
                    "on": true,
                    "lora": item.querySelector('select').value,
                    "strength": parseFloat(item.querySelector('input[type="number"]').value)
                };
            });
        } else {
            promptData[loraId].inputs["lora_1"] = { "on": false, "lora": "None", "strength": 1 };
        }
    }

    /* ── 동적 노드 우회 파이프라인 (Rewiring Pipeline) ──
       파이프라인 순서: VAE Decode → 업스케일러 → 디테일러 → 검열
       각 단계의 마지막 출력 노드를 추적하여 다음 단계의 입력에 연결한다. */
    let currentImageSource = [vaeDecodeId, 0];

    if (window.applyUpscalerPipeline) {
        currentImageSource = window.applyUpscalerPipeline(promptData, currentImageSource, findNodeIdByTitle);
    }

    if (window.applyDetailerPipeline) {
        currentImageSource = window.applyDetailerPipeline(promptData, currentImageSource, findNodeIdByTitle);
    }

    /* 검열 파이프라인 적용 (원본 이미지 소스를 백업하여 이중 저장에 활용) */
    const preCensorSource = [...currentImageSource];
    const isCensorOn = document.getElementById('toggle-mosaic')?.checked || false;

    if (window.applyCensorPipeline) {
        currentImageSource = window.applyCensorPipeline(promptData, currentImageSource, window.findNodeIdByTitle);
    }

    /* 중간 단계 Save 노드 제거 (최종 Save만 유지) */
    const redundantSaves = [
        "[Upscaler] Image Save",
        "[Detailer] Face Detailer Image Save",
        "[Detailer] Eye Detailer Image Save",
        "[Detailer] Mouth Detailer Image Save",
        "[Detailer] Hand Detailer Image Save",
    ];

    if (!isCensorOn) {
        redundantSaves.push("[Censor] Image Save");
    }

    redundantSaves.forEach(title => {
        const rId = window.findNodeIdByTitle(promptData, title);
        if (rId) delete promptData[rId];
    });

    /* 최종 Save 노드 연결 */
    if (imageSaveId) {
        promptData[imageSaveId].inputs.images = preCensorSource;
        promptData[imageSaveId].inputs.filename_prefix = filenamePrefix;
    }

    if (isCensorOn) {
        const censorSaveId = window.findNodeIdByTitle(promptData, "[Censor] Image Save");
        if (censorSaveId) {
            promptData[censorSaveId].inputs.images = currentImageSource;
            promptData[censorSaveId].inputs.filename_prefix = filenamePrefix + "_censored";
        }
    }

    /* 서버 로그 기록 */
    try {
        const logParts = [];
        logParts.push(`Gen: ${document.getElementById('gen-checkpoint')?.value}`);
        logParts.push(`P: ${posPrompt.substring(0, 30)}...`);

        if (document.getElementById('toggle-upscale')?.checked) {
            logParts.push(`Upscale: ON [${document.getElementById('upscale-model')?.value}] x${document.getElementById('upscale-ratio')?.value}`);
        } else {
            logParts.push(`Upscale: OFF`);
        }

        if (document.getElementById('toggle-detailer')?.checked) {
            const dParts = [];
            if (document.getElementById('tool-detailer-face')?.checked) dParts.push('Face');
            if (document.getElementById('tool-detailer-eye')?.checked) dParts.push('Eye');
            if (document.getElementById('tool-detailer-mouth')?.checked) dParts.push('Mouth');
            if (document.getElementById('tool-detailer-hand')?.checked) dParts.push('Hand');
            logParts.push(`Detailer: ON [${dParts.length > 0 ? dParts.join(", ") : "None"}]`);
        } else {
            logParts.push(`Detailer: OFF`);
        }

        if (isCensorOn) {
            const cMode = document.getElementById('censor-mode')?.value || 'mosaic';
            const cInt = document.getElementById('censor-intensity')?.value || '15';
            const cParts = [];
            if (document.getElementById('censor-vagina')?.checked) cParts.push('Vagina');
            if (document.getElementById('censor-penis')?.checked) cParts.push('Penis');
            if (document.getElementById('censor-nipples')?.checked) cParts.push('Nipples');
            logParts.push(`Censor: ON [${cMode.toUpperCase()}] Intensity: ${cInt} Targets: ${cParts.length > 0 ? cParts.join(", ") : "None"}`);
        } else {
            logParts.push(`Censor: OFF`);
        }

        const finalLogMessage = logParts.join(" | ");
        API.post('/assetmanager/api/log', { message: finalLogMessage })
            .catch(err => console.error("Logging failed:", err));
    } catch (e) {
        console.error("Error while preparing log:", e);
    }

    /* ComfyUI /prompt API 요청 후 웹소켓 완료 이벤트를 기다리는 Promise */
    return new Promise(async (resolve, reject) => {
        const tempHandler = function (event) {
            if (typeof event.data === "string") {
                const data = JSON.parse(event.data);
                if (data.type === 'executed' && data.data && data.data.prompt_id) {
                    window.ws.removeEventListener('message', tempHandler);
                    resolve();
                }
            }
        };
        window.ws.addEventListener('message', tempHandler);

        try {
            const data = await API.post('/prompt', { prompt: promptData, client_id: window.clientId });
            if (!data.prompt_id) {
                document.getElementById('progress-container').style.display = 'none';
                window.ws.removeEventListener('message', tempHandler);
                reject(new Error("Job enqueue failed"));
            }
        } catch (e) {
            document.getElementById('progress-container').style.display = 'none';
            window.ws.removeEventListener('message', tempHandler);
            reject(e);
        }
    });
}

/* ──────────────────────────────────────────────
   대기열(Queue) 관리 UI 함수
   ────────────────────────────────────────────── */

/** 작업 객체를 대기열에 추가하고 UI 갱신 */
function addJobToQueue(job) {
    jobQueue.push(job);
    renderJobQueue();
    if (window.appStateManager) window.appStateManager.debounceSave();
}

/** 대기열 목록을 HTML로 렌더링 */
function renderJobQueue() {
    const container = document.getElementById('job-queue-list');
    if (jobQueue.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: #666; margin: 0;">대기열이 비어 있습니다.</p>';
        return;
    }
    container.innerHTML = jobQueue.map((job, index) => `
        <div class="lora-item" style="justify-content: space-between; border-left: 4px solid #4CAF50;">
            <div style="flex:1;">
                <div style="font-size:0.9em; margin-bottom:5px;">${Object.entries(job.labels).map(([k, v]) => `<b>${k}:</b> ${v}`).join(' | ')}</div>
                <div style="font-size:0.75em; color:#888;">${job.fullPrompt.join(', ')}</div>
            </div>
            <div style="display:flex; align-items:center; gap:10px;">
                <label style="font-size:0.8em;">반복:</label>
                <input type="number" value="${job.repeatCount}" style="width:50px; padding:3px;" onchange="updateJobRepeat(${index}, this.value)">
                <button class="btn-secondary" onclick="removeJob(${index})" style="background:#844; padding: 2px 8px;">×</button>
            </div>
        </div>
    `).join('');
}

/** 대기열 전체 비우기 (확인 팝업 포함) */
function clearJobQueue() {
    if (jobQueue.length === 0) return;
    if (!confirm("대기열을 모두 비우시겠습니까?")) return;
    jobQueue = [];
    renderJobQueue();
    if (window.appStateManager) window.appStateManager.debounceSave();
}

/** 대기열 항목의 반복 횟수 변경 */
function updateJobRepeat(index, val) {
    jobQueue[index].repeatCount = parseInt(val);
    if (window.appStateManager) window.appStateManager.debounceSave();
}

/** 대기열에서 특정 항목 제거 */
function removeJob(index) {
    jobQueue.splice(index, 1);
    renderJobQueue();
    if (window.appStateManager) window.appStateManager.debounceSave();
}

/* ──────────────────────────────────────────────
   생성 모드 전환 (단일/배치) UI
   ────────────────────────────────────────────── */

/** 라디오 버튼에 따라 단일 모드 영역과 배치 모드 영역의 표시를 전환 */
function toggleGenMode() {
    const isBatch = document.getElementById('mode-batch').checked;
    document.getElementById('single-mode-area').style.display = isBatch ? 'none' : 'block';
    document.getElementById('batch-mode-area').style.display = isBatch ? 'block' : 'none';
}

/* ──────────────────────────────────────────────
   노드 실행 로그 패널 접기/펼치기
   ────────────────────────────────────────────── */

function toggleNodeLogPanel() {
    const panel = document.getElementById('node-log-panel');
    const btn = document.getElementById('node-log-toggle');
    if (!panel || !btn) return;
    const isHidden = panel.style.display === 'none';
    panel.style.display = isHidden ? 'flex' : 'none';
    btn.textContent = isHidden ? '📋 로그 ▼' : '📋 로그 ▶';
}

/* ──────────────────────────────────────────────
   생성 중지 (ComfyUI /interrupt API 호출)
   ────────────────────────────────────────────── */

/** 현재 진행 중인 생성을 중지하고 배치 큐도 멈춤 */
window._batchAborted = false;

async function stopGeneration() {
    window._batchAborted = true;
    stopPreviewPolling();
    try {
        await fetch('/interrupt', { method: 'POST' });
    } catch (e) {
        console.error('[AssetManager] 생성 중지 요청 실패:', e);
    }
    document.getElementById('live-status-text').innerText = '⏹ 중지 요청됨...';
    document.getElementById('live-status-text').style.color = '#ff5555';
    document.getElementById('progress-container').style.display = 'none';
}

/* ──────────────────────────────────────────────
   라이브 프리뷰 패널 접기/펼치기
   ────────────────────────────────────────────── */

function toggleLivePreview() {
    const body = document.getElementById('live-preview-body');
    const container = document.getElementById('live-preview-container');
    const btn = document.getElementById('live-preview-toggle');
    if (!body || !btn) return;

    const isCollapsed = body.classList.contains('collapsed');
    if (isCollapsed) {
        body.classList.remove('collapsed');
        container && container.classList.remove('collapsed-mode');
        btn.textContent = '▼ 접기';
    } else {
        body.classList.add('collapsed');
        container && container.classList.add('collapsed-mode');
        btn.textContent = '▶ 펼치기';
    }
    try { localStorage.setItem('livePreviewCollapsed', isCollapsed ? '0' : '1'); } catch(e) {}
}