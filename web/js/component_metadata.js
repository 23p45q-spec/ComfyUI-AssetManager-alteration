/**
 * component_metadata.js — 이미지 메타데이터 파싱 및 UI 폼 반영 모듈
 * PNG tEXt 청크에서 ComfyUI 메타데이터(prompt, workflow)를 추출하고,
 * 파싱된 데이터를 생성 탭의 UI 폼(체크포인트, 로라, 프롬프트 등)에 자동 적용합니다.
 * 드래그앤드롭 기반 단독 메타데이터 뷰어 기능도 제공합니다.
 */

/**
 * 로라 UI 행을 동적으로 추가하는 헬퍼 함수.
 * select 옵션은 api.js에서 미리 캐싱한 window.loraOptionsHTML을 사용한다.
 */
function appendLoraToUI(container, loraName, strength) {
    const row = document.createElement('div');
    row.className = 'lora-item';
    row.innerHTML = `<select style="flex: 1; margin-right: 10px;">${window.loraOptionsHTML || ''}</select>
    <label style="margin-bottom: 0; font-weight: normal;">가중치:</label><input type="number" step="0.1" value="${strength}" style="width: 70px; margin-left: 5px;"><button class="btn-secondary" style="margin-left: 10px;" onclick="this.parentElement.remove(); if(window.appStateManager) window.appStateManager.debounceSave();">X</button>`;

    const selectEl = row.querySelector('select');
    if (selectEl) selectEl.value = loraName;
    container.appendChild(row);
}

/**
 * 파싱된 이미지 메타데이터를 생성 탭의 UI 폼에 적용.
 * 체크포인트, 프롬프트(JPS/CLIP), 로라(표준/rgthree) 순서로 매핑한다.
 */
function applyMetadataToForm(metadata) {
    if (!metadata) {
        alert("메타데이터를 구조화할 수 없습니다.");
        return;
    }

    try {
        const p = metadata.prompt;
        if (!p) {
            alert("프롬프트 노드 데이터를 찾을 수 없습니다.");
            return;
        }

        /* 체크포인트 매핑 */
        const ckptNode = Object.values(p).find(node => node.class_type === 'CheckpointLoaderSimple');
        if (ckptNode && ckptNode.inputs.ckpt_name) {
            const cpSelect = document.getElementById('gen-checkpoint');
            cpSelect.value = ckptNode.inputs.ckpt_name;
        }

        /* 프롬프트 매핑: JPS 커스텀 노드 우선, 없으면 CLIP 노드 탐색 */
        const textComboNode = Object.values(p).find(node => node.class_type === 'Text Prompt Combo (JPS)');
        if (textComboNode && textComboNode.inputs) {
            if (textComboNode.inputs.pos) document.getElementById('base-pos').value = textComboNode.inputs.pos;
            if (textComboNode.inputs.neg) document.getElementById('base-neg').value = textComboNode.inputs.neg;
        } else {
            const textNodes = Object.entries(p).filter(([id, node]) => node.class_type === 'CLIPTextEncode');
            if (textNodes.length >= 2) {
                const ksampler = Object.values(p).find(n => n.class_type === 'KSampler' || n.class_type === 'KSamplerAdvanced');
                if (ksampler) {
                    const posNodeId = ksampler.inputs.positive?.[0];
                    const negNodeId = ksampler.inputs.negative?.[0];
                    if (posNodeId && p[posNodeId]) document.getElementById('base-pos').value = p[posNodeId].inputs.text;
                    if (negNodeId && p[negNodeId]) document.getElementById('base-neg').value = p[negNodeId].inputs.text;
                }
            }
        }

        /* 로라 매핑: 표준 LoraLoader + Power Lora Loader (rgthree) */
        const loraContainer = document.getElementById('selected-loras');
        if (loraContainer) {
            loraContainer.innerHTML = '';
            let loraFound = false;

            const basicLoraNodes = Object.values(p).filter(node => node.class_type === 'LoraLoader');
            basicLoraNodes.forEach(loraNode => {
                loraFound = true;
                appendLoraToUI(loraContainer, loraNode.inputs.lora_name, loraNode.inputs.strength_model);
            });

            const rgthreeLoraNode = Object.values(p).find(node => node.class_type === 'Power Lora Loader (rgthree)');
            if (rgthreeLoraNode && rgthreeLoraNode.inputs) {
                for (let num = 1; num <= 20; num++) {
                    const loraObj = rgthreeLoraNode.inputs[`lora_${num}`];
                    if (loraObj && loraObj.on && loraObj.lora && loraObj.lora !== 'None') {
                        loraFound = true;
                        appendLoraToUI(loraContainer, loraObj.lora, loraObj.strength);
                    }
                }
            }
        }

        alert("성공적으로 메타데이터를 UI 설정에 불러왔습니다.");
        if (window.appStateManager) window.appStateManager.debounceSave();

    } catch (e) {
        console.error("메타데이터 적용 실패:", e);
        alert("데이터 파싱 중 오류가 발생했습니다.");
    }
}

/* ──────────────────────────────────────────────
   PNG tEXt 청크 파싱 (단독 메타데이터 뷰어용)
   ────────────────────────────────────────────── */

/**
 * 로컬 PNG 파일의 ArrayBuffer를 직접 파싱하여
 * tEXt 청크 내의 ComfyUI prompt/workflow JSON 문자열을 추출한다.
 * @returns {{ prompt: Object, workflow: Object|null } | null}
 */
async function parseComfyUIMetadataFromPNG(file) {
    const arrayBuffer = await file.arrayBuffer();
    const view = new DataView(arrayBuffer);

    if (view.getUint32(0) !== 0x89504E47) return null;

    let offset = 8;
    let metadata = {};

    while (offset < view.byteLength) {
        let length;
        try {
            length = view.getUint32(offset);
        } catch (e) { break; }

        let type = '';
        for (let i = 0; i < 4; i++) {
            type += String.fromCharCode(view.getUint8(offset + 4 + i));
        }

        if (type === 'tEXt') {
            const dataOffset = offset + 8;
            let keyword = '';
            let textOffset = dataOffset;

            while (textOffset < dataOffset + length && view.getUint8(textOffset) !== 0) {
                keyword += String.fromCharCode(view.getUint8(textOffset));
                textOffset++;
            }
            textOffset++;

            const textBytes = new Uint8Array(arrayBuffer, textOffset, length - (textOffset - dataOffset));
            const text = new TextDecoder('utf-8').decode(textBytes);
            metadata[keyword] = text;
        } else if (type === 'IEND') {
            break;
        }
        offset += 12 + length;
    }

    if (metadata.prompt) {
        try {
            return {
                prompt: JSON.parse(metadata.prompt),
                workflow: metadata.workflow ? JSON.parse(metadata.workflow) : null,
                // 🆕 generate.js가 ComfyUI의 extra_data.extra_pnginfo로 같이 박아넣은, 이 이미지를
                // 만든 프롬프트 라이브러리 조각 정보(어떤 조각/그룹이었는지). 없을 수도 있음
                // (이 기능 추가 전에 생성됐거나, 조각 없이 공통 프롬프트만으로 생성한 경우).
                fragmentInfo: metadata.fragment_info ? JSON.parse(metadata.fragment_info) : null
            };
        } catch (e) {
            console.error("JSON 파싱 에러:", e);
        }
    }
    return null;
}

/* ──────────────────────────────────────────────
   메타데이터 결과 렌더링 (뷰어용 HTML 생성)
   ────────────────────────────────────────────── */

/** 추출된 메타데이터를 지정 컨테이너에 읽기 전용 HTML로 렌더링 */
function renderMetadataToDOM(metadata, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!metadata || !metadata.prompt) {
        container.innerHTML = `<p style="color: #ff5555;">ComfyUI 메타데이터(Prompt/Workflow)를 찾을 수 없습니다.</p>`;
        return;
    }

    let html = '';
    const p = metadata.prompt;

    // 🆕 이 이미지를 만든 프롬프트 라이브러리 조각 정보(있으면) — generate.js가 생성 시점에
    // ComfyUI extra_pnginfo로 직접 박아넣은 것이라, 파일을 옮겨도 그대로 남아있음.
    if (metadata.fragmentInfo && Array.isArray(metadata.fragmentInfo) && metadata.fragmentInfo.length > 0) {
        const names = metadata.fragmentInfo.map(f => `${f.itemName || '(이름없음)'} <span style="color:#888;">(${f.catName || ''})</span>`).join(', ');
        html += `<p><strong>🧩 생성 조각:</strong> ${names}</p>`;
    }

    const ckptNode = Object.values(p).find(n => n.class_type === 'CheckpointLoaderSimple');
    if (ckptNode) html += `<p><strong>체크포인트:</strong> ${ckptNode.inputs.ckpt_name}</p>`;

    html += `<p><strong>사용된 로라:</strong></p><ul>`;
    let loraFound = false;

    const basicLoraNodes = Object.values(p).filter(n => n.class_type === 'LoraLoader');
    basicLoraNodes.forEach(n => {
        html += `<li>${n.inputs.lora_name} (가중치: ${n.inputs.strength_model})</li>`;
        loraFound = true;
    });

    const rgthreeLoraNode = Object.values(p).find(n => n.class_type === 'Power Lora Loader (rgthree)');
    if (rgthreeLoraNode && rgthreeLoraNode.inputs) {
        for (let num = 1; num <= 20; num++) {
            const loraObj = rgthreeLoraNode.inputs[`lora_${num}`];
            if (loraObj && loraObj.on && loraObj.lora && loraObj.lora !== 'None') {
                html += `<li>${loraObj.lora} (가중치: ${loraObj.strength})</li>`;
                loraFound = true;
            }
        }
    }
    html += loraFound ? `</ul>` : `<li>사용된 로라 없음</li></ul>`;

    const textComboNode = Object.values(p).find(n => n.class_type === 'Text Prompt Combo (JPS)');
    if (textComboNode && textComboNode.inputs) {
        if (textComboNode.inputs.pos) html += `<p><strong>긍정 프롬프트:</strong><br><textarea readonly style="width:100%; rows=3; background:#222; color:#fff; border:1px solid #444; padding:5px;">${textComboNode.inputs.pos}</textarea></p>`;
        if (textComboNode.inputs.neg) html += `<p><strong>부정 프롬프트:</strong><br><textarea readonly style="width:100%; rows=3; background:#222; color:#fff; border:1px solid #444; padding:5px;">${textComboNode.inputs.neg}</textarea></p>`;
    } else {
        const textNodes = Object.entries(p).filter(([id, n]) => n.class_type === 'CLIPTextEncode');
        if (textNodes.length >= 2) {
            const ksampler = Object.values(p).find(n => n.class_type === 'KSampler' || n.class_type === 'KSamplerAdvanced');
            if (ksampler) {
                const posId = ksampler.inputs.positive?.[0];
                const negId = ksampler.inputs.negative?.[0];
                if (posId && p[posId]) html += `<p><strong>긍정 프롬프트:</strong><br><textarea readonly style="width:100%; rows=3; background:#222; color:#fff; border:1px solid #444; padding:5px;">${p[posId].inputs.text}</textarea></p>`;
                if (negId && p[negId]) html += `<p><strong>부정 프롬프트:</strong><br><textarea readonly style="width:100%; rows=3; background:#222; color:#fff; border:1px solid #444; padding:5px;">${p[negId].inputs.text}</textarea></p>`;
            }
        }
    }

    const detailers = Object.values(p).filter(n => n.class_type === 'FaceDetailer');
    if (detailers.length > 0) {
        html += `<p><strong>디테일러 적용 횟수:</strong> ${detailers.length}회</p>`;
    }

    container.innerHTML = html !== '' ? html : `<p>표시할 주요 노드(체크포인트, 프롬프트 등)를 찾지 못했습니다.</p>`;
}

/* ──────────────────────────────────────────────
   드래그앤드롭 메타데이터 뷰어 초기화
   ────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
    const dropzone = document.getElementById('metadata-dropzone');
    const fileInput = document.getElementById('metadata-file-input');
    const resultBox = document.getElementById('standalone-metadata-result');
    const sendBtn = document.getElementById('btn-standalone-send-gen');
    let currentStandaloneMetadata = null;

    if (!dropzone) return;

    dropzone.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async (e) => {
        if (e.target.files.length > 0) {
            await processDroppedFile(e.target.files[0]);
        }
    });

    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.style.backgroundColor = '#2a3b2a';
    });

    dropzone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dropzone.style.backgroundColor = 'transparent';
    });

    dropzone.addEventListener('drop', async (e) => {
        e.preventDefault();
        dropzone.style.backgroundColor = 'transparent';
        if (e.dataTransfer.files.length > 0) {
            await processDroppedFile(e.dataTransfer.files[0]);
        }
    });

    /** 드롭된 파일을 파싱하여 결과를 표시 */
    async function processDroppedFile(file) {
        if (file.type !== 'image/png' && file.type !== 'image/webp') {
            alert("PNG 또는 WebP 이미지만 지원합니다.");
            return;
        }

        dropzone.innerHTML = `<div style="font-size: 2em;">⏳ 분석 중...</div>`;
        const metadata = await parseComfyUIMetadataFromPNG(file);

        dropzone.style.minHeight = '100px';
        dropzone.innerHTML = `<div style="font-size: 1.5em; margin-bottom: 5px;">📥</div><div style="font-size: 0.9em;">다른 이미지 드롭 (${file.name})</div>`;

        resultBox.style.display = 'flex';
        renderMetadataToDOM(metadata, 'standalone-metadata-body');

        if (metadata && metadata.prompt) {
            currentStandaloneMetadata = metadata;
            sendBtn.style.display = 'block';
        } else {
            currentStandaloneMetadata = null;
            sendBtn.style.display = 'none';
        }
    }

    /** "이 설정으로 생성" 버튼: 뷰어의 메타데이터를 생성 탭에 적용 */
    sendBtn.addEventListener('click', () => {
        if (currentStandaloneMetadata) {
            applyMetadataToForm(currentStandaloneMetadata);
            openTab('tab-generate');
            window.scrollTo(0, 0);
        }
    });
});
