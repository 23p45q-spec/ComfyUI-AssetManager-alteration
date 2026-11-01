/* ──────────────────────────────────────────────
   🖼️ 프리셋 이미지 미리보기
   프리셋 개수가 많아져서, 목록에 마우스를 올리면 미리 등록해둔
   이미지가 뜨도록 하고, 그 이미지를 직접 추가/변경/삭제할 수 있게 한다.
   (native <select>는 option에 커스텀 hover를 못 붙이므로, 옆에
   버튼을 하나 두고 눌렀을 때 뜨는 목록형 패널에서 hover 미리보기를 제공)
   ────────────────────────────────────────────── */

/* ──────────────────────────────────────────────
   📦 프리셋 이미지 저장소: IndexedDB 사용
   (예전엔 localStorage에 저장했는데, 용량이 5~10MB밖에 안 돼서 프리셋 이미지 몇 개만
   등록해도 "저장 공간이 가득 찼습니다" 에러가 났음. IndexedDB는 사실상 용량 제한이
   거의 없어서 이 문제가 근본적으로 해결됨.)
   ────────────────────────────────────────────── */
let __presetImageDBPromise = null;
function openPresetImageDB() {
    if (__presetImageDBPromise) return __presetImageDBPromise;
    __presetImageDBPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('presetImagesDB', 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains('images')) {
                req.result.createObjectStore('images');
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return __presetImageDBPromise;
}

/** 예전에 localStorage에 저장해뒀던 프리셋 이미지들을, 딱 한 번 IndexedDB로 옮겨온다 */
async function migratePresetImagesFromLocalStorage() {
    if (localStorage.getItem('presetImagesMigratedToIDB')) return; // 이미 이사 끝남
    try {
        const db = await openPresetImageDB();
        const keysToMove = Object.keys(localStorage).filter(k => k.startsWith('presetImage_'));
        for (const lsKey of keysToMove) {
            const value = localStorage.getItem(lsKey);
            const presetKey = lsKey.slice('presetImage_'.length);
            if (value) await idbSet(db, presetKey, value);
            localStorage.removeItem(lsKey); // 옮겼으니 localStorage 자리는 비워줌
        }
        localStorage.setItem('presetImagesMigratedToIDB', '1');
    } catch (e) {
        console.error('프리셋 이미지 IndexedDB 이전 중 오류:', e);
    }
}

function idbGet(db, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('images', 'readonly');
        const req = tx.objectStore('images').get(key);
        req.onsuccess = () => resolve(req.result || '');
        req.onerror = () => reject(req.error);
    });
}
function idbSet(db, key, value) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('images', 'readwrite');
        tx.objectStore('images').put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
function idbDelete(db, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('images', 'readwrite');
        tx.objectStore('images').delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
function idbGetAllKeys(db) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('images', 'readonly');
        const req = tx.objectStore('images').getAllKeys();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

/** 프리셋 key에 등록된 미리보기 이미지(base64 dataURL)를 반환 */
async function getPresetImage(key) {
    try {
        await migratePresetImagesFromLocalStorage();
        const db = await openPresetImageDB();
        return await idbGet(db, key);
    } catch (e) {
        console.error('프리셋 이미지 조회 실패:', e);
        return '';
    }
}

/** 등록된 모든 프리셋 이미지의 key 목록 (있음/없음 표시용으로 한 번에 불러올 때 씀) */
async function getAllPresetImageKeys() {
    try {
        await migratePresetImagesFromLocalStorage();
        const db = await openPresetImageDB();
        return new Set(await idbGetAllKeys(db));
    } catch (e) {
        console.error('프리셋 이미지 키 목록 조회 실패:', e);
        return new Set();
    }
}

/** 업로드한 이미지를 미리보기용으로 축소+압축해서 dataURL(JPEG)로 반환. */
function resizeImageForPreset(file, maxSize = 768, quality = 0.92) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('파일을 읽지 못했습니다.'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('이미지를 불러오지 못했습니다.'));
            img.onload = () => {
                let { width, height } = img;
                if (width > height) {
                    if (width > maxSize) { height = Math.round(height * maxSize / width); width = maxSize; }
                } else {
                    if (height > maxSize) { width = Math.round(width * maxSize / height); height = maxSize; }
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', quality));
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

/** 프리셋 key에 미리보기 이미지를 저장 */
async function setPresetImage(key, dataUrl) {
    try {
        const db = await openPresetImageDB();
        await idbSet(db, key, dataUrl);
    } catch (e) {
        console.error(e);
        alert('이미지 저장에 실패했습니다: ' + e.message);
    }
}

/** 프리셋 key의 미리보기 이미지를 제거 */
async function removePresetImage(key) {
    try {
        const db = await openPresetImageDB();
        await idbDelete(db, key);
    } catch (e) { console.error(e); }
}

/** #gen-preset 옆에 "🖼️ 미리보기" 버튼이 없으면 만들어서 끼워넣는다 */
function ensurePresetPreviewButton() {
    if (document.getElementById('btn-preset-preview')) return;
    const sel = document.getElementById('gen-preset');
    if (!sel || !sel.parentElement) return;

    const btn = document.createElement('button');
    btn.id = 'btn-preset-preview';
    btn.type = 'button';
    btn.title = '프리셋에 마우스를 올리면 등록된 이미지를 미리 볼 수 있어요';
    btn.textContent = '🖼️';
    btn.style.cssText = 'margin-left:6px; padding:4px 10px; cursor:pointer; background:#333; border:1px solid #555; color:#fff; border-radius:4px; flex-shrink:0;';
    btn.onclick = togglePresetPreviewPanel;
    sel.insertAdjacentElement('afterend', btn);
}

/** 프리셋 미리보기 패널을 열고/닫는다. 목록에 마우스를 올리면 오른쪽에 이미지가 뜨고,
 *  클릭하면 그 프리셋으로 바로 전환된다. 이미지는 패널 안에서 추가/변경/삭제 가능. */
function togglePresetPreviewPanel() {
    const existing = document.getElementById('preset-preview-panel');
    if (existing) { existing.remove(); return; }
    openPresetPreviewPanelAsync();
}

async function openPresetPreviewPanelAsync() {
    const sel = document.getElementById('gen-preset');
    const btn = document.getElementById('btn-preset-preview');
    if (!sel || !btn) return;

    const panel = document.createElement('div');
    panel.id = 'preset-preview-panel';
    const rect = btn.getBoundingClientRect();
    panel.style.cssText = `
        position:absolute; z-index:1000; top:${rect.bottom + window.scrollY + 4}px; left:${rect.left + window.scrollX}px;
        background:#1a1a1a; border:1px solid #555; border-radius:8px; padding:10px;
        box-shadow:0 4px 16px rgba(0,0,0,0.5); display:flex; gap:10px; max-width:90vw;
    `;

    const listCol = document.createElement('div');
    listCol.style.cssText = 'display:flex; flex-direction:column; gap:2px; max-height:340px; overflow-y:auto; min-width:340px; user-select:none;';

    const hint = document.createElement('div');
    hint.textContent = '클릭 또는 누른 채 드래그: 지정(미리보기) · 더블클릭: 프리셋 교체';
    hint.style.cssText = 'font-size:0.72em; color:#888; margin-bottom:4px;';
    listCol.appendChild(hint);

    const rowsContainer = document.createElement('div');
    rowsContainer.style.cssText = 'display:grid; grid-template-columns:repeat(3, 1fr); gap:4px;';
    listCol.appendChild(rowsContainer);

    const previewCol = document.createElement('div');
    previewCol.style.cssText = 'width:360px; display:flex; flex-direction:column; align-items:center; gap:6px;';
    previewCol.innerHTML = `
        <div id="preset-preview-img-box" style="width:340px; height:340px; background:#111; border:1px dashed #444; border-radius:6px;
             display:flex; align-items:center; justify-content:center; overflow:hidden; color:#666; font-size:0.8em; text-align:center;">이미지 없음</div>
        <div id="preset-preview-name" style="font-size:0.82em; color:#ccc; text-align:center; min-height:1.2em;"></div>
        <input type="file" id="preset-preview-file-input" accept="image/*" style="display:none;">
        <div style="display:flex; gap:6px;">
            <button type="button" id="preset-preview-upload-btn" style="padding:4px 10px; font-size:0.8em; background:#333; border:1px solid #4CAF50; color:#4CAF50; border-radius:4px; cursor:pointer;">📷 이미지 추가/변경</button>
            <button type="button" id="preset-preview-remove-btn" style="padding:4px 10px; font-size:0.8em; background:#333; border:1px solid #e74c3c; color:#e74c3c; border-radius:4px; cursor:pointer;">제거</button>
        </div>
    `;

    let activeKey = sel.value;
    async function renderPreview(key, label) {
        activeKey = key;
        const img = await getPresetImage(key);
        previewCol.querySelector('#preset-preview-img-box').innerHTML =
            img ? `<img src="${img}" style="width:100%; height:100%; object-fit:cover;">` : '이미지 없음';
        previewCol.querySelector('#preset-preview-name').textContent = label || key;
    }

    let isDragging = false;
    function pickRow(row, opt) {
        rowsContainer.querySelectorAll('.picked').forEach(r => { r.classList.remove('picked'); r.style.background = ''; r.style.outline = ''; });
        row.classList.add('picked');
        row.style.background = '#3a2e10';
        row.style.outline = '1px solid #FF9800';
        renderPreview(opt.value, opt.textContent);
    }

    const presetImageKeys = await getAllPresetImageKeys(); // 한 번에 불러와서, 각 행마다 매번 IndexedDB 조회 안 하게 함

    Array.from(sel.options).forEach(opt => {
        const row = document.createElement('div');
        row.style.cssText = 'padding:5px 6px; cursor:pointer; border-radius:4px; font-size:0.8em; color:#ddd; display:flex; align-items:center; gap:5px; user-select:none; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;';
        const hasImg = presetImageKeys.has(opt.value);
        row.innerHTML = `${hasImg ? '🖼️' : '▫️'} <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${opt.textContent}</span>`;
        row.title = opt.textContent;
        row.dataset.optValue = opt.value;
        row.onclick = () => pickRow(row, opt);
        row.onmousedown = () => { isDragging = true; pickRow(row, opt); };
        row.ondblclick = () => {
            // 두번 클릭 = 실제로 이 프리셋으로 교체하고 패널 닫기
            sel.value = opt.value;
            if (typeof applyPreset === 'function') applyPreset();
            panel.remove();
        };
        rowsContainer.appendChild(row);
    });

    // 좌클릭 누른 채로 목록을 드래그(스크롤)하면, 지나가는 항목이 실시간으로 지정/미리보기 됨
    rowsContainer.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const target = document.elementFromPoint(e.clientX, e.clientY);
        const row = target && target.closest ? target.closest('[data-opt-value]') : null;
        if (!row || !rowsContainer.contains(row)) return;
        const opt = Array.from(sel.options).find(o => o.value === row.dataset.optValue);
        if (opt) pickRow(row, opt);
    });
    document.addEventListener('mouseup', () => { isDragging = false; });

    previewCol.querySelector('#preset-preview-upload-btn').onclick = () => {
        previewCol.querySelector('#preset-preview-file-input').click();
    };
    previewCol.querySelector('#preset-preview-file-input').onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        resizeImageForPreset(file)
            .then(dataUrl => setPresetImage(activeKey, dataUrl))
            .then(() => renderPreview(activeKey, previewCol.querySelector('#preset-preview-name').textContent))
            .catch(err => alert('이미지 처리 실패: ' + err.message));
    };
    previewCol.querySelector('#preset-preview-remove-btn').onclick = async () => {
        await removePresetImage(activeKey);
        renderPreview(activeKey, previewCol.querySelector('#preset-preview-name').textContent);
    };

    panel.appendChild(listCol);
    panel.appendChild(previewCol);
    document.body.appendChild(panel);

    const initialOpt = sel.options[sel.selectedIndex];
    renderPreview(sel.value, initialOpt ? initialOpt.textContent : '');

    setTimeout(() => {
        document.addEventListener('click', function closeOnOutside(e) {
            if (!panel.contains(e.target) && e.target !== btn) {
                panel.remove();
                document.removeEventListener('click', closeOnOutside);
            }
        });
    }, 0);
}

/**
 * window.loraOptionsHTML (로라 드롭다운 <option> 목록)이 아직 서버에서 안 채워졌을 수 있으므로,
 * 채워질 때까지 최대 3초간 짧게 폴링하며 기다린다. 이미 채워져 있으면 즉시 반환.
 * (addLoraRow()가 이 값이 비어있는 채로 호출되면 옵션 없는 빈 select가 만들어져
 *  프리셋의 로라가 "공백"으로 남는 문제를 막기 위함)
 */
function waitForLoraOptions(timeoutMs = 3000, intervalMs = 50) {
    return new Promise(resolve => {
        if (window.loraOptionsHTML) return resolve();
        const start = Date.now();
        const timer = setInterval(() => {
            if (window.loraOptionsHTML || Date.now() - start > timeoutMs) {
                clearInterval(timer);
                if (!window.loraOptionsHTML) {
                    console.warn('[프리셋] 로라 목록을 3초 안에 못 불러와서, 로라 없이 진행합니다.');
                }
                resolve();
            }
        }, intervalMs);
    });
}

/** 화면에 입력된 생성 설정 값을 객체로 캡처 (savePresetOverride / addNewPreset 공용) */
function captureCurrentGenState() {
    return {
        architecture: document.getElementById('gen-architecture')?.value,
        checkpoint: document.getElementById('gen-checkpoint')?.value,
        unet: document.getElementById('gen-unet')?.value,
        vae: document.getElementById('gen-vae')?.value,
        clip: document.getElementById('gen-clip')?.value,
        animaUseCheckpoint: document.getElementById('anima-use-checkpoint')?.checked || false,
        animaCheckpoint: document.getElementById('gen-anima-ckpt')?.value,
        sampler: document.getElementById('adv-sampler')?.value,
        scheduler: document.getElementById('adv-scheduler')?.value,
        steps: document.getElementById('adv-steps')?.value,
        cfg: document.getElementById('adv-cfg')?.value,
        pos: document.getElementById('base-pos')?.value,
        neg: document.getElementById('base-neg')?.value,
        loras: [...document.querySelectorAll('#selected-loras .lora-item')]
            .map(item => ({
                lora: item.querySelector('select').value,
                strength: parseFloat(item.querySelector('input[type="number"]').value)
            }))
            .filter(l => l.lora), // 이름 없는(선택 안 된) 로라 행은 저장에서 제외
        ipadapter: {
            enabled: document.getElementById('toggle-ipadapter')?.checked || false,
            model: document.getElementById('ipadapter-model')?.value || '',
            clipVision: document.getElementById('ipadapter-clip-vision')?.value || '',
            weight: document.getElementById('ipadapter-weight')?.value || '0.6',
            weightType: document.getElementById('ipadapter-weight-type')?.value || 'linear',
            start: document.getElementById('ipadapter-start')?.value || '0.0',
            end: document.getElementById('ipadapter-end')?.value || '1.0',
            uploadedName: window._ipadapterUploadedName || null
        },
        controlnet: {
            enabled: document.getElementById('toggle-controlnet')?.checked || false,
            preprocessor: document.getElementById('controlnet-preprocessor')?.value || 'CannyEdgePreprocessor',
            model: document.getElementById('controlnet-model')?.value || '',
            strength: document.getElementById('controlnet-strength')?.value || '1.0',
            start: document.getElementById('controlnet-start')?.value || '0.0',
            end: document.getElementById('controlnet-end')?.value || '1.0',
            uploadedName: window._controlnetUploadedName || null
        },
        inpaint: {
            enabled: document.getElementById('toggle-inpaint')?.checked || false,
            denoise: document.getElementById('inpaint-denoise')?.value || '0.75',
            growMask: document.getElementById('inpaint-grow-mask')?.value || '6',
            uploadedName: window._inpaintUploadedName || null,
            uploadedMaskName: window._inpaintUploadedMaskName || null
        },
        img2img: {
            enabled: document.getElementById('toggle-img2img')?.checked || false,
            denoise: document.getElementById('img2img-denoise')?.value || '0.65',
            uploadedName: window._img2imgUploadedName || null
        }
    };
}

/**
 * 🆕 스케줄러/샘플러/VAE 수동 추가
 * 서버의 object_info 목록(혹은 고정 목록)에 아직 안 뜨는 모델/값이 있을 때,
 * 이름을 직접 입력해서 드롭다운에 추가하고 바로 선택할 수 있게 해준다.
 * localStorage에 저장해두고, 목록이 다시 로드(예: VAE 재시도)돼도 사라지지 않게 재주입한다.
 */
const CUSTOM_MODEL_OPTIONS_KEY = 'customModelDropdownOptions'; // { [selectId]: string[] }

function getCustomModelOptions(selectId) {
    try {
        const all = JSON.parse(localStorage.getItem(CUSTOM_MODEL_OPTIONS_KEY) || '{}');
        return Array.isArray(all[selectId]) ? all[selectId] : [];
    } catch (e) {
        return [];
    }
}

/** entry는 문자열(값=표시용, 기존 동작) 또는 { value, label }(표시 텍스트를 따로 지정하고 싶을 때) */
function saveCustomModelOption(selectId, entry) {
    try {
        const value = (typeof entry === 'object' && entry) ? entry.value : entry;
        const all = JSON.parse(localStorage.getItem(CUSTOM_MODEL_OPTIONS_KEY) || '{}');
        all[selectId] = all[selectId] || [];
        const exists = all[selectId].some(v => (typeof v === 'object' ? v.value : v) === value);
        if (!exists) all[selectId].push(entry);
        localStorage.setItem(CUSTOM_MODEL_OPTIONS_KEY, JSON.stringify(all));
    } catch (e) {
        console.warn('[수동 추가] 저장 실패:', e);
    }
}

/** ✖ 버튼으로 수동 추가한 항목을 다시 지울 수 있게 */
function removeCustomModelOption(selectId, value) {
    try {
        const all = JSON.parse(localStorage.getItem(CUSTOM_MODEL_OPTIONS_KEY) || '{}');
        all[selectId] = (all[selectId] || []).filter(v => (typeof v === 'object' ? v.value : v) !== value);
        localStorage.setItem(CUSTOM_MODEL_OPTIONS_KEY, JSON.stringify(all));
    } catch (e) { /* 무시 */ }
}
window.removeCustomModelOption = removeCustomModelOption;

/** 저장해둔 수동 추가 항목들을 select에 다시 채워넣는다 (이미 있으면 중복 추가 안 함).
 *  서버 목록을 새로 불러오는 함수(loadVAEList 등)들이 innerHTML을 통째로 갈아치우므로,
 *  그 직후에 반드시 이 함수를 다시 호출해줘야 커스텀 항목이 유지된다. */
function reapplyCustomModelOptions(selectId) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    getCustomModelOptions(selectId).forEach(entry => {
        const value = (typeof entry === 'object' && entry) ? entry.value : entry;
        const label = (typeof entry === 'object' && entry && entry.label) ? entry.label : `✏️ ${value} (수동 추가)`;
        if (![...sel.options].some(o => o.value === value)) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            sel.appendChild(opt);
        }
    });
}

/** select 옆에 "＋" 버튼을 붙여서, 목록에 없는 값을 이름으로 직접 추가할 수 있게 한다. */
function addManualEntryButton(selectId, { label = '항목' } = {}) {
    const sel = document.getElementById(selectId);
    if (!sel || document.getElementById(`${selectId}-manual-add-btn`)) return; // 요소 없거나 이미 붙어있으면 스킵

    const btn = document.createElement('button');
    btn.id = `${selectId}-manual-add-btn`;
    btn.type = 'button';
    btn.textContent = '＋';
    btn.title = `목록에 안 보이는 ${label}을(를) 이름으로 직접 추가`;
    btn.style.cssText = 'margin-left:4px; padding:2px 8px; font-size:0.85em; background:#333; border:1px solid #888; color:#ccc; border-radius:4px; cursor:pointer; vertical-align:middle;';
    btn.addEventListener('click', () => {
        const value = prompt(`목록에 없는 ${label}을(를) 정확한 이름으로 입력하세요 (예: 파일명 그대로, comfy_name 등):`, '');
        if (!value || !value.trim()) return;
        const trimmed = value.trim();
        saveCustomModelOption(selectId, trimmed);
        reapplyCustomModelOptions(selectId);
        sel.value = trimmed;
        sel.disabled = false; // SDXL 잠금 등으로 비활성화돼 있었더라도 수동 지정 값은 쓸 수 있게 풀어줌
        // 다른 change 리스너(appStateManager 자동저장 등)가 반응하도록 이벤트를 흘려보냄.
        // 단, 프리셋 오버라이드 자동저장 리스너는 isTrusted 이벤트만 반응하므로(복원 중 오작동 방지),
        // 프로그램이 만든 이 이벤트는 안 걸린다 → savePresetOverride()를 직접 호출해서 저장해준다.
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        if (typeof savePresetOverride === 'function') savePresetOverride();
    });

    sel.insertAdjacentElement('afterend', btn);
}

function setupManualModelEntryButtons() {
    addManualEntryButton('adv-sampler', { label: '샘플러' });
    addManualEntryButton('adv-scheduler', { label: '스케줄러' });
    addManualEntryButton('gen-vae', { label: 'VAE' });
    reapplyCustomModelOptions('adv-sampler');
    reapplyCustomModelOptions('adv-scheduler');
    reapplyCustomModelOptions('gen-vae');
}

/** 현재 화면 상태를 프리셋 오버라이드로 저장 (기존 오버라이드에 병합 — 통째로 덮어쓰지 않음) */
function savePresetOverride() {
    /* 초기 로딩 중(applyState 완료 전)에는 DOM 값이 아직 복원되지 않은 상태이므로
       저장하면 기본값(0.65 등)이 오버라이드에 덮어씌워진다 → 반드시 가드 */
    if (!window.appStateLoaded) return;
    const key = document.getElementById('gen-preset')?.value;
    if (!key) return; // 프리셋 선택 안 한 상태면 저장 안 함

    const existingRaw = localStorage.getItem(`presetOverride_${key}`);
    const existing = existingRaw ? JSON.parse(existingRaw) : {};
    const merged = { ...existing, ...captureCurrentGenState() };

    try {
        localStorage.setItem(`presetOverride_${key}`, JSON.stringify(merged));
    } catch (e) {
        console.error('[Preset] 저장 실패 (localStorage 용량 초과 가능성):', e);
        alert('프리셋 저장에 실패했습니다. 저장 공간이 가득 찼을 수 있습니다. 백업 파일로 내보내기를 해두는 것을 권장합니다.');
    }
}

/** 저장된 오버라이드가 있으면 기본 프리셋 값에 덮어씌워 반환 */
function getEffectivePreset(key) {
    const base = window.MODEL_PRESETS[key];
    const saved = localStorage.getItem(`presetOverride_${key}`);
    if (!saved) return base;
    try {
        return { ...base, ...JSON.parse(saved) };
    } catch (e) {
        return base;
    }
}

window.MODEL_PRESETS = {
    "wai_sdxl": {
        label: "WAI Illustrious SDXL",
        architecture: "sdxl",
        checkpoint: "iIllustrious\\waiIllustriousSDXL_v160.safetensors",
        vae: "",
        clip: "",
        sampler: "euler_ancestral",
        scheduler: "karras",
        steps: 28,
        cfg: 5,
        pos: "여기에 긍정 프롬프트",   // ← 내용 알려주면 채워줄게
        neg: "여기에 부정 프롬프트",   // ← 내용 알려주면 채워줄게
        loras: []
    },
    "nova_anime_am": {
        label: "Nova Anime AM (Anima)",
        architecture: "anima",
        unet: "novaAnimeAM_v20.safetensors",
        clip: "qwen_3_06b_base.safetensors",
        vae: "qwen_image_vae.safetensors",
        sampler: "euler_ancestral",
        scheduler: "simple",
        steps: 28,
        cfg: 4,
        pos: "",   // ← 내용 알려주면 채워줄게
        neg: "",   // ← 내용 알려주면 채워줄게
        loras: [
            { lora: "anima.safetensors", strength: 0.8 }
        ]
    }
};

const CUSTOM_PRESETS_KEY = 'customPresets';

/** localStorage에 저장된 사용자 정의 프리셋들을 불러와 MODEL_PRESETS에 합친다 */
function loadCustomPresets() {
    try {
        const saved = JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY) || '{}');
        Object.assign(window.MODEL_PRESETS, saved);
    } catch (e) {
        console.warn("커스텀 프리셋 로드 실패:", e);
    }
}
loadCustomPresets(); // MODEL_PRESETS 정의 직후 바로 합쳐둠 (DOM 필요 없음)

const DEFAULT_PRESET_KEY = 'defaultPreset';

/** ⭐ 기본 버튼: 현재 선택된 프리셋을 새로고침 시 자동 적용할 기본으로 저장 */
function setDefaultPreset() {
    const sel = document.getElementById('gen-preset');
    const key = sel?.value;
    if (!key) { alert("기본으로 설정할 프리셋을 먼저 선택하세요."); return; }
    localStorage.setItem(DEFAULT_PRESET_KEY, key);
    const label = window.MODEL_PRESETS[key]?.label || key;
    alert(`"${label}"이(가) 기본 프리셋으로 설정되었습니다.`);
}




function exportPresetsToFile() {
    const data = {
        __type: 'comfy_preset_backup',
        __version: 1,
        savedAt: new Date().toISOString(),
        customPresets: JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY) || '{}'),
        defaultPreset: localStorage.getItem(DEFAULT_PRESET_KEY) || null,
        overrides: {}
    };

    // presetOverride_* 키들을 전부 수집 (기본 제공 프리셋에 대한 사용자 수정값)
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('presetOverride_')) {
            try {
                data.overrides[k] = JSON.parse(localStorage.getItem(k));
            } catch (e) { /* 손상된 값은 건너뜀 */ }
        }
    }

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `preset_backup_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

/** 📂 복원: 백업 JSON 파일을 선택받아 localStorage에 다시 채워넣기 */
function importPresetsFromFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        try {
            const data = JSON.parse(reader.result);
            if (data.__type !== 'comfy_preset_backup') {
                alert('이 파일은 프리셋 백업 파일이 아닌 것 같습니다.');
                return;
            }

            if (!confirm('현재 저장된 프리셋/오버라이드를 백업 파일 내용으로 덮어씁니다. 계속할까요?')) return;

            if (data.customPresets) {
                localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(data.customPresets));
                Object.assign(window.MODEL_PRESETS, data.customPresets);
            }
            if (data.defaultPreset) {
                localStorage.setItem(DEFAULT_PRESET_KEY, data.defaultPreset);
            }
            if (data.overrides) {
                Object.entries(data.overrides).forEach(([k, v]) => {
                    localStorage.setItem(k, JSON.stringify(v));
                });
            }

            syncPresetDropdownOptions();
            alert('복원 완료! 페이지를 새로고침합니다.');
            location.reload();
        } catch (e) {
            console.error('[Preset] 복원 실패:', e);
            alert('백업 파일을 읽는 중 오류가 발생했습니다.');
        }
    };
    reader.readAsText(file);
}


/**
 * 🧹 로컬스토리지 수동 청소 (안전 모드)
 * - 오직 "이미 삭제된 프리셋"의 오버라이드 값만 지운다 (presetOverride_<key> 인데
 *   window.MODEL_PRESETS에 더 이상 해당 key가 없는 경우 = 고아 캐시).
 * - customPresets, defaultPreset, 살아있는 프리셋의 presetOverride_* 값은 절대 건드리지 않음.
 * - 버튼을 눌렀을 때만 실행됨 (자동 실행 아님).
 */
function cleanupOrphanedPresetCache() {
    // 청소 전 안전망: 만약을 위해 현재 상태를 먼저 백업 파일로 내려받음
    try {
        exportPresetsToFile();
    } catch (e) {
        console.warn('[Cleanup] 청소 전 자동 백업 실패:', e);
    }

    const removed = [];
    for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith('presetOverride_')) continue; // 프리셋 관련 키가 아니면 무시

        const presetKey = k.slice('presetOverride_'.length);
        if (!(presetKey in window.MODEL_PRESETS)) {
            // 해당 프리셋이 더 이상 존재하지 않음 → 고아 캐시이므로 삭제
            localStorage.removeItem(k);
            removed.push(k);
        }
    }

    if (removed.length > 0) {
        console.log(`[Cleanup] 삭제된 프리셋의 고아 캐시 ${removed.length}개 정리 완료:`, removed);
        alert(`정리 완료: 더 이상 쓰지 않는 캐시 ${removed.length}개를 삭제했습니다.`);
    } else {
        alert('정리할 캐시가 없습니다. 이미 깨끗한 상태예요.');
    }
    return removed;
}

/** #gen-preset 드롭다운에 MODEL_PRESETS 중 아직 옵션으로 없는 항목을 추가하고,
 *  이미 있는 옵션은 오버라이드에 저장된 이름(있으면)으로 텍스트를 갱신 */
function syncPresetDropdownOptions() {
    const sel = document.getElementById('gen-preset');
    if (!sel) return;
    Object.keys(window.MODEL_PRESETS).forEach(key => {
        const effectiveLabel = getEffectivePreset(key)?.label || window.MODEL_PRESETS[key].label || key;
        let opt = sel.querySelector(`option[value="${key}"]`);
        if (!opt) {
            opt = document.createElement('option');
            opt.value = key;
            sel.appendChild(opt);
        }
        opt.textContent = effectiveLabel;
    });
}

/** "프리셋 추가" 버튼: 지금 화면에 입력된 설정을 그대로 캡처해서 새 프리셋으로 저장 (브라우저 로컬 한정) */
function addNewPreset() {
    const label = prompt("새 프리셋 이름을 입력하세요:");
    if (!label || !label.trim()) return;

    const key = `custom_${Date.now()}`;
    const newPreset = { label: label.trim(), ...captureCurrentGenState() };

    // 지금 화면의 아키텍처(sdxl/anima/sd3)가 뭔지 저장 직전에 한 번 더 확인시켜준다.
    // (이름은 "OO 아니마"라고 지어놓고 실제로는 SDXL 상태에서 저장해버리는 실수 방지)
    const archLabelMap = { sdxl: 'SDXL', anima: 'Anima', sd3: 'SD3/SD3.5' };
    const archLabel = archLabelMap[newPreset.architecture] || newPreset.architecture || '(알 수 없음)';
    const proceed = confirm(`"${label.trim()}" 프리셋을 지금 화면의 아키텍처(${archLabel}) 기준으로 저장합니다.\n\n아키텍처가 맞나요? 다르면 취소하고 위쪽 "아키텍처" 드롭다운을 먼저 바꾼 뒤 다시 시도해 주세요.`);
    if (!proceed) return;

    // 1) 메모리에 즉시 반영 (지금 바로 선택해서 쓸 수 있도록)
    window.MODEL_PRESETS[key] = newPreset;

    // 2) localStorage에 영구 저장
    const saved = JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY) || '{}');
    saved[key] = newPreset;
    localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(saved));

    // 3) 드롭다운에 옵션 추가하고 방금 만든 프리셋으로 선택 전환
    syncPresetDropdownOptions();
    const sel = document.getElementById('gen-preset');
    if (sel) sel.value = key;

    alert(`"${label.trim()}" 프리셋이 저장되었습니다. (아키텍처: ${archLabel})`);
}

/** "이름 수정" 버튼: 선택된 프리셋의 표시 이름(label)만 변경. 커스텀/기본 프리셋 둘 다 가능 */
function renamePreset() {
    const sel = document.getElementById('gen-preset');
    const key = sel?.value;
    if (!key) {
        alert("이름을 수정할 프리셋을 먼저 선택하세요.");
        return;
    }

    const preset = window.MODEL_PRESETS[key];
    if (!preset) return;

    const newLabel = prompt("새 이름을 입력하세요:", preset.label || key);
    if (!newLabel || !newLabel.trim()) return;
    const trimmed = newLabel.trim();

    // 1) 메모리 즉시 반영
    preset.label = trimmed;

    // 2) 영구 저장 — 커스텀 프리셋은 본체에 바로, 기본 프리셋은 오버라이드에 끼워서
    if (key.startsWith('custom_')) {
        const saved = JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY) || '{}');
        if (saved[key]) {
            saved[key].label = trimmed;
            localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(saved));
        }
    } else {
        const overrideRaw = localStorage.getItem(`presetOverride_${key}`);
        const override = overrideRaw ? JSON.parse(overrideRaw) : {};
        override.label = trimmed;
        localStorage.setItem(`presetOverride_${key}`, JSON.stringify(override));
    }

    // 3) 드롭다운에 보이는 텍스트도 즉시 갱신
    const opt = sel.querySelector(`option[value="${key}"]`);
    if (opt) opt.textContent = trimmed;

    if (window.appStateManager) window.appStateManager.debounceSave();
}

/**
 * 🔀 프리셋 병합
 * 두 프리셋을 골라 하나의 새 프리셋으로 합친다.
 * - 아키텍처/체크포인트/UNet/VAE/CLIP/샘플러/스케줄러/steps/cfg 등 "환경 설정"은
 *   지정한 기본 프리셋 쪽 값을 그대로 따라간다.
 * - 로라는 두 프리셋의 로라를 합치되, 같은 로라 파일이 겹치면 하나로(기본 프리셋 쪽 강도 우선).
 * - 긍정/부정 프롬프트는 콤마 기준으로 토큰을 합치고, 겹치는 표현은 하나만 남긴다.
 * 결과는 새 커스텀 프리셋으로 저장된다 (원본 두 프리셋은 그대로 유지).
 */
function openMergePresetsModal() {
    const keys = Object.keys(window.MODEL_PRESETS);
    if (keys.length < 2) return alert("병합하려면 프리셋이 2개 이상 있어야 합니다.");

    if (!document.getElementById('merge-presets-modal')) {
        const modal = document.createElement('div');
        modal.id = 'merge-presets-modal';
        modal.className = 'modal-overlay';
        modal.style.cssText = 'display:none;';
        modal.onclick = function (e) { if (e.target === this) closeMergePresetsModal(); };
        modal.innerHTML = `
            <div class="modal-content" onclick="event.stopPropagation()" style="width:480px; max-height:80vh; overflow-y:auto;">
                <div class="modal-header">
                    <h3 style="margin:0; color:#4CAF50;">🔀 프리셋 병합</h3>
                    <span class="close-btn" style="position:static; font-size:1.5em; color:#ff5555;" onclick="closeMergePresetsModal()">&times;</span>
                </div>
                <div class="modal-body" style="display:flex; flex-direction:column; gap:12px;">
                    <p style="font-size:0.85em; color:#aaa; margin:0;">
                        <b style="color:#FF9800;">기본</b>으로 고른 쪽의 아키텍처/체크포인트/샘플러/스케줄러/steps/cfg를 그대로 따라갑니다.<br>
                        로라와 프롬프트는 두 프리셋 걸 합치고, 겹치는 항목은 하나로 정리됩니다.
                    </p>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <label style="width:70px; font-size:0.88em; color:#FF9800; flex-shrink:0;">기본 ⭐</label>
                        <select id="merge-preset-a" style="flex:1; padding:5px; background:#222; border:1px solid #FF9800; color:#fff; border-radius:4px;"></select>
                    </div>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <label style="width:70px; font-size:0.88em; color:#ccc; flex-shrink:0;">합칠 쪽</label>
                        <select id="merge-preset-b" style="flex:1; padding:5px; background:#222; border:1px solid #555; color:#fff; border-radius:4px;"></select>
                    </div>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <label style="width:70px; font-size:0.88em; color:#ccc; flex-shrink:0;">새 이름</label>
                        <input type="text" id="merge-preset-name" placeholder="병합된 프리셋 이름"
                            style="flex:1; padding:5px 8px; background:#222; border:1px solid #555; color:#fff; border-radius:4px;">
                    </div>
                    <button class="btn-primary" onclick="executeMergePresets()" style="padding:12px; margin-top:4px;">
                        🔀 병합해서 새 프리셋으로 저장
                    </button>
                </div>
            </div>`;
        document.body.appendChild(modal);
    }

    const optsHtml = keys.map(k => {
        const label = getEffectivePreset(k)?.label || window.MODEL_PRESETS[k].label || k;
        return `<option value="${k}">${label}</option>`;
    }).join('');
    const selA = document.getElementById('merge-preset-a');
    const selB = document.getElementById('merge-preset-b');
    selA.innerHTML = optsHtml;
    selB.innerHTML = optsHtml;

    // 편의상 현재 선택된 프리셋을 기본(A) 쪽에 미리 선택해둔다
    const currentKey = document.getElementById('gen-preset')?.value;
    if (currentKey) selA.value = currentKey;
    // B는 A와 겹치지 않는 다른 값으로 기본 선택
    if (selB.value === selA.value) {
        const other = keys.find(k => k !== selA.value);
        if (other) selB.value = other;
    }

    document.getElementById('merge-preset-name').value = '';
    document.getElementById('merge-presets-modal').style.display = 'flex';
}

function closeMergePresetsModal() {
    const modal = document.getElementById('merge-presets-modal');
    if (modal) modal.style.display = 'none';
}

/** 콤마로 구분된 프롬프트 문자열 둘을 합치고, 공백/대소문자 차이를 무시한 뒤 겹치는 토큰은 하나만 남긴다.
 *  순서는 a의 토큰들 먼저, 그 다음 b에만 있던 토큰들이 이어붙는다. */
function mergePromptStrings(a, b) {
    const seen = new Set();
    const out = [];
    [a, b].forEach(str => {
        (str || '').split(',').forEach(raw => {
            const token = raw.trim();
            if (!token) return;
            const normKey = token.toLowerCase().replace(/\s+/g, ' ');
            if (seen.has(normKey)) return;
            seen.add(normKey);
            out.push(token);
        });
    });
    return out.join(', ');
}

/** 로라 배열 둘을 합친다. 같은 로라 파일(lora 값)이 양쪽에 있으면 기본(primary) 쪽 강도를 우선하고,
 *  secondary 쪽에만 있는 로라는 그대로 뒤에 붙인다. */
function mergeLoraArrays(primaryLoras, secondaryLoras) {
    const primary = Array.isArray(primaryLoras) ? primaryLoras : [];
    const secondary = Array.isArray(secondaryLoras) ? secondaryLoras : [];
    const seen = new Set(primary.map(l => l.lora));
    const merged = primary.map(l => ({ ...l }));
    secondary.forEach(l => {
        if (l && l.lora && !seen.has(l.lora)) {
            seen.add(l.lora);
            merged.push({ ...l });
        }
    });
    return merged;
}

function executeMergePresets() {
    const keyA = document.getElementById('merge-preset-a')?.value; // 기본
    const keyB = document.getElementById('merge-preset-b')?.value; // 합칠 쪽
    if (!keyA || !keyB) return alert("두 프리셋을 모두 선택하세요.");
    if (keyA === keyB) return alert("서로 다른 프리셋 두 개를 선택하세요.");

    const nameInput = document.getElementById('merge-preset-name')?.value?.trim();
    const presetA = getEffectivePreset(keyA);
    const presetB = getEffectivePreset(keyB);
    if (!presetA || !presetB) return alert("프리셋 정보를 불러오지 못했습니다.");

    const labelA = presetA.label || keyA;
    const labelB = presetB.label || keyB;
    const mergedLabel = nameInput || `${labelA} + ${labelB}`;

    // 아키텍처/모델 로딩 관련 필드는 전부 기본(A) 쪽을 그대로 따라간다.
    // (SDXL은 checkpoint, Anima/SD3는 unet+clip+vae 조합을 쓰므로 둘 다 그대로 복사)
    const merged = {
        label: mergedLabel,
        architecture: presetA.architecture,
        checkpoint: presetA.checkpoint,
        unet: presetA.unet,
        vae: presetA.vae,
        clip: presetA.clip,
        animaUseCheckpoint: presetA.animaUseCheckpoint,
        animaCheckpoint: presetA.animaCheckpoint,
        sampler: presetA.sampler,
        scheduler: presetA.scheduler,
        steps: presetA.steps,
        cfg: presetA.cfg,
        pos: mergePromptStrings(presetA.pos, presetB.pos),
        neg: mergePromptStrings(presetA.neg, presetB.neg),
        loras: mergeLoraArrays(presetA.loras, presetB.loras)
    };

    const key = `custom_${Date.now()}`;
    window.MODEL_PRESETS[key] = merged;

    const saved = JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY) || '{}');
    saved[key] = merged;
    localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(saved));

    syncPresetDropdownOptions();
    const sel = document.getElementById('gen-preset');
    if (sel) {
        sel.value = key;
        applyPreset();
    }

    closeMergePresetsModal();
    alert(`"${mergedLabel}" 프리셋으로 병합 완료.\n(환경설정: ${labelA} 기준 / 로라·프롬프트: 둘 다 합쳐서 중복 제거)`);
}

/**
 * IP-Adapter 관련 UI를 프리셋 데이터(ipa)에 맞게 설정.
 * ipa가 없거나 enabled가 false면 토글을 끄고 업로드 캐시/미리보기 상태도 초기화한다.
 * (프리셋을 바꿔도 이전 프리셋의 IP-Adapter 설정이 남아있던 버그 수정)
 */
function applyIPAdapterPresetUI(ipa) {
    const toggle = document.getElementById('toggle-ipadapter');

    if (!ipa || !ipa.enabled) {
        // 이 프리셋엔 IP-Adapter 설정이 없음 (또는 꺼져 있음) → 화면을 깨끗하게 초기화
        if (toggle) {
            toggle.checked = false;
            toggleSubOptions('ipadapter-opts', toggle);
        }
        window._ipadapterUploadedName = null;
        const statusEl = document.getElementById('ipadapter-upload-status');
        if (statusEl) statusEl.textContent = '';
        const nameEl = document.getElementById('ipadapter-image-name');
        if (nameEl) nameEl.textContent = '';
        const previewWrap = document.getElementById('ipadapter-preview-wrap');
        if (previewWrap) previewWrap.style.display = 'none';
        const img = document.getElementById('ipadapter-preview-img');
        if (img) img.src = '';
        return;
    }

    if (toggle) {
        toggle.checked = ipa.enabled || false;
        toggleSubOptions('ipadapter-opts', toggle);
    }

    const modelSel = document.getElementById('ipadapter-model');
    if (modelSel && ipa.model) {
        // 옵션이 로딩된 후 값 설정 (동적 로딩 대기)
        const trySet = () => {
            if ([...modelSel.options].some(o => o.value === ipa.model)) {
                modelSel.value = ipa.model;
            } else if (ipa.model) {
                const opt = document.createElement('option');
                opt.value = ipa.model; opt.textContent = ipa.model;
                modelSel.appendChild(opt);
                modelSel.value = ipa.model;
            }
        };
        if (modelSel.options.length <= 1) setTimeout(trySet, 800);
        else trySet();
    }

    const cvSel = document.getElementById('ipadapter-clip-vision');
    if (cvSel && ipa.clipVision) {
        const trySetCV = () => {
            if ([...cvSel.options].some(o => o.value === ipa.clipVision)) {
                cvSel.value = ipa.clipVision;
            } else if (ipa.clipVision) {
                const opt = document.createElement('option');
                opt.value = ipa.clipVision; opt.textContent = ipa.clipVision;
                cvSel.appendChild(opt);
                cvSel.value = ipa.clipVision;
            }
        };
        if (cvSel.options.length <= 1) setTimeout(trySetCV, 800);
        else trySetCV();
    }

    const weightEl = document.getElementById('ipadapter-weight');
    if (weightEl && ipa.weight !== undefined) {
        weightEl.value = ipa.weight;
        const valEl = document.getElementById('ipadapter-weight-val');
        if (valEl) valEl.textContent = parseFloat(ipa.weight).toFixed(2);
    }
    const wtEl = document.getElementById('ipadapter-weight-type');
    if (wtEl && ipa.weightType) wtEl.value = ipa.weightType;

    const startEl = document.getElementById('ipadapter-start');
    if (startEl && ipa.start !== undefined) startEl.value = ipa.start;
    const endEl = document.getElementById('ipadapter-end');
    if (endEl && ipa.end !== undefined) endEl.value = ipa.end;

    // 업로드 캐시 복원 (서버에 이미 업로드된 이미지를 /view 엔드포인트로 불러와 미리보기 표시)
    if (ipa.uploadedName) {
        window._ipadapterUploadedName = ipa.uploadedName;
        const statusEl = document.getElementById('ipadapter-upload-status');
        if (statusEl) statusEl.textContent = '✅ 이전 업로드 재사용';
        const nameEl = document.getElementById('ipadapter-image-name');
        if (nameEl) nameEl.textContent = ipa.uploadedName;

        const img = document.getElementById('ipadapter-preview-img');
        if (img) {
            img.src = `/view?filename=${encodeURIComponent(ipa.uploadedName)}&type=input&subfolder=`;
        }
        const previewWrap = document.getElementById('ipadapter-preview-wrap');
        if (previewWrap) previewWrap.style.display = 'block';
        const clearBtn = document.getElementById('ipadapter-image-clear');
        if (clearBtn) clearBtn.style.display = 'inline-block';
    }
}

/**
 * 컨트롤넷 관련 UI를 프리셋 데이터(cn)에 맞게 설정.
 * IP-Adapter의 applyIPAdapterPresetUI와 동일한 패턴 (없으면 초기화).
 */
function applyControlNetPresetUI(cn) {
    const toggle = document.getElementById('toggle-controlnet');

    if (!cn || !cn.enabled) {
        if (toggle) {
            toggle.checked = false;
            toggleSubOptions('controlnet-opts', toggle);
        }
        window._controlnetUploadedName = null;
        const statusEl = document.getElementById('controlnet-upload-status');
        if (statusEl) statusEl.textContent = '';
        const nameEl = document.getElementById('controlnet-image-name');
        if (nameEl) nameEl.textContent = '선택된 파일 없음';
        const previewWrap = document.getElementById('controlnet-preview-wrap');
        if (previewWrap) previewWrap.style.display = 'none';
        const img = document.getElementById('controlnet-preview-img');
        if (img) img.src = '';
        return;
    }

    if (toggle) {
        toggle.checked = cn.enabled || false;
        toggleSubOptions('controlnet-opts', toggle);
    }

    const preEl = document.getElementById('controlnet-preprocessor');
    if (preEl && cn.preprocessor) preEl.value = cn.preprocessor;

    const modelSel = document.getElementById('controlnet-model');
    if (modelSel && cn.model) {
        const trySet = () => {
            if ([...modelSel.options].some(o => o.value === cn.model)) {
                modelSel.value = cn.model;
            } else {
                const opt = document.createElement('option');
                opt.value = cn.model; opt.textContent = cn.model;
                modelSel.appendChild(opt);
                modelSel.value = cn.model;
            }
        };
        if (modelSel.options.length <= 1) setTimeout(trySet, 800);
        else trySet();
    }

    const strengthEl = document.getElementById('controlnet-strength');
    if (strengthEl && cn.strength !== undefined) strengthEl.value = cn.strength;
    const startEl = document.getElementById('controlnet-start');
    if (startEl && cn.start !== undefined) startEl.value = cn.start;
    const endEl = document.getElementById('controlnet-end');
    if (endEl && cn.end !== undefined) endEl.value = cn.end;

    if (cn.uploadedName) {
        window._controlnetUploadedName = cn.uploadedName;
        const statusEl = document.getElementById('controlnet-upload-status');
        if (statusEl) statusEl.textContent = '✅ 이전 업로드 재사용';
        const nameEl = document.getElementById('controlnet-image-name');
        if (nameEl) nameEl.textContent = cn.uploadedName;
        const img = document.getElementById('controlnet-preview-img');
        if (img) img.src = `/view?filename=${encodeURIComponent(cn.uploadedName)}&type=input&subfolder=`;
        const previewWrap = document.getElementById('controlnet-preview-wrap');
        if (previewWrap) previewWrap.style.display = 'block';
        const clearBtn = document.getElementById('controlnet-image-clear');
        if (clearBtn) clearBtn.style.display = 'inline-block';
    }
}

/**
 * 인페인팅 관련 UI를 프리셋 데이터(ip)에 맞게 설정.
 * (마스크는 아직 없으므로 원본 이미지 업로드 상태만 복원)
 */
function applyInpaintPresetUI(ip) {
    const toggle = document.getElementById('toggle-inpaint');

    if (!ip || !ip.enabled) {
        /* 프리셋에 inpaint 설정이 없으면 state_manager가 복원한 값을 건드리지 않는다 */
        return;
    }

    if (toggle) {
        toggle.checked = ip.enabled || false;
        toggleSubOptions('inpaint-opts', toggle);
    }

    const denoiseEl = document.getElementById('inpaint-denoise');
    if (denoiseEl && ip.denoise !== undefined) denoiseEl.value = ip.denoise;
    const growEl = document.getElementById('inpaint-grow-mask');
    if (growEl && ip.growMask !== undefined) growEl.value = ip.growMask;

    if (ip.uploadedName) {
        window._inpaintUploadedName = ip.uploadedName;
        const statusEl = document.getElementById('inpaint-upload-status');
        if (statusEl) statusEl.textContent = '✅ 이전 업로드 재사용';
        const nameEl = document.getElementById('inpaint-image-name');
        if (nameEl) nameEl.textContent = ip.uploadedName;
        const img = document.getElementById('inpaint-preview-img');
        if (img) img.src = `/view?filename=${encodeURIComponent(ip.uploadedName)}&type=input&subfolder=`;
        const bgImg = document.getElementById('inpaint-canvas-bg');
        if (bgImg) bgImg.src = `/view?filename=${encodeURIComponent(ip.uploadedName)}&type=input&subfolder=`;
        const previewWrap = document.getElementById('inpaint-preview-wrap');
        if (previewWrap) previewWrap.style.display = 'block';
        const clearBtn = document.getElementById('inpaint-image-clear');
        if (clearBtn) clearBtn.style.display = 'inline-block';
    }

    // 마스크 캐시 복원 (이전에 업로드된 마스크가 있으면 재사용)
    if (ip.uploadedMaskName) {
        window._inpaintUploadedMaskName = ip.uploadedMaskName;
        const maskStatus = document.getElementById('inpaint-mask-status');
        if (maskStatus) maskStatus.textContent = `✅ 이전 마스크 재사용: ${ip.uploadedMaskName}`;
    }
}

/**
 * Img2Img 프리셋 상태 UI 복원
 */
function applyImg2ImgPresetUI(i2i) {
    const toggle = document.getElementById('toggle-img2img');

    if (!i2i || !i2i.enabled) {
        /* 프리셋에 img2img 설정이 없으면 state_manager가 복원한 값을 건드리지 않는다 */
        return;
    }

    if (toggle) {
        toggle.checked = true;
        toggleSubOptions('img2img-opts', toggle);
    }

    const denoiseEl = document.getElementById('img2img-denoise');
    const denoiseNum = document.getElementById('img2img-denoise-num');
    const denoiseVal = document.getElementById('img2img-denoise-val');
    if (denoiseEl && i2i.denoise !== undefined) {
        denoiseEl.value = i2i.denoise;
        if (denoiseNum) denoiseNum.value = parseFloat(i2i.denoise).toFixed(2);
        if (denoiseVal) denoiseVal.textContent = parseFloat(i2i.denoise).toFixed(2);
    }

    if (i2i.uploadedName) {
        window._img2imgUploadedName = i2i.uploadedName;
        const statusEl = document.getElementById('img2img-upload-status');
        if (statusEl) statusEl.textContent = '✅ 이전 업로드 재사용';
        const nameEl = document.getElementById('img2img-image-name');
        if (nameEl) nameEl.textContent = i2i.uploadedName;
        const img = document.getElementById('img2img-preview-img');
        if (img) img.src = `/view?filename=${encodeURIComponent(i2i.uploadedName)}&type=input&subfolder=`;
        const previewWrap = document.getElementById('img2img-preview-wrap');
        if (previewWrap) previewWrap.style.display = 'block';
        const clearBtn = document.getElementById('img2img-image-clear');
        if (clearBtn) clearBtn.style.display = 'inline-block';
    }
}

/** "프리셋 제거" 버튼: 커스텀 프리셋은 완전 삭제, 기본 제공 프리셋은 저장된 오버라이드만 초기화 */
function removePreset() {
    const sel = document.getElementById('gen-preset');
    const key = sel?.value;
    if (!key) {
        alert("제거할 프리셋을 먼저 선택하세요.");
        return;
    }

    const preset = window.MODEL_PRESETS[key];
    const label = preset?.label || key;
    const isCustom = key.startsWith('custom_');

    if (isCustom) {
        if (!confirm(`"${label}" 프리셋을 완전히 삭제할까요? 되돌릴 수 없습니다.`)) return;

        // 1) 메모리에서 제거
        delete window.MODEL_PRESETS[key];

        // 2) localStorage에서 제거 (커스텀 프리셋 본체 + 혹시 쌓여있던 오버라이드까지)
        const saved = JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY) || '{}');
        delete saved[key];
        localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(saved));
        localStorage.removeItem(`presetOverride_${key}`);

        // 3) 드롭다운에서 옵션 제거하고 "직접 선택"으로 복귀
        sel.querySelector(`option[value="${key}"]`)?.remove();
        sel.value = "";
    } else {
        if (!confirm(`"${label}"은(는) 기본 제공 프리셋이라 완전히 삭제할 수는 없고,\n저장된 오버라이드(변경 내용)만 초기화할 수 있어요. 초기화할까요?`)) return;

        localStorage.removeItem(`presetOverride_${key}`);
        applyPreset(); // 초기화된 기본값을 화면에 바로 반영
        alert(`"${label}"의 오버라이드가 초기화되었습니다.`);
        return;
    }

    if (window.appStateManager) window.appStateManager.debounceSave();
}

/**
 * "기본값으로 초기화" 버튼:
 * 선택된 프리셋의 localStorage 오버라이드를 제거하고
 * MODEL_PRESETS 원본값을 화면에 즉시 반영한다.
 * 커스텀 프리셋(custom_*)은 오버라이드 개념이 없으므로
 * 저장 당시 값 그대로가 곧 기본값이라 초기화 불필요 → 안내만 표시.
 */
function resetPresetToDefault() {
    const sel = document.getElementById('gen-preset');
    const key = sel?.value;
    if (!key) {
        alert("초기화할 프리셋을 먼저 선택하세요.");
        return;
    }

    if (key.startsWith('custom_')) {
        alert("커스텀 프리셋은 저장된 값이 곧 기본값입니다.\n초기화가 필요하다면 '프리셋 제거' 후 다시 추가하세요.");
        return;
    }

    const preset = window.MODEL_PRESETS[key];
    const label = preset?.label || key;

    if (!confirm(`"${label}"의 모든 변경 내용(오버라이드)을 제거하고\n코드에 정의된 기본값으로 되돌릴까요?`)) return;

    localStorage.removeItem(`presetOverride_${key}`);

    // 드롭다운 텍스트도 원본 label로 복원
    const opt = sel.querySelector(`option[value="${key}"]`);
    if (opt) opt.textContent = preset.label || key;

    applyPreset(); // 기본값을 화면에 즉시 반영
    alert(`"${label}" 기본값으로 초기화되었습니다.`);

    if (window.appStateManager) window.appStateManager.debounceSave();
}

async function applyPreset({ skipLoras = false } = {}) {
    const key = document.getElementById('gen-preset')?.value;
    if (!key || !window.MODEL_PRESETS[key]) return;
    /* state_manager.js의 지연된 로라 복원이 이 시점 이후에 실행되면 오래된 데이터로 간주하고
       스스로 건너뛸 수 있도록 타임스탬프를 남겨둔다 (프리셋 전환 vs 지연 복원 경쟁 상태 방지) */
    window._presetAppliedAt = Date.now();
    const p = getEffectivePreset(key);

    // 아키텍처
    const archSel = document.getElementById('gen-architecture');
    if (archSel) {
        archSel.value = p.architecture;
        toggleArchitectureUI();
    }

    // 모델 (sdxl/anima 분기에 맞는 칸)
    if (p.architecture === 'anima') {
        const useCkptCb = document.getElementById('anima-use-checkpoint');
        if (useCkptCb) useCkptCb.checked = !!p.animaUseCheckpoint;
        if (p.animaUseCheckpoint) {
            const animaCkptSel = document.getElementById('gen-anima-ckpt');
            if (animaCkptSel) animaCkptSel.value = p.animaCheckpoint;
        } else {
            const unetSel = document.getElementById('gen-unet');
            if (unetSel) unetSel.value = p.unet;
        }
        if (typeof toggleAnimaModelSourceUI === 'function') toggleAnimaModelSourceUI();
    } else {
        const ckptSel = document.getElementById('gen-checkpoint');
        if (ckptSel) ckptSel.value = p.checkpoint;
    }

    const vaeSel = document.getElementById('gen-vae');
    if (vaeSel && p.vae !== undefined) vaeSel.value = p.vae;
    const clipSel = document.getElementById('gen-clip');
    if (clipSel && p.clip !== undefined) clipSel.value = p.clip;
    if (typeof syncClipForArchitecture === 'function') syncClipForArchitecture();
    // 🆕 프리셋에 저장된 VAE 값(수동 추가한 값 포함)을 명시적으로 넘겨서, SDXL 잠금 로직이
    //    무조건 초기화하지 않고 이 값을 우선하도록 함
    if (typeof syncVaeForArchitecture === 'function') syncVaeForArchitecture(p.vae);

    // 샘플러/스케줄러/스텝/CFG
    const samplerSel = document.getElementById('adv-sampler');
    if (samplerSel) samplerSel.value = p.sampler;
    const schedulerSel = document.getElementById('adv-scheduler');
    if (schedulerSel) schedulerSel.value = p.scheduler;
    const stepsInput = document.getElementById('adv-steps');
    if (stepsInput) stepsInput.value = p.steps;
    const cfgInput = document.getElementById('adv-cfg');
    if (cfgInput) cfgInput.value = p.cfg;

    // 긍정/부정 프롬프트
    const posEl = document.getElementById('base-pos');
    if (posEl && p.pos !== undefined) posEl.value = p.pos;
    const negEl = document.getElementById('base-neg');
    if (negEl && p.neg !== undefined) negEl.value = p.neg;

    // 로라 — 기존 선택 목록 비우고 프리셋 로라로 교체
    // skipLoras=true이면 건너뜀 (초기 로드 시 applyState가 나중에 복원하므로 중복 방지)
    const loraContainer = document.getElementById('selected-loras');
    if (loraContainer && !skipLoras) {
        const hasLoras = p.loras.some(l => l && l.lora);
        // 🔥 로라 드롭다운 옵션(window.loraOptionsHTML)이 아직 서버에서 안 채워졌으면
        //    select에 옵션이 하나도 없는 채로 만들어져서 "공백 로라"가 생김.
        //    추가할 로라가 있을 때만 최대 3초까지 기다린다.
        if (hasLoras) await waitForLoraOptions();

        loraContainer.innerHTML = ''; // 로라가 없는 프리셋이어도 이전 목록은 항상 비운다
        p.loras.forEach(l => {
            if (!l || !l.lora) return; // 이름 없는(빈) 로라 항목은 화면에 만들지 않음
            addLoraRow();
            const rows = loraContainer.querySelectorAll('.lora-item');
            const last = rows[rows.length - 1];
            if (last) {
                const selectEl = last.querySelector('select');
                selectEl.value = l.lora;
                last.querySelector('input[type="number"]').value = l.strength;
                if (selectEl.value !== l.lora) {
                    // 옵션 목록엔 없음 = 그 로라 파일 자체가 지금 폴더에 없는 것(삭제/이동 등).
                    // 그냥 비워두면 savePresetOverride()가 다음에 화면을 재캡처할 때
                    // captureCurrentGenState()의 .filter(l => l.lora)에 걸려 이 로라가 프리셋에서
                    // 통째로 사라지는 문제가 있었음 — placeholder 옵션을 만들어 선택 상태를 그대로 유지시켜서
                    // 프리셋에는 이름이 계속 남아있게 하고, 나중에 파일을 다시 받아 목록이 새로고침되면
                    // 진짜 옵션으로 자연히 대체되게 한다.
                    const placeholder = document.createElement('option');
                    placeholder.value = l.lora;
                    placeholder.textContent = `❌ (파일 없음) ${l.lora}`;
                    placeholder.dataset.missingLora = 'true';
                    selectEl.appendChild(placeholder);
                    selectEl.value = l.lora;
                    last.style.opacity = '0.6';
                    last.title = '이 로라 파일이 현재 없습니다. 다시 받아서 로라 목록이 새로고침되면 자동으로 정상 표시됩니다.';
                    console.warn(`[프리셋] 로라 파일을 찾을 수 없어 표시용 placeholder로 유지합니다: "${l.lora}" (프리셋: ${key})`);
                }
            }
        });
    }

    if (window.appStateManager) window.appStateManager.debounceSave();
}

document.addEventListener("DOMContentLoaded", async () => {
    // 1. UI 초기화
    if (window.UIManager) {
        window.UIManager.init();
    }

    // 1.2 🆕 샘플러/스케줄러/VAE "수동 추가(＋)" 버튼 부착 (목록에 안 뜨는 모델 대응)
    setupManualModelEntryButtons();

    // 1.5. 커스텀 프리셋 드롭다운 옵션 반영 (저장된 상태 복원 전에 먼저 해둬야
    //      appStateManager.applyState()가 커스텀 프리셋 key를 선택할 때 옵션이 존재함)
    syncPresetDropdownOptions();
    ensurePresetPreviewButton();

    // 1.6. 기본 프리셋 자동 적용 (⭐ 기본 버튼으로 저장된 프리셋)
    // applyState가 이후에 로라를 포함한 전체 상태를 덮어쓰므로,
    // 여기서는 로라 복원을 건너뛰고 나머지 설정만 적용한다.
    const defaultPresetKey = localStorage.getItem(DEFAULT_PRESET_KEY);
    if (defaultPresetKey && window.MODEL_PRESETS[defaultPresetKey]) {
        const sel = document.getElementById('gen-preset');
        if (sel) sel.value = defaultPresetKey;
        applyPreset({ skipLoras: true });
    }
    // 2. 드롭다운
    try {
        if (typeof loadDropdowns === "function") {
            await loadDropdowns();
        }
    } catch (e) {
        console.warn("dropdown 로드 실패:", e);
    }
    // 🔥 VAE
    try {
        await loadVAEList();
        syncVaeForArchitecture();
        reapplyCustomModelOptions('gen-vae'); // loadVAEList가 innerHTML을 갈아치우므로 수동 추가 항목 다시 채워넣기
    } catch (e) {
        console.warn("VAE 무시됨");
    }
    // 🔥 CLIP
    try {
        await loadCLIPList();
        syncClipForArchitecture();
    } catch (e) {
        console.warn("CLIP 무시됨");
    }
    // 🔥 UNet (Anima 전용)
    try {
        await loadUnetList();
        await loadAnimaCheckpointList();
    } catch (e) {
        console.warn("UNet 무시됨");
    }
    // 🔥 IP-Adapter 모델 + CLIP Vision
    try {
        await loadIPAdapterLists();
    } catch (e) {
        console.warn("IP-Adapter 목록 무시됨");
    }
    // 🔥 ControlNet 모델 목록
    try {
        await loadControlNetList();
    } catch (e) {
        console.warn("ControlNet 목록 무시됨");
    }
    // 3. 상태 매니저
    if (window.appStateManager) {
        try {
            const savedState = await window.appStateManager.loadStateFromServer();
            window.appStateLoaded = false;
            if (savedState) {
                // applyState가 로라를 추가하기 전에 컨테이너를 비워
                // 프리셋 자동 적용이나 이전 렌더링과의 중복을 방지한다.
                const loraContainer = document.getElementById('selected-loras');
                if (loraContainer) loraContainer.innerHTML = '';
                window.appStateManager.applyState(savedState);
            } else {
                if (window.UIManager) {
                    window.UIManager.openTab('tab-generate');
                }
            }
            setTimeout(() => {
                window.appStateLoaded = true;
            }, 100);
        } catch (e) {
            console.warn("상태 로드 실패:", e);
        }
    }

    // 3.5. 마지막 세션 상태(appStateManager)가 로라를 포함한 값들을 덮어썼을 수 있고,
    //      심지어 프리셋 드롭다운 자체를 "마지막에 쓰던 프리셋"으로 되돌려놨을 수도 있으므로,
    //      기본 프리셋이 설정되어 있다면 드롭다운을 강제로 그 기본 프리셋으로 되돌린 뒤
    //      전체(로라 포함)를 다시 한번 재적용한다. (모델마다 세팅값이 다르므로 프리셋이 항상 이겨야 함)
    {
        const sel = document.getElementById('gen-preset');
        if (sel) {
            if (defaultPresetKey && window.MODEL_PRESETS[defaultPresetKey]) {
                sel.value = defaultPresetKey; // 복원 과정에서 다른 프리셋으로 바뀌었을 수 있으니 강제로 되돌림
            }
            if (sel.value && window.MODEL_PRESETS[sel.value]) {
                applyPreset(); // skipLoras 기본값 false → 로라까지 포함해 프리셋 값으로 완전히 재적용
            }
        }
    }

    // 3.6. appStateManager가 일반 상태를 복원하면서 IP-Adapter 토글/값을 덮어쓸 수 있으므로,
    //      현재 선택된 프리셋의 IP-Adapter 설정을 마지막에 다시 한번 강제 적용해 우선권을 준다.
    {
        const sel = document.getElementById('gen-preset');
        const currentKey = sel?.value;
        if (currentKey && window.MODEL_PRESETS[currentKey]) {
            const effective = getEffectivePreset(currentKey);
            applyIPAdapterPresetUI(effective?.ipadapter);
            applyControlNetPresetUI(effective?.controlnet);
            applyInpaintPresetUI(effective?.inpaint);
            applyImg2ImgPresetUI(effective?.img2img);
        }
    }

    // 4. 갤러리
    try {
        if (typeof fetchGallery === 'function') {
            fetchGallery('checkpoints');
        }
    } catch (e) {
        console.warn("갤러리 로드 실패:", e);
    }

    // 5. 자동 저장
    document.addEventListener('input', () => {
        if (window.appStateManager && window.appStateLoaded) {
            window.appStateManager.debounceSave();
        }
    });

    document.addEventListener('change', () => {
        if (window.appStateManager && window.appStateLoaded) {
            window.appStateManager.debounceSave();
        }
    });

    // 🔥 프리셋 오버라이드 저장 리스너 (실제 사용자 조작일 때만 저장 — 상태 복원 중 발생하는
    //    프로그램 이벤트는 isTrusted=false라서 걸러짐)
    ['gen-architecture', 'gen-checkpoint', 'gen-unet', 'gen-vae', 'gen-clip', 'gen-anima-ckpt', 'anima-use-checkpoint', 'adv-sampler', 'adv-scheduler', 'adv-steps', 'adv-cfg', 'base-pos', 'base-neg',
     'ipadapter-model', 'ipadapter-clip-vision', 'ipadapter-weight', 'ipadapter-weight-type', 'ipadapter-start', 'ipadapter-end',
     'controlnet-preprocessor', 'controlnet-model', 'controlnet-strength', 'controlnet-start', 'controlnet-end',
     'inpaint-denoise', 'inpaint-grow-mask'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', (e) => { if (e.isTrusted) savePresetOverride(); });
    });
    document.getElementById('toggle-ipadapter')?.addEventListener('change', (e) => { if (e.isTrusted) savePresetOverride(); });
    document.getElementById('toggle-controlnet')?.addEventListener('change', (e) => { if (e.isTrusted) savePresetOverride(); });
    document.getElementById('toggle-inpaint')?.addEventListener('change', (e) => { if (e.isTrusted) savePresetOverride(); });
    // 🔥 로라 변경은 자동저장하되, 실제 사용자 조작(isTrusted)일 때만 저장한다.
    //    상태 복원(appStateManager) 중 프로그램이 대신 값을 넣어주는 경우는 isTrusted=false라서
    //    걸러지므로, 복원 타이밍이 늦어져도 엉뚱한(현재 선택된) 프리셋에 로라가 잘못 저장되는 일이 없다.
    document.getElementById('selected-loras')?.addEventListener('change', (e) => { if (e.isTrusted) savePresetOverride(); });
    document.getElementById('selected-loras')?.addEventListener('input', (e) => { if (e.isTrusted) savePresetOverride(); });
});

async function loadVAEList() {
    const vaeSel = document.getElementById("gen-vae");
    if (!vaeSel) return;
    try {
        const res = await fetch("/object_info/VAELoader");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const vaeList = data?.VAELoader?.input?.required?.vae_name?.[0] || [];
        vaeSel.innerHTML = `<option value="">기본 vae</option>`;
        vaeList.forEach(v => {
            vaeSel.innerHTML += `<option value="${v}">${v}</option>`;
        });
        reapplyCustomModelOptions('gen-vae');
    } catch (e) {
        console.warn("VAE 로드 실패:", e);
        // 실패했을 때 "모델 로딩 중..." 상태로 계속 멈춰있지 않도록, 실패했다고 명확히 표시하고
        // 다시 시도할 수 있는 옵션을 하나 넣어준다.
        vaeSel.innerHTML = `<option value="">⚠️ VAE 목록 로드 실패 (클릭해서 재시도)</option>`;
        reapplyCustomModelOptions('gen-vae');
        vaeSel.onclick = () => { vaeSel.onclick = null; loadVAEList(); };
    }
}

async function loadUnetList() {
    const unetSel = document.getElementById("gen-unet");
    if (!unetSel) return;
    try {
        const res = await fetch("/object_info/UNETLoader");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const unetList = data?.UNETLoader?.input?.required?.unet_name?.[0] || [];
        unetSel.innerHTML = `<option value="">선택 안 함</option>`;
        unetList.forEach(u => {
            unetSel.innerHTML += `<option value="${u}">${u}</option>`;
        });
    } catch (e) {
        console.warn("UNet 로드 실패:", e);
        unetSel.innerHTML = `<option value="">⚠️ UNet 목록 로드 실패 (클릭해서 재시도)</option>`;
        unetSel.onclick = () => { unetSel.onclick = null; loadUnetList(); };
    }
}

/** 아니마용 "체크포인트에서 불러오기" 드롭다운(#gen-anima-ckpt) — models/checkpoints 폴더 파일 목록 (SDXL용 목록과 동일 출처) */
async function loadAnimaCheckpointList() {
    const sel = document.getElementById("gen-anima-ckpt");
    if (!sel) return;
    try {
        const res = await fetch("/object_info/CheckpointLoaderSimple");
        if (!res.ok) return;
        const data = await res.json();
        const ckptList = data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
        sel.innerHTML = `<option value="">선택 안 함</option>`;
        ckptList.forEach(c => {
            sel.innerHTML += `<option value="${c}">${c}</option>`;
        });
    } catch (e) {
        console.warn("아니마용 체크포인트 목록 로드 실패");
    }
}

async function loadIPAdapterLists() {
    // IP-Adapter 모델 목록
    const modelSel = document.getElementById('ipadapter-model');
    if (modelSel) {
        try {
            const res = await fetch('/object_info/IPAdapterModelLoader');
            if (res.ok) {
                const data = await res.json();
                const list = data?.IPAdapterModelLoader?.input?.required?.ipadapter_file?.[0] || [];
                const prev = modelSel.value;
                modelSel.innerHTML = list.map(m => `<option value="${m}">${m}</option>`).join('');
                if (prev && [...modelSel.options].some(o => o.value === prev)) modelSel.value = prev;
            }
        } catch (e) { console.warn("IP-Adapter 모델 로드 실패"); }
    }

    // CLIP Vision 목록
    const cvSel = document.getElementById('ipadapter-clip-vision');
    if (cvSel) {
        try {
            const res = await fetch('/object_info/CLIPVisionLoader');
            if (res.ok) {
                const data = await res.json();
                const list = data?.CLIPVisionLoader?.input?.required?.clip_name?.[0] || [];
                const prev = cvSel.value;
                cvSel.innerHTML = list.map(m => `<option value="${m}">${m}</option>`).join('');
                if (prev && [...cvSel.options].some(o => o.value === prev)) cvSel.value = prev;
            }
        } catch (e) { console.warn("CLIP Vision 로드 실패"); }
    }
}

async function loadControlNetList() {
    const modelSel = document.getElementById('controlnet-model');
    if (!modelSel) return;
    try {
        const res = await fetch('/object_info/ControlNetLoader');
        if (res.ok) {
            const data = await res.json();
            const list = data?.ControlNetLoader?.input?.required?.control_net_name?.[0] || [];
            const prev = modelSel.value;
            modelSel.innerHTML = list.map(m => `<option value="${m}">${m}</option>`).join('');
            if (prev && [...modelSel.options].some(o => o.value === prev)) modelSel.value = prev;
        }
    } catch (e) { console.warn("ControlNet 모델 로드 실패"); }
}

/**
 * 아키텍처(sdxl/anima)에 맞춰 VAE 드롭다운을 자동으로 맞춰준다.
 * - sdxl: "기본 vae"로 고정하고 드롭다운 잠금 (SDXL은 체크포인트에 내장된 VAE를 그대로 쓰기 때문)
 * - anima: 목록에서 이름에 "qwen"이 들어간 항목을 자동으로 선택 (없으면 "anima"가 들어간 항목으로 시도, 편집은 계속 가능)
 */
/**
 * 아키텍처(sdxl/anima)에 맞춰 VAE 드롭다운을 자동으로 맞춰준다.
 * - sdxl: 기본은 "기본 vae"로 고정하고 드롭다운을 잠근다 (SDXL은 보통 체크포인트에 내장된 VAE를 그대로 쓰기 때문).
 *   단, preferredVae가 넘어오면(=프리셋에 명시적으로 저장된 VAE, 수동 추가한 VAE 포함) 그 값을 쓰고 잠그지 않는다.
 *   🆕 예전에는 preferredVae 여부와 상관없이 무조건 ''로 초기화+잠금이라, SDXL 프리셋에서 수동으로 넣은
 *   VAE를 골라도 다른 프리셋 갔다가 돌아오면 매번 사라졌음 — 이제 수동/저장된 값이 있으면 유지된다.
 * - anima: 목록에서 이름에 "qwen"이 들어간 항목을 자동으로 선택 (없으면 "anima"가 들어간 항목으로 시도, 편집은 계속 가능)
 */
function syncVaeForArchitecture(preferredVae) {
    const arch = document.getElementById('gen-architecture')?.value;
    const vaeSel = document.getElementById('gen-vae');
    if (!vaeSel) return;

    // 인자를 안 넘겼으면, 지금 화면에 이미 선택돼있는 값을 그대로 존중한다 (호출부를 다 안 고쳐도 안전하게)
    if (preferredVae === undefined) preferredVae = vaeSel.value || '';

    if (arch === 'sdxl') {
        if (preferredVae) {
            vaeSel.value = preferredVae;
            vaeSel.disabled = false;
        } else {
            vaeSel.value = '';
            vaeSel.disabled = true;
        }
    } else if (arch === 'anima') {
        vaeSel.disabled = false;
        if (preferredVae) {
            vaeSel.value = preferredVae;
        } else {
            const match = Array.from(vaeSel.options).find(o => /qwen/i.test(o.value) || /qwen/i.test(o.textContent))
                || Array.from(vaeSel.options).find(o => /anima/i.test(o.value) || /anima/i.test(o.textContent));
            if (match) vaeSel.value = match.value;
        }
    } else {
        vaeSel.disabled = false;
    }
}
window.syncVaeForArchitecture = syncVaeForArchitecture;

/**
 * 아키텍처(sdxl/anima)에 맞춰 CLIP 드롭다운을 자동으로 맞춰준다.
 * - sdxl: "기본 CLIP"으로 고정하고 드롭다운 잠금 (SDXL은 체크포인트에 내장된 CLIP을 그대로 쓰기 때문)
 * - anima: 목록에서 이름에 "qwen"이 들어간 항목을 자동으로 선택 (편집은 계속 가능)
 */
function syncClipForArchitecture() {
    const arch = document.getElementById('gen-architecture')?.value;
    const clipSel = document.getElementById('gen-clip');
    if (!clipSel) return;

    if (arch === 'sdxl') {
        clipSel.value = '';
        clipSel.disabled = true;
    } else if (arch === 'anima') {
        clipSel.disabled = false;
        const qwenOpt = Array.from(clipSel.options).find(o => /qwen/i.test(o.value) || /qwen/i.test(o.textContent));
        if (qwenOpt) clipSel.value = qwenOpt.value;
    } else {
        clipSel.disabled = false;
    }
}
window.syncClipForArchitecture = syncClipForArchitecture;

async function loadCLIPList() {
    const clipSel = document.getElementById("gen-clip");
    if (!clipSel) return;
    try {
        const res = await fetch("/object_info/CLIPLoader");
        if (!res.ok) return;
        const data = await res.json();
        const clipList = data?.CLIPLoader?.input?.required?.clip_name?.[0] || [];
        clipSel.innerHTML = `<option value="">기본 CLIP</option>`;
        clipList.forEach(c => {
            clipSel.innerHTML += `<option value="${c}">${c}</option>`;
        });
    } catch (e) {
        console.warn("CLIP 로드 실패");
    }
}