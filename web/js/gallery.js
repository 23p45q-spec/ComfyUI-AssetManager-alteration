/**
 * gallery.js — 갤러리(출력 이미지 브라우저) 프론트엔드 모듈
 * output 폴더의 이미지를 폴더별 트리 구조로 표시하고,
 * 이미지 다중 선택(Shift/Ctrl), 삭제, 컨텍스트 메뉴,
 * 메타데이터 기반 "이 설정으로 생성" 기능을 제공합니다.
 */

let fullGalleryData = [];
let currentFolderData = null;
let selectedImagePaths = new Set();
let lastSelectedIndex = -1;
let isDragging = false;
let startX, startY;
const selectionBox = document.getElementById('gallery-selection-box');
const galleryGrid = document.getElementById('gallery-grid');

/* ──────────────────────────────────────────────
   서버 데이터 페치
   ────────────────────────────────────────────── */

/** 갤러리 데이터를 서버에서 불러와 폴더 목록과 이미지 그리드를 렌더링 */
async function fetchGalleryData() {
    try {
        const data = await API.get('/assetmanager/api/gallery');
        if (data.status === 'success') {
            fullGalleryData = data.gallery;

            if (currentFolderData) {
                const refreshedFolder = fullGalleryData.find(g => g.folder === currentFolderData.folder);
                currentFolderData = refreshedFolder || null;
            }

            renderGalleryFolders(document.getElementById('gallery-search-input').value);
            renderGalleryGrid(currentFolderData);
        }
    } catch (e) {
        console.error("갤러리 로딩 실패", e);
    }
}

/* ──────────────────────────────────────────────
   폴더 트리 구조 생성 및 렌더링
   ────────────────────────────────────────────── */

let openedGalleryFolders = new Set();

/**
 * 1차원 폴더 그룹 배열을 중첩 트리 구조 객체로 변환.
 * 각 노드에 하위 이미지 개수(_count)를 누적 합산한다.
 */
function buildFolderTree(data, filterText) {
    const root = { _children: {}, _count: 0 };

    data.forEach((group, index) => {
        if (filterText && !group.folder.toLowerCase().includes(filterText.toLowerCase())) return;

        const parts = group.folder.split(/[\/\\]/);
        let current = root;
        let cumulativePath = [];

        parts.forEach((part, i) => {
            cumulativePath.push(part);
            const pathKey = cumulativePath.join('/');

            if (!current._children[part]) {
                current._children[part] = {
                    name: part,
                    fullPath: pathKey,
                    _children: {},
                    _count: 0,
                    _index: null
                };
            }
            current = current._children[part];
            current._count += group.images.length;

            if (i === parts.length - 1) {
                current._index = index;
            }
        });
    });

    return root;
}

/** 트리 노드 딕셔너리를 재귀적으로 HTML 문자열로 변환 */
function renderTreeNodes(nodeDict) {
    let html = '';
    const keys = Object.keys(nodeDict).sort();

    keys.forEach(key => {
        const node = nodeDict[key];
        const hasChildren = Object.keys(node._children).length > 0;
        const isSearching = document.getElementById('gallery-search-input')?.value.trim() !== '';
        const isOpen = openedGalleryFolders.has(node.fullPath) || isSearching;

        const isActive = currentFolderData && currentFolderData.folder === node.fullPath;
        const activeClass = isActive ? 'active' : '';

        const safePath = node.fullPath.replace(/'/g, "\\'");

        const toggleIcon = hasChildren
            ? `<div class="tree-toggle ${isOpen ? 'open' : ''}" onclick="toggleGalleryFolder(event, '${safePath}')">▶</div>`
            : `<div class="tree-toggle" style="visibility:hidden;">▶</div>`;

        const folderIcon = hasChildren && isOpen ? '📂' : '📁';
        const clickEvent = `onclick="selectGalleryFolder('${safePath}'); toggleGalleryFolder(null, '${safePath}')"`;
        const countHtml = `<span class="gallery-folder-count">${node._count}</span>`;

        html += `
            <div class="tree-node ${activeClass}" ${clickEvent}>
                ${toggleIcon}
                <span class="tree-label" title="${node.name}">${folderIcon} ${node.name}</span>
                ${countHtml}
            </div>
        `;

        if (hasChildren) {
            html += `<div class="tree-children ${isOpen ? 'open' : ''}">
                ${renderTreeNodes(node._children)}
            </div>`;
        }
    });

    return html;
}

/** 폴더 트리의 열림/닫힘 상태를 토글 */
function toggleGalleryFolder(e, path) {
    if (e) e.stopPropagation();
    if (openedGalleryFolders.has(path)) {
        openedGalleryFolders.delete(path);
    } else {
        openedGalleryFolders.add(path);
    }
    renderGalleryFolders(document.getElementById('gallery-search-input').value);
}

/** 좌측 폴더 목록 패널을 렌더링. 최상단에 '전체 이미지' 항목을 추가. */
function renderGalleryFolders(filterText = '') {
    const list = document.getElementById('gallery-folder-list');

    let totalImages = fullGalleryData.reduce((sum, g) => sum + g.images.length, 0);

    let html = `
        <div class="gallery-folder-item ${currentFolderData === null ? 'active' : ''}" onclick="selectGalleryFolder(null)" style="margin-bottom: 10px;">
            <span>🌌 전체 이미지</span>
            <span class="gallery-folder-count">${totalImages}</span>
        </div>
        <div class="folder-tree">
    `;

    const treeData = buildFolderTree(fullGalleryData, filterText);
    html += renderTreeNodes(treeData._children);

    html += `</div>`;
    list.innerHTML = html;
}

/** 검색 입력 필터 핸들러 */
function filterGalleryFolders(val) {
    renderGalleryFolders(val);
}

/** 특정 폴더를 선택하고 해당 폴더의 이미지를 표시 */
function selectGalleryFolder(path) {
    selectedImagePaths.clear();
    lastSelectedIndex = -1;
    updateGallerySelectionInfo();

    if (path === null) {
        currentFolderData = null;
    } else {
        currentFolderData = {
            folder: path,
            isAggregated: true
        };
    }

    document.getElementById('current-gallery-title').innerText = currentFolderData ? `📂 ${currentFolderData.folder}` : "🌌 전체 이미지";

    renderGalleryFolders(document.getElementById('gallery-search-input').value);
    renderGalleryGrid(currentFolderData);
}

/**
 * 현재 선택된 폴더(하위 포함) 또는 전체의 이미지 목록을 1차원 배열로 반환.
 * 생성 시간 역순으로 정렬된다.
 */
function getCurrentImageList() {
    let all = [];
    if (currentFolderData && currentFolderData.isAggregated) {
        const targetPath = currentFolderData.folder;
        fullGalleryData.forEach(g => {
            if (g.folder === targetPath || g.folder.startsWith(targetPath + '/') || g.folder.startsWith(targetPath + '\\')) {
                all = all.concat(g.images);
            }
        });
    } else {
        fullGalleryData.forEach(g => all = all.concat(g.images));
    }

    all.sort((a, b) => b.timestamp - a.timestamp);
    return all;
}

/* ──────────────────────────────────────────────
   이미지 그리드 렌더링
   ────────────────────────────────────────────── */

/** 우측 이미지 그리드를 현재 폴더 데이터 기준으로 렌더링 */
function renderGalleryGrid(folderData) {
    const images = getCurrentImageList();

    if (images.length === 0) {
        galleryGrid.innerHTML = '<p class="empty-msg" style="grid-column: 1 / -1; margin-top: 50px;">이미지가 없습니다.</p>';
        return;
    }

    galleryGrid.innerHTML = images.map((img, idx) => {
        const fullPath = img.subfolder ? `${img.subfolder}/${img.filename}` : img.filename;
        const isSelected = selectedImagePaths.has(fullPath);
        const safePath = encodeURIComponent(fullPath).replace(/'/g, "%27");

        return `
            <div class="gallery-item ${isSelected ? 'selected' : ''}" 
                 data-index="${idx}" 
                 data-path="${fullPath}"
                 onclick="handleImageClick(event, ${idx}, decodeURIComponent('${safePath}'))"
                 oncontextmenu="handleGalleryContextMenu(event, '${img.filename.replace(/'/g, "%27")}', '${(img.subfolder || '').replace(/'/g, "%27")}')">
                 
                <img src="${img.url}" loading="lazy">
                <div class="gallery-item-checkbox"></div>
            </div>
        `;
    }).join('');
}

/* ──────────────────────────────────────────────
   이미지 다중 선택 (Shift/Ctrl 클릭 지원)
   ────────────────────────────────────────────── */

let isDragSelecting = false;

/**
 * 이미지 클릭 핸들러.
 * Ctrl/Cmd 클릭: 단일 토글, Shift 클릭: 범위 선택, 일반 클릭: 라이트박스 열기
 */
function handleImageClick(e, index, fullPath) {
    if (isDragSelecting) {
        e.preventDefault();
        e.stopPropagation();
        return;
    }

    if (e.target.closest('.gallery-item-checkbox') || e.ctrlKey || e.metaKey || e.shiftKey) {
        e.stopPropagation();

        const images = getCurrentImageList();

        if (e.shiftKey && lastSelectedIndex !== -1) {
            const start = Math.min(lastSelectedIndex, index);
            const end = Math.max(lastSelectedIndex, index);
            const addMode = true;

            for (let i = start; i <= end; i++) {
                const bPath = images[i].subfolder ? `${images[i].subfolder}/${images[i].filename}` : images[i].filename;
                selectedImagePaths.add(bPath);
            }
        } else {
            if (selectedImagePaths.has(fullPath)) {
                selectedImagePaths.delete(fullPath);
            } else {
                selectedImagePaths.add(fullPath);
            }
            lastSelectedIndex = index;
        }

        syncDOMWithSelection();
        updateGallerySelectionInfo();
    } else {
        const img = getCurrentImageList()[index];
        openLightbox(img.url);
    }
}

/** 선택 상태를 DOM 클래스에 반영 (전체 재렌더링 없이 최적화) */
function syncDOMWithSelection() {
    const items = galleryGrid.querySelectorAll('.gallery-item');
    items.forEach(item => {
        const path = item.getAttribute('data-path');
        if (selectedImagePaths.has(path)) {
            item.classList.add('selected');
        } else {
            item.classList.remove('selected');
        }
    });
}

/** 현재 선택된 이미지 개수를 상태 바에 표시 */
function updateGallerySelectionInfo() {
    document.getElementById('gallery-selection-info').innerText = `선택됨: ${selectedImagePaths.size}`;
}

/* ──────────────────────────────────────────────
   컨텍스트 메뉴 및 "이 설정으로 생성" 기능
   ────────────────────────────────────────────── */

/** 갤러리 이미지 우클릭 시 컨텍스트 메뉴를 표시 */
function handleGalleryContextMenu(e, filename, subfolder) {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e, filename, subfolder);
}

/**
 * 선택한 이미지의 메타데이터를 읽어 생성 탭에 적용하는 브릿지 함수.
 * component_metadata.js의 applyMetadataToForm을 호출한다.
 */
async function sendToGenerateFromGallery() {
    if (!window.currentTargetImg) return;
    document.getElementById('context-menu').style.display = 'none';

    try {
        const decodedFile = decodeURIComponent(window.currentTargetImg.filename);
        const decodedSub = decodeURIComponent(window.currentTargetImg.subfolder);

        const data = await API.get(`/assetmanager/api/image_metadata?filename=${encodeURIComponent(decodedFile)}&subfolder=${encodeURIComponent(decodedSub)}`);

        if (data.status === 'success') {
            if (typeof applyMetadataToForm === 'function') {
                applyMetadataToForm(data);
                openTab('tab-generate');
                window.scrollTo(0, 0);
            } else {
                alert("메타데이터 모듈이 로드되지 않았습니다.");
            }
        } else {
            alert("이미지 메타데이터를 불러오지 못했습니다.");
        }
    } catch (e) {
        console.error(e);
        alert("메타데이터 분석 중 오류가 발생했습니다.");
    }
}

/**
 * 🆕 기능 확장: "이 이미지 설정을 조각으로 저장" — 갤러리 컨텍스트 메뉴에서 호출.
 * sendToGenerateFromGallery()와 같은 /assetmanager/api/image_metadata로 메타데이터를 받아오되,
 * 폼에 적용하는 대신 프롬프트/로라만 뽑아서 component_metadata.js의 applyMetadataToForm()과
 * 완전히 같은 노드 탐색 규칙(🔴 이 규칙이 바뀌면 여기도 같이 바꿀 것 — Text Prompt Combo (JPS)
 * 우선, 없으면 KSampler(Advanced)의 positive가 가리키는 CLIPTextEncode / 로라는 LoraLoader +
 * Power Lora Loader (rgthree))으로 library.js의 createGalleryImagePiece()에 넘겨 새 조각을 만든다.
 * 체크포인트는 조각 단위 저장 개념이 이 라이브러리에 없어서 가져오지 않음(생성 탭에서 전역으로 고르는 값).
 */
async function saveImageSettingsAsFragment() {
    if (!window.currentTargetImg) return;
    document.getElementById('context-menu').style.display = 'none';

    if (typeof createGalleryImagePiece !== 'function') {
        alert("프롬프트 라이브러리 기능을 찾지 못했습니다.");
        return;
    }

    try {
        const decodedFile = decodeURIComponent(window.currentTargetImg.filename);
        const decodedSub = decodeURIComponent(window.currentTargetImg.subfolder);
        const data = await API.get(`/assetmanager/api/image_metadata?filename=${encodeURIComponent(decodedFile)}&subfolder=${encodeURIComponent(decodedSub)}`);

        if (data.status !== 'success' || !data.prompt) {
            alert("이미지 메타데이터를 불러오지 못했습니다(ComfyUI로 생성한 PNG가 아니거나 메타데이터가 없을 수 있습니다).");
            return;
        }

        const p = data.prompt;

        /* 프롬프트 추출: Text Prompt Combo (JPS) 우선, 없으면 KSampler(Advanced)의 positive */
        let posText = '';
        const textComboNode = Object.values(p).find(n => n.class_type === 'Text Prompt Combo (JPS)');
        if (textComboNode && textComboNode.inputs && textComboNode.inputs.pos) {
            posText = textComboNode.inputs.pos;
        } else {
            const ksampler = Object.values(p).find(n => n.class_type === 'KSampler' || n.class_type === 'KSamplerAdvanced');
            const posNodeId = ksampler?.inputs?.positive?.[0];
            if (posNodeId && p[posNodeId]) posText = p[posNodeId].inputs.text || '';
        }
        if (!posText) {
            alert("이 이미지에서 긍정 프롬프트를 찾지 못했습니다.");
            return;
        }

        /* 로라 추출: 표준 LoraLoader + Power Lora Loader (rgthree) — component_metadata.js와 동일 로직 */
        const loraOverride = [];
        Object.values(p).filter(n => n.class_type === 'LoraLoader').forEach(n => {
            loraOverride.push({ lora: n.inputs.lora_name, strength: n.inputs.strength_model });
        });
        const rgthreeNode = Object.values(p).find(n => n.class_type === 'Power Lora Loader (rgthree)');
        if (rgthreeNode && rgthreeNode.inputs) {
            for (let num = 1; num <= 20; num++) {
                const loraObj = rgthreeNode.inputs[`lora_${num}`];
                if (loraObj && loraObj.on && loraObj.lora && loraObj.lora !== 'None') {
                    loraOverride.push({ lora: loraObj.lora, strength: loraObj.strength });
                }
            }
        }

        const defaultName = `갤러리 저장 ${decodedFile.replace(/\.[^.]+$/, '')}`.slice(0, 60);
        const name = (window.prompt('만들 조각 이름', defaultName) || '').trim();
        if (!name) return;
        if (!window.confirm(`이 이미지의 프롬프트${loraOverride.length ? ' + 로라 ' + loraOverride.length + '개' : ''}를 "🖼 갤러리에서 저장" 그룹의 조각 "${name}"(으)로 만들까요? (체크포인트는 조각에 저장되지 않습니다 — 생성 탭에서 따로 선택)`)) return;

        const result = createGalleryImagePiece(name, posText, loraOverride);
        if (!result || !result.ok) {
            alert((result && result.error) || "조각을 만들지 못했습니다.");
            return;
        }
        alert(`"${result.categoryName}" 그룹에 조각 "${name}"을(를) 만들었습니다.`);
    } catch (e) {
        console.error(e);
        alert("메타데이터 분석 중 오류가 발생했습니다.");
    }
}
window.saveImageSettingsAsFragment = saveImageSettingsAsFragment;

/* ──────────────────────────────────────────────
   이미지 삭제
   ────────────────────────────────────────────── */

/** 컨텍스트 메뉴에서 선택한 단일 이미지를 삭제 */
async function deleteContextImage() {
    if (!window.currentTargetImg) return;
    const decodedFile = decodeURIComponent(window.currentTargetImg.filename);
    const decodedSub = decodeURIComponent(window.currentTargetImg.subfolder);
    const path = decodedSub ? `${decodedSub}/${decodedFile}` : decodedFile;

    if (confirm(`이 이미지를 영구 삭제하시겠습니까?\n${decodedFile}`)) {
        await executeDelete([{ filename: decodedFile, subfolder: decodedSub }]);
    }
}

/** 체크박스로 선택된 모든 이미지를 일괄 삭제 */
async function deleteSelectedGalleryImages() {
    if (selectedImagePaths.size === 0) return;

    if (confirm(`선택한 ${selectedImagePaths.size}개의 이미지를 영구 삭제하시겠습니까?`)) {
        const payload = Array.from(selectedImagePaths).map(path => {
            const lastSlash = path.lastIndexOf('/');
            if (lastSlash !== -1) {
                return { subfolder: path.substring(0, lastSlash), filename: path.substring(lastSlash + 1) };
            }
            return { subfolder: "", filename: path };
        });
        await executeDelete(payload);
        selectedImagePaths.clear();
    }
}

/** 현재 보이는 폴더의 모든 이미지를 삭제 */
async function deleteAllGalleryImagesInView() {
    const images = getCurrentImageList();
    if (images.length === 0) return;

    if (confirm(`현재 보이는 ${images.length}개의 이미지를 모두 영구 삭제하시겠습니까?`)) {
        const payload = images.map(img => ({ subfolder: img.subfolder, filename: img.filename }));
        await executeDelete(payload);
        selectedImagePaths.clear();
    }
}

/** 삭제 API 요청을 실행하고 갤러리 데이터를 새로고침 */
async function executeDelete(imagesPayload) {
    try {
        const data = await API.post('/assetmanager/api/delete_images', { images: imagesPayload });

        if (data.status === 'success') {
            console.log(`Deleted: ${data.deleted}, Failed: ${data.failed}`);
            await fetchGalleryData();
        } else {
            alert("삭제 중 오류가 발생했습니다: " + data.message);
        }
    } catch (e) {
        console.error(e);
        alert("삭제 실패");
    } finally {
        document.getElementById('context-menu').style.display = 'none';
        updateGallerySelectionInfo();
    }
}

/* ──────────────────────────────────────────────
   DOM 초기화 (이벤트 바인딩)
   ────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('gallery-search-input').addEventListener('input', (e) => {
        renderGalleryFolders(e.target.value);
    });

    /** 전체 선택/해제 토글 버튼 */
    const selectAllBtn = document.getElementById('gallery-select-all');
    if (selectAllBtn) {
        selectAllBtn.addEventListener('click', () => {
            const items = document.querySelectorAll('.gallery-item');
            if (items.length === 0) return;

            const allSelected = Array.from(items).every(item => item.classList.contains('selected'));

            if (allSelected) {
                selectedImagePaths.clear();
            } else {
                items.forEach(item => {
                    selectedImagePaths.add(item.getAttribute('data-path'));
                });
            }
            syncDOMWithSelection();
            updateGallerySelectionInfo();
        });
    }
});
