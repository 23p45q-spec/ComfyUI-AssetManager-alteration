/**
 * tools_resizer.js — 이미지 리사이즈 도구 모듈
 * 이미지를 드래그앤드롭으로 업로드하여 백엔드 API로 리사이즈/포맷 변환하고,
 * 결과를 큐 형태로 관리하며 ZIP으로 일괄 다운로드할 수 있습니다.
 * 지원 리사이즈 모드: 비율(scale), 최장변(longest), 정확한 크기(exact)
 */

let resizerQueue = [];
let isResizerProcessing = false;
let currentResizerIndex = -1;

const resizerDropzone = document.getElementById('resizer-dropzone');
const resizerFileInput = document.getElementById('resizer-file-input');
const resizerDropPlaceholder = document.getElementById('resizer-drop-placeholder');
const resizerQueueContainer = document.getElementById('resizer-queue-container');

/** 리사이즈 모드 변경 시 해당 입력 필드만 표시 */
function toggleResizerInputs() {
    const mode = document.getElementById('resizer-mode').value;
    document.getElementById('resizer-inputs-scale').style.display = (mode === 'scale') ? 'flex' : 'none';
    document.getElementById('resizer-inputs-longest').style.display = (mode === 'longest') ? 'flex' : 'none';
    document.getElementById('resizer-inputs-exact').style.display = (mode === 'exact') ? 'flex' : 'none';
    if (window.appStateManager) window.appStateManager.debounceSave();
}

/** 출력 포맷 변경 시 품질 슬라이더 표시/숨김 (PNG는 무손실이므로 숨김) */
function toggleResizerQuality() {
    const format = document.getElementById('resizer-format').value;
    document.getElementById('resizer-quality-container').style.display = (format === 'png') ? 'none' : 'flex';
    if (window.appStateManager) window.appStateManager.debounceSave();
}

/* 드래그앤드롭 & 파일 선택 이벤트 */
if (resizerDropzone) {
    resizerDropzone.addEventListener('click', (e) => { if (isResizerProcessing) return; resizerFileInput.click(); });
    resizerDropzone.addEventListener('dragover', (e) => { e.preventDefault(); if (isResizerProcessing) return; resizerDropzone.style.borderColor = '#9C27B0'; resizerDropzone.style.backgroundColor = '#2c1e30'; });
    resizerDropzone.addEventListener('dragleave', () => { if (isResizerProcessing) return; resizerDropzone.style.borderColor = '#555'; resizerDropzone.style.backgroundColor = 'transparent'; });
    resizerDropzone.addEventListener('drop', (e) => { e.preventDefault(); if (isResizerProcessing) return; resizerDropzone.style.borderColor = '#555'; resizerDropzone.style.backgroundColor = 'transparent'; if (e.dataTransfer.files && e.dataTransfer.files.length > 0) addFilesToResizerQueue(e.dataTransfer.files); });
}

if (resizerFileInput) {
    resizerFileInput.addEventListener('change', (e) => { if (isResizerProcessing) return; if (e.target.files && e.target.files.length > 0) addFilesToResizerQueue(e.target.files); resizerFileInput.value = ''; });
}

/** 이미지 파일들을 리사이즈 큐에 추가 */
function addFilesToResizerQueue(files) {
    let addedCount = 0;
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file.type.startsWith('image/')) continue;
        resizerQueue.push({ id: 'resize_' + Date.now() + '_' + i, file, objectUrl: URL.createObjectURL(file), status: 'pending', serverFilename: null, resultUrl: null });
        addedCount++;
    }
    if (addedCount > 0) { resizerDropPlaceholder.style.display = 'none'; renderResizerQueue(); updateResizerStatus(`${resizerQueue.length}장 대기 중`, '#aaa', 0); }
}

/** 큐 썸네일 리스트 렌더링 */
function renderResizerQueue() {
    if (resizerQueue.length === 0) { resizerQueueContainer.innerHTML = '<span id="resizer-queue-empty-msg" style="color: #666; font-size: 0.9em; margin: auto;">대기열이 비어 있습니다.</span>'; return; }
    let html = '';
    resizerQueue.forEach((item, index) => {
        let borderStyle = '1px solid #444', overlayHtml = '';
        if (item.status === 'processing') { borderStyle = '2px solid #2196F3'; overlayHtml = `<div style="position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;"><span style="font-size:2em;animation:spin 1s linear infinite;">⏳</span></div>`; }
        else if (item.status === 'done') { borderStyle = '2px solid #4CAF50'; overlayHtml = `<div style="position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(76,175,80,0.3);display:flex;align-items:center;justify-content:center;"><span style="font-size:2em;font-weight:bold;color:white;text-shadow:0 0 5px black;">✔️</span></div>`; }
        else if (item.status === 'error') { borderStyle = '2px solid #f44336'; overlayHtml = `<div style="position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(244,67,54,0.3);display:flex;align-items:center;justify-content:center;"><span style="font-size:2em;font-weight:bold;color:white;text-shadow:0 0 5px black;">❌</span></div>`; }
        const imgSrc = item.resultUrl ? item.resultUrl : item.objectUrl;
        html += `<div style="position:relative;flex:0 0 80px;height:80px;border-radius:6px;overflow:hidden;border:${borderStyle};cursor:pointer;" title="${item.file.name}"><img src="${imgSrc}" style="width:100%;height:100%;object-fit:cover;">${overlayHtml}<button onclick="removeResizerQueueItem(event, ${index})" style="position:absolute;top:2px;right:2px;background:rgba(0,0,0,0.6);color:white;border:none;border-radius:50%;width:20px;height:20px;font-size:10px;cursor:pointer;display:${isResizerProcessing ? 'none' : 'block'};">✖</button></div>`;
    });
    resizerQueueContainer.innerHTML = html;
}

/** 큐에서 특정 항목 제거 */
function removeResizerQueueItem(event, index) {
    if (event) event.stopPropagation();
    if (isResizerProcessing) return;
    const item = resizerQueue[index];
    if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
    resizerQueue.splice(index, 1);
    resizerQueue.length === 0 ? resetResizerTool() : (renderResizerQueue(), updateResizerStatus(`${resizerQueue.length}장 대기 중`, '#aaa', 0));
}

/** 도구를 기본 상태로 초기화 */
function resetResizerTool() {
    resizerQueue.forEach(item => { if (item.objectUrl) URL.revokeObjectURL(item.objectUrl); });
    resizerQueue = []; isResizerProcessing = false; currentResizerIndex = -1;
    resizerDropPlaceholder.style.display = 'block';
    updateResizerStatus('준비됨', '#aaa', 0); renderResizerQueue();
}

/** 상태 텍스트와 프로그레스 바 갱신 */
function updateResizerStatus(text, color, progressPercent = null) {
    const statusText = document.getElementById('resizer-status-text');
    if (statusText) { statusText.innerText = text; statusText.style.color = color; }
    if (progressPercent !== null) { const bar = document.getElementById('resizer-progress-bar'); if (bar) bar.style.width = `${progressPercent}%`; }
}

/** 대기열의 모든 이미지를 순차적으로 리사이즈 처리 */
async function runStandaloneResizer() {
    if (resizerQueue.length === 0) return alert("대기열에 이미지가 없습니다.");
    if (isResizerProcessing) return;
    const hasPending = resizerQueue.some(item => item.status === 'pending' || item.status === 'error');
    if (!hasPending) return alert("모든 변환 작업이 완료되었습니다.");

    isResizerProcessing = true; currentResizerIndex = -1;
    resizerDropzone.style.cursor = 'not-allowed'; renderResizerQueue();
    processNextResizerTarget();
}

/** 다음 대기 중인 항목을 찾아 리사이즈 API를 호출 */
async function processNextResizerTarget() {
    const nextIndex = resizerQueue.findIndex((item, idx) => idx > currentResizerIndex && (item.status === 'pending' || item.status === 'error'));
    if (nextIndex === -1) { isResizerProcessing = false; resizerDropzone.style.cursor = 'pointer'; renderResizerQueue(); updateResizerStatus('모든 변환 작업 완료!', '#4CAF50', 100); return; }

    currentResizerIndex = nextIndex;
    const item = resizerQueue[currentResizerIndex]; item.status = 'processing'; renderResizerQueue();
    const progressPercent = Math.round((currentResizerIndex / resizerQueue.length) * 100);
    updateResizerStatus(`[${currentResizerIndex + 1}/${resizerQueue.length}] 변환 중...`, '#03A9F4', progressPercent);

    try {
        const formData = new FormData(); formData.append("file", item.file);
        const mode = document.getElementById('resizer-mode').value;
        const format = document.getElementById('resizer-format').value;
        const quality = document.getElementById('resizer-quality').value;
        formData.append("mode", mode); formData.append("format", format); formData.append("quality", quality);
        if (mode === 'scale') formData.append("val_scale", document.getElementById('resizer-val-scale').value);
        else if (mode === 'longest') formData.append("val_longest", document.getElementById('resizer-val-longest').value);
        else if (mode === 'exact') { formData.append("val_width", document.getElementById('resizer-val-width').value); formData.append("val_height", document.getElementById('resizer-val-height').value); }

        const data = await API.post('/assetmanager/api/resize', formData, true);
        if (data.status === 'success') { item.status = 'done'; item.serverFilename = data.filename; item.resultUrl = data.url; }
        else { console.error("Resize failed:", data.message); item.status = 'error'; }
    } catch (e) { console.error("Network error during resize:", e); item.status = 'error'; }

    renderResizerQueue();
    setTimeout(processNextResizerTarget, 100);
}

/** 완료된 리사이즈 이미지들을 ZIP으로 일괄 다운로드 */
async function downloadResizerZip() {
    if (isResizerProcessing) return alert("현재 처리 중입니다.");
    const doneItems = resizerQueue.filter(item => item.status === 'done' && item.serverFilename);
    if (doneItems.length === 0) return alert("완료된 이미지가 없습니다.");

    updateResizerStatus('ZIP 압축 중...', '#FF9800');
    const filenames = doneItems.map(item => "AssetManager_Resized/" + item.serverFilename);
    try {
        const blob = await API.post('/assetmanager/api/download_zip', { filenames });
        if (blob instanceof Blob) { const url = window.URL.createObjectURL(blob); const a = document.createElement('a'); a.style.display = 'none'; a.href = url; a.download = `Resized_Images_${Date.now()}.zip`; document.body.appendChild(a); a.click(); window.URL.revokeObjectURL(url); document.body.removeChild(a); updateResizerStatus('ZIP 다운로드 완료', '#4CAF50'); }
        else { alert("ZIP 파일 생성에 실패했습니다: " + (blob.message || "알 수 없는 에러")); updateResizerStatus("ZIP 다운로드 실패", '#f44336'); }
    } catch (e) { console.error("Error downloading zip:", e); updateResizerStatus("ZIP 다운로드 실패", '#f44336'); }
}
