/**
 * tools_censor.js — 단독 검열(모자이크/화이트마스크) 도구 모듈
 * 이미지를 업로드하여 ComfyUI 검열 파이프라인으로 일괄 처리하고,
 * 비교 슬라이더와 리터치 캔버스(브러시)로 결과를 확인·수정합니다.
 */

window.isStandaloneExecution = false;

let censorQueue = [];
let isCensorProcessing = false;
let currentCensorIndex = -1;

const censorDropzone = document.getElementById('censor-dropzone');
const censorFileInput = document.getElementById('censor-file-input');
const censorPreviewImg = document.getElementById('censor-preview-img');
const censorDropPlaceholder = document.getElementById('censor-drop-placeholder');
const censorQueueContainer = document.getElementById('censor-queue-container');

censorDropzone.addEventListener('click', (e) => {
    if (e.target.closest('#censor-detail-view')) return;
    if (isCensorProcessing) return;
    censorFileInput.click();
});

censorDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (isCensorProcessing) return;
    censorDropzone.style.borderColor = '#4CAF50';
    censorDropzone.style.backgroundColor = '#1a2a1a';
});

censorDropzone.addEventListener('dragleave', () => {
    if (isCensorProcessing) return;
    censorDropzone.style.borderColor = '#555';
    censorDropzone.style.backgroundColor = 'transparent';
});

censorDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    if (isCensorProcessing) return;
    censorDropzone.style.borderColor = '#555';
    censorDropzone.style.backgroundColor = 'transparent';
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        addFilesToCensorQueue(e.dataTransfer.files);
    }
});

censorFileInput.addEventListener('change', (e) => {
    if (isCensorProcessing) return;
    if (e.target.files && e.target.files.length > 0) {
        addFilesToCensorQueue(e.target.files);
    }
    censorFileInput.value = '';
});

/** 도구를 기본 상태로 초기화 */
function resetCensorTool() {
    censorQueue = [];
    isCensorProcessing = false;
    currentCensorIndex = -1;
    document.getElementById('censor-detail-view').style.display = 'none';
    censorDropzone.style.display = 'flex';
    censorPreviewImg.src = "";
    censorPreviewImg.style.display = 'none';
    censorDropPlaceholder.style.display = 'block';
    updateCensorStatus('준비됨', '#aaa', 0);
    renderCensorQueue();
}

/** 상태 텍스트와 프로그레스 바 갱신 */
function updateCensorStatus(text, color, progressPercent = null) {
    const statusText = document.getElementById('censor-status-text');
    if (statusText) { statusText.innerText = text; statusText.style.color = color; }
    if (progressPercent !== null) {
        const bar = document.getElementById('censor-progress-bar');
        if (bar) bar.style.width = `${progressPercent}%`;
    }
}

/** 이미지 파일들을 검열 큐에 추가 */
function addFilesToCensorQueue(files) {
    let addedCount = 0;
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file.type.startsWith('image/')) continue;
        censorQueue.push({
            id: 'censor_' + Date.now() + '_' + i, file, objectUrl: URL.createObjectURL(file),
            status: 'pending', serverFilename: null, resultUrl: null
        });
        addedCount++;
    }
    if (addedCount > 0) {
        renderCensorQueue();
        if (censorQueue.length === addedCount) viewCensorQueueItem(censorQueue[0].id);
    }
}

/** 큐 썸네일 리스트 렌더링 */
function renderCensorQueue() {
    if (!censorQueueContainer) return;
    if (censorQueue.length === 0) {
        censorQueueContainer.innerHTML = '<span id="censor-queue-empty-msg" style="color: #666; font-size: 0.9em; margin: auto;">대기열이 비어 있습니다.</span>';
        return;
    }
    let html = '';
    censorQueue.forEach((item, idx) => {
        let borderCol = '#444', overlayIcon = '';
        if (item.status === 'processing') { borderCol = '#FF9800'; overlayIcon = '⏳'; }
        else if (item.status === 'done') { borderCol = '#4CAF50'; overlayIcon = '✅'; }
        else if (item.status === 'error') { borderCol = '#ff5555'; overlayIcon = '❌'; }
        const isCurrent = (currentCensorIndex === idx && isCensorProcessing);
        html += `<div class="censor-queue-item" style="position:relative;width:60px;height:60px;flex-shrink:0;border:2px solid ${isCurrent ? '#fff' : borderCol};border-radius:6px;overflow:hidden;cursor:${isCensorProcessing ? 'not-allowed' : 'pointer'};opacity:${isCensorProcessing && !isCurrent && item.status === 'pending' ? 0.5 : 1};" onclick="viewCensorQueueItem('${item.id}')" title="${item.file.name}"><img src="${item.resultUrl || item.objectUrl}" style="width:100%;height:100%;object-fit:cover;">${overlayIcon ? `<div style="position:absolute;bottom:0;right:0;background:rgba(0,0,0,0.6);padding:2px 4px;font-size:0.7em;">${overlayIcon}</div>` : ''}${item.status === 'pending' && !isCensorProcessing ? `<button onclick="event.stopPropagation();removeCensorQueueItem('${item.id}')" style="position:absolute;top:0;right:0;background:rgba(255,0,0,0.7);color:white;border:none;border-radius:0 0 0 4px;font-size:8px;padding:2px 4px;cursor:pointer;">X</button>` : ''}</div>`;
    });
    censorQueueContainer.innerHTML = html;
}

/** 큐에서 특정 항목 제거 */
function removeCensorQueueItem(id) {
    if (isCensorProcessing) return;
    censorQueue = censorQueue.filter(item => item.id !== id);
    censorQueue.length === 0 ? resetCensorTool() : renderCensorQueue();
}

/** 큐 항목 클릭 시 미리보기 또는 디테일 뷰어 표시 */
function viewCensorQueueItem(id) {
    if (isCensorProcessing) return;
    const item = censorQueue.find(i => i.id === id);
    if (!item) return;
    if (item.status === 'done' && item.resultUrl) {
        censorPreviewImg.style.display = 'none'; censorDropPlaceholder.style.display = 'none'; censorDropzone.style.display = 'none';
        document.getElementById('censor-detail-view').style.display = 'flex';
        initCensorDetailView(item);
    } else {
        document.getElementById('censor-detail-view').style.display = 'none'; censorDropzone.style.display = 'flex';
        censorPreviewImg.src = item.resultUrl || item.objectUrl; censorPreviewImg.style.display = 'block'; censorDropPlaceholder.style.display = 'none';
    }
}

/** 이미지를 ComfyUI input 폴더에 업로드 */
async function uploadCensorImageToServer(file) {
    const formData = new FormData();
    formData.append('image', file); formData.append('type', 'input'); formData.append('subfolder', ''); formData.append('overwrite', 'true');
    const result = await API.post('/upload/image', formData, true);
    return result.name;
}

/** 대기 중인 모든 이미지에 대해 검열 파이프라인을 순차 실행 */
async function runStandaloneCensor() {
    const pendingItems = censorQueue.filter(i => i.status === 'pending');
    if (pendingItems.length === 0) { alert("대기열에 처리할 이미지가 없습니다."); return; }
    if (!window.baseWorkflow) { alert("워크플로우 데이터를 기다리는 중입니다."); return; }

    const overrides = { isCensorOn: true, labels: [], censorMode: document.getElementById('tool-censor-mode').value, censorIntensity: parseInt(document.getElementById('tool-censor-intensity').value, 10) };
    const targetIds = ['nipples', 'pussy', 'penis', 'anus', 'testicles', 'xray', 'cross-section'];
    targetIds.forEach(id => { if (document.getElementById(`tool-censor-${id}`)?.checked) overrides.labels.push(id === 'xray' ? 'x-ray' : id); });
    if (overrides.labels.length === 0) { alert("최소 하나 이상의 검열 타겟 부위를 선택해주세요."); return; }

    const promptDataTemplate = JSON.parse(JSON.stringify(window.baseWorkflow));
    promptDataTemplate["9998"] = { "class_type": "LoadImage", "inputs": { "image": "" } };
    const currentImageSource = ["9998", 0];
    window.applyCensorPipeline(promptDataTemplate, currentImageSource, window.findNodeIdByTitle, overrides);

    for (const nodeId of Object.keys(promptDataTemplate)) {
        if (nodeId === "9998") continue;
        const title = promptDataTemplate[nodeId]?._meta?.title || "";
        if (!title.startsWith("[Censor]")) delete promptDataTemplate[nodeId];
    }
    const censorSaveId = window.findNodeIdByTitle(promptDataTemplate, "[Censor] Image Save");
    if (censorSaveId) promptDataTemplate[censorSaveId].inputs.filename_prefix = "censor/StandaloneCensor";

    window.isStandaloneExecution = true; isCensorProcessing = true;
    let processedCount = 0; const totalCount = pendingItems.length;

    for (let i = 0; i < censorQueue.length; i++) {
        const item = censorQueue[i];
        if (item.status !== 'pending') continue;
        currentCensorIndex = i; item.status = 'processing'; renderCensorQueue(); viewCensorQueueItem(item.id);
        processedCount++;
        updateCensorStatus(`[${processedCount}/${totalCount}] 서버로 이미지 전송 중...`, '#FF9800', (processedCount - 1) / totalCount * 100);
        try {
            const serverFilename = await uploadCensorImageToServer(item.file); item.serverFilename = serverFilename;
            updateCensorStatus(`[${processedCount}/${totalCount}] 검열 파이프라인 가동...`, '#FF9800', (processedCount - 0.5) / totalCount * 100);
            const promptData = JSON.parse(JSON.stringify(promptDataTemplate));
            promptData["9998"].inputs.image = serverFilename;
            const finalUrl = await executeStandaloneWorkflow(promptData);
            item.resultUrl = finalUrl; item.status = 'done'; censorPreviewImg.src = finalUrl;
        } catch (e) { console.error(`[Standalone Censor] Item ${item.file.name} error:`, e); item.status = 'error'; }
        renderCensorQueue();
    }
    window.isStandaloneExecution = false; isCensorProcessing = false; currentCensorIndex = -1; renderCensorQueue();
    updateCensorStatus("✅ 전체 대기열 검열 파이프라인 완료", '#4CAF50', 100);
}

/** 단독 워크플로우를 ComfyUI에 전송하고 웹소켓으로 완료를 대기하는 Promise */
function executeStandaloneWorkflow(promptData) {
    return new Promise(async (resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => { if (!settled) { settled = true; if (window.ws) window.ws.removeEventListener('message', tempHandler); reject(new Error("처리 시간 초과 (30초)")); } }, 30000);
        const tempHandler = function (event) {
            if (typeof event.data === "string") {
                const data = JSON.parse(event.data);
                if (data.type === 'execution_error') { if (!settled) { settled = true; clearTimeout(timeout); if (window.ws) window.ws.removeEventListener('message', tempHandler); reject(new Error(`ComfyUI 실행 에러: ${data.data?.exception_message || JSON.stringify(data)}`)); } return; }
                if (data.type === 'executed' && data.data && data.data.prompt_id) { if (!settled) { settled = true; clearTimeout(timeout); if (window.ws) window.ws.removeEventListener('message', tempHandler); if (data.data.output && data.data.output.images) { const imgInfo = data.data.output.images[0]; resolve(`/view?filename=${imgInfo.filename}&type=${imgInfo.type}&subfolder=${imgInfo.subfolder || ''}&t=${Date.now()}`); } else { resolve(null); } } }
            }
        };
        if (window.ws) { window.ws.addEventListener('message', tempHandler); } else { reject("웹소켓이 연결되지 않았습니다."); }
        try { await API.post('/prompt', { "prompt": promptData, "client_id": window.clientId }); } catch (e) { if (window.ws) window.ws.removeEventListener('message', tempHandler); reject(new Error(`프롬프트 POST 에러: ${e.message}`)); }
    });
}

/* ──────────────────────────────────────────────
   비교 슬라이더 & 리터치 캔버스
   ────────────────────────────────────────────── */

let currentDetailItem = null;
let sliderPos = 50;
let isDraggingSlider = false;

const censorWrapper = document.getElementById('censor-image-wrapper');
const imgAfter = document.getElementById('censor-img-after');
const imgBefore = document.getElementById('censor-img-before');
const compareSlider = document.getElementById('censor-compare-slider');
const retouchCanvas = document.getElementById('censor-retouch-canvas');
const ctx = retouchCanvas.getContext('2d');

let zoomScale = 1; let panX = 0; let panY = 0;
let isPanning = false; let startPanX = 0; let startPanY = 0;
let isDrawing = false; let lastDrawX = 0; let lastDrawY = 0;

const brushColorInput = document.getElementById('censor-brush-color-picker');
const brushSizeInput = document.getElementById('censor-brush-size');
const brushEraserInput = document.getElementById('censor-brush-eraser');
const brushColorPreview = document.getElementById('brush-color-preview');

brushColorInput.addEventListener('input', (e) => { brushColorPreview.style.background = e.target.value; });

/** 디테일 뷰어 초기화 (비교 슬라이더 + 리터치 캔버스) */
function initCensorDetailView(item) {
    currentDetailItem = item; imgAfter.src = item.resultUrl; imgBefore.src = item.objectUrl;
    zoomScale = 1; panX = 0; panY = 0; sliderPos = 50;
    updateDetailViewTransform(); updateCompareSlider();
    imgAfter.onload = () => { retouchCanvas.width = imgAfter.naturalWidth; retouchCanvas.height = imgAfter.naturalHeight; clearCensorCanvas(); };
}

function clearCensorCanvas() { ctx.clearRect(0, 0, retouchCanvas.width, retouchCanvas.height); }

if (compareSlider) { compareSlider.addEventListener('mousedown', (e) => { isDraggingSlider = true; e.preventDefault(); e.stopPropagation(); }); }
document.addEventListener('mousemove', (e) => { if (isDraggingSlider && currentDetailItem) { const rect = censorWrapper.getBoundingClientRect(); let x = Math.max(0, Math.min(e.clientX - rect.left, rect.width)); sliderPos = (x / rect.width) * 100; updateCompareSlider(); } });
document.addEventListener('mouseup', () => { isDraggingSlider = false; isPanning = false; isDrawing = false; });

/** 슬라이더 위치에 따라 Before 이미지 클립 영역 갱신 */
function updateCompareSlider() { if (compareSlider) compareSlider.style.left = `${sliderPos}%`; if (imgBefore) imgBefore.style.clipPath = `polygon(0 0, ${sliderPos}% 0, ${sliderPos}% 100%, 0 100%)`; }

const container = document.getElementById('censor-compare-container');
if (container) {
    container.addEventListener('wheel', (e) => { if (!currentDetailItem) return; e.preventDefault(); zoomScale *= e.deltaY < 0 ? 1.1 : 0.9; zoomScale = Math.max(0.1, Math.min(zoomScale, 10)); updateDetailViewTransform(); });
    container.addEventListener('mousedown', (e) => { if (!currentDetailItem || isDraggingSlider) return; if (e.button === 1 || e.button === 2) { isPanning = true; startPanX = e.clientX - panX; startPanY = e.clientY - panY; e.preventDefault(); } });
    container.addEventListener('mousemove', (e) => { if (isPanning) { panX = e.clientX - startPanX; panY = e.clientY - startPanY; updateDetailViewTransform(); } });
    container.addEventListener('contextmenu', e => e.preventDefault());
}

function updateDetailViewTransform() { censorWrapper.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomScale})`; }

/** 화면 좌표를 캔버스 픽셀 좌표로 변환 */
function getCanvasPos(e) { const rect = retouchCanvas.getBoundingClientRect(); return { x: (e.clientX - rect.left) * (retouchCanvas.width / rect.width), y: (e.clientY - rect.top) * (retouchCanvas.height / rect.height) }; }

if (retouchCanvas) {
    retouchCanvas.addEventListener('mousedown', (e) => { if (e.button !== 0 || isDraggingSlider || isPanning || !currentDetailItem) return; isDrawing = true; const pos = getCanvasPos(e); lastDrawX = pos.x; lastDrawY = pos.y; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; });
    retouchCanvas.addEventListener('mousemove', (e) => { if (!isDrawing) return; const pos = getCanvasPos(e); ctx.beginPath(); if (brushEraserInput.checked) { ctx.globalCompositeOperation = 'destination-out'; ctx.lineWidth = brushSizeInput.value; ctx.strokeStyle = 'rgba(0,0,0,1)'; } else { ctx.globalCompositeOperation = 'source-over'; ctx.lineWidth = brushSizeInput.value; ctx.strokeStyle = brushColorInput.value; } ctx.moveTo(lastDrawX, lastDrawY); ctx.lineTo(pos.x, pos.y); ctx.stroke(); lastDrawX = pos.x; lastDrawY = pos.y; });
    retouchCanvas.addEventListener('mouseleave', () => { isDrawing = false; });
}

/** 결과 이미지 위에 리터치 캔버스를 합성하여 서버에 저장 */
async function saveRetouchedImage() {
    if (isCensorProcessing || !currentDetailItem) return;
    const mergeCanvas = document.createElement('canvas'); mergeCanvas.width = retouchCanvas.width; mergeCanvas.height = retouchCanvas.height;
    const mtx = mergeCanvas.getContext('2d'); mtx.drawImage(imgAfter, 0, 0, mergeCanvas.width, mergeCanvas.height); mtx.drawImage(retouchCanvas, 0, 0);
    const blob = await new Promise(resolve => mergeCanvas.toBlob(resolve, 'image/png'));
    if (!blob) { alert("이미지 병합에 실패했습니다."); return; }
    const urlParams = new URLSearchParams(currentDetailItem.resultUrl.split('?')[1]);
    const filename = urlParams.get('filename'); const subfolder = urlParams.get('subfolder') || '';
    if (!filename) { alert("원본 파일명을 찾을 수 없습니다."); return; }
    updateCensorStatus("병합된 이미지 서버 저장 중...", '#FF9800');
    const formData = new FormData(); formData.append('image', blob, filename); formData.append('type', 'output'); formData.append('subfolder', subfolder); formData.append('overwrite', 'true');
    try { await API.post('/upload/image', formData, true); updateCensorStatus("✅ 덧칠 병합 및 저장 완료", '#4CAF50'); currentDetailItem.resultUrl = currentDetailItem.resultUrl.replace(/&t=\d+/, '') + `&t=${Date.now()}`; imgAfter.src = currentDetailItem.resultUrl; clearCensorCanvas(); renderCensorQueue(); }
    catch (e) { console.error("Merge upload failed", e); updateCensorStatus("저장 실패", '#ff5555'); }
}

/* ──────────────────────────────────────────────
   🆕 갤러리/생성 결과 → 모자이크 리터치 바로 열기
   (기능 확장: 모자이크 리터치 — "현재 리터치캔버스 있으니 활용"하라는 요청으로 추가.
   단독 검열기 탭은 "업로드 → 서버가 검열 → before/after 비교 → 리터치" 흐름이 기본인데,
   여기서는 이미 완성된(모자이크가 이미 박힌) output 이미지 한 장만 가지고 디테일 뷰어를 연다.
   원본(모자이크 치기 전) 이미지는 따로 안 남아있으므로 before/after 둘 다 같은 이미지로 채워서
   비교 슬라이더는 사실상 의미가 없고, 리터치 캔버스(덧칠 + 저장)만 쓰는 용도. ────────────────────────────────────────────── */

/**
 * 이미 서버(output 폴더)에 있는 이미지 파일 하나를 단독 검열기의 리터치 캔버스로 바로 연다.
 * saveRetouchedImage()가 resultUrl의 filename/subfolder 쿼리값을 그대로 읽어서 "같은 파일에
 * overwrite 저장"하기 때문에, 그 포맷(/view?filename=...&type=output&subfolder=...)만 맞춰주면
 * 큐에 등록된 적 없는 이미지도 똑같이 동작한다.
 * @param {string} filename - 서버 output 폴더 기준 파일명
 * @param {string} subfolder - 하위 폴더 경로(없으면 '')
 */
function openRetouchForImage(filename, subfolder) {
    if (!filename) { alert("리터치할 이미지 파일명을 찾을 수 없습니다."); return; }
    if (typeof openTab === 'function') {
        const btn = document.querySelector('.tab-btn[onclick*="tab-tools-censor"]');
        openTab('tab-tools-censor', btn);
    }
    const url = `/view?filename=${encodeURIComponent(filename)}&type=output&subfolder=${encodeURIComponent(subfolder || '')}&t=${Date.now()}`;
    // before/after 둘 다 같은 이미지(원본이 따로 없어서) — 비교 슬라이더는 의미 없고 리터치 캔버스만 쓰는 용도
    const item = { id: 'retouch_' + Date.now(), resultUrl: url, objectUrl: url, status: 'done' };
    if (censorPreviewImg) censorPreviewImg.style.display = 'none';
    if (censorDropPlaceholder) censorDropPlaceholder.style.display = 'none';
    if (censorDropzone) censorDropzone.style.display = 'none';
    const detailView = document.getElementById('censor-detail-view');
    if (detailView) detailView.style.display = 'flex';
    initCensorDetailView(item);
    updateCensorStatus("기존 이미지를 리터치 중 — 덧칠 후 '덧칠 저장'을 누르면 같은 파일에 덮어씌워집니다.", '#9C27B0');
}
window.openRetouchForImage = openRetouchForImage;

/** 갤러리 우클릭 메뉴("🖌️ 모자이크 리터치")에서 호출 — window.currentTargetImg를 그대로 사용 */
function retouchContextImage() {
    const target = window.currentTargetImg;
    if (!target || !target.filename) { alert("대상 이미지를 찾을 수 없습니다."); return; }
    openRetouchForImage(target.filename, target.subfolder || '');
}
window.retouchContextImage = retouchContextImage;

/** 완료된 이미지들을 ZIP으로 일괄 다운로드 */
async function downloadCensorZip() {
    if (isCensorProcessing) { alert("파이프라인이 실행 중입니다."); return; }
    const doneItems = censorQueue.filter(i => i.status === 'done' && i.resultUrl);
    if (doneItems.length === 0) { alert("다운로드할 완료된 이미지가 없습니다."); return; }
    const filenames = doneItems.map(item => { const params = new URLSearchParams(item.resultUrl.split('?')[1]); const name = params.get('filename'); const sub = params.get('subfolder'); return sub ? `${sub}/${name}` : name; }).filter(Boolean);
    if (filenames.length === 0) return;
    updateCensorStatus("ZIP 파일 생성 중...", '#FF9800');
    try {
        const blob = await API.post('/assetmanager/api/download_zip', { filenames });
        if (blob instanceof Blob) { const downloadUrl = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = downloadUrl; a.download = `Censored_Images_${Date.now()}.zip`; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(downloadUrl); updateCensorStatus(`✅ ${filenames.length}장 ZIP 다운로드 완료`, '#4CAF50'); }
        else { alert("ZIP 파일 생성에 실패했습니다: " + (blob.message || "알 수 없는 에러")); updateCensorStatus("ZIP 다운로드 실패", '#ff5555'); }
    } catch (e) { console.error("ZIP download exception:", e); updateCensorStatus("ZIP 다운로드 오류", '#ff5555'); }
}
