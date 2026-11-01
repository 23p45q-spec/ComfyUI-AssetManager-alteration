/**
 * library.js — 프롬프트 라이브러리 관리 모듈
 * 작품(Work) > 그룹(Category) > 조각(Item) 3단 계층 구조를 지원합니다.
 * 아코디언 트리, 모달 편집, 드래그앤드롭 정렬, 컨텍스트 메뉴 복사/붙여넣기,
 * 직교곱(Cartesian Product) 기반 배치 큐 전송, 내보내기/가져오기 기능을 제공합니다.
 */

let libraryData = { works: [] };
let activeWorkId = null;
let activeCategoryId = null;
let selectedSet = {};
let combineMode = {}; // { catId: true } — Shift+Ctrl+클릭으로 표시된, 여러 선택을 하나로 합쳐 쓰는 그룹
let editingState = { work: null, category: null, item: null };
let clipboardGroup = null;

/* 조각 비교 모아보기 상태 (같은 그룹 안의 여러 버전을 나란히 보기 위함) */
let compareMode = false;
let compareSelection = new Set();

/* 조각 검색/필터 (스크롤 없이 이름으로 바로 찾기) */
let itemSearchQuery = '';

const SELECTED_SET_KEY = 'assetmgr_selectedSet';
const ACTIVE_STATE_KEY = 'assetmgr_activeState';

/** activeWorkId / activeCategoryId를 localStorage에 저장 */
function saveActiveState() {
    try {
        localStorage.setItem(ACTIVE_STATE_KEY, JSON.stringify({
            workId: activeWorkId,
            catId: activeCategoryId,
        }));
    } catch (e) {}
}

/** localStorage에서 activeWorkId / activeCategoryId 복원 */
function loadActiveState() {
    try {
        const raw = localStorage.getItem(ACTIVE_STATE_KEY);
        if (!raw) return;
        const { workId, catId } = JSON.parse(raw);
        if (workId) activeWorkId = workId;
        if (catId) activeCategoryId = catId;
    } catch (e) {}
}

/** selectedSet을 localStorage에 저장 (Set → Array 직렬화) */
function saveSelectedSet() {
    try {
        const serialized = {};
        for (const [catId, itemSet] of Object.entries(selectedSet)) {
            serialized[catId] = Array.from(itemSet);
        }
        localStorage.setItem(SELECTED_SET_KEY, JSON.stringify(serialized));
    } catch (e) {}
}

/** localStorage에서 selectedSet 복원 (Array → Set 역직렬화) */
function loadSelectedSet() {
    try {
        const raw = localStorage.getItem(SELECTED_SET_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        selectedSet = {};
        for (const [catId, arr] of Object.entries(parsed)) {
            if (Array.isArray(arr) && arr.length > 0) {
                selectedSet[catId] = new Set(arr);
            }
        }
    } catch (e) {}
}

document.addEventListener("DOMContentLoaded", async () => {
    try {
        const raw = await API.get('/assetmanager/api/library');
        libraryData = migrateLibraryData(raw);
    } catch (e) {
        console.warn("라이브러리 로드 오류, 빈 데이터로 시작:", e);
        libraryData = migrateLibraryData(null);
    }
    loadSelectedSet();
    loadActiveState();
    renderWorkTree();
    renderItems();
    renderBuilder();
    ensureAutoMergeAllButton();

    document.addEventListener('click', () => {
        document.getElementById('lib-context-menu').style.display = 'none';
    });
});

/* ──────────────────────────────────────────────
   데이터 마이그레이션
   ────────────────────────────────────────────── */

/**
 * 구 포맷(categories 배열만 있는 형태)을 새 포맷(works 배열)으로 자동 변환.
 * 복사 버그로 발생한 중복 그룹 ID도 함께 수정한다.
 */
function migrateLibraryData(data) {
    let result = { works: [] };
    if (!data) return result;

    if (data.works && Array.isArray(data.works)) {
        result = data;
    } else if (data.categories && Array.isArray(data.categories)) {
        console.log("[Library] 구 포맷 감지, 자동 마이그레이션 실행");
        result = { works: [{ id: "default", name: "기본", categories: data.categories }] };
    }

    const seenCatIds = new Set();
    let hasModifiedIds = false;

    result.works.forEach(work => {
        if (!work.categories) return;
        work.categories.forEach(cat => {
            if (seenCatIds.has(cat.id)) {
                cat.id = 'cat_fix_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
                hasModifiedIds = true;
            }
            seenCatIds.add(cat.id);
        });
    });

    if (hasModifiedIds || (data.categories && !data.works)) {
        API.post('/assetmanager/api/library', result)
            .catch(err => console.error("마이그레이션 저장 실패:", err));
    }

    return result;
}

/* ──────────────────────────────────────────────
   헬퍼 함수
   ────────────────────────────────────────────── */

/** 현재 활성화된 작품 객체를 반환 */
function getActiveWork() {
    return libraryData.works.find(w => w.id === activeWorkId) || null;
}

/** 현재 활성화된 그룹 객체를 반환 */
function getActiveCategory() {
    const work = getActiveWork();
    if (!work) return null;
    return work.categories.find(c => c.id === activeCategoryId) || null;
}

/** 모든 작품의 그룹을 1차원 배열로 반환 */
function getAllCategories() {
    const result = [];
    libraryData.works.forEach(w => w.categories.forEach(cat => result.push(cat)));
    return result;
}

let libraryAutoSaveTimer;

/** 라이브러리 데이터를 500ms 디바운스로 서버에 자동 저장 */
function debounceLibrarySave() {
    clearTimeout(libraryAutoSaveTimer);
    libraryAutoSaveTimer = setTimeout(async () => {
        API.post('/assetmanager/api/library', libraryData)
            .catch(err => console.error("라이브러리 저장 실패:", err));
    }, 500);
}

/** 즉시 저장 (사용자가 명시적으로 저장 버튼을 클릭한 경우) */
async function saveLibrary() {
    clearTimeout(libraryAutoSaveTimer);
    try {
        await API.post('/assetmanager/api/library', libraryData);
        alert("프롬프트 라이브러리가 저장되었습니다.");
    } catch (e) {
        console.error("라이브러리 저장 에러:", e);
    }
}

/* ──────────────────────────────────────────────
   작품/그룹 수정 모달
   ────────────────────────────────────────────── */

/**
 * 작품 또는 그룹의 ID/이름을 수정하는 모달을 연다.
 * @param {string} type - 'work' 또는 'category'
 * @param {string} id - 수정할 대상의 ID
 */
function openWorkEditModal(type, id) {
    let target;
    if (type === 'work') {
        target = libraryData.works.find(w => w.id === id);
        document.getElementById('work-edit-modal-title').innerText = '작품 수정';
    } else {
        const work = getActiveWork();
        if (!work) return;
        target = work.categories.find(c => c.id === id);
        document.getElementById('work-edit-modal-title').innerText = '그룹 수정';
    }
    if (!target) return;

    document.getElementById('work-edit-type').value = type;
    document.getElementById('work-edit-original-id').value = target.id;
    document.getElementById('work-edit-id').value = target.id;
    document.getElementById('work-edit-name').value = target.name;
    document.getElementById('work-edit-modal').style.display = 'flex';
}

/** 수정 모달 닫기 */
function closeWorkEditModal() {
    document.getElementById('work-edit-modal').style.display = 'none';
}

/** 수정 모달에서 입력된 값을 데이터에 반영 */
function saveWorkEditModal() {
    const type = document.getElementById('work-edit-type').value;
    const oldId = document.getElementById('work-edit-original-id').value;
    const newId = document.getElementById('work-edit-id').value.trim();
    const newName = document.getElementById('work-edit-name').value.trim();

    if (!newId || !newName) { alert("ID와 이름을 모두 입력해주세요."); return; }

    if (type === 'work') {
        const work = libraryData.works.find(w => w.id === oldId);
        if (!work) return;
        if (newId !== oldId && libraryData.works.some(w => w.id === newId)) {
            alert("이미 존재하는 작품 ID입니다."); return;
        }
        if (activeWorkId === oldId) activeWorkId = newId;
        work.id = newId;
        work.name = newName;
    } else {
        const work = getActiveWork();
        if (!work) return;
        const cat = work.categories.find(c => c.id === oldId);
        if (!cat) return;
        if (newId !== oldId && work.categories.some(c => c.id === newId)) {
            alert("같은 작품 내에 중복된 그룹 ID입니다."); return;
        }
        if (selectedSet[oldId] !== undefined) {
            selectedSet[newId] = selectedSet[oldId];
            delete selectedSet[oldId];
        }
        if (activeCategoryId === oldId) activeCategoryId = newId;
        cat.id = newId;
        cat.name = newName;
    }

    closeWorkEditModal();
    renderWorkTree();
    renderItems();
    renderBuilder();
    debounceLibrarySave();
}

/* ──────────────────────────────────────────────
   작품(Work) 관리
   ────────────────────────────────────────────── */

/** 새 작품을 추가하고 수정 모달을 바로 연다 */
function addWork() {
    const newId = 'work_' + Date.now();
    libraryData.works.push({ id: newId, name: "새 작품", categories: [] });
    activeWorkId = newId;
    renderWorkTree();
    openWorkEditModal('work', newId);
    debounceLibrarySave();
}

/** 작품과 하위 모든 그룹/조각을 삭제 */
function deleteWork(e, workId) {
    e.stopPropagation();
    const work = libraryData.works.find(w => w.id === workId);
    if (!work) return;
    if (!confirm(`'${work.name}' 작품과 포함된 모든 그룹/조각이 삭제됩니다.\n계속할까요?`)) return;
    libraryData.works = libraryData.works.filter(w => w.id !== workId);
    if (activeWorkId === workId) { activeWorkId = null; activeCategoryId = null; }
    renderWorkTree();
    renderItems();
    debounceLibrarySave();
}

/** 작품을 펼치거나 접는다 */
function toggleWork(workId) {
    activeWorkId = activeWorkId === workId ? null : workId;
    activeCategoryId = null;
    renderWorkTree();
    renderItems();
    saveActiveState();
}

/* ──────────────────────────────────────────────
   그룹(Category) 관리
   ────────────────────────────────────────────── */

/** 현재 활성 작품에 새 그룹을 추가 */
function addCategory() {
    const work = getActiveWork();
    if (!work) { alert("먼저 작품을 선택(펼치기)해 주세요."); return; }
    const newId = 'cat_' + Date.now();
    work.categories.push({ id: newId, name: "새 그룹", items: [] });
    activeCategoryId = newId;
    renderWorkTree();
    renderItems();
    openWorkEditModal('category', newId);
    debounceLibrarySave();
}

/** 그룹과 하위 조각을 삭제 */
function deleteCategory(e, catId) {
    e.stopPropagation();
    const work = getActiveWork();
    if (!work) return;
    if (!confirm("이 그룹과 포함된 모든 조각이 삭제됩니다.\n계속할까요?")) return;
    work.categories = work.categories.filter(c => c.id !== catId);
    if (activeCategoryId === catId) activeCategoryId = null;
    renderWorkTree();
    renderItems();
    debounceLibrarySave();
}

/** 특정 그룹을 선택하고 해당 그룹의 조각 목록을 표시 */
function selectCategory(workId, catId) {
    if (activeCategoryId !== catId) {
        compareMode = false;
        compareSelection.clear();
        itemSearchQuery = '';
        const box = document.getElementById('item-search-box');
        if (box) box.value = '';
    }
    activeWorkId = workId;
    activeCategoryId = catId;
    renderWorkTree();
    renderItems();
    updateQuickSendButton();
    document.getElementById('btn-add-item').style.display = 'block';
    saveActiveState();
}

/**
 * 🆕 공용 "라이브러리 조각으로 이동" 함수.
 * 그동안 대기열 라벨 클릭(navigateToSourceRef), 명령어 이동(jumpToGroupItem/jumpToGroupItemByIndex),
 * Peek 팝업의 "이동" 버튼이 각자 조금씩 다르게 구현되어 있던 것(하이라이트 방식이 배경색/외곽선으로 다르거나,
 * 실제 작업 세트 선택(selectItemToSet) 여부가 다르거나, 라이브러리 탭 자체 스크롤 유무가 다름)을 하나로 통일.
 * @param {string} catId 그룹 ID
 * @param {string} [itemId] 조각 ID (없으면 그룹까지만 이동)
 * @param {object} [opts]
 * @param {boolean} [opts.select=true] true면 실제로 selectItemToSet()도 호출해서 작업 세트에 선택 (기본 동작 통일)
 * @param {boolean} [opts.switchTab=true] 다른 탭(갤러리 등)에 있었다면 '이미지 생성' 탭으로 전환할지
 * @returns {boolean} 이동 성공 여부
 */
function goToLibraryFragment(catId, itemId, opts = {}) {
    const { select = true, switchTab = true, openEdit = false, queueSync = null } = opts;
    if (typeof libraryData === 'undefined') return false;

    const work = libraryData.works.find(w => w.categories.some(c => c.id === catId));
    const cat = work && work.categories.find(c => c.id === catId);
    if (!work || !cat) {
        alert('해당 그룹을 찾을 수 없습니다. (삭제되었을 수 있습니다)');
        return false;
    }

    if (switchTab && typeof openTab === 'function') openTab('tab-generate');
    selectCategory(work.id, cat.id);

    const item = itemId ? cat.items.find(it => it.id === itemId) : null;

    // openEdit=true면 라이브러리에서 직접 우클릭한 것과 완전히 동일하게 편집 모달까지 바로 연다.
    // (selectCategory가 activeCategoryId를 이미 동기적으로 세팅해뒀으므로 DOM 렌더 대기 없이 바로 호출 가능)
    if (openEdit && item && typeof openPromptEditModal === 'function') {
        openPromptEditModal(item.id, queueSync);
        return true;
    }

    // renderWorkTree/renderItems가 selectCategory 안에서 이미 호출되지만, DOM 갱신 이후에 스크롤/하이라이트해야
    // 대상 요소가 실제로 존재한다 (기존 3곳의 구현이 setTimeout 또는 requestAnimationFrame으로 각자 처리하던 부분 통일).
    // 🔧 예전엔 여기서 #tab-prompt 섹션 전체로 한 번 스크롤한 뒤 50ms 뒤에 조각/그룹 요소로 다시 스크롤했는데,
    //    두 smooth 스크롤이 겹치면서 애니메이션이 서로를 방해해 섹션 상단 근처에서 멈춰버리는 문제가 있었다.
    //    조각(또는 그룹) 요소로 한 번만 스크롤해도 그 섹션 자체가 자연히 화면에 들어오므로 스크롤 호출을 하나로 합친다.
    setTimeout(() => {
        const groupNode = document.querySelector(`.group-node[data-cat-id="${catId}"]`);
        flashHighlight(groupNode, 'bg');

        if (item) {
            const el = document.querySelector(`#item-list .prompt-tag[data-item-id="${item.id}"]`);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                flashHighlight(el, 'outline');
            } else if (groupNode) {
                groupNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            if (select && typeof selectItemToSet === 'function') {
                selectItemToSet(item.id, { shiftKey: false, stopPropagation: () => {} });
            }
        } else if (groupNode) {
            groupNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, 50);

    return true;
}

/** 요소를 잠깐 반짝여서 눈에 띄게 함. mode='bg'는 배경색(그룹 노드용), 'outline'은 외곽선(개별 조각용). */
function flashHighlight(el, mode = 'bg') {
    if (!el) return;
    if (mode === 'outline') {
        const origOutline = el.style.outline;
        el.style.transition = 'outline 0.15s';
        el.style.outline = '2px solid #4CAF50';
        setTimeout(() => {
            el.style.outline = origOutline;
            setTimeout(() => { el.style.transition = ''; }, 200);
        }, 500);
    } else {
        const origBg = el.style.backgroundColor;
        el.style.transition = 'background-color 0.3s';
        el.style.backgroundColor = '#4a3a1a';
        setTimeout(() => {
            el.style.backgroundColor = origBg;
            setTimeout(() => { el.style.transition = ''; }, 300);
        }, 1200);
    }
}
window.goToLibraryFragment = goToLibraryFragment;

/* ──────────────────────────────────────────────
   트리 렌더링
   ────────────────────────────────────────────── */

/** 좌측 패널의 작품 > 그룹 아코디언 트리를 렌더링 */
function renderWorkTree() {
    const tree = document.getElementById('work-tree');
    if (!tree) return;
    if (libraryData.works.length === 0) {
        tree.innerHTML = '<p class="empty-msg">작품을 추가해 주세요.</p>';
        return;
    }

    let html = '';
    libraryData.works.forEach((work, wIdx) => {
        const isExpanded = activeWorkId === work.id;
        html += `<div class="work-node" data-work-id="${work.id}" data-work-idx="${wIdx}">`;

        html += `<div class="work-header ${isExpanded ? 'active' : ''}" draggable="true"
            onclick="toggleWork('${work.id}')"
            oncontextmenu="event.preventDefault(); showWorkContextMenu(event, '${work.id}');">`;
        html += `<span class="work-arrow ${isExpanded ? 'expanded' : ''}">▶</span>`;
        html += `<span class="work-name">${work.name}</span>`;
        html += `<div class="action-btns">`;
        html += `<button class="btn-edit" onclick="event.stopPropagation(); openWorkEditModal('work', '${work.id}')" title="수정">✏️</button>`;
        html += `<button class="btn-delete" onclick="deleteWork(event, '${work.id}')" title="삭제">×</button>`;
        html += `</div></div>`;

        html += `<div class="work-children ${isExpanded ? 'expanded' : ''}">`;
        if (work.categories.length === 0) {
            html += '<p class="empty-msg" style="font-size:0.8em; padding: 5px 10px;">그룹 없음</p>';
        } else {
            work.categories.forEach((cat, cIdx) => {
                const isCatActive = activeCategoryId === cat.id && activeWorkId === work.id;
                html += `<div class="group-node ${isCatActive ? 'active' : ''}" draggable="true"
                    data-work-id="${work.id}" data-cat-id="${cat.id}" data-cat-idx="${cIdx}"
                    onclick="selectCategory('${work.id}', '${cat.id}')"
                    oncontextmenu="event.preventDefault(); showGroupContextMenu(event, '${work.id}', '${cat.id}');">`;
                html += `<span class="group-name">${cat.name} <small style="color:#666;">(${cat.items.length})</small></span>`;
                html += `<div class="action-btns">`;
                html += `<button class="btn-edit" onclick="event.stopPropagation(); openWorkEditModal('category', '${cat.id}')" title="수정">✏️</button>`;
                html += `<button class="btn-delete" onclick="deleteCategory(event, '${cat.id}')" title="삭제">×</button>`;
                html += `</div></div>`;
            });
        }
        html += `</div></div>`;
    });

    tree.innerHTML = html;
    attachTreeDragHandlers();
}

/* ──────────────────────────────────────────────
   드래그앤드롭 (작품 & 그룹 순서 변경)
   ────────────────────────────────────────────── */

/** 트리 내 작품/그룹 요소에 드래그앤드롭 이벤트를 바인딩 */
function attachTreeDragHandlers() {
    const tree = document.getElementById('work-tree');
    if (!tree) return;

    /* 작품 헤더 드래그 */
    tree.querySelectorAll('.work-header[draggable]').forEach(header => {
        header.addEventListener('dragstart', (e) => {
            e.stopPropagation();
            const workNode = header.closest('.work-node');
            workNode.classList.add('dragging');
            e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'work', id: workNode.dataset.workId }));
            e.dataTransfer.effectAllowed = 'move';
        });
        header.addEventListener('dragend', () => {
            tree.querySelectorAll('.dragging, .drag-over-top, .drag-over-bottom').forEach(el => {
                el.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
            });
        });
    });

    /* 그룹 노드 드래그 */
    tree.querySelectorAll('.group-node[draggable]').forEach(node => {
        node.addEventListener('dragstart', (e) => {
            e.stopPropagation();
            node.classList.add('dragging');
            e.dataTransfer.setData('text/plain', JSON.stringify({
                type: 'group', workId: node.dataset.workId, catId: node.dataset.catId
            }));
            e.dataTransfer.effectAllowed = 'move';
        });
        node.addEventListener('dragend', () => {
            tree.querySelectorAll('.dragging, .drag-over-top, .drag-over-bottom').forEach(el => {
                el.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
            });
        });
    });

    /* 작품 드롭 영역 */
    tree.querySelectorAll('.work-node').forEach(workNode => {
        workNode.addEventListener('dragover', (e) => {
            e.preventDefault();
            const data = getDragData(e);
            if (!data || data.type !== 'work') return;
            e.dataTransfer.dropEffect = 'move';
            const rect = workNode.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            workNode.classList.remove('drag-over-top', 'drag-over-bottom');
            workNode.classList.add(e.clientY < midY ? 'drag-over-top' : 'drag-over-bottom');
        });
        workNode.addEventListener('dragleave', () => {
            workNode.classList.remove('drag-over-top', 'drag-over-bottom');
        });
        workNode.addEventListener('drop', (e) => {
            e.preventDefault();
            workNode.classList.remove('drag-over-top', 'drag-over-bottom');
            try {
                const data = JSON.parse(e.dataTransfer.getData('text/plain'));
                if (data.type !== 'work') return;
                const fromIdx = libraryData.works.findIndex(w => w.id === data.id);
                const toIdx = parseInt(workNode.dataset.workIdx);
                if (fromIdx === -1 || fromIdx === toIdx) return;

                const rect = workNode.getBoundingClientRect();
                const insertBefore = e.clientY < rect.top + rect.height / 2;
                const [moved] = libraryData.works.splice(fromIdx, 1);
                let newIdx = insertBefore ? toIdx : toIdx + 1;
                if (fromIdx < toIdx) newIdx--;
                libraryData.works.splice(newIdx, 0, moved);
                renderWorkTree();
                debounceLibrarySave();
            } catch (err) { }
        });
    });

    /* 그룹 드롭 영역 */
    tree.querySelectorAll('.group-node').forEach(node => {
        node.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const types = e.dataTransfer.types;
            if (!types.includes('text/plain')) return;
            e.dataTransfer.dropEffect = 'move';

            node.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-center');
            const rect = node.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            node.classList.add(e.clientY < midY ? 'drag-over-top' : 'drag-over-bottom');
        });
        node.addEventListener('dragleave', () => {
            node.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-center');
        });
        node.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            node.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-center');
            try {
                const data = JSON.parse(e.dataTransfer.getData('text/plain'));

                /* 조각(Item)을 다른 그룹으로 이동 */
                if (data.type === 'item') {
                    const destWorkId = node.dataset.workId;
                    const destCatId = node.dataset.catId;

                    if (data.catId === destCatId) return;

                    const srcCat = getAllCategories().find(c => c.id === data.catId);
                    const destWork = libraryData.works.find(w => w.id === destWorkId);
                    if (!srcCat || !destWork) return;
                    const destCat = destWork.categories.find(c => c.id === destCatId);
                    if (!destCat) return;

                    const fromIdx = parseInt(data.idx);
                    if (isNaN(fromIdx) || fromIdx < 0 || fromIdx >= srcCat.items.length) return;

                    const [moved] = srcCat.items.splice(fromIdx, 1);
                    destCat.items.push(moved);

                    if (activeCategoryId === data.catId || activeCategoryId === destCatId) {
                        renderItems();
                    }
                    debounceLibrarySave();
                    return;
                }

                /* 그룹(Category) 순서 변경 */
                if (data.type === 'group') {
                    const srcWork = libraryData.works.find(w => w.id === data.workId);
                    const destWork = libraryData.works.find(w => w.id === node.dataset.workId);
                    if (!srcWork || !destWork) return;

                    const fromIdx = srcWork.categories.findIndex(c => c.id === data.catId);
                    const toIdx = parseInt(node.dataset.catIdx);
                    if (fromIdx === -1) return;

                    const rect = node.getBoundingClientRect();
                    const insertBefore = e.clientY < rect.top + rect.height / 2;

                    const [moved] = srcWork.categories.splice(fromIdx, 1);
                    let newIdx = insertBefore ? toIdx : toIdx + 1;
                    if (srcWork === destWork && fromIdx < toIdx) newIdx--;
                    destWork.categories.splice(newIdx, 0, moved);

                    renderWorkTree();
                    debounceLibrarySave();
                }
            } catch (err) { }
        });
    });
}

/** dragover 이벤트에서 드래그 데이터 타입을 확인하는 헬퍼 */
function getDragData(e) {
    if (e.dataTransfer.types.includes('text/plain')) {
        return { type: 'work' };
    }
    return null;
}

/* ──────────────────────────────────────────────
   컨텍스트 메뉴 (복사/잘라내기/붙여넣기)
   ────────────────────────────────────────────── */

/** 작품 우클릭 컨텍스트 메뉴 표시 */
function showWorkContextMenu(e, workId) {
    e.stopPropagation();
    const menu = document.getElementById('lib-context-menu');
    let html = '';
    if (clipboardGroup) {
        html += `<div class="ctx-item" onclick="pasteGroupToWork('${workId}')">📥 그룹 붙여넣기</div>`;
        html += `<div class="ctx-divider"></div>`;
    }
    html += `<div class="ctx-item" onclick="openWorkEditModal('work', '${workId}')">✏️ 작품 수정</div>`;
    html += `<div class="ctx-item" onclick="deleteWork(event, '${workId}')">🗑️ 작품 삭제</div>`;

    menu.innerHTML = html;
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.style.display = 'block';
}

/** 그룹 우클릭 컨텍스트 메뉴 표시 */
function showGroupContextMenu(e, workId, catId) {
    e.stopPropagation();
    const menu = document.getElementById('lib-context-menu');
    let html = '';
    html += `<div class="ctx-item" onclick="copyGroup('${workId}', '${catId}')">📋 그룹 복사</div>`;
    html += `<div class="ctx-item" onclick="cutGroup('${workId}', '${catId}')">✂️ 그룹 잘라내기</div>`;
    html += `<div class="ctx-divider"></div>`;
    html += `<div class="ctx-item" onclick="openWorkEditModal('category', '${catId}')">✏️ 그룹 수정</div>`;
    html += `<div class="ctx-item" onclick="deleteCategory(event, '${catId}')">🗑️ 그룹 삭제</div>`;

    menu.innerHTML = html;
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.style.display = 'block';
}

/** 그룹을 클립보드에 복사 */
function copyGroup(workId, catId) {
    const work = libraryData.works.find(w => w.id === workId);
    if (!work) return;
    const cat = work.categories.find(c => c.id === catId);
    if (!cat) return;
    clipboardGroup = { action: 'copy', workId, catId, data: JSON.parse(JSON.stringify(cat)) };
    document.getElementById('lib-context-menu').style.display = 'none';
}

/** 그룹을 클립보드에 잘라내기 */
function cutGroup(workId, catId) {
    const work = libraryData.works.find(w => w.id === workId);
    if (!work) return;
    const cat = work.categories.find(c => c.id === catId);
    if (!cat) return;
    clipboardGroup = { action: 'cut', workId, catId, data: JSON.parse(JSON.stringify(cat)) };
    document.getElementById('lib-context-menu').style.display = 'none';
}

/** 클립보드의 그룹을 대상 작품에 붙여넣기 */
function pasteGroupToWork(targetWorkId) {
    if (!clipboardGroup) return;
    const targetWork = libraryData.works.find(w => w.id === targetWorkId);
    if (!targetWork) return;

    let newCat = JSON.parse(JSON.stringify(clipboardGroup.data));

    if (clipboardGroup.action === 'copy') {
        newCat.id = 'cat_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    } else {
        if (targetWork.categories.some(c => c.id === newCat.id)) {
            newCat.id = newCat.id + '_copy_' + Date.now();
        }
    }

    targetWork.categories.push(newCat);

    if (clipboardGroup.action === 'cut') {
        const srcWork = libraryData.works.find(w => w.id === clipboardGroup.workId);
        if (srcWork) {
            srcWork.categories = srcWork.categories.filter(c => c.id !== clipboardGroup.catId);
        }
        clipboardGroup = null;
    }

    document.getElementById('lib-context-menu').style.display = 'none';
    renderWorkTree();
    debounceLibrarySave();
}

/* ──────────────────────────────────────────────
   조각(Item) 관리 및 렌더링
   ────────────────────────────────────────────── */

/**
 * 현재 활성 그룹의 조각 목록을 렌더링.
 * requires 속성이 있는 조각은 부모 조각이 선택되었을 때만 표시된다.
 */
function renderItems() {
    const list = document.getElementById('item-list');
    const category = getActiveCategory();

    if (!category) {
        document.getElementById('current-cat-name').innerText = `📝 그룹을 선택하세요`;
        list.innerHTML = '<p class="empty-msg" style="width:100%;">그룹을 선택해 주세요.</p>';
        document.getElementById('btn-add-item').style.display = 'none';
        const bulkBtn = document.getElementById('btn-bulk-edit');
        if (bulkBtn) bulkBtn.style.display = 'none';
        const searchBox = document.getElementById('item-search-box');
        if (searchBox) searchBox.style.display = 'none';
        return;
    }

    document.getElementById('current-cat-name').innerText = `📝 ${category.name}`;
    document.getElementById('btn-add-item').style.display = 'block';
    ensureCompareButton();
    document.getElementById('btn-compare-items').style.display = 'inline-block';
    ensureToolsMenu();
    document.getElementById('btn-tools-menu').style.display = 'inline-block';
    ensureSectionCollapsers();
    ensureBulkEditButton();
    ensureAutoMergeButton();
    ensureBulkVersionButton();
    ensureItemSearchBox();
    document.getElementById('item-search-box').style.display = 'block';
    ensureMissingFillButton();
    ensureLabelNumberedButton();
    ensureReviewButton();
    document.getElementById('btn-review').style.display = 'inline-block';
    renderCompareBar();

    const activeParentIds = [];
    for (const [catId, itemSet] of Object.entries(selectedSet)) {
        if (itemSet && itemSet.size > 0) {
            for (const id of itemSet) activeParentIds.push(`${catId}_${id}`);
        }
    }

    const query = itemSearchQuery.trim().toLowerCase();
    const visibleItems = query
        ? category.items.filter(it => itemMatchesSearch(it, query))
        : category.items;

    let html = '';
    if (query && visibleItems.length === 0) {
        html = `<p class="empty-msg" style="width:100%;">"${query}"에 맞는 조각이 없습니다.</p>`;
    }
    visibleItems.forEach((item, visibleIdx) => {
        const idx = category.items.indexOf(item); // 검색 필터 중에도 실제 배열상 위치를 써야 순서변경/드래그가 안 깨짐
        if (item.requires && Array.isArray(item.requires) && item.requires.length > 0) {
            const isRequirementMet = item.requires.some(reqId => activeParentIds.includes(reqId));
            if (!isRequirementMet) return;
        }

        const catSet = selectedSet[activeCategoryId];
        const isSelected = catSet && catSet.has(item.id);
        const isFirst = idx === 0;
        const isLast = idx === category.items.length - 1;
        const isCompareChecked = compareMode && compareSelection.has(item.id);
        const hasVariants = item.variants && item.variants.length > 1;
        const variantIdx = hasVariants ? ((item.activeVariant || 0) + 1) : 0;

        const clickHandler = compareMode
            ? `toggleCompareSelection('${item.id}', event);`
            : `selectItemToSet('${item.id}', event);`;

        html += `
            <div class="prompt-tag ${isSelected ? 'selected' : ''} ${isCompareChecked ? 'compare-checked' : ''}" 
                 draggable="${!compareMode}" data-cat-id="${activeCategoryId}" data-item-idx="${idx}" data-item-id="${item.id}"
                 style="${isCompareChecked ? 'outline:2px solid #FF9800; outline-offset:-1px;' : ''}"
                 ${hasVariants ? `title="${variantIdx}/${item.variants.length}"` : ''}
                 onclick="${clickHandler}"
                 ondblclick="event.stopPropagation(); ${compareMode ? '' : `sendSingleItemToQueue('${activeCategoryId}', '${item.id}');`}"
                 oncontextmenu="event.preventDefault(); openPromptEditModal('${item.id}');">
                ${compareMode ? `<span class="tag-compare-check" style="margin-right:4px;">${isCompareChecked ? '☑️' : '⬜'}</span>` : ''}
                <span class="tag-name">${item.name}</span>
                <span class="tag-id" style="display:none;">${item.id}</span>
                <span class="tag-value" style="display:none;">${item.prompt}</span>
                <button class="tag-edit-btn" onclick="event.stopPropagation(); openPromptEditModal('${item.id}');" title="수정">✏️</button>
                <button class="tag-delete-btn" onclick="event.stopPropagation(); deleteItem(event, '${item.id}');" title="삭제">×</button>
            </div>
        `;
    });

    if (html === '') {
        html = '<p class="empty-msg" style="width:100%; font-size: 0.9em;">조건에 맞는(활성화된) 조각이 없습니다.</p>';
    }
    list.innerHTML = html;
    if (typeof filterPromptTags === 'function') filterPromptTags();
    attachItemDragHandlers();
}

/** 조각 태그에 드래그앤드롭 이벤트를 바인딩 (같은 그룹 내 순서 변경용) */
function attachItemDragHandlers() {
    const list = document.getElementById('item-list');
    if (!list) return;

    list.querySelectorAll('.prompt-tag[draggable]').forEach(tag => {
        tag.addEventListener('dragstart', (e) => {
            e.stopPropagation();
            tag.classList.add('dragging-item');
            e.dataTransfer.setData('text/plain', JSON.stringify({
                type: 'item',
                catId: tag.dataset.catId,
                itemId: tag.dataset.itemId,
                idx: tag.dataset.itemIdx
            }));
            e.dataTransfer.effectAllowed = 'move';
        });

        tag.addEventListener('dragend', () => {
            list.querySelectorAll('.dragging-item, .drag-over-left, .drag-over-right').forEach(el => {
                el.classList.remove('dragging-item', 'drag-over-left', 'drag-over-right');
            });
        });

        tag.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!e.dataTransfer.types.includes('text/plain')) return;
            e.dataTransfer.dropEffect = 'move';

            const rect = tag.getBoundingClientRect();
            const midX = rect.left + rect.width / 2;
            tag.classList.remove('drag-over-left', 'drag-over-right');
            tag.classList.add(e.clientX < midX ? 'drag-over-left' : 'drag-over-right');
        });

        tag.addEventListener('dragleave', () => {
            tag.classList.remove('drag-over-left', 'drag-over-right');
        });

        tag.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            tag.classList.remove('drag-over-left', 'drag-over-right');

            try {
                const data = JSON.parse(e.dataTransfer.getData('text/plain'));
                if (data.type !== 'item') return;

                const category = getActiveCategory();
                if (!category || category.id !== data.catId) return;

                const fromIdx = parseInt(data.idx);
                const toIdx = parseInt(tag.dataset.itemIdx);
                if (fromIdx === toIdx || isNaN(fromIdx) || isNaN(toIdx)) return;

                const rect = tag.getBoundingClientRect();
                const insertBefore = e.clientX < rect.left + rect.width / 2;

                const [moved] = category.items.splice(fromIdx, 1);
                let newIdx = insertBefore ? toIdx : toIdx + 1;
                if (fromIdx < toIdx) newIdx--;

                category.items.splice(newIdx, 0, moved);
                renderItems();
                debounceLibrarySave();
            } catch (err) { }
        });
    });
}

/* ──────────────────────────────────────────────
   조각 편집 모달
   ────────────────────────────────────────────── */

/** 편집 모달에 "N개 버전이 합쳐진 조각입니다" 안내 + 분리 버튼을 동적으로 끼워넣는다 */
function renderVariantNote(item) {
    let note = document.getElementById('edit-prompt-variant-note');
    if (!note) {
        const promptGroup = document.getElementById('edit-prompt-value')?.closest('.form-group');
        if (!promptGroup) return;
        note = document.createElement('div');
        note.id = 'edit-prompt-variant-note';
        note.style.cssText = 'margin-top:8px; padding:8px; border:1px solid #FF9800; border-radius:6px; background:#2a2210; display:none;';
        promptGroup.appendChild(note);
    }
    const catId = activeCategoryId;
    if (item.variants && item.variants.length > 1) {
        const idx = (item.activeVariant || 0) + 1;
        const len = item.variants.length;
        note.style.display = 'block';
        note.innerHTML = `
            <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:0.85em;">
                <span style="color:#FF9800; font-weight:bold;">🔁 버전 관리</span>
                <button type="button" onclick="cycleVariantInModal('${catId}', '${item.id}', -1);" title="이전 버전"
                    style="padding:2px 8px; border-radius:4px 0 0 4px; background:#333; border:1px solid #FF9800; border-right:none; color:#FF9800; cursor:pointer;">◀</button>
                <span style="padding:2px 8px; background:#333; border-top:1px solid #FF9800; border-bottom:1px solid #FF9800; color:#FF9800;">${idx}/${len}</span>
                <button type="button" onclick="cycleVariantInModal('${catId}', '${item.id}', 1);" title="다음 버전"
                    style="padding:2px 8px; border-radius:0 4px 4px 0; background:#333; border:1px solid #FF9800; border-left:none; color:#FF9800; cursor:pointer;">▶</button>
                <button type="button" onclick="addVariantToItem('${catId}', '${item.id}');" title="지금 보이는 프롬프트를 기반으로 새 버전 추가"
                    style="padding:3px 8px; border-radius:4px; background:#333; border:1px solid #4CAF50; color:#4CAF50; cursor:pointer;">➕ 버전 추가</button>
                <button type="button" onclick="addToBasePositive('${catId}', '${item.id}');" title="지금 보이는 프롬프트를 공통 긍정(base-pos)에 추가"
                    style="padding:3px 8px; border-radius:4px; background:#333; border:1px solid #2196F3; color:#2196F3; cursor:pointer;">➕ 긍정에 추가</button>
                <button type="button" onclick="saveAndGenerateNow('${catId}', '${item.id}');" title="지금 편집중인 내용을 저장하고, 이 조각 하나만으로 바로 1장 생성합니다 (대기열에 안 쌓임)"
                    style="padding:3px 8px; border-radius:4px; background:#333; border:1px solid #9C27B0; color:#CE93D8; cursor:pointer;">🚀 저장 후 즉시 출력</button>
                <button type="button" onclick="copyItemAsNewFragment('${catId}', '${item.id}');" title="지금 보이는 프롬프트만 복사해서 완전히 새로운 조각으로 만듭니다 (이 조각의 버전 추가 아님)"
                    style="padding:3px 8px; border-radius:4px; background:#333; border:1px solid #4CAF50; color:#8BC34A; cursor:pointer;">📋 복사</button>
                <button type="button" onclick="deleteVariantFromItem('${catId}', '${item.id}');" title="지금 보이는 버전을 삭제"
                    style="padding:3px 8px; border-radius:4px; background:#333; border:1px solid #e74c3c; color:#e74c3c; cursor:pointer;">🗑 버전 삭제</button>
                <button type="button" onclick="openVariantRangeSendModal('${catId}', '${item.id}');" title="버전 범위를 골라 대기열에 한번에 전송"
                    style="padding:3px 8px; border-radius:4px; background:#333; border:1px solid #4CAF50; color:#4CAF50; cursor:pointer;">📥 범위 전송</button>
                <a href="#" style="margin-left:auto; color:#888; text-decoration:underline; white-space:nowrap;"
                   onclick="event.preventDefault(); splitMergedItem('${item.id}');">🔓 분리</a>
            </div>`;
    } else {
        note.style.display = 'block';
        note.innerHTML = `
            <div style="font-size:0.85em; display:flex; gap:6px; flex-wrap:wrap;">
                <button type="button" onclick="addVariantToItem('${catId}', '${item.id}');" title="지금 프롬프트를 1번 버전으로 두고, 새 버전을 추가로 만듭니다"
                    style="padding:3px 8px; border-radius:4px; background:#333; border:1px solid #4CAF50; color:#4CAF50; cursor:pointer;">➕ 버전 추가 (이 조각을 여러 버전으로 만들기)</button>
                <button type="button" onclick="addToBasePositive('${catId}', '${item.id}');" title="지금 프롬프트를 공통 긍정(base-pos)에 추가"
                    style="padding:3px 8px; border-radius:4px; background:#333; border:1px solid #2196F3; color:#2196F3; cursor:pointer;">➕ 긍정에 추가</button>
                <button type="button" onclick="saveAndGenerateNow('${catId}', '${item.id}');" title="지금 편집중인 내용을 저장하고, 이 조각 하나만으로 바로 1장 생성합니다 (대기열에 안 쌓임)"
                    style="padding:3px 8px; border-radius:4px; background:#333; border:1px solid #9C27B0; color:#CE93D8; cursor:pointer;">🚀 저장 후 즉시 출력</button>
                <button type="button" onclick="copyItemAsNewFragment('${catId}', '${item.id}');" title="지금 프롬프트만 복사해서 완전히 새로운 조각으로 만듭니다"
                    style="padding:3px 8px; border-radius:4px; background:#333; border:1px solid #4CAF50; color:#8BC34A; cursor:pointer;">📋 복사</button>
            </div>`;
    }
}

/** 편집 모달을 닫지 않고 버전만 전환 (프롬프트 입력칸 내용도 함께 갱신) */
/** 편집 모달을 닫지 않고 버전만 전환 (프롬프트 입력칸 내용도 함께 갱신).
 *  전환하기 전, 지금 입력창에 있는(아직 저장 안 한) 내용을 떠나는 버전에 먼저 반영해서 덮어써지지 않게 한다. */
function cycleVariantInModal(catId, itemId, dir) {
    const cat = getAllCategories().find(c => c.id === catId);
    const item = cat && cat.items.find(i => i.id === itemId);
    if (!item || !item.variants || item.variants.length < 2) return;

    const textarea = document.getElementById('edit-prompt-value');
    const curIdx = item.activeVariant || 0;
    if (textarea && item.variants[curIdx]) {
        item.variants[curIdx].prompt = textarea.value;
        item.prompt = textarea.value;
    }

    cycleVariant(catId, itemId, dir);

    document.getElementById('edit-prompt-value').value = item.prompt || '';
    renderVariantNote(item);

    // 🔧 버그 수정: 이 편집 모달이 "대기열 항목에서" 열린 경우, 그 특정 대기열 항목의 버전도
    // 지금 전환한 버전으로 즉시 맞춘다. (아래 syncQueueJobsWithItem은 각 대기열 항목이 "고정해둔"
    // 특정 버전을 지키는 게 기본 동작이라 — 범위 전송으로 여러 버전을 대기열에 나눠 넣어둔 경우를
    // 보호하기 위함 — 사용자가 직접 이 대기열 항목을 열어서 버전을 바꾼 경우엔 그 고정을 무시하고
    // 이 항목만 예외적으로 새 버전을 따라가야 한다. 이게 없으면 ◀▶로 왔다갔다 해도 대기열 쪽은
    // 계속 처음 넣었던 버전에 그대로 고정된 채 안 움직이는 것처럼 보인다.)
    if (activeQueueSyncTarget && typeof jobQueue !== 'undefined') {
        const { jobIndex, fragIndex } = activeQueueSyncTarget;
        const job = jobQueue[jobIndex];
        const ref = job && job.sourceRefs && job.sourceRefs[fragIndex];
        if (ref && ref.catId === catId && ref.itemId === itemId) {
            ref.variantIndex = item.activeVariant;
            job.fullPrompt[fragIndex] = item.prompt;
            if (typeof renderJobQueue === 'function') renderJobQueue();
        }
    }

    if (typeof syncQueueJobsWithItem === 'function') syncQueueJobsWithItem(catId, itemId, item);
    if (window.appStateManager) window.appStateManager.debounceSave();
}

/** 지금 활성 그룹 안의 병합된(여러 버전) 조각들의 표시 버전을 한번에 N번으로 맞춘다. 버전이 N개 미만인 조각은 건너뜀. */
function bulkSetGroupVersion() {
    const category = getActiveCategory();
    if (!category) return;

    const mergedItems = category.items.filter(it => it.variants && it.variants.length > 1);
    if (mergedItems.length === 0) {
        alert('이 그룹에는 병합된(여러 버전) 조각이 없습니다.');
        return;
    }

    const maxLen = Math.max(...mergedItems.map(it => it.variants.length));
    const raw = prompt(`이 그룹의 병합된 조각 ${mergedItems.length}개를 몇 번째 버전으로 맞출까요? (1 ~ ${maxLen})`, '1');
    if (raw === null) return;
    const n = parseInt(raw, 10);
    if (isNaN(n) || n < 1) {
        alert('올바른 번호를 입력해 주세요.');
        return;
    }

    let changed = 0, skipped = 0;
    mergedItems.forEach(item => {
        if (n > item.variants.length) { skipped++; return; }
        item.activeVariant = n - 1;
        item.prompt = item.variants[item.activeVariant].prompt;
        changed++;
    });

    renderItems();
    renderBuilder();
    debounceLibrarySave();
    alert(`${changed}개 조각을 ${n}번째 버전으로 맞췄습니다.${skipped > 0 ? ` (버전이 ${n}개 미만이라 ${skipped}개는 건너뜀)` : ''}`);
}

/** 지금 프롬프트 입력칸에 있는 내용을 새 버전으로 추가한다. 아직 병합 안 된 단일 조각이면 자동으로 병합형(variants)으로 전환. */
function addVariantToItem(catId, itemId) {
    const cat = getAllCategories().find(c => c.id === catId);
    const item = cat && cat.items.find(i => i.id === itemId);
    if (!item) return;

    if (!item.variants || item.variants.length < 2) {
        item.variants = [{ name: item.name, prompt: item.prompt }];
        item.activeVariant = 0;
    }
    const newIdx = item.variants.length;
    const currentPrompt = document.getElementById('edit-prompt-value').value || '';
    item.variants.push({ name: `${item.name} ${newIdx + 1}`, prompt: currentPrompt });
    item.activeVariant = newIdx;
    item.prompt = currentPrompt;

    renderVariantNote(item);
    renderItems();
    renderBuilder();
    debounceLibrarySave();
    if (typeof syncQueueJobsWithItem === 'function') syncQueueJobsWithItem(catId, itemId, item);
}

/** 지금 보이는(활성) 버전을 삭제. 버전이 1개만 남으면 병합을 풀고 일반 조각으로 되돌린다. */
function deleteVariantFromItem(catId, itemId) {
    const cat = getAllCategories().find(c => c.id === catId);
    const item = cat && cat.items.find(i => i.id === itemId);
    if (!item || !item.variants || item.variants.length < 2) return;

    const curIdx = item.activeVariant || 0;
    const label = item.variants[curIdx].name || `${curIdx + 1}번째 버전`;
    if (!confirm(`"${label}" 버전을 삭제할까요? 되돌릴 수 없습니다.`)) return;

    item.variants.splice(curIdx, 1);

    if (item.variants.length <= 1) {
        // 버전이 1개만 남으면 병합을 풀고 원래의 단일 조각으로 되돌림
        const last = item.variants[0];
        item.prompt = last ? last.prompt : item.prompt;
        delete item.variants;
        delete item.activeVariant;
    } else {
        item.activeVariant = Math.min(curIdx, item.variants.length - 1);
        item.prompt = item.variants[item.activeVariant].prompt;
    }

    document.getElementById('edit-prompt-value').value = item.prompt || '';
    renderVariantNote(item);
    renderItems();
    renderBuilder();
    debounceLibrarySave();
    if (typeof syncQueueJobsWithItem === 'function') syncQueueJobsWithItem(catId, itemId, item);
}

/** 편집 모달에 "이 조각의 지정 번호(선택)" 입력칸을 없으면 만들어 끼워넣는다.
 *  같은 에셋인데 캐릭터마다 그룹 내 순서가 달라도, 검수/저장 시 번호를 통일하고 싶을 때 사용.
 *  비워두면 원래대로 그룹 안에서의 실제 순서(배열 위치)가 쓰인다. */
function ensureCustomNumberField() {
    if (document.getElementById('edit-prompt-customnum')) return;
    const requiresGroup = document.getElementById('edit-prompt-requires')?.closest('.form-group');
    if (!requiresGroup || !requiresGroup.parentElement) return;
    makeFieldCollapsible(requiresGroup, 'requires', '🧷');

    const group = document.createElement('div');
    group.className = 'form-group';
    group.innerHTML = `
        <label>지정 번호 (선택 — 검수/저장 시 그룹 순서 대신 이 번호 사용)</label>
        <input type="number" id="edit-prompt-customnum" placeholder="비우면 그룹 내 순서(배열 위치) 그대로 사용"
            style="width:100%; box-sizing:border-box; padding:6px; background:#222; border:1px solid #555; color:#fff; border-radius:4px;">
    `;
    requiresGroup.insertAdjacentElement('afterend', group);
    makeFieldCollapsible(group, 'customnum', '🔢');
}

/** 🆕 편집 모달에 "이 조각 기본 반복 횟수" 입력칸을 없으면 만들어 끼워넣는다.
 *  타율(성공률)이 낮은 조각에 미리 반복 횟수를 박아두면, 대기열에 넣을 때 전역 반복횟수 입력값과
 *  무관하게 이 조각은 항상 지정한 횟수만큼 생성된다. 비워두면 기존처럼 전역 반복횟수를 그대로 따른다. */
function ensureItemRepeatField() {
    if (document.getElementById('edit-prompt-repeatcount')) return;
    const customNumGroup = document.getElementById('edit-prompt-customnum')?.closest('.form-group');
    if (!customNumGroup || !customNumGroup.parentElement) return;

    const group = document.createElement('div');
    group.className = 'form-group';
    group.innerHTML = `
        <label>이 조각 기본 반복 횟수 (선택 — 타율 낮은 조각용, 비우면 전송 시 전역 반복횟수 사용)</label>
        <input type="number" id="edit-prompt-repeatcount" min="1" placeholder="비우면 전역 반복횟수 입력값 그대로 사용"
            style="width:100%; box-sizing:border-box; padding:6px; background:#222; border:1px solid #555; color:#fff; border-radius:4px;">
    `;
    customNumGroup.insertAdjacentElement('afterend', group);
    makeFieldCollapsible(group, 'repeatcount', '🔁');
}

/** 편집 모달에 "이 조각 전용 로라" 섹션을 없으면 만들어 끼워넣는다 */
function ensureItemLoraField() {
    if (document.getElementById('edit-prompt-loras')) return;
    const customNumGroup = document.getElementById('edit-prompt-customnum')?.closest('.form-group');
    if (!customNumGroup || !customNumGroup.parentElement) return;

    const group = document.createElement('div');
    group.className = 'form-group';
    group.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center;">
            <label style="margin-bottom:0;">이 조각 전용 로라 (이 조각으로 생성할 때만 적용, 화면 상단 공통 로라 설정은 그대로 유지)</label>
            <button type="button" id="edit-prompt-lora-add-btn" class="btn-secondary" style="padding:3px 8px; font-size:0.85em; flex-shrink:0; margin-left:8px;">+ 로라 추가</button>
        </div>
        <div id="edit-prompt-loras" style="display:flex; flex-direction:column; gap:6px; margin-top:6px;"></div>
        <div style="font-size:0.78em; color:#888; margin-top:4px;">비워두면 평소처럼 화면 상단(공통) 로라 설정을 그대로 씁니다.</div>
    `;
    customNumGroup.insertAdjacentElement('afterend', group);

    if (typeof ensureLoraSelectSearchObserver === 'function') ensureLoraSelectSearchObserver('edit-prompt-loras');

    document.getElementById('edit-prompt-lora-add-btn').onclick = () => {
        if (!window.loraOptionsHTML) { alert('로라 목록이 아직 로딩되지 않았습니다. 잠시 후 다시 시도해 주세요.'); return; }
        const tempSelect = document.createElement('select');
        tempSelect.innerHTML = window.loraOptionsHTML;
        const firstOpt = Array.from(tempSelect.options).find(o => o.value);
        if (!firstOpt) { alert('선택 가능한 로라가 없습니다.'); return; }
        document.getElementById('edit-prompt-loras').appendChild(renderItemLoraRow({ lora: firstOpt.value, strength: 1 }));
    };
    makeFieldCollapsible(group, 'itemlora', '🎨');
}

/** 편집 모달에 "이 조각 전용 Img2Img / ControlNet" 섹션을 없으면 만들어 끼워넣는다 */
/** 🆕 "저장 및 적용" 버튼을 프롬프트 내용 입력칸 바로 아래, 부모 제약 조건(edit-prompt-requires) 바로 위로 옮긴다.
 *  index.html 마크업을 안 건드리고 런타임에 위치만 이동시키는 방식. 이미 원하는 자리에 있으면 다시 안 옮김. */
function ensureSaveButtonPosition() {
    const promptGroup = document.getElementById('edit-prompt-value')?.closest('.form-group');
    const requiresGroup = document.getElementById('edit-prompt-requires')?.closest('.form-group');
    if (!promptGroup || !requiresGroup) return;

    const saveBtn = Array.from(document.querySelectorAll('button'))
        .find(b => (b.getAttribute('onclick') || '').replace(/\s/g, '').includes('savePromptEditModal()'));
    if (!saveBtn) return;

    if (saveBtn.previousElementSibling === promptGroup) return; // 이미 제자리
    promptGroup.insertAdjacentElement('afterend', saveBtn);
}

/** 🆕 조각 편집 모달의 "전용 설정" 필드 하나(.form-group)를 개별적으로 접고 펼 수 있게 만든다.
 *  화면 위쪽 섹션들의 "완전히 접으면 아이콘 하나만 남는" 방식(ensureSectionCollapsers)과 동일하게,
 *  접으면 그 필드 박스 전체가 사라지고 이모티콘 버튼 하나만 공용 줄에 남는다 — 그 버튼에 마우스를
 *  올리면(title 툴팁) 원래 뭐였는지 보여준다. storageId별로 마지막 펼침 상태를 기억한다. */
function makeFieldCollapsible(groupEl, storageId, icon) {
    if (!groupEl || groupEl.dataset.collapsibleReady === '1') return;
    groupEl.dataset.collapsibleReady = '1';

    const headerEl = groupEl.firstElementChild;
    if (!headerEl) return;
    const fullLabel = headerEl.textContent.trim();

    // 여러 필드가 접혔을 때 아이콘들을 나란히 모아둘 공용 줄 (없으면 이 필드 바로 앞에 만든다)
    let iconRow = document.getElementById('edit-field-collapsed-row');
    if (!iconRow) {
        iconRow = document.createElement('div');
        iconRow.id = 'edit-field-collapsed-row';
        iconRow.style.cssText = 'display:none; flex-wrap:wrap; gap:6px; margin:4px 0;';
        groupEl.parentElement.insertBefore(iconRow, groupEl);
    }

    const iconBtn = document.createElement('button');
    iconBtn.type = 'button';
    iconBtn.className = 'field-collapse-mini-btn';
    iconBtn.textContent = icon || '⚙️';
    iconBtn.style.cssText = 'padding:4px 8px; font-size:0.95em; background:#2a2a2a; border:1px solid #555; color:#ccc; border-radius:6px; cursor:pointer;';

    const key = `am_field_collapsed_${storageId}`;

    const updateIconRowVisibility = () => {
        iconRow.style.display = iconRow.children.length > 0 ? 'flex' : 'none';
    };

    const applyState = (collapsed) => {
        if (collapsed) {
            groupEl.style.display = 'none';
            iconBtn.title = `${fullLabel} (펼치려면 클릭)`;
            if (!iconRow.contains(iconBtn)) iconRow.appendChild(iconBtn);
        } else {
            groupEl.style.display = '';
            if (iconBtn.parentElement === iconRow) iconRow.removeChild(iconBtn);
        }
        updateIconRowVisibility();
    };

    iconBtn.addEventListener('click', () => {
        applyState(false);
        try { localStorage.setItem(key, 'open'); } catch (err) {}
    });

    // 펼쳐진 상태로 보일 때, 필드 헤더 끝에 작게 "접기" 링크를 붙여서 다시 접을 수 있게 함
    // (label이 flex든 아니든 상관없이 항상 잘 보이도록 float 대신 inline 삽입)
    const collapseBackBtn = document.createElement('span');
    collapseBackBtn.textContent = ' ▲ 접기';
    collapseBackBtn.title = '이 설정 접기';
    collapseBackBtn.style.cssText = 'margin-left:8px; font-size:0.75em; color:#888; cursor:pointer; user-select:none; white-space:nowrap;';
    collapseBackBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        applyState(true);
        try { localStorage.setItem(key, 'closed'); } catch (err) {}
    });
    headerEl.appendChild(collapseBackBtn);

    const startOpen = localStorage.getItem(key) === 'open';
    applyState(!startOpen);

    groupEl._collapseHandle = { applyState };
}

/** 🆕 이 필드에 실제로 저장된 값이 있으면, 접혀있어도(아이콘 하나만 있어도) 자동으로 펼쳐서 보여준다.
 *  (설정해둔 걸 까먹고 "왜 반영이 안 되지" 헤매는 걸 방지) */
function forceOpenCollapsibleField(groupEl) {
    if (!groupEl || !groupEl._collapseHandle) return;
    groupEl._collapseHandle.applyState(false);
}

/** 🐛 버그 수정 짝 함수: 값이 없는 필드는 명시적으로 다시 접는다. makeFieldCollapsible()의
 *  필드 그룹 DOM(groupEl)은 조각마다 새로 안 만들고 편집 모달 하나를 계속 재사용하는데,
 *  forceOpenCollapsibleField만 있고 이 반대(닫기)가 없어서, "A 조각(값 있음, 자동으로 펼쳐짐)
 *  → B 조각(그 값 없음)"으로 넘어가도 A에서 펼쳐진 상태가 그대로 DOM에 남아있었다 — 마치
 *  "접기 기능이 풀린 것"처럼 보이는 버그. */
function forceCloseCollapsibleField(groupEl) {
    if (!groupEl || !groupEl._collapseHandle) return;
    groupEl._collapseHandle.applyState(true);
}

/** 🆕 이 조각에 실제로 저장된 값이 있는 "전용 설정" 필드는 펼치고, 없는 필드는 접는다 —
 *  필드별 개별 접기이므로 조각을 바꿀 때마다 매번 "값 있으면 펼침 / 없으면 접힘"으로 명확히
 *  재설정한다(🐛 예전엔 펼치기만 하고 접기는 안 해서 상태가 이전 조각 걸 그대로 들고 있었음). */
function syncAllFieldCollapseStates(item) {
    if (!item) return;
    const syncById = (id, cond) => {
        const el = document.getElementById(id);
        if (cond) forceOpenCollapsibleField(el); else forceCloseCollapsibleField(el);
    };
    syncById('edit-prompt-img2img', item.img2imgOverride && item.img2imgOverride.enabled);
    syncById('edit-prompt-controlnet', item.controlnetOverride && item.controlnetOverride.enabled);
    syncById('edit-prompt-censor', !!item.censorOverride);
    syncById('edit-prompt-negative', !!item.negativeOverride);
    syncById('edit-prompt-invalidate', !!(item.posInvalidate || item.negInvalidate));
    syncById('edit-prompt-condrules', !!(item.condRules && item.condRules.length));
    syncById('edit-prompt-catblock', !!(item.blockCategories && item.blockCategories.length));
    syncById('edit-prompt-seedgroup', !!item.seedGroup);
    syncById('edit-prompt-backview', !!item.backViewFaceWeightDown);

    const syncGroup = (el, cond) => { if (cond) forceOpenCollapsibleField(el); else forceCloseCollapsibleField(el); };
    syncGroup(document.getElementById('edit-prompt-requires')?.closest('.form-group'), !!(item.requires && item.requires.length));
    syncGroup(document.getElementById('edit-prompt-customnum')?.closest('.form-group'),
        item.customNumber !== undefined && item.customNumber !== null && item.customNumber !== '');
    syncGroup(document.getElementById('edit-prompt-loras')?.closest('.form-group'), !!(item.loras && item.loras.length));
}

function ensureItemPipelineFields() {
    ensureSaveButtonPosition(); // 매번 열릴 때 위치 확인 (한 번 옮겨진 뒤엔 내부에서 바로 스킵됨)
    if (document.getElementById('edit-prompt-img2img')) return;
    const loraGroup = document.getElementById('edit-prompt-loras')?.closest('.form-group');
    if (!loraGroup || !loraGroup.parentElement) return;

    const cloneSelectInto = (sourceId, targetSelect) => {
        const source = document.getElementById(sourceId);
        targetSelect.innerHTML = '';
        if (source) Array.from(source.options).forEach(opt => targetSelect.appendChild(new Option(opt.text, opt.value)));
    };

    const group = document.createElement('div');
    group.className = 'form-group';
    group.id = 'edit-prompt-img2img';
    group.style.cssText = 'border:1px solid #333; border-radius:8px; padding:10px; margin-top:10px;';
    group.innerHTML = `
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
            <input type="checkbox" id="edit-img2img-enabled"> 이 조각 전용 Img2Img (이 조각으로 생성할 때만 적용, 화면 상단 공통 Img2Img 설정은 그대로 유지)
        </label>
        <div style="display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap;">
            <input type="file" id="edit-img2img-file" accept="image/*" style="flex:1; min-width:160px;">
            <span id="edit-img2img-filename" style="font-size:0.8em; color:#888;"></span>
        </div>
        <div style="display:flex; align-items:center; gap:8px; margin-top:8px;">
            <label style="font-size:0.85em; color:#aaa; white-space:nowrap;">Denoise</label>
            <input type="number" id="edit-img2img-denoise" min="0.01" max="1.0" step="0.01" value="0.65" style="width:80px;">
        </div>
    `;
    loraGroup.insertAdjacentElement('afterend', group);

    const cnGroup = document.createElement('div');
    cnGroup.className = 'form-group';
    cnGroup.id = 'edit-prompt-controlnet';
    cnGroup.style.cssText = 'border:1px solid #333; border-radius:8px; padding:10px; margin-top:10px;';
    cnGroup.innerHTML = `
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
            <input type="checkbox" id="edit-controlnet-enabled"> 이 조각 전용 ControlNet (이 조각으로 생성할 때만 적용, 화면 상단 공통 ControlNet 설정은 그대로 유지)
        </label>
        <div style="display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap;">
            <input type="file" id="edit-controlnet-file" accept="image/*" style="flex:1; min-width:160px;">
            <span id="edit-controlnet-filename" style="font-size:0.8em; color:#888;"></span>
        </div>
        <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
            <select id="edit-controlnet-preprocessor" style="flex:1; min-width:140px;"></select>
            <select id="edit-controlnet-model" style="flex:1; min-width:140px;"></select>
        </div>
        <div style="display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap;">
            <label style="font-size:0.85em; color:#aaa;">강도</label>
            <input type="number" id="edit-controlnet-strength" min="0" max="2" step="0.05" value="1.0" style="width:70px;">
            <label style="font-size:0.85em; color:#aaa;">시작</label>
            <input type="number" id="edit-controlnet-start" min="0" max="1" step="0.05" value="0.0" style="width:70px;">
            <label style="font-size:0.85em; color:#aaa;">끝</label>
            <input type="number" id="edit-controlnet-end" min="0" max="1" step="0.05" value="1.0" style="width:70px;">
        </div>
    `;
    group.insertAdjacentElement('afterend', cnGroup);

    cloneSelectInto('controlnet-preprocessor', document.getElementById('edit-controlnet-preprocessor'));
    cloneSelectInto('controlnet-model', document.getElementById('edit-controlnet-model'));

    /* ── 검열(모자이크/화이트마스크) 섹션 ── */
    const censorGroup = document.createElement('div');
    censorGroup.className = 'form-group';
    censorGroup.id = 'edit-prompt-censor';
    censorGroup.style.cssText = 'border:1px solid #333; border-radius:8px; padding:10px; margin-top:10px;';
    censorGroup.innerHTML = `
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
            <input type="checkbox" id="edit-censor-enabled"> 이 조각 전용 검열 (이 조각으로 생성할 때만 적용, 화면 상단 공통 검열 설정은 그대로 유지)
        </label>
        <div id="edit-censor-labels" style="display:flex; flex-wrap:wrap; gap:8px 14px; margin-top:8px; font-size:0.85em; color:#ccc;"></div>
        <div style="display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap;">
            <label style="font-size:0.85em; color:#aaa; white-space:nowrap;">방식</label>
            <select id="edit-censor-mode" style="flex:1; min-width:120px;"></select>
            <label style="font-size:0.85em; color:#aaa; white-space:nowrap;">강도</label>
            <input type="range" id="edit-censor-intensity" min="1" max="50" value="15" style="flex:1; min-width:100px;">
        </div>
    `;
    cnGroup.insertAdjacentElement('afterend', censorGroup);
    cloneSelectInto('censor-mode', document.getElementById('edit-censor-mode'));

    /* ── 🆕 이 조각 전용 부정프롬프트 섹션 (Img2Img/ControlNet/검열과 같은 패턴) ── */
    const negGroup = document.createElement('div');
    negGroup.className = 'form-group';
    negGroup.id = 'edit-prompt-negative';
    negGroup.style.cssText = 'border:1px solid #333; border-radius:8px; padding:10px; margin-top:10px;';
    negGroup.innerHTML = `
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
            <input type="checkbox" id="edit-negative-enabled"> 이 조각 전용 부정프롬프트 (이 조각을 쓸 때만 공통 부정프롬프트 뒤에 자동으로 덧붙여짐)
        </label>
        <textarea id="edit-negative-value" rows="2" style="width:100%; margin-top:8px; resize:vertical;"
                  placeholder="예: bad hands, extra fingers"></textarea>
    `;
    censorGroup.insertAdjacentElement('afterend', negGroup);

    /* ── 🆕 이 조각 전용 키워드 무효화 (공통 긍정/부정 프롬프트 중 일부만 이 조각 쓸 때 제외) ──
       예: 출력하려는 게 "사과"인데 공통 부정프롬프트에 "과일"이 있으면, 여기 부정프롬프트 칸에
       "과일"을 적어두면 이 조각으로 생성할 때만 부정프롬프트에서 "과일"이 빠진다. */
    const invalidateGroup = document.createElement('div');
    invalidateGroup.className = 'form-group';
    invalidateGroup.id = 'edit-prompt-invalidate';
    invalidateGroup.style.cssText = 'border:1px solid #333; border-radius:8px; padding:10px; margin-top:10px;';
    invalidateGroup.innerHTML = `
        <label style="display:flex; align-items:center; gap:6px;">
            🚫 이 조각 전용 키워드 무효화 (이 조각을 쓸 때만, 공통 프롬프트 중 아래 키워드를 제외하고 생성)
        </label>
        <div style="font-size:0.8em; color:#888; margin-top:4px;">
            콤마로 여러 개 입력 가능. 예: 출력할 게 "사과"인데 공통 부정프롬프트에 "과일"이 있다면,
            아래 <b>부정프롬프트에서 무효화</b> 칸에 "과일"을 적으면 이 조각을 쓸 때만 부정프롬프트에서 "과일"이 빠집니다.
        </div>
        <label style="display:block; font-size:0.85em; color:#aaa; margin-top:8px;">긍정프롬프트에서 무효화</label>
        <textarea id="edit-pos-invalidate-value" rows="2" style="width:100%; margin-top:4px; resize:vertical;"
                  placeholder="예: long hair"></textarea>
        <div id="edit-pos-invalidate-chips" style="margin-top:4px; padding:6px 8px; background:#1a1a1a; border:1px solid #333; border-radius:6px; line-height:1.9;"></div>
        <div style="font-size:0.75em; color:#888; margin-top:2px;">▲ 공통 긍정프롬프트(공통+행동) — 태그를 클릭하면 이 조각에서만 끄기/켜기 (꺼진 태그는 취소선)</div>
        <div id="edit-pos-invalidate-comp-chips" style="margin-top:4px; padding:6px 8px; background:#1a1a1a; border:1px solid #333; border-radius:6px; line-height:1.9;"></div>
        <div style="font-size:0.75em; color:#888; margin-top:2px;">▲ 📷 이 조각 프롬프트 안의 구도 태그 — 클릭하면 이 조각에서만 끄기/켜기 (위 긍정프롬프트 무효화 칸에 자동 입력, 글자는 그대로)</div>
        <label style="display:block; font-size:0.85em; color:#aaa; margin-top:8px;">부정프롬프트에서 무효화</label>
        <textarea id="edit-neg-invalidate-value" rows="2" style="width:100%; margin-top:4px; resize:vertical;"
                  placeholder="예: 과일, fruit"></textarea>
        <div id="edit-neg-invalidate-chips" style="margin-top:4px; padding:6px 8px; background:#1a1a1a; border:1px solid #333; border-radius:6px; line-height:1.9;"></div>
        <div style="font-size:0.75em; color:#888; margin-top:2px;">▲ 공통 부정프롬프트 — 태그를 클릭하면 이 조각에서만 끄기/켜기 (꺼진 태그는 취소선)</div>
    `;
    negGroup.insertAdjacentElement('afterend', invalidateGroup);
    ['pos', 'neg'].forEach(kind => {
        const ta = invalidateGroup.querySelector(`#edit-${kind}-invalidate-value`);
        if (ta) ta.addEventListener('input', () => { refreshInvalidateChips(kind); if (kind === 'pos') refreshCompInvalidateChips(); });
    });

    /* ── 🔀 이 조각 전용 조건부 프롬프트 변화 ──
       예: 긍정프롬프트에 "apple"이 있으면 "red clothes" 추가, "orange"가 있으면 "orange clothes" 추가.
       규칙은 얼마든지 직접 추가/삭제 가능. (판정/적용 로직은 generate.js의 applyItemConditionalRules) */
    const condGroup = document.createElement('div');
    condGroup.className = 'form-group';
    condGroup.id = 'edit-prompt-condrules';
    condGroup.style.cssText = 'border:1px solid #333; border-radius:8px; padding:10px; margin-top:10px;';
    condGroup.innerHTML = `
        <label style="display:flex; align-items:center; gap:6px;">
            🔀 이 조각 전용 조건부 프롬프트 변화 (이 조각을 쓸 때만, 긍정프롬프트에 특정 단어가 있으면 프롬프트를 추가/교체)
        </label>
        <div style="font-size:0.8em; color:#888; margin-top:4px;">
            예: <b>apple</b> 이 있으면 → <b>red clothes</b> 추가 / <b>orange</b> 가 있으면 → <b>orange clothes</b> 추가.<br>
            단어는 콤마로 여러 개(하나라도 있으면 발동). 대소문자·밑줄(_)·가중치 문법은 무시하고, 공통/행동/다른 조각에 있는 단어도 인식합니다.
            "대신 지울 단어"를 적으면 발동 시 그 태그를 지워서 기존 옷 색 등을 <b>교체</b>할 수 있어요.
        </div>
        <div style="margin-top:8px; font-size:0.85em; color:#aaa;">
            각 조건 아래에 이 조각의 프롬프트가 색깔 태그로 보입니다. 태그를 클릭하면:
            <label style="margin-left:8px; cursor:pointer;"><input type="radio" name="cond-chip-mode" value="remove" checked> 🚫 발동 시 끄기(대신 지울 단어에 넣기/빼기)</label>
            <label style="margin-left:8px; cursor:pointer;"><input type="radio" name="cond-chip-mode" value="when"> 🎯 조건 단어로 넣기/빼기</label>
        </div>
        <div id="edit-cond-rules-list" style="display:flex; flex-direction:column; gap:8px; margin-top:8px;"></div>
        <button type="button" id="edit-cond-rules-add-btn" class="btn-secondary" style="margin-top:8px; padding:3px 10px; font-size:0.85em;">+ 조건 추가</button>
    `;
    invalidateGroup.insertAdjacentElement('afterend', condGroup);
    const promptValueEl = document.getElementById('edit-prompt-value');
    if (promptValueEl && !promptValueEl.dataset.condChipsWired) {
        promptValueEl.dataset.condChipsWired = '1';
        promptValueEl.addEventListener('input', () => { refreshAllCondRuleChips(); refreshCatBlockPreview(); refreshCompInvalidateChips(); }); // 조각 프롬프트를 고치면 조건 아래 칩/차단 미리보기도 같이 갱신
    }
    condGroup.querySelector('#edit-cond-rules-add-btn').onclick = () => {
        document.getElementById('edit-cond-rules-list').appendChild(renderCondRuleRow({}));
    };

    /* ── 🔗 시드 동일화 그룹: 같은 그룹명을 가진 조각들끼리, 한 번에 대기열에 같이 넣으면
       같은(공유) 시드를 쓰게 된다. 그룹 전체를 다시 넣을 때마다 그 시드는 새로 랜덤하게
       뽑히고, 그룹 안에서만 항상 일치한다 (예: "사과들기"+"사과먹기" 조각을 같이 넣으면
       매번 새 시드지만 그 둘은 서로 항상 같은 시드). ── */
    const seedGroupField = document.createElement('div');
    seedGroupField.className = 'form-group';
    seedGroupField.id = 'edit-prompt-seedgroup';
    seedGroupField.style.cssText = 'border:1px solid #333; border-radius:8px; padding:10px; margin-top:10px;';
    seedGroupField.innerHTML = `
        <label style="display:flex; align-items:center; gap:6px;">
            🔗 시드 동일화 그룹명 (선택)
        </label>
        <input type="text" id="edit-seedgroup-value" style="width:100%; margin-top:8px;"
               placeholder="예: 사과 — 같은 이름을 쓴 다른 조각들과 한 번에 대기열에 넣으면 시드가 공유됩니다">
    `;
    /* ── 🧱 이 조각 전용 카테고리 차단 ──
       이 조각을 쓸 때만, 최종 긍정프롬프트에서 선택한 카테고리(의상/패션, 얼굴 등)의 태그를 전부 제외.
       카테고리는 프롬프트 색 미리보기와 같은 분류. 클릭으로 차단(취소선)/해제. (적용은 generate.js applyItemCategoryBlock) */
    const catBlockGroup = document.createElement('div');
    catBlockGroup.className = 'form-group';
    catBlockGroup.id = 'edit-prompt-catblock';
    catBlockGroup.style.cssText = 'border:1px solid #333; border-radius:8px; padding:10px; margin-top:10px;';
    catBlockGroup.innerHTML = `
        <label style="display:flex; align-items:center; gap:6px;">
            🧱 이 조각 전용 카테고리 차단 (이 조각을 쓸 때만, 선택한 카테고리의 태그를 긍정프롬프트에서 전부 제외)
        </label>
        <div style="font-size:0.8em; color:#888; margin-top:4px;">
            예: 후방 조각이면 <b>얼굴</b>을 차단, 누드 조각이면 <b>의상/패션</b>을 차단. 카테고리를 클릭하면 차단(취소선)/해제됩니다.
            분류는 프롬프트 색깔과 같고, 공통·행동·다른 조각·이 조각 자신의 태그가 모두 대상입니다.
        </div>
        <div id="edit-catblock-chips" style="margin-top:8px; line-height:2;"></div>
        <div id="edit-catblock-preview" style="margin-top:6px; padding:6px 8px; background:#1a1a1a; border:1px solid #333; border-radius:6px; line-height:1.9;"></div>
        <div style="font-size:0.75em; color:#888; margin-top:2px;">▲ 차단 미리보기 (공통 긍정 + 이 조각 프롬프트) — 취소선 = 이 조각에서 빠질 태그</div>
    `;
    condGroup.insertAdjacentElement('afterend', catBlockGroup);
    catBlockGroup.insertAdjacentElement('afterend', seedGroupField);

    /* ── 🙈 후방뷰: 얼굴 관련 태그 가중치 하락 (카드에 항상 떠있던 버튼을 모달 안 체크박스로 이동) ── */
    const backViewField = document.createElement('div');
    backViewField.className = 'form-group';
    backViewField.id = 'edit-prompt-backview';
    backViewField.style.cssText = 'border:1px solid #333; border-radius:8px; padding:10px; margin-top:10px;';
    backViewField.innerHTML = `
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
            <input type="checkbox" id="edit-backview-enabled"> 🙈 후방뷰: 이 조각이 포함된 프롬프트의 얼굴 관련 태그(눈/입/표정 등) 가중치를 자동으로 0.5로 낮춤
        </label>
    `;
    seedGroupField.insertAdjacentElement('afterend', backViewField);

    /* 화면 상단의 검열 부위 체크박스 목록(censor-*)을 그대로 복제해서 라벨/값만 재사용 */
    const censorLabelIds = ['nipples', 'pussy', 'penis', 'anus', 'testicles', 'xray', 'cross-section'];
    const censorLabelText = { nipples: '꼭지', pussy: '음부', penis: '성기', anus: '항문', testicles: '고환', xray: 'X-ray', 'cross-section': '단면' };
    const labelsBox = document.getElementById('edit-censor-labels');
    censorLabelIds.forEach(key => {
        const wrap = document.createElement('label');
        wrap.style.cssText = 'display:flex; align-items:center; gap:3px; cursor:pointer;';
        wrap.innerHTML = `<input type="checkbox" data-censor-label="${key}"> ${censorLabelText[key] || key}`;
        labelsBox.appendChild(wrap);
    });

    /* 파일 선택 즉시 서버에 업로드해두고, 반환된 파일명을 저장해뒀다가 "저장" 시 item에 반영한다 */
    document.getElementById('edit-img2img-file').onchange = async (e) => {
        const file = e.target.files[0];
        if (!file || !window.uploadImg2ImgImage) return;
        const filenameEl = document.getElementById('edit-img2img-filename');
        filenameEl.textContent = '업로드 중...';
        try {
            const name = await window.uploadImg2ImgImage(file);
            window._editModalImg2ImgUploaded = name;
            filenameEl.textContent = name;
        } catch (err) {
            filenameEl.textContent = '업로드 실패';
        }
    };

    document.getElementById('edit-controlnet-file').onchange = async (e) => {
        const file = e.target.files[0];
        if (!file || !window.uploadControlNetImage) return;
        const filenameEl = document.getElementById('edit-controlnet-filename');
        filenameEl.textContent = '업로드 중...';
        try {
            const name = await window.uploadControlNetImage(file);
            window._editModalControlnetUploaded = name;
            filenameEl.textContent = name;
        } catch (err) {
            filenameEl.textContent = '업로드 실패';
        }
    };

    // 🆕 "이 조각 전용" 설정들이 계속 늘어서 모달이 길어짐 → 하나로 묶지 않고,
    // 다른 큰 섹션들처럼 기능마다 각자 아이콘 + ▼/▶로 개별 접기/펼치기.
    makeFieldCollapsible(group, 'img2img', '🖼️');
    makeFieldCollapsible(cnGroup, 'controlnet', '🎛️');
    makeFieldCollapsible(censorGroup, 'censor', '🔞');
    makeFieldCollapsible(negGroup, 'negative', '📝');
    makeFieldCollapsible(invalidateGroup, 'invalidate', '🚫');
    makeFieldCollapsible(condGroup, 'condrules', '🔀');
    makeFieldCollapsible(catBlockGroup, 'catblock', '🧱');
    makeFieldCollapsible(seedGroupField, 'seedgroup', '🔗');
    makeFieldCollapsible(backViewField, 'backview', '🙈');
}

/** 편집 모달을 열 때, 저장돼있던 item.img2imgOverride / item.controlnetOverride 값을 필드에 채운다 */
function renderItemPipelineFields(item) {
    const i2i = item.img2imgOverride || null;
    document.getElementById('edit-img2img-enabled').checked = !!(i2i && i2i.enabled);
    document.getElementById('edit-img2img-denoise').value = (i2i && i2i.denoise !== undefined) ? i2i.denoise : 0.65;
    document.getElementById('edit-img2img-filename').textContent = (i2i && i2i.imageName) ? i2i.imageName : '';
    document.getElementById('edit-img2img-file').value = '';
    window._editModalImg2ImgUploaded = (i2i && i2i.imageName) ? i2i.imageName : null;

    const cn = item.controlnetOverride || null;
    document.getElementById('edit-controlnet-enabled').checked = !!(cn && cn.enabled);
    document.getElementById('edit-controlnet-filename').textContent = (cn && cn.imageName) ? cn.imageName : '';
    document.getElementById('edit-controlnet-file').value = '';
    if (cn && cn.preprocessor) document.getElementById('edit-controlnet-preprocessor').value = cn.preprocessor;
    if (cn && cn.model) document.getElementById('edit-controlnet-model').value = cn.model;
    document.getElementById('edit-controlnet-strength').value = (cn && cn.strength !== undefined) ? cn.strength : 1.0;
    document.getElementById('edit-controlnet-start').value = (cn && cn.start !== undefined) ? cn.start : 0.0;
    document.getElementById('edit-controlnet-end').value = (cn && cn.end !== undefined) ? cn.end : 1.0;
    window._editModalControlnetUploaded = (cn && cn.imageName) ? cn.imageName : null;
}

/** 편집 모달을 열 때, 저장돼있던 item.censorOverride 값을 필드에 채운다 */
function renderItemCensorFields(item) {
    const c = item.censorOverride || null;
    document.getElementById('edit-censor-enabled').checked = !!(c && c.enabled);
    document.getElementById('edit-censor-mode').value = (c && c.mode) ? c.mode : 'mosaic';
    document.getElementById('edit-censor-intensity').value = (c && c.intensity !== undefined) ? c.intensity : 15;
    const labels = (c && Array.isArray(c.labels)) ? c.labels : [];
    document.querySelectorAll('#edit-censor-labels input[data-censor-label]').forEach(cb => {
        cb.checked = labels.includes(cb.dataset.censorLabel);
    });
}

/** 🆕 편집 모달을 열 때, 저장돼있던 item.negativeOverride 값을 필드에 채운다 */
function renderItemNegativeField(item) {
    const enabled = document.getElementById('edit-negative-enabled');
    const value = document.getElementById('edit-negative-value');
    if (!enabled || !value) return;
    enabled.checked = !!item.negativeOverride;
    value.value = item.negativeOverride || '';
}

/* ──────────────────────────────────────────────
   🎨 클릭으로 끄고 켜는 색깔 태그 칩 (조각 편집창 공용)
   색은 generate.js의 classifyPromptTag()(공통 프롬프트 색 미리보기와 같은 분류)를 그대로 재사용.
   - 🚫 키워드 무효화 칸: 공통 긍정/부정 프롬프트 태그 → 클릭하면 무효화 목록에 넣기/빼기 (꺼진 건 취소선)
   - 🔀 조건부 칸: 이 조각 프롬프트 태그 → 클릭하면 선택한 모드에 따라 "대신 지울 단어"/"조건 단어"에 넣기/빼기
   칩은 입력칸 값을 편하게 채워주는 용도일 뿐, 저장되는 건 항상 입력칸의 글자 그대로임.
   ────────────────────────────────────────────── */
function getPromptTagsFromText(str) {
    return (str || '').split(',').map(t => t.trim()).filter(Boolean);
}
function plainPromptTag(tag) {
    return (typeof stripWeightSyntax === 'function') ? stripWeightSyntax(tag) : tag;
}

/** off: 꺼진 표시(취소선), picked: 조건 단어로 선택됨(🎯 + 테두리)
 *  🆕 "red shirt"처럼 색상/수량/크기 수식어가 붙은 태그는 generate.js의 classifyPromptTagSegments()로
 *  쪼개서, 세그먼트마다 자기 색으로 두른 작은 알약을 이어붙여 보여준다(분류/필터링 판정 자체는 안 바뀌고
 *  칩 겉모습만 세분화됨) — generate.js의 renderCategorizedPromptHtml()/promptSegmentBadgeHtml()와
 *  디자인을 맞춤(옛날엔 여기만 따로 그라데이션 분할 방식이라 글자가 색 경계선에 걸치는 문제가 남아있었음). */
function makeToggleChip(tag, opts) {
    opts = opts || {};
    const segments = (typeof classifyPromptTagSegments === 'function')
        ? classifyPromptTagSegments(tag)
        : [{ name: '기타', color: '#aaaaaa', text: tag }];
    const marker = (typeof PROMPT_CATEGORY_RARE_MARKERS !== 'undefined' && segments.some(s => PROMPT_CATEGORY_RARE_MARKERS.has(s.name))) ? ' ✦' : '';
    const mainColor = segments[segments.length - 1].color || '#aaaaaa'; // picked 테두리/title 기준은 기본(마지막) 카테고리 색
    const chip = document.createElement('span');
    chip.className = 'toggle-chip';
    chip.style.cssText = 'display:inline-flex; align-items:center; cursor:' + (opts.readonly ? 'default' : 'pointer') + '; user-select:none;'
        + (opts.picked ? ` box-shadow:0 0 0 1px ${mainColor}; border-radius:5px;` : '');

    if (opts.off) {
        // 꺼진 태그는 세그먼트 색 구분이 의미 없으니(어차피 취소선 회색 하나) 기존처럼 통짜 한 조각으로
        chip.style.cssText += ' padding:2px 8px; border-radius:5px; margin:2px 3px 2px 0; font-size:0.82em; background:#33333388; color:#777; text-decoration:line-through; border:1px dashed #555;';
        chip.textContent = (opts.picked ? '🎯 ' : '') + tag + marker;
    } else {
        if (opts.picked) {
            const pickedPrefix = document.createElement('span');
            pickedPrefix.style.cssText = 'font-size:0.82em; margin:2px 2px 2px 0;';
            pickedPrefix.textContent = '🎯';
            chip.appendChild(pickedPrefix);
        }
        const n = segments.length;
        segments.forEach((s, i) => {
            chip.appendChild(promptSegmentBadgeHtmlNode(s, i === 0, i === n - 1, n === 1, i === n - 1 ? marker : ''));
        });
    }
    chip.title = opts.title || (segments.length > 1 ? segments.map(s => s.name).join(' + ') : '');
    chip.addEventListener('mousedown', e => e.preventDefault()); // 입력칸 포커스/선택이 풀리지 않게
    chip.addEventListener('click', () => { if (opts.onClick) opts.onClick(tag); });
    return chip;
}

/** 🆕 generate.js의 promptSegmentBadgeHtml()과 같은 모양을, 문자열이 아니라 실제 DOM 노드로 만든 버전
 *  (makeToggleChip()은 칩 전체가 하나의 DOM 엘리먼트여야 click/mousedown 리스너를 달 수 있어서 HTML 문자열
 *  대신 노드를 직접 만듦). 디자인(패딩/라운드/테두리 규칙)은 generate.js 쪽과 반드시 같이 맞출 것. */
function promptSegmentBadgeHtmlNode(seg, isFirst, isLast, isOnly, marker) {
    const c = seg.color;
    const radius = isOnly ? '5px' : isFirst ? '5px 0 0 5px' : isLast ? '0 5px 5px 0' : '0';
    const marginRight = isLast ? '3px' : '1px';
    const el = document.createElement('span');
    el.style.cssText = `display:inline-block; background:${c}26; color:${c}; border:1px solid ${c}55; `
        + `${isFirst ? '' : 'border-left:none; '}padding:2px 6px; border-radius:${radius}; margin:2px ${marginRight} 2px 0; `
        + `font-size:0.82em;`;
    el.textContent = seg.text + (marker || '');
    return el;
}

/** 🚫 무효화 칸의 칩 갱신. kind: 'pos' | 'neg'.
 *  판정은 실제 필터(generate.js filterTokensFromPromptByList)와 똑같이 "가중치 문법 벗기고 소문자" 정확일치 기준. */
function refreshInvalidateChips(kind) {
    const ta = document.getElementById(`edit-${kind}-invalidate-value`);
    const box = document.getElementById(`edit-${kind}-invalidate-chips`);
    if (!ta || !box) return;
    const invNorm = t => plainPromptTag(t).toLowerCase();
    const srcText = kind === 'pos'
        ? [document.getElementById('base-pos')?.value, document.getElementById('action-pos')?.value].filter(v => v && v.trim()).join(', ')
        : (document.getElementById('base-neg')?.value || '');
    const seen = new Set();
    const tags = getPromptTagsFromText(srcText).filter(t => { const k = invNorm(t); if (!k || seen.has(k)) return false; seen.add(k); return true; });
    box.innerHTML = '';
    if (tags.length === 0) {
        box.innerHTML = `<span style="color:#666; font-size:0.8em;">(공통 ${kind === 'pos' ? '긍정' : '부정'}프롬프트가 비어있음)</span>`;
        return;
    }
    const offSet = new Set(getPromptTagsFromText(ta.value).map(invNorm));
    tags.forEach(tag => {
        const off = offSet.has(invNorm(tag));
        box.appendChild(makeToggleChip(tag, {
            off,
            title: off ? '이 조각에서 제외됨 (클릭: 다시 켜기)' : '클릭: 이 조각에서만 끄기',
            onClick: () => {
                const n = invNorm(tag);
                const items = getPromptTagsFromText(ta.value);
                const has = items.some(x => invNorm(x) === n);
                const next = has ? items.filter(x => invNorm(x) !== n) : [...items, plainPromptTag(tag)];
                ta.value = next.join(', ');
                refreshInvalidateChips(kind);
                if (kind === 'pos') refreshCompInvalidateChips();
            }
        }));
    });
}

/** 📷 조각 편집창: 이 조각 프롬프트 안에서 인식된 구도 태그를 칩으로 보여주고, 클릭하면 이 조각의 "긍정프롬프트에서 무효화" 칸에 넣고 뺀다.
 *  (저장되는 건 기존 posInvalidate 그대로라 생성 파이프라인은 손대지 않음. 구도 인식은 tools_camera.js의 recognizeCameraCompositionTags) */
function refreshCompInvalidateChips() {
    const ta = document.getElementById('edit-pos-invalidate-value');
    const box = document.getElementById('edit-pos-invalidate-comp-chips');
    if (!ta || !box) return;
    const invNorm = t => plainPromptTag(t).toLowerCase();
    const recognizer = (typeof window.recognizeCameraCompositionTags === 'function') ? window.recognizeCameraCompositionTags : null;
    const tags = recognizer ? recognizer(document.getElementById('edit-prompt-value')?.value || '') : [];
    box.innerHTML = '';
    if (tags.length === 0) {
        box.innerHTML = `<span style="color:#666; font-size:0.8em;">(${recognizer ? '이 조각 프롬프트에서 인식된 구도 태그가 없음' : '카메라 구도 도구(tools_camera.js)가 없어 인식할 수 없음'})</span>`;
        return;
    }
    const offSet = new Set(getPromptTagsFromText(ta.value).map(invNorm));
    tags.forEach(tag => {
        const off = offSet.has(invNorm(tag));
        box.appendChild(makeToggleChip(tag, {
            off,
            title: off ? '이 조각에서 구도 태그 꺼짐 (클릭: 다시 켜기)' : '클릭: 이 조각에서만 이 구도 태그 끄기',
            onClick: () => {
                const n = invNorm(tag);
                const items = getPromptTagsFromText(ta.value);
                const has = items.some(x => invNorm(x) === n);
                ta.value = (has ? items.filter(x => invNorm(x) !== n) : [...items, plainPromptTag(tag)]).join(', ');
                refreshInvalidateChips('pos');
                refreshCompInvalidateChips();
            }
        }));
    });
}

/** 🔀 조건 한 줄의 칩 갱신: 이 조각 프롬프트 태그들을 보여주고, "대신 지울 단어"에 든 건 꺼짐 표시,
 *  "조건 단어"와 (실제 규칙 판정과 같은 방식으로) 일치하는 건 🎯 표시. */
function refreshCondRuleChips(row) {
    const box = row && row.querySelector('.cond-rule-chips');
    if (!box) return;
    const whenEl = row.querySelector('.cond-rule-when');
    const remEl = row.querySelector('.cond-rule-remove');
    const norm = (typeof _condNorm === 'function') ? _condNorm : (s => String(s || '').toLowerCase().replace(/_/g, ' ').trim());
    const matches = (typeof _condKeywordMatchesTag === 'function') ? _condKeywordMatchesTag : ((t, k) => t === k);
    const seen = new Set();
    const tags = getPromptTagsFromText(document.getElementById('edit-prompt-value')?.value).filter(t => { const k = norm(t); if (!k || seen.has(k)) return false; seen.add(k); return true; });
    box.innerHTML = '';
    if (tags.length === 0) {
        box.innerHTML = '<span style="color:#666; font-size:0.8em;">(이 조각의 프롬프트가 비어있음 — 위 프롬프트 내용을 먼저 입력하면 여기에 태그가 보입니다)</span>';
        return;
    }
    const whenKws = getPromptTagsFromText(whenEl.value).map(norm).filter(Boolean);
    const remKws = getPromptTagsFromText(remEl.value).map(norm).filter(Boolean);
    tags.forEach(tag => {
        const n = norm(tag);
        box.appendChild(makeToggleChip(tag, {
            off: remKws.includes(n),
            picked: whenKws.some(k => matches(n, k)),
            title: '클릭: 위에서 고른 모드에 따라 "대신 지울 단어" 또는 "조건 단어"에 넣기/빼기',
            onClick: () => {
                const mode = document.querySelector('input[name="cond-chip-mode"]:checked')?.value || 'remove';
                const el = mode === 'when' ? whenEl : remEl;
                const items = getPromptTagsFromText(el.value);
                const has = items.some(x => norm(x) === n);
                const next = has ? items.filter(x => norm(x) !== n) : [...items, plainPromptTag(tag)];
                el.value = next.join(', ');
                refreshCondRuleChips(row);
            }
        }));
    });
}

function refreshAllCondRuleChips() {
    document.querySelectorAll('#edit-cond-rules-list .cond-rule-row').forEach(refreshCondRuleChips);
}

/* 🧱 카테고리 차단 UI: 카테고리 버튼(클릭=차단/해제) + 차단 미리보기 */
function getPromptCategoryNames() {
    return (typeof PROMPT_CATEGORY_COLORS !== 'undefined') ? Object.keys(PROMPT_CATEGORY_COLORS)
        : ['작가', '얼굴', '표정/감정', '신체/외형', '인물/캐릭터', '의상/패션', '행동/포즈', '구도/스타일', '배경/장소', '사물/아이템', '2차창작/메타', '성인용', '기타'];
}

function refreshCatBlockPreview() {
    const box = document.getElementById('edit-catblock-preview');
    const chipsBox = document.getElementById('edit-catblock-chips');
    if (!box || !chipsBox) return;
    const blocked = chipsBox._blocked || new Set();
    const src = [document.getElementById('base-pos')?.value, document.getElementById('action-pos')?.value, document.getElementById('edit-prompt-value')?.value]
        .filter(v => v && v.trim()).join(', ');
    const seen = new Set();
    const tags = getPromptTagsFromText(src).filter(t => { const k = plainPromptTag(t).toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
    box.innerHTML = '';
    if (tags.length === 0) { box.innerHTML = '<span style="color:#666; font-size:0.8em;">(미리볼 프롬프트가 비어있음)</span>'; return; }
    tags.forEach(tag => {
        // 🐛 버그 수정: "red shirt"(색상+의상/패션)처럼 다중 색상 배지로 두 카테고리 이상인 태그는
        // getCanonicalPromptCategory(단일 결과)만 보면 한쪽 카테고리를 차단해도 "차단 안 됨"으로
        // 잘못 표시됐었다(실제로 generate.js의 applyItemCategoryBlock도 이 태그를 못 걸렀음 — 같이 수정).
        // classifyPromptTagSegments로 모든 세그먼트를 보고, 그중 하나라도 차단 목록에 있으면 차단으로 표시.
        const segments = (typeof classifyPromptTagSegments === 'function')
            ? classifyPromptTagSegments(tag)
            : [{ name: (typeof getCanonicalPromptCategory === 'function') ? getCanonicalPromptCategory(tag) : '기타' }];
        const catNames = segments.map(s => (typeof getCanonicalPromptCategoryName === 'function') ? getCanonicalPromptCategoryName(s.name) : s.name);
        const matchedBlocked = catNames.find(n => blocked.has(n));
        const off = !!matchedBlocked;
        const label = catNames.join(' + ');
        box.appendChild(makeToggleChip(tag, { off, readonly: true, title: off ? `차단됨 (${matchedBlocked})` : label }));
    });
}

function renderCatBlockChips() {
    const box = document.getElementById('edit-catblock-chips');
    if (!box) return;
    const blocked = box._blocked || (box._blocked = new Set());
    box.innerHTML = '';
    getPromptCategoryNames().forEach(name => {
        const color = ((typeof PROMPT_CATEGORY_COLORS !== 'undefined') && PROMPT_CATEGORY_COLORS[name]) || '#999999';
        const off = blocked.has(name);
        const chip = document.createElement('span');
        let css = 'display:inline-block; padding:3px 10px; border-radius:6px; margin:2px 4px 2px 0; font-size:0.85em; cursor:pointer; user-select:none;';
        if (off) css += ' background:#33333388; color:#999; text-decoration:line-through; border:1px dashed #666;';
        else css += ` background:${color}26; color:${color}; border:1px solid ${color}55;`;
        chip.style.cssText = css;
        chip.textContent = (off ? '🧱 ' : '') + name;
        chip.title = off ? '차단 중 (클릭: 해제)' : '클릭: 이 조각에서 이 카테고리 차단';
        chip.addEventListener('mousedown', e => e.preventDefault());
        chip.addEventListener('click', () => {
            if (blocked.has(name)) blocked.delete(name); else blocked.add(name);
            renderCatBlockChips();
        });
        box.appendChild(chip);
    });
    refreshCatBlockPreview();
}

/** 🧱 편집 모달을 열 때, 저장돼있던 item.blockCategories 를 버튼 상태로 채운다 */
function renderItemCatBlockField(item) {
    const box = document.getElementById('edit-catblock-chips');
    if (!box) return;
    box._blocked = new Set((item && Array.isArray(item.blockCategories)) ? item.blockCategories : []);
    renderCatBlockChips();
}

/** 🔀 조건부 규칙 한 줄(UI)을 만든다. rule = { when, add, remove } */
function renderCondRuleRow(rule) {
    rule = rule || {};
    const inputCss = 'width:100%; box-sizing:border-box; padding:5px; background:#222; border:1px solid #555; color:#fff; border-radius:4px;';
    const row = document.createElement('div');
    row.className = 'cond-rule-row';
    row.style.cssText = 'border:1px dashed #444; border-radius:6px; padding:8px; display:flex; flex-direction:column; gap:5px;';
    row.innerHTML = `
        <div style="display:flex; gap:6px; align-items:center;">
            <span style="color:#aaa; font-size:0.85em; white-space:nowrap;">만약 있으면</span>
            <input type="text" class="cond-rule-when" placeholder="예: apple (콤마로 여러 개)" style="${inputCss}">
            <button type="button" class="cond-rule-del btn-secondary" title="이 조건 삭제" style="padding:2px 8px; flex-shrink:0;">✕</button>
        </div>
        <textarea class="cond-rule-add" rows="2" placeholder="→ 추가할 프롬프트 (예: red clothes)" style="${inputCss} resize:vertical;"></textarea>
        <input type="text" class="cond-rule-remove" placeholder="(선택) 대신 지울 단어 (예: white dress)" style="${inputCss}">
        <div class="cond-rule-chips" style="padding:5px 7px; background:#1a1a1a; border:1px solid #333; border-radius:6px; line-height:1.9;"></div>
    `;
    row.querySelector('.cond-rule-when').value = rule.when || '';
    row.querySelector('.cond-rule-add').value = rule.add || '';
    row.querySelector('.cond-rule-remove').value = rule.remove || '';
    row.querySelector('.cond-rule-del').onclick = () => row.remove();
    // 입력칸을 직접 고치면 칩 표시(꺼짐/조건 선택)도 같이 갱신
    row.querySelector('.cond-rule-when').addEventListener('input', () => refreshCondRuleChips(row));
    row.querySelector('.cond-rule-remove').addEventListener('input', () => refreshCondRuleChips(row));
    refreshCondRuleChips(row);
    return row;
}

/** 🔀 편집 모달을 열 때, 저장돼있던 item.condRules 를 규칙 줄들로 채운다 */
function renderItemCondRulesField(item) {
    const list = document.getElementById('edit-cond-rules-list');
    if (!list) return;
    list.innerHTML = '';
    ((item && item.condRules) || []).forEach(r => list.appendChild(renderCondRuleRow(r)));
}

/** 🆕 편집 모달을 열 때, 저장돼있던 item.posInvalidate / item.negInvalidate 값을 필드에 채운다 */
function renderItemInvalidateFields(item) {
    const pos = document.getElementById('edit-pos-invalidate-value');
    const neg = document.getElementById('edit-neg-invalidate-value');
    if (pos) pos.value = (item && item.posInvalidate) || '';
    if (neg) neg.value = (item && item.negInvalidate) || '';
    refreshInvalidateChips('pos');
    refreshInvalidateChips('neg');
    refreshCompInvalidateChips();
}

/** 🔗 편집 모달을 열 때, 저장돼있던 item.seedGroup 값을 필드에 채운다 */
function renderItemSeedGroupField(item) {
    const value = document.getElementById('edit-seedgroup-value');
    if (!value) return;
    value.value = item.seedGroup || '';
}

/** 🙈 편집 모달을 열 때, 저장돼있던 item.backViewFaceWeightDown 값을 체크박스에 채운다 */
function renderItemBackViewField(item) {
    const enabled = document.getElementById('edit-backview-enabled');
    if (!enabled) return;
    enabled.checked = !!item.backViewFaceWeightDown;
}

/** "이 조각 전용 로라" 한 줄(select+가중치+삭제)을 만들어 반환 */
function renderItemLoraRow(entry) {
    const row = document.createElement('div');
    row.className = 'lora-item';
    row.style.cssText = 'display:flex; align-items:center; gap:6px;';
    row.innerHTML = `<select style="flex:1;">${window.loraOptionsHTML || ''}</select>
        <input type="number" step="0.01" value="${entry.strength}" style="width:70px;">
        <button type="button" class="btn-secondary" style="padding:2px 8px;">X</button>`;
    row.querySelector('select').value = entry.lora;
    row.querySelector('button').onclick = () => row.remove();
    return row;
}

/** 편집 모달의 로라 행들을 지금 item.loraOverride 값으로 다시 그린다 */
function renderItemLoraRows(item) {
    const container = document.getElementById('edit-prompt-loras');
    if (!container) return;
    container.innerHTML = '';
    (item.loraOverride || []).forEach(entry => container.appendChild(renderItemLoraRow(entry)));
}

/** 조각의 ID, 이름, 프롬프트, 의존성(requires)을 수정하는 모달을 연다 */
/** 대기열 항목(✏️ 클릭 등)에서 이 모달을 열었을 때 그 특정 대기열 job/조각 정보를 담아둔다.
 *  {jobIndex, fragIndex} 또는 null. 모달을 열 때마다 매번 새로 세팅되므로(기본값 null) 이전 값이
 *  다음 모달 오픈에 잘못 남는 일은 없다. cycleVariantInModal에서 "이 모달이 대기열에서 열렸으면
 *  버전 전환 시 그 대기열 항목도 즉시 따라가게" 하는 데 사용됨. */
let activeQueueSyncTarget = null;

/** 🆕 조각 1개짜리 대기열 항목의 편집 모달(prompt-edit-modal)이 열려있을 때, 이전/다음
 *  대기열 항목으로 바로 이동한다. 지금 편집 내용은 먼저 저장(savePromptEditModal)한 뒤,
 *  다음 항목이 조각 1개짜리면 그 조각의 편집 모달을, 여러 개 조합이면 대기열 전용 편집
 *  모달(openJobEditModal)을 연다 — handleQueueItemBodyClick과 같은 분기 기준을 그대로 재사용.
 *  ⌨️ 단축키 도움말의 queuePrevItem/queueNextItem(기본 Alt+↑/Alt+↓)에서 호출됨. */
function navigateQueueEditorFromPromptModal(direction) {
    if (!activeQueueSyncTarget || typeof jobQueue === 'undefined') return;
    const currentIndex = activeQueueSyncTarget.jobIndex;

    let target = currentIndex + direction;
    while (target >= 0 && target < jobQueue.length && jobQueue[target].disabled) {
        target += direction;
    }
    if (target < 0 || target >= jobQueue.length) return; // 맨 앞/맨 뒤 — 더 이동할 곳 없음

    if (typeof savePromptEditModal === 'function') savePromptEditModal(); // 저장 + 모달 닫기

    if (typeof handleQueueItemBodyClick === 'function') {
        handleQueueItemBodyClick(target);
    }
}
window.navigateQueueEditorFromPromptModal = navigateQueueEditorFromPromptModal;

/** 🆕 prompt-edit-modal 헤더에 "◀ ▶" 버튼을 한 번만 만들어 끼워넣는다 (닫기 버튼 바로 왼쪽).
 *  대기열에서 열렸을 때만 보이도록 openPromptEditModal에서 매번 display를 토글한다. */
function ensureQueueNavButtonsInPromptModal() {
    if (document.getElementById('prompt-edit-queue-nav')) return;
    const header = document.querySelector('#prompt-edit-modal .modal-header');
    if (!header) return;
    const nav = document.createElement('span');
    nav.id = 'prompt-edit-queue-nav';
    nav.style.cssText = 'display:none; gap:2px; margin-left:auto; margin-right:10px;';
    nav.innerHTML = `
        <button type="button" onclick="navigateQueueEditorFromPromptModal(-1)" title="이전 대기열 항목 (단축키는 ⌨️ 단축키 도움말 참고, 기본 Alt+↑)"
            style="font-size:0.85em; padding:3px 8px; background:#333; border:1px solid #FF9800; color:#FF9800; border-radius:4px 0 0 4px; cursor:pointer;">◀</button>
        <button type="button" onclick="navigateQueueEditorFromPromptModal(1)" title="다음 대기열 항목 (단축키는 ⌨️ 단축키 도움말 참고, 기본 Alt+↓)"
            style="font-size:0.85em; padding:3px 8px; background:#333; border:1px solid #FF9800; color:#FF9800; border-radius:0 4px 4px 0; cursor:pointer;">▶</button>
    `;
    const closeBtn = header.querySelector('.close-btn');
    if (closeBtn) header.insertBefore(nav, closeBtn); else header.appendChild(nav);
}

function openPromptEditModal(itemId, queueSyncTarget = null) {
    activeQueueSyncTarget = queueSyncTarget;
    ensureQueueNavButtonsInPromptModal();
    const navBtns = document.getElementById('prompt-edit-queue-nav');
    if (navBtns) navBtns.style.display = queueSyncTarget ? 'inline-flex' : 'none';
    const category = getActiveCategory();
    if (!category) return;
    const item = category.items.find(i => i.id === itemId);
    if (!item) return;

    document.getElementById('edit-prompt-original-id').value = item.id;
    document.getElementById('edit-prompt-name').value = item.name || '';
    document.getElementById('edit-prompt-id').value = item.id || '';
    document.getElementById('edit-prompt-value').value = item.prompt || '';
    const requiresStr = (item.requires && Array.isArray(item.requires)) ? item.requires.join(', ') : '';
    document.getElementById('edit-prompt-requires').value = requiresStr;
    ensureCustomNumberField();
    document.getElementById('edit-prompt-customnum').value = (item.customNumber !== undefined && item.customNumber !== null) ? item.customNumber : '';
    ensureItemRepeatField();
    document.getElementById('edit-prompt-repeatcount').value = (item.defaultRepeatCount !== undefined && item.defaultRepeatCount !== null) ? item.defaultRepeatCount : '';
    ensureItemLoraField();
    renderItemLoraRows(item);
    ensureItemPipelineFields();
    renderItemPipelineFields(item);
    renderItemCensorFields(item);
    renderItemNegativeField(item);
    renderItemInvalidateFields(item);
    renderItemCondRulesField(item);
    renderItemCatBlockField(item);
    renderItemSeedGroupField(item);
    renderItemBackViewField(item);
    syncAllFieldCollapseStates(item);
    renderVariantNote(item);
    document.getElementById('prompt-edit-modal').style.display = 'flex';

    // 모달이 열리면 프롬프트 입력창에 바로 포커스 + 전체 선택
    // (포커스가 없으면 Ctrl+A가 페이지 전체를 선택해버림)
    const valueField = document.getElementById('edit-prompt-value');
    requestAnimationFrame(() => {
        valueField.focus();
        valueField.select();
    });
}

/** 조각 편집 모달 닫기 — X/취소/배경클릭 모두 저장 버튼과 동일하게 처리 */
function closePromptEditModal() {
    const newId = document.getElementById('edit-prompt-id')?.value.trim();
    if (newId) {
        savePromptEditModal();
    } else {
        document.getElementById('prompt-edit-modal').style.display = 'none';
    }
}

/** 조각 편집 모달에서 입력된 값을 데이터에 반영 */
function savePromptEditModal() {
    const category = getActiveCategory();
    if (!category) return;
    const oldId = document.getElementById('edit-prompt-original-id').value;
    const item = category.items.find(i => i.id === oldId);
    if (!item) return;

    const newId = document.getElementById('edit-prompt-id').value.trim();
    if (!newId) { alert("ID는 비어둘 수 없습니다."); return; }
    if (newId !== oldId && category.items.some(i => i.id === newId)) {
        alert("동일한 그룹 내에 중복된 ID가 존재합니다."); return;
    }

    item.id = newId;
    item.name = document.getElementById('edit-prompt-name').value.trim();
    item.prompt = document.getElementById('edit-prompt-value').value;
    if (item.variants && item.variants[item.activeVariant || 0]) {
        item.variants[item.activeVariant || 0].prompt = item.prompt;
    }

    const reqStr = document.getElementById('edit-prompt-requires').value;
    const reqArray = reqStr.split(',').map(s => s.trim()).filter(s => s.length > 0);
    if (reqArray.length > 0) { item.requires = reqArray; } else { delete item.requires; }

    const customNumEl = document.getElementById('edit-prompt-customnum');
    if (customNumEl && customNumEl.value.trim() !== '') {
        const n = parseInt(customNumEl.value.trim(), 10);
        if (!isNaN(n)) item.customNumber = n; else delete item.customNumber;
    } else {
        delete item.customNumber;
    }

    // 🆕 이 조각 기본 반복 횟수 — 타율 낮은 조각을 대기열에 넣을 때 자동으로 이 횟수만큼 반복되게 함
    const repeatCountEl = document.getElementById('edit-prompt-repeatcount');
    if (repeatCountEl && repeatCountEl.value.trim() !== '') {
        const n = parseInt(repeatCountEl.value.trim(), 10);
        if (!isNaN(n) && n >= 1) item.defaultRepeatCount = n; else delete item.defaultRepeatCount;
    } else {
        delete item.defaultRepeatCount;
    }

    const loraRows = Array.from(document.querySelectorAll('#edit-prompt-loras .lora-item'));
    const loraList = loraRows.map(row => ({
        lora: row.querySelector('select').value,
        strength: parseFloat(row.querySelector('input[type="number"]').value) || 1
    })).filter(e => e.lora);
    if (loraList.length > 0) item.loraOverride = loraList; else delete item.loraOverride;

    const img2imgEnabled = document.getElementById('edit-img2img-enabled')?.checked;
    const img2imgName = window._editModalImg2ImgUploaded || null;
    if (img2imgEnabled && img2imgName) {
        item.img2imgOverride = {
            enabled: true,
            imageName: img2imgName,
            denoise: parseFloat(document.getElementById('edit-img2img-denoise')?.value || '0.65')
        };
    } else {
        delete item.img2imgOverride;
    }

    const controlnetEnabled = document.getElementById('edit-controlnet-enabled')?.checked;
    const controlnetName = window._editModalControlnetUploaded || null;
    if (controlnetEnabled && controlnetName) {
        item.controlnetOverride = {
            enabled: true,
            imageName: controlnetName,
            preprocessor: document.getElementById('edit-controlnet-preprocessor')?.value || 'CannyEdgePreprocessor',
            model: document.getElementById('edit-controlnet-model')?.value || '',
            strength: parseFloat(document.getElementById('edit-controlnet-strength')?.value || '1.0'),
            start: parseFloat(document.getElementById('edit-controlnet-start')?.value || '0.0'),
            end: parseFloat(document.getElementById('edit-controlnet-end')?.value || '1.0')
        };
    } else {
        delete item.controlnetOverride;
    }

    const censorEnabled = document.getElementById('edit-censor-enabled')?.checked;
    const censorLabels = Array.from(document.querySelectorAll('#edit-censor-labels input[data-censor-label]'))
        .filter(cb => cb.checked).map(cb => cb.dataset.censorLabel);
    if (censorEnabled && censorLabels.length > 0) {
        item.censorOverride = {
            enabled: true,
            labels: censorLabels,
            mode: document.getElementById('edit-censor-mode')?.value || 'mosaic',
            intensity: parseInt(document.getElementById('edit-censor-intensity')?.value || '15', 10)
        };
    } else {
        delete item.censorOverride;
    }

    // 🆕 이 조각 전용 부정프롬프트
    const negativeEnabled = document.getElementById('edit-negative-enabled')?.checked;
    const negativeText = (document.getElementById('edit-negative-value')?.value || '').trim();
    if (negativeEnabled && negativeText) {
        item.negativeOverride = negativeText;
    } else {
        delete item.negativeOverride;
    }

    // 🆕 이 조각 전용 키워드 무효화 (긍정/부정 각각)
    const posInvalidateText = (document.getElementById('edit-pos-invalidate-value')?.value || '').trim();
    if (posInvalidateText) { item.posInvalidate = posInvalidateText; } else { delete item.posInvalidate; }
    const negInvalidateText = (document.getElementById('edit-neg-invalidate-value')?.value || '').trim();
    if (negInvalidateText) { item.negInvalidate = negInvalidateText; } else { delete item.negInvalidate; }

    // 🔀 이 조각 전용 조건부 프롬프트 변화 (조건 단어가 있고, 추가/삭제 중 하나라도 있는 줄만 저장)
    const condRulesSaved = Array.from(document.querySelectorAll('#edit-cond-rules-list .cond-rule-row')).map(row => ({
        when: (row.querySelector('.cond-rule-when')?.value || '').trim(),
        add: (row.querySelector('.cond-rule-add')?.value || '').trim(),
        remove: (row.querySelector('.cond-rule-remove')?.value || '').trim()
    })).filter(r => r.when && (r.add || r.remove));
    if (condRulesSaved.length > 0) { item.condRules = condRulesSaved; } else { delete item.condRules; }

    // 🧱 이 조각 전용 카테고리 차단
    const catBlockSet = document.getElementById('edit-catblock-chips')?._blocked;
    if (catBlockSet && catBlockSet.size > 0) { item.blockCategories = Array.from(catBlockSet); } else { delete item.blockCategories; }

    // 🔗 시드 동일화 그룹명
    const seedGroupText = (document.getElementById('edit-seedgroup-value')?.value || '').trim();
    if (seedGroupText) {
        item.seedGroup = seedGroupText;
    } else {
        delete item.seedGroup;
    }

    // 🙈 후방뷰: 얼굴 가중치 하락
    item.backViewFaceWeightDown = !!document.getElementById('edit-backview-enabled')?.checked;

    if (selectedSet[activeCategoryId] === oldId) selectedSet[activeCategoryId] = newId;

    if (typeof syncQueueJobsWithItem === 'function') syncQueueJobsWithItem(activeCategoryId, oldId, item);

    // 직접 닫기 (closePromptEditModal 호출 시 무한루프 방지)
    document.getElementById('prompt-edit-modal').style.display = 'none';
    renderItems();
    renderBuilder();
    debounceLibrarySave();
}

/** 📷 카메라 구도 팝업의 "조각으로 만들기"가 호출: 현재 작품에 "📷 구도" 그룹(없으면 만듦)을 두고 그 안에 조각을 추가한다.
 *  반환: { ok, categoryName, categoryId, itemId } 또는 { ok:false, error } */
function createCompositionPiece(name, prompt) {
    const work = getActiveWork() || (libraryData.works && libraryData.works[0]);
    if (!work) return { ok: false, error: '먼저 프롬프트 라이브러리에서 작품을 만들거나 선택해 주세요.' };
    const GROUP_NAME = '📷 구도';
    let category = work.categories.find(c => c.name === GROUP_NAME);
    if (!category) {
        let catId = 'cat_' + Date.now();
        while (getAllCategories().some(c => c.id === catId)) catId += '_';
        category = { id: catId, name: GROUP_NAME, items: [] };
        work.categories.push(category);
    }
    let itemId = 'item_' + Date.now();
    while (getAllCategories().some(c => c.items.some(it => it.id === itemId))) itemId += '_';
    category.items.push({ id: itemId, name: String(name || '구도'), prompt: String(prompt || '') });
    if (typeof renderWorkTree === 'function') { try { renderWorkTree(); } catch (e) { /* 화면 갱신 실패가 저장을 막으면 안 됨 */ } }
    if (typeof renderItems === 'function') { try { renderItems(); } catch (e) { /* 위와 같음 */ } }
    debounceLibrarySave();
    // 📷 방금 만든 조각을 다른 조각처럼 바로 대기열에 넣는다 (sendSingleItemToQueue와 같은 경로)
    if (typeof sendSingleItemToQueue === 'function') { try { sendSingleItemToQueue(category.id, itemId); } catch (e) { /* 대기열 추가 실패가 조각 생성 자체를 막으면 안 됨 */ } }
    return { ok: true, categoryName: GROUP_NAME, categoryId: category.id, itemId };
}
window.createCompositionPiece = createCompositionPiece;

/** 🆕 기능 확장: "이 이미지 설정을 조각으로 저장" — 갤러리 이미지에 박힌 메타데이터(프롬프트+로라)를
 *  createCompositionPiece()와 완전히 같은 패턴으로 조각화한다. 체크포인트는 조각 단위로 저장되는
 *  개념 자체가 이 라이브러리 시스템에 없어서(체크포인트는 생성 탭에서 전역으로 고르는 값) 넘기지 않음 —
 *  대신 로라는 item.loraOverride(이 조각 전용 로라, getItemLoraOverride()가 읽는 바로 그 필드)로 들어감.
 *  반환: { ok, categoryName, categoryId, itemId } 또는 { ok:false, error } — createCompositionPiece와 동일 규약.
 */
function createGalleryImagePiece(name, prompt, loraOverride) {
    const work = getActiveWork() || (libraryData.works && libraryData.works[0]);
    if (!work) return { ok: false, error: '먼저 프롬프트 라이브러리에서 작품을 만들거나 선택해 주세요.' };
    const GROUP_NAME = '🖼 갤러리에서 저장';
    let category = work.categories.find(c => c.name === GROUP_NAME);
    if (!category) {
        let catId = 'cat_' + Date.now();
        while (getAllCategories().some(c => c.id === catId)) catId += '_';
        category = { id: catId, name: GROUP_NAME, items: [] };
        work.categories.push(category);
    }
    let itemId = 'item_' + Date.now();
    while (getAllCategories().some(c => c.items.some(it => it.id === itemId))) itemId += '_';
    const newItem = { id: itemId, name: String(name || '갤러리 저장'), prompt: String(prompt || '') };
    if (Array.isArray(loraOverride) && loraOverride.length > 0) newItem.loraOverride = loraOverride;
    category.items.push(newItem);
    if (typeof renderWorkTree === 'function') { try { renderWorkTree(); } catch (e) { /* 화면 갱신 실패가 저장을 막으면 안 됨 */ } }
    if (typeof renderItems === 'function') { try { renderItems(); } catch (e) { /* 위와 같음 */ } }
    debounceLibrarySave();
    if (typeof sendSingleItemToQueue === 'function') { try { sendSingleItemToQueue(category.id, itemId); } catch (e) { /* 대기열 추가 실패가 조각 생성 자체를 막으면 안 됨 */ } }
    return { ok: true, categoryName: GROUP_NAME, categoryId: category.id, itemId };
}
window.createGalleryImagePiece = createGalleryImagePiece;

/** 새 조각을 추가하고 편집 모달을 바로 연다 */
function addItem() {
    const category = getActiveCategory();
    if (!category) return;
    const newItemId = 'item_' + Date.now();
    category.items.push({ id: newItemId, name: "새 조각", prompt: "" });
    renderItems();
    openPromptEditModal(newItemId);
    // 🆕 새 조각을 만들면 대기열에도 자동으로 추가한다. 지금은 프롬프트가 비어있지만
    // sourceRefs로 이 조각 자체를 참조해서 넣어두기 때문에, 이후 편집 모달에서 저장하면
    // syncQueueJobsWithItem이 알아서 이 대기열 항목의 텍스트도 같이 채워준다.
    if (typeof sendSingleItemToQueue === 'function') sendSingleItemToQueue(category.id, newItemId);
    debounceLibrarySave();
}

/* ──────────────────────────────────────────────
   조각 비교 모아보기 (같은 그룹의 여러 버전을 나란히 비교)
   ────────────────────────────────────────────── */

/** "조각 목록" 헤더에 비교(🔍) 버튼이 없으면 만들어서 일괄수정 버튼 옆에 끼워넣는다 */
function ensureCompareButton() {
    if (document.getElementById('btn-compare-items')) return;
    const addBtn = document.getElementById('btn-add-item');
    if (!addBtn || !addBtn.parentElement) return;
    const btn = document.createElement('button');
    btn.id = 'btn-compare-items';
    btn.className = 'btn-secondary';
    btn.title = '여러 조각(버전)을 나란히 비교해서 하나 고르기';
    btn.style.cssText = 'display:none; padding:4px 10px; font-size:0.9em; margin-right:6px;';
    btn.textContent = '🔍 비교';
    btn.onclick = toggleCompareMode;
    addBtn.parentElement.insertBefore(btn, addBtn);
}

/** "조각 목록" 헤더에 자동 병합(🧩) 버튼이 없으면 만들어서 끼워넣는다 */
/** "조각 목록" 헤더에 "⋯ 도구" 버튼 + 드롭다운 메뉴를 없으면 만든다.
 *  덜 자주 쓰는 도구들(자동 병합/버전 일괄 설정/빈 번호 채우기/이미지 검수)을
 *  여기 하나로 모아서 헤더가 버튼으로 지저분해지지 않게 함. */
function ensureToolsMenu() {
    if (document.getElementById('btn-tools-menu')) return;
    const addBtn = document.getElementById('btn-add-item');
    if (!addBtn || !addBtn.parentElement) return;

    const wrap = document.createElement('span');
    wrap.style.cssText = 'position:relative; display:inline-block; margin-right:6px;';

    const btn = document.createElement('button');
    btn.id = 'btn-tools-menu';
    btn.className = 'btn-secondary';
    btn.title = '자동 병합 / 버전 일괄 설정 / 빈 번호 채우기 / 이미지 검수';
    btn.style.cssText = 'display:none; padding:4px 10px; font-size:0.9em;';
    btn.textContent = '⋯ 도구';

    const panel = document.createElement('div');
    panel.id = 'tools-menu-panel';
    panel.style.cssText = `
        display:none; position:absolute; top:100%; left:0; margin-top:4px; z-index:500;
        background:#1c1c1c; border:1px solid #555; border-radius:8px; min-width:220px;
        box-shadow:0 6px 18px rgba(0,0,0,0.5); overflow:hidden;`;

    btn.onclick = (e) => {
        e.stopPropagation();
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    };
    document.addEventListener('click', () => { panel.style.display = 'none'; });
    panel.onclick = (e) => e.stopPropagation();

    wrap.appendChild(btn);
    wrap.appendChild(panel);
    addBtn.parentElement.insertBefore(wrap, addBtn);
}

/** 도구 메뉴 안에 넣을 버튼 하나를 표준 스타일로 만들어 붙여준다 */
function addToolsMenuItem(id, icon, label, title, onClick) {
    const panel = document.getElementById('tools-menu-panel');
    if (!panel || document.getElementById(id)) return;
    const item = document.createElement('button');
    item.id = id;
    item.title = title;
    item.style.cssText = `
        display:block; width:100%; text-align:left; padding:9px 12px; font-size:0.88em;
        background:none; border:none; border-bottom:1px solid #2a2a2a; color:#ddd; cursor:pointer;`;
    item.onmouseenter = () => { item.style.background = '#2a2a2a'; };
    item.onmouseleave = () => { item.style.background = 'none'; };
    item.textContent = `${icon} ${label}`;
    item.onclick = () => { document.getElementById('tools-menu-panel').style.display = 'none'; onClick(); };
    panel.appendChild(item);
}

function ensureAutoMergeButton() {
    ensureToolsMenu();
    addToolsMenuItem(
        'btn-auto-merge', '🧩', '이름별 자동 병합',
        '이름이 같고 뒤에 숫자만 다른 조각들(예: 사과1, 사과2, 사과3)을 한번에 찾아서 자동으로 병합',
        autoMergeByName
    );
}

/** "조각 목록" 헤더에 그룹 전체 버전 일괄 설정(🔢) 버튼이 없으면 만들어서 끼워넣는다 */
function ensureBulkVersionButton() {
    ensureToolsMenu();
    addToolsMenuItem(
        'btn-bulk-version', '🔢', '버전 일괄 설정',
        '이 그룹 안의 병합된(여러 버전) 조각들을 한번에 지정한 번호의 버전으로 맞춘다',
        bulkSetGroupVersion
    );
}

/** 조각 목록 위에 검색/필터 입력창이 없으면 만들어서 끼워넣는다 (스크롤 없이 이름/내용으로 바로 찾기) */
function ensureItemSearchBox() {
    if (document.getElementById('item-search-box')) return;
    const list = document.getElementById('item-list');
    if (!list || !list.parentElement) return;

    const box = document.createElement('input');
    box.id = 'item-search-box';
    box.type = 'text';
    box.placeholder = '🔍 조각 이름/내용 검색... ( / 키로 바로 포커스, Esc로 지우기)';
    box.style.cssText = 'display:none; width:100%; box-sizing:border-box; padding:7px 10px; margin-bottom:8px; background:#1c1c1c; border:1px solid #555; color:#fff; border-radius:6px; font-size:0.9em;';
    box.oninput = () => { itemSearchQuery = box.value; renderItems(); };
    box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { box.value = ''; itemSearchQuery = ''; renderItems(); box.blur(); }
    });
    list.parentElement.insertBefore(box, list);
}

/* ──────────────────────────────────────────────
   🕳 빈 번호 채우기: 폴더의 파일 번호(1,2,3,6...)를 검사해서
   빠진 번호(4,5)를 찾고, 선택한 그룹의 그 순번 조각들을 자동으로 대기열에 넣는다.
   ────────────────────────────────────────────── */

/** 도구 메뉴에 "🕳 빈 번호 채우기" 항목이 없으면 추가한다 */
function ensureMissingFillButton() {
    ensureToolsMenu();
    addToolsMenuItem(
        'btn-missing-fill', '🕳', '빈 번호 채우기',
        '출력 폴더에서 빠진 번호(예: 1,2,3,6 → 4,5 빠짐)를 찾아, 선택한 그룹의 그 순번 조각들을 자동으로 대기열에 추가',
        openMissingFillModal
    );
}

/* ──────────────────────────────────────────────
   🏷 번호에 설명 붙이기: 1.png, 2.png... 처럼 번호 매겨진 이미지들을
   순서대로 라벨(표정 이름 등)과 매칭해서 "{접두어}{라벨}{확장자}"로 복사.
   ────────────────────────────────────────────── */

/**
 * 🎲 랜덤 로라: 로라 목록 중에서 2~5개를 무작위로 골라서,
 * 각각 0.2~1.0 사이 랜덤 가중치로 "선택된 로라" 목록에 추가한다.
 * (기존 addLoraRow와 동일한 행 구조를 그대로 사용해서 서로 호환됨)
 */
/**
 * 🎲 랜덤 로라: 로라 목록 중에서(제외 목록 제외) 2~5개를 무작위로 골라서,
 * 각각 0.2~1.0 사이 랜덤 가중치(소수점 1자리)로 "선택된 로라" 목록에 넣는다.
 * 누를 때마다 기존에 있던 로라는 전부 지우고 새로 뽑는다.
 */
/** 로라 파일명(경로/확장자 제거)을 프롬프트에 넣을 태그 이름으로 변환 */
function loraFilenameToPromptTag(value) {
    if (!value) return '';
    const base = value.split(/[\\/]/).pop(); // 폴더 경로 제거
    return base.replace(/\.(safetensors|pt|ckpt|pth)$/i, ''); // 확장자 제거
}

function addRandomLoras() {
    if (!window.loraOptionsHTML) {
        alert('로라 목록이 아직 로딩되지 않았습니다. 잠시 후 다시 시도해 주세요.');
        return;
    }

    // window.loraOptionsHTML은 <option>...</option> 문자열이라, 임시 select에 넣어서 옵션들을 뽑아낸다
    const tempSelect = document.createElement('select');
    tempSelect.innerHTML = window.loraOptionsHTML;
    const excluded = getRandomLoraExcludeSet();
    const options = Array.from(tempSelect.options).filter(o => o.value && !excluded.has(o.value)); // 빈 값 + 제외 목록 제외

    if (options.length === 0) {
        alert('선택 가능한 로라가 없습니다. (제외 목록에 너무 많이 들어있을 수 있어요)');
        return;
    }

    const count = Math.min(options.length, Math.floor(Math.random() * 4) + 2); // 2~5개 (로라가 부족하면 있는 만큼만)
    const shuffled = [...options].sort(() => Math.random() - 0.5); // 서로 겹치지 않게 셔플 후 앞에서부터 자름
    const picked = shuffled.slice(0, count);

    // 누를 때마다 기존 로라는 다 지우고 새로 채운다
    const container = document.getElementById('selected-loras');
    container.innerHTML = '';

    // ── 프롬프트에 이전에 자동으로 넣어뒀던 로라 이름들을 먼저 지운다 (누적 방지) ──
    const posEl = document.getElementById('base-pos');
    let prevTags = [];
    try { prevTags = JSON.parse(container.dataset.autoTags || '[]'); } catch (e) { prevTags = []; }
    if (posEl && prevTags.length > 0) {
        let text = posEl.value;
        prevTags.forEach(tag => {
            if (!tag) return;
            // "태그, " 또는 ", 태그" 형태로 들어가 있을 걸 감안해서 콤마까지 같이 지움
            text = text.replace(new RegExp(`\\s*,?\\s*${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,?`, 'g'), ', ');
        });
        text = text.replace(/^\s*,\s*/, '').replace(/,\s*,/g, ',').replace(/,\s*$/, '').trim();
        posEl.value = text;
    }

    const newTags = [];
    picked.forEach(opt => {
        const row = document.createElement('div');
        row.className = 'lora-item';
        const weight = (Math.random() * (1 - 0.2) + 0.2).toFixed(1); // 0.2 ~ 1.0, 소수점 1자리
        const tag = `@${loraFilenameToPromptTag(opt.value)}`;
        row.dataset.autoTag = tag; // 이 로라 행이 프롬프트에 넣어둔 태그 — X로 지울 때 같이 지우기 위해 기억
        row.innerHTML = `<select style="flex: 1; margin-right: 10px;">${window.loraOptionsHTML || ''}</select>
            <label style="margin-bottom: 0; font-weight: normal;">가중치:</label><input type="number" step="0.01" value="${weight}" style="width: 70px; margin-left: 5px;"><button class="btn-secondary" style="margin-left: 10px;" onclick="removeRandomLoraRow(this)">X</button>`;
        row.querySelector('select').value = opt.value;
        container.appendChild(row);
        newTags.push(tag);
    });

    // ── 새로 뽑은 로라 이름들을 "@로라이름" 형식으로 프롬프트에 자동으로 추가 ──
    if (posEl && newTags.length > 0) {
        const cleanTags = newTags.filter(Boolean);
        posEl.value = posEl.value.trim()
            ? `${posEl.value.trim()}, ${cleanTags.join(', ')}`
            : cleanTags.join(', ');
    }
    container.dataset.autoTags = JSON.stringify(newTags); // 다음에 또 누를 때 이번 것들을 지우기 위해 기억해둠

    persistLoraChange();
}
window.addRandomLoras = addRandomLoras;

/** 프롬프트 텍스트에서 특정 "@태그" 하나를 안전하게 제거 (콤마 정리까지) */
function removePromptTag(text, tag) {
    if (!tag) return text;
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let result = text.replace(new RegExp(`\\s*,?\\s*${escaped}\\s*,?`, 'g'), ', ');
    result = result.replace(/^\s*,\s*/, '').replace(/,\s*,/g, ',').replace(/,\s*$/, '').trim();
    return result;
}

/** 🎲 랜덤 로라로 뽑힌 행의 X 버튼: 행 삭제 + 그 로라가 프롬프트에 넣어뒀던 "@태그"도 같이 제거 */
function removeRandomLoraRow(btn) {
    const row = btn.closest('.lora-item');
    if (!row) return;
    const tag = row.dataset.autoTag;
    const container = document.getElementById('selected-loras');

    if (tag) {
        const posEl = document.getElementById('base-pos');
        if (posEl) posEl.value = removePromptTag(posEl.value, tag);

        // 기억해둔 autoTags 목록에서도 이 태그를 빼서, 다음에 🎲를 다시 눌러도 유령 태그가 안 지워지는 일 없게 함
        if (container) {
            try {
                let tags = JSON.parse(container.dataset.autoTags || '[]');
                tags = tags.filter(t => t !== tag);
                container.dataset.autoTags = JSON.stringify(tags);
            } catch (e) { /* 무시 */ }
        }
    }

    row.remove();
    persistLoraChange();
}
window.removeRandomLoraRow = removeRandomLoraRow;

/* ──────────────────────────────────────────────
   🚫 랜덤 로라 제외 목록 (페이스 디테일러 같은, 랜덤으로 뽑히면 안 되는 로라들)
   ────────────────────────────────────────────── */

function getRandomLoraExcludeSet() {
    try { return new Set(JSON.parse(localStorage.getItem('randomLoraExcludeList') || '[]')); }
    catch (e) { return new Set(); }
}
function saveRandomLoraExcludeSet(set) {
    localStorage.setItem('randomLoraExcludeList', JSON.stringify([...set]));
}

function openRandomLoraExcludeModal() {
    if (!document.getElementById('random-lora-exclude-modal')) {
        const modal = document.createElement('div');
        modal.id = 'random-lora-exclude-modal';
        modal.className = 'modal-overlay';
        modal.style.cssText = 'display:none;';
        modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
        document.body.appendChild(modal);
    }
    if (!window.loraOptionsHTML) {
        alert('로라 목록이 아직 로딩되지 않았습니다. 잠시 후 다시 시도해 주세요.');
        return;
    }

    const tempSelect = document.createElement('select');
    tempSelect.innerHTML = window.loraOptionsHTML;
    const options = Array.from(tempSelect.options).filter(o => o.value);
    const excluded = getRandomLoraExcludeSet();

    const modal = document.getElementById('random-lora-exclude-modal');
    modal.innerHTML = `
        <div class="modal-content" onclick="event.stopPropagation()" style="width:min(90vw, 480px);">
            <div class="modal-header">
                <h3 style="margin:0; color:#CE93D8;">🚫 랜덤 로라 제외 목록</h3>
                <span class="close-btn" style="position:static; font-size:1.5em; color:#ff5555;" onclick="document.getElementById('random-lora-exclude-modal').style.display='none';">&times;</span>
            </div>
            <div class="modal-body">
                <p style="font-size:0.82em; color:#aaa; margin:0 0 8px;">체크한 로라는 🎲 랜덤 로라 뽑을 때 절대 안 뽑혀요. (페이스 디테일러처럼 항상 켜져있어야 하는 로라 등)</p>
                <div style="max-height:320px; overflow-y:auto; display:flex; flex-direction:column; gap:4px;">
                    ${options.map(opt => `
                        <label style="display:flex; align-items:center; gap:8px; font-size:0.85em; color:#ddd; cursor:pointer; padding:3px 0;">
                            <input type="checkbox" data-lora-value="${escapeHtml(opt.value)}" ${excluded.has(opt.value) ? 'checked' : ''} onchange="toggleRandomLoraExclude('${escapeHtml(opt.value).replace(/'/g, "\\'")}' , this.checked)">
                            <span>${escapeHtml(opt.textContent)}</span>
                        </label>
                    `).join('')}
                </div>
            </div>
        </div>`;
    modal.style.display = 'flex';
}
window.openRandomLoraExcludeModal = openRandomLoraExcludeModal;

/* ──────────────────────────────────────────────
   📋 이 도구가 쓰는 프롬프트 입력칸 목록 (여러 기능이 공통으로 참조)
   ────────────────────────────────────────────── */
// ⚠️⚠️⚠️ 새 프롬프트 입력칸(textarea/input)을 추가할 때마다 반드시 이 목록에도 같이 추가할 것! ⚠️⚠️⚠️
// 안 빼먹으려면: 새 칸이 "프롬프트 글을 적는 칸"이면 거의 항상 여기 + 위의 ARTIST_AUTOCOMPLETE_TARGET_SELECTOR
// 둘 다에 추가해야 함(가중치 추가/콤마구간 지우기 단축키 + artist: 자동완성). 실제로 NAI 기능 추가할 때
// 이걸 빼먹어서 그 칸들만 단축키/자동완성이 안 먹는 버그가 났었음(아래 nai-* 항목들로 한 번에 수정).
const PROMPT_TEXT_FIELD_SELECTORS =
    '#base-pos, #base-neg, #action-pos, #edit-prompt-value, #edit-negative-value, ' +
    '#edit-pos-invalidate-value, #edit-neg-invalidate-value, ' +
    '.job-edit-frag, #regen-pos, #regen-neg, ' +
    '.nai-character-positive-textarea, .nai-character-negative-textarea, ' +
    '.cond-rule-add, ' +
    '#nai-text-render-input, #nai-director-prompt';

/* ──────────────────────────────────────────────
   🎛️ 커스텀 단축키 시스템 — 키보드 기반 단축키(한→영 변환, 콤마 앞 가중치 추가)는
   ⌨️ 단축키 도움말 모달에서 사용자가 직접 다른 키 조합으로 바꿀 수 있다.
   (마우스 조합 단축키인 Ctrl+클릭/Shift+Ctrl+클릭/좌클릭+휠 등은 코드 여러 곳에 흩어져 있어
   지금은 고정. 필요하면 나중에 같은 방식으로 확장 가능)
   ────────────────────────────────────────────── */
const CUSTOM_SHORTCUTS_KEY = 'customShortcutKeys';
const SHORTCUT_DEFS = {
    hanToEng: { label: '한↔영 자판 되돌리기 (메ㅔㅣㄷ ↔ apple, 양방향+토글)', default: { key: 'e', ctrl: false, alt: true, shift: false } },
    weightAdd: { label: '콤마(,) 바로 앞 조각에 가중치 추가/증가', default: { key: '/', ctrl: false, alt: false, shift: false } },
    clearSegment: { label: '콤마(,) 뒤에 입력한 내용 전부 지우기 (지금 치고 있던 조각만 비우기)', default: { key: 'Backspace', ctrl: false, alt: true, shift: false } },
    openLastQueueItem: { label: '대기열 맨 마지막 항목 열기', default: { key: 'l', ctrl: false, alt: true, shift: false } },
    queuePrevItem: { label: '조각/대기열 편집 모달에서 이전 대기열 항목으로 이동', default: { key: 'ArrowUp', ctrl: false, alt: true, shift: false } },
    queueNextItem: { label: '조각/대기열 편집 모달에서 다음 대기열 항목으로 이동', default: { key: 'ArrowDown', ctrl: false, alt: true, shift: false } },
    toggleButtonBindMode: { label: '🔗 버튼에 단축키 지정 모드 켜기/끄기 (팝업이 열려있어도 작동)', default: { key: 'b', ctrl: true, alt: true, shift: false } },
    // 🆕 기능 확장: 지금 프롬프트(조각 편집 중이면 그 프롬프트, 아니면 공통 긍정)와 태그 겹침이
    // 높은 output 이미지들을 찾아 모달로 보여줌 — prompt_image_finder.js.
    findImagesByPrompt: { label: '🔎 이 프롬프트로 전에 생성한 이미지 목록 보기', default: { key: 'f', ctrl: false, alt: true, shift: false } },
};

function getCustomShortcuts() {
    try {
        const raw = JSON.parse(localStorage.getItem(CUSTOM_SHORTCUTS_KEY) || '{}');
        return (raw && typeof raw === 'object') ? raw : {};
    } catch (e) { return {}; }
}

function getShortcutCombo(id) {
    const custom = getCustomShortcuts();
    return custom[id] || SHORTCUT_DEFS[id].default;
}

function setShortcutCombo(id, combo) {
    const custom = getCustomShortcuts();
    custom[id] = combo;
    localStorage.setItem(CUSTOM_SHORTCUTS_KEY, JSON.stringify(custom));
}

function resetShortcutToDefault(id) {
    const custom = getCustomShortcuts();
    delete custom[id];
    localStorage.setItem(CUSTOM_SHORTCUTS_KEY, JSON.stringify(custom));
    renderShortcutHelpModalBody();
}
window.resetShortcutToDefault = resetShortcutToDefault;

function matchesShortcutCombo(e, id) {
    const combo = getShortcutCombo(id);
    return e.key.toLowerCase() === combo.key.toLowerCase()
        && !!e.ctrlKey === !!combo.ctrl
        && !!e.altKey === !!combo.alt
        && !!e.shiftKey === !!combo.shift;
}

function comboToLabel(combo) {
    const parts = [];
    if (combo.ctrl) parts.push('Ctrl');
    if (combo.alt) parts.push('Alt');
    if (combo.shift) parts.push('Shift');
    parts.push(combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
    return parts.join(' + ');
}

/** "변경" 버튼을 누르면 다음 키 입력을 그대로 캡처해서 그 조합으로 저장한다 */
function startRebindShortcut(id, btnEl) {
    btnEl.textContent = '키를 누르세요… (Esc 취소)';
    btnEl.disabled = true;

    const handler = (e) => {
        e.preventDefault();
        e.stopPropagation();

        // 모디파이어 키 단독 입력은 무시하고 계속 대기 (Ctrl/Alt/Shift만 누른 상태)
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;

        document.removeEventListener('keydown', handler, true);
        if (e.key === 'Escape') { renderShortcutHelpModalBody(); return; }

        const combo = { key: e.key.length === 1 ? e.key.toLowerCase() : e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };
        if (!combo.ctrl && !combo.alt && !combo.shift) {
            const ok = confirm('Ctrl/Alt/Shift 없이 이 키만 쓰면, 프롬프트를 평소에 칠 때도 이 단축키가 계속 발동할 수 있어요.\n그래도 이 키로 설정할까요?');
            if (!ok) { renderShortcutHelpModalBody(); return; }
        }
        setShortcutCombo(id, combo);
        renderShortcutHelpModalBody();
    };
    document.addEventListener('keydown', handler, true);
}
window.startRebindShortcut = startRebindShortcut;

/* ──────────────────────────────────────────────
   🌐 한→영 자판 되돌리기: 한글로 잘못 친 걸 영어로 되돌리기 ("메ㅔㅣㄷ" → "apple")
   원리: 2벌식 자판에서 각 한글 자모가 원래 어느 영문 키였는지 거꾸로 찾아서, 그 키들을 그대로
   이어붙인다. 완성된 음절("메")은 초성/중성/종성으로 분해하고, 아직 안 합쳐진 낱개 자모
   ("ㅔ","ㅣ","ㄷ" 등)도 각각 원래 키로 되돌린다. 영어/숫자/기호는 그대로 둠.
   범위: 선택한 텍스트가 있으면 그 부분만, 없으면 입력칸 전체를 변환.
   단축키는 ⌨️ 단축키 도움말 모달에서 변경 가능 (기본: Alt+E).
   ────────────────────────────────────────────── */
const HAN_TO_ENG_KEY_MAP = {
    'ㅂ': 'q', 'ㅈ': 'w', 'ㄷ': 'e', 'ㄱ': 'r', 'ㅅ': 't', 'ㅛ': 'y', 'ㅕ': 'u', 'ㅑ': 'i', 'ㅐ': 'o', 'ㅔ': 'p',
    'ㅁ': 'a', 'ㄴ': 's', 'ㅇ': 'd', 'ㄹ': 'f', 'ㅎ': 'g', 'ㅗ': 'h', 'ㅓ': 'j', 'ㅏ': 'k', 'ㅣ': 'l',
    'ㅋ': 'z', 'ㅌ': 'x', 'ㅊ': 'c', 'ㅍ': 'v', 'ㅠ': 'b', 'ㅜ': 'n', 'ㅡ': 'm',
    'ㅃ': 'Q', 'ㅉ': 'W', 'ㄸ': 'E', 'ㄲ': 'R', 'ㅆ': 'T', 'ㅒ': 'O', 'ㅖ': 'P'
};
const HAN_CHOSEONG_LIST = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const HAN_JUNGSEONG_LIST = ['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'];
const HAN_JONGSEONG_LIST = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
// 2벌식에서 한 번에 못 치고 두 키를 이어 쳐서 만드는 겹모음/겹받침 조합
const HAN_JUNGSEONG_COMBO = { 'ㅘ': ['ㅗ', 'ㅏ'], 'ㅙ': ['ㅗ', 'ㅐ'], 'ㅚ': ['ㅗ', 'ㅣ'], 'ㅝ': ['ㅜ', 'ㅓ'], 'ㅞ': ['ㅜ', 'ㅔ'], 'ㅟ': ['ㅜ', 'ㅣ'], 'ㅢ': ['ㅡ', 'ㅣ'] };
const HAN_JONGSEONG_COMBO = { 'ㄳ': ['ㄱ', 'ㅅ'], 'ㄵ': ['ㄴ', 'ㅈ'], 'ㄶ': ['ㄴ', 'ㅎ'], 'ㄺ': ['ㄹ', 'ㄱ'], 'ㄻ': ['ㄹ', 'ㅁ'], 'ㄼ': ['ㄹ', 'ㅂ'], 'ㄽ': ['ㄹ', 'ㅅ'], 'ㄾ': ['ㄹ', 'ㅌ'], 'ㄿ': ['ㄹ', 'ㅍ'], 'ㅀ': ['ㄹ', 'ㅎ'], 'ㅄ': ['ㅂ', 'ㅅ'] };

function hanJamoToKeys(jamo, comboTable) {
    const combo = comboTable[jamo];
    if (combo) return combo.map(j => HAN_TO_ENG_KEY_MAP[j] || '').join('');
    return HAN_TO_ENG_KEY_MAP[jamo] || '';
}

/** 글자 하나(완성된 한글 음절이든 낱개 자모든)를 원래 눌렀을 영문 키로 되돌린다. 대상이 아니면 그대로 반환 */
function hanCharToEngKeys(ch) {
    const code = ch.codePointAt(0);
    if (code >= 0xAC00 && code <= 0xD7A3) { // 완성된 한글 음절 (가~힣)
        const sIndex = code - 0xAC00;
        const L = Math.floor(sIndex / (21 * 28));
        const V = Math.floor((sIndex % (21 * 28)) / 28);
        const T = sIndex % 28;
        let keys = HAN_TO_ENG_KEY_MAP[HAN_CHOSEONG_LIST[L]] || '';
        keys += hanJamoToKeys(HAN_JUNGSEONG_LIST[V], HAN_JUNGSEONG_COMBO);
        if (T > 0) keys += hanJamoToKeys(HAN_JONGSEONG_LIST[T], HAN_JONGSEONG_COMBO);
        return keys;
    }
    if (HAN_TO_ENG_KEY_MAP[ch] !== undefined) return HAN_TO_ENG_KEY_MAP[ch]; // 낱개 자모 (예: ㅔ, ㅣ, ㄷ)
    return ch; // 한글이 아니면(영어/숫자/기호/공백) 그대로 둠
}

function convertHangulTypoToEnglish(text) {
    return Array.from(text).map(hanCharToEngKeys).join('');
}

/** 🆕 반대 방향: 영어(키 입력 그대로)를 한글로 조립. HAN_TO_ENG_KEY_MAP을 거꾸로 뒤집어서
 *  키→자모 맵을 만들고, 실제 2벌식 IME처럼 초성+중성(+종성)을 조립해 나간다.
 *  종성 자리에 자음이 왔다가 바로 뒤에 모음이 이어지면(예: g-a-n-a → 가나), 그 자음은 종성이
 *  아니라 "다음 글자의 초성"으로 넘어가야 하므로 한 글자 보류했다가 다음 입력을 보고 판단한다. */
const KEY_TO_JAMO = Object.fromEntries(Object.entries(HAN_TO_ENG_KEY_MAP).map(([jamo, key]) => [key, jamo]));
const HAN_CHOSEONG_SET = new Set(HAN_CHOSEONG_LIST);
const HAN_JUNGSEONG_SET = new Set(HAN_JUNGSEONG_LIST);
const HAN_VALID_JONGSEONG_SET = new Set(HAN_JONGSEONG_LIST.filter(Boolean)); // ㄸ,ㅃ,ㅉ 등은 종성 불가라 제외됨

function findComboKey(comboTable, parts) {
    return Object.keys(comboTable).find(k => comboTable[k].join('') === parts) || null;
}

function composeKeysToHangul(text) {
    const chars = Array.from(text);
    let result = '';
    let cho = null, jung = null, jong = null;

    const flush = () => {
        if (cho !== null && jung !== null) {
            const L = HAN_CHOSEONG_LIST.indexOf(cho);
            const V = HAN_JUNGSEONG_LIST.indexOf(jung);
            const T = jong ? HAN_JONGSEONG_LIST.indexOf(jong) : 0;
            result += String.fromCodePoint(0xAC00 + (L * 21 + V) * 28 + T);
        } else if (cho !== null) {
            result += cho; // 초성만 있고 중성이 아직 없는 상태로 끝남(뒤에 자음/구분자가 옴) → 낱개 자모로 표시
        } else if (jung !== null) {
            result += jung;
        }
        cho = jung = jong = null;
    };

    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        const jamo = KEY_TO_JAMO[ch];
        if (!jamo) { flush(); result += ch; continue; } // 매핑 안 되는 문자(숫자/기호/공백 등)는 그대로 통과

        const nextJamo = (i + 1 < chars.length) ? KEY_TO_JAMO[chars[i + 1]] : null;
        const nextIsVowel = !!nextJamo && HAN_JUNGSEONG_SET.has(nextJamo);

        const isConsonant = HAN_CHOSEONG_SET.has(jamo) && !HAN_JUNGSEONG_SET.has(jamo);
        if (isConsonant) {
            if (cho === null) {
                cho = jamo;
            } else if (jung === null) {
                flush(); cho = jamo; // 초성만 있는데 또 자음 → 이전 건 낱개로 확정, 새로 시작
            } else if (jong === null) {
                // 🔧 다음이 모음이면 이 자음은 종성이 아니라 "다음 음절의 초성"이어야 함 (예: g-a-n-a → 가나)
                if (HAN_VALID_JONGSEONG_SET.has(jamo) && !nextIsVowel) jong = jamo;
                else { flush(); cho = jamo; }
            } else {
                // 이미 종성이 있는 상태에서 또 자음 옴 → 겹받침 시도. 단, 다음이 모음이면 겹받침을
                // 만들지 않고 방금 온 자음을 다음 음절의 초성으로 넘긴다 (예: 닭 vs 달기 구분)
                const combo = findComboKey(HAN_JONGSEONG_COMBO, jong + jamo);
                if (combo && !nextIsVowel) jong = combo;
                else { flush(); cho = jamo; }
            }
        } else { // 모음
            if (jung === null) {
                if (cho !== null) jung = jamo;
                else { flush(); result += jamo; } // 초성 없이 모음만 옴 → 낱개로 표시
            } else if (jong === null) {
                const combo = findComboKey(HAN_JUNGSEONG_COMBO, jung + jamo);
                if (combo) jung = combo; // 겹모음 완성 (예: ㅗ+ㅏ → ㅘ)
                else { flush(); result += jamo; } // 겹모음 불가 → 이전 음절 확정, 이 모음은 낱개로
            } else {
                // 종성으로 보류해뒀던 자음은 사실 "다음 글자의 초성"이었음 → 넘겨준다
                const carried = jong;
                jong = null;
                flush();
                cho = carried;
                jung = jamo;
            }
        }
    }
    flush();
    return result;
}

/** 텍스트에 완성된 한글 음절이나 한글 자모가 하나라도 섞여있으면 true (한→영 방향으로 판단) */
function containsHangul(text) {
    return /[\uac00-\ud7a3\u3131-\u318e]/.test(text);
}

/** 🆕 Alt+E를 같은 자리에서 한 번 더 누르면 되돌리기(토글). 완전한 역변환 알고리즘 대신,
 *  "방금 뭘 뭘로 바꿨는지"를 기억해뒀다가 그 결과가 그대로 남아있으면 원래대로 되돌리는 방식 —
 *  더 간단하고 100% 정확함(원본 자모 정보를 잃지 않고 그대로 들고 있으므로). */
let lastHanToEngConversion = null; // { el, start, before, after }

function performHanToEngToggle(el) {
    const hasSelection = el.selectionStart !== el.selectionEnd;
    let rangeStart, rangeEnd;
    if (hasSelection) {
        rangeStart = el.selectionStart;
        rangeEnd = el.selectionEnd;
    } else {
        // 🐛 수정: 선택 영역이 없을 때 항상 텍스트 전체(0~끝)를 변환해버리던 버그.
        // 콤마 구간 찾기(findCurrentCommaSegment)를 재사용해서, 캐럿이 지금 속한
        // "콤마와 콤마 사이" 구간만 변환 대상으로 삼는다. 구간을 못 찾으면(빈 칸 등)
        // 캐럿 위치 그 자체(빈 변환)로 대체해 안전하게 아무 일도 안 일어나게 한다.
        const seg = (typeof findCurrentCommaSegment === 'function')
            ? findCurrentCommaSegment(el.value, el.selectionStart)
            : null;
        rangeStart = seg ? seg.segStart : el.selectionStart;
        rangeEnd = seg ? seg.segEnd : el.selectionStart;
    }

    // 🔧 토글 판정 기준 변경: 변환 후 텍스트 전체를 "선택" 상태로 남겨두던 것 때문에
    // Alt+E를 누르면 자동으로 전체 선택되는 것처럼 보였음. 이제 변환 후엔 커서만 그 뒤로
    // 옮기고(선택 안 함), 대신 "커서가 방금 변환한 결과 바로 뒤에 그대로 있는지"로 토글을 판정한다.
    const last = lastHanToEngConversion;
    const canToggleBack = !hasSelection && !!last && last.el === el &&
        el.selectionStart === last.start + last.after.length &&
        el.value.slice(last.start, last.start + last.after.length) === last.after;

    if (canToggleBack) {
        const before = last.before;
        const afterLen = last.after.length;
        el.value = el.value.slice(0, last.start) + before + el.value.slice(last.start + afterLen);
        const newCaret = last.start + before.length;
        el.setSelectionRange(newCaret, newCaret); // 선택하지 않고 커서만 이동
        lastHanToEngConversion = null; // 되돌렸으니 초기화 —또 누르면 그 자리를 새로 변환
    } else {
        const original = el.value.slice(rangeStart, rangeEnd);
        // 한글이 섞여있으면 한→영, 순수 영어(등)면 영→한 — 방향을 자동으로 판단
        const converted = containsHangul(original)
            ? convertHangulTypoToEnglish(original)
            : composeKeysToHangul(original);
        el.value = el.value.slice(0, rangeStart) + converted + el.value.slice(rangeEnd);
        const newCaret = rangeStart + converted.length;
        el.setSelectionRange(newCaret, newCaret); // 🔧 선택하지 않고 커서만 뒤로 이동
        lastHanToEngConversion = { el, start: rangeStart, before: original, after: converted };
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

document.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!el.matches || !el.matches(PROMPT_TEXT_FIELD_SELECTORS)) return;
    if (!matchesShortcutCombo(e, 'hanToEng')) return;

    e.preventDefault();
    performHanToEngToggle(el);
}, true);

/* ──────────────────────────────────────────────
   ⚖️ 콤마 앞 가중치 추가/증가: "고양이 귀,/" 처럼 콤마 바로 뒤에서 이 단축키(기본 "/")를 누르면
/* ──────────────────────────────────────────────
   ⚖️ 콤마 사이 조각에 가중치 추가/증가: 콤마와 콤마 사이(캐럿이 그 구간 어디에 있든) 이 단축키
   (기본 "/")를 누르면 그 구간 전체를 "(고양이 귀:1.1)"로 감싼다. 이미 "(...:숫자)" 형식이면
   숫자를 0.1씩 올린다 → 계속 누르면 1.1 → 1.2 → 1.3 ... 처럼 증가.
   "/"는 프롬프트에서 실제로 쓸 일이 없는 문자라서, 콤마 바로 뒤가 아니라 구간 안 어디서 눌러도
   바로 적용되게 함 (일반 타이핑 방해 걱정 없음).
   단축키는 ⌨️ 단축키 도움말 모달에서 변경 가능 (기본: /).
   ────────────────────────────────────────────── */
const PROMPT_WEIGHT_STEP = 0.1;
const PROMPT_WEIGHT_START = 1.1;

/** 캐럿이 포함된 콤마 구간(트림된 내용)의 시작/끝 위치를 반환.
 *  🔧 버그 수정: 캐럿이 있는 구간이 비어있으면(예: 자동완성이 "태그, "처럼 콤마+공백을 자동으로
 *  붙여줘서 캐럿이 그 바로 뒤 "아직 아무것도 없는 빈 칸"에 있게 되는 경우), 그 자리에서 포기하지
 *  않고 바로 앞의 비어있지 않은 구간(=방금 자동완성으로 채워진 태그)을 대신 사용한다. */
function findCurrentCommaSegment(text, caret) {
    // 0) 🔧 버그 수정: 캐럿이 "콤마 바로 뒤"에 있으면 (콤마와 캐럿 사이에 공백만 있는 경우 —
    //    아직 아무것도 안 쳤든, 자동으로 넘어가서 이미 다음 태그를 다 쳐놓은 상태든 상관없이)
    //    항상 그 콤마 "앞" 구간을 대상으로 삼는다.
    //    이렇게 해야 "/"를 눌러 가중치를 감싼 뒤 캐럿이 자동으로 다음 칸으로 넘어가 있어도,
    //    바로 이어서 "/"를 연달아 누르면 다음 태그가 아니라 방금 그 구간이 계속 잡혀서
    //    1.1 → 1.2 → 1.3 ...으로 자연스럽게 이어진다. (예전엔 다음 칸에 이미 글자가
    //    있으면 그쪽을 잘못 잡아버려서, 연속으로 누르면 엉뚱한 다음 태그에 가중치가 붙었음)
    let back = caret - 1;
    let commaPos = -1;
    while (back >= 0) {
        if (text[back] === ',') { commaPos = back; break; }
        if (!/\s/.test(text[back])) break; // 공백이 아닌 실제 글자를 만나면 "콤마 바로 뒤"가 아님
        back--;
    }
    if (commaPos !== -1) {
        let segStartRaw = 0;
        for (let j = commaPos - 1; j >= 0; j--) {
            if (text[j] === ',') { segStartRaw = j + 1; break; }
        }
        let a = segStartRaw, b = commaPos;
        while (a < b && /\s/.test(text[a])) a++;
        while (b > a && /\s/.test(text[b - 1])) b--;
        if (b > a) return { segStart: a, segEnd: b };
        // 앞 구간도 비어있으면(콤마가 연달아 있는 경우 등) 아래 일반 로직으로 넘어감
    }

    // 1) 그 외의 경우엔 캐럿이 포함된 구간을 그대로 사용
    const rawBounds = [];
    let start = 0;
    for (let i = 0; i <= text.length; i++) {
        if (i === text.length || text[i] === ',') {
            rawBounds.push([start, i]);
            start = i + 1;
        }
    }
    const idx = rawBounds.findIndex(([s, e]) => caret >= s && caret <= e);
    if (idx === -1) return null;

    const trim = ([s, e]) => {
        let a = s, b = e;
        while (a < b && /\s/.test(text[a])) a++;
        while (b > a && /\s/.test(text[b - 1])) b--;
        return b > a ? { segStart: a, segEnd: b } : null;
    };

    const current = trim(rawBounds[idx]);
    if (current) return current;

    if (idx > 0) return trim(rawBounds[idx - 1]); // 지금 구간이 비어있으면 바로 앞 구간으로 대체
    return null;
}

/** "(내용:숫자)" 형식이면 숫자를 한 단계 올리고, 아니면 새로 "(내용:1.1)"로 감싼다 */
function applyPromptWeightIncrement(segmentText) {
    const m = segmentText.match(/^\((.+):([\d.]+)\)$/);
    if (m) {
        const inner = m[1];
        const weight = Math.round((parseFloat(m[2]) + PROMPT_WEIGHT_STEP) * 10) / 10;
        return `(${inner}:${weight.toFixed(1)})`;
    }
    return `(${segmentText}:${PROMPT_WEIGHT_START.toFixed(1)})`;
}

document.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!el.matches || !el.matches(PROMPT_TEXT_FIELD_SELECTORS)) return;
    if (!matchesShortcutCombo(e, 'weightAdd')) return;
    if (el.selectionStart !== el.selectionEnd) return; // 선택 영역이 있으면 오해 방지를 위해 건너뜀(원래 키 그대로 입력)

    const caret = el.selectionStart;
    const seg = findCurrentCommaSegment(el.value, caret);
    if (!seg) return; // 콤마 구간을 못 찾으면(빈 칸 등) 이 키를 원래 용도로 그대로 통과시킴

    e.preventDefault();
    const original = el.value.slice(seg.segStart, seg.segEnd);
    const updated = applyPromptWeightIncrement(original);
    let afterOriginal = el.value.slice(seg.segEnd);

    // 🔧 버그 수정: 이 구간 뒤에 콤마가 아예 없으면(맨 마지막 태그인 경우) 그대로 끝나버려서
    // 이어서 다음 태그를 치기 불편했음 → 뒤에 콤마가 없으면 ", "를 자동으로 붙여준다.
    if (!afterOriginal.trimStart().startsWith(',')) {
        afterOriginal = ', ' + afterOriginal;
    }

    const newValue = el.value.slice(0, seg.segStart) + updated + afterOriginal;
    el.value = newValue;

    // 캐럿을 바뀐 구간 바로 뒤(콤마 앞)에 두면, 이어서 타이핑할 때 ", " 사이에 끼어 들어가서
    // 다음 태그를 정상적으로 이어 칠 수 없었음. 바로 뒤에 콤마(+공백)가 있으면 그것까지
    // 건너뛰어서, 다음 태그를 바로 이어 칠 수 있는 위치에 캐럿을 둔다.
    let newCaret = seg.segStart + updated.length;
    if (newValue[newCaret] === ',') {
        newCaret++;
        while (newCaret < newValue.length && /\s/.test(newValue[newCaret])) newCaret++;
    }
    el.setSelectionRange(newCaret, newCaret);
    el.dispatchEvent(new Event('input', { bubbles: true }));
}, true);

/* ──────────────────────────────────────────────
   🧹 콤마(,) 뒤에 입력한 내용 전부 지우기 — 지금 치고 있던(또는 캐럿이 가 있는) 콤마 구간
   하나만 통째로 비운다. 앞뒤 콤마와 다른 조각들은 그대로 두고, 그 구간 내용만 사라진다.
   가중치 추가(/)와 똑같은 방식으로 "지금 캐럿이 속한 콤마 구간"을 찾아서(findCurrentCommaSegment),
   그 구간의 글자만 지우는 것 — 오타 났을 때 그 태그만 빠르게 비우고 다시 치기 좋음.
   단축키는 ⌨️ 단축키 도움말 모달에서 변경 가능 (기본: Alt+Backspace).
   ────────────────────────────────────────────── */
document.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!el.matches || !el.matches(PROMPT_TEXT_FIELD_SELECTORS)) return;
    if (!matchesShortcutCombo(e, 'clearSegment')) return;
    if (el.selectionStart !== el.selectionEnd) return; // 선택 영역이 있으면 오해 방지를 위해 건너뜀(원래 키 그대로 동작)

    const caret = el.selectionStart;
    const seg = findCurrentCommaSegment(el.value, caret);
    if (!seg) return; // 지울 구간이 없으면(빈 칸 등) 이 키를 원래 용도로 그대로 통과시킴

    e.preventDefault();
    const newValue = el.value.slice(0, seg.segStart) + el.value.slice(seg.segEnd);
    el.value = newValue;
    el.setSelectionRange(seg.segStart, seg.segStart);
    el.dispatchEvent(new Event('input', { bubbles: true }));
}, true);

/* ──────────────────────────────────────────────
   📬 Alt+L: 대기열 맨 마지막 항목의 편집창 열기
   대기열 항목 하나를 클릭해서 여는 것과 완전히 동일 — 조각이 1개짜리면 라이브러리 편집 모달로,
   여러 개짜리면 대기열 편집 모달로 (handleQueueItemBodyClick과 완전히 같은 동작).
   입력창에 포커스가 있어도 Alt가 포함돼 있어 타이핑을 방해하지 않고 항상 작동함.
   단축키는 ⌨️ 단축키 도움말 모달에서 변경 가능 (기본: Alt+L).
   ────────────────────────────────────────────── */
document.addEventListener('keydown', (e) => {
    if (!matchesShortcutCombo(e, 'openLastQueueItem')) return;
    if (typeof jobQueue === 'undefined' || typeof handleQueueItemBodyClick !== 'function') return;

    e.preventDefault();
    if (!jobQueue || jobQueue.length === 0) {
        alert('대기열이 비어있습니다.');
        return;
    }
    handleQueueItemBodyClick(jobQueue.length - 1);
}, true);

/* ──────────────────────────────────────────────
   🔤 단어 등록 — 자주 쓰는 단어/문구를 등록해두고, 지정한 단축키를 누르면 지금 포커스 있는
   프롬프트 입력칸의 캐럿 위치에 바로 삽입된다. (콤마 자동완성 삽입 규칙과 동일하게, 뒤에
   이미 콤마/닫는 괄호/콜론이 이어지면 콤마를 덧붙이지 않고, 아니면 ", "를 붙여 이어줌)
   여러 개 등록 가능하고, 각각 다른 단축키를 지정할 수 있다. ⚙️ 옆 "🔤 단어 등록" 버튼에서 관리.
   ────────────────────────────────────────────── */
const REGISTERED_WORDS_KEY = 'registeredQuickWords';

function getRegisteredWords() {
    try {
        const raw = JSON.parse(localStorage.getItem(REGISTERED_WORDS_KEY) || '[]');
        return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
}

function saveRegisteredWords(list) {
    try { localStorage.setItem(REGISTERED_WORDS_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
}

function comboEqualsRaw(a, b) {
    if (!a || !b) return false;
    return a.key.toLowerCase() === b.key.toLowerCase()
        && !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt && !!a.shift === !!b.shift;
}

/** 새로 지정하려는 키 조합이 이미 다른 곳(기본 단축키/버튼 지정 단축키/다른 등록 단어)에서 쓰이고 있는지 확인 */
function findShortcutConflictLabel(combo, excludeWordId) {
    for (const id of Object.keys(SHORTCUT_DEFS)) {
        if (comboEqualsRaw(getShortcutCombo(id), combo)) return SHORTCUT_DEFS[id].label;
    }
    const buttonHit = (typeof getCustomButtonShortcuts === 'function' ? getCustomButtonShortcuts() : [])
        .find(item => comboEqualsRaw(item.combo, combo));
    if (buttonHit) return buttonHit.label;
    const wordHit = getRegisteredWords().find(w => w.id !== excludeWordId && comboEqualsRaw(w.combo, combo));
    if (wordHit) return `등록 단어 "${wordHit.word}"`;
    return null;
}

/** "변경/지정" 버튼을 누르면 다음 키 입력을 그대로 캡처한다 (startRebindShortcut과 같은 방식, 콜백만 다름) */
function captureNextKeyCombo(onCapture) {
    const handler = (e) => {
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return; // 모디파이어 단독 입력은 계속 대기
        e.preventDefault();
        e.stopPropagation();
        document.removeEventListener('keydown', handler, true);
        if (e.key === 'Escape') { onCapture(null); return; }
        onCapture({ key: e.key.length === 1 ? e.key.toLowerCase() : e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });
    };
    document.addEventListener('keydown', handler, true);
}

function addRegisteredWord() {
    const input = document.getElementById('new-registered-word-input');
    if (!input) return;
    const word = input.value.trim();
    if (!word) { alert('등록할 단어/문구를 입력하세요.'); return; }

    const id = 'w_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const list = getRegisteredWords();
    list.push({ id, word, combo: null });
    saveRegisteredWords(list);
    input.value = '';
    renderRegisteredWordsModalBody();

    // 등록하자마자 바로 이어서 단축키를 지정할 수 있게 그 항목의 "단축키 지정" 버튼을 자동으로 눌러줌
    const btn = document.querySelector(`#registered-words-modal [data-word-id="${id}"] .word-bind-btn`);
    if (btn) startRebindRegisteredWord(id, btn);
    input.focus();
}
window.addRegisteredWord = addRegisteredWord;

function removeRegisteredWord(id) {
    saveRegisteredWords(getRegisteredWords().filter(w => w.id !== id));
    renderRegisteredWordsModalBody();
}
window.removeRegisteredWord = removeRegisteredWord;

function startRebindRegisteredWord(id, btnEl) {
    if (btnEl) { btnEl.textContent = '키를 누르세요… (Esc 취소)'; btnEl.disabled = true; }
    captureNextKeyCombo((combo) => {
        if (!combo) { renderRegisteredWordsModalBody(); return; }
        if (!combo.ctrl && !combo.alt && !combo.shift) {
            const ok = confirm('Ctrl/Alt/Shift 없이 이 키만 쓰면, 프롬프트를 평소에 칠 때도 이 단축키가 계속 발동할 수 있어요.\n그래도 이 키로 설정할까요?');
            if (!ok) { renderRegisteredWordsModalBody(); return; }
        }
        const conflict = findShortcutConflictLabel(combo, id);
        if (conflict) {
            const ok = confirm(`이 키 조합은 이미 "${conflict}"에서 쓰고 있어요. 그래도 등록할까요? (두 기능이 같이 발동할 수 있어요)`);
            if (!ok) { renderRegisteredWordsModalBody(); return; }
        }
        const list = getRegisteredWords();
        const target = list.find(w => w.id === id);
        if (target) target.combo = combo;
        saveRegisteredWords(list);
        renderRegisteredWordsModalBody();
    });
}
window.startRebindRegisteredWord = startRebindRegisteredWord;

function renderRegisteredWordsModalBody() {
    const modal = document.getElementById('registered-words-modal');
    if (!modal) return;

    const words = getRegisteredWords();
    const rows = words.map(w => `
        <div data-word-id="${w.id}" style="display:flex; gap:8px; padding:7px 0; border-bottom:1px solid #333; align-items:center;">
            <span style="flex:0 0 auto; min-width:96px; font-weight:bold; color:${w.combo ? '#ffd600' : '#777'}; font-size:0.85em;">${w.combo ? comboToLabel(w.combo) : '(미지정)'}</span>
            <span style="flex:1; font-size:0.85em; color:#ddd; word-break:break-all;">${escapeHtml(w.word)}</span>
            <button type="button" class="btn-secondary word-bind-btn" style="padding:2px 8px; font-size:0.8em;"
                    onclick="startRebindRegisteredWord('${w.id}', this)">단축키 지정</button>
            <button type="button" class="btn-secondary" style="padding:2px 8px; font-size:0.8em;"
                    onclick="removeRegisteredWord('${w.id}')">삭제</button>
        </div>`).join('');

    modal.innerHTML = `
        <div class="modal-content" onclick="event.stopPropagation()" style="width:min(90vw, 480px);">
            <div class="modal-header">
                <h3 style="margin:0; color:#ffd600;">🔤 단어 등록</h3>
                <span class="close-btn" style="position:static; font-size:1.5em; color:#ff5555;"
                      onclick="document.getElementById('registered-words-modal').style.display='none';">&times;</span>
            </div>
            <div class="modal-body">
                <p style="font-size:0.82em; color:#aaa; margin:0 0 10px;">자주 쓰는 단어/문구를 등록하고 단축키를 지정하면, 프롬프트 입력칸 어디서든 캐럿 위치에 바로 삽입됩니다.</p>
                <div style="display:flex; gap:6px; margin-bottom:12px;">
                    <input type="text" id="new-registered-word-input" placeholder="등록할 단어/문구 입력"
                           style="flex:1; padding:5px 8px; font-size:0.85em; background:#222; color:#eee; border:1px solid #555; border-radius:4px;">
                    <button type="button" class="btn-primary" style="padding:4px 12px; font-size:0.85em;" onclick="addRegisteredWord()">추가</button>
                </div>
                <div style="max-height:320px; overflow-y:auto;">
                    ${words.length ? rows : '<p style="font-size:0.82em; color:#777; text-align:center; padding:14px 0;">등록된 단어가 없습니다.</p>'}
                </div>
            </div>
        </div>`;

    const input = document.getElementById('new-registered-word-input');
    if (input) {
        input.addEventListener('keydown', (e) => {
            e.stopPropagation(); // 다른 전역 단축키(한↔영 변환 등)와 안 겹치게
            if (e.key === 'Enter') { e.preventDefault(); addRegisteredWord(); }
        });
    }
}

function openRegisteredWordsModal() {
    let modal = document.getElementById('registered-words-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'registered-words-modal';
        modal.className = 'modal-overlay';
        modal.style.cssText = 'display:none;';
        modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
        document.body.appendChild(modal);
    }
    renderRegisteredWordsModalBody();
    modal.style.display = 'flex';
    setTimeout(() => document.getElementById('new-registered-word-input')?.focus(), 0);
}
window.openRegisteredWordsModal = openRegisteredWordsModal;

/** 등록한 단어를 캐럿 위치에 삽입. 자동완성 삽입 규칙과 동일하게, 뒤에 이미 콤마/닫는 괄호/콜론이
 *  이어지면 콤마를 붙이지 않고, 아니면 ", "를 붙여서 기존 프롬프트 목록에 자연스럽게 이어붙인다. */
function insertRegisteredWordAtCaret(el, word) {
    const text = el.value;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const suffix = /^\s*[,):]/.test(after) ? '' : ', ';
    el.value = before + word + suffix + after;
    const newCaret = (before + word + suffix).length;
    el.setSelectionRange(newCaret, newCaret);
    el.focus();
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

document.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!el.matches || !el.matches(PROMPT_TEXT_FIELD_SELECTORS)) return;
    const words = getRegisteredWords().filter(w => w.combo);
    if (!words.length) return;
    const hit = words.find(w => comboEqualsRaw(w.combo, { key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey }));
    if (!hit) return;

    e.preventDefault();
    insertRegisteredWordAtCaret(el, hit.word);
}, true);

/* ──────────────────────────────────────────────
   ⌨️ 단축키 도움말 모달 — 화면 오른쪽 위(또는 ⚙️ 설정 버튼 옆)에 작은 버튼으로 띄워서 언제든 확인 가능.
   키보드 단축키(한→영 변환, 가중치 추가)는 여기서 "변경" 버튼으로 원하는 키 조합으로 바꿀 수 있다.
   ────────────────────────────────────────────── */
const FIXED_SHORTCUT_HELP_ITEMS = [
    { keys: 'Enter (입력창/모달 없을 때)', desc: '🚀 대기열 전체 순차 생성을 바로 시작' },
    { keys: '/ (입력창/모달 없을 때)', desc: '조각 검색창에 바로 포커스' },
    { keys: '숫자 입력 (입력창 포커스 없을 때)', desc: '0.5초간 추가 입력 없으면 그 번호로 자동 이동. 콤마(,)도 입력 가능' },
    { keys: 'Shift + 숫자 입력', desc: '이동은 안 하고 그 번호 미리보기 팝업만 띄움' },
    { keys: 'Esc (숫자 입력 중)', desc: '입력 중이던 번호 취소' },
    { keys: '← / → (검수 도구 안에서)', desc: '이전 이미지로 이동 / 다음(또는 판정 후 다음)으로 이동' },
    { keys: 'Ctrl + Z (그림판 편집 중)', desc: '그림판에서 방금 그린 것 되돌리기' },
    { keys: 'Ctrl + 좌클릭 (이미지)', desc: '그 이미지를 번호 매겨서 바로 저장 (검수 없이 즉시 저장)' },
    { keys: 'Ctrl + 우클릭 (이미지)', desc: '그 이미지의 재생성(리롤) 모달 열기' },
    { keys: 'Shift + Ctrl + 클릭 (라이브러리 조각)', desc: '여러 조각을 하나로 합치기' },
    { keys: '좌클릭 누른 채로 휠', desc: '쉼표(,)로 나뉜 프롬프트 조각을 한 칸씩 옮겨가며 선택 (지울 때 편함)' },
    { keys: 'artist: 뒤에 이름 일부 + Enter/Tab', desc: '긍정프롬프트에서 등록된 작가 이름 자동완성 (📝 작가 목록 관리에 등록 필요)' },
    { keys: '↑ / ↓ (작가 자동완성 중)', desc: '자동완성 후보 목록 탐색' },
    { keys: 'Esc (자동완성 중)', desc: '자동완성 후보 목록 닫기' },
];

function renderShortcutHelpModalBody() {
    const modal = document.getElementById('shortcut-help-modal');
    if (!modal) return;

    const editableRows = Object.keys(SHORTCUT_DEFS).map(id => {
        const combo = getShortcutCombo(id);
        const isCustom = !!getCustomShortcuts()[id];
        return `
            <div style="display:flex; gap:8px; padding:7px 0; border-bottom:1px solid #333; align-items:center;">
                <span style="flex:0 0 auto; min-width:90px; font-weight:bold; color:#8bc34a; font-size:0.85em;">${comboToLabel(combo)}</span>
                <span style="flex:1; font-size:0.85em; color:#ddd;">${SHORTCUT_DEFS[id].label}</span>
                <button type="button" class="btn-secondary" style="padding:2px 8px; font-size:0.8em;"
                        onclick="startRebindShortcut('${id}', this)">변경</button>
                ${isCustom ? `<button type="button" class="btn-secondary" style="padding:2px 8px; font-size:0.8em;" onclick="resetShortcutToDefault('${id}')">기본값</button>` : ''}
            </div>`;
    }).join('');

    const fixedRows = FIXED_SHORTCUT_HELP_ITEMS.map(item => `
        <div style="display:flex; gap:10px; padding:7px 0; border-bottom:1px solid #333; align-items:flex-start;">
            <span style="flex:0 0 auto; min-width:170px; font-weight:bold; color:#CE93D8; font-size:0.85em;">${item.keys}</span>
            <span style="flex:1; font-size:0.85em; color:#ddd;">${item.desc}</span>
        </div>`).join('');

    const customButtonList = getCustomButtonShortcuts();
    const customButtonRows = customButtonList.map((item, i) => `
        <div style="display:flex; gap:8px; padding:7px 0; border-bottom:1px solid #333; align-items:center;">
            <span style="flex:0 0 auto; min-width:90px; font-weight:bold; color:#ffd600; font-size:0.85em;">${comboToLabel(item.combo)}</span>
            <span style="flex:1; font-size:0.85em; color:#ddd;">${item.label}</span>
            <button type="button" class="btn-secondary" style="padding:2px 8px; font-size:0.8em;"
                    onclick="removeCustomButtonShortcut(${i})">삭제</button>
        </div>`).join('');

    const registeredWordRows = getRegisteredWords().filter(w => w.combo).map(w => `
        <div style="display:flex; gap:8px; padding:5px 0; border-bottom:1px solid #333; align-items:center;">
            <span style="flex:0 0 auto; min-width:90px; font-weight:bold; color:#ffd600; font-size:0.85em;">${comboToLabel(w.combo)}</span>
            <span style="flex:1; font-size:0.85em; color:#ddd; word-break:break-all;">${escapeHtml(w.word)}</span>
        </div>`).join('');

    modal.innerHTML = `
        <div class="modal-content" onclick="event.stopPropagation()" style="width:min(90vw, 520px);">
            <div class="modal-header">
                <h3 style="margin:0;">⌨️ 단축키 모음</h3>
                <span class="close-btn" style="position:static; font-size:1.5em; color:#ff5555;"
                      onclick="document.getElementById('shortcut-help-modal').style.display='none';">&times;</span>
            </div>
            <div class="modal-body">
                <p style="font-size:0.82em; color:#8bc34a; margin:4px 0 2px; font-weight:bold;">✏️ 직접 수정 가능</p>
                <div style="margin-bottom:12px;">${editableRows}</div>

                <p style="font-size:0.82em; color:#ffd600; margin:10px 0 2px; font-weight:bold; display:flex; justify-content:space-between; align-items:center;">
                    <span>🔤 등록 단어 단축키</span>
                    <button type="button" class="btn-secondary" style="padding:2px 8px; font-size:0.75em;" onclick="openRegisteredWordsModal()">관리</button>
                </p>
                <div style="margin-bottom:12px;">${registeredWordRows || '<p style="font-size:0.8em; color:#777; margin:2px 0;">등록된 단어 단축키가 없습니다.</p>'}</div>

                ${customButtonList.length > 0 ? `
                <p style="font-size:0.82em; color:#ffd600; margin:10px 0 2px; font-weight:bold;">🔗 버튼에 직접 지정한 단축키</p>
                <div style="margin-bottom:12px;">${customButtonRows}</div>
                ` : ''}

                <p style="font-size:0.82em; color:#888; margin:10px 0 2px;">🔒 마우스 조합 등 고정 단축키</p>
                <div style="max-height:40vh; overflow-y:auto;">${fixedRows}</div>
            </div>
        </div>`;
}

function openShortcutHelpModal() {
    let modal = document.getElementById('shortcut-help-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'shortcut-help-modal';
        modal.className = 'modal-overlay';
        modal.style.cssText = 'display:none;';
        modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
        document.body.appendChild(modal);
    }
    renderShortcutHelpModalBody();
    modal.style.display = 'flex';
}
window.openShortcutHelpModal = openShortcutHelpModal;

/** 🆕 상단 네비게이션 바의 "빠른 이동" 아이콘들(ensureQuickJumpNavIcons)과 똑같은 스타일을 내는 헬퍼.
 *  글자 없이 이모티콘만 보이고, title 속성으로 커서 올렸을 때 이름이 뜨게 한다. */
function applyNavIconStyle(btn) {
    btn.style.cssText = 'font-size:1.05em; padding:4px 7px; background:transparent; border:1px solid transparent; color:#ccc; cursor:pointer; border-radius:6px;';
    btn.onmouseenter = () => { btn.style.background = '#2a2a2a'; btn.style.borderColor = '#555'; };
    btn.onmouseleave = () => { btn.style.background = 'transparent'; btn.style.borderColor = 'transparent'; };
}

/** ⚙️ 톱니바퀴 설정 버튼을 찾아 그 옆에 "⌨️ 단축키" 버튼을 끼워넣는다. 못 찾으면 화면 우측 상단에 고정 버튼으로 대신 띄움. */
function ensureShortcutHelpButton() {
    if (document.getElementById('shortcut-help-btn')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'shortcut-help-btn';
    btn.textContent = '⌨️';
    btn.title = '단축키 도움말';
    btn.onclick = openShortcutHelpModal;

    const bindBtn = document.createElement('button');
    bindBtn.type = 'button';
    bindBtn.id = 'shortcut-bind-mode-btn';
    bindBtn.textContent = '🔗';
    bindBtn.title = '버튼에 단축키 지정';
    bindBtn.onclick = toggleButtonBindMode;

    const memoBtn = document.createElement('button');
    memoBtn.type = 'button';
    memoBtn.id = 'memo-pad-toggle-btn';
    memoBtn.textContent = '📝';
    memoBtn.title = '메모장';
    memoBtn.onclick = toggleMemoPad;

    const wordBtn = document.createElement('button');
    wordBtn.type = 'button';
    wordBtn.id = 'registered-words-btn';
    wordBtn.textContent = '🔤';
    wordBtn.title = '단어 등록';
    wordBtn.onclick = openRegisteredWordsModal;

    // 톱니바퀴(⚙️) 아이콘처럼 보이는 버튼/요소를 최대한 찾아서 그 옆에 붙여본다
    const gearCandidate = Array.from(document.querySelectorAll('button, [role="button"], .icon-btn'))
        .find(el => (el.textContent || '').includes('⚙'));

    if (gearCandidate && gearCandidate.parentElement) {
        [btn, bindBtn, memoBtn, wordBtn].forEach(applyNavIconStyle);
        gearCandidate.insertAdjacentElement('afterend', btn);
        btn.insertAdjacentElement('afterend', bindBtn);
        bindBtn.insertAdjacentElement('afterend', memoBtn);
        memoBtn.insertAdjacentElement('afterend', wordBtn);
    } else {
        // 못 찾으면 화면 우측 상단에 고정 버튼으로 대신 띄움
        applyNavIconStyle(btn);
        btn.style.cssText += 'position:fixed; top:8px; right:150px; z-index:9998;';
        applyNavIconStyle(bindBtn);
        bindBtn.style.cssText += 'position:fixed; top:8px; right:114px; z-index:9998;';
        applyNavIconStyle(memoBtn);
        memoBtn.style.cssText += 'position:fixed; top:8px; right:78px; z-index:9998;';
        applyNavIconStyle(wordBtn);
        wordBtn.style.cssText += 'position:fixed; top:8px; right:42px; z-index:9998;';
        document.body.appendChild(btn);
        document.body.appendChild(bindBtn);
        document.body.appendChild(memoBtn);
        document.body.appendChild(wordBtn);
    }

    // 🐛 버그 수정: "🔗 버튼에 단축키 지정" 토글은 팝업(job-edit-modal, prompt-edit-modal 등) 안의
    // 버튼에도 단축키를 지정할 수 있어야 하는데, 원래 자리(네비게이션 바)에 그대로 두면 전체화면
    // 모달 오버레이에 가려서 팝업이 열려있는 동안은 이 버튼을 누를 수가 없었다.
    // → 버튼 위치/크기는 원래 그대로 두고, 대신 키보드 단축키(기본 Ctrl+Alt+B, ⌨️ 단축키
    // 도움말에서 재지정 가능)로도 지정 모드를 켤 수 있게 해서, 팝업이 열려있어도 그 단축키만
    // 누르면 버튼을 클릭할 필요 없이 바로 지정 모드가 켜지도록 함.
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureShortcutHelpButton);
} else {
    ensureShortcutHelpButton();

}

/* ──────────────────────────────────────────────
   📖 기능 도움말 모달 — 2달치 누적 기능이 너무 많아져서 인수인계/기억 복구용으로 만듦.

   🔴 규칙 (예외 없음, 사용자가 매번 말 안 해도 항상 지킬 것):
   새 기능을 추가하거나(새 버튼/탭/도구 등) 기존 기능을 크게 바꾸면(동작 방식이 달라지면),
   같은 작업 안에서 — 사용자가 "도움말에 등록해줘"라고 따로 요청하지 않아도 — 반드시
   아래 FEATURE_HELP_SECTIONS에 항목을 새로 추가하거나 기존 항목의 desc/tech를 같이 고칠 것.
   (큰 변경이면 새 항목보다 기존 항목 desc를 갱신하는 쪽을 우선 고려 — 같은 기능이 항목 여러 개로
   쪼개지면 다음 세션에서 오히려 헷갈림.) desc는 사용자 입장에서 "뭘 하는 기능인지/어떻게 쓰는지",
   tech는 "어떤 함수가 담당하는지 / 어느 파일인지"를 적어서, 다음 세션에서 코드를 처음부터
   다시 뒤질 필요 없이 바로 그 함수로 갈 수 있게 한다. 알트클릭 상세 도움말을 쓰는 요소라면
   바로 아래 ELEMENT_HELP_MAP에도 같이 등록할 것(그쪽 설명 참고).
   섹션은 화면 위에서 아래로 나타나는 순서(공통설정→...→대기열→라이브러리)와 최대한 맞춤.
   ────────────────────────────────────────────── */
const FEATURE_HELP_SECTIONS = [
    {
        title: '1. 공통 환경 설정',
        items: [
            {
                name: '🎨 NovelAI(NAI) 이미지 생성',
                desc: '아키텍처 드롭다운에서 "🎨 NovelAI (NAI)"를 고르면 로컬 ComfyUI 모델 대신 NovelAI 서버로 이미지를 생성한다. ' +
              '체크포인트/로라/VAE/CLIP 행이 사라지고 API 토큰과 NAI 전용 설정 전체(해상도 프리셋/샘플러/노이즈스케줄/스텝/CFG/CFG Rescale/시드/SMEA/SMEA DYN/UC프리셋/품질태그/가중치변환)가 자체 UI로 나타남 — 공통 "고급 설정"과는 별개로 독립 관리(부정 프롬프트만 공통 칸 재사용, 시드 동일화 그룹도 동작). 모델 목록에 Curated 계열도 있음. ' +
              '✅ 실제 생성까지 테스트해서 정상 작동 확인된 기능(전부 V4.5 기준): Img2Img, 인페인팅(기존 "🎨 편집" 그림판 재사용해서 칠한 부분을 diff로 자동 마스크화 + 경계 블러로 이음매 완화), 캐릭터별 프롬프트+위치 지정(드래그로 위치 조절), Vibe Transfer(스타일 참조 이미지 여러 장), Precise Reference(단 전용 API를 못 찾아서 Vibe Transfer와 같은 경로로 동작 — 캐릭터/스타일 구분은 반영 안 됨), Text Rendering(이미지 안에 글자 넣기), NAI Director 도구(선화추출/스케치/채색/감정변경/배경제거/정리, "🛠️ 도구" 탭)와 무료 업스케일. ' +
              '❌ 투명 배경(V5 전용 체크박스)은 켜도 실제로 투명하게 안 나오는 것을 확인함 — 원인 미상. ' +
              '🚫 V5 모델은 Vibe Transfer/Precise Reference 호출 시 서버가 에러를 반환해서(미지원으로 보임) 그 두 섹션 자체가 V5에서는 숨겨짐 — 참조 계열 기능은 V4.5를 쓸 것. ' +
              '프롬프트 랜덤화({a|b|c} 문법)는 NAI 서버가 직접 해석해서 별도 구현 불필요, 프롬프트 조각(@) 기능은 이 프로그램의 "프롬프트 라이브러리"가 동등한 역할. ' +
              '컨트롤넷/디테일러/모자이크 같은 로컬 후처리는 NAI 경로에 해당 사항 없음(적용 안 됨). 결과는 output/nai 폴더에 저장되어 기존 대기열·검수 흐름을 그대로 탐. 생성/인코딩/업스케일마다 Anlas가 소모됨.',

                tech: 'executeNaiGeneration(), convertWeightsForNai() — generate.js (executeGeneration() 맨 앞에서 architecture===\'nai\'면 분기). 백엔드 api_nai_generate() — __init__.py (POST /assetmanager/api/nai_generate, 응답 zip에서 png 추출). UI는 index.html의 #nai-row/toggleArchitectureUI().'
            },
            {
                name: '🍌 나노바나나 (Google Gemini 이미지 생성)',
                desc: '아키텍처 드롭다운에서 "🍌 나노바나나"를 고르면 로컬 ComfyUI 모델 대신 Google 서버(gemini-2.5-flash-image)로 이미지를 생성한다. 체크포인트/로라/VAE/CLIP 행이 사라지고 API 키 입력칸이 나타남. 현재는 프롬프트→이미지 한 장만 지원하며, 고급설정(해상도/샘플러/스텝/CFG/시드)과 참조이미지/컨트롤넷/Img2Img/인페인팅/디테일러/모자이크는 전부 무시됨(후처리 연동은 추후 지원 예정, 미완료). 🆕 단, 체크포인트가 필요 없는 "일반 업스케일"만은 아래 "⬆️ 생성 직후 자동 업스케일" 체크박스로 적용 가능. 결과 이미지는 ComfyUI output/nanobanana 폴더에 저장되어 기존 대기열·검수 흐름을 그대로 탐. 반복횟수(repeatCount)도 정상 동작(횟수만큼 API 호출).',
                tech: 'executeNanoBananaGeneration() — generate.js (executeGeneration() 맨 앞에서 architecture===\'nanobanana\'면 분기). 백엔드 api_nanobanana_generate() — __init__.py (POST /assetmanager/api/nanobanana_generate, 서버가 Google API 대신 호출). UI는 index.html의 #nanobanana-row/toggleArchitectureUI().'
            },
            {
                name: '🤖 GPT (OpenAI 이미지 생성, 신규)',
                desc: '아키텍처 드롭다운에서 "🤖 GPT"를 고르면 로컬 ComfyUI 모델 대신 OpenAI 서버(gpt-image-1)로 이미지를 생성한다. 🍌 나노바나나와 완전히 동일한 구조 — 체크포인트/로라/VAE/CLIP 행이 사라지고 API 키 입력칸이 나타남. 현재는 프롬프트→이미지 한 장만 지원하며, 고급설정(해상도/샘플러/스텝/CFG/시드)과 참조이미지/컨트롤넷/Img2Img/인페인팅/디테일러/모자이크는 전부 무시됨(후처리 연동은 추후 지원 예정, 미완료). 🆕 단, 체크포인트가 필요 없는 "일반 업스케일"만은 아래 "⬆️ 생성 직후 자동 업스케일" 체크박스로 적용 가능. 결과 이미지는 ComfyUI output/gpt 폴더에 저장되어 기존 대기열·검수 흐름을 그대로 탐. 반복횟수(repeatCount)도 정상 동작(횟수만큼 API 호출).',
                tech: 'executeGptGeneration() — generate.js (executeGeneration() 맨 앞에서 architecture===\'gpt\'면 분기). 백엔드 api_gpt_generate() — __init__.py (POST /assetmanager/api/gpt_generate, 서버가 OpenAI /v1/images/generations 대신 호출, b64_json 우선 처리하고 url 응답도 대비). UI는 index.html의 #gpt-row/toggleArchitectureUI().'
            },
            {
                name: '💬 대화하며 이미지 뽑기 (신규)',
                desc: '🎲 랜덤 프리셋으로 생성 버튼 옆의 "💬 대화하며 이미지 뽑기"를 누르면 채팅 모달이 뜸. 공급자를 Gemini/GPT(OpenAI)/커스텀(OpenAI 호환 엔드포인트 — 로컬 LLM인 Ollama의 llama3.2-vision 등도 연결 가능) 중 골라서 API 키(커스텀은 엔드포인트 URL+모델명)를 입력해두면 저장됨. 원하는 그림을 자연어로 대화하면 AI가 Danbooru 스타일 태그 프롬프트를 제안하고(입력창 위 미리보기 줄에 표시), 대화로 계속 다듬다가 "🎨 생성" 버튼을 누르면 그때 실제로 생성됨(대화 중엔 자동 생성 안 함). 생성된 이미지는 채팅창에 바로 뜨고, 그 다음 메시지("머리색 바꿔줘" 등)에는 그 이미지가 비전 입력으로 같이 전달돼서 모델이 보고 반영한 새 프롬프트를 제안함 — 결과 보며 계속 대화로 수정 가능. 생성 자체는 현재 Generate 탭에 설정된 체크포인트/아키텍처/고급설정을 그대로 사용(채팅은 프롬프트 작성만 담당).',
                tech: '프런트: ensureChatGenUI()/buildChatGenModal()/sendChatGenMessage()/chatGenGenerate() — library.js(🎲 랜덤 프리셋 생성 블록 바로 뒤). 설정은 getChatGenSettings()/saveChatGenSettings() → localStorage의 chatGenSettings 키(이미지 생성용 nanoBananaApiKey/gptApiKey와는 별도 저장). 생성은 chatGenGenerate()가 generate.js의 executeGeneration(positive, negative, \'chatgen\')을 직접 호출해 기존 파이프라인 재사용. 백엔드: POST /assetmanager/api/chatgen_message — __init__.py의 api_chatgen_message(), 공급자별로 Gemini generateContent / OpenAI(or 호환) chat/completions를 호출하고 JSON({reply, positive_prompt, negative_prompt})으로 통일해 응답. 직전 생성 이미지는 _chatgen_read_image_b64()가 서버에서 직접 디스크(output 폴더)로부터 읽어 base64로 비전 입력에 첨부(경로 탈출 방지 처리됨). 🆕 채팅 기록(chatGenMessages)과 직전 제안 프롬프트/이미지(chatGenState)는 메시지가 바뀔 때마다 localStorage의 chatGenHistory 키에 저장되고, 새로고침·재접속해도 그대로 복원됨(loadChatGenHistory()/saveChatGenHistory()). 모달 상단 "🗑 대화 초기화" 버튼으로 수동 삭제 가능(clearChatGenHistory(), 확인창 있음). 대화 1개만 저장하는 구조라 여러 대화를 동시에 보관하진 않음 — 초기화하면 이전 기록은 사라짐.'
            },
            {
                name: '🆕 알트클릭 상세 도움말',
                desc: 'Alt(옵션) 키를 누른 채 아무 드롭다운/버튼이나 클릭하면, 원래 동작(값 변경, 모달 열림 등) 대신 그 항목의 설명 팝업만 뜬다. 처음 보는 사람도 각 항목이 뭘 하는지, 어떤 함수/노드로 이어지는지 바로 확인 가능. 지금은 "1. 공통 환경 설정"과 "2. 고급 설정" 두 섹션만 등록되어 있음(다른 섹션은 이후 확장 예정, 미완료).',
                tech: 'ELEMENT_HELP_MAP, setupAltClickHelp() — library.js (FEATURE_HELP_SECTIONS 배열 바로 뒤). id 없는 버튼은 index.html에 data-help="키" 속성을 붙여서 매칭.'
            },
            {
                name: '아키텍처 드롭다운 (gen-architecture)',
                desc: 'SDXL / SD1.5 / Anima(qwen_image 계열) 중 어떤 모델 계열로 생성할지 고른다. 이 값에 따라 체크포인트 목록, CLIP/VAE 로딩 방식, 샘플러 기본값이 전부 갈라진다.',
                tech: 'toggleArchitectureUI() — index.html 인라인 스크립트. 실제 워크플로우 노드 분기는 generate.js의 프롬프트 빌드 로직(architecture 변수로 분기).'
            },
            {
                name: 'Anima 전용 로딩 구조',
                desc: 'Anima는 체크포인트 한 방 로딩이 아니라 UNETLoader + CLIPLoader(qwen_image) + VAELoader를 따로 조합해서 쓴다. "체크포인트로 통합 사용" 토글로 한 파일짜리 Anima 체크포인트도 지원.',
                tech: 'generate.js의 architecture===\'anima\' 분기, toggleAnimaModelSourceUI() (index.html).'
            },
            {
                name: '체크포인트/프리셋',
                desc: '체크포인트를 바꾸면 모델별로 저장해둔 프리셋(로라 구성, 샘플러, IP-Adapter 등)이 자동 적용된다.',
                tech: 'applyPreset() — main.js. 프리셋 데이터는 window.MODEL_PRESETS.'
            },
        ]
    },
    {
        title: '2. 고급 설정',
        items: [
            {
                name: '샘플러 / 스케줄러 / 스텝 / CFG',
                desc: '표준 KSampler 파라미터. Anima는 지금 euler_ancestral + simple로 고정 사용 중 (전용 AnimaFlowCorrectiveSampler 노드팩 버전 호환 문제로 임시 되돌림 — 노드팩 업데이트되면 다시 전환 예정, 미완료).',
                tech: 'adv-sampler/adv-scheduler/adv-steps/adv-cfg (index.html input) → generate.js가 프롬프트 JSON 빌드 시 그대로 주입.'
            },
            {
                name: '시드 랜덤/고정',
                desc: '체크하면 매번 랜덤 시드, 해제하면 입력한 시드 값 고정 사용.',
                tech: 'adv-seed-random 체크박스, adv-seed 입력창 (index.html) — generate.js.'
            },
        ]
    },
    {
        title: '3. 베이스 프롬프트 & 색상 카테고리',
        items: [
            {
                name: '🆕 알트클릭 도움말 (베이스 프롬프트 & 무효화)',
                desc: '이 섹션도 Alt+클릭 도움말에 등록됨: 공통 긍정/부정 프롬프트 칸(base-pos/base-neg), 조각 편집모달의 "이 조각 전용 — 공통에서 빼기" 두 칸. 색상 카테고리 배지/@작가명 인식/접기 아이콘 같은 자동 동작(클릭할 대상이 없는 기능)은 알트클릭 대상에서 제외 — 이 모달(기능 도움말)에서 계속 설명함.',
                tech: 'ELEMENT_HELP_MAP의 base-pos/base-neg/edit-pos-invalidate-value/edit-neg-invalidate-value 키 — library.js.'
            },
            {
                name: '베이스 긍정/부정 프롬프트',
                desc: '모든 생성에 공통으로 깔리는 프롬프트. 조각(라이브러리 항목)의 프롬프트와 합쳐져서 최종 프롬프트가 만들어진다.',
                tech: '#base-pos, #base-neg (index.html) — generate.js가 조각 프롬프트와 concat.'
            },
            {
                // 🆕 기능 확장: 단축키로 "이 프롬프트로 전에 생성한 이미지" 찾기
                name: '🔎 이 조각으로 생성한 이미지 목록 (Alt+F)',
                desc: 'Alt+F(단축키는 ⌨️ 단축키 도움말에서 변경 가능)를 조각(라이브러리 아이템) 편집 중에 누르면, 그 조각으로 생성한 이미지 내역(🖼 조각별 생성 내역 기록 항목 참고)을 바로 보여줌. 조각 편집 중이 아니면 "조각을 편집하는 중에만 쓸 수 있다"는 안내만 뜸. 🔧 원래는 output 폴더를 훑어 프롬프트 태그 겹침 비율로 비슷한 이미지를 "추측"해서 찾는 기능이었는데, 실사용 중 다른 프롬프트인데도 찾아지는 오탐이 발견돼서 추측 검색은 완전히 없애고 정확한 기록 방식(아래 항목)으로만 동작하도록 바뀜.',
                tech: 'prompt_image_finder.js (신규 독립 파일, 많이 작아짐). keydown에서 matchesShortcutCombo(e, "findImagesByPrompt")만 확인하고, #work-edit-modal이 열려있으면 #edit-prompt-original-id로 itemId를, activeCategoryId로 catId를 읽어 openItemGeneratedImagesModal(catId, itemId)(library.js)을 바로 호출. 백엔드 라우트(예전엔 __init__.py에 있던 /assetmanager/api/search_by_prompt)는 더 안 쓰여서 삭제됨.'
            },
            {
                name: '🖼 조각별 생성 내역 기록 + 검증 (신규 — 2번 기능의 정확도 문제를 해결, 이중 저장)',
                desc: '조각(라이브러리 아이템)으로 생성이 성공할 때마다, 그 결과 파일명을 "추측"이 아니라 그 조각 자체에 직접 기록해둔다(library.json과 PNG 파일 자체 둘 다 — 아래 "저장 위치" 참고). 조각 편집 모달의 프롬프트 칸 옆 "🖼 생성 내역" 버튼을 누르면 최신순으로 5장씩 보여줌. ⚠️ 이 기능을 추가하기 전에 생성한 이미지는 기록이 없어서(소급 적용 안 됨) 안 뜸. 조각 하나당 최근 500장까지만 보관. 🆕(출력 폴더 정리 시 안전장치) "파일명 1.png가 지워지고 그 자리에 다른 1.png가 생기면?"이라는 실제 위험이 있어서, 기록된 파일명을 무조건 믿지 않고 하나씩 검증한다 — 먼저 가벼운 HEAD 요청으로 서버의 Last-Modified를 기록해둔 시각과 비교해서 같으면("그때 그 파일 그대로") PNG를 안 열어보고 통과, 다르면 PNG를 직접 열어서 안에 박힌 "fragment_info"가 지금 이 조각이 맞는지 최종 확인한다. 검증을 통과 못 한 기록(파일 삭제됨/다른 이미지로 바뀜)은 목록에서 조용히 빠지고, 그다음 기록을 계속 검사해서 "5장 보여주기"를 채운다(끝까지 가도 못 채우면 그만큼만 표시). ⚙️ 환경설정의 "PNG 검증 건너뛰기"를 켜면 이 확인을 전부 생략하고 최신 5장을 그냥 바로 보여줌(빠른 대신 틀린 파일이 섞여도 못 거름).',
                tech: 'generate.js executeGeneration() 성공 시(job.lastResults 기록 직후) → recordGeneratedImagesForRefs(job.sourceRefs, result)(library.js, library.json에 저장). job.sourceRefs(각 {catId, itemId})로 실제 조각 객체를 찾아 item.generatedImages 배열에 {filename, subfolder, type, timestamp}를 push, 500장 넘으면 오래된 것부터 slice. item._combined(합성 조각)이면 item._sourceItems 전부에 기록. 저장 위치(2곳): ① library.json — 위 경로. ② PNG 파일 자체 — executeGeneration()의 11번째 인자 fragmentInfo(job.sourceRefs를 {catId,catName,itemId,itemName} 배열로 정리)를 POST /prompt의 extra_data.extra_pnginfo.fragment_info로 전송 → ComfyUI 표준 SaveImage 노드가 "workflow"와 완전히 같은 방식으로 PNG tEXt 청크에 저장(커스텀 노드 불필요). 읽기는 component_metadata.js parseComfyUIMetadataFromPNG()가 "fragment_info" 청크도 같이 파싱 → metadata.fragmentInfo. 보기+검증: openItemGeneratedImagesModal(catId, itemId) → verifyHistoryEntry(entry, itemId, url) — HEAD 요청 Last-Modified(±2초 허용) 1차 확인 후, 안 맞으면 fetch로 PNG 전체를 받아 parseComfyUIMetadataFromPNG()로 fragment_info 재확인. BATCH=5개씩 검증 통과분만 채워서 "더 보기"로 이어서 검사. 건너뛰기 설정은 AppSettings.get("skipImageVerification").'
            },
            {
                // 🆕(기능 도움말 점검 세션 — prompt_utils.js 확인 후 추가, 기존엔 아예 미등록)
                name: '⌨️ 프롬프트 더블클릭 가중치 조절 (신규 등록)',
                desc: '프롬프트 입력칸(공통 긍정/부정, 조각 편집창 등)에서 단어를 더블클릭하면 (단어:1.1)처럼 가중치 괄호가 붙거나 0.1씩 올라간다. 빠르게 두 번 우클릭하면 반대로 0.1씩 내려감. 1.0이 되면 괄호가 자동으로 없어짐(순정 태그로 복귀). 커서가 콤마로 구분된 "그 태그 덩어리" 안 어디에 있든 그 태그 전체를 인식해서 감싸줌. textarea 안에서는 브라우저 기본 우클릭 메뉴가 아예 안 뜨는데, 이건 우클릭 두 번을 가중치 조절용 제스처로 쓰기 위해 의도적으로 막아놓은 것.',
                tech: 'prompt_utils.js (독립 IIFE 모듈). getTokenAt(text, pos) — 커서 위치에서 콤마/줄바꿈 전까지를 한 토큰으로 추출. parseWeighted()/adjustWeight() — 기존 (word:N.N) 패턴이면 숫자만 바꾸고, 아니면 새로 괄호를 씌움(0.1 단위 반올림, 1.0이면 괄호 제거, 0 이하로 내려가면 숫자 없이 원래 단어만 남김). handleWeightAdjust()가 textarea.value를 직접 잘라붙이고 input 이벤트를 dispatch(appStateManager 저장 트리거). 좌더블클릭=+0.1(dblclick 이벤트), 우더블클릭=-0.1(mousedown e.button===2를 400ms 안에 두 번 세어 판정, contextmenu 이벤트는 preventDefault로 억제). bindStaticTextareas()가 #base-pos/#base-neg/#edit-prompt-value에 고정 바인딩, observeDynamicTextareas()(MutationObserver)가 나중에 생기는 textarea에도 자동으로 같은 이벤트를 걸어줌.'
            },
            {
                name: '색상 카테고리 배지 (🎨 13종 분류)',
                desc: '입력창/대기열 항목 밑에 프롬프트 태그별로 색깔 배지를 붙여서 한눈에 "이 태그가 뭔지"(작가/얼굴/의상/구도/사물/성인용 등) 보여준다. 13개 카테고리: 작가/얼굴/표정감정/신체외형/인물캐릭터/의상패션/행동포즈/구도스타일/배경장소/사물아이템/2차창작메타/성인용/기타.',
                tech: 'generate.js의 카테고리 분류 로직 + tags_ko.json(위키 규칙기반) + tag_categories_extra.json(4개 소스 병합: danbooru-tags-classified CSV, 아카라이브 위키, NovelAI 원본 시트 — 총 173,411개). tag_categories_extra.json은 반드시 tags_ko.json과 같은 web/js 폴더에 있어야 함. ⚠️ cache:"force-cache"로 불러오므로, 이 파일 수정 후엔 브라우저 하드 리프레시(Ctrl+Shift+R) 필요 — 콘솔에 "tag_categories_extra.json 병합 N개" 로그로 최신본 확인.'
            },
            {
                name: '📷 카메라 구도 팝업 (신규, 다른 노드에서 이식)',
                desc: '공통 긍정 (Positive) 이름 옆의 "📷 구도" 버튼 → 팝업. 3D 미리보기에서 카메라 방위·높이·거리·롤을 드래그/휠로 맞추면 카메라 프롬프트(예: (from front:1.50), (low angle:1.20) …)가 만들어지고, 기본으로 "바꿀 때마다 공통 긍정프롬프트에 자동 반영"되어 이전 구도가 새 구도로 교체됨(내가 쓴 다른 프롬프트는 그대로). 긍정프롬프트 안의 구도 태그를 인식해서 칩으로 보여주고 클릭으로 하나씩 끄기/켜기(글자는 그대로, 생성에서만 빠짐), "전부 무효화", [🧩 조각으로 만들기]("📷 구도" 그룹의 조각으로 빼내고 바로 대기열에 추가)를 지원. 조각 편집창의 "이 조각 전용 키워드 무효화"에서도 그 조각 프롬프트 안의 구도 태그를 클릭으로 끄고 켤 수 있음. "생성에 자동 적용"을 켜면 생성할 때마다 구도를 긍정프롬프트 맨 뒤에 붙이고(프리셋 랜덤 가능, 기본 꺼짐), 프리셋·태그 문구·가중치 설정(기본 가중치는 그림이 깨지지 않게 최대 1.5)도 팝업 안에서 조절. 🆕(기능 확장: 카메라 구도 ↔ 여러 각도 일괄 생성) "📐 전체 각도 일괄 생성" 버튼 — "프리셋 랜덤"이 생성마다 프리셋 중 하나를 무작위로 고르는 것과 달리, 이건 등록된 프리셋 전부를 순서대로 1장씩(캐릭터 시트처럼 "정면/왼쪽/오른쪽/후면" 전부를 한 번에) 생성한다. 확인창 후 한 장씩 차례로(동시에 여러 장 안 쏨) 진행하고, 도중에 기존 "생성 취소"를 누르면 다음 각도부터 중단됨. 다른 사람이 만든 ComfyUI-KR-Camera-Control(원본: ComfyUI_bsk_UI, © 2026 灰暗x)을 이식한 것이라 AGPL-3.0-or-later 조건이 적용됨.',
                tech: 'tools_camera.js (별도 파일, /assetmanager/static/js/ 에 두고 index.html에서 로드). 알고리즘은 원본 camera_control.js·Python 노드와 4500건 비교로 동일 확인. 상태는 localStorage "am_camera_v1"(구도 값, 설정, 프리셋, 자동 반영/무효화/끈 태그). 긍정프롬프트 교체: replaceCompositionInPrompt(), 인식: recognizeCompositionTags(), 생성 연동: generate.js applyCameraComposition() → applyCameraCompositionToPrompt() (본 생성/스케치/저장 후 즉시 출력의 최종 조립 마지막 단계). 조각 만들기: library.js createCompositionPiece(), 조각 편집창 칩: refreshCompInvalidateChips(). 🆕 generateAllPresetAngles()(camera-gen-all-angles-btn) — config.camera_presets를 순회하며 매번 computePrompt()+appendUserPrompt()로 그 프리셋의 구도 프롬프트를 계산해 replaceCompositionInPrompt()로 base-pos에 끼워넣고 window.executeGeneration()을 await로 순차 호출(한 장 끝나야 다음 프리셋 시작). 루프 도는 동안만 autoApply를 임시로 꺼서, applyDisabledTokens() 내부에서 또 호출되는 applyCameraCompositionToPrompt()가 "프리셋 랜덤"으로 한 번 더 끼어들어 방금 넣은 프리셋과 충돌하는 걸 막음(끝나면 원래 값으로 복원). ⚠️ AGPL 파일이므로 배포/공유 시 라이선스 표기와 소스 제공 조건을 지켜야 함.'
            },
            {
                name: '🔤 태그 자동완성: 밑줄/공백 표기 합치기 (신규)',
                desc: '프롬프트 칸에서 영어 태그를 치거나 한글로 쳤을 때 뜨는 자동완성에서, 데이터에 "smile gesture"와 "smile_gesture"처럼 밑줄만 다른 같은 태그가 따로 들어 있어도 이제 후보가 하나로 합쳐져서 한 번만 뜸. 남기는 표기는 ① 사용횟수가 더 많은 쪽 ② 횟수가 같으면 한글 뜻(설명)이 더 긴 쪽 ③ 그것도 같으면 입력 중인 표기(밑줄을 쳤으면 밑줄, 띄어쓰기를 쳤으면 공백) ④ 그래도 못 정하면 기본 설정(사용횟수 우선) 순서. 한글 정확일치는 후보가 1개로 합쳐져서 콤마를 치면 자동으로 영어 태그로 바뀜. 영어 자동완성/한글 정확일치/한글 유사검색 세 경로 모두 같은 규칙.',
                tech: 'korean_autocomplete.js — collapseTagVariants()/tagVariantKey()/preferredFormFromQuery()/lookupExact(). getEnSuggestions()는 합친 뒤에 개수 제한(MAX_SUGGESTIONS)을 걸고, getFuzzySuggestions()는 같은 태그가 나오면 사용횟수/설명이 더 나은 표기로 그 자리에서 교체. DEFAULT_TAG_FORM(\'count\'|\'space\'|\'underscore\')으로 기본 표기를 바꿀 수 있음. tags_ko.json 데이터 자체는 수정하지 않음(화면에서만 합침).'
            },
            {
                name: '📖 태그 사전 "!" 버튼 (기능 도움말 신설 전부터 있던 기능 — 누락분 추가등록)',
                desc: '프롬프트 칸 자동완성 드롭다운이 뜨면, 각 후보 항목 오른쪽에 작은 "!" 버튼이 같이 뜬다. "!"를 누르기 전엔 아무 반응 없고, 누르면 그 태그의 한글명·카테고리·상세 설명·관련 키워드·사용횟수가 풍선(말풍선)으로 뜸 — 그 항목을 클릭해서 "선택"하는 동작과는 완전히 분리되어 있어서, "!"를 눌러도 프롬프트 칸에 태그가 들어가지 않는다(순수하게 "이 태그가 무슨 뜻인지" 바로 찾아보는 용도). 같은 "!"를 다시 누르거나 풍선 밖을 클릭하거나 Esc를 누르면 닫힘. 자동완성 드롭다운이 document.body에 새로 생길 때마다 MutationObserver로 감지해서 버튼을 주입하는 방식이라 별도 초기화 없이 항상 동작. v1(텍스트박스 아래에 칩으로 나열하던 방식)은 태그 수가 많을 때 너무 난잡해져서 폐기하고 v2(드롭다운 항목에 버튼 끼워넣기)로 교체됨. 🆕(모델 정보 모달 ↔ 태그 사전 연결) 이 "!" 버튼이 자동완성 드롭다운 전용이 아니게 됨 — window.TagDictionary라는 작은 공개 API(lookup/openBubbleFor/createBangButton/isReady)를 새로 노출해서, ℹ️ 모델 정보 모달의 트리거 워드/태그 칩처럼 다른 화면에서도 같은 "!" 버튼·풍선을 재사용할 수 있게 됨.',
                tech: 'tag_dictionary.js (별도 파일, /assetmanager/static/js/ 에 두고 index.html에서 로드) — injectBangButtons()가 .ko-ac-dropdown(korean_autocomplete.js가 띄우는 드롭다운)의 자식 추가를 bodyObserver(MutationObserver)로 감시하다가 .ko-ac-item마다 .tag-dict-bang 버튼을 주입. 버튼은 mousedown 단계에서 stopPropagation()으로 korean_autocomplete.js의 행(row) 선택 핸들러보다 먼저 가로채서 "!" 클릭이 태그 선택으로 안 이어지게 막음. 데이터는 korean_autocomplete.js와 동일한 tags_ko.json을 재사용(fetch, enIndex Map으로 보관). 풍선 표시/위치는 openBubble()/positionBubble(). 🆕 window.TagDictionary.createBangButton(tagText) — 자동완성용과 똑같은 .tag-dict-bang을 만들되, 원래 CSS가 .ko-ac-item(position:relative) 안에서 absolute로 붙게 설계돼 있어서 그런 부모가 없는 재사용 맥락에선 position:static으로 풀어서 반환. 외부(ui_manager.js의 showModelInfo() 등)에서 이 API로 "!" 버튼을 직접 만들어 원하는 자리에 appendChild 하면 됨.'
            },
            {
                name: '@작가명 / artist:이름 인식',
                desc: '이 표기 형식을 감지해서 자동으로 "작가" 카테고리로 분류. 밑줄(_)과 공백은 서로 같은 걸로 취급(정규화).',
                tech: 'generate.js 카테고리 분류 로직 내 정규식 처리 부분.'
            },
            {
                name: '🚫 이 조각 전용 키워드 무효화',
                desc: '이 조각을 쓸 때만, 공통 긍정/부정 프롬프트 중 지정한 키워드를 최종 조립 시점에 제외한다. 예: 출력할 게 "사과"인데 공통 부정프롬프트에 "과일"이 있으면, 이 조각의 무효화 칸에 "과일"을 적으면 이 조각으로 생성할 때만 부정프롬프트에서 "과일"이 빠짐(다른 조각 쓸 땐 그대로 남음). 원본 base-pos/base-neg 값 자체는 안 건드림. 여러 조각을 조합(Shift+Ctrl 합치기 제외)해서 큐에 넣으면 각 조각의 무효화 키워드가 전부 합쳐짐. 🆕 입력칸 아래에 공통 긍정프롬프트(공통+행동)와 공통 부정프롬프트가 프롬프트 색깔과 같은 색 태그로 보이고, 태그를 클릭하면 그 단어가 무효화 칸에 자동으로 들어가며(취소선 = 이 조각에서 꺼짐) 다시 클릭하면 켜짐. 칸에 직접 타이핑해도 표시가 같이 바뀜.',
                tech: '클릭 토글 칩: makeToggleChip()/refreshInvalidateChips() — library.js (색은 generate.js classifyPromptTag, 켜짐/꺼짐 판정은 실제 필터와 같은 "가중치 벗기고 소문자" 정확일치). item.posInvalidate/item.negInvalidate — library.js 편집모달(#edit-pos-invalidate-value/#edit-neg-invalidate-value). 집계는 getItemPosInvalidate()/getItemNegInvalidate()/collectPosInvalidateForRefs()/collectNegInvalidateForRefs() — library.js. 실제 필터링은 generate.js의 filterTokensFromPromptByList()/applyItemTokenInvalidation() (전역 "무력화 키워드" applyDisabledTokens와 필터 로직 공유). ⚠️ Shift+Ctrl로 합쳐진(_combined) 조각은 실제 category.items에 없는 합성 id라서 이 무효화(및 로라/부정프롬 등 다른 전용설정 전부 동일)가 적용 안 되는 기존 한계 있음(2026-09 확인, 미해결).'
            },
            {
                name: '🔽 "이 조각 전용 설정"들 기능별로 개별 접기 (아이콘만 남김)',
                desc: 'img2img🖼️/컨트롤넷🎛️/검열🔞/부정프롬📝/키워드무효화🚫/조건부변화🔀/카테고리차단🧱/시드그룹🔗/후방뷰🙈/부모제약조건🧷/지정번호🔢/전용로라🎨 — 조각당 붙는 전용 설정이 계속 늘어서 편집 모달이 너무 길어짐. 화면 위쪽 큰 섹션들을 완전히 접었을 때와 똑같은 방식으로, 접으면 그 필드 박스 전체가 사라지고 이모티콘 버튼 하나만 공용 줄에 남는다 — 그 아이콘에 마우스를 올리면(툴팁) 원래 뭐였는지 뜨고, 클릭하면 다시 펼쳐진다. 펼쳐진 상태에서는 라벨 옆에 작은 "▲ 접기" 링크로 다시 접을 수 있다. 조각을 열 때마다, 그 조각에 실제로 저장된 값이 있는 필드는 접혀있어도 자동으로 펼치고, 값이 없는 필드는 자동으로 접는다. 🐛 버그 수정(2중태그/접기 버그 제보 세션): "값 있으면 펼침"만 있고 "값 없으면 접음"이 빠져있어서, A 조각(예: 카테고리차단 켜짐 → 자동으로 펼쳐짐) 편집 후 그 필드가 비어있는 B 조각을 열면 A에서 펼쳐진 상태가 그대로 남아있는 버그가 있었음("접기 기능이 저절로 풀리는 것"처럼 보였던 현상) — 편집 모달의 필드 DOM을 조각마다 새로 안 만들고 재사용하는 구조라 생긴 문제였고, 이제 조각을 열 때마다 값 유무로 펼침/접힘을 명확히 재설정하도록 고침.',
                tech: 'makeFieldCollapsible(groupEl, storageId, icon) — library.js, ensureItemPipelineFields()/ensureCustomNumberField()/ensureItemLoraField()에서 각 필드 그룹 생성 직후 호출. 공용 아이콘 줄은 #edit-field-collapsed-row (ensureSectionCollapsers()의 #collapsed-sections-row와 동일한 패턴). 동기화는 syncAllFieldCollapseStates(item) — openPromptEditModal에서 호출, 값 있으면 forceOpenCollapsibleField() 값 없으면 🆕 forceCloseCollapsibleField()(이번에 추가, applyState(true) 호출). 접힘 상태의 "기본값"(수동으로 펼쳐둔 채 쓰고 싶은지)은 localStorage의 am_field_collapsed_* 키(필드 종류별로 공유 — 조각별 아님, 🔀=condrules, 🧱=catblock)로, 조각별 자동 펼침/접힘은 이 기본값과 별개로 매번 그 조각의 실제 값만 보고 강제 적용됨.'
            },
        ]
    },
    {
        title: '4. 참조 이미지 / 컨트롤넷 / Img2Img / 인페인팅',
        items: [
            {
                name: '🆕 알트클릭 도움말 등록됨',
                desc: 'IP-Adapter/컨트롤넷/Img2Img/인페인팅 4개 체크박스 전부 Alt+클릭 도움말 등록됨.',
                tech: 'ELEMENT_HELP_MAP의 toggle-ipadapter/toggle-controlnet/toggle-img2img/toggle-inpaint — library.js.'
            },
            {
                name: 'IP-Adapter, ControlNet, Img2Img, Inpaint 토글',
                desc: '각각 체크박스로 켜면 하위 옵션(모델, 강도, 디노이즈 등)이 펼쳐진다. 조각(라이브러리 항목) 단위로 개별 오버라이드도 가능 (편집 모달에서 설정).',
                tech: 'toggle-ipadapter/toggle-controlnet/toggle-img2img/toggle-inpaint — toggleSubOptions() (ui_manager.js). 🐛 예전엔 "실제 적용은 generate.js" 라고 적혀있었는데 틀렸음, 바로잡음 — 실제 파이프라인 적용은 각각 pipeline_ipadapter.js/pipeline_controlnet.js/pipeline_img2img.js/pipeline_inpaint.js에 분리되어 있고(pipeline_inpaint.js는 pipeline_facedetect.js의 YOLOv8-face 자동 얼굴 마스킹과도 연동), generate.js는 이 함수들을 호출만 함. 자세한 내부 동작은 각 toggle 항목(ELEMENT_HELP_MAP) 참고.'
            },
        ]
    },
    {
        title: '5. 후처리 옵션',
        items: [
            {
                name: '🆕 알트클릭 도움말 등록됨',
                desc: '업스케일/디테일러/모자이크 체크박스 3개 Alt+클릭 도움말 등록됨.',
                tech: 'ELEMENT_HELP_MAP의 toggle-upscale/toggle-detailer/toggle-mosaic — library.js.'
            },
            {
                name: '업스케일 / 디테일러(얼굴·눈·입·손) / 모자이크',
                desc: '생성 후 자동으로 적용되는 후처리 단계들. 모자이크는 부위별(꼭지/보지/자지/항문/고환/X-Ray/단면) 개별 검열 on/off와 강도 조절 가능.',
                tech: '🐛 예전엔 "generate.js" 라고 적혀있었는데 틀렸음, 바로잡음 — pipeline_upscaler.js의 applyUpscalerPipeline(), pipeline_detailer.js의 applyDetailerPipeline(), pipeline_censor.js의 applyCensorPipeline(). 자세한 내부 동작은 각 toggle 항목(ELEMENT_HELP_MAP) 참고.'
            },
        ]
    },
    {
        title: '6. 프롬프트 라이브러리',
        items: [
            {
                name: '🆕 알트클릭 도움말 등록됨',
                desc: '시드그룹명 입력칸, 작가 순차 테스트 시작 버튼, 이 조각 기본 반복 횟수 입력칸, 세트 전송/퀵생성/전체 자동병합 버튼 Alt+클릭 도움말 등록됨.',
                tech: 'ELEMENT_HELP_MAP의 edit-seedgroup-value/artistStyleTestStart/edit-prompt-repeatcount/btn-send-set-queue/btn-quick-send/btn-auto-merge-all — library.js.'
            },
            {
                name: '🧱 조각 전용 카테고리 차단 (신규)',
                desc: '조각 편집창의 "🧱 카테고리 차단"에서 의상/패션·얼굴 같은 카테고리를 클릭으로 차단/해제. 이 조각을 쓸 때만 최종 긍정프롬프트에서 그 카테고리 태그가 전부 빠지고, 미리보기에서 취소선으로 확인 가능. 분류는 프롬프트 색깔과 동일. 🐛 버그 수정: "red shirt"(색상+의상/패션), "hand in apple"(신체/외형+사물/아이템)처럼 🎨 다중 색상 배지로 카테고리 2개 이상으로 쪼개져 보이는 태그는, 예전엔 태그 전체를 "한 카테고리"로만 판정하는 바람에 둘 중 하나만 걸리고 나머지는 차단이 안 먹는 버그가 있었음(예: "사물/아이템"을 차단해도 "hand in apple"은 안 빠짐 — 판정이 "신체/외형"으로만 되고 있었어서). 이제 다중 색상 배지와 똑같은 방식으로 태그를 세그먼트별로 쪼개서, 그중 하나라도 차단 목록에 있으면 태그 전체를 뺌.',
                tech: 'item.blockCategories — library.js 편집모달(#edit-prompt-catblock). getItemBlockCategories()/collectBlockCategoriesForRefs() → job.blockCategoriesOverride. 적용은 generate.js applyItemCategoryBlock() → 🆕 tagHasBlockedCategory()(classifyPromptTagSegments()로 세그먼트 전체를 확인, 기존 classifyPromptTag 단일 판정에서 교체) (무효화 다음, 조건부 변화 전). 미리보기 쪽(refreshCatBlockPreview(), library.js)도 같은 세그먼트 판정으로 맞춤.'
            },
            {
                name: '🔀 조각 전용 조건부 프롬프트 변화 (신규)',
                desc: '조각 편집창의 "🔀 조건부 프롬프트 변화"에서 "긍정프롬프트에 A가 있으면 B를 추가"(예: apple→red clothes, orange→orange clothes) 규칙을 자유롭게 추가/삭제. 조건 단어는 콤마로 여러 개, "대신 지울 단어"로 기존 태그 교체도 가능. 이 조각이 들어간 생성에서만 적용. 🆕 각 조건 아래에는 이 조각의 프롬프트가 색깔 태그로 보이는데, 위쪽 모드 선택에 따라 태그를 클릭하면 "대신 지울 단어"(취소선 = 발동 시 꺼짐) 또는 "조건 단어"(🎯 표시)에 넣고 뺄 수 있어서 단어를 직접 치지 않아도 됨.',
                tech: 'item.condRules — library.js 편집모달(#edit-prompt-condrules, renderCondRuleRow/renderItemCondRulesField). getItemCondRules()/collectCondRulesForRefs() → job.condRulesOverride. 판정/적용은 generate.js applyItemConditionalRules() (무효화 다음 단계). 클릭 칩: refreshCondRuleChips()/makeToggleChip() — library.js. ⚠️ _combined 합성 조각은 소스 조각 규칙을 취합해서 적용함.'
            },
            {
                name: '작품/그룹/조각 구조',
                desc: '작품(카테고리) → 그 안에 여러 조각(item). 조각은 버전(variants)을 여러 개 가질 수 있고 ◀▶로 전환.',
                tech: 'getAllCategories() — library.js. 저장은 debounceLibrarySave()/saveLibrary().'
            },
            {
                name: '🔗 시드 동일화 그룹',
                desc: '같은 그룹명을 붙인 조각들은, 한 번에 대기열에 넣으면 전부 같은 시드를 공유한다 (재실행마다 새 시드로 롤). 그림체/구도 비교에 유용.',
                tech: 'getOrRollSeedForItem()/getOrRollSeedForRefs()/resetSeedGroupRollsForBatch() — library.js.'
            },
            {
                name: '🎭 작가 순차 스타일 테스트',
                desc: '등록된 작가들을 등록 순서 그대로, 전부 같은(공유) 시드로 대기열에 순서대로 추가 — 그림체만 순수 비교용. 🎨 랜덤 작가 섞기 목록과는 별개 기능.',
                tech: 'runArtistStyleTest() — library.js (약 3936번 줄 근처).'
            },
            {
                name: '🆕 이 조각 기본 반복 횟수',
                desc: '조각 편집 모달에서 "이 조각 기본 반복 횟수"를 지정해두면, 전송 시 화면 상단의 전역 반복횟수 입력값과 무관하게 이 조각은 항상 지정한 횟수만큼 대기열에 반복 등록된다. 타율(성공률)이 낮은 프롬프트에 미리 넉넉하게 박아두는 용도. 비워두면 기존처럼 전송 시점의 전역 반복횟수를 그대로 따름. 여러 조각을 합쳐서(Shift+Ctrl) 보낼 때는 조합 안에 지정된 조각이 여럿이면 그중 최댓값을 사용.',
                tech: 'item.defaultRepeatCount — ensureItemRepeatField()/savePromptEditModal()에서 편집. getItemDefaultRepeatCount(item)(단일 조각) / collectMaxRepeatCountForRefs(refs)(조합) — library.js. sendSingleItemToQueue(), quickSendItems(), 실행버전 executeVariantRangeSend(), sendSetToQueue(), executeRangeSend() 각각에서 전역 rCount보다 우선 적용.'
            },
            {
                name: '🙈 후방뷰 얼굴가중치 하락',
                desc: '뒷모습(후방뷰) 구도일 때 얼굴 관련 가중치를 자동으로 낮춰주는 옵션. 조각 편집 모달의 체크박스로 켬/끔 (카드 버튼 방식이었다가 사용성 피드백으로 체크박스로 변경됨).',
                tech: 'item.backViewFaceWeightDown 플래그 — library.js 편집 모달, collectBackViewFaceFlagForRefs()로 대기열 job에 전달.'
            },
            {
                name: '🛠️ 세트 조합 / 📥 세트를 대기열로 전송',
                desc: '여러 그룹에서 조각을 하나씩 선택해서 조합을 만들고, 조합 가능한 전체 경우의 수(카르테시안 곱)를 한 번에 대기열로 보낸다. requires 제약조건이 있으면 그 조건 어긴 조합은 자동 제외.',
                tech: 'sendSetToQueue(), buildSelectedGroupArrays(), isValidCombination() — library.js.'
            },
            {
                name: '⚡ 퀵생성 (N개씩 순차 전송)',
                desc: '그룹 안 조각들을 지정한 개수(기본 5개)씩 잘라서 순서대로 대기열에 보낸다. ◀▶로 구간 이동.',
                tech: 'quickSendItems()/quickSendPrev()/quickSendNext() — library.js.'
            },
            {
                name: '🧩 전체 조각 자동 병합',
                desc: '이름 끝 번호/버전 표시(1, .2, _3, (4), v5 등)만 다르고 나머지 이름이 같은 조각들을 자동으로 하나의 조각(버전들)으로 합쳐준다.',
                tech: 'autoMergeAllCategories(), scanMergeableGroups(), baseNameKey() — library.js.'
            },
        ]
    },
    {
        title: '7. 대기열 (Job Queue)',
        items: [
            {
                name: '🆕 알트클릭 도움말 등록됨',
                desc: '큐 시작/반복출력/이미지검수 열기/검수시작 버튼 Alt+클릭 도움말 등록됨.',
                tech: 'ELEMENT_HELP_MAP의 btn-start-batch/btn-start-batch-repeat/btn-review/reviewStart — library.js.'
            },
            {
                name: '대기열 목록 / 항목별 편집·비활성화·삭제',
                desc: '쌓인 작업들을 한 줄씩 보여주고, 항목 클릭으로 편집 모달을 열거나(1개짜리는 라이브러리 편집 모달, 여러 개 조합이면 대기열 전용 편집 모달), 비활성화(건너뛰기)/삭제 가능.',
                tech: 'renderJobQueue(), addJobToQueue(), toggleJobDisabled() — generate.js. jobQueue는 generate.js의 모듈 스코프 변수(let jobQueue = []).'
            },
            {
                name: '◀▶ 대기열 항목 편집 모달에서 이전/다음으로 바로 이동',
                desc: '대기열 항목의 편집 모달(✏️)을 열어둔 채로, 모달을 닫았다 다시 여는 과정 없이 바로 이전/다음 항목으로 이동. 조각 1개짜리 항목(prompt-edit-modal)과 여러 조각 조합 항목(job-edit-modal) 둘 다 지원. 지금 항목의 수정 내용은 자동 저장 후 이동, 비활성화된 항목은 건너뜀. 단축키는 ⌨️ 단축키 도움말에서 변경 가능 (기본: Alt+↑ 이전 / Alt+↓ 다음).',
                tech: 'navigateJobEditModal() — generate.js (job-edit-modal용). navigateQueueEditorFromPromptModal() — library.js (prompt-edit-modal용, activeQueueSyncTarget 기준). 실제 어느 모달을 열지는 handleQueueItemBodyClick()이 판단(조각 개수 기준) — generate.js. 단축키 정의는 SHORTCUT_DEFS.queuePrevItem/queueNextItem — library.js.'
            },
            {
                name: '🚀 큐 전체 순차 생성 시작',
                desc: '대기열에 쌓인(비활성화 안 된) 항목들을 순서대로 하나씩 생성 실행. Enter 키(입력창/모달 없을 때)로도 바로 시작 가능.',
                tech: 'startBatchGeneration() — generate.js.'
            },
            {
                name: '📋 실행 로그 패널 + 🩺 간단 진단 (신규)',
                desc: '"⏹ 생성중지" 옆 "📋 로그 ▼"를 펼치면 노드 실행 로그가 보이는데, 이제 (1) 맨 위에 "🩺 간단 진단" 한 줄이 떠서 지금 어느 노드(예: 체크포인트 로더, VAE 디코드, KSampler)에서 막힌 것 같은지를 신호등(🔴 문제 / 🟡 의심 / 🟢 정상 진행 / ⚪ 이상 없음)과 함께 알려주고 — 의심될 땐 그 단계에서 흔한 원인 한 줄(예: VAE는 VRAM 부족, 체크포인트는 모델 로딩 지연)도 보여줌, (2) 실행 중인 노드 줄에 경과 초가 실시간으로 붙고 마지막 신호 후 30초↑는 주황+⚠️, 90초↑는 빨강으로 바뀜, (3) 끝난 노드 줄에는 그 노드가 걸린 시간이 남음. 진단 줄을 클릭하면 빠른 진단 팝업이 열리고, 로그를 접어두면 이 기능도 같이 쉼. 같은 신호등이 🩺 버튼(생성중지 옆)에도 표시됨. 추정이지 확정은 아니니 근거는 🛠️ 도구 → 🩺 에셋매니저 진단에서 확인.',
                tech: 'generate.js installAmDiagRecorder() 5번 블록의 setInterval(1초) — #node-log-panel 맨 위에 #node-log-diag(sticky)를 만들고 amDiagInfer()(library.js) 1순위 결과를 표시, 활성 줄(.log-entry.active)에 .log-elapsed span 부착. panel.offsetParent===null(접힘)이면 건너뜀. pushNodeExecutionLog()/resetNodeExecutionLog()는 수정 없음(reset이 헤더를 지워도 1초 안에 재생성). 클릭은 openAmDiagQuick().'
            },
            {
                name: '⬆️ 검수 완료 후 승인된 파일 일괄 업스케일 (신규)',
                desc: '🖼️ 이미지 검수를 끝까지 마치고(모든 항목 판정) "좋음"으로 저장한 파일이 있으면, 검수 화면 위쪽에 "⬆️ 승인된 N장 일괄 업스케일" 버튼이 나타남. 누르면 창이 열리고 방식이 두 가지임 — 위쪽 기본은 🖼️ 일반 업스케일(서버에서 Lanczos 보간으로 확대: 빠르고 무료, 토큰 불필요, AI 업스케일 아님, PNG는 프롬프트 메타데이터 유지), 아래쪽은 🎨 NAI 업스케일(AI 복원, NAI 토큰 필요, Anlas 안 듦, 느림). 결과는 각 원본이 있는 폴더 안의 하위 폴더(일반=upscaled / NAI=upscaled_nai)에 같은 파일명(.png)으로 저장되고 원본은 그대로 남음. 진행바/장별 결과가 보이고 ⏹ 중지가 가능하며, 이미 만든 파일은 건너뛰므로 멈췄다가 다시 눌러도 이어서 처리됨. NAI는 요청 과다(429)는 대기 후 재시도, 토큰 오류(401)·Anlas/구독 문제(402)는 즉시 중단.',
                tech: 'library.js의 updateReviewUpscaleButton()/openBatchUpscaleModal()/runBatchUpscale(method) (showCurrentReviewImage()를 감싸서 항상 버튼 상태 갱신). 백엔드 __init__.py의 api_upscale_file(POST /assetmanager/api/upscale_file {path, scale, outSubfolder, skipExisting}) / api_nai_upscale_file(POST /assetmanager/api/nai_upscale_file, 추가로 token). ⚠️ 새 라우트라 __init__.py 반영 후 ComfyUI 재시작 필요(404면 미반영).'
            },
            {
                name: '🆕 검수 화면에 번호표 대조 결과 표시',
                desc: '🛠️ 도구 → 🔢 조각 번호표/대조에서 그룹별 "(사과,딸기,바나나)" 기대 목록을 적어두면, 🖼 이미지 검수 화면의 조각 이름 옆에 그 조각의 번호가 기대 목록과 맞는지 ✅ 일치 / ❌ 불일치(기대값 + 실제 이름)로 같이 표시됨. 단일 보기와 그리드 보기 모두 적용되고, 도구 탭의 "검수 화면에 일치/불일치 표시" 체크박스로 끌 수 있음.',
                tech: 'getNumCheckBadgeForJob()/appendNumCheckBadge() — library.js. showCurrentReviewImage()의 #review-item-label 뒤에 span으로 덧붙임. 설정은 localStorage "am_numcheck_v1".'
            },
            {
                name: '🖼 이미지 검수 도구',
                desc: '대기열에서 이미 생성된 결과 이미지들을 👍좋음(대기열에서 제거+지정폴더 저장)/👎나쁨(대기열에 그대로 두고 재시도 가능) 판정. 새로고침으로 끊겨도 이어서 진행됨. 같은 job이 반복생성으로 여러 장을 만들었으면 한 장씩 넘기는 대신 그리드로 동시에 보여줌(아래 항목 참고).',
                tech: 'reviewState 객체, showCurrentReviewImage(), reviewDecide() — library.js (4780번대~).'
            },
            {
                name: '🆕 검수 시 반복 결과 그리드 동시확인',
                desc: '반복생성(repeatCount>1)으로 같은 job이 여러 장을 만들면, 예전엔 "반복 N/M"이라고 표시만 되고 한 장씩 순서대로만 볼 수 있었다. 이제 같은 job의 결과가 여러 장이면 자동으로 그리드 모드로 전환돼서 한 화면에 다 같이 보면서 각각 개별로 👍/👎 판정 가능. 묶음 안의 전부가 판정되면 자동으로 다음 항목/묶음으로 넘어감. ↩ 취소로 그리드 안에서 개별 판정만 되돌리기도 가능. ◀▶ 이동은 묶음 단위로 건너뜀.',
                tech: 'getReviewClusterIndices(), reviewDecideGridCell(), reviewUndoGridCell() — library.js. showCurrentReviewImage()가 cluster.length>1일 때 #review-grid-frame으로 분기, 1개면 기존 #review-img-frame 단일모드 그대로 사용. 판정 공용 로직은 reviewDecideEntry(queueIndex, isGood, autoAdvance) — 단일모드(reviewDecide)와 그리드모드 둘 다 이걸 호출.'
            },
            {
                name: '🆕 검열 켜진 결과는 원본도 대조용으로 같이 표시',
                desc: '조각 전용 검열(모자이크 등)이 켜져서 원본+검열본이 한 쌍으로 나온 경우, 검수 화면에 검열본만 뜨면 실제로 제대로 가려졌는지 확인이 안 됐었다. 이제 검열본을 검수할 때 옆(단일모드)이나 셀 안(그리드모드)에 원본(비검열)을 대조용 참고 이미지로 같이 보여준다. 판정 자체는 여전히 검열본 기준이고, 원본은 별도의 검수 대상으로 잡히지 않는다(👍/👎 버튼 없음, 저장도 안 됨 — 순수 참고용).',
                tech: '생성 시점에 executeGeneration() 한 번당 결과 이미지들을 같은 genGroupId로 태그(generate.js, job.lastResults.push 부분) → isCensored 플래그로 원본/검열본 구분. findOriginalPairForResult(job, result) — library.js가 같은 genGroupId에서 isCensored:false인 짝을 찾음. getGeneratedResultEntries()에서 검열본이 있는 원본은 독립 검수대상 목록에서 제외.'
            },
            {
                name: 'Ctrl+클릭 즉시 저장',
                desc: '검수 도구를 거치지 않고, 이미지를 Ctrl+클릭 한 번으로 번호 매겨서 바로 지정 폴더에 저장. 이미 보낸 파일은 prompt_id까지 포함한 키로 중복 저장 방지.',
                tech: 'quickSendNumberedFile() — generate.js. review_accept API는 __init__.py의 api_review_accept.'
            },
            {
                name: '📖 새로고침 시 대기열 복원',
                desc: '대기열/배치모드 화면 상태 전체를 서버(app_state.json)에 저장해뒀다가 새로고침 시 복원. (2026-09 세션에서 이 라우트 자체가 없었던 걸 발견해서 새로 추가함 — 그전엔 새로고침하면 항상 사라졌었음.)',
                tech: 'state_manager.js의 saveState()/loadStateFromServer() ↔ __init__.py의 /assetmanager/api/save_state, /assetmanager/api/load_state.'
            },
            {
                name: '⚠️ 섹션 접기와의 상호작용 주의',
                desc: '대기열 섹션 자체도 다른 섹션들처럼 접을 수 있는데(▼▶ 아이콘), 접힌 채로 새로고침하면 그 접힌 상태가 localStorage에 남아있어서 "대기열이 안 보인다"고 오인하기 쉽다 — 실제로 2026-09 세션에 이걸로 한참 헤맸음. 안 보이면 먼저 접힌 섹션들 아이콘 줄부터 확인할 것.',
                tech: 'ensureSectionCollapsers(), section._forceExpand() — library.js.'
            },
        ]
    },
    {
        title: '8. 메모장 & 네비게이션 바',
        items: [
            {
                name: '🆕 알트클릭 도움말 등록됨',
                desc: '메모장/단축키/버튼단축키지정/기능도움말/모아보기/생성가이드 버튼 6개 Alt+클릭 도움말 등록됨. 상단 네비게이션 바 자체(숫자 이동)는 항목이 동적으로 생성돼서 개별 등록은 안 함 — 이 모달에서 계속 설명.',
                tech: 'ELEMENT_HELP_MAP의 memo-pad-toggle-btn/shortcut-help-btn/shortcut-bind-mode-btn/feature-help-btn/alt-help-catalog-btn/generation-guide-btn — library.js.'
            },
            {
                name: '🔰 생성 가이드 (처음이신가요?)',
                desc: '아키텍처 선택 → 체크포인트 → (선택)로라 → 프롬프트 정하기 → 고급설정 확인 → 대기열 → 생성 시작 → 검수/저장, 이 순서를 처음 쓰는 사람 눈높이로 풀어서 안내하는 단계별 가이드. 아키텍처별 차이/주의사항과 시드·CFG·가중치 문법 같은 기초 AI 그림 상식도 별도 항목으로 넣음. 인페인팅/Img2Img/컨트롤넷/IP-Adapter 같은 부가기능은 "나중에 배워도 되는 것"으로 일부러 뺌 — 기본 생성 흐름만 다룸. 각 단계 옆 "📍 이동" 버튼으로 실제 화면으로 바로 이동 가능(jumpToSection 재사용).',
                tech: 'GENERATION_GUIDE_STEPS 배열, openGenerationGuideModal(), ensureGenerationGuideButton() — library.js.'
            },
            {
                name: '📝 메모장 (여러 탭 + 외부 .txt 동기화)',
                desc: '배경 딤 없이 화면 다른 곳도 그대로 조작 가능한 팝업. 브라우저 탭처럼 여러 메모 관리, 외부 .txt 파일과 양방향 동기화.',
                tech: 'toggleMemoPad() — library.js. 동기화 API는 __init__.py의 /assetmanager/api/memo/*.'
            },
            {
                name: '🧭 상단 네비게이션 바 빠른 이동',
                desc: '숫자만 입력하면 그 번호의 큰 섹션(공통설정/고급설정/.../대기열/프롬프트 라이브러리)으로 실제 이동. Shift+숫자는 미리보기 팝업만. 네비게이션 바 아이콘 클릭도 동일(클릭=미리보기, Ctrl+클릭=이동).',
                tech: 'JUMP_SECTIONS 배열, jumpToSection(), peekSection() — library.js. ⚠️ 대기열 항목은 살아있는 DOM 노드라서 미리보기는 반드시 peekJobQueueSnapshot()(복제본)을 거쳐야 함 — 원본 노드를 옮기면 팝업이 비정상 종료될 때 노드가 증발하는 버그가 있었음(2026-09 수정).'
            },
            {
                name: '⌨️ 단축키 모음 / 📖 기능 도움말 / 🖱️ 알트클릭 도움말 모아보기 버튼',
                desc: '⚙️ 설정 버튼 옆에 나란히 붙는 버튼들. 단축키는 직접 재지정 가능, 이 기능 도움말은 이 파일(FEATURE_HELP_SECTIONS)만 고치면 바로 반영됨. "모아보기"는 Alt+클릭 도움말(ELEMENT_HELP_MAP)들을 한 화면에 섹션별로 펼쳐서 훑어볼 수 있는 목록.',
                tech: 'ensureShortcutHelpButton()/openShortcutHelpModal(), ensureFeatureHelpButton()/openFeatureHelpModal(), ensureAltHelpCatalogButton()/openAltHelpCatalogModal() — library.js.'
            },
            {
                name: '⌨️ 프롬프트 단축키가 팝업/모달 안 필드에서도 작동',
                desc: 'Alt+E(한↔영), "/"(가중치 추가) 같은 프롬프트 단축키가 원래 일부 필드(#base-pos 등)에서만 작동하고 조각 편집모달의 새 필드(키워드무효화 등)에서는 안 먹혔음 → 대상 필드 목록에 추가해서 모달 안에서도 동일하게 작동하도록 확장. 단, 📝 메모장 텍스트영역은 "순수 자유 메모용"이라는 원래 설계 의도대로 의도적으로 계속 제외됨(자유롭게 글 쓰다가 가중치 단축키가 오작동하는 걸 막기 위함).',
                tech: 'PROMPT_TEXT_FIELD_SELECTORS 상수 — library.js. 이 selector에 맞는 요소에서 keydown 이벤트가 잡히면 각 단축키 핸들러(Alt+E/, 등)가 동작. 새 필드를 만들 때마다 이 목록에 추가해야 단축키가 적용됨.'
            },
            {
                name: '🔗 "버튼에 단축키 지정" 팝업 열려있어도 켤 수 있음',
                desc: '지정 모드를 켜고 아무 버튼이나 눌러서 그 버튼 전용 단축키를 만드는 기능(🔗 버튼에 단축키 지정)이, 이 토글 버튼 자체가 네비게이션 바 안에 있다 보니 전체화면 팝업(job-edit-modal 등)이 열려있으면 팝업에 가려 눌리지가 않았음(팝업 안 버튼에는 애초에 지정 시도조차 못 함) → 버튼 자체의 위치/크기는 그대로 두고, 대신 키보드 단축키(기본 Ctrl+Alt+B)로도 지정 모드를 켤 수 있게 추가함. 팝업이 열려있어도 이 단축키만 누르면 지정 모드가 켜지고, 곧바로 그 팝업 안의 버튼을 클릭해서 단축키를 지정할 수 있음. (다만 팝업마다 다시 그려지는 버튼이면, 그 단축키는 같은 팝업이 다시 열려있을 때만 작동 — 기존에 문서화돼있던 한계.)',
                tech: 'SHORTCUT_DEFS.toggleButtonBindMode(기본 Ctrl+Alt+B) — library.js, toggleButtonBindMode() 바로 아래 keydown 리스너에서 matchesShortcutCombo로 감지. 원래 버튼(#shortcut-bind-mode-btn)의 스타일은 안 건드림.'
            },
            {
                name: '⚠️ 괄호 안 닫힘 경고',
                desc: '생성 시작 직전에 최종 조립된 긍정/부정 프롬프트의 "(" "," ")" 괄호 짝이 맞는지 검사. 안 맞으면 몇 개가 남는지 알려주고 그래도 계속할지 확인창을 띄움 — 취소하면 생성 자체가 안 나감. "\\(" "\\)"(리터럴 괄호 문자, danbooru 이스케이프 문법)는 가중치 강조 괄호가 아니므로 검사에서 제외됨.',
                tech: 'findUnbalancedParenMessage(posPrompt, negPrompt) — generate.js, executeGeneration() 맨 앞에서 호출(모든 생성 경로가 결국 이 함수를 거치므로 한 곳만 고치면 전체 적용됨).'
            },
            {
                name: '🔄 작가 표기 일괄 변환 (신규)',
                desc: '긍정 프롬프트(#base-pos)에서 인식되는 모든 작가 표기(맨 태그/(이름:가중치)/@이름/artist:이름/(artist:이름:가중치)/NAI 1.2::이름::/자연어 by 이름 — 총 6종)를, 🎨 랜덤 작가 섞기 버튼 옆 드롭다운에서 고른 형식 하나로 한 번에 통일해줌. "artist:" 같은 접두사가 그 체크포인트가 실제 학습한 형식인지는 모델마다 달라서(danbooru 태그 학습 모델은 접두사가 죽은 토큰이지만, e621/구조화 캡션으로 학습된 모델은 접두사를 실제로 학습했을 수 있음 — 검색해서 확인한 내용) 자동으로 바꿔버리지 않고, 사람이 결과를 보고 직접 형식을 골라 바꿀 수 있게 만듦. "artist:"/"@" 같은 표시(marker)가 없는 맨 태그나 괄호 가중치만 있는 태그(예: (rella:1.2))는 일반 태그와 글자만으로 구분이 안 돼서, 📝 작가 목록 관리에 등록해둔 이름과 일치할 때만 작가로 인식해서 바꾼다(미등록 태그는 절대 안 건드림).',
                tech: 'convertArtistTagsBulk() → convertArtistTagsTo(text, targetFormat) — library.js (addRandomArtists 근처). 형식 정의는 ARTIST_TAG_FORMATS. 맨 태그/괄호 가중치 인식은 getRandomArtistList()로 등록된 이름만 매칭(정규식 동적 생성, 긴 이름부터 매칭해 부분일치 오탐 방지). UI는 ensureRandomArtistUI()에서 #artist-format-select + 버튼으로 자동 삽입(index.html 안 건드림).'
            },
            {
                name: '🔄 NAI→ComfyUI 가중치 변환 (조각 편집 모달, 신규)',
                desc: '조각 편집 모달의 프롬프트 칸 옆 "NAI→콤피 변환" 버튼 — NovelAI에서 복사해온 프롬프트는 {단어}(강조)/[단어](약화) 중괄호·대괄호 문법을 쓰는데, 이 프로그램(ComfyUI)의 프롬프트는 (단어:1.2) 숫자 가중치 문법을 쓰기 때문에 그대로 붙여넣으면 괄호가 그냥 글자 취급돼서 가중치가 하나도 안 먹는다. 이 버튼을 누르면 그 자리에서 바로 (단어:N.NN) 형식으로 바꿔줌. {단어} 하나당 ×1.05, [단어] 하나당 ×(1/1.05)이고 중첩할수록 누적 곱해짐(예: {{red hair}} → (red hair:1.10)). 최신 NAI처럼 {단어:1.3}로 숫자를 직접 적은 경우엔 그 숫자를 그대로 가져다 씀. ⚠️ 이 프로그램이 따로 쓰는 "{선택1|선택2}" 프롬프트 랜덤화 문법과 구분하기 위해, "|"가 들어있는 중괄호는 NAI 강조로 보지 않고 원문 그대로 보존함(랜덤화 기능 안 깨짐).',
                tech: 'convertEditPromptNaiToComfy() → convertNaiWeightSyntaxToComfy(text) — library.js. 재귀 하향식 파서로 중첩 괄호를 누적 배율로 계산, "|" 포함 중괄호는 재귀 안 하고 원문 그대로 buf에 보존(프롬프트 랜덤화 문법과의 충돌 방지). 버튼은 index.html #edit-prompt-value 라벨 옆에 직접 추가.'
            },
            {
                name: '🎨 다중 색상 배지 — "red shirt" 같은 수식어 태그',
                desc: '프롬프트 색상 미리보기/태그 칩에서, "red shirt"(색상+아이템)나 "two girls"(수량+인물), "two big red hats"(수량+크기+색상+아이템)처럼 태그 맨 앞에 수량·크기·색상 수식어가 붙은 경우, 세그먼트마다 자기 색으로 두른 작은 알약을 이어붙여서(예: (two)(big)(red)(hats)) 각 부분이 뭘로 인식됐는지 한눈에 보여줌(마우스 올리면 "수량 + 크기 + 색상 + 의상/패션"처럼 구성도 표시). 바깥쪽 모서리만 둥글게 해서 "이어붙인 하나의 태그"라는 느낌은 유지함. 🔧 예전엔 배지 하나를 그라데이션으로 나눠 칠하는 방식이라 글자가 색 경계선 위에 걸쳐서 가독성이 떨어졌는데, 이 문제를 고치면서 지금 방식(세그먼트별 독립 알약)으로 교체됨. 수식어가 없는 보통 태그는 기존과 완전히 동일(단색 배지 1개). 🐛 버그 수정: "black hair", "large breasts"처럼 그 자체로 이미 danbooru에 등록된 완전한 태그는, 앞 단어가 색상·크기 단어 목록에 우연히 걸려도 더 이상 쪼개지지 않고 통째로 배지 1개로 나옴(예전엔 "black"이 색상으로 인식돼서 "색상 + 신체/외형"으로 잘못 쪼개졌었음). "hand in apple"처럼 수량/크기/색상 수식어가 아니어도, 통째로는 분류가 안 되는 여러 단어짜리 구는 관사/전치사(in/on/of 등)를 건너뛰고 단어 하나하나를 다시 분류해봐서, 2종류 이상 인식되면("hand"→신체/외형, "apple"→아직 기타처럼) 그 조합으로 쪼개서 보여줌 — 둘 다 기타거나 한 종류뿐이면 쪼개는 의미가 없어서 기존처럼 1개로 유지됨. ✦(희귀 카테고리 표시)는 바깥에 따로 안 뜨고 마지막 조각 배지 안쪽 글자 뒤에 붙음.',
                tech: 'classifyPromptTagSegments() — generate.js. 0단계(🐛 버그수정): 쪼개기 전에 TAG_CATEGORY_MAP.has(bare)로 태그 전체가 이미 알려진 단일 태그인지 먼저 확인, 맞으면 안 쪼개고 그대로 반환. 1단계: PROMPT_QUANTITY_WORDS → PROMPT_SIZE_WORDS(🆕 3번째 수식어 그룹) → PROMPT_COLOR_WORDS 순서로 태그 맨 앞부터 떼어냄(PROMPT_CATEGORY_COLORS에 "수량"/"크기"/"색상" 3개). 2단계: 남은 부분은 classifyPromptTagByWords()가 PROMPT_STOPWORDS(관사/전치사)를 건너뛰고 단어별로 classifyPromptTag() 돌려본 뒤, 연속 동일 카테고리는 병합(이때 각 세그먼트에 실제 해당 단어 글자(text)도 같이 저장)하고 서로 다른 카테고리가 2개 이상일 때만 그 결과를 채택(세그먼트 2~4개로 제한). 렌더링: generate.js의 promptSegmentBadgeHtml()/renderCategorizedPromptHtml()과 library.js의 promptSegmentBadgeHtmlNode()/makeToggleChip() — 양쪽 다 세그먼트별 독립 알약 디자인으로 통일되어 있음(한쪽만 고치면 다시 불일치 생기니 디자인 바꿀 때 항상 같이 수정). ⚠️ 중요: 🧱 조각 카테고리 차단/🚫 키워드 무효화 등 실제 분류·필터링 로직은 전부 classifyPromptTag()(단일 결과)를 그대로 쓰고 이 기능과 완전히 분리되어 있어서 영향 없음 — 이건 순수 표시 전용.'
            },
        ]
    },
    {
        title: '9. 도구 (메타데이터 뷰어 / 단독 검열기 / 퀵 리사이저)',
        items: [
            {
                name: '🧩 워크플로우 이미지 실행 (신규 도구 탭)',
                desc: '🛠️ 도구 ▼ → "🧩 워크플로우 이미지 실행". 다른 사람이 만든 ComfyUI 워크플로우가 들어 있는 이미지(PNG/WebP) 또는 API 형식 .json을 넣으면 그 워크플로우를 이 ComfyUI에서 그대로 실행해 결과를 뽑음. 넣자마자 이 ComfyUI에 없는 노드/모델 파일을 미리 알려주고(❌), 코드 실행이 가능해 보이는 노드(exec/eval/python/shell 이름)는 ⚠️ 경고 + 실행 전 확인. 프롬프트는 고쳐서 실행 가능, 시드 랜덤(기본 켬)으로 매번 새로 뽑고 횟수(1~20) 지정 가능. 진행 상황/미리보기가 보이고 결과는 이 화면과 히스토리 패널에 쌓임. 이 앱이 생성 중일 땐 실행을 막음. 편집기용 워크플로우만 있는 이미지는 API 형식이 없어 실행 불가(Export (API)로 저장한 .json 필요). ' +
                    '🎛️ 모델/샘플러 등 선택 영역: 노드가 원래 가진 콤보(드롭다운) 입력(체크포인트/로라/샘플러/스케줄러 등)과 숫자 입력칸(steps/cfg 등 INT·FLOAT)은 — 이 ComfyUI와 불일치 여부와 무관하게 — 전부 고를 수 있게 뜬다. 내가 안 가진 값(체크포인트 등)이면 "⚠️ 원본: …"으로 맨 위에 선택 불가 상태로 표시돼 실수로 그대로 실행하는 걸 막아줌. 바꾼 값은 실행에만 반영되고 원본 워크플로우 자체는 안 바뀜, 새 파일을 불러오면 선택값은 초기화됨. 시드는 "시드 랜덤" 체크박스가 따로 있어서 여기엔 안 뜸.',
                tech: 'library.js의 wf* 블록 (wfExtractFromFile/wfPreflight/wfRenderComboFields/wfRunAll …). index.html의 #tab-tools-wfrun / #wfrun-root / #wfrun-combos. 실행은 POST /prompt + 웹소켓·/history, 중지는 /interrupt. 실행 중 window.isStandaloneExecution과 window.globalNodeTitleMap을 임시로 바꾸고 끝나면 복구. 선택값은 wfState.fieldOverrides(`${노드id}::${키}`)에 저장, wfRunAll이 전송 직전 복제 프롬프트에만 적용.'
            },
            {
                name: '🔎 프롬프트 특수 검색 (신규 도구 탭)',
                desc: '🛠️ 도구 ▼ → "🔎 프롬프트 특수 검색". 찾을 프롬프트를 적으면 대상(조각 프롬프트/조각 전용 부정/공통 긍정/공통 부정)마다 있으면 🟢, 없으면 🔴 불이 켜지고, 불을 클릭하면 추가/제거됨. [＋전체]/[－전체]로 일괄 처리, ↩ 되돌리기 1회 지원.',
                tech: 'psearch 블록 — library.js 맨 아래. index.html의 #tab-tools-psearch / #psearch-root. 설정은 localStorage "am_psearch_v1".'
            },
            {
                name: '🩺 에셋매니저 진단 (신규 도구 탭)',
                desc: '🛠️ 도구 ▼ → "🩺 에셋매니저 진단". 페이지가 열려 있는 동안의 웹소켓/HTTP/오류/생성 요청 기록과 [지금 점검] 결과를 합쳐서 어디서 막혔는지 추정하고(🔴🟡🟢 + 다음에 확인할 것), 보고서 복사/저장과 서버 로그 기록을 지원함. 같은 진단을 "⏹ 생성중지" 옆 🩺 버튼(신호등 + 빠른 진단 팝업)과 "📋 로그" 패널 맨 위 한 줄에서도 간단히 볼 수 있음(아래 "📋 실행 로그 패널" 항목 참고).',
                tech: 'generate.js installAmDiagRecorder()(window.amDiag) + library.js amDiag* 블록. index.html의 #tab-tools-diag / #diag-root.'
            },
            {
                name: '🔢 조각 번호표/대조 (신규 도구 탭)',
                desc: '🛠️ 도구 ▼ → "🔢 조각 번호표/대조". 그룹을 고르면 몇 번에 어떤 조각이 있는지 이름만 표로 보여주고, 번호/이름을 바로 수정할 수 있음. "1.사과, 2.딸기" 텍스트로 한꺼번에 이름 수정도 가능. 또 "(사과,딸기,바나나)" 같은 목록을 적어두면 번호 순서대로 조각 이름과 대조해서 일치/불일치를 표시하고, 이미지 검수 화면에도 같은 결과(✅/❌)가 표시됨.',
                tech: 'renderNumCheckTool() 등 numcheck 블록 — library.js 맨 아래. index.html의 #tab-tools-numcheck / #numcheck-root. 설정은 localStorage "am_numcheck_v1". 번호 규칙은 getGroupPositionForJob()과 동일(지정 번호 우선, 없으면 그룹 내 순서).'
            },
            {
                name: '🆕 알트클릭 도움말 등록됨',
                desc: '메타데이터 뷰어/단독 검열기/퀵 리사이저 3개 탭의 드롭존, 옵션, 버튼 전부 Alt+클릭 도움말 등록됨(검열 타겟 부위 체크박스 7개는 설명이 같아서 하나로 묶어서 등록).',
                tech: 'ELEMENT_HELP_MAP의 metadata-dropzone부터 resizerResetTool까지 — library.js.'
            },
            {
                name: '🔍 메타데이터 뷰어',
                desc: '이 프로그램(ComfyUI)으로 만든 PNG/WEBP 이미지를 드롭하면, 그 이미지를 만들 때 쓴 설정값(아키텍처/체크포인트·UNet/Clip/VAE/프롬프트/로라/샘플러/스케줄러/Steps/CFG 등)을 그대로 읽어서 보여줌. "🪄 이 설정으로 생성" 버튼으로 그 설정을 Generate 화면에 그대로 채워서(아키텍처 자동 전환 포함) 비슷한 조건으로 다시 뽑아볼 수 있음.',
                tech: 'processDroppedFile(file) → parseComfyUIMetadataFromPNG(file), applyMetadataToForm() — component_metadata.js (main.js 아님). PNG tEXt 청크의 프롬프트 JSON을 파싱.'
            },
            {
                name: '🔍 단독 검열기',
                desc: '이미 가지고 있는 이미지 파일(이 프로그램 밖에서 만든 것도 가능)을 드롭해서 모자이크/블러 처리. 부위별(꼭/보/꼬/항/알/X-Ray/단면) on-off, 검열 방식(모자이크/흰색블러/흰색단색), 강도 조절 가능. 자동 처리로 부족하면 붓 도구로 직접 손으로 덧칠 가능(전/후 비교 슬라이더로 확인). 여러 장 동시 드롭 → 대기열 순차 처리 → ZIP 일괄 다운로드. 🆕(기능 확장: 모자이크 리터치) 이 탭에 직접 드롭한 이미지뿐 아니라, **갤러리에서 아무 이미지나 우클릭 → "🖌️ 모자이크 리터치"**로도 이 리터치 캔버스를 바로 열 수 있음 — 생성 중 자동 적용된 모자이크(toggle-mosaic)가 어설프게 씌워졌을 때, 그 결과물을 직접 덧칠해서 고칠 수 있게 됨. 이 경우 원본(모자이크 치기 전) 이미지가 따로 안 남아있어서 전/후 비교 슬라이더는 의미가 없고(양쪽 다 같은 이미지), 리터치 캔버스로 덧칠 → "덧칠 저장"만 사용. 저장하면 **원본 파일에 그대로 덮어써짐**(새 파일로 안 남고 overwrite).',
                tech: 'runStandaloneCensor(), downloadCensorZip(), resetCensorTool(), clearCensorCanvas(), saveRetouchedImage() — 🐛 예전 설명엔 main.js라고 잘못 적혀있었음, 바로잡음: 전부 tools_censor.js. 🆕 openRetouchForImage(filename, subfolder)/retouchContextImage() — tools_censor.js, 갤러리 컨텍스트 메뉴 전용 진입점. saveRetouchedImage()가 resultUrl의 filename/subfolder 쿼리값을 그대로 읽어 "같은 파일에 overwrite 업로드"하는 기존 로직을 그대로 재사용하기 때문에, 큐에 등록 안 된 이미지(갤러리 이미지)도 그 포맷(/view?filename=...&type=output&subfolder=...)만 맞춰서 synthetic item을 만들면 동일하게 동작함 — 백엔드 변경 없이 프론트엔드 재사용만으로 구현됨.'
            },
            {
                name: '✂️ 퀵 리사이저',
                desc: '이미지 크기(원본유지/비율%/긴축기준/강제WxH)와 출력 포맷(WEBP/JPEG/PNG)+압축품질을 정해서 일괄 변환. 여러 장 동시 드롭 → 대기열 순차 처리 → ZIP 일괄 다운로드.',
                tech: 'runStandaloneResizer(), downloadResizerZip(), resetResizerTool(), toggleResizerInputs(), toggleResizerQuality() — main.js.'
            },
            {
                name: '🎬 NAI Director 도구',
                desc: 'NovelAI의 Director Tools(augment-image API)로 이미지 한 장을 즉석 변환. 선화 추출/스케치화/스케치 채색(프롬프트+디프라이)/감정·표정 변경(프롬프트+디프라이)/배경 제거/배경 정리/업스케일(2배·4배, 무료) 중 선택 — 전부 실제 생성까지 테스트해서 정상 작동 확인됨 ✅. 생성 탭(NAI)의 API 토큰을 그대로 재사용 가능. 결과는 output/nai에 저장되지만 대기열/검수와는 무관한 독립 실행.',
                tech: 'runNaiDirectorTool(), handleNaiDirectorFile(), toggleNaiDirectorPromptRow() — generate.js. 백엔드 api_nai_director() — __init__.py (POST /assetmanager/api/nai_director, PIL로 이미지 크기 추출; 업스케일은 별도 엔드포인트 /ai/upscale + model="nai-diffusion-5-curated" 필요했음). 전부 검증 완료.'
            },
        ]
    },
    {
        // 🆕(기능 도움말 점검 세션) gallery.js/ui_manager.js를 받아서 확인 후 신설 —
        // 기존엔 이 탭 전체가 FEATURE_HELP_SECTIONS/ELEMENT_HELP_MAP 둘 다 등록이 0개였음.
        title: '10. 갤러리 (출력 이미지 브라우저)',
        items: [
            {
                name: '🆕 알트클릭 도움말 등록됨',
                desc: '폴더 트리, 검색, 이미지 그리드, 선택 정보, 라이트박스, 우클릭 메뉴, 모델 정보 모달, 라이브 프리뷰 접기, 좌우 패널 드래그까지 alt+클릭으로 설명 확인 가능.',
                tech: 'ELEMENT_HELP_MAP의 gallery-folder-list부터 gen-resizer까지 — library.js. 실제 로직은 gallery.js(갤러리 전용)와 ui_manager.js(탭 전환/모달/라이트박스/컨텍스트메뉴 등 범용 UI)에 분산.'
            },
            {
                name: '🖼 폴더 트리 + 전체/폴더별 보기',
                desc: 'output 폴더 구조를 그대로 좌측 트리로 보여줌. "🌌 전체 이미지"는 모든 폴더를 합쳐 최신순으로, 특정 폴더를 고르면 그 폴더와 하위 폴더 이미지를 전부 모아서 보여줌(하위 폴더까지 합쳐짐). 검색창에 폴더명을 치면 해당하는 것만 남기고 자동으로 펼쳐짐.',
                tech: 'fetchGalleryData() — /assetmanager/api/gallery GET. buildFolderTree()가 평평한 폴더 목록을 중첩 트리로 변환(각 노드에 하위 포함 누적 개수 _count). getCurrentImageList()가 선택된 폴더(+하위) 또는 전체의 이미지를 1차원 배열로 모아 timestamp 역순 정렬.'
            },
            {
                name: '🖱 다중 선택 (Ctrl/Shift) + 삭제',
                desc: '이미지를 그냥 클릭하면 라이트박스로 바로 보여주고, Ctrl(⌘)+클릭이나 체크박스 클릭은 그 이미지만 선택 토글, Shift+클릭은 마지막 선택~지금 클릭 사이 범위 전체를 선택. 선택한 것만 일괄 삭제하거나, 현재 보이는 폴더의 전체 이미지를 한꺼번에 삭제할 수도 있음 — 전부 영구 삭제라 confirm 창이 한 번 뜸.',
                tech: 'handleImageClick() — selectedImagePaths(Set) 관리, syncDOMWithSelection()으로 전체 재렌더링 없이 DOM 클래스만 갱신. deleteSelectedGalleryImages()/deleteAllGalleryImagesInView()/deleteContextImage() → executeDelete() → /assetmanager/api/delete_images POST → 성공 시 fetchGalleryData()로 새로고침.'
            },
            {
                name: '🖱 우클릭 메뉴 — "이 설정으로 생성" / 리터치 / 조각 저장 / 삭제',
                desc: '이미지를 우클릭하면 메뉴가 뜸. "이 설정으로 생성"을 고르면 그 이미지에 박힌 ComfyUI 메타데이터(체크포인트/프롬프트/로라/샘플러 등)를 읽어서 생성 탭 폼에 그대로 채워주고 생성 탭으로 자동 이동 — 🔍 메타데이터 뷰어 도구와 완전히 같은 적용 로직을 재사용함. 🆕 "🖌️ 모자이크 리터치"는 그 이미지를 단독 검열기 탭의 리터치 캔버스로 바로 연다. 🆕 "💾 이 설정을 조각으로 저장"은 이미지의 프롬프트+로라만 뽑아서 프롬프트 라이브러리에 새 조각으로 등록한다("🖼 갤러리에서 저장" 그룹에 쌓임) — 체크포인트는 조각에 안 들어감(생성 탭 전역 설정이라).',
                tech: 'sendToGenerateFromGallery() — /assetmanager/api/image_metadata GET → applyMetadataToForm()(component_metadata.js, 메타데이터 뷰어 도구와 공유하는 함수). 메뉴 자체는 UIManager.openContextMenu()/closeMetadataModal() 패턴과 별개로 document 전역 click에서 자동으로 닫힘(UIManager.initContextMenuListener()). 🆕 retouchContextImage()(tools_censor.js), saveImageSettingsAsFragment()(gallery.js)→createGalleryImagePiece()(library.js) — 자세한 내부 동작은 각각 🔍 단독 검열기 / ELEMENT_HELP_MAP의 context-menu 항목 참고.'
            },
            {
                name: 'ℹ️ 모델 정보 모달 (체크포인트/로라 상세)',
                desc: '체크포인트/로라 선택 UI에서 정보 보기를 누르면, CivitAI 미리보기 이미지·베이스 모델·태그·설명을 모아 보여줌. 로컬에 매칭되는 .json 메타데이터가 없으면 "정보를 찾지 못했습니다"로 안내.',
                tech: 'UIManager.showModelInfo(modelType, modelName) — /assetmanager/api/model_info GET. 이미지 우선순위: civitai.images[0].url → preview_url(/assetmanager/api/view_image 프록시).'
            },
        ]
    },
    {
        // 🆕 상단 ⚙️ 톱니바퀴를 눌러도 "⚙️ 환경 설정" 제목만 뜨고 내용이 하나도 없던 빈 탭을 채움.
        title: '11. ⚙️ 환경 설정 (신규 — 빈 탭이었던 걸 채움)',
        items: [
            {
                name: '🔞 GPT / 나노바나나 성인용 키워드 경고 (신규)',
                desc: 'GPT(OpenAI)나 🍌 나노바나나(Google)로 생성 요청을 보내기 직전, 프롬프트에 🔞 성인용으로 분류되는 태그가 있으면 확인창을 한 번 띄운다(어떤 태그가 걸렸는지 미리보기로 보여줌). "취소"를 누르면 그 생성 자체가 진행되지 않음. 로컬 ComfyUI/NAI 생성에는 영향 없음(외부 상업 API 2곳만 해당). 체크박스로 끄면 더 이상 안 뜸(기본은 켜짐).',
                tech: 'generate.js의 confirmProceedWithAdultPrompt(posPrompt, serviceLabel) — executeGptGeneration()/executeNanoBananaGeneration() 맨 앞에서 호출. classifyPromptTagSegments()로 각 태그를 세그먼트 단위로 분류해서(🎨 다중 색상 배지와 같은 로직) 세그먼트 중 하나라도 "성인용"이면 걸림. AppSettings.get("nsfwWarningEnabled")가 false면 체크 자체를 건너뜀.'
            },
            {
                name: '🔤 태그 자동완성 기본 표기',
                desc: '자동완성에서 "gray hair"/"gray_hair"처럼 표기만 다른 같은 태그를 하나로 합칠 때, 사용횟수·뜻 길이·입력한 글자로도 못 정하면 따르는 기본값. 이전엔 korean_autocomplete.js 코드 안에 상수로 박혀있어서(DEFAULT_TAG_FORM) 바꾸려면 파일을 직접 고쳐야 했는데, 이제 여기서 드롭다운으로 바로 바꿀 수 있고 새로고침 없이 즉시 반영됨.',
                tech: 'AppSettings.set("defaultTagForm", value) → window.setDefaultTagForm(value)(korean_autocomplete.js가 노출) 호출로 그 파일의 DEFAULT_TAG_FORM 클로저 변수를 즉시 갱신. 저장은 localStorage am_app_settings_v1.'
            },
            {
                name: '🔑 외부 API 키 상태 + ⌨️/📖 바로가기',
                desc: '🍌 나노바나나/🤖 GPT API 키가 지금 저장돼 있는지 한눈에 확인하고 지울 수 있음(입력 자체는 생성 탭의 해당 아키텍처 드롭다운 밑에서 함). 아래엔 ⌨️ 단축키 목록/변경, 📖 기능 도움말 모아보기 모달을 바로 여는 바로가기 버튼도 둠.',
                tech: 'renderSettingsTab() — library.js, DOMContentLoaded에서 페이지 로드 시 바로 #tab-settings를 채움(탭을 열 때까지 안 기다림, 무거운 fetch 없음). API 키 상태는 localStorage의 nanoBananaApiKey/gptApiKey 존재 여부만 확인(값 자체는 안 보여줌). 바로가기는 기존 openShortcutHelpModal()/openFeatureHelpModal() 그대로 호출.'
            },
            {
                name: '🧩 AppSettings — 새 설정 추가하는 공용 창구',
                desc: '앞으로 설정 항목이 더 생기면 이 객체에 필드만 추가하면 됨(localStorage 키 하나로 관리, JSON). 다른 파일에서도 window.AppSettings.get("키")/set("키", 값)으로 바로 읽고 쓸 수 있음.',
                tech: 'const AppSettings = (IIFE) — library.js, localStorage 키 am_app_settings_v1. get(key)/set(key, value)/DEFAULTS 3개만 노출. set()은 쓰자마자 바로 localStorage에 저장(디바운스 없음 — 설정 변경은 빈도가 낮아서 즉시 저장이 더 안전).'
            },
        ]
    },
    {
        // 🆕(도움말 등록 세션) outfit_set_wizard.js를 받아서 신설 —
        // 이전 세션에서 큰 신규 기능을 통째로 만들고 도움말 등록을 빠뜨렸던 것을 채움.
        title: '12. 👗 의상에셋매니저 (신규)',
        items: [
            {
                name: '👗 의상에셋매니저 — 개요',
                desc: '여러 벌의 "의상"을 한 화면에서 동시에 만들어서 한 그룹(카테고리)에 조각으로 한꺼번에 등록하는 전용 도구. 라이브러리의 "+ 조각 추가" 버튼 옆에 생기는 버튼으로 연다. 의상마다 콤마로 여러 개를 한 번에 입력할 수 있는 "칩" 목록(자동완성 연동)이 있고, 칩을 클릭해서 고른 뒤 같은 줄의 색상(기본 10색+커스텀, RGB 피커, 랜덤/커스텀랜덤)·품질(14종) 팔레트를 누르면 그 칩만 바뀐다(순서는 안 바뀜). 칩을 우클릭하면 비활성화(취소선, 프롬프트에서 제외)되고 다시 우클릭하면 복구된다.',
                tech: 'ensureOutfitSetButton()이 #btn-add-item 옆에 버튼을 심음 — outfit_set_wizard.js. openOutfitSetModal()/ensureModal()로 모달 생성, renderOutfitRows() → renderOutfitLine()이 의상별 칩 목록+색상/품질 팔레트를 그림. 칩 클릭은 selectOutfitChip(), 우클릭 비활성화는 toggleOutfitChipDisabled(), 직접 타이핑 수정은 editChipTextLive()/handleOutfitChipTyping()(자동완성 연동, Enter로 칩 확정).'
            },
            {
                name: '🏃 행동 조각 — 기본(공유) / 이 의상 전용 + 🚫 제외',
                desc: '각 의상 밑에 행동(포즈 등) 조각을 붙일 수 있다. "🏃 기본 행동"은 모든 의상이 공통으로 공유하는 조각(위쪽 공용 영역에서 관리)이고, 의상별로 "이 의상 전용" 행동을 따로 추가할 수도 있다. 둘 다 기존 그룹에서 조각을 골라 체크하는 방식이고(여러 그룹에 걸쳐 선택 가능), 마지막으로 보던 그룹을 기억해뒀다가 다음에 열 때 그 그룹을 먼저 보여준다. 🚫 제외는 "이 의상만 기본 행동 중 일부를 빼고 싶다"일 때 쓰는 기능으로, 제외한 항목은 그 의상의 최종 결과에서만 빠지고 다른 의상/기본 행동 자체에는 영향 없다.',
                tech: '공용: openSharedActionPicker()/sharedActionTagsHtml()/removeSharedActionRef(). 의상 전용: openActionPickerFor(outfitId)/extraActionTagsHtml()/removeExtraActionRef(). 조각 선택창 공통 로직: ensureFragmentPicker(), populateFragmentGroupSelect(), onFragmentGroupChange(), renderFragmentPickerList(), isFragmentPicked(), pickFragmentIntoOutfit(). 🚫 제외: toggleExcludeSharedAction(outfitId, catId, itemId), toggleExcludePanel(outfitId), excludePanelHtml(outfit) — 전부 outfit_set_wizard.js.'
            },
            {
                name: '💾 자동 저장/동기화 + 그룹 저장',
                desc: '버튼을 따로 안 눌러도 편집하면 알아서(디바운스) 라이브러리에 반영되고, 모달을 닫을 때(바깥 클릭 포함)도 즉시 한 번 더 반영된다. 같은 의상을 다시 편집해서 재제출해도 중복으로 새 조각이 생기지 않고 기존에 만들어둔 조각이 업데이트된다. 의상 이름칸을 고치면 이미 만들어진 조각의 이름도 같이 바뀐다. 저장할 그룹은 드롭다운으로 고르거나 새로 만들 수 있고, 선택했던 그룹·행동 그룹·커스텀 색상은 전부 다음에 열어도 그대로 남아있다. 🗑 삭제를 누르면 그 의상과 거기서 만들어진 조각들이 전부 지워진다.',
                tech: 'scheduleSync()(디바운스) → syncOutfitsToLibrary() — resolveTargetCategory()로 저장할 그룹 결정 후 upsertComboItem()/createItemInCategory()로 조각 생성·갱신(resolveActionRef()로 행동 참조 해석). 상태 저장/복원: saveWizardState()/loadWizardState() — localStorage(outfit_set_wizard 키). renameOutfitLive(outfitId, value), deleteOutfitAndItems(outfitId). 그룹 선택: populateGroupSelect(), onGroupSelectChange(). 🐛(해결됨) "새로고침하면 다 날아가는" 버그는 populateGroupSelect()가 상태 복원 전에 먼저 저장을 트리거해서 빈 상태로 덮어쓰던 게 원인이었음 — 순서를 바로잡아 해결.'
            },
        ]
    },
    {
        // 🆕(배포 준비 세션) workflow.json 전체 class_type 전수조사 + 웹 검색으로 확정한
        // 설치 요구사항. 노드를 그래프에 올리는 방식이 아니라 상단 버튼(asset_manager_launcher.js)으로
        // 새 탭에서 열리는 웹앱이라, "이 커스텀노드/모델이 없으면 뭐가 깨지는지" 미리 알아야
        // 설치 직후 멘붕을 피할 수 있어서 도움말에 통째로 박아둠.
        title: '13. 🧩 필요한 모델/커스텀노드 (설치 요구사항)',
        items: [
            {
                name: '🧩 커스텀노드 5종 — 전부 ComfyUI Manager로 설치 가능',
                desc: '이 확장 자체는 노드를 하나도 등록 안 하지만, 안에 내장된 workflow.json(업스케일/디테일러/검열/메인 생성)이 아래 5개 커스텀노드 패키지에 의존합니다. 전부 ComfyUI Manager의 "Custom Nodes Manager"에서 이름으로 검색해서 설치하면 됩니다(수동 설치 시 재시작 필요). 하나라도 빠지면 해당 기능(업스케일/디테일러/검열/메인 생성 중 그 부분)이 "노드를 찾을 수 없음" 에러로 죽습니다.',
                tech: '① ComfyUI-Impact-Pack — https://github.com/ltdrdata/ComfyUI-Impact-Pack (디테일러/검열의 FaceDetailerPipe, ToDetailerPipe, SAMLoader, ImpactSchedulerAdapter 등)\n② ComfyUI-Impact-Subpack — https://github.com/ltdrdata/ComfyUI-Impact-Subpack (★Impact Pack과 별개 설치 필수★ — UltralyticsDetectorProvider가 여기 있음. 이게 없으면 Impact Pack을 깔아도 BBOX/SEGM 모델 자체를 못 불러옴)\n③ rgthree-comfy — https://github.com/rgthree/rgthree-comfy (Power Lora Loader, SDXL Empty Latent Image)\n④ ComfyUI_JPS-Nodes — https://github.com/JPS-GER/ComfyUI_JPS-Nodes (Text Prompt Combo (JPS), Sampler Scheduler Settings (JPS))\n⑤ WAS Node Suite — https://github.com/WASasquatch/was-node-suite-comfyui (Text to Conditioning, [Main] T2C 노드용. ⚠️ 2024년 이후 업데이트가 끊긴 "retired" 상태 리포지만, 이 워크플로우가 쓰는 Text to Conditioning 노드 자체는 과거 버전 그대로 잘 동작함)'
            },
            {
                name: '📦 디테일러/검열용 모델 — models/ultralytics/bbox·segm',
                desc: '위 커스텀노드만 깔면 모델 선택 드롭다운은 뜨지만 안이 비어있습니다. 아래 모델 파일을 받아서 정확한 폴더(bbox 전용 vs segm 전용)에 넣어야 실제로 선택/사용할 수 있습니다. ComfyUI Manager의 "Model Manager"에서 이름 검색으로도 상당수 받아집니다.',
                tech: '얼굴/입 BBOX(face_yolov8m.pt) · 손 BBOX(hand_yolov8s.pt) → models/ultralytics/bbox/ — 출처: https://huggingface.co/Bingsu/adetailer (Bingsu/adetailer 리포, 파일명 그대로 찾으면 됨)\n눈 SEGM(PitEyeDetailer-v2-seg.pt) → models/ultralytics/segm/ — 출처: CivitAI, 제작자 "Pitpe11", 모델명 "Eye Detailer/Segmentation - ADetailer v2" (CivitAI 검색창에 그대로 입력하면 찾을 수 있음, NSFW 표시가 걸려있을 수 있어 로그인 필요할 수 있음)\n검열용 NSFW SEGM(ntd11_anime_nsfw_segm_v5-variant1.pt) → models/ultralytics/segm/ — workflow.json에 파일명이 박혀있는데 공식 배포처(CivitAI/HuggingFace) URL은 못 찾음. CivitAI에서 파일명 그대로("ntd11" 또는 "anime nsfw segm")로 검색 필요 — 못 찾으면 같은 역할(SEGM, NSFW 부위 탐지)을 하는 다른 anime nsfw segm 모델로 대체하고 workflow.json의 해당 노드 model_name 값을 새 파일명으로 바꿔도 됨.'
            },
            {
                name: '🖼 업스케일 모델 — models/upscale_models',
                desc: '업스케일러 파이프라인과 나노바나나/GPT/NAI 후처리가 공통으로 쓰는 기본 모델입니다. 드롭다운에서 다른 업스케일 모델로 바꿔 쓸 수도 있으니(코드 기본값일 뿐 필수 고정값 아님), 꼭 이 파일이 아니어도 됩니다.',
                tech: '4x-UltraSharp.pth → models/upscale_models/ — 출처: https://huggingface.co/lokCX/4x-Ultrasharp/blob/main/4x-UltraSharp.pth'
            },
            {
                name: '🌐 브라우저측 신체부위 자동감지 — ONNX Runtime Web + YOLOv8-face',
                desc: 'pipeline_facedetect.js가 서버가 아니라 브라우저에서 직접 돌리는 모델입니다. ComfyUI 모델 폴더가 아니라 확장 자체의 web/static/ 폴더 밑에 넣어야 합니다. 주의: 코드 주석에 yolo11m.onnx·손·발 모델 경로도 정의돼 있지만 "모델 확보 후 경로 교체 필요" 상태로 보여서, 실제로 그 부위들까지 쓰고 있는지는 직접 확인 필요.',
                tech: 'onnxruntime-web 1.18.0의 ort.min.js / ort-wasm-simd.wasm → web/static/js/ (npm 패키지 onnxruntime-web@1.18.0의 dist 폴더에서 추출하거나 jsdelivr/unpkg CDN에서 직접 다운로드)\nyolov8n-face.onnx(약 6MB) → web/static/models/yolov8-face/ — 출처: GitHub akanametov/yolo-face 리포지토리 릴리즈'
            },
        ]
    },
];

/** 🆕 알트클릭 상세 도움말 기능
 *  이 프로그램을 처음 보는 사람도 각 드롭다운/버튼이 뭘 하는지, 어떤 함수/노드로 이어지는지
 *  바로 확인할 수 있게, Alt(옵션)를 누른 채 아무 컨트롤이나 클릭하면 그 항목의 설명 팝업만 뜨게 한다
 *  (원래 클릭 동작 — 값 변경, 모달 열림 등 — 은 실행되지 않고 도움말만 뜬다).
 *  지금은 "1. 공통 환경 설정"과 "2. 고급 설정" 두 섹션만 등록되어 있음 — 이후 섹션은 추후 확장 예정.
 *
 *  🔴 규칙 (예외 없음): 알트클릭으로 설명이 떠야 할 새 드롭다운/버튼/입력칸을 추가하면,
 *  사용자가 따로 말하지 않아도 같은 작업 안에서 이 맵에도 항목을 같이 추가할 것. (위
 *  FEATURE_HELP_SECTIONS 쪽 등록과는 별개 — 한쪽만 하고 끝내지 말 것.)
 *
 *  키는 두 가지 방식으로 매칭한다:
 *  1) 엘리먼트 자체의 id (예: 'gen-architecture')
 *  2) id가 없는 버튼 등은 data-help="키이름" 속성을 index.html에 붙여두고 그 값으로 매칭 (예: 'presetAdd')
 */
const ELEMENT_HELP_MAP = {
    // ── 1. 공통 환경 설정 ──
    'gen-preset': {
        name: '프리셋 드롭다운 (gen-preset)',
        desc: '모델별로 저장해둔 구성(체크포인트/로라/샘플러/IP-Adapter 등)을 한 번에 불러온다. 고르는 즉시 적용됨(별도 확인 없음).',
        tech: 'applyPreset() — main.js, onchange. 프리셋 데이터는 window.MODEL_PRESETS에 저장.'
    },
    presetAdd: {
        name: '+ 추가 (프리셋 새로 만들기)',
        desc: '지금 화면에 설정된 값(체크포인트/로라/샘플러 등) 그대로를 새 프리셋으로 저장한다. 이름을 입력하라는 프롬프트가 뜸.',
        tech: 'addNewPreset() — main.js.'
    },
    presetRename: {
        name: '✎ 이름수정',
        desc: '현재 선택된 프리셋의 이름만 바꾼다. 안에 저장된 설정 내용은 그대로 유지됨.',
        tech: 'renamePreset() — main.js.'
    },
    presetRemove: {
        name: '- 제거',
        desc: '현재 선택된 프리셋을 삭제한다. 되돌릴 수 없음 — 삭제 후 남은 캐시는 아래 "🧹 청소" 버튼으로 정리 가능.',
        tech: 'removePreset() — main.js.'
    },
    presetMerge: {
        name: '🔀 병합',
        desc: '두 개의 프리셋을 골라서 하나로 합친다. 로라 등 리스트형 항목은 합쳐지고, 단일값(샘플러 등)은 어느 쪽을 쓸지 고르게 됨.',
        tech: 'openMergePresetsModal() — main.js.'
    },
    presetSetDefault: {
        name: '⭐ 기본',
        desc: '지금 선택된 프리셋을 "새로고침했을 때 자동으로 불러올 기본 프리셋"으로 지정한다.',
        tech: 'setDefaultPreset() — main.js.'
    },
    presetExport: {
        name: '💾 백업',
        desc: '모든 프리셋과 현재 설정 전체를 JSON 파일 하나로 내보낸다. 다른 컴퓨터로 옮기거나 만약을 대비한 백업용.',
        tech: 'exportPresetsToFile() — main.js.'
    },
    presetImport: {
        name: '📂 복원',
        desc: '💾 백업으로 내보냈던 JSON 파일을 다시 불러와서 프리셋/설정을 복원한다. 지금 있는 프리셋과 합쳐지거나 덮어써질 수 있음(파일 내용에 따라 다름).',
        tech: 'importPresetsFromFile(file) — main.js, #preset-import-input의 change 이벤트.'
    },
    presetCleanup: {
        name: '🧹 청소',
        desc: '삭제된 프리셋이 남긴 찌꺼기 캐시(로라 목록 등)만 정리한다. 10초 카운트다운 후에 눌러야 실행됨 — 현재 활성 프리셋의 값은 건드리지 않음(단, 확인창엔 "초기화될 수 있다"고 경고가 뜨니 주의).',
        tech: 'startCleanupCountdown() → cleanupOrphanedPresetCache() — index.html 인라인 스크립트.'
    },
    'gen-architecture': {
        name: '아키텍처 드롭다운 (gen-architecture)',
        desc: 'SDXL / SD1.5 / Anima(qwen_image 계열) / SD3 / 🍌 나노바나나(Google Gemini) / 🎨 NovelAI(NAI) 중 어떤 모델 계열로 생성할지 고른다. 이 값에 따라 체크포인트 목록, CLIP/VAE 로딩 방식, 샘플러 기본값이 전부 갈라진다. 바꾸면 아래 체크포인트/UNet 관련 행들이 자동으로 보이거나 숨겨짐. 🍌 나노바나나는 로컬 모델이 아니라 Google 서버 API를 쓰는 완전히 다른 방식이라, 선택하면 체크포인트/로라 대신 API 키 입력행이 나타남. 🎨 NAI도 마찬가지로 NovelAI 서버 API를 쓰며, 선택하면 API 토큰/모델 입력행이 나타나고 고급설정(해상도/샘플러/스텝/CFG/시드)과 부정 프롬프트는 그대로 쓴다.',
        tech: 'toggleArchitectureUI() — index.html 인라인 스크립트, onchange. ComfyUI 계열 노드 분기는 generate.js의 executeGeneration(), 나노바나나는 같은 파일의 executeNanoBananaGeneration()로 완전히 별도 분기.'
    },
    'nanobanana-api-key': {
        name: '🍌 나노바나나 API 키',
        desc: 'Google AI Studio(aistudio.google.com)에서 발급받은 Gemini API 키를 입력한다. 이 브라우저에만 저장되고(localStorage), 생성 요청을 보낼 때 서버로 같이 전달되어 서버가 대신 Google API를 호출한다.',
        tech: '#nanobanana-api-key (index.html) → localStorage의 nanoBananaApiKey 키. executeNanoBananaGeneration() — generate.js가 읽어서 /assetmanager/api/nanobanana_generate로 전달. 실제 Google API 호출은 __init__.py의 api_nanobanana_generate()가 서버 쪽에서 수행(CORS/키 노출 방지).'
    },
    'nanobanana-note': {
        name: '🍌 나노바나나 주의사항',
        desc: '나노바나나는 로컬 모델이 아니라 Google 서버 API를 호출하는 방식이라, 체크포인트/로라/VAE/CLIP은 물론 고급설정(해상도/샘플러/스텝/CFG/시드)과 참조이미지·컨트롤넷·Img2Img·인페인팅·디테일러·모자이크 같은 후처리 기능이 전부 적용되지 않고 무시된다(현재는 순수 프롬프트→이미지 한 장만 지원, 후처리 연동은 추후 지원 예정). 🆕 단, 체크포인트가 필요 없는 "일반 업스케일"만은 생성 직후 자동 적용 가능(아키텍처 드롭다운 아래 "⬆️ 생성 직후 자동 업스케일" 참고).',
        tech: '(문서용 안내문, 클릭 대상 아님) — generate.js의 executeNanoBananaGeneration()이 posPrompt만 사용하고 나머지 설정은 참조하지 않음.'
    },
    'gpt-api-key': {
        name: '🤖 GPT API 키',
        desc: 'OpenAI Platform(platform.openai.com)에서 발급받은 API 키(sk-...)를 입력한다. 이 브라우저에만 저장되고(localStorage), 생성 요청을 보낼 때 서버로 같이 전달되어 서버가 대신 OpenAI 이미지 생성 API(gpt-image-1)를 호출한다.',
        tech: '#gpt-api-key (index.html) → localStorage의 gptApiKey 키. executeGptGeneration() — generate.js가 읽어서 /assetmanager/api/gpt_generate로 전달. 실제 OpenAI API 호출은 __init__.py의 api_gpt_generate()가 서버 쪽에서 수행(CORS/키 노출 방지), 🍌 나노바나나와 완전히 동일한 구조.'
    },
    'gpt-note': {
        name: '🤖 GPT 주의사항',
        desc: 'GPT(OpenAI)도 로컬 모델이 아니라 OpenAI 서버 API를 호출하는 방식이라, 체크포인트/로라/VAE/CLIP은 물론 고급설정(해상도/샘플러/스텝/CFG/시드)과 참조이미지·컨트롤넷·Img2Img·인페인팅·디테일러·모자이크 같은 후처리 기능이 전부 적용되지 않고 무시된다(현재는 순수 프롬프트→이미지 한 장만 지원, 후처리 연동은 추후 지원 예정). 🆕 단, 체크포인트가 필요 없는 "일반 업스케일"만은 생성 직후 자동 적용 가능(아키텍처 드롭다운 아래 "⬆️ 생성 직후 자동 업스케일" 참고).',
        tech: '(문서용 안내문, 클릭 대상 아님) — generate.js의 executeGptGeneration()이 posPrompt만 사용하고 나머지 설정은 참조하지 않음.'
    },
    'nai-api-token': {
        name: '🎨 NAI API 토큰',
        desc: 'NovelAI 계정 설정(Account Settings)에서 발급하는 Persistent API Token(pst-로 시작)을 입력한다. 이 브라우저에만 저장되고(localStorage), 생성 요청 시 서버로 같이 전달되어 서버가 대신 NovelAI API를 호출한다. 생성할 때마다 Anlas(구독 포인트)가 소모된다.',
        tech: '#nai-api-token (index.html) → localStorage의 naiApiToken 키. executeNaiGeneration() — generate.js가 읽어서 /assetmanager/api/nai_generate로 전달. 실제 NAI 호출은 __init__.py의 api_nai_generate()가 서버 쪽에서 수행(Bearer 인증).'
    },
    'nai-model': {
        name: '🎨 NAI 모델 드롭다운',
        desc: '어떤 NovelAI 이미지 모델로 그릴지 고른다. Full은 더 다양하고 덜 정제된 데이터셋, Curated는 더 엄선된(퀄리티 중심) 데이터셋. V4.5 Full이 가장 검증됨. V5/Curated 계열과 V3는 이 프로그램에서 아직 실제로 돌려보지 못한 항목이라 "미검증"으로 표시함. 모델에 따라 아래 Precise Reference(V4.5 전용)/Text Rendering(V3 제외)/투명배경(V5 전용) 행이 자동으로 보이거나 숨겨짐. 안 되면 V4.5 Full로 돌아올 것.',
        tech: '#nai-model (index.html select) → executeNaiGeneration()의 body.model → __init__.py api_nai_generate(). V3는 v4_prompt 계열 필드를 빼고 보냄.'
    },
    'nai-uc-preset': {
        name: '🎨 UC 프리셋 번호',
        desc: 'NAI가 부정 프롬프트 앞에 자동으로 붙여주는 기본 부정 태그 묶음(Undesired Content 프리셋)의 번호. 0이 NAI 기본값이고, 나머지 번호가 각각 무슨 묶음인지는 NovelAI 웹 화면의 UC 프리셋 목록 순서를 따른다(이 프로그램은 번호만 그대로 전달). 잘 모르면 0으로 두면 됨.',
        tech: '#nai-uc-preset (index.html number input) → body.ucPreset → NAI 요청 parameters.ucPreset.'
    },
    'nai-quality-toggle': {
        name: '🎨 품질 태그 자동 추가',
        desc: '체크하면 NAI가 프롬프트 끝에 품질 관련 태그(best quality 등)를 자동으로 덧붙인다. 공통 긍정에 이미 품질 태그를 직접 적어뒀다면 끄는 게 중복을 피할 수 있음.',
        tech: '#nai-quality-toggle (index.html checkbox) → body.qualityToggle → NAI 요청 parameters.qualityToggle.'
    },
    'nai-convert-weights': {
        name: '🎨 가중치 문법 변환',
        desc: '이 프로그램의 프롬프트는 (단어:1.2) 같은 ComfyUI/A1111 문법을 쓰는데, NAI는 이 문법을 그대로 알아듣지 못한다. 체크하면 전송 직전에 (단어:1.2)→1.2::단어::, (단어)→1.1::단어::로 바꿔서 보낸다(\\( \\) 리터럴 괄호는 일반 괄호로 복원). 긍정/부정 프롬프트 둘 다 적용. 매우 복잡한 중첩 괄호는 완벽하지 않을 수 있고, NAI 쪽 문법 해석이 이 변환과 정확히 일치하는지는 실제로 뽑아보며 확인이 필요함.',
        tech: 'convertWeightsForNai(text) — generate.js. executeNaiGeneration()에서 체크 시 posPrompt/negPrompt에 적용.'
    },
    'nai-resolution': {
        name: '🎨 NAI 해상도 프리셋',
        desc: 'NovelAI가 공식으로 지원하는 해상도 목록 중에서 고른다(Normal/Large/Wallpaper/Small 등급별). "직접 입력..."을 고르면 가로/세로를 숫자로 직접 넣을 수 있음 — 64의 배수로 맞추는 게 안전하고, 무료 등급은 총 픽셀수(가로×세로)가 1024×1024(약 104만) 이내여야 추가 Anlas 소모 없이 생성됨.',
        tech: '#nai-resolution / #nai-custom-width / #nai-custom-height (index.html) → toggleNaiCustomResolution(). executeNaiGeneration()이 width/height로 변환해서 body에 담아 백엔드로 전달.'
    },
    'nai-sampler': {
        name: '🎨 NAI 샘플러',
        desc: 'NovelAI가 자체 지원하는 샘플러 목록. ComfyUI 샘플러 이름과 다르게 전부 k_ 접두사가 붙는 NAI 고유 이름을 그대로 씀(별도 변환 없이 바로 전달됨). Euler Ancestral이 가장 무난함.',
        tech: '#nai-sampler (index.html select) → executeNaiGeneration()의 body.sampler → __init__.py api_nai_generate()가 그대로 NAI 요청에 전달.'
    },
    'nai-noise-schedule': {
        name: '🎨 NAI 노이즈 스케줄',
        desc: '샘플러와 짝지어 쓰는 스케줄. Karras가 기본값이자 가장 무난함.',
        tech: '#nai-noise-schedule (index.html select) → executeNaiGeneration()의 body.noiseSchedule.'
    },
    'nai-steps': {
        name: '🎨 NAI 스텝',
        desc: '이미지를 다듬는 반복 횟수. NAI는 보통 28 안팎을 씀. 무료 등급은 스텝이 높아지면(28 초과 등) 해상도 제한과 맞물려 Anlas가 추가로 소모될 수 있음.',
        tech: '#nai-steps (index.html input) → executeNaiGeneration()의 body.steps.'
    },
    'nai-cfg': {
        name: '🎨 NAI CFG (Scale)',
        desc: '프롬프트를 얼마나 강하게 따를지의 강도. NAI 기본값은 5 안팎. 너무 높이면 과채도로 깨질 수 있음(아래 CFG Rescale로 어느 정도 완화 가능).',
        tech: '#nai-cfg (index.html input) → executeNaiGeneration()의 body.scale → NAI 요청 parameters.scale.'
    },
    'nai-cfg-rescale': {
        name: '🎨 NAI CFG Rescale',
        desc: 'CFG를 높게 줬을 때 생기는 과채도/번짐을 줄여주는 보정값(0~1). 0이면 보정 없음, NAI 공식 문서 기준 보통 0~0.2 사이를 권장. 잘 모르면 0으로 두면 됨.',
        tech: '#nai-cfg-rescale (index.html input) → executeNaiGeneration()의 body.cfgRescale → NAI 요청 parameters.cfg_rescale.'
    },
    'nai-seed-random': {
        name: '🎨 NAI 시드 랜덤/고정',
        desc: '체크하면 매번 다른 랜덤 시드, 해제하면 옆 칸에 적은 시드로 고정. 위쪽 공통 "고급 설정"의 시드와는 별개로 NAI 전용으로 따로 관리됨.',
        tech: '#nai-seed-random (index.html checkbox) → executeNaiGeneration()의 rawSeed 계산.'
    },
    'nai-seed': {
        name: '🎨 NAI 시드 입력칸',
        desc: '고정 시드로 쓸 숫자값. 위의 "랜덤" 체크가 켜져 있으면 비활성화됨.',
        tech: '#nai-seed (index.html input) → executeNaiGeneration()의 body.seed.'
    },
    'nai-sm': {
        name: '🎨 SMEA',
        desc: 'NAI 전용 샘플링 보정 기능. 큰 해상도에서 구도가 덜 반복되고 더 자연스럽게 나오도록 도와줌(일부 모델/해상도에서만 의미있게 작동). 켜면 Anlas 소모가 늘어날 수 있음.',
        tech: '#nai-sm (index.html checkbox) → executeNaiGeneration()의 body.sm → NAI 요청 parameters.sm.'
    },
    'nai-sm-dyn': {
        name: '🎨 SMEA DYN',
        desc: 'SMEA의 강화판. 이걸 켜면 SMEA도 자동으로 같이 켜짐(SMEA DYN만 단독으로는 못 씀). SMEA를 끄면 이것도 같이 꺼짐.',
        tech: '#nai-sm-dyn (index.html checkbox) → executeNaiGeneration()의 body.smDyn → NAI 요청 parameters.sm_dyn.'
    },
    'nai-characters-section': {
        name: '🧑‍🤝‍🧑 NAI 캐릭터별 프롬프트 (V4/V4.5 전용)',
        desc: '한 장에 여러 캐릭터를 넣을 때, 캐릭터마다 다른 특징(머리색/옷 등)을 따로 지정할 수 있는 NAI V4/V4.5 전용 기능. 공통 프롬프트는 "전체 배경/구도" 설명용으로 쓰고, 캐릭터별 세부 묘사는 여기 각 캐릭터 칸에 나눠 적는다. V3 모델에서는 이 기능이 없어서 무시됨.',
        tech: 'naiCharacters 배열(index.html) → executeNaiGeneration()의 body.characters → __init__.py api_nai_generate()가 v4_prompt.caption.char_captions / v4_negative_prompt.caption.char_captions로 변환.'
    },
    'nai-add-character': {
        name: '+ 캐릭터 추가',
        desc: '캐릭터 입력 칸을 하나 더 추가한다. 각 칸에 긍정/부정 프롬프트를 따로 적고, 아래 미리보기 사각형의 동그라미를 드래그해서 그 캐릭터가 대략 어디에 나올지 위치를 지정할 수 있다(안 건드리면 화면 중앙, NAI가 알아서 배치).',
        tech: 'addNaiCharacterRow() — index.html 인라인 스크립트. renderNaiCharacters()/renderNaiCharPositionPreview()가 목록/미리보기를 다시 그림.'
    },
    'nai-char-position-preview': {
        name: '캐릭터 위치 미리보기',
        desc: '화면(정사각형)을 캔버스 삼아, 각 캐릭터가 나올 대략적인 위치를 점으로 표시한다. 점을 마우스로 드래그하면 그 캐릭터의 x/y 좌표가 바뀐다(0~1 사이 비율, 0.5/0.5가 정중앙).',
        tech: '#nai-char-position-preview (index.html) — renderNaiCharPositionPreview()가 드래그 이벤트로 naiCharacters 배열의 x/y를 갱신.'
    },
    'nai-precise-ref-section': {
        name: '🎯 NAI Precise Reference',
        desc: '원래는 Vibe Transfer보다 더 정밀하게 캐릭터·스타일을 참고시키는 기능인데, NAI의 실제 전용 API 필드가 공식 문서화되어 있지 않고 추정한 필드("character_reference")로는 에러 없이 조용히 무시되는 것을 확인함. 그래서 지금은 확실히 작동하는 Vibe Transfer와 같은 경로(encode-vibe)로 돌아가도록 바꿔놨음 — 참조 자체는 실제로 반영되지만, "캐릭터만/스타일만" 구분 같은 정밀 제어는 못 살림(타입 선택 드롭다운은 화면에 남아있지만 현재는 결과에 영향 없음). V4/V4.5에서 사용 가능 — V5는 실제 테스트 결과 서버에서 500 에러가 나서(아직 미지원으로 보임) UI 자체를 숨겨둠.',
        tech: 'naiPreciseRefImages 배열(index.html) → executeNaiGeneration()의 body.preciseReference → __init__.py api_nai_generate()가 Vibe Transfer 이미지들과 합쳐서 reference_image_multiple로 전달(encode-vibe 경유). refType 필드는 현재 백엔드에서 사용 안 됨(향후 진짜 필드명 확인되면 분리 예정).'
    },
    'nai-precise-ref-add': {
        name: '+ 이미지 추가 (Precise Reference)',
        desc: '참조할 이미지를 추가한다(최대 16장 권장).',
        tech: 'addNaiPreciseRefImage(file) — index.html.'
    },
    'nai-text-render': {
        name: '🔤 Text Rendering (이미지 안에 글자 넣기)',
        desc: '여기 적은 글자가 이미지 안에 실제로 그려지도록 NAI 공식 문법("프롬프트 맨 끝에 Text: 글자")을 자동으로 붙여서 보낸다. V4 이상 모델에서만 동작(V3는 섹션 자체가 숨겨짐). 모델별 최대 글자수: V4/V4.5 118자, V5 Curated 374자, V5 Full 750자. 짧은 글자가 잘 안 나오면 품질 태그 자동 추가를 꺼보면 도움이 될 수 있음(품질 태그 안에 "글자 없음" 의미의 토큰이 섞여 있어서 충돌 가능).',
        tech: '#nai-text-render-input (index.html) → executeNaiGeneration()에서 prompt 끝에 "\n\nText: ..." 형식으로 직접 붙여서 body.prompt에 포함(백엔드 수정 없이 프롬프트 자체에 얹는 방식).'
    },
    'nai-transparent-bg': {
        name: '투명 배경 (Transparent BG) — ❌ 실제 테스트 결과 작동 안 함',
        desc: 'V5 모델 전용 기능으로, 배경 없이 진짜 알파 채널(투명)로 이미지를 생성하는 기능이어야 하는데, 실제로 켜고 생성해봐도 투명하게 안 나오는 것을 확인함. 필드명("transparent")은 다른 자료로 교차 확인했는데도 안 됐어서 정확한 원인 미상 — V5가 공개된 지 얼마 안 돼서(2026년 8월) 참고할 자료 자체가 적음. 체크박스는 남겨두지만 현재는 기대하지 말 것.',
        tech: '#nai-transparent-bg (index.html checkbox) → executeNaiGeneration()의 body.transparentBg → __init__.py가 parameters.transparent로 전달하지만 실제 효과 미확인(원인 추가 조사 필요).'
    },
    'nai-prompt-randomizer-note': {
        name: '프롬프트 랜덤화 / 프롬프트 조각 안내',
        desc: '{고양이|강아지|토끼} 문법은 NAI 서버가 직접 해석하는 기능이라 이 프로그램이 따로 처리할 필요 없이 프롬프트에 그대로 적으면 동작한다. NAI의 "프롬프트 조각(@)" 기능은 이 프로그램의 "프롬프트 라이브러리"가 이미 동등한 역할을 하고 있어서 별도로 안 만들었다.',
        tech: '(문서용 안내문, 클릭 대상 아님) — NAI 서버 측 프롬프트 파서가 직접 처리.'
    },
    'nai-img2img-section': {
        name: '🖼 NAI Img2Img 원본 이미지',
        desc: '완전 백지에서 새로 그리는 대신, 넣은 이미지를 밑그림 삼아 NAI 자체 img2img로 다시 그린다. 안 넣으면 평소처럼 새로 생성(txt2img)됨.',
        tech: 'naiImg2ImgBase64(index.html) → executeNaiGeneration()의 body.img2img → __init__.py api_nai_generate()가 action을 "img2img"로 바꾸고 parameters.image/strength/noise를 추가해서 NAI에 전달.'
    },
    'nai-img2img-dropzone': {
        name: 'Img2Img 이미지 드롭존',
        desc: '이미지를 클릭해서 선택하거나 끌어다 놓으면 등록된다. 해상도는 위에서 고른 NAI 해상도에 맞춰 자동으로 맞춰지며, 원본과 비율이 다르면 크롭될 수 있음.',
        tech: 'handleNaiImg2ImgFile(file) — index.html. FileReader로 base64 변환 후 naiImg2ImgBase64에 저장.'
    },
    'nai-img2img-strength': {
        name: 'Img2Img 강도 (Strength)',
        desc: '원본 이미지를 얼마나 남길지. 낮을수록(0에 가까울수록) 원본과 거의 똑같이, 높을수록(1에 가까울수록) 원본에서 많이 벗어나 새로 그려짐. 0.5~0.8 사이를 많이 씀.',
        tech: '#nai-img2img-strength (index.html) → executeNaiGeneration()의 body.img2img.strength → NAI 요청 parameters.strength.'
    },
    'nai-img2img-noise': {
        name: 'Img2Img 노이즈',
        desc: '원본 이미지에 노이즈를 추가로 섞는 정도. 기본 0이면 노이즈 없이 원본 그대로 시작. 살짝 올리면 디테일이 조금 더 다양해질 수 있음.',
        tech: '#nai-img2img-noise (index.html) → executeNaiGeneration()의 body.img2img.noise → NAI 요청 parameters.noise.'
    },
    'nai-vibe-section': {
        name: '🌈 NAI Vibe Transfer',
        desc: '체크포인트/로라 없이 "이 이미지 그림체·분위기를 참고해줘" 하는 NAI 전용 기능. 참조 이미지를 여러 장 추가할 수 있고, 각각 "정보 추출"(그 이미지에서 얼마나 많은 특징을 뽑아낼지)과 "적용 강도"(그 특징을 결과에 얼마나 강하게 반영할지)를 따로 조절한다. Img2Img/인페인팅과 동시에 켜도 됨(서로 독립적). V4/V4.5에서 정상 작동 확인됨 — V5는 서버에서 500 에러가 나서(미지원으로 보임) 섹션 자체가 숨겨짐.',
        tech: 'naiVibeImages 배열(index.html) → executeNaiGeneration()의 body.vibeTransfer → __init__.py api_nai_generate()가 /ai/encode-vibe로 먼저 인코딩한 뒤 reference_image_multiple/reference_information_extracted_multiple/reference_strength_multiple 배열로 전달. V4/V4.5 검증됨, V5는 toggleNaiModelFeatureRows()가 UI를 숨기고 백엔드도 한 번 더 막음.'
    },
    'nai-vibe-add': {
        name: '+ 이미지 추가 (Vibe Transfer)',
        desc: '참조할 이미지를 추가한다. 여러 장을 한 번에 선택할 수도 있음.',
        tech: 'addNaiVibeImage(file) — index.html.'
    },
    'nai-inpaint-section': {
        name: '🩹 NAI 인페인팅 마스크 (실제 생성 테스트 완료 ✅)',
        desc: '이미지 전체가 아니라 마스크로 지정한 일부분만 다시 그리는 기능. 마스크를 안 만들면 그냥 Img2Img(전체 다시 그리기)로 동작함. 실제로 작동은 확인했으나 다시 그려진 부분과 원본 사이 경계가 부자연스럽게(티 나게) 나오는 문제가 있어서, 아래 "마스크 경계 부드럽게(블러)" 슬라이더를 추가해서 완화함.',
        tech: 'naiInpaintMaskBase64(index.html) → executeNaiGeneration()의 body.img2img.maskBase64 → __init__.py api_nai_generate()가 마스크가 있으면 action을 "infill"로 바꾸고 모델명 뒤에 "-inpainting"을 붙여서 NAI에 전달(실제 생성 성공 확인됨). 전송 전 PIL GaussianBlur로 마스크 경계를 부드럽게 처리.'
    },
    'nai-inpaint-paint-btn': {
        name: '✏️ 화면에서 칠해서 마스크 만들기',
        desc: '이 프로그램에 이미 있는 "🎨 편집" 그림판을 그대로 재사용한다. 원본 이미지가 그림판으로 열리고, 다시 그리고 싶은 부분을 아무 색으로나 칠한 뒤 저장하면, 칠하기 전/후 이미지를 픽셀 단위로 비교해서 달라진 부분을 자동으로 흑백 마스크(흰색=다시 그려질 영역)로 만들어준다. 그림판 내부 구현을 몰라도 재사용 가능하게 이렇게 설계함.',
        tech: 'openNaiMaskPainter() — index.html, window.openPaintEditor()를 호출(원래 검수 화면의 "🎨 편집" 버튼이 쓰는 것과 동일한 함수). buildNaiMaskFromDiff()가 캔버스 픽셀 비교로 마스크를 생성.'
    },
    'nai-inpaint-mask-blur': {
        name: '마스크 경계 부드럽게 (블러)',
        desc: '칠한 마스크의 경계를 가우시안 블러로 부드럽게 만들어서, 다시 그려진 부분과 원본 사이의 딱딱한 이음매(seam)가 덜 티나게 해준다. 값이 클수록 경계가 더 넓고 부드럽게 섞이지만, 너무 크면 의도한 영역 밖까지 살짝 영향을 줄 수 있음. 0이면 블러 없이 칠한 그대로(이전 동작과 동일).',
        tech: '#nai-inpaint-mask-blur (index.html) → executeNaiGeneration()의 body.img2img.maskBlur → __init__.py api_nai_generate()가 PIL의 ImageFilter.GaussianBlur로 마스크에 적용 후 전송.'
    },
    'nai-note': {
        name: '🎨 NAI 주의사항 (실제 테스트 결과 정리)',
        desc: 'NAI는 로컬 모델이 아니라 NovelAI 서버 API를 호출하는 방식이라 생성마다 Anlas가 소모된다. 체크포인트/로라/VAE/CLIP, 컨트롤넷/업스케일/디테일러/모자이크(로컬 후처리)는 적용되지 않는다. ' +
              '✅ 실제 테스트로 확인된 것(V4.5 기준): Img2Img, 인페인팅(마스크+경계블러), 캐릭터별 프롬프트, Vibe Transfer, Precise Reference, Text Rendering, Director 도구, 업스케일. ' +
              '⚠️ Precise Reference는 전용 API 필드를 못 찾아서 Vibe Transfer와 같은 경로로 동작 — "캐릭터만/스타일만" 구분은 반영 안 됨. ' +
              '❌ 투명 배경(V5)은 원인 불명으로 실제 투명하게 안 나옴. ' +
              '🚫 V5는 Vibe Transfer/Precise Reference 호출 시 서버가 500을 반환해서(미지원으로 보임) 그 두 섹션이 V5에서는 아예 숨겨짐 — V4.5를 쓸 것.',
        tech: '(문서용 안내문, 클릭 대상 아님) — 각 기능의 세부 구현은 개별 ELEMENT_HELP_MAP 항목 참고.'
    },
    'gen-checkpoint': {
        name: '체크포인트 (SDXL/SD1.5/SD3용)',
        desc: '실제 그림을 그릴 메인 모델 파일. 체크포인트를 바꾸면 그 모델에 저장해둔 프리셋(로라 구성, 샘플러, IP-Adapter 등)이 자동 적용될 수 있음. 아키텍처가 Anima/SD3일 땐 이 행 자체가 숨겨짐.',
        tech: 'applyPreset() — main.js (체크포인트 변경 시 프리셋 자동 매칭 로직 포함). toggleArchitectureUI()가 표시 여부를 제어.',
        path: 'ComfyUI-Easy-Install\\ComfyUI\\models\\checkpoints — 여기에 .safetensors 파일을 넣으면 목록에 뜸(새로고침 필요).'
    },
    'gen-unet': {
        name: 'UNet (Anima 전용)',
        desc: 'Anima는 체크포인트 한 방 로딩이 아니라 UNETLoader + CLIPLoader(qwen_image) + VAELoader를 따로 조합해서 쓴다. 이건 그중 UNet(그림을 그리는 핵심 가중치) 파일을 고르는 곳. "체크포인트 파일에서 불러오기" 토글을 켜면 이 행 대신 아래 "체크포인트 (Anima)" 행이 쓰인다.',
        tech: 'toggleAnimaModelSourceUI() — index.html. generate.js의 architecture===\'anima\' 분기에서 UNETLoader 노드에 주입.',
        path: 'ComfyUI-Easy-Install\\ComfyUI\\models\\diffusion_models (구버전 ComfyUI는 models\\unet 폴더를 봄 — 안 뜨면 두 폴더 다 확인)'
    },
    'gen-anima-ckpt': {
        name: '체크포인트 (Anima 통합 파일)',
        desc: 'Anima용 unet+clip+vae가 하나로 합쳐진 체크포인트 파일에서 UNet만 뽑아 쓴다. CLIP/VAE는 이 파일 게 아니라 아래 CLIP/VAE 드롭다운에서 고른 값을 그대로 사용한다 — 헷갈리기 쉬운 부분.',
        tech: 'toggleAnimaModelSourceUI() — index.html. anima-use-checkpoint 체크박스가 켜져 있을 때만 이 행이 보임.',
        path: 'ComfyUI-Easy-Install\\ComfyUI\\models\\checkpoints (일반 체크포인트와 같은 폴더)'
    },
    'anima-use-checkpoint': {
        name: '체크포인트 파일에서 불러오기 (Anima)',
        desc: '켜면: UNet을 개별 .safetensors 대신 통합 체크포인트 파일에서 추출해서 씀 (CLIP/VAE는 그대로 아래 값 사용). 끄면: 위의 "UNet (Anima)" 드롭다운에서 UNet 파일을 직접 고름.',
        tech: 'toggleAnimaModelSourceUI() — index.html, onchange. anima-unet-row ↔ anima-ckpt-row 표시를 서로 토글.'
    },
    'gen-sd3-unet': {
        name: 'UNet (SD3용)',
        desc: 'SD3/SD3.5 아키텍처를 골랐을 때 쓰는 UNet 파일 선택. Anima와 마찬가지로 체크포인트 한 방 로딩이 아니라 UNet을 따로 불러오는 구조.',
        tech: 'toggleArchitectureUI() — index.html. generate.js의 architecture===\'sd3\' 분기.',
        path: 'ComfyUI-Easy-Install\\ComfyUI\\models\\diffusion_models (구버전은 models\\unet)'
    },
    'gen-vae': {
        name: 'VAE 드롭다운',
        desc: '이미지를 최종 픽셀로 디코딩하는 VAE 모델. 아키텍처를 바꾸면 그 아키텍처에 맞는 기본 VAE로 자동 전환될 수 있음(syncVaeForArchitecture).',
        tech: 'syncVaeForArchitecture() — toggleArchitectureUI() 안에서 호출 (index.html/main.js).',
        path: 'ComfyUI-Easy-Install\\ComfyUI\\models\\vae'
    },
    'gen-clip': {
        name: 'CLIP 드롭다운',
        desc: '프롬프트 텍스트를 모델이 이해하는 형태로 인코딩하는 CLIP 모델. Anima는 CLIPLoader(qwen_image) 전용 파일이 따로 필요해서, 아키텍처에 맞는 CLIP으로 자동 전환될 수 있음(syncClipForArchitecture).',
        tech: 'syncClipForArchitecture() — toggleArchitectureUI() 안에서 호출 (index.html/main.js).',
        path: 'ComfyUI-Easy-Install\\ComfyUI\\models\\clip (최신 ComfyUI는 models\\text_encoders 폴더를 봄 — 안 뜨면 두 폴더 다 확인)'
    },
    loraAddRow: {
        name: '+ 로라 추가',
        desc: '로라(LoRA) 선택 행을 하나 더 추가한다. 여러 개 추가해서 동시에 여러 로라를 겹쳐 적용할 수 있음(각 행마다 세기(weight) 조절 가능).',
        tech: 'addLoraRow() — main.js.',
        path: 'ComfyUI-Easy-Install\\ComfyUI\\models\\loras'
    },
    loraRandom: {
        name: '🎲 랜덤 로라',
        desc: '등록된 로라 중에서 무작위로 골라 자동으로 추가해준다. 아래 "🚫 제외 목록"에 넣어둔 로라는 뽑히지 않음.',
        tech: 'addRandomLoras() — main.js.',
        path: 'ComfyUI-Easy-Install\\ComfyUI\\models\\loras'
    },
    loraRandomExclude: {
        name: '🚫 제외 목록',
        desc: '🎲 랜덤 로라를 돌릴 때 절대 뽑히면 안 되는 로라들을 미리 지정해두는 곳.',
        tech: 'openRandomLoraExcludeModal() — main.js.'
    },
    // ── 3. 베이스 프롬프트 & 색상 카테고리 ──
    'base-pos': {
        name: '공통 긍정 프롬프트 (base-pos)',
        desc: '"항상 넣고 싶은 말"을 적어두는 칸. 여기 적은 내용은 라이브러리에서 어떤 조각을 골라 생성하든 매번 자동으로 같이 붙어서 나간다. 예: 화질 관련 단어(masterpiece, best quality 등)를 여기 적어두면 매번 따로 안 적어도 됨. 🆕(기능 도움말 점검 세션에서 발견 — 기존엔 문서화가 아예 안 돼 있었음) 이 칸을 포함해 프롬프트 입력용 textarea는 전부 **더블클릭으로 가중치 조절**이 가능: 커서 위치의 단어(콤마로 구분된 한 덩어리)를 더블클릭하면 (단어:1.1)처럼 감싸거나 가중치를 +0.1, 빠르게 두 번 우클릭하면 -0.1. 가중치가 정확히 1.0이 되면 괄호가 자동으로 사라짐. textarea 안에서는 우클릭 메뉴(붙여넣기 등 브라우저 기본 메뉴)가 아예 안 뜨도록 막혀있음 — 우클릭 두 번을 가중치 조절 제스처로 쓰기 때문.',
        tech: '#base-pos (index.html textarea) — generate.js가 라이브러리 조각의 프롬프트 앞뒤로 이 값을 이어붙임(concat)해서 최종 프롬프트를 만듦. 더블클릭 가중치 조절은 prompt_utils.js의 bindWeightEvents()가 담당(getTokenAt()로 커서 위치 콤마 구간 추출 → adjustWeight()로 (word:weight) 문자열 계산 → dispatchEvent("input")으로 appStateManager 저장까지 트리거). #base-pos/#base-neg/#edit-prompt-value는 고정 바인딩, 그 외 동적으로 생기는 textarea는 MutationObserver(observeDynamicTextareas())가 자동으로 같은 이벤트를 걸어줌 — 라이브러리 조각 편집창 등 나중에 생기는 입력칸도 전부 적용됨.'
    },
    'base-neg': {
        name: '공통 부정 프롬프트 (base-neg)',
        desc: '"항상 빼고 싶은 것"을 적어두는 칸(그림에 안 나왔으면 하는 것). 위의 공통 긍정과 마찬가지로 어떤 조각을 쓰든 매번 자동으로 같이 들어감. 예: 손가락이 이상하게 나오는 걸 막고 싶으면 여기에 관련 단어를 적어둠. 더블클릭 가중치 조절은 base-pos와 동일하게 적용됨(아래 tech 참고).',
        tech: '#base-neg (index.html textarea) — generate.js가 라이브러리 조각의 부정 프롬프트와 concat. 더블클릭/우더블클릭 가중치 조절은 prompt_utils.js bindWeightEvents() — base-pos 항목 참고.'
    },
    'edit-pos-invalidate-value': {
        name: '🚫 이 조각 전용 — 공통 긍정에서 빼기',
        desc: '위의 "공통 긍정 프롬프트"는 원래 항상 자동으로 붙는데, "이 조각을 쓸 때만은 그중 이 단어는 빼줘"라고 예외를 걸어두는 칸. 여기 적은 단어는 이 조각으로 생성할 때만 최종 프롬프트에서 제외되고, 다른 조각을 쓸 땐 평소대로 그대로 들어감. 공통 긍정 칸 자체의 내용은 안 바뀜(그 조각 쓸 때만 "빼고 조립"하는 것 뿐). 입력칸 아래에 공통 긍정프롬프트가 색깔 태그로 보이고, 태그를 클릭하면 그 단어가 이 칸에 자동으로 들어가며(취소선 = 꺼짐) 다시 클릭하면 켜짐.',
        tech: 'item.posInvalidate — library.js 조각 편집모달. generate.js의 filterTokensFromPromptByList()가 최종 조립 시 이 목록에 있는 단어를 걸러냄.'
    },
    'edit-neg-invalidate-value': {
        name: '🚫 이 조각 전용 — 공통 부정에서 빼기',
        desc: '위와 똑같은 방식인데 "공통 부정 프롬프트" 쪽 예외. 예: 평소엔 "과일"을 항상 안 나오게 막아뒀는데, 이번 조각은 사과 그림이라 "과일"을 빼야 할 때 여기에 "과일"이라고 적으면 이 조각 쓸 때만 그 제한이 풀림. 입력칸 아래에 공통 부정프롬프트가 색깔 태그로 보이고, 클릭으로 끄기/켜기(취소선 = 꺼짐)를 할 수 있음.',
        tech: 'item.negInvalidate — library.js 조각 편집모달. generate.js의 filterTokensFromPromptByList()가 최종 조립 시 이 목록에 있는 단어를 걸러냄.'
    },
    // ── 4. 참조 이미지 / 컨트롤넷 / Img2Img / 인페인팅 ──
    'toggle-ipadapter': {
        name: 'IP-Adapter 켜기/끄기',
        desc: '"이런 느낌의 그림처럼 그려줘" 하고 참고 이미지를 넣어서 그 분위기(그림체, 색감 등)를 흉내내게 하는 기능. 켜면 참고 이미지 업로드 칸과 강도 조절 슬라이더가 나타남. 모델 이름에 "faceid"가 들어가면 자동으로 FaceID 전용 모드로 분기해서, 얼굴 임베딩 추출용 InsightFace 로더까지 추가로 연결됨(일반 모드보다 입력 노드가 1개 더 많음). CLIP Vision 연결은 체크박스로 껐다 켤 수 있는데, IPAdapter 내부 구현상 CLIP Vision이 없으면 에러가 나기 때문에 FaceID 모드에서는 꺼도 강제로 같이 연결됨.',
        tech: '#toggle-ipadapter (index.html checkbox) → toggleSubOptions(\'ipadapter-opts\', this). 실제 적용은 pipeline_ipadapter.js의 applyIPAdapterPipeline() — 🐛 예전 설명엔 generate.js라고 잘못 적혀있었음, 바로잡음. uploadIPAdapterImage()로 /upload/image 업로드 → IPAdapterModelLoader+LoadImage(+FaceID면 IPAdapterInsightFaceLoader) 신설 → KSampler.inputs.model을 IPAdapterAdvanced(일반) 또는 IPAdapterFaceID(페이스ID) 출력으로 교체. 꺼져있을 때는 혹시 베이스 workflow.json에 ipadapter_apply_001이 하드코딩돼 있어도 KSampler.model을 Lora Loader 출력으로 되돌리고 관련 노드를 전부 delete.'
    },
    'toggle-controlnet': {
        name: '컨트롤넷(ControlNet) 켜기/끄기',
        desc: '참고 이미지의 "구도/자세/윤곽선"만 그대로 따라 그리게 하는 기능(그림체는 안 따라함, IP-Adapter랑 다른 점). 전처리기(Canny 엣지/깊이맵/오픈포즈/라인아트) 중 하나를 골라서 참고 이미지를 그 형태로 변환한 다음 적용. 강도(strength)와 적용 구간(시작~끝 %, start/end percent)을 조절 가능.',
        tech: '#toggle-controlnet (index.html checkbox) → toggleSubOptions(\'controlnet-opts\', this). 실제 적용은 pipeline_controlnet.js의 applyControlNetPipeline() — 🐛 예전 설명엔 generate.js라고 잘못 적혀있었음, 바로잡음. workflow.json에는 ControlNet 노드가 원래 없어서, IP-Adapter처럼 LoadImage→AIO_Preprocessor→ControlNetLoader→ControlNetApplyAdvanced를 매번 동적으로 새로 만들고, KSampler의 positive/negative conditioning을 그 출력으로 통째로 교체하는 방식. 꺼져 있으면 애초에 추가 노드를 안 만드니 따로 정리할 것도 없음(off면 함수가 그냥 조기 return).'
    },
    'toggle-img2img': {
        name: 'Img2Img(이미지 → 이미지) 켜기/끄기',
        desc: '완전 백지 상태에서 새로 그리는 대신, 넣은 이미지를 밑그림 삼아서 거기서부터 다시 그리는 기능. "디노이즈" 값이 낮으면 원본과 비슷하게, 높으면 원본과 많이 달라짐.',
        tech: '#toggle-img2img (index.html checkbox) → toggleSubOptions(\'img2img-opts\', this). 실제 적용은 pipeline_img2img.js의 applyImg2ImgPipeline() — 🐛 예전 설명엔 generate.js라고 잘못 적혀있었음, 바로잡음. uploadImg2ImgImage()로 미리 업로드해두거나(선택 즉시) 생성 시점에 재시도 업로드 → LoadImage+VAEEncode를 신설해서 KSampler.inputs.latent_image를 그 출력으로, KSampler.inputs.denoise를 슬라이더 값으로 교체. 원래 있던 "[Main] Latent Image"(빈 캔버스 생성용 EmptyLatentImage) 노드는 더 이상 안 쓰이게 되므로 orphan 방지차 삭제. VAE는 커스텀 VAE 노드(vae_custom_001)가 있으면 그걸, 없으면 체크포인트 내장 VAE(출력 슬롯 2번)를 씀.'
    },
    'toggle-inpaint': {
        name: '인페인팅(부분 다시 그리기) 켜기/끄기',
        desc: '이미지의 특정 부분만 지우고 그 부분만 다시 그리는 기능(예: 손만 다시 그리기). 켜면 원본 이미지 업로드 칸과 함께, 원본 위에 흰 브러시로 직접 마스크(칠할 영역)를 그리는 캔버스가 나타남. 브러시 크기/경도(hardness), 디노이즈 강도, 마스크 확장(grow mask, 경계를 몇 픽셀 더 넓힐지) 조절 가능. 지우개 모드도 있어서 잘못 칠한 부분을 되돌릴 수 있음. 🔧(인페인팅 ↔ 얼굴 자동 마스킹 점검) 손으로 안 칠해도 되는 자동 마스크 버튼이 생각보다 훨씬 다양함 — "신체 부위 자동 마스크" 묶음에 얼굴기반/비율기반/커스텀모델 3종류가 다 있음(아래 각 항목 참고). 전부 이미 구현+연결까지 완료된 상태였고 문서화만 안 돼 있었어서, 이번에 alt-click 설명만 새로 등록함(기능 자체는 손 안 댐).',
        tech: '#toggle-inpaint (index.html checkbox) → toggleSubOptions(\'inpaint-opts\', this). 실제 적용은 pipeline_inpaint.js의 applyInpaintPipeline() — 🐛 예전 설명엔 generate.js라고 잘못 적혀있었음, 바로잡음. #inpaint-mask-canvas에 그린 마스크를 캔버스 toBlob()으로 PNG화해서 uploadInpaintImage()로 /upload/image 업로드, 원본은 LoadImage, 마스크는 LoadImageMask로 각각 불러와 VAEEncodeForInpaint에 연결 → KSampler.latent_image 교체. 마스크 드로잉 자체는 initInpaintCanvas() IIFE가 담당. 자동 마스크 쪽은 pipeline_facedetect.js(별도 IIFE, bindUI()가 전부 ?.addEventListener로 선택적 바인딩).'
    },
    'inpaint-autoface-btn': {
        name: '🎯 얼굴 감지 (인페인팅 자동 마스크)',
        desc: 'YOLO로 이미지 속 얼굴 위치를 자동으로 찾아서 그 자리에 바로 마스크를 그려줌. 바로 아래 "😊 얼굴"/"🗣 머리"뿐 아니라, "목·쇄골/가슴/허리/하체/다리"처럼 얼굴 박스를 기준으로 비율 추정한 신체 부위 버튼들도 전부 이 감지 결과(얼굴 위치)가 있어야 작동함 — 그래서 이 버튼을 먼저 눌러야 함(안 누르고 다른 부위 버튼부터 누르면 "먼저 얼굴 감지를 실행하세요" 경고가 뜸).',
        tech: 'detectAndMask() — pipeline_facedetect.js. YOLO 얼굴 감지 모델(ONNX, 브라우저에서 직접 추론) 결과를 _lastDetections/_lastImageEl에 저장해두고, switchMode()/신체부위 버튼들이 이 캐시를 재사용. 전신 높이는 "얼굴 높이 × 9"로 추정해서 목/가슴/허리/하체/다리 비율을 계산.'
    },
    'inpaint-face-mode-face': {
        name: '😊 얼굴 / 🗣 머리 (인페인팅 자동 마스크)',
        desc: '"🎯 얼굴 감지"로 찾은 얼굴 위치를 기준으로, "😊 얼굴"은 YOLO가 감지한 얼굴 영역만, "🗣 머리"는 얼굴+머리카락 전체를 마스크로 그려줌.',
        tech: 'switchMode(\'face\'|\'head\') — pipeline_facedetect.js. drawFaceMask()/drawHeadMask()가 감지된 박스를 기준으로 캔버스에 직접 타원형 마스크를 그림(soft blur 포함).'
    },
    'inpaint-body-neck': {
        name: '목·쇄골 / 가슴 / 허리 / 하체 / 다리 (인페인팅 자동 마스크 — 얼굴기반 비율 추정)',
        desc: '"🎯 얼굴 감지"로 찾은 얼굴 박스 크기를 기준으로, "전신 높이 = 얼굴 높이 × 9"라는 비율로 각 신체 부위 위치를 추정해서 마스크를 그려줌. 실제로 그 부위를 다시 감지하는 게 아니라 얼굴 비율로 "대략 이쯤이겠다" 추정하는 방식이라, 포즈가 특이하거나 신체 비율이 일반적이지 않으면 위치가 어긋날 수 있음(그럴 땐 브러시로 직접 보정).',
        tech: 'applyBodyPartMask(part, canvas, detections, imgEl) — pipeline_facedetect.js, part ∈ {neck, chest, waist, lower, legs}. 얼굴 감지(_lastDetections) 없이는 먼저 "⚠️ 먼저 얼굴 감지를 실행하세요" 경고만 뜨고 동작 안 함.'
    },
    'inpaint-custom-pelvis': {
        name: '🎯 골반 / 🤚 손 / 💪 팔 / 🦶 발 감지 (인페인팅 자동 마스크 — 전용 커스텀 모델)',
        desc: '위의 얼굴기반 추정과 달리, 이 4개는 그 부위 전용으로 따로 학습된 커스텀 YOLO 모델이 이미지를 실제로 다시 분석해서 찾아냄(얼굴 감지를 먼저 안 해도 바로 사용 가능). 골반은 Class 3/4 전용 모델, 손/발은 각각 전용 모델, 팔은 손 모델 결과를 위로 3배 확장해서 팔 영역까지 포함시키는 방식.',
        tech: 'detectAndMaskPelvis()(커스텀 YOLO11, TARGET_CLASSES 3/4) / detectAndMaskHands()·detectAndMaskArms()(HAND_MODEL_URL, arms는 expandTop:3.0 옵션으로 박스 위쪽 확장) / detectAndMaskFeet()(FEET_MODEL_URL) — 전부 pipeline_facedetect.js, 공통 헬퍼 _detectAndMaskWithModel()을 통해 모델 로딩(최초 1회, 이후 세션 캐시)→추론→drawCustomMask()로 그림.'
    },
    'inpaint-zone-upper': {
        name: '상반신 / 하반신 / 중앙 / 전체 / 왼쪽 / 오른쪽 (인페인팅 자동 마스크 — 비율 기반)',
        desc: 'AI 감지 없이, 이미지를 단순 비율로 잘라서 마스크 씌움(상단 55%, 하단 55%, 가운데 40%, 전체, 좌/우 절반). 얼굴·신체 감지가 안 되는 이미지(캐릭터가 아니거나 각도가 특이한 경우)에도 항상 쓸 수 있는 대체 수단.',
        tech: 'applyZoneMask(zone) — pipeline_facedetect.js, zone ∈ {upper, lower, center, bg, left, right}. 감지 모델 전혀 안 씀, 캔버스 좌표 비율 계산만으로 즉시 그림(가장 빠름).'
    },
    // ── 5. 후처리 옵션 ──
    'toggle-upscale': {
        name: '업스케일(고해상도 확대) 켜기/끄기',
        desc: '생성이 끝난 이미지를 더 큰 해상도로 선명하게 키워주는 후처리. 그림을 처음부터 큰 해상도로 그리는 것보다 빠르고 안정적임. 업스케일 모델(4x-UltraSharp 등)과 목표 배율을 고르면, 모델 자체 배율(2x/4x/8x — 모델 파일명에 적힌 숫자로 자동 판별)과 목표 배율이 다를 때 그 차이만큼 추가로 리사이즈 배율을 자동 계산해서 정확히 원하는 배율로 맞춰줌(예: 4배 모델인데 목표가 1.5배면 내부적으로 1.5/4=0.375배로 축소 보정).',
        tech: '#toggle-upscale (index.html checkbox) → toggleSubOptions(\'upscale-opts\', this). pipeline_upscaler.js의 applyUpscalerPipeline() — 🐛 예전 설명엔 generate.js라고 잘못 적혀있었음, 바로잡음. workflow.json에 이미 있는 "[Upscaler] Image Upscale"(업스케일 모델 적용) → "[Upscaler] Ratio"(ImageScaleBy로 목표 배율 보정) → VAEEncode → 자체 KSampler(2차 디노이즈) → VAEDecode 체인을 그대로 쓰고, 꺼져 있으면 체인 전체(모델 로더~이미지 저장까지)를 delete.'
    },
    'toggle-detailer': {
        name: '디테일러(얼굴·눈·입·손 보정) 켜기/끄기',
        desc: '생성된 이미지에서 얼굴/눈/입/손처럼 망가지기 쉬운 부위를 자동으로 찾아서 한 번 더 세밀하게 다시 그려주는 후처리. 4개 부위(얼굴/눈/입/손)를 각각 독립적으로 켜고 끌 수 있고, 부위별로 감지 모델(YOLO bbox 등)도 따로 고를 수 있음. 켠 것들만 체인으로 순서대로 연결됨(예: 얼굴+손만 켜면 그 둘만 순서대로 적용).',
        tech: '#toggle-detailer (index.html checkbox) → toggleSubOptions(\'detailer-opts\', this). pipeline_detailer.js의 applyDetailerPipeline() — 🐛 예전 설명엔 generate.js라고 잘못 적혀있었음, 바로잡음. 전체 토글이 꺼져있거나 부위별 토글(detailer-face-toggle 등)이 꺼져있으면 그 부위의 "[Detailer] {부위} Detailer"류 노드를 전부 delete, 켜져있으면 currentPipe(파이프라인 현재 끝단)를 그 디테일러 입력에 연결하고 출력을 다음 디테일러(또는 최종 저장)로 체인. 기본 감지 모델: 얼굴/입=bbox/face_yolov8m.pt, 눈=segm/PitEyeDetailer-v2-seg.pt, 손=bbox/hand_yolov8s.pt.'
    },
    'toggle-mosaic': {
        name: '모자이크(검열) 켜기/끄기',
        desc: '생성된 이미지의 특정 부위(꼭지/보지/자지/항문/고환 등)에 자동으로 모자이크를 씌우는 후처리. 부위별로 개별 on/off, 강도 조절 가능. 이 조각 전용 검열 설정(편집모달의 🔞)으로 조각별 예외도 줄 수 있음. 모자이크 말고 "흰색으로 가리기"(가장자리를 블러 처리해서 자연스럽게, 또는 블러 없이 딱 잘라서) 모드도 고를 수 있음 — 3가지 모드(mosaic/white/white_solid) 중 선택.',
        tech: '#toggle-mosaic (index.html checkbox) → toggleSubOptions(\'mosaic-opts\', this). pipeline_censor.js의 applyCensorPipeline() — 🐛 예전 설명엔 generate.js라고 잘못 적혀있었음, 바로잡음. 꺼져있거나 타겟 부위를 하나도 안 골랐으면 검열 관련 노드 전부 delete. 켜져있으면 공통으로 "[Censor] NSFW Segm Detector"로 선택된 부위(labels)를 감지하고 강도(censorIntensity)의 2배를 dilation(마스크 확장 픽셀)으로 씀. mosaic 모드는 강도를 0~8배율로 매핑해서 축소→확대로 모자이크 효과(1/scale로 다운스케일 후 다시 scale로 업스케일), white/white_solid 모드는 Mosaic 노드 대신 흰 캔버스+블러 마스크(white) 또는 블러 없는 원본 마스크(white_solid)를 합성. 조각별 오버라이드는 item.censorOverride.'
    },
    // ── 6. 프롬프트 라이브러리 ──
    'edit-catblock-chips': {
        name: '🧱 이 조각 전용 — 카테고리 차단',
        desc: '"이 조각을 쓸 때만 의상(또는 얼굴 등) 관련 프롬프트를 전부 빼고 싶다"를 카테고리 단위로 처리하는 기능. 카테고리 버튼을 클릭하면 차단(취소선), 다시 클릭하면 해제. 카테고리는 프롬프트 색깔과 같은 분류를 쓰고, 아래 미리보기에서 어떤 태그가 빠지는지 취소선으로 바로 보임. 공통·행동·다른 조각·이 조각 자신의 태그가 모두 대상이라, 이 조각에 직접 적은 같은 카테고리 태그도 같이 빠지는 점에 주의(긍정프롬프트에만 적용, 부정프롬프트는 안 건드림). 분류에 없는 태그는 "기타"로 취급됨. 🐛 "red shirt"처럼 🎨 다중 색상 배지로 카테고리 2개 이상인 태그는 이제 세그먼트 중 하나라도 차단 목록에 있으면 빠짐(예전엔 하나로만 판정돼서 안 빠지는 버그가 있었음).',
        tech: 'item.blockCategories[] — library.js 편집모달(#edit-prompt-catblock, renderCatBlockChips/refreshCatBlockPreview). 수집: getItemBlockCategories()/collectBlockCategoriesForRefs() → job.blockCategoriesOverride. 적용: generate.js applyItemCategoryBlock() → tagHasBlockedCategory()(classifyPromptTagSegments() 세그먼트 전체 확인 — 🐛 기존 classifyPromptTag() 단일 판정에서 교체) (무효화 다음, 조건부 변화 전; 본 생성/스케치/저장 후 즉시 출력 3곳).'
    },
    'camera-popup-btn': {
        name: '📷 구도 버튼 (공통 긍정 옆)',
        desc: '공통 긍정프롬프트 이름 옆의 버튼. 누르면 카메라 구도 팝업이 열리고(드래그로 옮길 수 있음, ✕나 다시 누르면 닫힘), 3D 미리보기로 카메라 방위·높이·거리·롤을 맞추면 구도 프롬프트가 만들어져 공통 긍정프롬프트에 자동 반영됨. 팝업 안에서 프리셋, 태그/가중치 설정, 구도 태그 인식·무효화, 조각으로 만들기, 생성에 자동 적용을 다 할 수 있음.',
        tech: 'toggleCameraPopup() — tools_camera.js (index.html의 #camera-popup-btn). 팝업 본체는 #camera-popup, 안의 화면은 #camera-root.'
    },
    'camera-link-box': {
        name: '📷 긍정프롬프트 연동',
        desc: '구도를 공통 긍정프롬프트와 이어주는 칸. ① "바꿀 때마다 자동 반영"(기본 켬): 구도를 바꾸면 긍정프롬프트에 이미 들어 있던 이전 구도가 새 구도로 교체됨(같은 자리에, 없으면 맨 뒤에 추가). 내가 쓴 다른 프롬프트는 그대로 둠. 끄면 [✅ 지금 긍정프롬프트에 적용]을 눌러서만 반영. ② 인식된 구도 태그 칩(클릭으로 끄기/켜기), ③ [🧩 조각으로 만들기], ④ 구도 태그 전부 무효화가 모여 있음.',
        tech: 'applyCompositionToBasePos()/replaceCompositionInPrompt() — tools_camera.js. 교체 대상은 이 도구가 만들 수 있는 태그(설정의 사용자 프롬프트 칸) + 마지막으로 넣었던 구도 문구(프리셋 사용자 프롬프트 포함).'
    },
    'camera-recognized': {
        name: '📷 인식된 구도 태그 (클릭으로 끄기/켜기)',
        desc: '공통 긍정프롬프트 안에서 "구도 태그"로 인식된 것들을 칩으로 보여줌(가중치·밑줄 표기가 달라도 같은 태그로 봄: (from front:1.50) = from_front). 칩을 클릭하면 그 구도 태그가 생성에서 빠지고(취소선, 글자는 그대로) 다시 클릭하면 켜짐 — 조각 안에 든 같은 태그도 함께 걸림. [🧩 조각으로 만들기]는 인식된 태그를 프롬프트 라이브러리의 "📷 구도" 그룹에 새 조각으로 만들고(긍정프롬프트에서는 뺌, 확인 후) 다른 조각과 똑같이 바로 대기열에도 넣음. 아래 "전부 무효화"를 켜면 칩 하나하나 대신 모든 구도 태그가 한꺼번에 빠지고, "생성에 자동 적용"을 같이 켜면 이 도구의 구도만 남음. 구도 태그의 기준은 설정 → 사용자 프롬프트 칸의 문구라서, 그 문구를 바꾸면 인식 대상도 바뀜.',
        tech: 'recognizeCompositionTags()/invalidateCameraCompositionTags() — tools_camera.js. 끈 태그는 localStorage "am_camera_v1"의 offTags(정규화된 글자), 전부 무효화는 invalidateAll. 적용은 generate.js applyCameraComposition() → applyCameraCompositionToPrompt()가 최종 조립 마지막 단계에서. 조각 만들기는 library.js createCompositionPiece().'
    },
    'edit-pos-invalidate-comp-chips': {
        name: '🚫 이 조각 프롬프트 안의 구도 태그 (클릭으로 끄기/켜기)',
        desc: '이 조각의 프롬프트 안에서 구도 태그(from behind, close-up 같은 카메라 구도 관련 태그)로 인식된 것들을 칩으로 보여줌. 클릭하면 그 태그가 위 "긍정프롬프트에서 무효화" 칸에 자동으로 들어가 이 조각을 쓸 때만 빠지고(취소선, 조각의 글자는 그대로) 다시 클릭하면 켜짐. 카메라 구도 팝업의 구도를 쓰고 싶은데 조각에 구도 태그가 섞여 충돌할 때 유용. 구도 태그의 기준은 📷 구도 팝업의 설정(사용자 프롬프트 칸).',
        tech: 'refreshCompInvalidateChips() — library.js. 저장은 기존 item.posInvalidate 그대로(window.recognizeCameraCompositionTags로 인식, tools_camera.js).'
    },
    'camera-canvas': {
        name: '📷 카메라 구도 — 3D 미리보기',
        desc: '카메라 위치를 보면서 조절하는 캔버스. 좌드래그 = 카메라 위치(좌우=방위, 위아래=높이), 우드래그(또는 Alt+드래그) = 미리보기 시점만 회전(구도 값은 안 바뀜), 휠 = 거리(가깝게/멀게), Shift+휠 = 롤(기울기), 더블클릭 = X/Y 초기화, Shift+더블클릭 = 미리보기 시점 초기화. 아래 X·Y·Z·롤 슬라이더/숫자 칸으로도 같은 값을 조절할 수 있고(숫자 칸: Enter 적용, Esc 취소, ↑↓ 0.01, Shift+↑↓ 0.10), 값에 따라 아래 노란 프롬프트 칸이 바로 바뀜.',
        tech: 'tools_camera.js (원본: ComfyUI-KR-Camera-Control의 camera_control.js, AGPL-3.0-or-later). computePrompt()/computePlainPrompt()는 원본 그대로 이식. 상태는 localStorage "am_camera_v1".'
    },
    'camera-preset-select': {
        name: '📷 카메라 프리셋',
        desc: '자주 쓰는 카메라 위치(좌표 + 프리셋 사용자 프롬프트)를 이름 붙여 저장해 두는 목록. 기본 4개(정면/왼쪽/오른쪽/후면)가 들어 있고, [저장]으로 현재 구도를 추가(같은 이름이면 덮어쓰기), [삭제]로 지우면 남은 번호가 0부터 다시 매겨짐. [랜덤]은 프리셋과 무관하게 X·Y·Z를 -1~1 사이 무작위 값으로 설정. 프리셋의 번호는 "생성에 자동 적용 → 프리셋 랜덤"에서 무작위로 고르는 대상이 됨.',
        tech: 'config.camera_presets[] — tools_camera.js. 저장 위치는 localStorage "am_camera_v1"(이 앱 전체에서 하나).'
    },
    'camera-prompt-output': {
        name: '📷 구도 프롬프트 (출력)',
        desc: '지금 맞춰둔 카메라 구도가 만들어내는 프롬프트(읽기 전용). 보통은 (from front:1.50) 같은 가중치 태그로 나오고(기본 가중치는 그림이 깨지지 않게 최대 1.5로 낮춰둠), 가중치가 1.6을 넘으면 노란 경고와 "안전 가중치로 맞추기" 버튼이 뜸. 설정의 "가중치 제거"를 켜면 가중치 없는 순수 태그로 나옴(NAI에 쓸 때 편함). 아래 [📋 프롬프트 복사]로 복사하거나, 아래 연동 칸의 자동 반영/[✅ 지금 긍정프롬프트에 적용]으로 공통 긍정프롬프트에 넣을 수 있음(이미 넣어 둔 이전 구도는 새 구도로 교체됨).',
        tech: 'computeCurrentPrompt() — 알고리즘 출력 + 활성 프리셋 사용자 프롬프트(appendUserPrompt).'
    },
    'camera-auto-apply-box': {
        name: '📷 생성에 자동 적용',
        desc: '켜 두면 생성할 때마다 구도 프롬프트를 최종 긍정프롬프트 맨 뒤에 자동으로 붙임(기본 꺼짐 — 꺼져 있으면 이 화면은 생성에 아무 영향 없음). 방식은 두 가지: "위에서 맞춘 구도 그대로"(항상 같은 구도) / "저장된 프리셋 중 매번 랜덤"(생성할 때마다 프리셋을 무작위로 골라 그 좌표 + 그 프리셋의 사용자 프롬프트를 쓰고, 롤은 화면 값 그대로 — 원본 노드에서 preset_index에 Random Int를 연결한 것과 같은 효과). 설정은 저장되어 이 화면을 다시 열지 않아도 적용됨.',
        tech: 'getCameraCompositionPrompt() — tools_camera.js. 호출은 generate.js applyCameraComposition()이 본 생성/스케치/저장 후 즉시 출력(library.js)의 최종 조립 마지막 단계에서 함.'
    },
    'camera-settings-weights': {
        name: '📷 가중치 설정',
        desc: '방위/높이/거리 각각의 총 가중치(기본 1.5 — 보통 모델이 견디는 범위는 1.0~1.5이고 그보다 크면 그림이 깨지기 쉬움), 각 태그 가중치 상한(기본 1.5, 총 가중치를 올려도 이 값을 넘는 태그는 이 값으로 잘림), ⚖️ 안전 가중치로 맞추기 버튼, 사용 여부, 데드존(이보다 약하면 태그를 빼는 기준), 롤 데드존, 그리고 "가중치 제거"(가중치 괄호 없이 순수 태그로 출력)를 조절. 값은 즉시 위 프롬프트에 반영됨.',
        tech: 'config.azimuth / elevation / distance / tilt / no_weight — tools_camera.js.'
    },
    'camera-settings-prompts': {
        name: '📷 사용자 프롬프트 (태그 문구)',
        desc: '방위·높이·거리 단계별로 어떤 태그를 쓸지 직접 바꾸는 곳(예: 정면 = from front). 칸 앞의 체크를 끄면 그 단계는 태그를 내지 않음. 렌즈/심도/카메라 무빙/구도/스타일은 문구를 적고 체크를 켜야 프롬프트에 포함됨. 쓰는 모델의 태그 방식에 맞게 바꾸면 됨.',
        tech: 'config.azimuth.directions / elevation.categories / distance.categories / extras — tools_camera.js.'
    },
    'wfrun-drop': {
        name: '🧩 워크플로우 이미지 넣기',
        desc: '다른 사람이 만든 ComfyUI 워크플로우가 들어 있는 이미지(PNG/WebP, 또는 API 형식 .json)를 끌어다 놓거나 클릭해서 고르는 곳. ComfyUI가 저장한 이미지에는 실행에 쓰는 "prompt"(API 형식)가 들어 있어서 그대로 실행할 수 있음. 편집기용 워크플로우만 있거나(Export (API)로 다시 저장 필요) 메타데이터가 지워진 이미지는 실행할 수 없다고 안내함.',
        tech: 'wfLoadFile()/wfExtractFromFile() — library.js. PNG tEXt/zTXt/iTXt 청크, WebP/JPEG는 EXIF 안의 prompt:{...} 글자를 읽음.'
    },
    'wfrun-info': {
        name: '🧩 워크플로우 요약 / 사전 점검',
        desc: '넣은 워크플로우의 노드 수, 크기, 샘플러 설정, 쓰는 모델 파일과 함께 이 ComfyUI에서 실행 가능한지 미리 점검한 결과를 보여줌: ❌ 없는 노드(커스텀 노드 설치 필요), ❌ 없는 파일/값(모델 파일 미설치 등 — 모델 줄이 빨갛게 표시), ⚠️ 코드를 실행할 수 있어 보이는 노드(exec/eval/python/shell 등 이름). 경고가 있어도 실행은 막지 않고, 최종 판단은 ComfyUI가 함.',
        tech: 'wfSummarize()/wfPreflight() — GET /object_info/<노드>로 노드 존재와 combo 입력값 목록을 확인.'
    },
    'wfrun-prompts': {
        name: '🧩 워크플로우의 프롬프트 칸',
        desc: '워크플로우 안의 텍스트 인코딩(CLIPTextEncode) 노드의 프롬프트를 그대로 보여주고, 고치면 이 내용으로 실행함(원본 워크플로우는 안 바뀜). 긍정/부정 이름은 워크플로우 제작자가 붙인 노드 제목을 따름.',
        tech: '.wfrun-prompt-edit[data-node-id] — 실행 시 복제본의 해당 노드 inputs.text를 교체.'
    },
    'wfrun-seed-random': {
        name: '🧩 시드 랜덤',
        desc: '켜 두면(기본) 실행할 때마다 워크플로우의 시드(seed/noise_seed)를 새 값으로 바꿔서 매번 다른 그림을 뽑음. ComfyUI는 똑같은 그래프를 다시 보내면 캐시된 결과를 쓰고 새로 안 그려서, 끄면 같은 이미지가 반복되거나 아예 출력이 없을 수 있음. 다른 노드에서 링크로 받는 시드는 건드리지 않음.',
        tech: 'wfRandomizeSeeds() — 숫자 값인 seed/noise_seed 입력만 교체.'
    },
    'wfrun-count': {
        name: '🧩 실행 횟수',
        desc: '같은 워크플로우를 몇 번 연속으로 뽑을지(1~20). 한 번에 하나씩 순서대로 실행하고, 시드 랜덤이 켜져 있으면 매번 다른 시드를 씀. 도중에 오류가 나면 같은 오류가 반복되지 않도록 남은 횟수는 중단함.',
        tech: 'wfRunAll() — 순차 실행, 최대 20.'
    },
    'wfrun-run-btn': {
        name: '🧩 실행 / 중지',
        desc: '▶ 실행: 워크플로우를 이 ComfyUI에서 실행하고 진행 상황(지금 도는 노드 + 진행률)을 보여줌. 이 앱이 생성 중이거나 다른 단독 작업(검열기 등)이 돌고 있으면 서로 꼬이지 않게 막음. ⏹ 중지: ComfyUI의 현재 실행을 중단하고 남은 횟수도 보내지 않음. 코드를 실행할 수 있어 보이는 노드가 있으면 실행 전에 확인을 물음. 끝나면 결과가 아래에 쌓이고 오른쪽 히스토리 패널에도 추가됨.',
        tech: 'wfRunAll()/wfStop() — POST /prompt, 웹소켓 + GET /history/<id> 확인, 중지는 POST /interrupt. 실행 중에는 window.isStandaloneExecution을 켜서 생성 탭 UI/노드 로그를 보호.'
    },
    'wfrun-results': {
        name: '🧩 실행 결과',
        desc: '실행해서 나온 이미지가 쌓이는 곳(클릭하면 크게 열림). 같은 이미지가 오른쪽 히스토리 패널에도 추가되어 거기서 평소처럼 쓸 수 있음. 결과가 안 나오면 시드 랜덤이 꺼져 캐시된 경우나, 이미지를 저장/미리보기하는 노드가 없는 워크플로우일 수 있음.',
        tech: 'wfAddResults() — /view?filename&type&subfolder 주소 + addHistoryItemToPanel().'
    },
    'psearch-input': {
        name: '🔎 특수 검색 — 찾을 프롬프트',
        desc: '찾고 싶은 프롬프트(태그)를 적는 칸. 콤마로 여러 개(최대 8개) 적으면 개수만큼 열이 생김. 태그 단위로 비교하며 (apple:1.2) 같은 가중치, 대소문자, 밑줄(_)/공백 차이는 같은 태그로 봄. 입력한 내용은 기억됨.',
        tech: 'psParseTags()/psNorm() — library.js psearch 블록 (#tab-tools-psearch). stripWeightSyntax()로 가중치를 벗겨 정규화.'
    },
    'psearch-target': {
        name: '🔎 특수 검색 — 검색 대상',
        desc: '어디서 찾을지 고르는 칸. 🧩 조각의 프롬프트 / 🧩 조각의 전용 부정프롬프트(조각 편집창의 "전용 부정") / 📝 공통 긍정프롬프트 / 🚫 공통 부정프롬프트(생성 탭의 칸). 조각을 고르면 오른쪽 그룹 선택으로 범위를 좁힐 수 있음.',
        tech: 'psGetTargets() — 조각은 item.prompt(활성 변형 동기화)/item.negativeOverride, 공통은 #base-pos/#base-neg textarea 직접 수정.'
    },
    'psearch-group': {
        name: '🔎 특수 검색 — 그룹 범위',
        desc: '조각을 검색할 때 전체 그룹을 볼지 특정 그룹만 볼지 고르는 칸. 공통 프롬프트를 검색할 때는 쓰이지 않음(비활성).',
        tech: 'getAllCategories() 기준 — 번호는 getItemEffectiveNumber()(지정 번호 우선, 없으면 순서).'
    },
    'psearch-filter': {
        name: '🔎 특수 검색 — 표시 필터',
        desc: '전체 보기 / 🟢 하나라도 있는 것만 / 🔴 하나라도 없는 것만. 예: "red dress"가 빠진 조각만 모아 보고 위의 [＋전체]로 한꺼번에 추가할 때 유용. 일괄 추가/제거는 지금 표시 중인 곳 전체에만 적용됨.',
        tech: 'renderPSearchTable() — 필터 후 rows 전체가 psBulk() 대상(화면 표시는 앞 400곳까지).'
    },
    'psearch-table': {
        name: '🔎 특수 검색 — 불 켜진 표',
        desc: '🟢 = 그 프롬프트가 있음, 🔴 = 없음. 불을 클릭하면 🔴는 추가(맨 뒤에 ", 태그"), 🟢는 제거(그 태그만 빼고 나머지 글자는 그대로). 열 머리의 [＋전체]/[－전체]는 표시 중인 모든 곳에 일괄 적용(확인창이 뜸). 조각을 고치면 이미 대기열에 들어간 작업의 프롬프트도 같이 갱신됨.',
        tech: 'psToggleCell()/psBulk() → psApplyChanges() → syncQueueJobsWithItem() + debounceLibrarySave() + renderItems()/renderBuilder().'
    },
    'psearch-undo': {
        name: '🔎 특수 검색 — 되돌리기',
        desc: '마지막으로 한 추가/제거(개별 클릭이든 일괄이든 1회분)를 원래대로 복원. 한 번 되돌리면 비활성화되고, 다른 변경을 하면 그 변경이 새로 기록됨. 페이지를 새로고침하면 기록이 사라짐.',
        tech: 'psearchUndoRec(메모리) — psUndo()가 before 값으로 set() 후 저장/동기화.'
    },
    'review-batch-upscale-btn': {
        name: '⬆️ 승인된 파일 일괄 업스케일 (검수 완료 후)',
        desc: '이미지 검수를 끝까지(모든 항목 판정) 마치고 "좋음"으로 저장한 파일이 있을 때만 검수 화면 위쪽에 나타나는 버튼. 누르면 창이 열리고, 기본(위쪽)은 🖼️ 일반 업스케일(서버에서 Lanczos 보간으로 확대 — 빠르고 무료, 토큰 불필요, PNG 프롬프트 메타데이터 유지), 아래쪽은 🎨 NAI 업스케일(AI, NAI 토큰 필요, Anlas 안 듦). 결과는 각 원본이 있는 폴더 안의 하위 폴더(일반=upscaled, NAI=upscaled_nai)에 같은 파일명(.png)으로 저장되고 원본은 그대로 남음. 이미 만든 파일은 건너뛰므로 중간에 멈춰도 다시 누르면 이어서 처리됨.',
        tech: 'updateReviewUpscaleButton()/openBatchUpscaleModal()/runBatchUpscale(method) — library.js. 완료 판정은 isReviewComplete(), 대상은 getReviewApprovedFiles()(reviewState.decisions의 type=good + destPath). 백엔드 POST /assetmanager/api/upscale_file(일반, Pillow Lanczos) / /assetmanager/api/nai_upscale_file(NAI) — __init__.py.'
    },
    'batch-upscale-modal': {
        name: '⬆️ 일괄 업스케일 창',
        desc: '대상 파일 수와 일부 이름이 보이고, 위쪽 🖼️ 일반 업스케일(기본: 배율 2/3/4/1.5배, 토큰 불필요)과 아래쪽 🎨 NAI 업스케일(배율 2/4배, NAI 토큰 — 비우면 생성 탭/도구 탭 토큰 사용)을 각각 시작할 수 있음. "이미 업스케일된 파일은 건너뛰기"는 두 방식에 공통. 진행 중에는 해당 방식의 버튼이 ⏹ 중지로 바뀌고(지금 처리 중인 한 장까지만 끝내고 멈춤) 다른 방식 버튼은 잠김. 진행바와 장별 결과(✅ 완료+크기 / ⏭ 건너뜀 / ❌ 실패+이유)가 아래 로그에 쌓이고, 끝나면 개수 요약이 나옴. NAI는 요청이 몰리면(429) 잠시 기다렸다 재시도하고 토큰/Anlas 오류(401·402)는 바로 중단함.',
        tech: 'runBatchUpscale(method) — 장당 fetch POST. 일반: BATCH_UPSCALE_METHODS.plain(간격 없음). NAI: BATCH_UPSCALE_GAP_MS(800ms) 간격 + BATCH_UPSCALE_RETRY_MS([5000,10000]) 429 재시도. 배율은 localStorage "am_batch_upscale_plain_scale"(일반) / "am_batch_upscale_scale"(NAI).'
    },
    'node-log-toggle': {
        name: '📋 로그 ▼ (실행 로그 패널 접기/펼치기)',
        desc: '"⏹ 생성중지" 옆 버튼. 눌러서 펼치면 지금 생성에서 어떤 노드가 어떤 순서로 실행되는지 보이는 로그 패널이 열림. 펼쳐져 있을 때만 맨 위에 "🩺 간단 진단" 한 줄이 나오고(어느 노드에서 막힌 것 같은지 + 신호등), 실행 중인 노드 줄에 경과 초가 붙음. 접어두면 진단 표시도 같이 쉼. 접힘 상태는 기억됨.',
        tech: 'toggleNodeLogPanel() — generate.js (상태는 localStorage nodeLogPanelCollapsed). 진단 헤더/경과시간은 installAmDiagRecorder()의 setInterval이 담당.'
    },
    'node-log-diag': {
        name: '🩺 로그 패널의 간단 진단 한 줄',
        desc: '📋 로그 패널 맨 위 한 줄. 신호등(🔴 문제 / 🟡 의심 / 🟢 정상 진행 / ⚪ 이상 없음)과 함께 지금 어느 노드에서 막힌 것 같은지 알려줌(예: VAE 디코딩 단계 / 체크포인트 로더 단계). 의심될 땐 그 단계의 흔한 원인 한 줄이 같이 나옴. 마우스를 올리면 자세한 설명과 다음에 확인할 것이 뜨고, 클릭하면 빠른 진단 팝업이 열림. 추정이며 확정은 아님.',
        tech: 'updateNodeLogDiag() — generate.js (amDiagInfer() 1순위 결과 표시). 클릭은 openAmDiagQuick() — library.js.'
    },
    'edit-pos-invalidate-chips': {
        name: '🚫 공통 긍정프롬프트 (클릭으로 끄기/켜기)',
        desc: '공통 긍정프롬프트(공통 + 행동)의 태그들이 프롬프트 색깔과 같은 색으로 보이는 칸. 태그를 클릭하면 그 단어가 위 "긍정프롬프트에서 무효화" 칸에 자동으로 들어가고(취소선 = 이 조각에서만 꺼짐), 다시 클릭하면 켜짐. 공통 프롬프트 원본은 안 바뀜.',
        tech: 'refreshInvalidateChips("pos") — library.js. 판정은 실제 필터와 같은 "가중치 벗기고 소문자" 정확일치.'
    },
    'edit-neg-invalidate-chips': {
        name: '🚫 공통 부정프롬프트 (클릭으로 끄기/켜기)',
        desc: '공통 부정프롬프트의 태그들이 색깔 태그로 보이는 칸. 클릭하면 그 단어가 위 "부정프롬프트에서 무효화" 칸에 들어가 이 조각에서만 꺼지고(취소선), 다시 클릭하면 켜짐.',
        tech: 'refreshInvalidateChips("neg") — library.js.'
    },
    'edit-catblock-preview': {
        name: '🧱 차단 미리보기',
        desc: '공통 긍정 + 이 조각 프롬프트의 태그를 색깔 태그로 보여주고, 위에서 차단한 카테고리에 속해 이 조각에서 빠질 태그는 취소선으로 표시함. 보기 전용(클릭해도 바뀌지 않음) — 차단/해제는 위의 카테고리 버튼에서.',
        tech: 'refreshCatBlockPreview() — library.js. 분류는 generate.js getCanonicalPromptCategory().'
    },
    'edit-cond-rules-list': {
        name: '🔀 조건 목록 (조각 프롬프트 색깔 태그)',
        desc: '각 조건 아래의 색깔 태그는 이 조각의 프롬프트임. 위쪽 모드 선택에 따라 클릭하면 "대신 지울 단어"(취소선 = 조건 발동 시 꺼짐) 또는 "조건 단어"(🎯 표시)에 넣고 뺄 수 있음. 조각 프롬프트를 고치면 태그도 바로 갱신됨.',
        tech: 'refreshCondRuleChips()/refreshAllCondRuleChips() — library.js.'
    },
    'diag-quick-btn': {
        name: '🩺 빠른 진단 버튼 (생성중지 옆)',
        desc: '"⏹ 생성중지"와 "📋 로그" 옆의 진단 버튼. 이름 옆 신호등이 현재 상태를 3초마다 보여줌(🔴 문제 감지 / 🟡 의심 / 🟢 정상 진행 / 표시 없음=이상 없음). 누르면 팝업으로 지금 어디서 막혔는지 추정 결과(웹소켓 끊김, 서버가 워크플로우 거부, 노드 정체, 외부 API 오류 등)와 다음에 확인할 것을 보여주고, [지금 점검]으로 서버 상태까지 확인하거나 [자세히]로 도구 탭의 상세 진단을 열 수 있음. 📋 로그 패널에서도 실행 중인 노드 줄에 경과 초가 표시되고 신호가 30초↑ 끊기면 주황+⚠️, 90초↑는 빨강으로 바뀜.',
        tech: 'openAmDiagQuick()/updateAmDiagQuickButton() — library.js. 경과시간 표시는 generate.js installAmDiagRecorder()의 setInterval이 #node-log-panel의 .log-entry.active에 .log-elapsed span을 붙임. 판정은 amDiagInfer().'
    },
    'diag-run-btn': {
        name: '🩺 진단 — 지금 점검',
        desc: 'ComfyUI 서버 응답, 웹소켓 상태, ComfyUI 큐(실행/대기 개수), AssetManager 백엔드 응답, GPU 여유 VRAM, 브라우저 저장소, API 키 입력 여부를 즉시 확인하고, 기록된 이벤트와 합쳐서 "어디서 막혔는지"를 다시 추정함. 가벼운 조회만 하며 생성 작업에는 영향이 없음.',
        tech: 'amDiagRunChecks() — GET /system_stats, /queue, /assetmanager/api/memo/all (6초 시간 초과). 결과는 window.__amDiagChecks.'
    },
    'diag-autorefresh': {
        name: '🩺 진단 — 5초마다 자동 점검',
        desc: '이 탭이 화면에 보이는 동안만 5초마다 자동으로 점검하고 화면을 갱신함(다른 탭을 보고 있으면 쉼). 생성이 멈춘 것 같을 때 켜두고 변화를 지켜보기 좋음.',
        tech: 'renderAmDiagTool()의 setInterval — #diag-root가 안 보이면(offsetParent===null) 건너뜀.'
    },
    'diag-verdict': {
        name: '🩺 진단 — 판정과 추정 원인',
        desc: '🔴 문제 / 🟡 의심 / 🟢 정상 신호등과 함께, 근거에 따른 추정 원인과 "다음에 확인할 것"을 심각한 순서로 보여줌. 웹소켓 끊김, ComfyUI의 워크플로우 거부(누락 노드/모델 파일), 노드 실행 오류(VRAM 부족 등), 노드 정체, 큐 대기, 완료 이벤트 유실, NAI/나노바나나 오류(키·쿼터·서버), 백엔드 라우트 오류(404/500), 프론트 JS 오류를 구분함. 추정이지 확정은 아님.',
        tech: 'amDiagInfer() — window.amDiag(블랙박스 기록기, generate.js)의 state/events + window.__amDiagChecks를 규칙으로 판정.'
    },
    'diag-timeline': {
        name: '🩺 진단 — 최근 이벤트',
        desc: '페이지가 열려 있는 동안 기록된 사건들(웹소켓 연결/노드 전환/진행률, /prompt 등 HTTP 응답 코드와 소요시간, JS 오류, 생성 요청 시작·종료)을 최신순으로 보여줌. "오류/경고만"으로 문제가 된 줄만 걸러볼 수 있음. 최근 400개까지만 보관되고 새로고침하면 사라짐.',
        tech: 'window.amDiag.events — generate.js installAmDiagRecorder(): 웹소켓 리스너, fetch 래퍼, error/unhandledrejection, console.error/warn, executeGeneration 래퍼.'
    },
    'diag-report-btn': {
        name: '🩺 진단 — 보고서 복사 / 저장',
        desc: '지금 판정, 추정 원인, 서버 점검 결과, 최근 이벤트 120개를 텍스트로 만들어 클립보드에 복사(또는 .txt로 저장)함. 문제가 생겼을 때 그대로 붙여넣어 공유하면 원인 분석이 쉬움. API 키 같은 값은 들어가지 않고 "입력됨/비어있음"만 표시됨.',
        tech: 'amDiagBuildReport().'
    },
    'diag-serverlog-btn': {
        name: '🩺 진단 — 서버 로그에 요약 기록',
        desc: '현재 상태와 1순위 추정 원인, 가장 최근 오류 1줄을 한 줄로 만들어 서버 쪽 로그(/assetmanager/api/log)에 남김. 생성할 때마다 기록되던 기존 서버 로그와 같은 곳에 남으니, 나중에 서버 로그를 볼 때 "그때 무슨 상태였는지" 맞춰보기 좋음.',
        tech: 'API.post("/assetmanager/api/log", {message}) — generate.js의 생성 로그 기록과 같은 엔드포인트.'
    },
    'numcheck-group': {
        name: '🔢 번호표 — 그룹 선택',
        desc: '번호표를 볼 프롬프트 라이브러리 그룹을 고르는 칸. 고른 그룹의 조각들이 번호 순서대로 이름만 표시됨. 번호는 조각 편집창의 "지정 번호"가 있으면 그 값, 없으면 그룹 안 순서(1부터)이며 검수 화면의 "그룹 내 N번"과 같은 번호임.',
        tech: 'renderNumCheckTool()/getItemEffectiveNumber() — library.js (도구 탭 #tab-tools-numcheck, index.html). 번호 계산은 getGroupPositionForJob()과 동일 규칙.'
    },
    'numcheck-table': {
        name: '🔢 번호표 — 번호/이름 수정',
        desc: '몇 번에 어떤 조각이 있는지 이름만 보여주는 표. 번호 칸을 고치면 그 조각의 지정 번호가 바뀌고(비우면 순서대로 자동), 이름 칸을 고치면 조각 이름이 바뀜(Enter 또는 칸 밖 클릭으로 저장). ⚠️는 같은 번호를 쓰는 조각이 둘 이상이라는 뜻. 대조 목록을 적어두면 오른쪽에 기대값과 일치 여부(✅/❌)도 같이 표시.',
        tech: 'item.customNumber / item.name 직접 수정 → debounceLibrarySave() — library.js numcheck 블록.'
    },
    'numcheck-bulk': {
        name: '🔢 번호표 — 텍스트로 한꺼번에 수정',
        desc: '"1.사과, 2.딸기" 형식으로 번호표를 한 줄로 보여주는 칸. 여기서 이름을 고친 뒤 아래 [텍스트대로 이름 적용]을 누르면 번호가 맞는 조각들의 이름이 한꺼번에 바뀜. 번호 자체를 바꾸는 건 표의 번호 칸에서.',
        tech: 'numcheck-bulk-apply 버튼 → 정규식 (\\d+)[.:)]이름 파싱 — library.js numcheck 블록.'
    },
    'numcheck-expected': {
        name: '🔢 대조 — 기대 목록',
        desc: '"(사과,딸기,바나나)"처럼 번호 순서대로 있어야 할 이름을 적는 칸. 첫 단어는 1번 조각, 둘째는 2번 조각… 과 비교해서 조각 이름에 그 단어가 들어있으면 일치. 빈칸(사과,,바나나)은 그 번호를 건너뜀. 따옴표로 감싼 "사과","딸기","바나나" 형태도 인식하고 괄호는 있어도 없어도 됨(따옴표 안의 콤마는 그 항목의 일부로 봄, 단 목록 전체를 따옴표 한 쌍으로 감싼 경우는 콤마로 나눔). 그룹별로 따로 저장되고, 검수 화면에서 그 조각을 볼 때 일치/불일치가 같이 표시됨.',
        tech: 'localStorage "am_numcheck_v1" (그룹 id별 expected 텍스트) — parseNumCheckExpected()/numCheckMatches(), 검수 표시는 appendNumCheckBadge() — library.js.'
    },
    'numcheck-badge-toggle': {
        name: '🔢 대조 — 검수 화면 표시',
        desc: '켜두면 이미지 검수 화면에서 그 조각의 번호가 기대 목록과 일치하는지(✅/❌ + 기대값) 이름 옆에 같이 보여줌. 생성한 그림이 기대한 조각(예: 1번=사과)에서 나온 게 맞는지 확인할 때 유용.',
        tech: 'getNumCheckBadgeForJob() — showCurrentReviewImage() 단일/그리드 모드에서 호출.'
    },
    'edit-cond-rules-add-btn': {
        name: '🔀 이 조각 전용 — 조건부 프롬프트 변화',
        desc: '"만약 프롬프트에 A가 있으면 B를 추가"라는 규칙을 이 조각에만 걸어두는 기능. 예: apple이 있으면 red clothes 추가, orange가 있으면 orange clothes 추가. [+ 조건 추가]로 규칙을 마음대로 늘릴 수 있고, 조건 단어는 콤마로 여러 개(하나라도 있으면 발동) 적을 수 있음. "대신 지울 단어"에 기존 옷(예: white dress)을 적으면 발동할 때 그 태그를 지워서 교체까지 됨. 공통 프롬프트나 다른 조각에 있는 단어도 인식하고, 이 조각이 들어간 생성에서만 적용됨. 주의: 단어 단위 일치라 "orange"는 "orange hair"에도 반응함(원치 않으면 더 구체적으로 적기). 각 조건 아래에 이 조각의 프롬프트가 색깔 태그로 보이는데, 클릭하면 위쪽 모드 선택에 따라 "대신 지울 단어"(취소선 = 발동 시 꺼짐) 또는 "조건 단어"(🎯 표시)에 넣고 뺄 수 있음.',
        tech: 'item.condRules[{when,add,remove}] — library.js 편집모달(#edit-prompt-condrules). 수집: getItemCondRules()/collectCondRulesForRefs() → job.condRulesOverride. 적용: generate.js applyItemConditionalRules() (무효화 다음, 최종 조립 시점; 본 생성/스케치/저장 후 즉시 출력 3곳). add 입력칸은 .cond-rule-add — 자동완성/단축키 selector 2곳에 등록됨.'
    },
    'edit-seedgroup-value': {
        name: '🔗 시드 동일화 그룹명',
        desc: '여기에 이름을 적어두면, 같은 이름을 적은 다른 조각들과 한 번에 대기열에 넣었을 때 전부 똑같은 시드(난수 값)를 나눠 쓴다. 같은 시드면 그림의 전체적인 뼈대(구도 등)가 비슷하게 나와서, 그림체나 로라만 바꿔가며 비교하고 싶을 때 유용함. 대기열을 다시 만들 때마다 그룹 전체가 새 시드로 다시 롤됨.',
        tech: 'item.seedGroup — library.js 편집모달(#edit-seedgroup-value). getOrRollSeedForItem()/getOrRollSeedForRefs()/resetSeedGroupRollsForBatch()가 실제 시드 배분을 담당.'
    },
    artistStyleTestStart: {
        name: '🎭 작가 순차 스타일 테스트 시작',
        desc: '등록해둔 작가 이름들을 목록 순서 그대로, 전부 같은 시드로 대기열에 쭉 추가해준다. 시드가 같으니까 "같은 구도에서 작가(그림체)만 바뀌면 어떻게 보이나"를 한눈에 비교하기 좋음.',
        tech: 'runArtistStyleTest() — library.js.'
    },
    'edit-prompt-repeatcount': {
        name: '🆕 이 조각 기본 반복 횟수',
        desc: '여기에 숫자를 적어두면, 이 조각을 대기열에 보낼 때 화면 위쪽의 "전역 반복횟수" 입력값과 상관없이 항상 이 숫자만큼 반복해서 넣어준다. "그림이 잘 안 나오는(타율 낮은) 프롬프트"에 미리 넉넉하게 박아두는 용도. 비워두면 평소처럼 전송할 때 입력한 반복횟수를 그대로 따름.',
        tech: 'item.defaultRepeatCount — ensureItemRepeatField()/savePromptEditModal(). getItemDefaultRepeatCount(item)/collectMaxRepeatCountForRefs(refs) — library.js.'
    },
    'btn-send-set-queue': {
        name: '📥 세트를 대기열로 전송',
        desc: '여러 그룹에서 조각을 하나씩 골라 "조합"을 만들어두면, 그 조합으로 나올 수 있는 모든 경우의 수를 한 번에 대기열에 몽땅 넣어준다. 조합하면 안 되는 규칙(제약조건)을 걸어둔 게 있으면 그 규칙에 걸리는 조합은 알아서 빠짐.',
        tech: 'sendSetToQueue(), buildSelectedGroupArrays(), isValidCombination() — library.js.'
    },
    'btn-quick-send': {
        name: '⚡ 퀵생성',
        desc: '그룹 안에 있는 조각들을 정해둔 개수(기본 5개)씩 잘라서, 그 묶음을 순서대로 대기열에 보낸다. 조각이 아주 많은 그룹을 한 번에 다 보내지 않고 조금씩 나눠서 확인하며 보낼 때 씀.',
        tech: 'quickSendItems()/quickSendPrev()/quickSendNext() — library.js.'
    },
    'btn-auto-merge-all': {
        name: '🧩 전체 조각 자동 병합',
        desc: '이름 끝에 숫자나 버전 표시만 다르고(예: "사과1", "사과.2", "사과_3") 나머지 이름은 같은 조각들을 자동으로 찾아서, 하나의 조각 안에 여러 "버전"으로 합쳐준다. 합쳐진 뒤엔 ◀▶ 버튼으로 버전을 넘겨가며 씀.',
        tech: 'autoMergeAllCategories(), scanMergeableGroups(), baseNameKey() — library.js.'
    },
    // ── 7. 대기열 (Job Queue) ──
    'btn-start-batch': {
        name: '🚀 큐 전체 순차 생성 시작',
        desc: '지금 대기열에 쌓여있는(꺼두지 않은) 항목들을 위에서부터 순서대로 하나씩 실제로 생성 시작한다. 입력창이나 팝업이 열려있지 않을 때는 Enter 키로도 똑같이 시작할 수 있음.',
        tech: 'startBatchGeneration() — generate.js.'
    },
    'btn-start-batch-repeat': {
        name: '🔁 반복출력',
        desc: '대기열의 항목들을 한 번만 도는 게 아니라, 다 돌고 나면 처음부터 다시 반복해서 계속 생성한다(수동으로 멈출 때까지). 자리를 비워두고 오래 돌릴 때 씀.',
        tech: 'startBatchGenerationRepeatedPrompt() — generate.js.'
    },
    'btn-review': {
        name: '🖼 이미지 검수 (버튼)',
        desc: '지금까지 생성된 이미지들을 한 장(또는 반복생성이면 여러 장을 그리드로) 씩 보면서, 마음에 들면 👍(대기열에서 빠지고 지정 폴더에 저장), 별로면 👎(대기열에 그대로 남아서 나중에 다시 시도 가능) 판정하는 화면을 연다.',
        tech: 'openReviewModal() — library.js.'
    },
    reviewStart: {
        name: '▶ 검수 시작',
        desc: '검수할 그룹/범위를 고른 다음 누르면 실제로 검수 화면(한 장씩 또는 그리드)이 시작된다.',
        tech: 'startReview() — library.js.'
    },
    // ── 8. 메모장 & 네비게이션 바 ──
    'memo-pad-toggle-btn': {
        name: '📝 메모장',
        desc: '화면을 어둡게 가리지 않는 작은 메모 팝업을 열고 닫는 버튼. 열어놓은 채로 다른 곳(입력창, 버튼 등)을 계속 자유롭게 조작할 수 있음. 여러 개의 메모를 브라우저 탭처럼 관리 가능하고, 컴퓨터에 있는 .txt 파일과 양방향으로 동기화됨.',
        tech: 'toggleMemoPad() — library.js. 동기화는 __init__.py의 /assetmanager/api/memo/*.'
    },
    'shortcut-help-btn': {
        name: '⌨️ 단축키',
        desc: '지금 등록된 모든 키보드 단축키 목록을 보여주는 버튼. 여기서 단축키를 직접 다른 키로 바꿀 수도 있음.',
        tech: 'openShortcutHelpModal() — library.js.'
    },
    'shortcut-bind-mode-btn': {
        name: '🔗 버튼에 단축키 지정',
        desc: '이 모드를 켠 다음 아무 버튼이나 누르면, 그 버튼 전용 단축키를 새로 만들 수 있다(원래 그 버튼의 동작 대신 지정 모드로 들어감). 기본 단축키 Ctrl+Alt+B로도 이 모드를 켤 수 있어서, 팝업이 열려있어 이 버튼 자체가 안 보일 때도 쓸 수 있음.',
        tech: 'toggleButtonBindMode() — library.js.'
    },
    'feature-help-btn': {
        name: '📖 기능 도움말 (지금 이 버튼)',
        desc: '지금 보고 계신 이 상세 설명 모달을 여는 버튼. 섹션별로 접혀있는 목록이라 전체를 한눈에 훑어볼 수 있음.',
        tech: 'openFeatureHelpModal() — library.js. 내용은 FEATURE_HELP_SECTIONS 배열.'
    },
    'alt-help-catalog-btn': {
        name: '🖱️ 알트클릭 도움말 모아보기 (지금 이 버튼)',
        desc: 'Alt+클릭으로 하나씩 볼 수 있는 도움말들을 전부 한 화면에 섹션별로 모아서 보여주는 버튼.',
        tech: 'openAltHelpCatalogModal() — library.js. 내용은 ELEMENT_HELP_MAP + ALT_HELP_CATALOG_SECTIONS.'
    },
    'generation-guide-btn': {
        name: '🔰 처음이신가요? (생성 가이드) (지금 이 버튼)',
        desc: '아키텍처 선택부터 이미지 한 장 뽑기까지, 순서대로 따라오면 되는 단계별 가이드를 보여주는 버튼. 인페인팅/Img2Img 같은 부가기능은 일부러 빼고 "기본 생성"만 다룸.',
        tech: 'openGenerationGuideModal() — library.js. 내용은 GENERATION_GUIDE_STEPS 배열.'
    },
    // ── 2. 고급 설정 ──
    'adv-dimensions': {
        name: '해상도 드롭다운 (adv-dimensions)',
        desc: '생성될 이미지의 가로×세로 픽셀 크기. 정사각형/가로/세로 여러 비율 중 선택. 세로가 긴 옵션(832×1216 등)을 고르면 검수 화면에서도 세로 이미지로 나옴.',
        tech: 'adv-dimensions (index.html select) → generate.js가 프롬프트 JSON의 EmptyLatentImage 노드 width/height에 그대로 주입.'
    },
    'adv-sampler': {
        name: '샘플러 드롭다운',
        desc: '노이즈를 이미지로 바꿔나가는 알고리즘. Euler Ancestral이 가장 무난. Anima는 현재 euler_ancestral + simple로 고정 사용 중(전용 노드팩 버전 호환 문제로 임시 되돌려놓은 상태 — 노드팩 업데이트되면 다시 전환 예정, 미완료 항목).',
        tech: 'adv-sampler (index.html) → generate.js가 프롬프트 JSON 빌드 시 KSampler 노드에 그대로 주입.'
    },
    'adv-scheduler': {
        name: '스케줄러 드롭다운',
        desc: '스텝마다 노이즈를 얼마나씩 줄여나갈지의 스케줄. 샘플러랑 짝지어 쓰는 값이라 보통 조합을 통째로 바꾸는 게 안전함.',
        tech: 'adv-scheduler (index.html) → generate.js → KSampler 노드.'
    },
    'adv-steps': {
        name: 'Steps 입력칸',
        desc: '이미지를 다듬는 반복 횟수. 많을수록 디테일은 좋아지지만 생성 시간도 그만큼 늘어남. 보통 20~35 사이에서 씀.',
        tech: 'adv-steps (index.html input) → generate.js → KSampler 노드 steps 값.'
    },
    'adv-cfg': {
        name: 'CFG 입력칸',
        desc: '프롬프트를 얼마나 "고지식하게" 따를지의 강도. 낮으면 자유롭고 다양하게, 높으면 프롬프트에 집착하지만 과하면 그림이 깨짐(과채도/왜곡).',
        tech: 'adv-cfg (index.html input) → generate.js → KSampler 노드 cfg 값.'
    },
    'adv-seed-random': {
        name: '시드 랜덤/고정 체크박스',
        desc: '체크하면 생성할 때마다 매번 다른 랜덤 시드를 씀(다양한 결과). 해제하면 옆 입력칸에 적은 시드 값을 고정으로 계속 씀(같은 조건이면 거의 같은 그림이 나옴 — 미세 조정/재현용).',
        tech: 'adv-seed-random (index.html checkbox), onchange으로 adv-seed의 disabled를 토글 — generate.js가 실제 시드값을 프롬프트에 주입.'
    },
    'adv-seed': {
        name: '시드 입력칸',
        desc: '고정 시드로 쓸 숫자값. 위의 "랜덤" 체크가 켜져 있으면 비활성화되어 입력할 수 없음(그 상태에선 어차피 무시되고 매번 새 랜덤값이 쓰임).',
        tech: 'adv-seed (index.html input) → generate.js → KSampler 노드 seed 값.'
    },
    // ── 9-추가. NAI Director 도구 ──
    'nai-director-dropzone': {
        name: '🎬 NAI Director — 원본 이미지',
        desc: '변환할 이미지를 클릭하거나 드래그해서 넣는다.',
        tech: 'handleNaiDirectorFile(file) — generate.js.'
    },
    'nai-director-token': {
        name: '🎬 NAI Director — API 토큰',
        desc: '비워두면 생성 탭(아키텍처: NAI)에 입력해둔 토큰을 그대로 가져다 쓴다. 따로 다른 계정으로 쓰고 싶을 때만 여기 입력.',
        tech: '#nai-director-token (index.html) → runNaiDirectorTool() — generate.js. 비어있으면 #nai-api-token 또는 localStorage의 naiApiToken을 대신 사용.'
    },
    'nai-director-type': {
        name: '🎬 NAI Director — 도구 선택',
        desc: '선화 추출(사진/채색본에서 선만 뽑기) / 스케치화(러프 스케치처럼) / 스케치 채색(선화에 색 입히기, 프롬프트로 색 지정 가능) / 감정·표정 변경(프롬프트로 목표 감정 지정) / 배경 제거(투명 배경으로) / 배경 정리(배경을 단순하게 정리) / 🔧 업스케일(2배 또는 4배 선택 가능, 기본 4배 — 둘 다 augment-image가 아닌 별도 /ai/upscale 엔드포인트라 Anlas가 안 드는 무료 기능) 중 고른다. "업스케일"을 고르면 바로 아래에 배율 선택(nai-director-upscale-scale)이 나타남.',
        tech: '#nai-director-type (index.html select) → toggleNaiDirectorPromptRow()가 reqType==="upscale"일 때 #nai-director-upscale-row를 보여줌. runNaiDirectorTool()의 reqType/scale → __init__.py api_nai_director()의 req_type(upscale이면 NAI_UPSCALE_ENDPOINT="/ai/upscale" 분기, 그 외는 augment-image API).'
    },
    'nai-director-upscale-row': {
        name: '🎬 NAI Director — 업스케일 배율',
        desc: '"🔧 업스케일"을 골랐을 때만 나타나는 배율 선택(2배 / 4배, 기본 4배). 둘 다 NAI의 /ai/upscale 전용 엔드포인트를 써서 Anlas가 들지 않는 무료 기능 — augment-image를 쓰는 다른 Director 기능(선화추출/채색 등)과는 과금 체계 자체가 다름.',
        tech: '#nai-director-upscale-scale (value="4"|"2", 기본 4) — runNaiDirectorTool()에서 parseInt로 읽어 scale로 전송. __init__.py api_nai_director()의 upscale 분기, api_nai_upscale_file()(⬆️ 검수 완료 후 일괄 업스케일 기능)도 같은 scale(2|4) 파라미터 규칙을 공유.'
    },
    'nai-director-prompt': {
        name: '🎬 NAI Director — 지시 프롬프트',
        desc: '채색/감정변경 도구에서만 나타남. 채색이면 "이런 색으로 칠해줘" 식 지시, 감정변경이면 "이런 표정으로 바꿔줘" 식 지시를 적는다. 비워둬도 동작은 하지만(자동으로 적당히 처리), 적으면 더 의도대로 나올 확률이 높음.',
        tech: '#nai-director-prompt (index.html) → runNaiDirectorTool() → NAI 요청 payload.prompt (colorize/emotion일 때만 전송).'
    },
    'nai-director-defry': {
        name: '🎬 NAI Director — 디프라이 (Defry)',
        desc: '원본의 선/구도를 얼마나 강하게 유지할지. 낮을수록(0에 가까울수록) 원본에 충실하고, 높을수록 더 많이 바뀜. 채색/감정변경에서만 쓰임.',
        tech: '#nai-director-defry (index.html range) → runNaiDirectorTool() → NAI 요청 payload.defry.'
    },
    'nai-director-run': {
        name: '🚀 실행 (NAI Director)',
        desc: '왼쪽 이미지를 선택한 도구로 변환한다. 변환 결과는 output/nai 폴더에도 저장되지만, 대기열/검수 흐름과는 무관한 독립 실행이다.',
        tech: 'runNaiDirectorTool() — generate.js. 백엔드 api_nai_director() — __init__.py (POST /assetmanager/api/nai_director).'
    },
    // ── 9. 도구 (메타데이터 뷰어 / 단독 검열기 / 퀵 리사이저) ──
    'metadata-dropzone': {
        name: '📥 메타데이터 뷰어 — 이미지 드롭존',
        desc: '이 프로그램(ComfyUI)으로 만든 PNG/WEBP 이미지를 끌어다 놓으면, 그 이미지를 만들 때 썼던 프롬프트/체크포인트/로라/시드 등 설정값을 그대로 읽어서 보여준다. 이미지 파일 자체에 그 정보가 저장돼 있어서 가능한 기능 — 다른 프로그램에서 만든 이미지는 정보가 없어서 안 뜰 수 있음.',
        tech: '#metadata-dropzone (index.html) — drop/change 이벤트로 processDroppedFile(file) 호출 → parseComfyUIMetadataFromPNG(file) (component_metadata.js, main.js 아님). PNG의 tEXt 청크에서 프롬프트 JSON을 파싱.'
    },
    'btn-standalone-send-gen': {
        name: '🪄 이 설정으로 생성 (Send to Generate)',
        desc: '방금 분석한 이미지의 설정값을 그대로 Generate 화면에 채워 넣는다. 마음에 든 남의(또는 예전) 그림과 최대한 비슷한 조건에서 다시 생성해보고 싶을 때 씀. 체크포인트/프롬프트/로라뿐 아니라 아키텍처(SDXL/아니마/SD3, CLIPLoader의 type 값으로 자동 판별해 화면도 그에 맞게 전환됨)·UNet/Clip/VAE·샘플러·스케줄러·Steps·CFG까지 전부 읽어서 채운다(🐛 예전엔 아키텍처 전환 자체를 안 하고 샘플러/스케줄러/Steps/CFG는 손도 안 대서, 아니마 이미지를 불러와도 SDXL용 체크포인트 칸만 찾다 끝나고 화면엔 이전 값이 그대로 남아 품질이 떨어졌음 — 수정 완료). 지금 가진 목록에 없는 값(파일이 없거나 이름이 다름)은 조용히 무시되지 않고 "적용되지 않았습니다" 알림으로 어떤 항목인지 알려줌.',
        tech: 'applyMetadataToForm() — component_metadata.js (main.js 아님). setSelectValueSafe()로 옵션 존재 여부 확인 후 대입, CLIPLoader.inputs.type이 "qwen_image"면 anima, "sd3"면 sd3, 둘 다 아니면 sdxl로 판별 후 toggleArchitectureUI()/toggleAnimaModelSourceUI() 호출(index.html). 분석 결과가 있을 때만 버튼이 나타남.'
    },
    'censor-dropzone': {
        name: '📸 단독 검열기 — 이미지 드롭존',
        desc: '이미 가지고 있는 이미지 파일(이 프로그램으로 만든 게 아니어도 상관없음)을 끌어다 놓으면, 오른쪽에서 설정한 부위/스타일대로 모자이크 처리를 해준다. 여러 장을 한 번에 넣으면 아래쪽 대기열에 쌓여서 순서대로 처리됨.',
        tech: '#censor-dropzone (index.html) — drop/change 이벤트로 addFilesToCensorQueue(files) 호출.'
    },
    censorTargetCheckbox: {
        name: '타겟 부위 체크박스 (꼭/보/꼬/항/알/X-Ray/단면)',
        desc: '체크된 부위만 자동으로 찾아서 모자이크를 씌운다. 기본으로 꼭/보/꼬 세 개만 켜져 있고 나머지는 꺼져 있음 — 필요한 부위만 추가로 켜면 됨.',
        tech: 'tool-censor-nipples/pussy/penis/anus/testicles/xray/cross-section (index.html checkbox) — runStandaloneCensor()가 체크된 것만 검열 대상으로 서버에 전달.'
    },
    'tool-censor-mode': {
        name: '검열 방식 드롭다운',
        desc: '모자이크(타일 모양으로 잘게 쪼갬) / 흰색 블러 막(뿌옇게 흐림) / 흰색 단색(그냥 흰 도형으로 완전히 가림) 중 하나를 고른다.',
        tech: 'tool-censor-mode (index.html select) — runStandaloneCensor()가 이 값을 서버 검열 API에 전달.'
    },
    'tool-censor-intensity': {
        name: '검열 강도 슬라이더',
        desc: '숫자가 높을수록 모자이크 타일이 커지거나 블러가 더 넓게 퍼진다. 낮으면 살짝만 가려짐.',
        tech: 'tool-censor-intensity (index.html range input) — runStandaloneCensor()가 서버 검열 API에 전달.'
    },
    censorRunPipeline: {
        name: '🚀 대기열 검열 파이프라인 가동',
        desc: '드롭해둔 이미지들을 왼쪽 옵션(부위/방식/강도) 그대로 순서대로 전부 처리한다.',
        tech: 'runStandaloneCensor() — main.js.'
    },
    censorDownloadZip: {
        name: '📦 전체 완료본 ZIP 다운로드',
        desc: '처리가 끝난 이미지들을 하나하나 저장하지 않고, 압축파일(zip) 하나로 한 번에 받는다.',
        tech: 'downloadCensorZip() — main.js.'
    },
    censorResetTool: {
        name: '↺ 큐 초기화 (비우기)',
        desc: '지금까지 드롭해둔 이미지 대기열을 전부 비운다. 처리 결과도 같이 사라짐.',
        tech: 'resetCensorTool() — main.js.'
    },
    'btn-brush-color': {
        name: '🎨 붓 색상 (수동 덧칠)',
        desc: '자동 검열로 부족한 부분을 직접 손으로 덧칠해서 가리고 싶을 때 쓰는 붓의 색깔을 고른다.',
        tech: 'censor-brush-color-picker (index.html color input) — 캔버스 덧칠 로직에서 사용.'
    },
    'censor-brush-size': {
        name: '붓 크기 슬라이더',
        desc: '수동 덧칠할 때 붓의 굵기를 조절한다.',
        tech: 'censor-brush-size (index.html range input).'
    },
    'censor-brush-eraser': {
        name: '지우개 체크박스',
        desc: '체크하면 붓이 "칠하기"가 아니라 "지우기"로 바뀐다. 잘못 칠한 부분을 되돌릴 때 씀.',
        tech: 'censor-brush-eraser (index.html checkbox).'
    },
    censorClearCanvas: {
        name: '초기화 (덧칠 지우기)',
        desc: '지금까지 손으로 덧칠한 내용을 전부 지운다. 자동 검열 결과 자체는 안 지워짐.',
        tech: 'clearCensorCanvas() — main.js.'
    },
    censorSaveRetouch: {
        name: '💾 병합 저장 (덧칠 합치기)',
        desc: '자동 검열 결과 위에 손으로 덧칠한 내용까지 합쳐서 하나의 최종 이미지로 저장한다.',
        tech: 'saveRetouchedImage() — main.js.'
    },
    'censor-compare-slider': {
        name: '전/후 비교 슬라이더',
        desc: '가운데 막대를 좌우로 끌면 검열 전(원본)과 검열 후 결과를 한 화면에서 겹쳐서 비교해볼 수 있다.',
        tech: 'censor-compare-slider (index.html) — 드래그 시 clip-path로 censor-img-before의 보이는 영역을 조절.'
    },
    'resizer-dropzone': {
        name: '✂️ 퀵 리사이저 — 이미지 드롭존',
        desc: '이미지를 끌어다 놓으면 오른쪽 설정(크기/포맷)대로 한 번에 변환해준다. 여러 장을 동시에 넣으면 아래 대기열에 쌓여서 순서대로 처리됨.',
        tech: '#resizer-dropzone (index.html) — drop/change 이벤트로 addFilesToResizerQueue(files) 호출.'
    },
    'resizer-mode': {
        name: '리사이즈 방식 드롭다운',
        desc: '원본 해상도 유지(크기는 안 바꾸고 포맷/용량만 변환) / 비율(%) 축소(예: 50%면 가로세로 절반) / 긴 축 기준(가장 긴 변을 지정한 픽셀에 맞춤, 비율 유지) / 강제 해상도 지정(가로x세로를 원하는 숫자로 딱 고정, 비율이 깨질 수 있음) 중 고른다.',
        tech: 'resizer-mode (index.html select) → toggleResizerInputs()가 고른 방식에 맞는 입력칸만 보여줌.'
    },
    'resizer-val-scale': {
        name: '스케일(%) 입력칸',
        desc: '"비율(%) 축소" 방식일 때 나오는 값. 50이면 가로세로 절반 크기로 줄어든다.',
        tech: 'resizer-val-scale (index.html input) — runStandaloneResizer()가 서버 API에 전달.'
    },
    'resizer-val-longest': {
        name: '픽셀(px) 입력칸 (긴 축 기준)',
        desc: '"긴 축 기준" 방식일 때 나오는 값. 이미지의 가로/세로 중 더 긴 쪽을 이 픽셀 수에 맞추고, 짧은 쪽은 비율 그대로 따라서 줄어든다.',
        tech: 'resizer-val-longest (index.html input) — runStandaloneResizer()가 서버 API에 전달.'
    },
    'resizer-val-width': {
        name: '가로(W) 입력칸 (강제 해상도)',
        desc: '"강제 해상도 지정" 방식일 때 나오는 값. 원본 비율을 무시하고 이 가로 픽셀 수로 딱 맞춘다 — 원본 비율과 다르면 이미지가 눌리거나 늘어나 보일 수 있음.',
        tech: 'resizer-val-width (index.html input) — runStandaloneResizer()가 서버 API에 전달.'
    },
    'resizer-val-height': {
        name: '세로(H) 입력칸 (강제 해상도)',
        desc: '위 가로(W)와 짝지어 쓰는 세로 픽셀 값. 마찬가지로 원본 비율 무시하고 강제로 맞춤.',
        tech: 'resizer-val-height (index.html input) — runStandaloneResizer()가 서버 API에 전달.'
    },
    'resizer-format': {
        name: '출력 포맷 드롭다운',
        desc: 'WEBP(용량 대비 화질이 좋아서 추천) / JPEG(호환성 좋지만 화질 손실 있음) / PNG(무손실이라 화질은 최고지만 용량이 큼) 중 고른다.',
        tech: 'resizer-format (index.html select) → toggleResizerQuality()가 포맷에 따라 압축품질 칸 표시 여부를 조절.'
    },
    'resizer-quality': {
        name: '압축 품질 슬라이더',
        desc: 'WEBP/JPEG일 때만 나옴. 숫자가 높을수록 화질은 좋아지지만 파일 용량도 커진다. PNG는 무손실이라 이 옵션 자체가 없음.',
        tech: 'resizer-quality (index.html range input) — runStandaloneResizer()가 서버 API에 전달.'
    },
    resizerRunBatch: {
        name: '⚡ 대기열 일괄 변환 시작',
        desc: '드롭해둔 이미지들을 왼쪽 옵션(리사이즈 방식/포맷/품질) 그대로 순서대로 전부 변환한다.',
        tech: 'runStandaloneResizer() — main.js.'
    },
    resizerDownloadZip: {
        name: '📦 완료본 ZIP 다운로드',
        desc: '변환이 끝난 이미지들을 압축파일(zip) 하나로 한 번에 받는다.',
        tech: 'downloadResizerZip() — main.js.'
    },
    resizerResetTool: {
        name: '↺ 큐 초기화 (비우기)',
        desc: '지금까지 드롭해둔 이미지 대기열을 전부 비운다. 변환 결과도 같이 사라짐.',
        tech: 'resetResizerTool() — main.js.'
    },

    // 🆕(기능 도움말 점검 — gallery.js/ui_manager.js 확인 후 추가) 갤러리 탭 전체가
    // alt-click 등록이 0개였던 걸 발견해서 새로 작성. gallery.js는 출력 이미지 브라우저,
    // ui_manager.js는 탭 전환/라이트박스/모달/컨텍스트메뉴 등 "순수 UI" 담당.
    'gallery-folder-list': {
        name: '🖼 갤러리 — 좌측 폴더 트리',
        desc: 'output 폴더 구조를 그대로 트리로 보여줌. 맨 위 "🌌 전체 이미지"를 고르면 모든 폴더의 이미지를 한꺼번에(최신순) 보여주고, 특정 폴더를 고르면 그 폴더 + 하위 폴더의 이미지만 모아서 보여줌(하위 폴더 이미지도 다 합쳐짐 — 예: "a" 폴더를 고르면 "a/b", "a/c" 안의 이미지도 같이 나옴). 폴더명 숫자는 그 폴더(+하위) 이미지 총 개수. ▶ 아이콘을 누르면 하위 폴더를 펼치고, 검색창에 글자를 치면 이름이 일치하는 폴더만 남으면서 자동으로 펼쳐짐.',
        tech: 'fetchGalleryData() — gallery.js, /assetmanager/api/gallery GET. buildFolderTree()가 서버가 준 평평한 폴더 목록(group.folder가 "a/b/c" 같은 경로 문자열)을 "/" "\\\\" 기준으로 쪼개서 중첩 트리 객체로 변환하고 각 노드에 _count(하위 포함 누적 이미지 수)를 더해감. renderTreeNodes()가 재귀적으로 HTML 생성, openedGalleryFolders(Set)가 펼침 상태 기억. selectGalleryFolder(path)가 currentFolderData를 바꾸고 renderGalleryGrid() 재호출. UIManager.openTab()이 "tab-gallery"로 처음 들어올 때(폴더 목록이 아직 "데이터 로딩 중..."이면) fetchGalleryData()를 자동 호출.'
    },
    'gallery-search-input': {
        name: '🔍 갤러리 폴더 검색',
        desc: '글자를 치면 폴더 이름(경로 포함)에 그 글자가 들어간 폴더만 트리에 남기고, 검색 중엔 결과를 다 보여주려고 자동으로 전부 펼쳐짐. 입력칸을 비우면 원래 트리(펼침 상태 기억된 대로)로 돌아감.',
        tech: "input 이벤트 → filterGalleryFolders(val) → renderGalleryFolders(filterText) → buildFolderTree(data, filterText)가 group.folder.toLowerCase().includes(filterText.toLowerCase())로 필터링. DOMContentLoaded 시점에 리스너 등록(gallery.js 맨 아래)."
    },
    'gallery-grid': {
        name: '🖼 갤러리 — 이미지 그리드',
        desc: '선택된 폴더(또는 전체)의 이미지를 최신순으로 늘어놓음. 그냥 클릭하면 라이트박스(전체화면 미리보기)로 열림. Ctrl/Cmd+클릭이나 체크박스 클릭은 그 이미지 하나만 선택 토글, Shift+클릭은 마지막으로 선택한 이미지부터 지금 클릭한 이미지까지 범위 전체를 선택. 우클릭하면 컨텍스트 메뉴(삭제 / 이 설정으로 생성 등)가 뜸.',
        tech: 'renderGalleryGrid(folderData) — getCurrentImageList()(현재 폴더 기준 이미지 1차원 배열, timestamp 역순 정렬)를 이미지 태그로 렌더링. handleImageClick(e, index, fullPath)가 e.ctrlKey/e.metaKey/e.shiftKey로 분기: Shift는 lastSelectedIndex~index 범위를 selectedImagePaths(Set)에 추가, 일반 클릭은 openLightbox(img.url)(UIManager). 선택 상태는 전체 재렌더링 없이 syncDOMWithSelection()으로 DOM 클래스만 갱신(성능 최적화). 우클릭은 handleGalleryContextMenu() → UIManager.openContextMenu()가 메뉴 표시 + window.currentTargetImg에 대상 기억.'
    },
    'current-gallery-title': {
        name: '🖼 갤러리 — 현재 폴더 제목',
        desc: '지금 보고 있는 폴더 경로("📂 폴더명") 또는 "🌌 전체 이미지" 표시. 폴더를 바꿀 때마다 자동으로 갱신됨 — 이 자체는 누를 수 있는 버튼이 아니라 그냥 현재 위치 표시.',
        tech: 'selectGalleryFolder() 안에서 textContent 직접 갱신 — gallery.js.'
    },
    'gallery-selection-info': {
        name: '🖼 갤러리 — 선택 개수 표시',
        desc: '지금 Ctrl/Shift로 선택해둔 이미지가 몇 장인지 보여줌("선택됨: N"). 이 상태에서 컨텍스트 메뉴나 별도 버튼으로 "선택한 것만 삭제"를 걸 수 있음.',
        tech: 'updateGallerySelectionInfo() — selectedImagePaths.size를 읽어 textContent 갱신. deleteSelectedGalleryImages()가 이 Set을 기준으로 일괄 삭제 요청(executeDelete) 후 비움.'
    },
    lightbox: {
        name: '🖼 라이트박스 (이미지 전체화면 보기)',
        desc: '갤러리에서 이미지를 그냥 클릭하면 뜨는 전체화면 미리보기. 배경이나 닫기로 닫을 수 있음(바깥 영역 클릭 시 닫히는지는 CSS/다른 클릭 리스너에 달려있을 수 있음 — 이 함수 자체는 열고 닫는 것만 담당).',
        tech: 'UIManager.openLightbox(src)/closeLightbox() — ui_manager.js. #lightbox-img에 src를 넣고 #lightbox의 display를 flex로. window.openLightbox로 전역 노출되어 gallery.js의 handleImageClick()에서 직접 호출.'
    },
    'context-menu': {
        name: '🖱 갤러리 우클릭 컨텍스트 메뉴',
        desc: '갤러리 이미지를 우클릭하면 마우스 위치에 뜨는 메뉴. "이 설정으로 생성"(이미지에 박힌 ComfyUI 메타데이터를 생성 탭 폼에 그대로 적용) / Img2Img로 보내기 / 🆕 모자이크 리터치 / 🆕 이 설정을 조각으로 저장 / 이미지 삭제 등의 동작을 담음. 메뉴 바깥 아무 곳이나 클릭하면 자동으로 닫힘.',
        tech: 'UIManager.openContextMenu(e, filename, subfolder) — ui_manager.js. gallery.js의 handleGalleryContextMenu()에서 호출, window.currentTargetImg에 대상 파일 기억. UIManager.initContextMenuListener()가 document 전역 click에 "메뉴 닫기"를 걸어둠(UIManager.init()에서 자동 등록). "이 설정으로 생성"은 sendToGenerateFromGallery()(gallery.js) → /assetmanager/api/image_metadata GET → applyMetadataToForm()(component_metadata.js)로 이어짐. 🆕 "🖌️ 모자이크 리터치"는 retouchContextImage()(tools_censor.js) → openRetouchForImage() — 단독 검열기 탭의 비교뷰+리터치 캔버스 재사용(🔍 단독 검열기 항목 참고). 🆕 "💾 이 설정을 조각으로 저장"은 saveImageSettingsAsFragment()(gallery.js, 같은 image_metadata를 받아 프롬프트/로라만 추출) → createGalleryImagePiece()(library.js, 📷 카메라 구도의 createCompositionPiece()와 완전히 같은 패턴) — "🖼 갤러리에서 저장" 그룹에 새 조각 생성. 체크포인트는 이 라이브러리 시스템에 조각 단위 저장 개념이 없어서(생성 탭에서 전역으로 고르는 값) 가져오지 않음.'
    },
    'model-info-modal': {
        name: 'ℹ️ 모델(체크포인트/로라) 상세 정보 모달',
        desc: '체크포인트나 로라를 고르는 드롭다운/카드에서 정보 보기를 누르면, 그 모델의 CivitAI 미리보기 이미지·베이스 모델·트리거 워드·태그·설명을 모아서 보여줌. 로컬에 .json 메타데이터 파일이 없으면 "정보를 찾지 못했습니다" 표시. 🆕(모델 정보 모달 ↔ 태그 사전 연결) 트리거 워드(Trigger Words, 초록)와 태그(Tags, 파랑)가 이제 읽기 전용 텍스트가 아니라 **클릭 가능한 칩**으로 나옴 — 칩 본문을 클릭하면 공통 긍정 프롬프트(base-pos)에 바로 추가되고(추가되면 취소선으로 표시), 옆의 "!" 버튼을 누르면 태그 사전(🆕 태그 사전 "!" 버튼 항목 참고) 풍선 설명이 그 자리에서 뜸. 둘은 성격이 다름 — Trigger Words는 그 모델을 실제로 학습시킬 때 쓰인 "진짜 트리거 단어", Tags는 CivitAI가 매긴 넓은 범주의 스타일 태그(둘 다 있을 수도, 하나만 있을 수도, 둘 다 없을 수도 있음 — 모델 업로더가 CivitAI에 등록해둔 메타데이터에 달려있음). Tags 쪽은 danbooru 태그 형식이 아닐 수 있어서 "!"를 눌러도 "사전에 없는 태그입니다"가 뜰 수 있는데, 정상적인 동작임.',
        tech: 'UIManager.showModelInfo(modelType, modelName) — ui_manager.js. /assetmanager/api/model_info GET(type/name 쿼리). 이미지는 info.civitai.images[0].url 우선, 없으면 info.preview_url을 /assetmanager/api/view_image로 프록시. 설명은 info.modelDescription 또는 info.civitai.model.description, 둘 다 없으면 안내 문구. 칩 렌더링은 UIManager._renderModelInfoTagChips(slotId, tagList, color) — info.trainedWords/info.tags 배열을 받아 클릭 시 #base-pos에 콤마로 이어붙이고 input 이벤트 dispatch(appStateManager 저장 트리거). "!" 버튼은 tag_dictionary.js가 새로 노출한 공개 API window.TagDictionary.createBangButton(tagText)를 그대로 재사용(자동완성 드롭다운용으로 만들어졌던 .tag-dict-bang을, position:static으로 풀어서 모달처럼 부모가 position:relative가 아닌 곳에서도 쓸 수 있게 함) — TagDictionary가 아직 로드 전이면 "!" 버튼 없이 칩만 표시(조용히 생략, 에러 없음).'
    },
    'live-preview-toggle': {
        name: '▲▼ 라이브 프리뷰 접기/펼치기',
        desc: '생성 중 실시간 미리보기 패널을 접었다 펼쳤다 한다. 접힌 상태는 저장되어 다음에 켰을 때도 유지됨(appStateManager 연동).',
        tech: 'UIManager.toggleLivePreview() — #live-preview-body에 collapsed 클래스 토글, #live-preview-container에 collapsed-mode 토글, 버튼 텍스트도 "▲ 접기"/"▼ 펼치기"로 교체. appStateManager.debounceSave() 호출.'
    },
    'gen-resizer': {
        name: '↔️ 생성 탭 좌우 패널 너비 조절 (드래그)',
        desc: '생성 탭에서 왼쪽(설정)과 오른쪽(결과/프리뷰) 패널 경계를 마우스로 드래그해서 너비 비율을 바꿀 수 있다. 너무 한쪽으로 쏠리지 않게 40%~90% 범위로만 움직여짐.',
        tech: 'UIManager.initLayoutResizer() — ui_manager.js. #gen-resizer의 mousedown으로 isResizing 시작, document 전역 mousemove에서 #tab-generate 컨테이너 기준 퍼센트를 계산해 #gen-left/#gen-right의 width를 직접 갱신, mouseup으로 종료. UIManager.init()에서 자동 등록.'
    },
    // 🆕 ⚙️ 환경 설정 탭(기존엔 완전히 빈 탭이었음)
    'settings-nsfw-warning': {
        name: '🔞 GPT/나노바나나 성인용 키워드 경고 켜고 끄기',
        desc: '체크하면(기본 켜짐) GPT·나노바나나로 생성 요청을 보내기 직전에, 프롬프트에 🔞 성인용 태그가 있을 때 확인창이 뜬다. 꺼두면 이 확인창 없이 바로 전송됨(로컬 ComfyUI/NAI 생성에는 애초에 영향 없음).',
        tech: 'AppSettings.set("nsfwWarningEnabled", checked) — library.js. generate.js의 confirmProceedWithAdultPrompt()가 매 생성 시도마다 AppSettings.get("nsfwWarningEnabled")를 읽어서 분기.'
    },
    'settings-default-tag-form': {
        name: '🔤 태그 자동완성 기본 표기 선택',
        desc: '자동완성에서 표기만 다른 같은 태그(gray hair / gray_hair 등)를 합칠 때, 다른 기준으로도 못 정하면 이 설정을 따름.',
        tech: 'AppSettings.set("defaultTagForm", value) → window.setDefaultTagForm(value)(korean_autocomplete.js) 즉시 반영. 저장은 localStorage am_app_settings_v1.'
    },
    'settings-skip-image-verification': {
        name: '🖼 생성 내역 — PNG 검증 건너뛰기',
        desc: '켜면 조각의 "🖼 생성 내역"을 열 때 HEAD/PNG 검증을 생략하고 기록된 파일명을 그냥 믿고 바로 보여줌(빠름). 꺼두면(기본) 파일이 지워졌거나 같은 이름의 다른 파일로 바뀐 걸 걸러낼 수 있지만 그만큼 열 때 조금 느려짐.',
        tech: 'AppSettings.set("skipImageVerification", checked). openItemGeneratedImagesModal()이 이 값을 읽어서 verifyHistoryEntry() 호출 자체를 건너뛸지 결정.'
    },
    // 🆕 나노바나나/GPT/NAI 공통 — 생성 직후 자동 업스케일
    'api-post-upscale': {
        name: '⬆️ 생성 직후 자동 업스케일 (나노바나나/GPT/NAI 공용)',
        desc: '나노바나나·GPT·NAI는 로컬 체크포인트가 없어서 모델 기반 업스케일/디테일러/모자이크(hires-fix 방식, 체크포인트+KSampler 필요)는 못 붙지만, 체크포인트 없이 Pillow로 그냥 확대만 하는 "일반 업스케일"은 생성 직후 자동으로 돌릴 수 있다. 켜두면 결과가 나올 때마다 추가로 한 번 더 호출되고(배율은 아래 숫자칸), 원본은 그대로 두고 같은 폴더의 upscaled 하위 폴더에 확대본이 저장되며 검수/히스토리엔 확대본이 뜬다. 실패해도(서버 통신 오류 등) 원본 생성 자체는 이미 끝난 뒤라 조용히 넘어가고 원본이 그대로 쓰인다.',
        tech: 'generate.js의 autoUpscaleApiResult(imgInfo) — executeNanoBananaGeneration()/executeGptGeneration()/executeNaiGeneration()이 결과를 반환하기 직전에 공통으로 호출. POST /assetmanager/api/upscale_file에 {filename, subfolder, type, scale, outSubfolder:"upscaled"}를 보냄(절대경로 path 대신 filename/subfolder/type으로도 호출 가능하도록 __init__.py의 api_upscale_file()을 확장함 — folder_paths.get_output_directory() 등으로 서버에서 직접 경로 계산). 성공하면 {filename은 그대로, subfolder만 "/upscaled" 붙임}으로 imgInfo를 교체해서 돌려줌.'
    },
    'api-post-upscale-note': {
        name: '⬆️ 생성 직후 자동 업스케일 — 안내문',
        desc: '위 체크박스/배율 설정에 대한 설명 문구. 토글 자체의 설명은 "⬆️ 생성 직후 자동 업스케일" 항목 참고. 🆕 이것과 별개로, 체크포인트 기반 업스케일/디테일러/모자이크를 쓰는 법도 안내함(아래 "🧩 모델 기반 후처리" 항목 참고).',
        tech: 'index.html, 순수 안내 텍스트(상호작용 없음).'
    },
    // 🆕 나노바나나/GPT/NAI — 체크포인트 기반(디테일러/모자이크/모델 업스케일) 후처리
    'post-process-model-note': {
        name: '🧩 모델 기반 후처리용 체크포인트 — 안내문',
        desc: '나노바나나·GPT·NAI를 고르면 체크포인트/VAE/CLIP/로라 선택창이 숨지 않고 그대로 보이는데, 이건 생성 자체에 쓰이는 게 아니라 "고급 설정"의 업스케일링/디테일러/검열(모자이크)을 켰을 때 그 후처리 단계에서만 쓰인다. 후처리를 안 쓸 거면 그냥 비워둬도 생성엔 지장 없음.',
        tech: 'applyLocalPostProcessToExternalImage(imgInfo) (generate.js) — #toggle-upscale/#toggle-detailer/#toggle-mosaic 중 하나라도 켜져 있으면 실행. window.baseWorkflow를 복제해서 ckptId에 #gen-checkpoint 값을 넣고, #selected-loras를 로라 로더에 적용한 뒤, 생성된 외부 API 이미지를 /upload/image로 ComfyUI input 폴더에 재업로드해서 LoadImage 노드로 연결 → applyUpscalerPipeline → applyDetailerPipeline → applyCensorPipeline 순서로 그대로 통과시키고 "[Main] Image Save"에 최종 결과를 연결. 🔧 tools_censor.js의 runStandaloneCensor()와 동일한 방식으로, 타이틀이 "[Upscaler]/[Detailer]/[Censor]"로 시작하지 않는 노드(+체크포인트/로라/우리 LoadImage/최종 Save 제외)는 전부 삭제한 뒤 /prompt로 제출 — 불필요한 [Main] KSampler 로컬 생성이 같이 안 돌게 함. tools_censor.js의 executeStandaloneWorkflow()와 같은 패턴(웹소켓 executed/execution_error 이벤트)으로 완료까지 기다렸다가(타임아웃 180초, 디테일러/업스케일이 검열보다 오래 걸릴 수 있어서 30초보다 늘림) 최종 이미지로 imgInfo를 교체해서 반환. 실패/타임아웃/체크박스 다 꺼짐/체크포인트 미선택이면 원본 imgInfo를 그대로 반환.'
    },
    // 🆕 👗 의상에셋매니저 (outfit_set_wizard.js) — 이전 세션에 등록 누락됐던 것을 채움
    'btn-outfit-set-wizard': {
        name: '👗 의상에셋매니저 열기',
        desc: '+ 조각 추가 버튼 옆의 전용 버튼. 여러 벌의 의상을 한 화면에서 만들어서 한 그룹에 조각으로 한꺼번에 등록하는 모달을 연다. 자세한 사용법은 📖 기능 도움말의 "12. 👗 의상에셋매니저" 섹션 참고(칩/색상·품질 팔레트/행동 조각/자동 저장 등 내부 요소는 의상마다 동적으로 생성되는 구조라 이 Alt+클릭 지도에는 개별 등록 대신 그 섹션에 모아서 설명함).',
        tech: 'ensureOutfitSetButton() — outfit_set_wizard.js, #btn-add-item 옆에 버튼 삽입. onclick=openOutfitSetModal().'
    },
    'outfit-set-group-select': {
        name: '저장할 그룹 선택',
        desc: '의상에셋매니저에서 만든 조각들을 어느 그룹(카테고리)에 저장할지 고른다. 목록 맨 아래 "+ 새 그룹 만들기"를 고르면 바로 아래 이름 입력칸이 나타난다. 고른 값/입력한 새 그룹 이름은 localStorage에 남아 다음에 열 때도 유지된다.',
        tech: 'populateGroupSelect() — outfit_set_wizard.js. onchange="onGroupSelectChange()"로 새 그룹 입력칸 표시/숨김 전환, saveWizardState()로 즉시 저장. syncOutfitsToLibrary()가 이 값으로 resolveTargetCategory()를 호출해 실제 저장 대상 그룹을 정함.'
    },
    'outfit-set-new-group-name': {
        name: '새 그룹 이름 입력',
        desc: '저장할 그룹에서 "+ 새 그룹 만들기"를 골랐을 때만 나타나는 입력칸. 여기 입력한 이름으로 새 그룹이 만들어진다.',
        tech: 'oninput="saveWizardState()"로 입력할 때마다 즉시 localStorage 저장 — outfit_set_wizard.js. onGroupSelectChange()가 표시 여부를 제어.'
    },
};

// 🆕 검열기 타겟 부위 체크박스 7개는 설명이 전부 같아서, 위에서 만든 객체 하나(censorTargetCheckbox)를
// 여러 id에 그대로 재사용한다 (중복 작성 방지).
['tool-censor-nipples', 'tool-censor-pussy', 'tool-censor-penis', 'tool-censor-anus',
 'tool-censor-testicles', 'tool-censor-xray', 'tool-censor-cross-section'].forEach(id => {
    ELEMENT_HELP_MAP[id] = ELEMENT_HELP_MAP.censorTargetCheckbox;
});

// 🔧(인페인팅 ↔ 얼굴 자동 마스킹 점검) 신체 부위/비율/커스텀모델 버튼들은 그룹 안에서 설명이
// 전부 같아서, 대표 id 하나에 작성한 설명을 나머지 id들에도 그대로 재사용한다.
ELEMENT_HELP_MAP['inpaint-face-mode-head'] = ELEMENT_HELP_MAP['inpaint-face-mode-face'];
['inpaint-body-chest', 'inpaint-body-waist', 'inpaint-body-lower', 'inpaint-body-legs'].forEach(id => {
    ELEMENT_HELP_MAP[id] = ELEMENT_HELP_MAP['inpaint-body-neck'];
});
['inpaint-custom-hands', 'inpaint-custom-arms', 'inpaint-custom-feet'].forEach(id => {
    ELEMENT_HELP_MAP[id] = ELEMENT_HELP_MAP['inpaint-custom-pelvis'];
});
['inpaint-zone-lower', 'inpaint-zone-center', 'inpaint-zone-bg', 'inpaint-zone-left', 'inpaint-zone-right'].forEach(id => {
    ELEMENT_HELP_MAP[id] = ELEMENT_HELP_MAP['inpaint-zone-upper'];
});

// 🐛 알트클릭 도움말 점검 중 발견: #nai-director-upscale-scale(실제 배율 드롭다운)이
// #nai-director-upscale-row(그걸 감싼 div)와 형제 관계라, 드롭다운을 직접 alt+클릭하면
// findHelpEntry()가 부모를 타고 올라가도 'nai-director-upscale-row'를 못 찾고 그냥 지나쳤었음.
// 같은 설명을 쓰면 되므로 별도 작성 없이 그대로 재사용.
ELEMENT_HELP_MAP['nai-director-upscale-scale'] = ELEMENT_HELP_MAP['nai-director-upscale-row'];

(function setupAltClickHelp() {
    let popupEl = null;

    function closePopup() {
        if (popupEl) { popupEl.remove(); popupEl = null; }
        document.removeEventListener('mousedown', outsideClickHandler, true);
        document.removeEventListener('keydown', escHandler, true);
    }
    function outsideClickHandler(e) {
        if (popupEl && !popupEl.contains(e.target)) closePopup();
    }
    function escHandler(e) {
        if (e.key === 'Escape') closePopup();
    }

    function findHelpEntry(target) {
        let el = target;
        while (el && el !== document.body) {
            if (el.id && ELEMENT_HELP_MAP[el.id]) return ELEMENT_HELP_MAP[el.id];
            const helpKey = el.dataset && el.dataset.help;
            if (helpKey && ELEMENT_HELP_MAP[helpKey]) return ELEMENT_HELP_MAP[helpKey];
            el = el.parentElement;
        }
        return null;
    }

    function showPopup(entry, x, y) {
        closePopup();
        popupEl = document.createElement('div');
        popupEl.style.cssText = `
            position:fixed; z-index:9999; max-width:420px; background:#1e1e1e; color:#eee;
            border:1px solid #4CAF50; border-radius:8px; padding:14px 16px; box-shadow:0 6px 20px rgba(0,0,0,0.6);
            font-size:0.85em; line-height:1.5;
        `;
        popupEl.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; margin-bottom:6px;">
                <div style="font-weight:bold; color:#4CAF50;">💡 ${entry.name}</div>
                <span style="cursor:pointer; color:#888; font-size:1.1em; line-height:1;" title="닫기">&times;</span>
            </div>
            <div style="color:#ddd; margin-bottom:8px; white-space:pre-wrap;">${entry.desc}</div>
            ${entry.path ? `<div style="color:#e0a030; font-size:0.85em; font-family:Consolas, monospace; margin-bottom:8px; word-break:break-all;">📁 ${entry.path}</div>` : ''}
            <div style="color:#888; font-size:0.9em; font-family:Consolas, monospace; border-top:1px dashed #444; padding-top:6px;">🔧 ${entry.tech}</div>
        `;
        popupEl.querySelector('span').onclick = closePopup;
        document.body.appendChild(popupEl);

        // 화면 밖으로 안 나가게 위치 보정
        const rect = popupEl.getBoundingClientRect();
        let left = x + 12, top = y + 12;
        if (left + rect.width > window.innerWidth - 10) left = window.innerWidth - rect.width - 10;
        if (top + rect.height > window.innerHeight - 10) top = window.innerHeight - rect.height - 10;
        popupEl.style.left = Math.max(10, left) + 'px';
        popupEl.style.top = Math.max(10, top) + 'px';

        setTimeout(() => {
            document.addEventListener('mousedown', outsideClickHandler, true);
            document.addEventListener('keydown', escHandler, true);
        }, 0);
    }

    // capture 단계에서 가로채서, 원래 클릭 동작(값 변경/모달 열림 등)이 실행되기 전에 막는다
    document.addEventListener('click', function(e) {
        if (!e.altKey) return;
        const entry = findHelpEntry(e.target);
        if (!entry) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        showPopup(entry, e.clientX, e.clientY);
    }, true);

    // select 태그는 mousedown 시점에 이미 네이티브 드롭다운을 열어버리는 브라우저가 있어서 같이 막아준다.
    // 🐛 버그 수정: 이걸 select뿐 아니라 모든 매칭 요소에 걸었더니, textarea/input(base-pos, adv-seed 등)에서
    // mousedown의 기본동작을 막으면 브라우저가 뒤이은 click 이벤트 자체를 안 쏴버려서 알트클릭이 먹통이 됐었음.
    // → select에만 적용.
    document.addEventListener('mousedown', function(e) {
        if (!e.altKey) return;
        if (e.target.tagName !== 'SELECT') return;
        if (!ELEMENT_HELP_MAP[e.target.id] && !(e.target.dataset && ELEMENT_HELP_MAP[e.target.dataset.help])) return;
        e.preventDefault();
    }, true);
})();

function renderFeatureHelpModalBody() {

    const modal = document.getElementById('feature-help-modal');
    if (!modal) return;

    const sectionsHtml = FEATURE_HELP_SECTIONS.map(section => {
        const itemsHtml = section.items.map(item => `
            <div style="padding:10px 0; border-bottom:1px solid #333;">
                <div style="font-weight:bold; color:#8bc34a; font-size:0.9em; margin-bottom:3px;">${escapeHtml(item.name)}</div>
                <div style="font-size:0.85em; color:#ddd; line-height:1.5; margin-bottom:4px;">${escapeHtml(item.desc)}</div>
                <div style="font-size:0.75em; color:#888; font-family:monospace;">🔧 ${escapeHtml(item.tech)}</div>
            </div>`).join('');
        return `
            <details style="margin-bottom:10px;" open>
                <summary style="cursor:pointer; font-weight:bold; color:#FF9800; font-size:1em; padding:6px 0;">${escapeHtml(section.title)}</summary>
                <div style="padding-left:6px;">${itemsHtml}</div>
            </details>`;
    }).join('');

    modal.innerHTML = `
        <div class="modal-content" onclick="event.stopPropagation()" style="width:min(92vw, 640px);">
            <div class="modal-header">
                <h3 style="margin:0;">📖 기능 도움말</h3>
                <span class="close-btn" style="position:static; font-size:1.5em; color:#ff5555;"
                      onclick="document.getElementById('feature-help-modal').style.display='none';">&times;</span>
            </div>
            <div class="modal-body" style="max-height:75vh; overflow-y:auto;">
                <p style="font-size:0.78em; color:#666; margin:0 0 10px;">💡 새 기능이 생기면 이 목록도 같이 업데이트됩니다. 각 항목의 🔧은 담당 함수/파일 위치예요 (다음 세션 인수인계용).</p>
                ${sectionsHtml}
            </div>
        </div>`;
}

function openFeatureHelpModal() {
    let modal = document.getElementById('feature-help-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'feature-help-modal';
        modal.className = 'modal-overlay';
        modal.style.cssText = 'display:none;';
        modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
        document.body.appendChild(modal);
    }
    renderFeatureHelpModalBody();
    modal.style.display = 'flex';
}
window.openFeatureHelpModal = openFeatureHelpModal;

/** ⚙️ 설정 버튼(또는 ⌨️ 단축키 버튼) 옆에 "📖 기능 도움말" 버튼을 끼워넣는다. */
function ensureFeatureHelpButton() {
    if (document.getElementById('feature-help-btn')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'feature-help-btn';
    btn.textContent = '📖';
    btn.title = '기능 도움말';
    btn.onclick = openFeatureHelpModal;

    // ⌨️ 단축키 버튼이 이미 있으면 그 옆에, 없으면(로딩 순서 문제 등) ⚙️ 옆에 붙인다.
    const anchor = document.getElementById('shortcut-help-btn')
        || Array.from(document.querySelectorAll('button, [role="button"], .icon-btn'))
            .find(el => (el.textContent || '').includes('⚙'));

    if (anchor && anchor.parentElement) {
        applyNavIconStyle(btn);
        anchor.insertAdjacentElement('afterend', btn);
    } else {
        applyNavIconStyle(btn);
        btn.style.cssText += 'position:fixed; top:8px; right:186px; z-index:9998;';
        document.body.appendChild(btn);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(ensureFeatureHelpButton, 350));
} else {
    setTimeout(ensureFeatureHelpButton, 350);
}

/** 🆕 알트클릭 도움말 모아보기 — ELEMENT_HELP_MAP에 등록된 항목들을 한 화면에서 훑어볼 수 있게
 *  섹션별로 묶어서 보여준다. 매번 Alt+클릭 안 해도 전체를 한 번에 확인/검수할 수 있음.
 *  섹션 구성은 FEATURE_HELP_SECTIONS의 "1. 공통 환경 설정" / "2. 고급 설정"과 대응된다. */
const ALT_HELP_CATALOG_SECTIONS = [
    {
        title: '1. 공통 환경 설정',
        keys: ['gen-preset', 'presetAdd', 'presetRename', 'presetRemove', 'presetMerge', 'presetSetDefault',
               'presetExport', 'presetImport', 'presetCleanup', 'gen-architecture', 'nanobanana-api-key', 'nanobanana-note', 'nai-api-token', 'nai-model', 'nai-resolution', 'nai-sampler', 'nai-noise-schedule', 'nai-steps', 'nai-cfg', 'nai-cfg-rescale', 'nai-seed-random', 'nai-seed', 'nai-sm', 'nai-sm-dyn', 'nai-characters-section', 'nai-add-character', 'nai-char-position-preview', 'nai-precise-ref-section', 'nai-precise-ref-add', 'nai-text-render', 'nai-transparent-bg', 'nai-prompt-randomizer-note', 'nai-img2img-section', 'nai-img2img-dropzone', 'nai-img2img-strength', 'nai-img2img-noise', 'nai-inpaint-section', 'nai-inpaint-paint-btn', 'nai-inpaint-mask-blur', 'nai-vibe-section', 'nai-vibe-add', 'nai-uc-preset', 'nai-quality-toggle', 'nai-convert-weights', 'nai-note', 'gen-checkpoint', 'gen-unet',
               'gen-anima-ckpt', 'anima-use-checkpoint', 'gen-sd3-unet', 'gen-vae', 'gen-clip',
               'loraAddRow', 'loraRandom', 'loraRandomExclude']
    },
    {
        title: '2. 고급 설정',
        keys: ['adv-dimensions', 'adv-sampler', 'adv-scheduler', 'adv-steps', 'adv-cfg', 'adv-seed-random', 'adv-seed']
    },
    {
        title: '3. 베이스 프롬프트 & 색상 카테고리',
        keys: ['base-pos', 'camera-popup-btn', 'camera-canvas', 'camera-preset-select', 'camera-prompt-output', 'camera-link-box', 'camera-recognized', 'camera-auto-apply-box', 'camera-settings-weights', 'camera-settings-prompts', 'base-neg', 'edit-pos-invalidate-value', 'edit-neg-invalidate-value', 'edit-pos-invalidate-chips', 'edit-pos-invalidate-comp-chips', 'edit-neg-invalidate-chips']
    },
    {
        title: '4. 참조 이미지 / 컨트롤넷 / Img2Img / 인페인팅',
        keys: ['toggle-ipadapter', 'toggle-controlnet', 'toggle-img2img', 'toggle-inpaint',
               'inpaint-autoface-btn', 'inpaint-face-mode-face', 'inpaint-body-neck', 'inpaint-custom-pelvis', 'inpaint-zone-upper']
    },
    {
        title: '5. 후처리 옵션',
        keys: ['toggle-upscale', 'toggle-detailer', 'toggle-mosaic']
    },
    {
        title: '6. 프롬프트 라이브러리',
        keys: ['edit-catblock-chips', 'edit-catblock-preview', 'edit-cond-rules-add-btn', 'edit-cond-rules-list', 'edit-seedgroup-value', 'artistStyleTestStart', 'edit-prompt-repeatcount', 'btn-send-set-queue', 'btn-quick-send', 'btn-auto-merge-all']
    },
    {
        title: '7. 대기열 (Job Queue)',
        keys: ['btn-start-batch', 'btn-start-batch-repeat', 'btn-review', 'reviewStart', 'review-batch-upscale-btn', 'batch-upscale-modal', 'node-log-toggle', 'node-log-diag']
    },
    {
        title: '8. 메모장 & 네비게이션 바',
        keys: ['memo-pad-toggle-btn', 'shortcut-help-btn', 'shortcut-bind-mode-btn', 'feature-help-btn', 'alt-help-catalog-btn', 'generation-guide-btn']
    },
    {
        title: '9. 도구 (메타데이터 뷰어 / 단독 검열기 / 퀵 리사이저)',
        keys: ['metadata-dropzone', 'btn-standalone-send-gen',
               'censor-dropzone', 'tool-censor-nipples', 'tool-censor-mode', 'tool-censor-intensity',
               'censorRunPipeline', 'censorDownloadZip', 'censorResetTool',
               'btn-brush-color', 'censor-brush-size', 'censor-brush-eraser', 'censorClearCanvas', 'censorSaveRetouch', 'censor-compare-slider',
               'resizer-dropzone', 'resizer-mode', 'resizer-val-scale', 'resizer-val-longest', 'resizer-val-width', 'resizer-val-height',
               'resizer-format', 'resizer-quality', 'resizerRunBatch', 'resizerDownloadZip', 'resizerResetTool',
               'nai-director-dropzone', 'nai-director-token', 'nai-director-type', 'nai-director-upscale-row', 'nai-director-prompt', 'nai-director-defry', 'nai-director-run',
                'numcheck-group', 'numcheck-table', 'numcheck-bulk', 'numcheck-expected', 'numcheck-badge-toggle',
                'wfrun-drop', 'wfrun-info', 'wfrun-prompts', 'wfrun-seed-random', 'wfrun-count', 'wfrun-run-btn', 'wfrun-results',
                'psearch-input', 'psearch-target', 'psearch-group', 'psearch-filter', 'psearch-table', 'psearch-undo',
                'diag-quick-btn', 'diag-run-btn', 'diag-autorefresh', 'diag-verdict', 'diag-timeline', 'diag-report-btn', 'diag-serverlog-btn']
    },
    {
        title: '10. 갤러리 (출력 이미지 브라우저)',
        keys: ['gallery-folder-list', 'gallery-search-input', 'gallery-grid', 'current-gallery-title',
               'gallery-selection-info', 'lightbox', 'context-menu', 'model-info-modal', 'live-preview-toggle', 'gen-resizer']
    },
    {
        title: '11. ⚙️ 환경 설정',
        keys: ['settings-nsfw-warning', 'settings-default-tag-form']
    },
];

function renderAltHelpCatalogModalBody() {
    const modal = document.getElementById('alt-help-catalog-modal');
    if (!modal) return;

    const registeredKeys = new Set(Object.keys(ELEMENT_HELP_MAP));
    const coveredKeys = new Set();
    ALT_HELP_CATALOG_SECTIONS.forEach(s => s.keys.forEach(k => coveredKeys.add(k)));
    // 혹시 섹션 목록에 넣는 걸 깜빡한 키가 있으면(신규 추가 시 실수 방지용) 맨 아래 "미분류"로 표시
    const uncategorized = [...registeredKeys].filter(k => !coveredKeys.has(k));

    const sectionsHtml = ALT_HELP_CATALOG_SECTIONS.concat(
        uncategorized.length > 0 ? [{ title: '(미분류 — ALT_HELP_CATALOG_SECTIONS에 추가 필요)', keys: uncategorized }] : []
    ).map(section => {
        const itemsHtml = section.keys.map(key => {
            const entry = ELEMENT_HELP_MAP[key];
            if (!entry) return '';
            return `<div style="margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid #333;">
                <div style="font-weight:bold; color:#4CAF50; margin-bottom:4px;">💡 ${escapeHtml(entry.name)} <span style="font-size:0.75em; color:#666; font-weight:normal;">[${escapeHtml(key)}]</span></div>
                <div style="color:#ddd; font-size:0.88em; margin-bottom:5px; white-space:pre-wrap;">${escapeHtml(entry.desc)}</div>
                ${entry.path ? `<div style="color:#e0a030; font-size:0.82em; font-family:Consolas, monospace; margin-bottom:5px; word-break:break-all;">📁 ${escapeHtml(entry.path)}</div>` : ''}
                <div style="color:#888; font-size:0.8em; font-family:Consolas, monospace;">🔧 ${escapeHtml(entry.tech)}</div>
            </div>`;
        }).join('');
        return `
            <details style="margin-bottom:10px;" open>
                <summary style="cursor:pointer; font-weight:bold; color:#FF9800; font-size:1em; padding:6px 0;">${escapeHtml(section.title)}</summary>
                <div style="padding-left:6px;">${itemsHtml}</div>
            </details>`;
    }).join('');

    modal.innerHTML = `
        <div class="modal-content" onclick="event.stopPropagation()" style="width:min(92vw, 640px);">
            <div class="modal-header">
                <h3 style="margin:0;">🖱️ 알트클릭 도움말 모아보기</h3>
                <span class="close-btn" style="position:static; font-size:1.5em; color:#ff5555;"
                      onclick="document.getElementById('alt-help-catalog-modal').style.display='none';">&times;</span>
            </div>
            <div class="modal-body" style="max-height:75vh; overflow-y:auto;">
                <p style="font-size:0.78em; color:#666; margin:0 0 10px;">💡 Alt(옵션)+클릭으로 각 항목에서 개별로 볼 수 있는 도움말을 한 화면에 모아놓은 목록입니다. 지금은 1·2번 섹션만 등록되어 있음.</p>
                ${sectionsHtml}
            </div>
        </div>`;
}

function openAltHelpCatalogModal() {
    let modal = document.getElementById('alt-help-catalog-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'alt-help-catalog-modal';
        modal.className = 'modal-overlay';
        modal.style.cssText = 'display:none;';
        modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
        document.body.appendChild(modal);
    }
    renderAltHelpCatalogModalBody();
    modal.style.display = 'flex';
}
window.openAltHelpCatalogModal = openAltHelpCatalogModal;

/** 📖 기능 도움말 버튼 옆에 "🖱️ 알트클릭 도움말 모아보기" 버튼을 끼워넣는다. */
function ensureAltHelpCatalogButton() {
    if (document.getElementById('alt-help-catalog-btn')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'alt-help-catalog-btn';
    btn.textContent = '🖱️';
    btn.title = '알트클릭 도움말 모아보기';
    btn.onclick = openAltHelpCatalogModal;

    const anchor = document.getElementById('feature-help-btn')
        || document.getElementById('shortcut-help-btn')
        || Array.from(document.querySelectorAll('button, [role="button"], .icon-btn'))
            .find(el => (el.textContent || '').includes('⚙'));

    if (anchor && anchor.parentElement) {
        applyNavIconStyle(btn);
        anchor.insertAdjacentElement('afterend', btn);
    } else {
        applyNavIconStyle(btn);
        btn.style.cssText += 'position:fixed; top:8px; right:150px; z-index:9998;';
        document.body.appendChild(btn);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(ensureAltHelpCatalogButton, 400));
} else {
    setTimeout(ensureAltHelpCatalogButton, 400);
}

/** 🆕 처음 쓰는 사람용 "생성 가이드" — 아키텍처 선택부터 이미지 한 장 뽑을 때까지 순서대로 안내.
 *  인페인팅/Img2Img/컨트롤넷/IP-Adapter 같은 부가기능은 일부러 뺌(나중에 익숙해지면 배우면 되는 것들).
 *  각 단계의 "이동" 버튼은 기존 jumpToSection()을 그대로 재사용해서 실제 화면 위치로 스크롤해줌. */
const GENERATION_GUIDE_STEPS = [
    {
        title: '1. 아키텍처 고르기',
        desc: '맨 위 "아키텍처" 드롭다운에서 어떤 종류의 모델을 쓸지 고릅니다. 뭘 골라야 할지 모르겠으면 일단 SDXL로 시작하는 게 가장 무난합니다. 각 아키텍처별 차이는 바로 아래 항목을 참고하세요.',
        jumpKeyword: '공통 환경 설정'
    },
    {
        title: '📌 아키텍처별 차이 & 주의사항',
        desc: '• SDXL — 가장 무난하고 자료/로라가 제일 많습니다. 처음이면 이걸로 시작하세요. ' +
              '• SD1.5 — 예전 구형 모델입니다. 가볍고 빠르지만 요즘 기준으론 디테일이 떨어집니다. 옛날에 받아둔 SD1.5 전용 로라를 쓸 때만 골라도 됩니다. ' +
              '• Anima(qwen_image 계열) — 체크포인트 한 방으로 끝나지 않고 UNet/CLIP/VAE를 따로따로 골라야 합니다. 구조가 달라서 처음엔 헷갈리기 쉬우니 여유 있을 때 시도해보세요. ' +
              '• SD3/SD3.5 — 비교적 최신이라 지원 로라/자료가 SDXL보다 적을 수 있습니다. 이것도 UNet을 따로 불러오는 구조라 SDXL과 화면 구성이 다릅니다. ' +
              '• 🍌 나노바나나 / 🎨 NAI — 로컬 모델이 아니라 외부 서비스(Google / NovelAI) 서버로 그리는 방식이라 API 키(토큰)가 필요하고, 체크포인트·로라 개념이 없습니다. 사용량에 따라 비용(나노바나나는 결제 연결, NAI는 Anlas)이 듭니다. NAI는 고급설정과 부정 프롬프트가 적용되지만 나노바나나는 프롬프트만 적용됩니다. ' +
              '⚠️ 공통 주의: 아키텍처를 바꾸면 체크포인트/VAE/CLIP 목록이 통째로 바뀌니, 중간에 바꿨다면 그 밑에 있는 값들도 맞게 바뀌었는지 한 번씩 확인하세요.',
        jumpKeyword: '공통 환경 설정'
    },
    {
        title: '📌 처음이면 알아두면 좋은 AI 그림 상식',
        desc: '• 시드(seed) — 그림의 "무작위 씨앗값". 같은 프롬프트+같은 시드+같은 설정이면 거의 같은 그림이 나오고, 시드를 바꾸면 완전히 다른 그림이 나옵니다. ' +
              '• CFG — 프롬프트를 얼마나 고지식하게 따를지의 강도. 너무 높이면 오히려 그림이 과채도로 깨지거나 이상해질 수 있습니다. ' +
              '• 스텝(Steps) — 무조건 높다고 좋은 게 아니라 어느 지점부터는 별 차이 없이 시간만 늘어납니다. ' +
              '• 가중치 문법 — 프롬프트에서 (단어:1.2)처럼 괄호+숫자를 쓰면 그 단어의 비중을 더 세게(1보다 크면) 또는 약하게(1보다 작으면) 줄 수 있습니다. ' +
              '• 프롬프트는 보통 앞쪽에 적힌 단어일수록 더 강하게 반영되는 경향이 있습니다(모델마다 조금씩 다를 수 있음). ' +
              '• 로라는 많이 겹쳐 쓸수록 결과가 예측하기 어려워지고 그림이 망가지기 쉬우니, 처음엔 1~2개로 시작하는 걸 추천합니다. ' +
              '• 한 번에 완벽한 그림이 나오는 경우는 드뭅니다 — 여러 장 뽑아서 그중 마음에 드는 걸 고르는 방식(가챠 느낌)에 가깝습니다. ' +
              '• 손가락, 눈동자 방향, 글자 같은 세밀한 부분은 AI가 특히 잘 틀리는 부분이라 처음부터 완벽하길 기대하지 않는 게 좋습니다.',
        jumpKeyword: null
    },
    {
        title: '2. 체크포인트(모델 파일) 고르기',
        desc: '아키텍처를 고르면 바로 밑에 "체크포인트" 드롭다운이 나타납니다. 여기서 실제로 그림을 그릴 모델 파일을 고릅니다. 모델마다 그림체가 완전히 다르니, 이것저것 골라보면서 마음에 드는 걸 찾아보세요.',
        jumpKeyword: '공통 환경 설정'
    },
    {
        title: '3. (선택) 로라 추가',
        desc: '로라는 체크포인트에 살짝 더하는 양념 같은 것으로, 특정 캐릭터나 그림체를 더 잘 뽑고 싶을 때 추가합니다. 처음이면 이 단계는 건너뛰어도 전혀 문제없습니다.',
        jumpKeyword: '공통 환경 설정'
    },
    {
        title: '4. 프롬프트(어떤 그림을 그릴지) 정하기',
        desc: '방법은 두 가지입니다. ① 아래쪽 "공통 긍정/부정 프롬프트" 칸에 원하는 내용을 직접 글로 적기. ② 왼쪽 아래 "프롬프트 라이브러리" 탭에서 미리 만들어둔 조각(캐릭터, 포즈 등)을 골라서 쓰기. 처음이면 라이브러리에 예시가 있는지부터 살펴보세요.',
        jumpKeyword: '베이스 프롬프트'
    },
    {
        title: '5. 고급 설정은 일단 기본값 그대로',
        desc: '해상도/샘플러/스텝/CFG/시드 같은 값들인데, 처음엔 안 건드리고 기본값 그대로 써도 충분히 괜찮은 그림이 나옵니다. 익숙해진 다음에 하나씩 바꿔보면서 차이를 느껴보세요.',
        jumpKeyword: '고급 설정'
    },
    {
        title: '6. 대기열에 넣기',
        desc: '프롬프트 라이브러리에서 조각을 골랐다면 "대기열로 보내기" 같은 버튼으로 대기열에 쌓습니다. 직접 글로만 적었다면 이 단계 없이 바로 다음(생성 시작)으로 가도 됩니다.',
        jumpKeyword: '프롬프트 라이브러리'
    },
    {
        title: '7. 생성 시작!',
        desc: '대기열 화면에서 "🚀 큐 전체 순차 생성 시작" 버튼을 누르면 순서대로 실제 그림이 그려지기 시작합니다. 대기열에 아무것도 안 넣었으면 이 버튼을 눌러도 아무 일도 안 일어납니다 — 그럴 땐 4~6단계부터 다시 확인해보세요.',
        jumpKeyword: '대기열'
    },
    {
        title: '8. 결과 확인하고 저장하기',
        desc: '그림이 다 그려지면 "🖼 이미지 검수" 버튼으로 한 장씩(반복생성이면 여러 장을 그리드로) 보면서 마음에 들면 👍(자동 저장), 별로면 👎(대기열에 남아서 나중에 다시 시도 가능)를 누르면 됩니다.',
        jumpKeyword: '대기열'
    },
    {
        title: '📌 참고 — 나중에 배워도 되는 것들',
        desc: '참조이미지(IP-Adapter)/컨트롤넷/Img2Img(이미지로 다시 그리기)/인페인팅(부분만 다시 그리기) 같은 기능들은 전부 "기본 생성"이 익숙해진 다음에 하나씩 켜봐도 늦지 않습니다. 지금 당장 몰라도 그림 뽑는 데는 전혀 지장 없습니다.',
        jumpKeyword: null
    },
];

function renderGenerationGuideModalBody() {
    const modal = document.getElementById('generation-guide-modal');
    if (!modal) return;

    const stepsHtml = GENERATION_GUIDE_STEPS.map(step => `
        <div style="display:flex; gap:12px; align-items:flex-start; margin-bottom:16px; padding-bottom:14px; border-bottom:1px solid #333;">
            <div style="flex:1;">
                <div style="font-weight:bold; color:#4CAF50; margin-bottom:4px;">${escapeHtml(step.title)}</div>
                <div style="color:#ddd; font-size:0.9em; line-height:1.5;">${escapeHtml(step.desc)}</div>
            </div>
            ${step.jumpKeyword ? `<button class="btn-secondary" style="white-space:nowrap; flex-shrink:0;"
                onclick="document.getElementById('generation-guide-modal').style.display='none'; jumpToSection('${step.jumpKeyword}');">📍 이동</button>` : ''}
        </div>`).join('');

    modal.innerHTML = `
        <div class="modal-content" onclick="event.stopPropagation()" style="width:min(92vw, 640px);">
            <div class="modal-header">
                <h3 style="margin:0;">🔰 생성 가이드 (처음이신가요?)</h3>
                <span class="close-btn" style="position:static; font-size:1.5em; color:#ff5555;"
                      onclick="document.getElementById('generation-guide-modal').style.display='none';">&times;</span>
            </div>
            <div class="modal-body" style="max-height:75vh; overflow-y:auto;">
                <p style="font-size:0.8em; color:#666; margin:0 0 14px;">💡 아키텍처 선택부터 이미지 한 장을 뽑기까지의 순서입니다. 각 단계 옆 "📍 이동" 버튼을 누르면 그 화면으로 바로 이동합니다. 더 자세한 설명은 각 항목을 Alt+클릭 하거나, 📖 기능 도움말을 참고하세요.</p>
                ${stepsHtml}
            </div>
        </div>`;
}

function openGenerationGuideModal() {
    let modal = document.getElementById('generation-guide-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'generation-guide-modal';
        modal.className = 'modal-overlay';
        modal.style.cssText = 'display:none;';
        modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
        document.body.appendChild(modal);
    }
    renderGenerationGuideModalBody();
    modal.style.display = 'flex';
}
window.openGenerationGuideModal = openGenerationGuideModal;

/** 다른 도움말 버튼들 옆에 "🔰 생성 가이드" 버튼을 끼워넣는다. */
function ensureGenerationGuideButton() {
    if (document.getElementById('generation-guide-btn')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'generation-guide-btn';
    btn.textContent = '🔰';
    btn.title = '처음이신가요? (생성 가이드)';
    btn.onclick = openGenerationGuideModal;

    const anchor = document.getElementById('alt-help-catalog-btn')
        || document.getElementById('feature-help-btn')
        || document.getElementById('shortcut-help-btn');

    if (anchor && anchor.parentElement) {
        applyNavIconStyle(btn);
        anchor.insertAdjacentElement('afterend', btn);
    } else {
        applyNavIconStyle(btn);
        btn.style.cssText += 'position:fixed; top:8px; right:114px; z-index:9998;';
        document.body.appendChild(btn);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(ensureGenerationGuideButton, 450));
} else {
    setTimeout(ensureGenerationGuideButton, 450);
}

/* ──────────────────────────────────────────────
   📝 메모장 팝업 — 다른 모달들과 달리 화면을 어둡게 가리는 오버레이가 없고,
   패널 자체도 자기 영역 밖은 전혀 가리지 않기 때문에, 열어놓은 채로 화면의
   다른 곳(입력창, 버튼, 대기열 등)을 자유롭게 계속 조작할 수 있다.
   - 창은 하나, 그 안에서 브라우저 탭처럼 여러 메모를 전환해서 씀 (탭 옆 "+"로 새 탭 추가)
   - 입력 즉시 localStorage에 자동 저장 → 새로고침/브라우저 재시작해도 내용 유지
   - 제목 표시줄을 드래그하면 원하는 위치로 옮길 수 있고, 위치도 저장됨
   - 오른쪽 아래 모서리를 드래그하면 크기 조절 가능, 크기도 저장됨
   - ✕로 닫아도 내용은 사라지지 않고, 다시 열면 마지막 상태(탭 구성 포함) 그대로 이어서 사용 가능
   ────────────────────────────────────────────── */
const MEMO_PAD_TABS_KEY = 'freeMemoPadTabs';
const MEMO_PAD_ACTIVE_TAB_KEY = 'freeMemoPadActiveTab';
const MEMO_PAD_GEOMETRY_KEY = 'freeMemoPadGeometry';
const MEMO_PAD_MINIMIZED_KEY = 'freeMemoPadMinimized';
// 예전 버전들의 데이터(마이그레이션용) — 사용자가 이미 써놨던 메모를 잃어버리지 않기 위해 유지
const LEGACY_MEMO_PAD_CONTENT_KEY = 'freeMemoPadContent';
const LEGACY_MEMO_PAD_IDS_KEY = 'freeMemoPadIds';
const legacyMemoContentKey = (id) => `freeMemoPadContent_${id}`;

/* ──────────────────────────────────────────────
   🔗 외부 메모장(윈도우 메모장 등)과의 동기화 — 탭 하나당 실제 .txt 파일 하나(백엔드 memos 폴더).
   - 저장: 타이핑 멈추고 잠시 후 서버에 POST해서 실제 파일에 씀 (디바운스)
   - 반영: 몇 초 간격으로 서버 GET해서, 외부에서 파일이 바뀌었으면 가져와 채워넣음 (폴링)
   - 충돌 방지: 지금 그 탭을 편집 중(포커스)이면 외부 변경을 덮어쓰지 않고 다음 폴링까지 미룸
   - 백엔드 라우트가 아직 없거나 서버가 오프라인이어도 조용히 실패하고 넘어감 → 로컬(localStorage)
     저장/복원은 이 기능과 무관하게 항상 정상 동작한다.
   ────────────────────────────────────────────── */
const MEMO_SYNC_SAVE_DEBOUNCE_MS = 800;
const MEMO_SYNC_POLL_INTERVAL_MS = 3000;
const memoSyncMtimeKey = (tabId) => `freeMemoPadSyncMtime_${tabId}`;

async function memoSyncSaveToServer(tabId, content) {
    try {
        const res = await fetch('/assetmanager/api/memo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tabId, content }),
        });
        const data = await res.json();
        if (data && data.ok && data.mtime) {
            try { localStorage.setItem(memoSyncMtimeKey(tabId), String(data.mtime)); } catch (e) { /* ignore */ }
        }
    } catch (e) { /* 백엔드 라우트가 없거나 서버 오프라인 — 조용히 무시, 로컬 저장은 계속 정상 */ }
}

async function memoSyncDeleteFromServer(tabId) {
    try {
        await fetch('/assetmanager/api/memo/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tabId }),
        });
    } catch (e) { /* ignore */ }
    try { localStorage.removeItem(memoSyncMtimeKey(tabId)); } catch (e) { /* ignore */ }
}

/** 탭 목록을 가져온다. 예전 버전(여러 개의 별도 창, 또는 그 이전의 단일 메모장) 데이터가
 *  남아있으면 한 번만 자동으로 탭들로 옮겨준다. */
function getMemoPadTabs() {
    let tabs = null;
    try { tabs = JSON.parse(localStorage.getItem(MEMO_PAD_TABS_KEY)); } catch (e) { tabs = null; }
    if (Array.isArray(tabs) && tabs.length > 0) return tabs;

    tabs = [];
    // 1) 바로 이전 버전: 메모장을 여러 개의 별도 창으로 띄우던 방식 → 각 창을 탭 하나씩으로 이어받음
    try {
        const prevIds = JSON.parse(localStorage.getItem(LEGACY_MEMO_PAD_IDS_KEY));
        if (Array.isArray(prevIds) && prevIds.length > 0) {
            prevIds.forEach((id) => {
                const content = localStorage.getItem(legacyMemoContentKey(id));
                tabs.push({ id: 'tab_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), content: content || '' });
            });
        }
    } catch (e) { /* ignore */ }
    // 2) 그보다 더 예전: 메모장이 하나뿐이던 방식
    if (tabs.length === 0) {
        try {
            const legacy = localStorage.getItem(LEGACY_MEMO_PAD_CONTENT_KEY);
            if (legacy !== null) tabs.push({ id: 'tab_default', content: legacy });
        } catch (e) { /* ignore */ }
    }
    if (tabs.length === 0) tabs.push({ id: 'tab_' + Date.now(), content: '' });
    saveMemoPadTabs(tabs);
    return tabs;
}

function saveMemoPadTabs(tabs) {
    try { localStorage.setItem(MEMO_PAD_TABS_KEY, JSON.stringify(tabs)); } catch (e) { /* ignore */ }
}

function getActiveMemoTabId(tabs) {
    let id = null;
    try { id = localStorage.getItem(MEMO_PAD_ACTIVE_TAB_KEY); } catch (e) { id = null; }
    if (id && tabs.some(t => t.id === id)) return id;
    return tabs[0].id;
}

function saveActiveMemoTabId(id) {
    try { localStorage.setItem(MEMO_PAD_ACTIVE_TAB_KEY, id); } catch (e) { /* ignore */ }
}

function ensureMemoPad() {
    if (document.getElementById('memo-pad-panel')) return;

    let savedGeometry = {};
    try { savedGeometry = JSON.parse(localStorage.getItem(MEMO_PAD_GEOMETRY_KEY)) || {}; } catch (e) { savedGeometry = {}; }

    let tabs = getMemoPadTabs();
    let activeTabId = getActiveMemoTabId(tabs);

    const panel = document.createElement('div');
    panel.id = 'memo-pad-panel';
    // 🔑 배경 딤 없음: 오버레이 요소를 아예 만들지 않고, 이 패널만 화면 위에 떠 있게 함.
    // 패널 밖 영역은 pointer-events가 전혀 가로채이지 않아서 뒤쪽 UI를 그대로 조작 가능.
    panel.style.cssText = [
        'display:none',
        'position:fixed',
        `top:${savedGeometry.top || '70px'}`,
        savedGeometry.left ? `left:${savedGeometry.left}` : 'right:16px',
        `width:${savedGeometry.width || '300px'}`,
        `height:${savedGeometry.height || '260px'}`,
        'min-width:220px',
        'min-height:150px',
        'max-width:90vw',
        'max-height:90vh',
        'z-index:9996', // 다른 모달(오버레이)보다는 낮게, 일반 UI보다는 위에
        'flex-direction:column',
        'background:#1e1e1e',
        'border:1px solid #555',
        'border-radius:8px',
        'box-shadow:0 4px 20px rgba(0,0,0,0.6)',
        'overflow:hidden',
        'resize:both',
    ].join(';');

    const header = document.createElement('div');
    header.id = 'memo-pad-header';
    header.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:6px 8px 6px 12px; background:#2a2a2a; border-bottom:1px solid #444; cursor:move; user-select:none; flex-shrink:0;';

    const titleWrap = document.createElement('span');
    titleWrap.style.cssText = 'display:flex; align-items:center; gap:5px;';

    // 📝 아이콘 — 클릭하면 최소화(아이콘만 남기고 접힘) ↔ 복원 토글
    const iconBtn = document.createElement('span');
    iconBtn.id = 'memo-pad-icon-btn';
    iconBtn.textContent = '📝';
    iconBtn.title = '최소화 / 펼치기';
    iconBtn.style.cssText = 'cursor:pointer; font-size:1.05em; line-height:1;';
    iconBtn.onmousedown = (e) => { e.stopPropagation(); }; // 드래그 시작 대신 클릭 토글만 되도록
    iconBtn.onclick = (e) => { e.stopPropagation(); toggleMemoPadMinimize(); };
    titleWrap.appendChild(iconBtn);

    const label = document.createElement('span');
    label.id = 'memo-pad-title-label';
    label.textContent = '메모장';
    label.style.cssText = 'font-size:0.85em; color:#ddd; font-weight:bold;';
    titleWrap.appendChild(label);

    header.appendChild(titleWrap);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.id = 'memo-pad-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.title = '닫기 (내용은 그대로 유지됩니다)';
    closeBtn.style.cssText = 'background:none; border:none; color:#aaa; cursor:pointer; font-size:1em; line-height:1; padding:2px 6px;';
    closeBtn.onmouseenter = () => { closeBtn.style.color = '#fff'; };
    closeBtn.onmouseleave = () => { closeBtn.style.color = '#aaa'; };
    closeBtn.onclick = () => { panel.style.display = 'none'; };
    header.appendChild(closeBtn);

    // 🗂 탭 바 — 브라우저 탭처럼 메모를 여러 개 전환해서 쓸 수 있게. 맨 끝의 "+"로 새 탭 추가.
    const tabBar = document.createElement('div');
    tabBar.id = 'memo-pad-tabbar';
    tabBar.style.cssText = 'display:flex; align-items:center; gap:2px; padding:4px 6px 0; background:#232323; border-bottom:1px solid #444; overflow-x:auto; flex-shrink:0; scrollbar-width:thin;';

    const textarea = document.createElement('textarea');
    textarea.id = 'memo-pad-textarea';
    textarea.placeholder = '여기에 자유롭게 메모하세요… (자동 저장됩니다)';
    textarea.spellcheck = false;
    textarea.style.cssText = 'flex:1; width:100%; box-sizing:border-box; resize:none; border:none; outline:none; background:#1e1e1e; color:#eee; padding:10px; font-size:0.88em; line-height:1.5; font-family:inherit;';
    // 메모장 안에서 다른 단축키(한↔영 변환, 가중치 등)가 오작동하지 않도록,
    // 다른 전역 keydown 리스너로 전파되지 않게 막는다(메모장은 순수 자유 메모용).
    textarea.addEventListener('keydown', (e) => { e.stopPropagation(); });

    // 🔗 외부 .txt 파일로의 저장은 타이핑마다 하지 않고, 멈춘 뒤 잠깐 기다렸다가 한 번만 보낸다(디바운스).
    let saveDebounceTimer = null;
    function flushPendingMemoSave() {
        if (!saveDebounceTimer) return;
        clearTimeout(saveDebounceTimer);
        saveDebounceTimer = null;
        const tab = tabs.find(t => t.id === activeTabId);
        if (tab) memoSyncSaveToServer(tab.id, tab.content);
    }
    textarea.addEventListener('input', () => {
        const tab = tabs.find(t => t.id === activeTabId);
        if (tab) tab.content = textarea.value;
        saveMemoPadTabs(tabs);

        clearTimeout(saveDebounceTimer);
        const tabIdAtEdit = activeTabId;
        const contentAtEdit = textarea.value;
        saveDebounceTimer = setTimeout(() => {
            saveDebounceTimer = null;
            memoSyncSaveToServer(tabIdAtEdit, contentAtEdit);
        }, MEMO_SYNC_SAVE_DEBOUNCE_MS);
    });
    // 창을 닫거나(✕) 최소화할 때, 대기 중이던 저장이 있으면 미루지 않고 바로 반영
    closeBtn.addEventListener('click', flushPendingMemoSave);

    function tabLabel(tab, index) {
        const firstLine = (tab.content || '').split('\n')[0].trim();
        return firstLine ? (firstLine.length > 8 ? firstLine.slice(0, 8) + '…' : firstLine) : `메모 ${index + 1}`;
    }

    function renderTabBar() {
        tabBar.innerHTML = '';
        tabs.forEach((tab, index) => {
            const tabBtn = document.createElement('div');
            const isActive = tab.id === activeTabId;
            tabBtn.style.cssText = `display:flex; align-items:center; gap:4px; padding:4px 8px; font-size:0.78em; border-radius:5px 5px 0 0; cursor:pointer; white-space:nowrap; max-width:110px; ${isActive ? 'background:#1e1e1e; color:#fff; border:1px solid #444; border-bottom:1px solid #1e1e1e; margin-bottom:-1px;' : 'background:#2a2a2a; color:#999; border:1px solid transparent;'}`;

            const tabText = document.createElement('span');
            tabText.textContent = tabLabel(tab, index);
            tabText.style.cssText = 'overflow:hidden; text-overflow:ellipsis;';
            tabBtn.appendChild(tabText);

            if (tabs.length > 1) {
                const tabCloseBtn = document.createElement('span');
                tabCloseBtn.textContent = '×';
                tabCloseBtn.title = '이 탭 삭제 (연동된 외부 파일도 함께 삭제됩니다)';
                tabCloseBtn.style.cssText = 'color:#888; font-size:0.95em; line-height:1;';
                tabCloseBtn.onmouseenter = () => { tabCloseBtn.style.color = '#ff6b6b'; };
                tabCloseBtn.onmouseleave = () => { tabCloseBtn.style.color = '#888'; };
                tabCloseBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (tab.content && tab.content.trim() && !confirm('이 메모 탭을 삭제할까요? 내용도 함께 지워집니다 (연동된 외부 파일도 삭제됨).')) return;
                    if (activeTabId === tab.id) flushPendingMemoSave(); // 지우기 직전 탭이면 대기 중이던 저장부터 정리
                    const idx = tabs.findIndex(t => t.id === tab.id);
                    tabs.splice(idx, 1);
                    saveMemoPadTabs(tabs);
                    memoSyncDeleteFromServer(tab.id); // 연동된 외부 .txt 파일도 함께 삭제
                    if (activeTabId === tab.id) {
                        activeTabId = tabs[Math.max(0, idx - 1)].id;
                        saveActiveMemoTabId(activeTabId);
                        textarea.value = tabs.find(t => t.id === activeTabId).content || '';
                    }
                    renderTabBar();
                };
                tabBtn.appendChild(tabCloseBtn);
            }

            tabBtn.onmousedown = (e) => { e.stopPropagation(); }; // 탭 클릭이 창 드래그로 오해되지 않도록
            tabBtn.onclick = () => {
                if (activeTabId === tab.id) return;
                flushPendingMemoSave(); // 다른 탭으로 넘어가기 전, 방금 치던 내용을 바로 파일에 반영
                activeTabId = tab.id;
                saveActiveMemoTabId(activeTabId);
                textarea.value = tab.content || '';
                textarea.focus();
                renderTabBar();
            };
            tabBar.appendChild(tabBtn);
        });

        // "+" 새 탭 추가 버튼
        const addTabBtn = document.createElement('span');
        addTabBtn.textContent = '+';
        addTabBtn.title = '새 메모 탭 추가';
        addTabBtn.style.cssText = 'padding:4px 9px; font-size:0.9em; font-weight:bold; color:#8bc34a; cursor:pointer; line-height:1;';
        addTabBtn.onmousedown = (e) => { e.stopPropagation(); };
        addTabBtn.onmouseenter = () => { addTabBtn.style.color = '#aed581'; };
        addTabBtn.onmouseleave = () => { addTabBtn.style.color = '#8bc34a'; };
        addTabBtn.onclick = () => {
            flushPendingMemoSave();
            const newTab = { id: 'tab_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), content: '' };
            tabs.push(newTab);
            activeTabId = newTab.id;
            saveMemoPadTabs(tabs);
            saveActiveMemoTabId(activeTabId);
            memoSyncSaveToServer(newTab.id, ''); // 외부에서 바로 찾아 열 수 있도록 빈 파일을 즉시 만들어둠
            textarea.value = '';
            renderTabBar();
            textarea.focus();
        };
        tabBar.appendChild(addTabBtn);
    }
    renderTabBar();
    textarea.value = (tabs.find(t => t.id === activeTabId) || tabs[0]).content || '';

    // 🔁 외부 파일 변경 폴링: 몇 초마다 서버에 물어봐서, 지금 편집 중이 아닌 탭에 외부 변경이
    // 있으면 반영한다. (지금 포커스 중인 탭은 타이핑 내용이 날아가지 않도록 건드리지 않음)
    async function pollMemoSync() {
        let data;
        try {
            // 🐛 수정: 브라우저가 이 GET 요청을 캐싱해서 매번 똑같은(예전) 응답을 돌려주는 바람에
            // 외부에서 파일을 수정해도 영원히 반영이 안 되던 버그. cache:'no-store' + 매번 다른
            // 캐시버스팅 쿼리(_t)를 붙여서 항상 서버에 새로 물어보도록 강제한다.
            const res = await fetch('/assetmanager/api/memo/all?_t=' + Date.now(), { cache: 'no-store' });
            data = await res.json();
        } catch (e) { return; } // 라우트가 아직 없거나 서버 오프라인 — 조용히 스킵

        if (!data || !data.ok || !data.memos) return;
        let changed = false;

        tabs.forEach((tab) => {
            const remote = data.memos[tab.id];
            if (!remote) return; // 서버에 아직 이 탭 파일이 없음(한 번도 저장 안 됨) — 다음 저장 때 자동 생성됨

            let knownMtime = 0;
            try { knownMtime = parseFloat(localStorage.getItem(memoSyncMtimeKey(tab.id))) || 0; } catch (e) { /* ignore */ }
            if (remote.mtime <= knownMtime) return; // 우리가 이미 저장해서 알고 있는 시점 — 새 외부 변경 아님
            if (remote.content === tab.content) {
                try { localStorage.setItem(memoSyncMtimeKey(tab.id), String(remote.mtime)); } catch (e) { /* ignore */ }
                return;
            }

            const isEditingThisTabNow = document.activeElement === textarea && activeTabId === tab.id;
            if (isEditingThisTabNow) return; // 지금 편집 중이면 덮어쓰지 않고 다음 폴링까지 미룸

            tab.content = remote.content;
            try { localStorage.setItem(memoSyncMtimeKey(tab.id), String(remote.mtime)); } catch (e) { /* ignore */ }
            if (activeTabId === tab.id) textarea.value = remote.content; // 지금 보고 있는 탭이면 화면도 갱신
            changed = true;
        });

        if (changed) {
            saveMemoPadTabs(tabs);
            renderTabBar();
        }
    }
    pollMemoSync(); // 컴피가 꺼져있던 동안 외부에서 수정된 내용이 있으면 열자마자 한 번 반영
    setInterval(pollMemoSync, MEMO_SYNC_POLL_INTERVAL_MS);

    panel.appendChild(header);
    panel.appendChild(tabBar);
    panel.appendChild(textarea);
    document.body.appendChild(panel);

    // 최소화 상태: 탭 바, 텍스트 영역, 닫기 버튼, 제목 글자를 숨기고 📝 아이콘만 보이는
    // 작은 정사각형으로 접는다. 위치(드래그)는 최소화 상태에서도 그대로 옮길 수 있다.
    panel.dataset.minimized = 'false';
    let expandedGeometry = null; // 최소화 직전 크기를 기억해뒀다가 복원 시 사용

    function applyMinimizedLayout() {
        expandedGeometry = { width: panel.style.width, height: panel.style.height };
        panel.style.width = '44px';
        panel.style.height = '44px';
        panel.style.minWidth = '44px';
        panel.style.minHeight = '44px';
        panel.style.resize = 'none';
        header.style.justifyContent = 'center';
        header.style.padding = '0';
        header.style.border = 'none';
        header.style.height = '100%';
        label.style.display = 'none';
        closeBtn.style.display = 'none';
        tabBar.style.display = 'none';
        textarea.style.display = 'none';
        panel.style.borderRadius = '50%';
    }

    function applyExpandedLayout() {
        panel.style.width = (expandedGeometry && expandedGeometry.width) || savedGeometry.width || '300px';
        panel.style.height = (expandedGeometry && expandedGeometry.height) || savedGeometry.height || '260px';
        panel.style.minWidth = '220px';
        panel.style.minHeight = '150px';
        panel.style.resize = 'both';
        header.style.justifyContent = 'space-between';
        header.style.padding = '6px 8px 6px 12px';
        header.style.borderBottom = '1px solid #444';
        header.style.height = '';
        label.style.display = '';
        closeBtn.style.display = '';
        tabBar.style.display = '';
        textarea.style.display = '';
        panel.style.borderRadius = '8px';
    }

    function toggleMemoPadMinimize() {
        const isMinimized = panel.dataset.minimized === 'true';
        if (isMinimized) {
            applyExpandedLayout();
            panel.dataset.minimized = 'false';
        } else {
            flushPendingMemoSave();
            applyMinimizedLayout();
            panel.dataset.minimized = 'true';
            textarea.blur();
        }
        saveGeometry();
    }
    panel._toggleMinimize = toggleMemoPadMinimize;

    function saveGeometry() {
        const rect = panel.getBoundingClientRect();
        const isMinimized = panel.dataset.minimized === 'true';
        try {
            localStorage.setItem(MEMO_PAD_GEOMETRY_KEY, JSON.stringify({
                top: rect.top + 'px',
                left: rect.left + 'px',
                // 최소화된 상태(44px 아이콘 크기)는 저장하지 않고, 펼쳐진 상태의 크기만 기억한다.
                width: isMinimized ? ((expandedGeometry && expandedGeometry.width) || savedGeometry.width || '300px') : (rect.width + 'px'),
                height: isMinimized ? ((expandedGeometry && expandedGeometry.height) || savedGeometry.height || '260px') : (rect.height + 'px'),
            }));
            localStorage.setItem(MEMO_PAD_MINIMIZED_KEY, isMinimized ? 'true' : 'false');
        } catch (e) { /* ignore */ }
    }

    // 제목 표시줄 드래그로 위치 이동
    let drag = null;
    header.addEventListener('mousedown', (e) => {
        if (e.target === closeBtn) return;
        const rect = panel.getBoundingClientRect();
        drag = { startX: e.clientX, startY: e.clientY, startLeft: rect.left, startTop: rect.top };
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!drag) return;
        const nextLeft = Math.max(0, drag.startLeft + (e.clientX - drag.startX));
        const nextTop = Math.max(0, drag.startTop + (e.clientY - drag.startY));
        panel.style.left = nextLeft + 'px';
        panel.style.right = 'auto';
        panel.style.top = nextTop + 'px';
    });
    document.addEventListener('mouseup', () => {
        if (!drag) return;
        drag = null;
        saveGeometry();
    });

    // resize:both로 크기를 조절한 뒤(마우스를 뗀 시점)에 크기 저장
    panel.addEventListener('mouseup', () => saveGeometry());
    if (typeof ResizeObserver !== 'undefined') {
        let resizeSaveTimer = null;
        new ResizeObserver(() => {
            // 최소화된 동안(고정 44px)에는 리사이즈 저장을 건너뛴다 — applyMinimizedLayout이
            // 크기를 강제로 바꾸는 것도 감지돼서 불필요하게 저장이 도는 것을 방지.
            if (panel.dataset.minimized === 'true') return;
            clearTimeout(resizeSaveTimer);
            resizeSaveTimer = setTimeout(saveGeometry, 200);
        }).observe(panel);
    }

    // 이전에 최소화된 채로 닫았다면, 다시 열었을 때도 최소화 상태로 시작
    let startMinimized = false;
    try { startMinimized = localStorage.getItem(MEMO_PAD_MINIMIZED_KEY) === 'true'; } catch (e) { /* ignore */ }
    if (startMinimized) {
        applyMinimizedLayout();
        panel.dataset.minimized = 'true';
    }
}

/** 메모장 패널을 열고 닫는다. 오버레이가 없으므로 열려 있는 동안에도 화면의 다른 부분을 그대로 조작할 수 있다. */
function toggleMemoPad() {
    ensureMemoPad();
    const panel = document.getElementById('memo-pad-panel');
    if (!panel) return;
    const isOpen = panel.style.display !== 'none';
    if (isOpen) {
        panel.style.display = 'none';
    } else {
        panel.style.display = 'flex';
        document.getElementById('memo-pad-textarea')?.focus();
    }
}
window.toggleMemoPad = toggleMemoPad;

/* ──────────────────────────────────────────────
   🔗 버튼에 직접 단축키 지정하기 — "지정 모드"를 켜고 아무 버튼이나 클릭하면,
   그 자리에서 다음 키 입력을 받아 그 버튼에 연결한다. 실행할 때는 그 버튼을 실제로
   .click()하는 방식이라(코드를 따로 복사해서 돌리는 게 아니라 진짜 클릭과 동일), onclick 안에서
   this를 쓰는 버튼(예: 탭 전환)도 정상 동작한다. 단, 그러려면 그 버튼이 그 순간 화면에 실제로
   존재해야 한다 (대기열 항목처럼 매번 다시 그려지는 버튼은 지정해도 다음 렌더링 때 못 찾을 수 있음
   — 이 기능은 상단 고정 버튼들처럼 항상 같은 자리에 있는 버튼에 쓰는 걸 권장).
   ────────────────────────────────────────────── */
const CUSTOM_BUTTON_SHORTCUTS_KEY = 'customButtonShortcuts';
let buttonBindModeActive = false;

function getCustomButtonShortcuts() {
    try {
        const raw = JSON.parse(localStorage.getItem(CUSTOM_BUTTON_SHORTCUTS_KEY) || '[]');
        return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
}
function setCustomButtonShortcuts(list) {
    localStorage.setItem(CUSTOM_BUTTON_SHORTCUTS_KEY, JSON.stringify(list));
}
function removeCustomButtonShortcut(index) {
    const list = getCustomButtonShortcuts();
    list.splice(index, 1);
    setCustomButtonShortcuts(list);
    renderShortcutHelpModalBody();
}
window.removeCustomButtonShortcut = removeCustomButtonShortcut;

function comboMatches(e, combo) {
    return e.key.toLowerCase() === combo.key.toLowerCase()
        && !!e.ctrlKey === !!combo.ctrl && !!e.altKey === !!combo.alt && !!e.shiftKey === !!combo.shift;
}

function toggleButtonBindMode() {
    buttonBindModeActive = !buttonBindModeActive;
    const btn = document.getElementById('shortcut-bind-mode-btn');
    if (btn) {
        btn.textContent = buttonBindModeActive ? '🔗 지정 모드 켜짐 (끄려면 클릭)' : '🔗 버튼에 단축키 지정';
        btn.style.outline = buttonBindModeActive ? '2px solid #ffd600' : '';
    }
    showBindModeBanner(buttonBindModeActive);
}
window.toggleButtonBindMode = toggleButtonBindMode;

// 🆕 키보드로도 지정 모드 토글 가능 (기본 Ctrl+Alt+B, ⌨️ 단축키 도움말에서 재지정 가능).
// 팝업이 열려있으면 원래 자리의 "🔗" 버튼이 모달에 가려 안 눌릴 수 있는데, 이 단축키는
// document 전역에서 잡히므로 팝업이 열려있어도 항상 작동한다 — 버튼 자체는 크기/위치를
// 그대로 두고, 접근 경로만 하나 더 늘린 것.
document.addEventListener('keydown', (e) => {
    if (typeof matchesShortcutCombo !== 'function') return;
    if (!matchesShortcutCombo(e, 'toggleButtonBindMode')) return;
    e.preventDefault();
    toggleButtonBindMode();
});

function showBindModeBanner(show) {
    let banner = document.getElementById('bind-mode-banner');
    if (show) {
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'bind-mode-banner';
            banner.style.cssText = 'position:fixed; top:0; left:0; right:0; background:#ffd600; color:#000; ' +
                'text-align:center; padding:6px; font-weight:bold; z-index:2147483647; font-size:0.9em;';
            banner.textContent = '🔗 단축키 지정 모드 — 단축키로 쓰고 싶은 버튼을 클릭하세요 (끄려면 "🔗" 버튼 다시 클릭)';
            document.body.appendChild(banner);
        }
        banner.style.display = 'block';
    } else if (banner) {
        banner.style.display = 'none';
    }
}

// 지정 모드일 때는 버튼 클릭을 실제로 실행하지 않고 "지정 대상"으로 가로챈다
document.addEventListener('click', (e) => {
    if (!buttonBindModeActive) return;
    if (e.target.id === 'shortcut-bind-mode-btn') return; // 지정모드 토글 버튼 자신은 정상 동작해야 함
    const btn = e.target.closest('button');
    if (!btn) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    startCaptureShortcutForButton(btn);
}, true);

/** 버튼을 다시 찾기 위한 식별자를 만든다. id가 있으면 그걸로, 없으면 화면에 보이는 텍스트로.
 *  (onclick 속성 유무와 무관하게 동작 — property로 붙인 핸들러, addEventListener로 붙인 핸들러 전부
 *  실제 .click()으로 똑같이 트리거되므로, 여기선 "그 버튼을 다시 찾을 수만 있으면" 충분하다) */
function getButtonIdentifier(btn) {
    if (btn.id) return { type: 'id', value: btn.id };
    const text = (btn.textContent || '').trim();
    return { type: 'text', value: text };
}

function findButtonByIdentifier(identifier) {
    if (!identifier) return null;
    if (identifier.type === 'id') return document.getElementById(identifier.value);
    return Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === identifier.value) || null;
}

function startCaptureShortcutForButton(btn) {
    // 🔧 이전엔 onclick="..." 속성이 있는 버튼만 지정 가능했는데, .onclick = fn 처럼 자바스크립트로
    // 붙인 버튼(예: 🎨 랜덤 작가 섞기 등)은 그 속성이 안 남아서 "onclick 코드가 없다"고 막혔었다.
    // → 코드를 따로 저장하는 대신, 그 버튼을 "다시 찾을 식별자"만 저장해두고 실행 시 실제로 .click()해서
    //   호출 방식과 무관하게 항상 동작하도록 변경.
    const identifier = getButtonIdentifier(btn);
    const label = (btn.title || btn.textContent || '버튼').trim().replace(/\s+/g, ' ').slice(0, 40);

    showBindModeBanner(false);
    const captureBanner = document.createElement('div');
    captureBanner.id = 'bind-mode-capture-banner';
    captureBanner.style.cssText = 'position:fixed; top:0; left:0; right:0; background:#9C27B0; color:#fff; ' +
        'text-align:center; padding:6px; font-weight:bold; z-index:2147483647; font-size:0.9em;';
    captureBanner.textContent = `"${label}" 버튼에 지정할 키를 누르세요… (Esc 취소)`;
    document.body.appendChild(captureBanner);

    const handler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return; // 모디파이어 단독이면 계속 대기

        document.removeEventListener('keydown', handler, true);
        captureBanner.remove();
        if (buttonBindModeActive) showBindModeBanner(true); // 지정 모드는 계속 유지 (연속으로 여러 개 지정 가능)

        if (e.key === 'Escape') return; // 취소

        const combo = { key: e.key.length === 1 ? e.key.toLowerCase() : e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };

        const list = getCustomButtonShortcuts();
        const existingIdx = list.findIndex(item => comboMatches(e, item.combo));
        if (existingIdx !== -1) {
            const ok = confirm(`이미 "${list[existingIdx].label}"에 지정된 키예요. 덮어쓸까요?`);
            if (!ok) return;
            list.splice(existingIdx, 1);
        }

        list.push({ combo, identifier, label });
        setCustomButtonShortcuts(list);
        alert(`✅ "${label}" 버튼에 ${comboToLabel(combo)} 단축키를 지정했습니다.`);
    };
    document.addEventListener('keydown', handler, true);
}

document.addEventListener('keydown', (e) => {
    if (buttonBindModeActive) return; // 지정 모드 중엔 실행 안 함 (startCaptureShortcutForButton이 처리)
    const list = getCustomButtonShortcuts();
    const match = list.find(item => comboMatches(e, item.combo));
    if (!match) return;

    // 순수 키(모디파이어 없음)로 지정된 경우, 입력창에서 타이핑을 방해하지 않도록 무시
    const active = document.activeElement;
    const isFormField = active && (['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) || active.isContentEditable);
    if (isFormField && !match.combo.ctrl && !match.combo.alt) return;

    e.preventDefault();
    const liveBtn = findButtonByIdentifier(match.identifier);
    if (liveBtn) {
        liveBtn.click();
    } else {
        alert(`"${match.label}" 버튼을 화면에서 찾을 수 없어 실행하지 못했어요. (다른 탭으로 이동했거나 사라진 버튼일 수 있어요)`);
    }
}, true);

/* ──────────────────────────────────────────────
   🖱️ 좌클릭 누른 채로 휠: 쉼표(,)로 나뉜 프롬프트 조각을 한 칸씩 옮겨가며 선택
   - 휠을 내리면 다음 조각, 올리면 이전 조각으로 이동하며 그 구간을 드래그한 것처럼 선택해줌.
   - 새로 좌클릭할 때마다(mousedown) 그 클릭 위치가 속한 조각부터 다시 시작.
   - 같은 프롬프트 입력칸 목록(PROMPT_TEXT_FIELD_SELECTORS)에 그대로 적용.
   ────────────────────────────────────────────── */
const WHEEL_SELECT_SELECTORS = PROMPT_TEXT_FIELD_SELECTORS;

/** 텍스트를 쉼표 기준으로 나눈 뒤, "지울 때 깔끔하게 지워지도록" 콤마까지 포함한 선택 범위를 반환.
 *  - 마지막 조각이 아니면: 내용 + 뒤쪽 콤마(,) + 그 뒤 공백까지 포함 (예: "사과, ")
 *  - 맨 마지막 조각이면: 뒤에 콤마가 없으니, 대신 앞쪽 콤마(,)부터 포함 (예: ", 감귤")
 *  → 어떤 조각을 지워도 "쉼표가 두 개 붙거나 빈 칸만 남는" 문제 없이 자연스럽게 이어짐.
 *  (연속 콤마나 공백만 있는 빈 조각은 건너뜀) */
function getTrimmedCommaSegments(text) {
    const commaIndices = [];
    for (let i = 0; i < text.length; i++) if (text[i] === ',') commaIndices.push(i);

    const bounds = [];
    let prev = 0;
    commaIndices.forEach(ci => { bounds.push([prev, ci]); prev = ci + 1; });
    bounds.push([prev, text.length]);

    const segments = [];
    bounds.forEach(([bs, be], idx) => {
        let s = bs, e = be;
        while (s < e && /\s/.test(text[s])) s++;
        let te = e;
        while (te > s && /\s/.test(text[te - 1])) te--;
        if (te <= s) return; // 빈 조각은 선택할 게 없으니 건너뜀

        let selStart = s, selEnd = te;
        const hasTrailingComma = idx < commaIndices.length;
        if (hasTrailingComma) {
            const commaIdx = commaIndices[idx];
            selEnd = commaIdx + 1;
            while (selEnd < text.length && /\s/.test(text[selEnd])) selEnd++; // 콤마 뒤 공백까지
        } else if (idx > 0) {
            selStart = commaIndices[idx - 1]; // 마지막 조각이면 앞쪽 콤마부터 포함
        }
        segments.push({ start: selStart, end: selEnd });
    });
    return segments;
}

document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // 왼쪽 클릭만
    const el = e.target;
    if (el.matches && el.matches(WHEEL_SELECT_SELECTORS)) {
        delete el.dataset.wheelSelectIndex; // 새로 클릭했으니 다음 휠에서 클릭 위치 기준으로 다시 계산
    }
}, true);

document.addEventListener('wheel', (e) => {
    const el = e.target;
    if (!el.matches || !el.matches(WHEEL_SELECT_SELECTORS)) return;
    if (!(e.buttons & 1)) return; // 왼쪽 버튼이 지금 눌려있을 때만 동작 (그냥 스크롤은 그대로 통과)

    const segments = getTrimmedCommaSegments(el.value);
    if (segments.length === 0) return;

    e.preventDefault(); // 이 상태에선 페이지/입력칸 스크롤 대신 조각 선택으로 대체

    let idx = el.dataset.wheelSelectIndex !== undefined ? parseInt(el.dataset.wheelSelectIndex, 10) : NaN;
    if (Number.isNaN(idx)) {
        // 이번에 새로 누른 클릭 위치(캐럿)가 속한 조각을 찾아 그걸 첫 선택으로 삼는다
        const caret = el.selectionStart;
        idx = segments.findIndex(seg => caret >= seg.start && caret <= seg.end);
        if (idx === -1) idx = 0;
    } else {
        idx += (e.deltaY > 0 ? 1 : -1); // 휠 내림=다음 조각, 올림=이전 조각
    }
    idx = Math.max(0, Math.min(segments.length - 1, idx));
    el.dataset.wheelSelectIndex = String(idx);

    const seg = segments[idx];
    el.setSelectionRange(seg.start, seg.end);
}, { passive: false, capture: true });

/* ──────────────────────────────────────────────
   🔍 작가 이름 자동완성 (긍정프롬프트 전용): "artist:app" 까지만 쳐도 등록해둔 작가 목록에서
   이름 앞부분이 일치하는 후보를 보여주고, Enter로 바로 전체 이름으로 완성시켜준다.
   (📝 작가 목록 관리에 등록해둔 이름들을 그대로 매칭 대상으로 씀 — 랜덤 작가 섞기 기능과 같은 목록 재사용)
   ────────────────────────────────────────────── */
// 🆕 NAI 캐릭터별 프롬프트 칸(positive textarea)도 같은 자동완성이 되도록 selector에 추가함.
// ⚠️⚠️⚠️ 새 프롬프트 입력칸(textarea/input)을 추가할 때마다 반드시 이 selector에도 같이 추가할 것! ⚠️⚠️⚠️
// 안 그러면 그 칸에서만 유독 "artist:" 자동완성이 안 먹는 버그가 생김(실제로 NAI 기능 추가할 때 이걸 빼먹어서 한 번 발생했음).
const ARTIST_AUTOCOMPLETE_TARGET_SELECTOR = '#base-pos, .nai-character-positive-textarea, .cond-rule-add';

/** 캐럿 바로 앞이 "artist:이름쓰던중" 패턴인지 확인하고, 그 이름 부분의 실제 위치/텍스트를 반환. 아니면 null. */
function getArtistAutocompleteContext(el) {
    const value = el.value;
    const caret = el.selectionStart;
    const before = value.slice(0, caret);
    const match = before.match(/artist:([^,]*)$/i); // 캐럿 바로 앞이 콤마 없이 "artist:"로 이어지는 부분
    if (!match) return null;

    const raw = match[1];
    const leadingSpaces = raw.length - raw.replace(/^\s+/, '').length;
    const partial = raw.trim();
    const rawStart = caret - raw.length;

    return { partial, replaceStart: rawStart + leadingSpaces, replaceEnd: caret };
}

function renderArtistAutocompleteDropdown(el, matches) {
    let box = document.getElementById('artist-autocomplete-box');
    if (!box) {
        box = document.createElement('div');
        box.id = 'artist-autocomplete-box';
        box.style.cssText = 'position:fixed; z-index:99999; background:#222; border:1px solid #CE93D8; ' +
            'border-radius:6px; max-height:220px; overflow-y:auto; font-size:0.85em; ' +
            'box-shadow:0 4px 12px rgba(0,0,0,0.5);';
        document.body.appendChild(box);
    }
    const rect = el.getBoundingClientRect();
    box.style.left = rect.left + 'px';
    box.style.top = (rect.bottom + 2) + 'px';
    box.style.minWidth = Math.min(rect.width, 260) + 'px';
    box.style.display = 'block';
    box.dataset.selectedIndex = '0';

    box.innerHTML = matches.map((name, i) => `
        <div class="artist-ac-item" data-idx="${i}" data-name="${name.replace(/"/g, '&quot;')}"
             style="padding:5px 10px; cursor:pointer; color:#eee; ${i === 0 ? 'background:#3a2a4a;' : ''}">${name}</div>
    `).join('');

    box.querySelectorAll('.artist-ac-item').forEach(row => {
        row.onmousedown = (e) => {
            e.preventDefault(); // 클릭해도 textarea 포커스가 안 빠지게
            applyArtistAutocomplete(el, el._artistAcCtx, row.dataset.name);
            hideArtistAutocompleteDropdown();
        };
    });
}

function hideArtistAutocompleteDropdown() {
    const box = document.getElementById('artist-autocomplete-box');
    if (box) box.style.display = 'none';
}

function applyArtistAutocomplete(el, ctx, name) {
    if (!ctx) return;
    const value = el.value;
    const newValue = value.slice(0, ctx.replaceStart) + name + value.slice(ctx.replaceEnd);
    el.value = newValue;
    const newCaret = ctx.replaceStart + name.length;
    el.setSelectionRange(newCaret, newCaret);
    el.focus();
    el.dispatchEvent(new Event('input', { bubbles: true })); // 영어전용 경고 등 다른 리스너도 같이 갱신되게
}

document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.matches || !el.matches(ARTIST_AUTOCOMPLETE_TARGET_SELECTOR)) return;

    const ctx = getArtistAutocompleteContext(el);
    if (!ctx || ctx.partial.length === 0) { hideArtistAutocompleteDropdown(); return; }

    const pool = getRandomArtistList().map(entry => entry.name);
    // 🆕 등록된 이름에 언더스코어(_)가 있어도, 사용자가 공백으로 쳐도 같은 걸로 인식되게 정규화해서 비교
    const normalizeForMatch = (s) => s.toLowerCase().replace(/_/g, ' ');
    const lower = normalizeForMatch(ctx.partial);
    const matches = pool.filter(name => normalizeForMatch(name).startsWith(lower)).slice(0, 8);

    if (matches.length === 0) { hideArtistAutocompleteDropdown(); return; }
    el._artistAcCtx = ctx;
    renderArtistAutocompleteDropdown(el, matches);
}, true);

document.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!el.matches || !el.matches(ARTIST_AUTOCOMPLETE_TARGET_SELECTOR)) return;
    const box = document.getElementById('artist-autocomplete-box');
    if (!box || box.style.display === 'none') return;

    const items = Array.from(box.querySelectorAll('.artist-ac-item'));
    if (items.length === 0) return;
    let idx = parseInt(box.dataset.selectedIndex || '0', 10);

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        idx = Math.min(items.length - 1, idx + 1);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        idx = Math.max(0, idx - 1);
    } else if (e.key === 'Enter') {
        e.preventDefault(); // 줄바꿈 삽입 방지, 대신 자동완성 확정
        applyArtistAutocomplete(el, el._artistAcCtx, items[idx].dataset.name);
        hideArtistAutocompleteDropdown();
        return;
    } else if (e.key === 'Escape') {
        hideArtistAutocompleteDropdown();
        return;
    } else if (e.key === 'Tab') {
        e.preventDefault();
        applyArtistAutocomplete(el, el._artistAcCtx, items[idx].dataset.name);
        hideArtistAutocompleteDropdown();
        return;
    } else {
        return; // 다른 키는 그냥 통과시켜서 계속 타이핑되게
    }

    box.dataset.selectedIndex = String(idx);
    items.forEach((it, i) => { it.style.background = i === idx ? '#3a2a4a' : ''; });
}, true);

// 입력칸에서 포커스가 빠지면(다른 곳 클릭 등) 목록도 같이 숨김 (focus/blur는 버블 안 하므로 capture로 등록)
document.addEventListener('blur', (e) => {
    if (e.target && e.target.matches && e.target.matches(ARTIST_AUTOCOMPLETE_TARGET_SELECTOR)) {
        setTimeout(hideArtistAutocompleteDropdown, 150); // 후보 클릭 처리 시간을 확보한 뒤 숨김
    }
}, true);

/* ──────────────────────────────────────────────
   ➕ 대기열 화면에도 "새 조각" 버튼 추가 — "대기열 비우기" 버튼 바로 옆에.
   index.html을 안 건드리고, 이미 있는 "대기열 비우기" 버튼(onclick="clearJobQueue()")을
   런타임에 찾아서 그 옆에 끼워넣는 방식(🎲 랜덤 작가 버튼과 같은 패턴).
   클릭하면 라이브러리의 ➕새조각(addItem)과 완전히 똑같이 동작 — 현재 선택된 라이브러리
   그룹에 새 조각을 만들고, 편집 모달을 열고, 대기열에도 바로 추가된다.
   ────────────────────────────────────────────── */
function ensureQueueNewFragmentButton() {
    if (document.getElementById('queue-new-fragment-btn')) return;
    const clearBtn = Array.from(document.querySelectorAll('button'))
        .find(b => (b.getAttribute('onclick') || '').replace(/\s/g, '').includes('clearJobQueue()'));
    if (!clearBtn || !clearBtn.parentElement) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'queue-new-fragment-btn';
    btn.className = clearBtn.className || 'btn-secondary';
    btn.textContent = '➕ 새 조각';
    btn.title = '➕새조각과 완전히 동일 — 현재 선택된 라이브러리 그룹에 새 조각을 만들고 대기열에도 바로 추가합니다.';
    btn.onclick = () => { if (typeof addItem === 'function') addItem(); };

    clearBtn.insertAdjacentElement('afterend', btn);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureQueueNewFragmentButton);
} else {
    ensureQueueNewFragmentButton();
}

/* ──────────────────────────────────────────────
   🎨 랜덤 작가 섞기 — 로라 추가가 아니라 "긍정 프롬프트에 직접" 작가 태그를 섞어 넣는 기능.
   🎲 랜덤 로라와 완전히 같은 패턴: 사용자가 직접 관리하는 작가 목록 중 체크된 것들에서
   2~5명을 무작위로 골라 "1.5::artist:이름::," 형식으로 긍정 프롬프트(#base-pos)에 추가한다.
   누를 때마다 이전에 자동으로 넣어둔 태그는 지우고 새로 채운다 (누적 방지, 🎲 랜덤 로라와 동일).
   ────────────────────────────────────────────── */

const RANDOM_ARTIST_LIST_KEY = 'randomArtistManageList';
const RANDOM_ARTIST_COUNT_KEY = 'randomArtistCountRange'; // 🆕 최소/최대 뽑을 인원수 (사용자 조절 가능)

/** 저장된 최소/최대 인원수를 읽어온다. 기본값 2~13명 */
function getRandomArtistCountRange() {
    try {
        const raw = JSON.parse(localStorage.getItem(RANDOM_ARTIST_COUNT_KEY) || 'null');
        if (raw && Number.isFinite(raw.min) && Number.isFinite(raw.max) && raw.min >= 1 && raw.max >= raw.min) {
            return raw;
        }
    } catch (e) { /* 무시하고 기본값 반환 */ }
    return { min: 2, max: 13 };
}

function setRandomArtistCountRange(min, max) {
    localStorage.setItem(RANDOM_ARTIST_COUNT_KEY, JSON.stringify({ min, max }));
}

/** 저장된 작가 목록을 읽어온다. 형식: [{ name: '작가이름', enabled: true }, ...] */
function getRandomArtistList() {
    try {
        const raw = JSON.parse(localStorage.getItem(RANDOM_ARTIST_LIST_KEY) || '[]');
        if (Array.isArray(raw)) return raw.filter(e => e && typeof e.name === 'string');
    } catch (e) { /* 무시하고 빈 목록 반환 */ }
    return [];
}

function setRandomArtistList(list) {
    localStorage.setItem(RANDOM_ARTIST_LIST_KEY, JSON.stringify(list));
}

/** 📝 작가 목록 관리 모달: 직접 이름을 추가/삭제하고, 체크로 켜고 끌 수 있다 (🚫 랜덤 로라 제외 목록과 같은 UI 패턴) */
function openRandomArtistManageModal() {
    if (!document.getElementById('random-artist-manage-modal')) {
        const modal = document.createElement('div');
        modal.id = 'random-artist-manage-modal';
        modal.className = 'modal-overlay';
        modal.style.cssText = 'display:none;';
        modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
        document.body.appendChild(modal);
    }
    renderRandomArtistManageModal();
    document.getElementById('random-artist-manage-modal').style.display = 'flex';
}
window.openRandomArtistManageModal = openRandomArtistManageModal;

const RANDOM_ARTIST_ROWS_RENDER_LIMIT = 300; // 한 번에 그리는 최대 줄 수 — 수천 개를 한꺼번에 그리면 모달이 버벅여서 캡을 둠

/** 검색어로 걸러낸 작가 행 HTML을 만든다. 인덱스(i)는 항상 "필터 전 전체 목록" 기준 원래 위치를
 *  그대로 쓴다 — toggleRandomArtistEnabled/removeRandomArtistEntry가 그 인덱스로 배열을 직접 건드리기 때문. */
function buildRandomArtistRowsHtml(filterText) {
    const list = getRandomArtistList();
    const q = (filterText || '').trim().toLowerCase();
    const filtered = list
        .map((entry, i) => ({ entry, i }))
        .filter(({ entry }) => !q || entry.name.toLowerCase().includes(q));

    if (list.length === 0) {
        return `<p style="color:#888; font-size:0.85em;">아직 등록된 작가가 없습니다. 아래에서 추가해 주세요.</p>`;
    }
    if (filtered.length === 0) {
        return `<p style="color:#888; font-size:0.85em;">"${escapeHtml(filterText)}"와(과) 일치하는 작가가 없습니다.</p>`;
    }

    const shown = filtered.slice(0, RANDOM_ARTIST_ROWS_RENDER_LIMIT);
    const rowsHtml = shown.map(({ entry, i }) => `
        <div style="display:flex; align-items:center; gap:8px; padding:4px 0; border-bottom:1px solid #333;">
            <input type="checkbox" ${entry.enabled !== false ? 'checked' : ''}
                   onchange="toggleRandomArtistEnabled(${i}, this.checked)">
            <span style="flex:1;">${escapeHtml(entry.name)}</span>
            <button class="btn-secondary" style="padding:2px 8px;" onclick="removeRandomArtistEntry(${i})">🗑</button>
        </div>`).join('');

    const moreNotice = filtered.length > RANDOM_ARTIST_ROWS_RENDER_LIMIT
        ? `<p style="color:#888; font-size:0.78em; margin:6px 0 0;">${filtered.length}건 중 ${RANDOM_ARTIST_ROWS_RENDER_LIMIT}건만 표시 중 — 검색으로 좁혀 보세요.</p>`
        : (q ? `<p style="color:#888; font-size:0.78em; margin:6px 0 0;">전체 ${list.length}건 중 ${filtered.length}건 일치</p>` : '');

    return rowsHtml + moreNotice;
}

/** 검색창에 입력할 때마다 목록 전체(검색창 포함)를 다시 그리지 않고, 행 목록 부분만 갱신한다
 *  (전체를 다시 그리면 입력 중이던 검색창이 매번 새로 생겨서 포커스/커서 위치가 날아감). */
function filterRandomArtistRows(filterText) {
    const container = document.getElementById('random-artist-rows-container');
    if (container) container.innerHTML = buildRandomArtistRowsHtml(filterText);
}
window.filterRandomArtistRows = filterRandomArtistRows;

function renderRandomArtistManageModal() {
    const modal = document.getElementById('random-artist-manage-modal');
    const list = getRandomArtistList();
    const countRange = getRandomArtistCountRange();

    const rowsHtml = buildRandomArtistRowsHtml('');

    modal.innerHTML = `
        <div class="modal-content" onclick="event.stopPropagation()" style="width:min(90vw, 480px);">
            <div class="modal-header">
                <h3 style="margin:0; color:#CE93D8;">🎨 랜덤 작가 목록 관리</h3>
                <span class="close-btn" style="position:static; font-size:1.5em; color:#ff5555;"
                      onclick="document.getElementById('random-artist-manage-modal').style.display='none';">&times;</span>
            </div>
            <div class="modal-body">
            <p style="font-size:0.82em; color:#aaa; margin:8px 0;">체크된 작가만 🎨 랜덤 작가 섞기를 누를 때 뽑힙니다. 체크만 끄면 목록엔 남고 랜덤 뽑기에서만 제외돼요.</p>

            <!-- 🆕 한 번에 뽑을 최소/최대 인원수 조절 -->
            <div style="display:flex; align-items:center; gap:6px; margin-bottom:10px; font-size:0.85em; color:#ddd;">
                <span>한 번에</span>
                <input type="number" id="random-artist-count-min" min="1" max="99" value="${countRange.min}"
                       style="width:52px;" onchange="updateRandomArtistCountRange()">
                <span>~</span>
                <input type="number" id="random-artist-count-max" min="1" max="99" value="${countRange.max}"
                       style="width:52px;" onchange="updateRandomArtistCountRange()">
                <span>명 랜덤 (학습이 잘 안 된 작가가 많으면 이 숫자를 줄여보세요)</span>
            </div>

            <div style="display:flex; gap:6px; margin-bottom:6px;">
                <input type="text" id="random-artist-new-name" placeholder="작가 이름 입력"
                       style="flex:1;" onkeydown="if(event.key==='Enter'){ event.preventDefault(); addRandomArtistEntry(); }">
                <button class="btn-primary" onclick="addRandomArtistEntry()">추가</button>
            </div>

            <!-- 🆕 일괄 추가: 쉼표/줄바꿈으로 구분된 텍스트를 통째로 붙여넣으면 한 번에 다 등록됨 (수천 개도 가능) -->
            <details style="margin-bottom:10px;">
                <summary style="cursor:pointer; color:#CE93D8; font-size:0.85em;">📋 여러 명 한 번에 붙여넣기 (대량 등록)</summary>
                <div style="margin-top:6px;">
                    <textarea id="random-artist-bulk-text" rows="4" style="width:100%; resize:vertical;"
                              placeholder="쉼표(,) 또는 줄바꿈으로 구분해서 여러 이름을 한 번에 붙여넣으세요. 수천 개를 한 번에 붙여넣어도 됩니다.&#10;예: wlop, sakimichan, ningen (mob idol)"></textarea>
                    <button class="btn-secondary" style="margin-top:4px;" onclick="bulkAddRandomArtists()">일괄 추가</button>
                    <span id="random-artist-bulk-result" style="font-size:0.8em; color:#8bc34a; margin-left:8px;"></span>
                </div>
            </details>

            <!-- 🆕 목록이 많아지면 스크롤로 다 훑기 힘드니, 이름으로 바로 걸러볼 수 있는 검색창 -->
            <input type="text" id="random-artist-search-input" placeholder="🔍 등록된 작가 검색 (${list.length}명 등록됨)"
                   style="width:100%; box-sizing:border-box; margin-bottom:6px;"
                   oninput="filterRandomArtistRows(this.value)">

            <div id="random-artist-rows-container" style="max-height:300px; overflow-y:auto;">${rowsHtml}</div>
            </div>
        </div>`;
}

/** 🆕 일괄 추가: 쉼표/줄바꿈으로 구분된 텍스트를 한 번에 파싱해서 목록에 추가 (중복은 자동으로 건너뜀) */
function bulkAddRandomArtists() {
    const textarea = document.getElementById('random-artist-bulk-text');
    const raw = textarea?.value || '';
    const names = raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    if (names.length === 0) return;

    const list = getRandomArtistList();
    const existing = new Set(list.map(e => e.name.toLowerCase()));
    let added = 0;
    names.forEach(name => {
        if (!existing.has(name.toLowerCase())) {
            list.push({ name, enabled: true });
            existing.add(name.toLowerCase());
            added++;
        }
    });
    setRandomArtistList(list);
    if (textarea) textarea.value = '';

    const resultEl = document.getElementById('random-artist-bulk-result');
    renderRandomArtistManageModal();
    // renderRandomArtistManageModal이 모달 전체를 다시 그리므로, 다시 그린 뒤의 결과 표시 엘리먼트를 잡아서 메시지 표시
    const newResultEl = document.getElementById('random-artist-bulk-result');
    if (newResultEl) newResultEl.textContent = `✅ ${added}명 추가됨 (중복 ${names.length - added}명 제외)`;
}
window.bulkAddRandomArtists = bulkAddRandomArtists;

/** 🆕 모달의 최소/최대 인원수 입력값이 바뀌면 검증 후 저장 (최소가 최대보다 크면 자동으로 맞춰줌) */
function updateRandomArtistCountRange() {
    const minEl = document.getElementById('random-artist-count-min');
    const maxEl = document.getElementById('random-artist-count-max');
    let min = parseInt(minEl?.value, 10);
    let max = parseInt(maxEl?.value, 10);
    if (!Number.isFinite(min) || min < 1) min = 1;
    if (!Number.isFinite(max) || max < 1) max = 1;
    if (min > max) { const t = min; min = max; max = t; } // 실수로 거꾸로 입력해도 알아서 정렬
    setRandomArtistCountRange(min, max);
    if (minEl) minEl.value = min;
    if (maxEl) maxEl.value = max;
}
window.updateRandomArtistCountRange = updateRandomArtistCountRange;

function addRandomArtistEntry() {
    const input = document.getElementById('random-artist-new-name');
    const name = (input?.value || '').trim();
    if (!name) return;
    const list = getRandomArtistList();
    if (list.some(e => e.name.toLowerCase() === name.toLowerCase())) {
        alert('이미 목록에 있는 이름입니다.');
        return;
    }
    list.push({ name, enabled: true });
    setRandomArtistList(list);
    if (input) input.value = '';
    renderRandomArtistManageModal();
}
window.addRandomArtistEntry = addRandomArtistEntry;

function toggleRandomArtistEnabled(index, checked) {
    const list = getRandomArtistList();
    if (list[index]) {
        list[index].enabled = checked;
        setRandomArtistList(list);
    }
}
window.toggleRandomArtistEnabled = toggleRandomArtistEnabled;

function removeRandomArtistEntry(index) {
    const list = getRandomArtistList();
    list.splice(index, 1);
    setRandomArtistList(list);
    renderRandomArtistManageModal();
}
window.removeRandomArtistEntry = removeRandomArtistEntry;

/* ──────────────────────────────────────────────
   🎭 작가 순차 스타일 테스트 — 기존 "🎨 랜덤 작가 섞기" 목록과는 완전히 별개인 목록.
   여기 등록해둔 작가를 순서대로 하나씩, 전부 같은 시드로 대기열에 넣어서
   "같은 장면, 작가만 바뀌는" 비교용 이미지들을 한 번에 뽑을 수 있다.
   ────────────────────────────────────────────── */
const ARTIST_STYLE_TEST_LIST_KEY = 'artistStyleTestList';

function getArtistStyleTestList() {
    try {
        const raw = JSON.parse(localStorage.getItem(ARTIST_STYLE_TEST_LIST_KEY) || '[]');
        return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
}
function setArtistStyleTestList(list) {
    try { localStorage.setItem(ARTIST_STYLE_TEST_LIST_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
}

const ARTIST_STYLE_TEST_ROWS_RENDER_LIMIT = 300;

function buildArtistStyleTestRowsHtml(filterText) {
    const list = getArtistStyleTestList();
    const q = (filterText || '').trim().toLowerCase();
    const filtered = list
        .map((entry, i) => ({ entry, i }))
        .filter(({ entry }) => !q || entry.name.toLowerCase().includes(q));

    if (list.length === 0) {
        return `<p style="color:#888; font-size:0.85em;">아직 등록된 작가가 없습니다. 아래에서 추가해 주세요.</p>`;
    }
    if (filtered.length === 0) {
        return `<p style="color:#888; font-size:0.85em;">"${escapeHtml(filterText)}"와(과) 일치하는 작가가 없습니다.</p>`;
    }

    const shown = filtered.slice(0, ARTIST_STYLE_TEST_ROWS_RENDER_LIMIT);
    const rowsHtml = shown.map(({ entry, i }) => `
        <div style="display:flex; align-items:center; gap:8px; padding:4px 0; border-bottom:1px solid #333;">
            <span style="width:26px; color:#888; font-size:0.8em; text-align:right;">${i + 1}.</span>
            <input type="checkbox" ${entry.enabled !== false ? 'checked' : ''}
                   onchange="toggleArtistStyleTestEnabled(${i}, this.checked)">
            <span style="flex:1;">${escapeHtml(entry.name)}</span>
            <button class="btn-secondary" style="padding:2px 8px;" onclick="removeArtistStyleTestEntry(${i})">🗑</button>
        </div>`).join('');

    const moreNotice = filtered.length > ARTIST_STYLE_TEST_ROWS_RENDER_LIMIT
        ? `<p style="color:#888; font-size:0.78em; margin:6px 0 0;">${filtered.length}건 중 ${ARTIST_STYLE_TEST_ROWS_RENDER_LIMIT}건만 표시 중 — 검색으로 좁혀 보세요.</p>`
        : (q ? `<p style="color:#888; font-size:0.78em; margin:6px 0 0;">전체 ${list.length}건 중 ${filtered.length}건 일치</p>` : '');

    return rowsHtml + moreNotice;
}

function filterArtistStyleTestRows(filterText) {
    const container = document.getElementById('artist-style-test-rows-container');
    if (container) container.innerHTML = buildArtistStyleTestRowsHtml(filterText);
}
window.filterArtistStyleTestRows = filterArtistStyleTestRows;

function renderArtistStyleTestModal() {
    const modal = document.getElementById('artist-style-test-manage-modal');
    const list = getArtistStyleTestList();
    const rowsHtml = buildArtistStyleTestRowsHtml('');

    modal.innerHTML = `
        <div class="modal-content" onclick="event.stopPropagation()" style="width:min(90vw, 480px);">
            <div class="modal-header">
                <h3 style="margin:0; color:#4FC3F7;">🎭 작가 순차 테스트 목록</h3>
                <span class="close-btn" style="position:static; font-size:1.5em; color:#ff5555;"
                      onclick="document.getElementById('artist-style-test-manage-modal').style.display='none';">&times;</span>
            </div>
            <div class="modal-body">
            <p style="font-size:0.82em; color:#aaa; margin:8px 0;">체크된 작가들을 <b>등록된 순서 그대로</b> 하나씩, 전부 같은 시드로 대기열에 넣습니다 (그림체만 순수 비교). 🎨 랜덤 작가 섞기 목록과는 완전히 별개예요.</p>

            <div style="display:flex; gap:6px; margin-bottom:6px;">
                <input type="text" id="artist-style-test-new-name" placeholder="작가 이름 입력"
                       style="flex:1;" onkeydown="if(event.key==='Enter'){ event.preventDefault(); addArtistStyleTestEntry(); }">
                <button class="btn-primary" onclick="addArtistStyleTestEntry()">추가</button>
            </div>

            <details style="margin-bottom:10px;">
                <summary style="cursor:pointer; color:#4FC3F7; font-size:0.85em;">📋 여러 명 한 번에 붙여넣기 (순서 그대로 등록됨)</summary>
                <div style="margin-top:6px;">
                    <textarea id="artist-style-test-bulk-text" rows="4" style="width:100%; resize:vertical;"
                              placeholder="쉼표(,) 또는 줄바꿈으로 구분해서 붙여넣으세요. 붙여넣은 순서 그대로 테스트 순서가 됩니다.&#10;예: wlop, sakimichan, ningen (mob idol)"></textarea>
                    <button class="btn-secondary" style="margin-top:4px;" onclick="bulkAddArtistStyleTest()">일괄 추가</button>
                    <span id="artist-style-test-bulk-result" style="font-size:0.8em; color:#8bc34a; margin-left:8px;"></span>
                </div>
            </details>

            <input type="text" id="artist-style-test-search-input" placeholder="🔍 등록된 작가 검색 (${list.length}명 등록됨)"
                   style="width:100%; box-sizing:border-box; margin-bottom:6px;"
                   oninput="filterArtistStyleTestRows(this.value)">

            <div id="artist-style-test-rows-container" style="max-height:300px; overflow-y:auto;">${rowsHtml}</div>

            <button class="btn-primary" style="width:100%; margin-top:12px; background:#4FC3F7; border-color:#4FC3F7;"
                    data-help="artistStyleTestStart" onclick="runArtistStyleTest()">🎭 이 목록으로 순차 테스트 시작 (대기열에 추가)</button>
            </div>
        </div>`;
}

function openArtistStyleTestModal() {
    let modal = document.getElementById('artist-style-test-manage-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'artist-style-test-manage-modal';
        modal.className = 'modal-overlay';
        modal.style.cssText = 'display:none;';
        modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
        document.body.appendChild(modal);
    }
    renderArtistStyleTestModal();
    modal.style.display = 'flex';
}
window.openArtistStyleTestModal = openArtistStyleTestModal;

function addArtistStyleTestEntry() {
    const input = document.getElementById('artist-style-test-new-name');
    const name = (input?.value || '').trim();
    if (!name) return;
    const list = getArtistStyleTestList();
    if (list.some(e => e.name.toLowerCase() === name.toLowerCase())) {
        alert('이미 목록에 있는 이름입니다.');
        return;
    }
    list.push({ name, enabled: true });
    setArtistStyleTestList(list);
    if (input) input.value = '';
    renderArtistStyleTestModal();
}
window.addArtistStyleTestEntry = addArtistStyleTestEntry;

function bulkAddArtistStyleTest() {
    const textarea = document.getElementById('artist-style-test-bulk-text');
    const raw = textarea?.value || '';
    const names = raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    if (names.length === 0) return;

    const list = getArtistStyleTestList();
    const existing = new Set(list.map(e => e.name.toLowerCase()));
    let added = 0;
    names.forEach(name => {
        if (!existing.has(name.toLowerCase())) {
            list.push({ name, enabled: true });
            existing.add(name.toLowerCase());
            added++;
        }
    });
    setArtistStyleTestList(list);
    if (textarea) textarea.value = '';

    renderArtistStyleTestModal();
    const newResultEl = document.getElementById('artist-style-test-bulk-result');
    if (newResultEl) newResultEl.textContent = `✅ ${added}명 추가됨 (중복 ${names.length - added}명 제외)`;
}
window.bulkAddArtistStyleTest = bulkAddArtistStyleTest;

function toggleArtistStyleTestEnabled(index, checked) {
    const list = getArtistStyleTestList();
    if (list[index]) list[index].enabled = checked;
    setArtistStyleTestList(list);
}
window.toggleArtistStyleTestEnabled = toggleArtistStyleTestEnabled;

function removeArtistStyleTestEntry(index) {
    const list = getArtistStyleTestList();
    list.splice(index, 1);
    setArtistStyleTestList(list);
    renderArtistStyleTestModal();
}
window.removeArtistStyleTestEntry = removeArtistStyleTestEntry;

/** 🎭 등록된 순서 그대로, 체크된 작가들을 전부 같은(공유) 시드로 대기열에 추가한다.
 *  기존 조각(item) 시스템과 무관한 "합성 job"이라 sourceRefs는 비워두고 fullPrompt에
 *  작가 태그만 직접 넣는다 — 화면 상단의 공통 프롬프트(장면)는 대기열 실행 시 자동으로 같이 합쳐짐. */
function runArtistStyleTest() {
    const pool = getArtistStyleTestList().filter(e => e.enabled !== false);
    if (pool.length === 0) {
        alert('테스트할 작가가 없습니다. 목록에서 먼저 작가를 추가/체크해 주세요.');
        return;
    }
    const sharedSeed = Math.floor(Math.random() * 10000000000000000); // 이 배치 전체가 공유할 시드 (한 번만 뽑음)

    pool.forEach((artist, i) => {
        addJobToQueue({
            id: Date.now() + i,
            labels: { '작가테스트': `${i + 1}. ${artist.name}` },
            fullPrompt: [`(artist:${artist.name}:1.0)`],
            sourceRefs: [],
            repeatCount: 1,
            seedGroupSeed: sharedSeed
        });
    });

    document.getElementById('artist-style-test-manage-modal').style.display = 'none';
    document.getElementById('mode-batch').checked = true;
    if (typeof toggleGenMode === 'function') toggleGenMode();
    alert(`✅ ${pool.length}명의 작가로 순차 테스트 작업 ${pool.length}개를 대기열에 추가했습니다.\n(전부 같은 시드 ${sharedSeed}를 공유합니다 — 대기열에서 "일괄 실행"을 눌러 진행하세요)`);
}
window.runArtistStyleTest = runArtistStyleTest;

/** #selected-loras 아래, 🎨 랜덤 작가 버튼들 옆에 "🎭 작가 순차 테스트" 버튼을 한 번만 끼워넣는다. */
function ensureArtistStyleTestUI() {
    if (document.getElementById('artist-style-test-btn')) return;
    const anchor = document.getElementById('random-artist-mix-btn')?.parentElement;
    if (!anchor || !anchor.parentElement) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'artist-style-test-btn';
    btn.className = 'btn-secondary';
    btn.style.cssText = 'border-color:#4FC3F7; color:#4FC3F7; margin-top:6px;';
    btn.textContent = '🎭 작가 순차 스타일 테스트';
    btn.onclick = openArtistStyleTestModal;

    anchor.insertAdjacentElement('afterend', btn);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureArtistStyleTestUI);
} else {
    ensureArtistStyleTestUI();
}

/** 🎨 랜덤 작가 섞기: 체크된 작가 중 2~5명을 무작위로 골라 긍정 프롬프트에 "1.5::artist:이름::," 형식으로 넣는다.
 *  🎲 랜덤 로라와 동일하게, 누를 때마다 이전에 자기가 넣어둔 태그는 지우고 새로 채운다 (누적 방지). */
function addRandomArtists() {
    const posEl = document.getElementById('base-pos');
    if (!posEl) return;

    const pool = getRandomArtistList().filter(e => e.enabled !== false);
    if (pool.length === 0) {
        alert('랜덤으로 뽑을 작가가 없습니다. 📝 작가 목록 관리에서 먼저 작가를 추가/체크해 주세요.');
        return;
    }

    // ── 이전에 이 기능으로 자동으로 넣어뒀던 태그들을 먼저 지운다 (누적 방지, 🎲 랜덤 로라와 동일 패턴) ──
    let prevTags = [];
    try { prevTags = JSON.parse(posEl.dataset.randomArtistTags || '[]'); } catch (e) { prevTags = []; }
    let text = posEl.value;
    prevTags.forEach(tag => {
        if (!tag) return;
        text = text.replace(new RegExp(`\\s*,?\\s*${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,?`, 'g'), ', ');
    });
    text = text.replace(/^\s*,\s*/, '').replace(/,\s*,/g, ',').replace(/,\s*$/, '').trim();

    const count = Math.min(pool.length, (() => {
        const { min, max } = getRandomArtistCountRange(); // 🆕 설정 모달에서 지정한 최소/최대 인원수 사용
        return Math.floor(Math.random() * (max - min + 1)) + min;
    })());
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const picked = shuffled.slice(0, count);

    // 🆕 가중치도 매번 랜덤 (0.2~1.3, 소수 첫째자리)
    const randomWeight = () => (Math.random() * (1.3 - 0.2) + 0.2).toFixed(1);
    // 🆕 ComfyUI 식 가중치 표기로 변경: (artist:이름:가중치),
    const newTags = picked.map(entry => `(artist:${entry.name}:${randomWeight()}),`);

    posEl.value = text
        ? `${text}, ${newTags.join(' ')}`
        : newTags.join(' ');
    posEl.dataset.randomArtistTags = JSON.stringify(newTags); // 다음에 또 누를 때 이번 것들을 지우기 위해 기억
}
window.addRandomArtists = addRandomArtists;

/** 작가 표기 형식 종류. 코드/커뮤니티에서 실제로 쓰이는 것만 추렸다 — ComfyUI 괄호 가중치 쪽은
 *  NAI 가중치(1.2::이름::)는 NovelAI 공식 문법(docs.novelai.net)으로, 숫자가 꼭 앞에 붙어야 한다. */
const ARTIST_TAG_FORMATS = {
    bare:     { label: '맨 태그 (이름)',            render: (n, w) => n },
    bare_w:   { label: '가중치 ((이름:1.2))',        render: (n, w) => `(${n}:${w || 1.2})` },
    at:       { label: '@이름',                      render: (n, w) => `@${n}` },
    artist:   { label: 'artist:이름',                render: (n, w) => w ? `(artist:${n}:${w})` : `artist:${n}` },
    nai:      { label: 'NAI 가중치 (1.2::이름::)',    render: (n, w) => `${w || 1.2}::${n}::` },
    by:       { label: '자연어 (by 이름)',            render: (n, w) => `by ${n}` },
};

/** text 안에서 인식되는 모든 작가 표기(위 6종)를 찾아 targetFormat으로 전부 통일한다.
 *  "artist:"/"@"/"by"/NAI "::" 처럼 표기 자체에 marker가 있는 건 이름이 뭐든 바로 인식하지만,
 *  marker가 없는 맨 태그·괄호 가중치만 있는 태그(예: (rella:1.2))는 그게 작가 이름인지 그냥
 *  "masterpiece" 같은 일반 태그인지 글자만 보고 구분할 수 없다 — 그래서 이 두 경우만
 *  📝 작가 목록 관리에 등록해둔 이름과 매칭될 때만 작가로 인식한다 (일반 태그 오염 방지). */
function convertArtistTagsTo(text, targetFormat) {
    if (!text) return { text: text || '', count: 0 };
    const renderer = ARTIST_TAG_FORMATS[targetFormat];
    if (!renderer) return { text, count: 0 };

    // 🐛 찾은 작가는 바로 목표 형식으로 바꿔 넣지 않고, 일단 널문자 placeholder로만 바꿔둔다.
    // 바로 바꿔 넣으면(예: artist:이름 → NAI 1.2::이름::) 그 결과물이 다음 순서의 다른 형식
    // 인식 패턴(NAI용 ::)에 다시 걸려서 한 작가가 두 번 세어지는 문제가 있었음 — placeholder는
    // 어떤 인식 패턴과도 절대 안 겹치는 문자라 이 문제가 없고, 맨 마지막에 한 번에 실제 형식으로 바꾼다.
    const found = [];
    const mark = (name, weight) => { found.push({ name: name.trim(), weight: weight || null }); return `\u0000${found.length - 1}\u0000`; };

    // 1) (artist:이름:가중치)
    text = text.replace(/\(\s*artist\s*:\s*([^:()]+?)\s*:\s*([\d.]+)\s*\)/gi, (m, n, w) => mark(n, w));
    // 2) artist:이름 (가중치 없이, 태그 맨 앞에서만)
    text = text.replace(/(^|[,(])\s*artist\s*:\s*([^,()]+)/gi, (m, pre, n) => pre + mark(n, null));
    // 3) NAI 1.2::이름::
    text = text.replace(/([\d.]+)\s*::\s*([^:]+?)\s*::/g, (m, w, n) => mark(n, w));
    // 4) by 이름 (자연어, 태그 맨 앞에서만)
    text = text.replace(/(^|[,(])\s*by\s+([^,()]+)/gi, (m, pre, n) => pre + mark(n, null));
    // 5) @이름
    text = text.replace(/(^|[\s,(])@([^\s,()]+)/g, (m, pre, n) => pre + mark(n, null));

    // 6) 등록된 작가 목록에 있는 이름만: 괄호 가중치만 있는 맨 태그, 또는 아무 표시도 없는 맨 태그
    //    (목록에 없는 단어는 일반 태그일 수 있어서 절대 안 건드림)
    const knownNames = getRandomArtistList().map(e => e.name).filter(Boolean);
    if (knownNames.length) {
        const escaped = knownNames
            .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .sort((a, b) => b.length - a.length); // 긴 이름부터 매칭(짧은 이름이 부분일치로 먼저 먹는 것 방지)
        const altGroup = escaped.join('|');
        text = text.replace(new RegExp(`\\(\\s*(${altGroup})\\s*:\\s*([\\d.]+)\\s*\\)`, 'gi'), (m, n, w) => mark(n, w));
        text = text.replace(new RegExp(`(^|[,(])\\s*(${altGroup})\\s*(?=,|\\)|$)`, 'gi'), (m, pre, n) => pre + mark(n, null));
    }

    text = text.replace(/\u0000(\d+)\u0000/g, (m, idx) => renderer.render(found[idx].name, found[idx].weight));
    return { text, count: found.length };
}

/** "🔄 작가 표기 일괄 변환" 버튼: #base-pos에서 인식되는 모든 작가 표기를 드롭다운에서 고른
 *  형식 하나로 통일한다. 어느 형식이 실제로 맞는지는 체크포인트마다 달라서(검색해서 확인한 내용 —
 *  danbooru 태그 학습 모델은 "artist:"가 죽은 토큰이지만, e621/구조화 캡션으로 학습된 모델은
 *  "artist:"를 실제로 학습했을 수 있음) 자동 판단하지 않고, 사람이 직접 골라서 바꾸게 한다. */
function convertArtistTagsBulk() {
    const posEl = document.getElementById('base-pos');
    const sel = document.getElementById('artist-format-select');
    if (!posEl || !sel) return;
    const { text, count } = convertArtistTagsTo(posEl.value, sel.value);
    if (count === 0) {
        alert('긍정 프롬프트에서 인식되는 작가 표기를 찾지 못했습니다.\n(맨 태그/괄호 가중치 형태는 📝 작가 목록 관리에 등록된 이름만 인식합니다.)');
        return;
    }
    posEl.value = text;
    if (typeof appStateManager !== 'undefined') appStateManager.debounceSave();
    alert(`${count}개의 작가 표기를 "${ARTIST_TAG_FORMATS[sel.value].label}" 형식으로 통일했습니다.`);
}
window.convertArtistTagsBulk = convertArtistTagsBulk;

/** 🆕 기능 추가: NAI(NovelAI) 프롬프트 강조 문법 → ComfyUI/A1111 숫자 가중치 문법 변환.
 *  NAI는 {단어}(×1.05)/[단어](×1/1.05≈0.952)를 중첩해서 강조를 표현하고(예: {{red hair}} = ×1.1025),
 *  최신 NAI는 {단어:1.3}처럼 콜론 숫자로 직접 가중치를 주는 것도 지원한다. ComfyUI의 CLIPTextEncode는
 *  이 문법을 모르기 때문에(중괄호/대괄호를 그냥 글자로 봄), NAI에서 긁어온 프롬프트를 그대로 붙여넣으면
 *  가중치가 하나도 안 먹는다 — 이 함수가 그 괄호 구간을 ComfyUI가 이해하는 (단어:N.NN) 형식으로 바꿔준다.
 *  중첩은 재귀로 처리(누적 배율), {단어:1.3}처럼 콜론 숫자가 이미 있는 단순 구간은 그 값을 그대로 사용.
 *  이미 (단어:weight) 형식인 구간이나 괄호가 전혀 없는 평문은 건드리지 않는다. */
function convertNaiWeightSyntaxToComfy(text) {
    if (!text) return text;
    const UP = 1.05, DOWN = 1 / 1.05;
    let i = 0;
    const n = text.length;

    function parseLevel(mult) {
        let out = '';
        let buf = '';
        const flush = () => {
            if (!buf) return;
            out += (Math.abs(mult - 1) < 0.001) ? buf : `(${buf}:${mult.toFixed(2)})`;
            buf = '';
        };
        while (i < n) {
            const ch = text[i];
            if (ch === '}' || ch === ']') break; // 이 레벨을 연 괄호의 짝 — 호출자가 소비하도록 돌아감
            if (ch === '{' || ch === '[') {
                const isUp = ch === '{';
                const closeCh = isUp ? '}' : ']';
                let depth = 1, j = i + 1;
                while (j < n && depth > 0) {
                    if (text[j] === ch) depth++;
                    else if (text[j] === closeCh) depth--;
                    if (depth > 0) j++;
                }
                const inner = (j < n) ? text.slice(i + 1, j) : null;
                // ⚠️ 이 프로그램은 {선택1|선택2|선택3} 문법을 "프롬프트 랜덤화"(매번 그중 하나를 랜덤
                // 선택)로 따로 쓰고 있어서, "|"가 들어있는 중괄호는 NAI 강조가 아니라 그 랜덤화
                // 문법일 가능성이 높다 — 건드리면 그 기능이 깨지므로 원문 그대로 보존(재귀 안 함).
                if (isUp && inner !== null && inner.includes('|')) {
                    buf += text.slice(i, j + 1);
                    i = j + 1;
                    continue;
                }
                const explicit = inner && inner.match(/^([^{}\[\]]+):(-?\d+(?:\.\d+)?)$/);
                if (explicit) {
                    flush();
                    out += `(${explicit[1].trim()}:${parseFloat(explicit[2]).toFixed(2)})`;
                    i = j + 1;
                    continue;
                }
                flush();
                i++; // 여는 괄호 소비
                out += parseLevel(mult * (isUp ? UP : DOWN));
                if (i < n && (text[i] === '}' || text[i] === ']')) i++; // 닫는 괄호 소비
                continue;
            }
            buf += ch;
            i++;
        }
        flush();
        return out;
    }

    return parseLevel(1);
}
window.convertNaiWeightSyntaxToComfy = convertNaiWeightSyntaxToComfy;

/** 조각 편집 모달의 "NAI→콤피 변환" 버튼 — #edit-prompt-value 내용을 그 자리에서 바로 변환. */
function convertEditPromptNaiToComfy() {
    const el = document.getElementById('edit-prompt-value');
    if (!el) return;
    if (!/[{}[\]]/.test(el.value)) {
        alert('이 프롬프트에는 NAI 강조 문법({ }/[ ])이 없습니다 — 변환할 게 없어요.');
        return;
    }
    const before = el.value;
    el.value = convertNaiWeightSyntaxToComfy(el.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    console.log('[NAI→콤피 변환]', { before, after: el.value });
}
window.convertEditPromptNaiToComfy = convertEditPromptNaiToComfy;

/* ══════════════════════════════════════════════
   🆕 ⚙️ 환경설정 탭 — 지금까지 톱니바퀴를 눌러도 "⚙️ 환경 설정"이라는
   제목 하나만 있고 아무 내용도 없던 "유령 버튼" 문제를 여기서 고친다.
   localStorage 키 하나(am_app_settings_v1)에 JSON으로 모아서 관리 —
   새 설정을 추가할 땐 DEFAULTS에 필드만 늘리면 됨.
   ══════════════════════════════════════════════ */
const AppSettings = (function () {
    const KEY = 'am_app_settings_v1';
    const DEFAULTS = {
        nsfwWarningEnabled: true,  // 🔞 GPT/나노바나나 전송 전 성인용 키워드 경고 (generate.js가 읽음)
        defaultTagForm: 'count',  // 🔤 자동완성 표기 기본값 (korean_autocomplete.js가 읽음)
        skipImageVerification: false, // 🖼 생성 내역 — PNG 검증 건너뛰고 기록된 파일명을 그냥 믿고 보여줌
    };
    let cache = null;
    function load() {
        if (cache) return cache;
        try { cache = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}')); }
        catch (e) { cache = Object.assign({}, DEFAULTS); }
        return cache;
    }
    function save() { localStorage.setItem(KEY, JSON.stringify(cache)); }
    return {
        get(key) { return load()[key]; },
        set(key, value) {
            load();
            cache[key] = value;
            save();
            if (key === 'defaultTagForm' && typeof window.setDefaultTagForm === 'function') {
                window.setDefaultTagForm(value); // korean_autocomplete.js에 즉시 반영(새로고침 불필요)
            }
        },
        DEFAULTS
    };
})();
window.AppSettings = AppSettings;

/** #tab-settings 안쪽을 실제 설정 UI로 채운다. 무거운 작업(fetch 등)이 없어서 탭을 열 때까지
 *  안 기다리고 페이지 로드 시 바로 그려둠(아래 DOMContentLoaded). */
function renderSettingsTab() {
    const root = document.getElementById('tab-settings');
    if (!root) return;
    const s = AppSettings;

    root.innerHTML = `
        <h2>⚙️ 환경 설정</h2>
        <div style="max-width:640px; display:flex; flex-direction:column; gap:24px; margin-top:10px;">

            <div class="form-group" style="margin:0;">
                <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-weight:normal;">
                    <input type="checkbox" id="settings-nsfw-warning">
                    🔞 GPT / 🍌 나노바나나 생성 전, 성인용 키워드 포함 시 경고
                </label>
                <p style="color:#999; font-size:0.85em; margin:6px 0 0 26px;">
                    OpenAI·Google 쪽 API는 성인용 콘텐츠를 서버에서 거부하거나 계정에 불이익을 줄 수 있어서,
                    프롬프트에 🔞 성인용으로 분류되는 태그가 있으면 전송 직전에 확인창을 한 번 띄웁니다.
                    로컬 ComfyUI(NAI 포함) 생성에는 적용되지 않습니다.
                </p>
            </div>

            <div class="form-group" style="margin:0;">
                <label>🔤 태그 자동완성 — 표기가 애매할 때 기본값</label>
                <select id="settings-default-tag-form" style="max-width:280px; display:block; margin-top:4px;">
                    <option value="count">사용횟수가 더 많은 쪽 (기본)</option>
                    <option value="space">공백 표기 우선 (gray hair)</option>
                    <option value="underscore">밑줄 표기 우선 (gray_hair)</option>
                </select>
                <p style="color:#999; font-size:0.85em; margin:6px 0 0 0;">
                    자동완성이 "gray hair"/"gray_hair"처럼 표기만 다른 같은 태그를 하나로 합칠 때,
                    사용횟수·뜻 길이·방금 입력한 글자로도 못 정하면 이 설정을 따릅니다.
                </p>
            </div>

            <div class="form-group" style="margin:0;">
                <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-weight:normal;">
                    <input type="checkbox" id="settings-skip-image-verification">
                    🖼 조각 "생성 내역" — PNG 검증 건너뛰고 빠르게 보기
                </label>
                <p style="color:#999; font-size:0.85em; margin:6px 0 0 26px;">
                    기본은 켜져 있지 않습니다(= 검증함). 조각 편집창의 "🖼 생성 내역"을 열 때마다 기록된
                    파일이 지금도 그 조각으로 만든 그 파일이 맞는지 확인하는데, 출력 폴더를 거의 안 정리하는
                    편이면 이 확인이 불필요한 지연일 수 있어서 끌 수 있게 했습니다. 켜면(건너뛰면) 기록된
                    파일명을 그냥 믿고 보여주기 때문에, 그 사이 파일이 지워졌거나 같은 이름의 다른 파일로
                    바뀌었어도 걸러지지 않습니다.
                </p>
            </div>

            <div class="form-group" style="margin:0;">
                <label>🔑 외부 API 키 상태</label>
                <div id="settings-api-key-status" style="font-size:0.88em; color:#ccc; display:flex; flex-direction:column; gap:5px; margin-top:6px;"></div>
                <p style="color:#999; font-size:0.85em; margin:6px 0 0 0;">
                    키 입력 자체는 생성 탭의 아키텍처 드롭다운 아래 칸에서 하고, 여기서는 지금 저장된
                    상태만 한눈에 확인하고 필요하면 지울 수 있습니다.
                </p>
            </div>

            <div class="form-group" style="margin:0;">
                <label>⌨️ 단축키 / 📖 기능 도움말</label>
                <div style="display:flex; gap:8px; margin-top:6px;">
                    <button type="button" class="btn-secondary" onclick="if (typeof openShortcutHelpModal === 'function') openShortcutHelpModal();">⌨️ 단축키 목록 / 변경</button>
                    <button type="button" class="btn-secondary" onclick="if (typeof openFeatureHelpModal === 'function') openFeatureHelpModal();">📖 기능 도움말 모아보기</button>
                </div>
                <p style="color:#999; font-size:0.85em; margin:6px 0 0 0;">
                    자주 쓰는 설명 화면 바로가기 — 원래 있던 그 모달들을 그대로 엽니다.
                </p>
            </div>

        </div>
    `;

    const nsfwEl = document.getElementById('settings-nsfw-warning');
    if (nsfwEl) {
        nsfwEl.checked = s.get('nsfwWarningEnabled') !== false;
        nsfwEl.addEventListener('change', (e) => s.set('nsfwWarningEnabled', e.target.checked));
    }

    const tagFormEl = document.getElementById('settings-default-tag-form');
    if (tagFormEl) {
        tagFormEl.value = s.get('defaultTagForm') || 'count';
        tagFormEl.addEventListener('change', (e) => s.set('defaultTagForm', e.target.value));
    }

    const skipVerifyEl = document.getElementById('settings-skip-image-verification');
    if (skipVerifyEl) {
        skipVerifyEl.checked = s.get('skipImageVerification') === true;
        skipVerifyEl.addEventListener('change', (e) => s.set('skipImageVerification', e.target.checked));
    }

    const statusEl = document.getElementById('settings-api-key-status');
    if (statusEl) {
        const keys = [
            { label: '🍌 나노바나나(Google)', storageKey: 'nanoBananaApiKey' },
            { label: '🤖 GPT(OpenAI)', storageKey: 'gptApiKey' },
        ];
        statusEl.innerHTML = keys.map(k => {
            const has = !!localStorage.getItem(k.storageKey);
            return `<div>${has ? '✅' : '⬜'} ${k.label} — ${has ? '저장됨' : '미설정'}` +
                (has ? ` <button type="button" class="btn-secondary" style="margin-left:6px; padding:0 8px; font-size:0.85em;" ` +
                    `onclick="localStorage.removeItem('${k.storageKey}'); if (typeof renderSettingsTab === 'function') renderSettingsTab();">지우기</button>` : '') +
                `</div>`;
        }).join('');
    }
}
window.renderSettingsTab = renderSettingsTab;

document.addEventListener('DOMContentLoaded', () => {
    try { renderSettingsTab(); } catch (e) { console.error('[설정 탭 렌더링 실패]', e); }
});

/** #selected-loras(공통 로라 목록) 바로 아래에 "🎨 랜덤 작가 섞기" / "📝 작가 목록 관리" 버튼을 한 번만 끼워넣는다.
 *  index.html을 직접 안 건드려도 되도록, 🎲 랜덤 프리셋 버튼과 같은 방식(JS로 자동 삽입)을 사용. */
function ensureRandomArtistUI() {
    if (document.getElementById('random-artist-mix-btn')) return;
    const loraContainer = document.getElementById('selected-loras');
    if (!loraContainer || !loraContainer.parentElement) return;

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex; gap:6px; margin-top:6px;';

    const mixBtn = document.createElement('button');
    mixBtn.type = 'button';
    mixBtn.id = 'random-artist-mix-btn';
    mixBtn.className = 'btn-secondary';
    mixBtn.style.cssText = 'border-color:#CE93D8; color:#CE93D8;';
    mixBtn.textContent = '🎨 랜덤 작가 섞기';
    mixBtn.onclick = addRandomArtists;

    const manageBtn = document.createElement('button');
    manageBtn.type = 'button';
    manageBtn.className = 'btn-secondary';
    manageBtn.textContent = '📝 작가 목록 관리';
    manageBtn.onclick = openRandomArtistManageModal;

    const formatSel = document.createElement('select');
    formatSel.id = 'artist-format-select';
    formatSel.style.cssText = 'background:#222; border:1px solid #555; color:#fff; border-radius:4px; padding:0 6px;';
    formatSel.innerHTML = Object.entries(ARTIST_TAG_FORMATS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');

    const convertBtn = document.createElement('button');
    convertBtn.type = 'button';
    convertBtn.className = 'btn-secondary';
    convertBtn.style.cssText = 'border-color:#80CBC4; color:#80CBC4;';
    convertBtn.textContent = '🔄 일괄 변환';
    convertBtn.onclick = convertArtistTagsBulk;

    wrap.appendChild(mixBtn);
    wrap.appendChild(manageBtn);
    wrap.appendChild(formatSel);
    wrap.appendChild(convertBtn);
    loraContainer.insertAdjacentElement('afterend', wrap);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureRandomArtistUI);
} else {
    ensureRandomArtistUI();
}

function toggleRandomLoraExclude(loraValue, checked) {
    const set = getRandomLoraExcludeSet();
    if (checked) set.add(loraValue); else set.delete(loraValue);
    saveRandomLoraExcludeSet(set);
}
window.toggleRandomLoraExclude = toggleRandomLoraExclude;

function ensureLabelNumberedButton() {
    ensureToolsMenu();
    addToolsMenuItem(
        'btn-label-numbered', '🏷', '번호에 설명 붙이기',
        '1,2,3...처럼 번호 매겨진 이미지들을 순서대로 라벨(표정 이름 등)과 매칭해서 "접두어+라벨" 이름으로 복사',
        openLabelNumberedModal
    );
}

function openLabelNumberedModal() {
    if (!document.getElementById('label-numbered-modal')) {
        const modal = document.createElement('div');
        modal.id = 'label-numbered-modal';
        modal.className = 'modal-overlay';
        modal.style.cssText = 'display:none;';
        modal.onclick = (e) => { if (e.target === modal) { flushLabelModalState(); modal.style.display = 'none'; } };
        document.body.appendChild(modal);
    }
    const modal = document.getElementById('label-numbered-modal');
    modal.innerHTML = `
        <div class="modal-content" onclick="event.stopPropagation()" style="width:min(90vw, 520px);">
            <div class="modal-header">
                <h3 style="margin:0; color:#4CAF50;">🏷 번호에 설명 붙이기</h3>
                <span class="close-btn" style="position:static; font-size:1.5em; color:#ff5555;" onclick="flushLabelModalState(); document.getElementById('label-numbered-modal').style.display='none';">&times;</span>
            </div>
            <div class="modal-body" style="display:flex; flex-direction:column; gap:10px;">
                <p style="font-size:0.82em; color:#aaa; margin:0;">
                    번호 매겨진 이미지(1, 2, 3...)를 순서대로 아래 라벨 목록과 매칭해서, 폴더 안에 <code>labeled_images</code> 폴더를 만들고 그 안에 복사해요.
                </p>
                <div>
                    <label style="font-size:0.85em; color:#ccc;">번호 매겨진 이미지가 있는 폴더</label>
                    <input type="text" id="label-src-folder" placeholder="예: C:\\Users\\yohan\\Desktop\\새 폴더 (2)\\다르다르\\다르감정"
                        style="width:100%; box-sizing:border-box; padding:6px; margin-top:4px; background:#222; border:1px solid #555; color:#fff; border-radius:4px;">
                </div>
                <div>
                    <label style="font-size:0.85em; color:#ccc;">접두어 (선택 — 비워두면 라벨 이름만 사용)</label>
                    <input type="text" id="label-prefix" placeholder="예: 고해 (비우면 접두어 없이 저장)"
                        style="width:100%; box-sizing:border-box; padding:6px; margin-top:4px; background:#222; border:1px solid #555; color:#fff; border-radius:4px;">
                </div>

                <div style="border:1px solid #333; border-radius:6px; padding:8px; background:#1a1a1a;">
                    <div style="display:flex; align-items:center; justify-content:flex-end; margin-bottom:6px;">
                        <div style="display:flex; gap:4px;">
                            <button type="button" title="새 프리셋 추가" style="width:22px; height:22px; line-height:1; padding:0; font-size:0.85em; background:#2a2a2a; border:1px solid #4CAF50; color:#4CAF50; border-radius:4px; cursor:pointer;" onclick="addLabelPresetSlot()">➕</button>
                            <button type="button" title="선택된 프리셋 이름 수정" style="width:22px; height:22px; line-height:1; padding:0; font-size:0.8em; background:#2a2a2a; border:1px solid #888; color:#ccc; border-radius:4px; cursor:pointer;" onclick="renameActiveLabelPreset()">✏️</button>
                        </div>
                    </div>
                    <div id="label-preset-chips" style="display:flex; flex-wrap:wrap; gap:6px;"></div>
                </div>

                <div>
                    <label style="font-size:0.85em; color:#ccc;">라벨 목록 (한 줄에 하나씩 — 또는 "미소", "환한 미소", ... 처럼 따옴표+콤마 붙여넣기도 가능)</label>
                    <textarea id="label-list" rows="8" placeholder="예 1) 한 줄에 하나씩:&#10;미소&#10;놀람&#10;분노&#10;&#10;예 2) 따옴표 목록 그대로 붙여넣기:&#10;&quot;미소&quot;, &quot;환한 미소&quot;, &quot;불쾌&quot;, &quot;부끄&quot;"
                        style="width:100%; box-sizing:border-box; padding:6px; margin-top:4px; background:#222; border:1px solid #555; color:#fff; border-radius:4px; font-family:inherit;"></textarea>
                </div>

                <div style="border:1px solid #333; border-radius:6px; padding:8px; background:#1a1a1a;">
                    <label style="display:flex; align-items:center; gap:8px; font-size:0.85em; color:#ccc; cursor:pointer;">
                        <input type="checkbox" id="label-convert-webp" checked style="width:16px; height:16px;" onchange="document.getElementById('label-webp-quality-row').style.display = this.checked ? 'flex' : 'none';">
                        🖼️ 라벨 붙이면서 바로 WEBP로 변환해서 저장 (원본은 그대로 두고, 결과물만 webp)
                    </label>
                    <div id="label-webp-quality-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                        <label style="font-size:0.8em; color:#aaa; white-space:nowrap;">품질</label>
                        <input type="range" id="label-webp-quality" min="1" max="100" value="100" style="flex:1;"
                            oninput="document.getElementById('label-webp-quality-str').innerText=this.value">
                        <span id="label-webp-quality-str" style="font-size:0.8em; color:#aaa; width:2.5em; text-align:right;">100</span>
                    </div>
                </div>

                <div style="border:1px solid #333; border-radius:6px; padding:8px; background:#1a1a1a;">
                    <label style="display:flex; align-items:center; gap:8px; font-size:0.85em; color:#ccc; cursor:pointer;">
                        <input type="checkbox" id="label-duplicate-enable" style="width:16px; height:16px;" onchange="document.getElementById('label-duplicate-folder-row').style.display = this.checked ? 'block' : 'none';">
                        📑 복제 저장 (같은 결과물을 다른 폴더에도 하나 더 저장)
                    </label>
                    <div id="label-duplicate-folder-row" style="display:none; margin-top:6px;">
                        <input type="text" id="label-duplicate-folder" placeholder="예: D:\\backup\\labeled  또는  D:\\backup\\tes(아하)(감정)"
                            style="width:100%; box-sizing:border-box; padding:6px; background:#222; border:1px solid #555; color:#fff; border-radius:4px;">
                        <label style="display:flex; align-items:center; gap:8px; font-size:0.8em; color:#aaa; cursor:pointer; margin-top:6px;">
                            <input type="checkbox" id="label-duplicate-structured" style="width:14px; height:14px;" checked>
                            괄호 문법으로 폴더 자동 생성 — 두 가지 방식 지원:<br>
                            ① 이 칸 자체에 <code style="color:#4CAF50;">경로(이름)(감정/행동/특수)</code>로 쓰면 배치 전체가 그 폴더 구조를 공유하고, 파일명은 각자의 원래 라벨을 사용<br>
                            ② 라벨 목록의 각 줄에 <code style="color:#4CAF50;">경로(이름)(감정/행동/특수)</code>로 쓰면 줄마다 다른 폴더/경로 가능 (이 칸은 그때 기본값)
                            (이미 있는 폴더는 그대로 두고, 없는 폴더만 새로 만듦)
                        </label>
                    </div>
                </div>

                <button class="btn-primary" style="padding:10px;" onclick="executeLabelNumbered()">🏷 라벨 붙여서 복사</button>
                <div id="label-numbered-result" style="font-size:0.85em; color:#FF9800; white-space:pre-wrap;"></div>
            </div>
        </div>`;
    modal.style.display = 'flex';

    const srcInput = document.getElementById('label-src-folder');
    const prefixInput = document.getElementById('label-prefix');
    const listInput = document.getElementById('label-list');
    const dupEnableInput = document.getElementById('label-duplicate-enable');
    const dupFolderInput = document.getElementById('label-duplicate-folder');
    const dupStructuredInput = document.getElementById('label-duplicate-structured');
    const savedSrc = localStorage.getItem('labelSrcFolder');
    const savedPrefix = localStorage.getItem('labelPrefix');
    const savedList = localStorage.getItem('labelList');
    const savedDupEnable = localStorage.getItem('labelDuplicateEnable') === '1';
    const savedDupFolder = localStorage.getItem('labelDuplicateFolder');
    const savedDupStructured = localStorage.getItem('labelDuplicateStructured');
    if (savedSrc) srcInput.value = savedSrc;
    if (savedPrefix !== null) prefixInput.value = savedPrefix;
    if (savedList) listInput.value = savedList;
    if (savedDupFolder) dupFolderInput.value = savedDupFolder;
    if (savedDupStructured !== null) dupStructuredInput.checked = savedDupStructured === '1';
    if (savedDupEnable) {
        dupEnableInput.checked = true;
        document.getElementById('label-duplicate-folder-row').style.display = 'block';
    }
    srcInput.addEventListener('input', () => localStorage.setItem('labelSrcFolder', srcInput.value));
    prefixInput.addEventListener('input', () => localStorage.setItem('labelPrefix', prefixInput.value));
    dupStructuredInput.addEventListener('change', () => localStorage.setItem('labelDuplicateStructured', dupStructuredInput.checked ? '1' : '0'));
    dupEnableInput.addEventListener('change', () => localStorage.setItem('labelDuplicateEnable', dupEnableInput.checked ? '1' : '0'));
    dupFolderInput.addEventListener('input', () => localStorage.setItem('labelDuplicateFolder', dupFolderInput.value));
    listInput.addEventListener('input', flushLabelModalState);
    listInput.addEventListener('paste', () => {
        // 붙여넣기로 통째로 새 내용을 넣는 경우, 이전에 선택돼 있던 프리셋을 조용히
        // 덮어쓰지 않도록 활성 프리셋 연결을 끊는다. (저장하려면 ➕로 새로 저장해야 함)
        activeLabelPresetId = null;
        setTimeout(() => { flushLabelModalState(); renderLabelPresetOptions(); }, 0);
    });

    renderLabelPresetOptions();
}

let activeLabelPresetId = null;

/**
 * 모달을 닫기 직전에 무조건 한 번 더 호출해서, 라벨란 원본 텍스트를 있는 그대로
 * localStorage(및 선택된 프리셋 슬롯)에 저장한다. 파싱/재조합 없이 textarea.value를 그대로 씀 —
 * 따옴표든 뭐든 원본 문자열을 절대 건드리지 않는다.
 */
function flushLabelModalState() {
    const listInput = document.getElementById('label-list');
    if (!listInput) return;
    localStorage.setItem('labelList', listInput.value);
    if (activeLabelPresetId) {
        const presets = getLabelPresets();
        const preset = presets.find(p => p.id === activeLabelPresetId);
        if (preset) { preset.text = listInput.value; saveLabelPresets(presets); }
    }
}

/* ──────────────────────────────────────────────
   📌 라벨 프리셋: 번호/이름 슬롯 버튼 클릭 한 번으로 즉시 불러오고,
   프롬프트 조각처럼 수정하면 바로 그 슬롯에 자동 저장되는 방식.
   버튼은 ➕(새 슬롯 추가) / ✏️(선택된 슬롯 이름 수정) 딱 두 개만 둔다.
   ────────────────────────────────────────────── */

function getLabelPresets() {
    try {
        const data = JSON.parse(localStorage.getItem('labelPresets') || '[]');
        return Array.isArray(data) ? data : [];
    } catch (e) { return []; }
}
function saveLabelPresets(presets) {
    localStorage.setItem('labelPresets', JSON.stringify(presets));
}

function renderLabelPresetOptions() {
    const container = document.getElementById('label-preset-chips');
    if (!container) return;
    const presets = getLabelPresets();

    if (presets.length === 0) {
        container.innerHTML = '<span style="color:#666; font-size:0.8em;">➕ 버튼으로 첫 프리셋을 추가해 보세요.</span>';
        return;
    }

    container.innerHTML = presets.map((p, i) => {
        const isActive = p.id === activeLabelPresetId;
        const label = p.name || String(i + 1);
        return `<button type="button" title="클릭하면 이 프리셋을 바로 불러옵니다"
            style="padding:4px 10px; font-size:0.78em; border-radius:12px; cursor:pointer;
                background:${isActive ? '#4CAF50' : '#2a2a2a'}; color:${isActive ? '#111' : '#ccc'};
                border:1px solid ${isActive ? '#4CAF50' : '#555'};"
            onclick="selectLabelPreset('${p.id}')">${escapeHtml(label)}</button>`;
    }).join('');
}

/** 슬롯 클릭: 그 프리셋을 활성화하고 내용을 라벨란에 즉시 채운다 (이후 수정은 자동으로 이 슬롯에 저장됨) */
function selectLabelPreset(id) {
    const presets = getLabelPresets();
    const preset = presets.find(p => p.id === id);
    if (!preset) return;
    activeLabelPresetId = id;
    const listInput = document.getElementById('label-list');
    listInput.value = preset.text || '';
    localStorage.setItem('labelList', listInput.value);
    renderLabelPresetOptions();
}

/** ➕ 지금 라벨란 내용으로 새 프리셋 슬롯을 만들고 바로 활성화한다 */
function addLabelPresetSlot() {
    const presets = getLabelPresets();
    const listInput = document.getElementById('label-list');
    const defaultName = String(presets.length + 1);
    const name = prompt('새 프리셋 이름 (비워두면 번호로 저장):', defaultName);
    if (name === null) return;

    const preset = { id: `preset_${Date.now()}`, name: name.trim() || defaultName, text: listInput.value };
    presets.push(preset);
    saveLabelPresets(presets);
    activeLabelPresetId = preset.id;
    renderLabelPresetOptions();
}

/** ✏️ 현재 선택된(활성화된) 프리셋 슬롯의 이름만 수정한다 */
function renameActiveLabelPreset() {
    if (!activeLabelPresetId) return alert('먼저 이름을 바꿀 프리셋을 클릭해서 선택해 주세요.');
    const presets = getLabelPresets();
    const preset = presets.find(p => p.id === activeLabelPresetId);
    if (!preset) return;
    const newName = prompt('새 이름:', preset.name);
    if (newName === null || !newName.trim()) return;
    preset.name = newName.trim();
    saveLabelPresets(presets);
    renderLabelPresetOptions();
}

/** 파일 이름에 쓸 수 없는 문자(윈도우 기준: \ / : * ? " < > | 및 제어문자)를 제거 */
function sanitizeForFilename(s) {
    return s.replace(/[\\/:*?"<>|\x00-\x1F]/g, '').trim();
}

/**
 * 라벨 목록 텍스트를 라벨 배열로 파싱한다.
 * "미소", "환한 미소", ... 처럼 따옴표로 감싼 목록을 그대로 붙여넣으면
 * 따옴표 쌍 단위로 추출한다 (콤마/줄바꿈/괄호가 섞여 있어도 안전).
 * 따옴표 개수가 안 맞아서 한 번에 여러 줄이 통째로 잡히는 경우에도,
 * 잡힌 덩어리를 다시 줄 단위로 쪼개서 개별 라벨로 복구한다.
 * 따옴표가 하나도 없으면 예전처럼 줄바꿈 기준으로 나눈다.
 */
function parseLabelListText(text) {
    if (/["']/.test(text)) {
        const matches = [...text.matchAll(/"([^"]*)"|'([^']*)'/g)];
        const labels = matches
            .map(m => (m[1] !== undefined ? m[1] : m[2]))
            .flatMap(chunk => chunk.split(/\r?\n/)) // 따옴표 짝이 안 맞아 여러 줄이 한 덩어리로 잡혔어도 줄 단위로 복구
            .map(s => sanitizeForFilename(s))
            .filter(s => s.length > 0);
        if (labels.length > 0) return labels;
    }
    return text.split('\n').map(s => sanitizeForFilename(s)).filter(s => s.length > 0);
}

/** parseLabelListText와 같은 구조지만 sanitizeForFilename을 적용하지 않는 "원본 그대로" 버전.
 *  괄호 문법에 Windows 경로(예: C:\Users\...)를 직접 적을 때, 파일명 정리 규칙이 백슬래시(\)와
 *  콜론(:)을 지워버려서 경로가 깨지는 걸 막기 위해 복제 구조 파싱 전용으로 따로 둔다. */
function parseLabelListTextRaw(text) {
    if (/["']/.test(text)) {
        const matches = [...text.matchAll(/"([^"]*)"|'([^']*)'/g)];
        const labels = matches
            .map(m => (m[1] !== undefined ? m[1] : m[2]))
            .flatMap(chunk => chunk.split(/\r?\n/))
            .map(s => s.trim())
            .filter(s => s.length > 0);
        if (labels.length > 0) return labels;
    }
    return text.split('\n').map(s => s.trim()).filter(s => s.length > 0);
}

/** 라벨 한 줄에서 "경로(이름)(이름+감정/행동/특수)" 형식을 통째로 파싱한다.
 *  예: C:\Users\yohan\Desktop\tes(아하)(감정) → 앞부분 전체가 저장 경로, 괄호 2개가 폴더/파일명 구조.
 *  - 첫 번째 "(" 앞의 텍스트 = 이 라벨 전용 저장 경로 (있으면 전역 "복제 폴더" 입력값보다 우선함)
 *  - 괄호 안 첫 번째 값 = 이름 → 1단 하위 폴더
 *  - 괄호 안 두 번째 값(있으면) = "이름+감정/행동/특수" → 2단 하위 폴더이자 파일명
 *    (이름을 안 적었으면 자동으로 첫 번째 값을 앞에 붙여줌: (사과)(감정) → (사과)(사과감정)으로 취급.
 *     이미 이름이 들어있으면 중복으로 안 붙임)
 *  - 괄호 뒤에 남는 텍스트가 있으면 파일명 뒤에 덧붙임
 *  🆕 반드시 괄호 2개가 붙어서(사이 공백 없이) 와야만 이 문법으로 인식한다. 괄호 1개짜리는 그냥 일반 경로로
 *     취급한다 — 그래야 윈도우가 자동으로 만드는 "새 폴더 (2)" 같은 흔한 이름이 오작동하지 않는다.
 *  - 이 조건에 안 맞는 라벨은 폴더 구조 없이(subPath='') 라벨 그대로를 파일명으로 사용 (기존 방식과 동일) */
function parseStructuredDuplicateLabel(rawLabel) {
    const m = rawLabel.match(/^(.*?)\(([^)]*)\)\(([^)]*)\)\s*(.*)$/);
    if (!m) {
        return { baseOverride: '', subPath: '', fileName: sanitizeForFilename(rawLabel) };
    }
    const baseOverride = m[1].trim();
    const g1 = (m[2] || '').trim();
    const g2 = (m[3] || '').trim();
    const trailing = sanitizeForFilename(m[4] || '').trim();
    if (!g1 && !g2) {
        return { baseOverride: '', subPath: '', fileName: sanitizeForFilename(rawLabel) };
    }

    // 🆕 두 번째 괄호에 이름을 안 적었으면 자동으로 앞에 붙여줌: (사과)(감정) → (사과)(사과감정)
    // 이미 이름이 포함돼 있으면(예: (사과)(사과감정)) 중복으로 안 붙임
    let g2Full = g2;
    if (g1 && g2 && !g2.startsWith(g1)) {
        g2Full = g1 + g2;
    }
    const groupsFull = [g1, g2Full].filter(Boolean);
    const folderPartsFull = groupsFull.map(p => sanitizeForFilename(p));

    // 두 번째 괄호가 있으면(자동 보정된 값 포함) 그걸 그대로 파일명으로 씀.
    // 한 개뿐이면 첫 번째(이름)를 파일명으로 씀. 괄호 뒤 여분 텍스트가 있으면 뒤에 덧붙임.
    const base = groupsFull.length >= 2 ? groupsFull[1] : groupsFull[0];
    const fileName = sanitizeForFilename(`${base}${trailing}`) || base;

    return { baseOverride, subPath: folderPartsFull.join('/'), fileName };
}

/** "복제 폴더" 입력칸 자체에 괄호 문법을 통째로 썼을 때 파싱한다 (라벨마다 다른 경로가 아니라
 *  배치 전체가 같은 폴더 구조를 공유하는 경우). 예: C:\...\tes(아하)(감정)
 *  → baseOverride: "C:\...\tes", subPath: "아하/아하감정" 하나만 계산해서 모든 파일에 재사용.
 *  이때 파일명은 (구조 정보 안에 이미 다 들어있어 파일마다 구분이 안 되므로) 각 파일의 원래 라벨을 그대로 씀.
 *  🆕 위와 동일하게, 괄호 2개가 붙어서 와야만 인식한다 — "새 폴더 (2)" 같은 흔한 폴더명과 안 겹치게.
 *  이 조건에 안 맞으면(괄호가 없거나 1개뿐이면) null을 반환 — 이 경우 순수 경로로 취급한다. */
function parseStructuredDuplicateFolderGlobal(rawFolderValue) {
    const m = rawFolderValue.match(/^(.*?)\(([^)]*)\)\(([^)]*)\)\s*(.*)$/);
    if (!m) return null;
    const g1 = (m[2] || '').trim();
    const g2 = (m[3] || '').trim();
    if (!g1 && !g2) return null;
    const baseOverride = m[1].trim();
    let g2Full = g2;
    if (g1 && g2 && !g2.startsWith(g1)) g2Full = g1 + g2;
    const groupsFull = [g1, g2Full].filter(Boolean);
    const folderParts = groupsFull.map(p => sanitizeForFilename(p));
    return { baseOverride, subPath: folderParts.join('/') };
}

async function executeLabelNumbered() {
    const folder = document.getElementById('label-src-folder').value.trim();
    const prefix = document.getElementById('label-prefix').value; // 공백/빈값 자체도 의도된 접두어일 수 있어 trim 안 함
    const labels = parseLabelListText(document.getElementById('label-list').value);
    const convertWebp = document.getElementById('label-convert-webp').checked;
    const webpQuality = parseInt(document.getElementById('label-webp-quality').value, 10) || 100;
    const duplicateEnabled = document.getElementById('label-duplicate-enable').checked;
    const duplicateFolderRaw = document.getElementById('label-duplicate-folder').value; // 경로 문자 보존 위해 trim만, sanitize 안 함
    const duplicateFolder = duplicateFolderRaw.trim();
    const duplicateStructured = document.getElementById('label-duplicate-structured').checked;
    const resultEl = document.getElementById('label-numbered-result');

    if (!folder) return alert('폴더 경로를 입력해 주세요.');
    if (labels.length === 0) return alert('라벨 목록을 한 줄에 하나씩 입력해 주세요.');

    // 괄호 문법은 두 군데 중 하나에 쓸 수 있다:
    //  ① "복제 폴더" 칸 자체에 통째로 쓴 경우 → 배치 전체가 같은 폴더 구조를 공유, 파일명은 각자의 원래 라벨 사용
    //  ② 라벨 목록 각 줄에 쓴 경우(기존 방식) → 파일마다 다른 경로/구조 가능
    const globalStructured = (duplicateEnabled && duplicateStructured) ? parseStructuredDuplicateFolderGlobal(duplicateFolderRaw) : null;
    let duplicateTargets = null;
    if (duplicateEnabled && duplicateStructured) {
        if (globalStructured) {
            duplicateTargets = labels.map(lbl => ({
                baseOverride: globalStructured.baseOverride,
                subPath: globalStructured.subPath,
                fileName: sanitizeForFilename(String(lbl))
            }));
        } else {
            // sanitize 안 된 원본 텍스트로 다시 파싱해야 경로의 \, : 이 안 깨짐
            duplicateTargets = parseLabelListTextRaw(document.getElementById('label-list').value).map(parseStructuredDuplicateLabel);
        }
    }

    // 복제 폴더 입력칸은, 경로를 직접 안 가진 항목들을 위한 "기본값"일 뿐이다.
    // ① 방식(전역 구조)이거나, ② 방식에서 모든 줄이 자기 경로를 갖고 있으면 기본값 없이도 됨.
    const hasLineWithoutOwnPath = !duplicateTargets || duplicateTargets.some(t => !t.baseOverride);
    if (duplicateEnabled && !duplicateFolder && hasLineWithoutOwnPath) {
        return alert(duplicateStructured
            ? '복제 폴더 칸에 경로(괄호 포함 또는 순수 경로)를 입력하거나, 라벨 목록의 모든 줄에 "경로(이름)(이름+설명)" 형태로 직접 적어주세요.'
            : '복제 저장을 켰으면 복제할 폴더 경로도 입력해 주세요.');
    }

    resultEl.textContent = '처리 중...';
    try {
        const res = await API.post('/assetmanager/api/label_numbered_files', {
            folder, prefix, labels, convertWebp, webpQuality,
            duplicateFolder: duplicateEnabled ? duplicateFolder : null,
            duplicateTargets // null이면 기존 방식(라벨 그대로, 폴더 구조 없음)
        });
        if (!res.ok) { resultEl.textContent = `❌ ${res.error}`; return; }

        let msg = `✅ ${res.processed}개 파일 처리 완료${convertWebp ? ' (WEBP 변환됨)' : ''} → ${res.outputFolder}`;
        if (duplicateEnabled) {
            msg += res.duplicateOutputFolder
                ? `\n📑 복제 저장 완료 → ${res.duplicateOutputFolder}${duplicateStructured ? (globalStructured ? ' (복제 폴더 칸의 괄호 문법 적용됨 — 파일명은 원래 라벨 사용)' : ' (라벨별 괄호 문법으로 경로/폴더 자동 처리됨)') : ''}`
                : `\n⚠️ 복제 저장을 요청했지만 서버 응답에 복제 결과가 없습니다. (서버가 duplicateFolder/duplicateTargets 파라미터를 아직 지원하지 않을 수 있어요 — 이 경우 원본 위치에만 저장됐을 가능성이 높습니다)`;
        }
        if (res.skipped && res.skipped.length > 0) {
            msg += `\n⚠️ 라벨보다 파일이 많아서 제외됨(${res.skipped.length}개): ${res.skipped.slice(0, 10).join(', ')}${res.skipped.length > 10 ? ' 외...' : ''}`;
        }
        // 🆕 라벨 범위 안에 있는데 파일 자체가 없던 "빈 번호"를 눈에 띄게 알림으로 띄운다.
        if (res.missingNumbers && res.missingNumbers.length > 0) {
            const list = res.missingNumbers.slice(0, 20).join(', ');
            const more = res.missingNumbers.length > 20 ? ` 외 ${res.missingNumbers.length - 20}개` : '';
            msg += `\n🚨 빈 번호 발견 (${res.missingNumbers.length}개): ${list}${more}번 파일이 없어서 해당 라벨은 아무 파일에도 안 붙었습니다.`;
            alert(`🚨 빈 번호가 있습니다!\n\n${list}${more}번 파일이 폴더에 없어서, 그 번호에 해당하는 라벨이 아무 파일에도 매칭되지 않았습니다.\n(다른 파일이 밀려서 매칭되지는 않으니 안심하되, 빠진 파일은 따로 확인해 주세요.)`);
        }
        resultEl.textContent = msg;

        // 🆕 처리에 성공한 원본(번호 매겨진) 파일들 정보를 기억해뒀다가, "🗑 원본 정리" 버튼에서 그대로 재사용한다.
        window._lastLabelNumberedRun = { folder, prefix, labels, skipped: res.skipped || [] };
        renderLabelNumberedCleanupButton();
    } catch (e) {
        resultEl.textContent = '❌ 서버 통신 오류가 발생했습니다. (/assetmanager/api/label_numbered_files 엔드포인트 확인 필요)';
    }
}

/** 🗑 결과 메시지 아래에 "처리된 원본 파일 정리" 버튼을 그린다 (처리 성공 시에만 호출됨). */
function renderLabelNumberedCleanupButton() {
    const resultEl = document.getElementById('label-numbered-result');
    if (!resultEl || !window._lastLabelNumberedRun) return;

    let btnRow = document.getElementById('label-numbered-cleanup-row');
    if (!btnRow) {
        btnRow = document.createElement('div');
        btnRow.id = 'label-numbered-cleanup-row';
        btnRow.style.cssText = 'margin-top:8px;';
        resultEl.insertAdjacentElement('afterend', btnRow);
    }
    btnRow.innerHTML = `
        <button style="padding:6px 12px; background:#3a1a1a; border:1px solid #e74c3c; color:#e74c3c; border-radius:6px; font-size:0.85em; cursor:pointer;"
            onclick="cleanupLabelNumberedSourceFiles()"
            title="방금 라벨을 붙인 번호 매겨진 원본 파일들(1.png, 2.png...)을 지웁니다. 라벨 붙인 결과물/복제본은 그대로 남습니다.">
            🗑 처리된 원본 파일 정리
        </button>`;
}

/** 🗑 방금 성공적으로 라벨을 붙인 "번호 매겨진 원본" 파일들을 서버에서 지운다.
 *  라벨 붙이기 결과물(outputFolder)이나 복제본(duplicateOutputFolder)은 건드리지 않는다 —
 *  오직 처리 대상이었던 원본 소스 폴더의 숫자 파일명(1.png, 2.png...)만 지운다. */
async function cleanupLabelNumberedSourceFiles() {
    const run = window._lastLabelNumberedRun;
    if (!run) return alert('정리할 대상이 없습니다. 먼저 "번호에 설명 붙이기"를 실행해 주세요.');

    if (!confirm(`"${run.folder}" 폴더의 번호 매겨진 원본 파일(${run.labels.length - run.skipped.length}개)을 삭제할까요?\n(라벨 붙인 결과물/복제본은 그대로 남습니다. 이 원본들은 다른 곳에 따로 저장돼 있다고 하셨죠?)`)) return;

    const resultEl = document.getElementById('label-numbered-result');
    try {
        const res = await API.post('/assetmanager/api/delete_numbered_files', {
            folder: run.folder,
            prefix: run.prefix,
            labels: run.labels,
            skipped: run.skipped // 처리 때 제외된 파일은 정리 대상에서도 제외
        });
        if (!res.ok) { alert(`❌ 정리 실패: ${res.error}`); return; }

        if (resultEl) resultEl.textContent += `\n🗑 원본 파일 ${res.deleted ?? '?'}개 정리 완료.`;
        const btnRow = document.getElementById('label-numbered-cleanup-row');
        if (btnRow) btnRow.remove();
        window._lastLabelNumberedRun = null;
    } catch (e) {
        alert('❌ 서버 통신 오류가 발생했습니다. (/assetmanager/api/delete_numbered_files 엔드포인트가 백엔드에 아직 없을 수 있습니다)');
    }
}

function openMissingFillModal() {
    if (!document.getElementById('missing-fill-modal')) {
        const modal = document.createElement('div');
        modal.id = 'missing-fill-modal';
        modal.className = 'modal-overlay';
        modal.style.cssText = 'display:none;';
        modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
        document.body.appendChild(modal);
    }

    const allCats = getAllCategories();
    const catOptions = allCats.map(c => {
        const work = libraryData.works.find(w => w.categories.includes(c));
        const label = `${work ? work.name + ' / ' : ''}${c.name} (${c.items.length}개)`;
        const selected = c.id === activeCategoryId ? 'selected' : '';
        return `<option value="${c.id}" ${selected}>${label}</option>`;
    }).join('');

    const modal = document.getElementById('missing-fill-modal');
    modal.innerHTML = `
        <div class="modal-content" onclick="event.stopPropagation()" style="width:min(90vw, 480px);">
            <div class="modal-header">
                <h3 style="margin:0; color:#4CAF50;">🕳 빈 번호 채우기</h3>
                <span class="close-btn" style="position:static; font-size:1.5em; color:#ff5555;" onclick="document.getElementById('missing-fill-modal').style.display='none';">&times;</span>
            </div>
            <div class="modal-body" style="display:flex; flex-direction:column; gap:10px;">
                <div>
                    <label style="font-size:0.85em; color:#ccc;">어느 그룹의 조각들로 채울까요?</label>
                    <select id="missing-fill-cat" style="width:100%; padding:6px; margin-top:4px; background:#222; border:1px solid #555; color:#fff; border-radius:4px;">
                        ${catOptions}
                    </select>
                </div>
                <div>
                    <label style="font-size:0.85em; color:#ccc;">검사할 출력 폴더 경로 (서버 기준 절대경로)</label>
                    <input type="text" id="missing-fill-folder" placeholder="예: C:\\Users\\yohan\\Desktop\\ffe"
                        style="width:100%; box-sizing:border-box; padding:6px; margin-top:4px; background:#222; border:1px solid #555; color:#fff; border-radius:4px;">
                </div>
                <button class="btn-secondary" onclick="scanMissingNumbers()">🔍 검사</button>
                <div id="missing-fill-result" style="font-size:0.85em; color:#FF9800; min-height:20px;"></div>
                <button class="btn-primary" id="missing-fill-execute-btn" style="padding:10px; display:none;" onclick="executeMissingFill()">📥 빠진 번호만큼 대기열에 추가</button>
            </div>
        </div>`;
    modal.style.display = 'flex';

    // 마지막으로 검사했던 폴더 경로를 기억해뒀다가 자동으로 채워줌
    const folderInput = document.getElementById('missing-fill-folder');
    const savedFolder = localStorage.getItem('missingFillFolder');
    if (savedFolder) folderInput.value = savedFolder;
    folderInput.addEventListener('input', () => {
        localStorage.setItem('missingFillFolder', folderInput.value);
    });
}

let lastMissingNumbers = null;

async function scanMissingNumbers() {
    const folder = document.getElementById('missing-fill-folder').value.trim();
    const resultEl = document.getElementById('missing-fill-result');
    const execBtn = document.getElementById('missing-fill-execute-btn');
    execBtn.style.display = 'none';
    lastMissingNumbers = null;

    if (!folder) { resultEl.textContent = '폴더 경로를 입력해 주세요.'; return; }
    resultEl.textContent = '검사 중...';

    try {
        const data = await API.get(`/assetmanager/api/missing_numbers?folder=${encodeURIComponent(folder)}`);
        if (!data.ok) {
            resultEl.textContent = `❌ ${data.error || '검사에 실패했습니다.'}`;
            return;
        }
        if (data.missing.length === 0) {
            resultEl.textContent = `✅ ${data.min}~${data.max}번 사이에 빠진 번호가 없습니다. (총 ${data.total_files}개 파일)`;
            return;
        }
        resultEl.textContent = `⚠️ 빠진 번호 ${data.missing.length}개: ${data.missing.join(', ')}`;
        lastMissingNumbers = data.missing;
        execBtn.style.display = 'block';
    } catch (e) {
        resultEl.textContent = '❌ 서버 통신 오류가 발생했습니다. (백엔드에 /assetmanager/api/missing_numbers 엔드포인트가 있는지 확인해 주세요)';
    }
}

function executeMissingFill() {
    if (!lastMissingNumbers || lastMissingNumbers.length === 0) return;
    const catId = document.getElementById('missing-fill-cat').value;
    const cat = getAllCategories().find(c => c.id === catId);
    if (!cat) return alert('그룹을 찾을 수 없습니다.');

    let added = 0, skipped = 0;
    lastMissingNumbers.forEach((num, i) => {
        const item = cat.items[num - 1];
        if (!item) { skipped++; return; }
        addJobToQueue({
            id: Date.now() + i,
            labels: { [cat.name]: item.name },
            fullPrompt: [item.prompt],
            sourceRefs: [{ catId: cat.id, itemId: item.id }],
            repeatCount: 1,
            ...(getItemLoraOverride(item).length > 0 ? { loraOverride: getItemLoraOverride(item) } : {}),
            ...(getItemSingleOverride(item, 'img2imgOverride') ? { img2imgOverride: getItemSingleOverride(item, 'img2imgOverride') } : {}),
            ...(getItemSingleOverride(item, 'controlnetOverride') ? { controlnetOverride: getItemSingleOverride(item, 'controlnetOverride') } : {}),
            ...(getItemSingleOverride(item, 'censorOverride') ? { censorOverride: getItemSingleOverride(item, 'censorOverride') } : {}),
            ...(getItemNegativeOverride(item).length > 0 ? { negativeOverride: getItemNegativeOverride(item).join(', ') } : {})
        });
        added++;
    });

    document.getElementById('missing-fill-modal').style.display = 'none';
    alert(`${added}개 조각을 대기열에 추가했습니다.${skipped > 0 ? ` (${skipped}개는 그룹에 해당 번호 조각이 없어 건너뜀)` : ''}`);
}

/* ──────────────────────────────────────────────
   ▼▶ 섹션 접기 (진짜로 공간까지 안 차지하게)
   "이미지 생성" 탭 안의 각 .form-section에 접기 버튼을 달아서,
   접으면 display:none으로 완전히 스크롤 공간에서 사라지게 한다.
   접힌 상태는 localStorage에 저장돼서 새로고침해도 유지됨.

   🆕 index.html 쪽에 따로 있던 네이티브 아코디언(고급 설정 전용 + 나머지 섹션용)은 삭제하고,
   이 파일의 접기 기능 하나로 통일함. 아이콘은 이모지 대신 ▼(펼침)/▶(접힘) 화살표만 사용.
   접힌 섹션 안의 입력요소(input/select/textarea/button)는 disabled 처리해서 안 보이는 동안
   내부적으로 계속 "작동"하지 않게 하고, 펼치면 원복함.
   ────────────────────────────────────────────── */

/** 섹션 제목에 포함된 키워드를 보고 알맞은 이모지를 골라준다 (위쪽 "접힌 항목 줄" 아이콘용) */
function getSectionCollapseIcon(label) {
    const rules = [
        [/공통 환경|Global Settings/i, '⚙️'],
        [/고급 설정|Advanced/i, '🛠️'],
        [/베이스 프롬프트|Base Prompts/i, '📝'],
        [/참조 이미지|IP-Adapter/i, '🖼️'],
        [/컨트롤넷|ControlNet/i, '🎛️'],
        [/이미지 투 이미지|Img2Img/i, '🔄'],
        [/인페인팅|Inpaint/i, '🖌️'],
        [/후처리|Post-Processing/i, '✨'],
        [/대기열|Queue/i, '📋'],
        [/체크포인트|Checkpoint/i, '💾'],
        [/로라|Lora/i, '🎨'],
        [/갤러리|Gallery/i, '🖼️'],
        [/샘플러|Sampler/i, '🎲'],
        [/해상도|Resolution|크기/i, '📐'],
    ];
    for (const [pattern, icon] of rules) {
        if (pattern.test(label)) return icon;
    }
    return '📁'; // 매칭되는 규칙이 없을 때의 기본 아이콘
}

/** 섹션의 body(헤더 제외 나머지) 안에 있는 입력요소들을 접었을 때 비활성화 / 펼 때 복원 */
function setSectionInteractiveDisabled(body, disabled) {
    const els = body.querySelectorAll('input, select, textarea, button');
    els.forEach(el => {
        if (disabled) {
            if (el.disabled) return; // 원래부터 disabled면 우리가 건드린 게 아니므로 표시 안 남김
            el.disabled = true;
            el.dataset.collapseDisabled = '1';
        } else {
            if (el.dataset.collapseDisabled === '1') {
                el.disabled = false;
                delete el.dataset.collapseDisabled;
            }
        }
    });
}

function ensureSectionCollapsers() {
    const sections = document.querySelectorAll('#tab-generate .form-section');

    // 여러 개 접힌 섹션들을 나란히 한 줄에 배치할 컨테이너 (없으면 만들어서 첫 섹션 앞에 둠)
    let collapsedRow = document.getElementById('collapsed-sections-row');
    if (!collapsedRow && sections.length > 0) {
        collapsedRow = document.createElement('div');
        collapsedRow.id = 'collapsed-sections-row';
        collapsedRow.style.cssText = 'display:none; flex-wrap:wrap; gap:6px; margin-bottom:10px;';
        sections[0].parentElement.insertBefore(collapsedRow, sections[0]);
    }

    const updateCollapsedRowVisibility = () => {
        if (collapsedRow) collapsedRow.style.display = collapsedRow.children.length > 0 ? 'flex' : 'none';
    };

    sections.forEach((section, idx) => {
        if (section.dataset.collapserReady) return; // 중복 방지
        const header = section.querySelector('h2, h3');
        if (!header) return;
        if (header.hasAttribute('onclick')) header.removeAttribute('onclick'); // 혹시 남아있는 구식 onclick 제거

        const label = header.textContent.trim();
        const key = 'sectionCollapsed_' + (label || idx);
        section.dataset.collapserReady = '1';

        // 헤더 뒤에 오는 나머지 내용물을 하나의 body로 감싼다 (접었다 펼 때 이 덩어리를 통째로 숨김)
        const body = document.createElement('div');
        let sibling = header.nextSibling;
        const toMove = [];
        while (sibling) {
            toMove.push(sibling);
            sibling = sibling.nextSibling;
        }
        toMove.forEach(node => body.appendChild(node));
        section.appendChild(body);

        // 완전히 접혔을 때: 제목 섹션(section) 자체를 숨기고, 위쪽 아이콘 줄에 작은 버튼 하나만 남긴다
        // (이 위쪽 아이콘 줄은 섹션별 이모지 유지 — 헤더 옆의 접기 버튼만 ▼로 바뀐 것)
        const iconBtn = document.createElement('button');
        iconBtn.type = 'button';
        iconBtn.textContent = getSectionCollapseIcon(label);
        iconBtn.style.cssText = 'padding:4px 8px; font-size:0.95em; background:#2a2a2a; border:1px solid #555; color:#ccc; border-radius:6px; cursor:pointer;';

        // 다른 함수(퀵점프 등)에서 접힌 섹션을 강제로 펼칠 수 있도록 참조를 심어둠
        section._forceExpand = () => { applyState(false); localStorage.setItem(key, '0'); };

        const applyState = (collapsed) => {
            setSectionInteractiveDisabled(body, collapsed);
            if (collapsed) {
                section.style.display = 'none';
                iconBtn.title = `${label} (펼치려면 클릭)`;
                if (collapsedRow && !collapsedRow.contains(iconBtn)) collapsedRow.appendChild(iconBtn);
            } else {
                section.style.display = '';
                section.style.padding = '';
                section.style.marginBottom = '';
                if (iconBtn.parentElement === collapsedRow) collapsedRow.removeChild(iconBtn);
            }
            updateCollapsedRowVisibility();
        };

        iconBtn.onclick = () => {
            applyState(false);
            localStorage.setItem(key, '0');
        };

        // 펼쳐진 상태일 때 헤더 옆에 보이는 접기용 화살표(▼)
        const toggleBtn = document.createElement('span');
        toggleBtn.style.cssText = 'cursor:pointer; margin-left:8px; font-size:0.8em; color:#888; user-select:none;';
        toggleBtn.textContent = '▼';
        header.style.display = 'flex';
        header.style.alignItems = 'center';
        header.appendChild(toggleBtn);
        toggleBtn.onclick = () => {
            applyState(true);
            localStorage.setItem(key, '1');
        };

        const savedCollapsed = localStorage.getItem(key) === '1';
        applyState(savedCollapsed);
    });

    updateCollapsedRowVisibility();
}

document.addEventListener('DOMContentLoaded', () => {
    setTimeout(ensureSectionCollapsers, 300);
    setTimeout(ensureSectionCollapsers, 1500);
});
window.addEventListener('load', () => setTimeout(ensureSectionCollapsers, 200));

/* ──────────────────────────────────────────────
   🖼 이미지 검수 (대기열 기반)
   범위 지정 전송 → 배치 생성으로 만든 결과물들을 한 장씩 보면서
   나쁨=대기열에 그대로 둠(재시도 가능) / 좋음=대기열에서 제거 + 지정 폴더에 복사.
   번호는 그 조각이 속한 "그룹 안에서의 실제 순번"으로 매겨진다 (임의의 카운터 아님).
   ────────────────────────────────────────────── */

function ensureReviewButton() {
    if (document.getElementById('btn-review')) return;
    const addBtn = document.getElementById('btn-add-item');
    if (!addBtn || !addBtn.parentElement) return;
    const btn = document.createElement('button');
    btn.id = 'btn-review';
    btn.className = 'btn-secondary';
    btn.title = '대기열에서 이미 생성된 작업들 중 고른 것들을 한 장씩 보면서, 나쁘면 대기열에 그대로 두고 좋으면 대기열에서 빼면서 폴더에 저장';
    btn.style.cssText = 'display:none; padding:4px 10px; font-size:0.9em; margin-right:6px;';
    btn.textContent = '🖼 이미지 검수';
    btn.onclick = openReviewModal;
    addBtn.parentElement.insertBefore(btn, addBtn);
}

// 🆕 검수 진행상태(reviewState)를 localStorage에 저장해서, 새로고침해도 검수 위치/이번 세션 결정
//    내용이 유지되도록 한다. (예전엔 메모리에만 있어서 새로고침하면 전부 날아갔음)
const REVIEW_STATE_STORAGE_KEY = 'reviewStateSave_v1';

function loadPersistedReviewState() {
    try {
        const raw = localStorage.getItem(REVIEW_STATE_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.queue)) return null;
        return parsed;
    } catch (e) {
        console.warn('[검수] 저장된 검수 진행상태를 불러오지 못했습니다 (무시하고 새로 시작):', e);
        return null;
    }
}

/** reviewState를 localStorage에 저장. 상태가 바뀌는 모든 지점(시작/결정/되돌리기/이동)에서 호출. */
function persistReviewState() {
    try {
        localStorage.setItem(REVIEW_STATE_STORAGE_KEY, JSON.stringify(reviewState));
    } catch (e) {
        // 용량 초과 등으로 저장 실패해도 검수 자체는 계속 진행 가능해야 하므로 조용히 경고만 남김
        console.warn('[검수] 검수 진행상태 저장 실패(저장 공간 가득 찼을 수 있음):', e);
    }
}

/** 저장된 검수 진행상태를 완전히 지우고 처음부터 다시 시작할 수 있게 한다 */
function clearPersistedReviewState() {
    reviewState.queue = [];
    reviewState.destFolder = '';
    reviewState.catIds = [];
    reviewState.pos = 0;
    reviewState.decisions = {};
    try { localStorage.removeItem(REVIEW_STATE_STORAGE_KEY); } catch (e) { /* 무시 */ }
}
window.clearPersistedReviewState = clearPersistedReviewState;

const reviewState = Object.assign(
    { queue: [], destFolder: '', catIds: [], pos: 0, decisions: {} },
    loadPersistedReviewState() || {}
);
// queue: [{jobId}] — job.id 기준으로 안정적으로 추적 (jobQueue는 splice로 인덱스가 계속 바뀌므로 index 대신 id 사용)
// decisions: { [jobId]: { type:'good'|'bad', removedJob, removedAtIndex, destPath } }

/** 이미 검수한 job의 id 목록을 브라우저에 기억해뒀다가, 다시 검수 대상에서 빼기 위한 저장소 */
function getReviewedJobIds() {
    try { return new Set(JSON.parse(localStorage.getItem('reviewedJobIds') || '[]')); }
    catch (e) { return new Set(); }
}
function markJobAsReviewed(jobId) {
    const set = getReviewedJobIds();
    set.add(jobId);
    const arr = [...set];
    localStorage.setItem('reviewedJobIds', JSON.stringify(arr.slice(-2000)));
}
function unmarkJobAsReviewed(jobId) {
    const set = getReviewedJobIds();
    set.delete(jobId);
    localStorage.setItem('reviewedJobIds', JSON.stringify([...set]));
}

/** 대기열 안에서 "이미 생성 완료됐고(lastResults 있음) + 아직 검수 안 한" 결과 이미지들을 골라낸다.
 *  job 하나가 반복 생성으로 이미지를 여러 장 만들었으면 각각 별도 항목으로 반환한다. */
function getGeneratedResultEntries() {
    if (typeof jobQueue === 'undefined') return [];
    const reviewed = getReviewedJobIds();
    const entries = [];
    jobQueue.forEach((job, jobIdx) => {
        const results = job.lastResults || (job.lastResult ? [job.lastResult] : []);
        results.forEach((result, resultIndex) => {
            if (reviewed.has(`${job.id}::${resultIndex}`)) return;
            // 🆕 검열이 켜져서 원본+검열본이 짝으로 나온 경우, "원본(비검열)"은 검수 화면에서
            // 대조용 참고 이미지로만 보여주고 독립적인 판정 대상에서는 뺀다 — 실제로 저장되는 건 검열본 쪽이므로.
            if (result.isCensored === false && result.genGroupId &&
                results.some(r => r !== result && r.genGroupId === result.genGroupId && r.isCensored === true)) {
                return;
            }
            entries.push({ jobIdx, resultIndex });
        });
    });
    return entries;
}

/** job 하나에 대한 표시용 라벨(그룹명/조각명) */
function getJobDisplayLabel(job) {
    if (job.sourceRefs && job.sourceRefs.length > 0) {
        const ref = job.sourceRefs[0];
        const cat = getAllCategories().find(c => c.id === ref.catId);
        const item = cat && cat.items.find(it => it.id === ref.itemId);
        if (cat && item) return `${cat.name} / ${item.name}`;
    }
    return Object.entries(job.labels || {}).map(([k, v]) => `${k}:${v}`).join(', ') || '(이름 없음)';
}

/** 검수 대상 결과 이미지들을 sourceRefs의 그룹(catId) 기준으로 묶는다. { catId, catName, entries[] }[] */
function groupGeneratedJobsByCategory() {
    const entries = getGeneratedResultEntries();
    const groups = new Map();
    entries.forEach(({ jobIdx, resultIndex }) => {
        const job = jobQueue[jobIdx];
        const ref = job.sourceRefs && job.sourceRefs[0];
        const catId = ref ? ref.catId : '__none__';
        const cat = ref ? getAllCategories().find(c => c.id === catId) : null;
        const catName = cat ? cat.name : '(그룹 정보 없음)';
        if (!groups.has(catId)) groups.set(catId, { catId, catName, entries: [] });
        groups.get(catId).entries.push({ jobIdx, resultIndex });
    });
    return [...groups.values()];
}

function openReviewModal() {
    if (!document.getElementById('review-modal')) {
        const modal = document.createElement('div');
        modal.id = 'review-modal';
        modal.className = 'modal-overlay';
        modal.style.cssText = 'display:none;';
        modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
        document.body.appendChild(modal);
    }
    const modal = document.getElementById('review-modal');
    const groups = groupGeneratedJobsByCategory();

    const groupRowsHtml = groups.map(g => `
        <label style="display:flex; align-items:center; gap:8px; padding:6px 4px; border-bottom:1px solid #2a2a2a; cursor:pointer;">
            <input type="checkbox" class="review-group-check" data-cat-id="${g.catId}" checked style="width:16px; height:16px;">
            <span style="flex:1;">${escapeHtml(g.catName)}</span>
            <span style="color:#888; font-size:0.85em;">${g.entries.length}개${g.entries.length === 1 ? ' (테스트용일 수 있음)' : ''}</span>
        </label>
    `).join('');

    modal.innerHTML = `
        <div class="modal-content" onclick="event.stopPropagation()" style="width:99vw; max-width:99vw; height:96vh; max-height:96vh; padding:10px; display:flex; flex-direction:column; overflow:hidden;">
            <div class="modal-header" style="flex-shrink:0;">
                <h3 style="margin:0; color:#4CAF50;">🖼 이미지 검수</h3>
                <span class="close-btn" style="position:static; font-size:1.5em; color:#ff5555;" onclick="document.getElementById('review-modal').style.display='none';">&times;</span>
            </div>
            <div class="modal-body" style="flex:1; min-height:0; padding:8px; display:flex; flex-direction:column; overflow-y:auto;">
                <div id="review-setup-area">
                    <p style="font-size:0.85em; color:#aaa; margin:0 0 8px;">검수할 그룹을 고르세요 (체크 해제하면 그 그룹은 건너뜀 — 예: 1개짜리 테스트 결과물 빼고 하기 좋음)</p>
                    <div style="max-height:220px; overflow-y:auto; border:1px solid #333; border-radius:6px; padding:4px 8px;">
                        ${groupRowsHtml || '<p style="color:#666; font-size:0.85em; padding:8px;">검수할(이미 생성된) 작업이 없습니다.</p>'}
                    </div>
                    <div style="display:flex; gap:8px; margin-top:8px;">
                        <button class="btn-secondary" style="flex:1; font-size:0.8em;" onclick="document.querySelectorAll('.review-group-check').forEach(c=>c.checked=true);">전체 선택</button>
                        <button class="btn-secondary" style="flex:1; font-size:0.8em;" onclick="document.querySelectorAll('.review-group-check').forEach(c=>c.checked=false);">전체 해제</button>
                    </div>
                    <div style="margin-top:10px;">
                        <label style="font-size:0.85em; color:#ccc;">좋은 이미지를 복사할 폴더</label>
                        <input type="text" id="review-dest-folder" placeholder="예: C:\\Users\\yohan\\Desktop\\ffe"
                            style="width:100%; box-sizing:border-box; padding:6px; margin-top:4px; background:#222; border:1px solid #555; color:#fff; border-radius:4px;">
                    </div>
                    <button class="btn-primary" style="width:100%; margin-top:10px; padding:10px;" data-help="reviewStart" onclick="startReview()">▶ 검수 시작</button>
                </div>

                <div id="review-area" style="display:none; flex:1; min-height:0; flex-direction:column; gap:8px;">
                    <div style="display:flex; width:100%; justify-content:space-between; align-items:center; flex-shrink:0; gap:4px;">
                        <button id="review-prev-btn" style="padding:4px 12px; font-size:0.85em; background:#333; border:1px solid #888; color:#ccc; border-radius:4px; cursor:pointer;" onclick="reviewGoPrev()">◀ 이전</button>
                        <button style="padding:4px 10px; font-size:0.8em; background:#333; border:1px solid #888; color:#ccc; border-radius:4px; cursor:pointer;" onclick="cancelReview()">✖ 검수 종료(이어서 가능)</button>
                        <button style="padding:4px 8px; font-size:0.75em; background:#1a2a1a; border:1px solid #4CAF50; color:#4CAF50; border-radius:4px; cursor:pointer;" onclick="appendNewReviewItems()" title="처음부터 다시 시작하지 않고, 같은 그룹에서 새로 생성된 이미지만 지금 검수 목록 뒤에 이어붙입니다">🔄 새 항목 이어서</button>
                        <button style="padding:4px 8px; font-size:0.75em; background:#3a1a1a; border:1px solid #e74c3c; color:#e74c3c; border-radius:4px; cursor:pointer;" onclick="restartReviewFromScratch()" title="지금까지의 검수 위치/결정 내용을 전부 지우고 그룹 선택 화면으로 돌아갑니다">🗑 처음부터</button>
                        <button id="review-next-btn" style="padding:4px 12px; font-size:0.85em; background:#333; border:1px solid #888; color:#ccc; border-radius:4px; cursor:pointer;" onclick="reviewGoNext()">다음 ▶</button>
                    </div>
                    <div style="flex-shrink:0; text-align:center;">
                        <div id="review-progress" style="font-size:0.8em; color:#888;"></div>
                        <div id="review-item-label" style="font-size:1em; font-weight:bold; color:#4CAF50; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-align:center;"></div>
                    </div>
                    <!-- 🆕 순서 수정: 프롬프트 텍스트(고정 높이)를 먼저 배치하고, 이미지 표시 영역(flex:1, 나머지 공간 전부 차지)을
                         맨 마지막(버튼 바로 위)에 둬서 이미지가 항상 맨 위(라벨 바로 밑)부터 꽉 차게 나오도록 함 -->
                    <div id="review-item-prompt" style="flex-shrink:0; font-size:0.78em; color:#aaa; text-align:center; max-height:2.4em; overflow-y:auto; padding:0 8px;"></div>
                    <div id="review-media-row" style="flex:1; min-height:0; width:100%; display:flex; justify-content:center; align-items:stretch; gap:0;">
                        <!-- 🆕 검열 켜진 조각: 원본(왼쪽)을 검열본에 딱 붙여서 나란히 보여줌 (제대로 가려졌는지 빈틈없이 대조) -->
                        <div id="review-original-ref" style="display:none; flex:1; min-width:0; min-height:0; background:#111; border:1px solid #e0a030; border-right:none; flex-direction:column; overflow:hidden;">
                            <div style="flex-shrink:0; font-size:0.75em; color:#e0a030; text-align:center; padding:2px 0; background:#241a05;">🔓 원본(비검열) 대조용 — 판정은 오른쪽 검열본 기준</div>
                            <div style="flex:1; min-height:0; display:flex; align-items:center; justify-content:center;">
                                <img id="review-original-ref-img" style="max-width:100%; max-height:100%; object-fit:contain; pointer-events:none;">
                            </div>
                        </div>
                        <div id="review-img-frame" style="flex:1; min-width:0; min-height:0; background:#111; border:1px solid #333; display:flex; align-items:center; justify-content:center; overflow:hidden; cursor:pointer; position:relative;" title="좌클릭=좋음 · 우클릭=나쁨 (이미지 옆 여백도 동일하게 반응함)">
                            <img id="review-img" style="max-width:100%; max-height:100%; object-fit:contain; pointer-events:none;">
                            <button id="review-edit-btn" onclick="event.stopPropagation(); openReviewImageEditor();"
                                title="결정하기 전에 지금 보이는 이미지를 그림판으로 편집 — 기존 그림판 편집 기능을 그대로 재사용 (별도 저장 리소스 추가 없음)"
                                style="position:absolute; top:8px; right:8px; z-index:2; padding:6px 10px; background:rgba(20,30,45,0.85); border:1px solid #4a90d9; color:#4a90d9; border-radius:6px; font-size:0.85em; cursor:pointer;">🎨 편집</button>
                        </div>
                    </div>
                    <!-- 🆕 같은 job이 반복생성(repeatCount>1)으로 여러 장을 만들었을 때, 한 장씩 넘기지 않고
                         한 화면에 그리드로 동시에 보면서 각각 개별 판정할 수 있게 하는 모드 -->
                    <div id="review-grid-frame" style="display:none; flex:1; min-height:0; width:100%; overflow-y:auto; gap:10px; flex-wrap:wrap; align-content:flex-start; justify-content:center; padding:4px;"></div>
                    <div id="review-decide-row" style="flex-shrink:0; display:flex; gap:10px; width:100%;">
                        <button id="review-bad-btn" style="flex:1; padding:12px; background:#3a1a1a; border:1px solid #e74c3c; color:#e74c3c; border-radius:6px; font-size:1em; cursor:pointer;" onclick="reviewDecide(false)">👎 나쁨 (대기열에 그대로 둠)</button>
                        <button id="review-good-btn" style="flex:1; padding:12px; background:#1a3a1a; border:1px solid #4CAF50; color:#4CAF50; border-radius:6px; font-size:1em; cursor:pointer;" onclick="reviewDecide(true)">👍 좋음 (대기열 제거+저장)</button>
                    </div>
                    <div id="review-decided-row" style="flex-shrink:0; display:none; gap:10px; width:100%; align-items:center;">
                        <span id="review-decided-label" style="flex:1; font-size:0.9em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></span>
                        <button style="padding:10px 14px; background:#3a2a10; border:1px solid #FF9800; color:#FF9800; border-radius:6px; cursor:pointer;" onclick="undoReviewDecision()">↩ 이 검수 취소(되돌리기)</button>
                    </div>
                    <p style="flex-shrink:0; font-size:0.75em; color:#666; margin:0;">이미지 좌클릭=좋음 · 우클릭=나쁨 · 키보드 ← 이전 · → 다음/좋음(미결정시)</p>
                </div>
            </div>
        </div>`;
    modal.style.display = 'flex';

    const destInput = document.getElementById('review-dest-folder');
    const savedDest = localStorage.getItem('reviewDestFolder');
    if (savedDest) destInput.value = savedDest;
    destInput.addEventListener('input', () => localStorage.setItem('reviewDestFolder', destInput.value));

    const imgFrame = document.getElementById('review-img-frame');
    imgFrame.onclick = () => { if (!isCurrentReviewPosDecided()) reviewDecide(true); };
    imgFrame.oncontextmenu = (e) => { e.preventDefault(); if (!isCurrentReviewPosDecided()) reviewDecide(false); };

    // 🆕 새로고침 등으로 끊겼던 검수가 이어서 진행 중이면(대기열이 비어있지 않으면) 그룹 선택 화면을 건너뛰고
    //    바로 검수 화면으로 복귀시킨다.
    if (reviewState.queue.length > 0) {
        document.getElementById('review-setup-area').style.display = 'none';
        document.getElementById('review-area').style.display = 'flex';
        showCurrentReviewImage();
    }
}

/** 🗑 처음부터: 저장된 검수 진행상태를 전부 지우고 그룹 선택 화면으로 되돌아간다 */
function restartReviewFromScratch() {
    if (!confirm('지금까지의 검수 위치와 이번 세션에서 내린 결정 내용을 전부 지우고 처음부터 다시 시작할까요?\n(이미 "좋음"으로 저장/이동된 이미지 자체는 되돌아가지 않습니다)')) return;
    clearPersistedReviewState();
    document.getElementById('review-area').style.display = 'none';
    document.getElementById('review-setup-area').style.display = 'block';
}
window.restartReviewFromScratch = restartReviewFromScratch;

function startReview() {
    const dest = document.getElementById('review-dest-folder').value.trim();
    if (!dest) return alert('저장할 폴더를 입력해 주세요.');

    const checkedCatIds = new Set(
        [...document.querySelectorAll('.review-group-check:checked')].map(c => c.dataset.catId)
    );
    if (checkedCatIds.size === 0) return alert('검수할 그룹을 하나 이상 선택해 주세요.');

    const entries = getGeneratedResultEntries().filter(({ jobIdx }) => {
        const ref = jobQueue[jobIdx].sourceRefs && jobQueue[jobIdx].sourceRefs[0];
        const catId = ref ? ref.catId : '__none__';
        return checkedCatIds.has(catId);
    });
    if (entries.length === 0) return alert('선택한 그룹에 검수할 작업이 없습니다.');

    reviewState.queue = entries.map(({ jobIdx, resultIndex }) => ({ jobId: jobQueue[jobIdx].id, resultIndex }));
    reviewState.destFolder = dest;
    reviewState.catIds = [...checkedCatIds]; // 🆕 "이어서" 기능이 같은 그룹만 다시 훑어보기 위해 저장
    reviewState.pos = 0;
    reviewState.decisions = {};
    persistReviewState();

    document.getElementById('review-setup-area').style.display = 'none';
    document.getElementById('review-area').style.display = 'flex';
    showCurrentReviewImage();
}

/** 🔄 새 항목 이어서: 처음부터 다시 시작하지 않고, startReview() 때 선택했던 것과 같은 그룹에서
 *  그 사이 새로 생성된(아직 검수 큐에 없는) 결과물만 지금 큐 뒤에 이어붙인다.
 *  검수를 다 끝낸 뒤 새로 뽑은 이미지를 볼 때마다 "처음부터"로 리셋 → 그룹 다시 체크 → 검수 시작을
 *  반복해야 했던 불편함을 없애기 위함. */
function appendNewReviewItems() {
    if (!reviewState.catIds || reviewState.catIds.length === 0) {
        alert('이어서 추가할 그룹 정보가 없습니다. "🗑 처음부터"로 그룹을 다시 선택해 주세요.');
        return;
    }
    if (typeof jobQueue === 'undefined') return;

    const catIdSet = new Set(reviewState.catIds);
    const existingKeys = new Set(reviewState.queue.map(e => `${e.jobId}::${e.resultIndex}`));

    const newEntries = getGeneratedResultEntries().filter(({ jobIdx, resultIndex }) => {
        const job = jobQueue[jobIdx];
        const ref = job.sourceRefs && job.sourceRefs[0];
        const catId = ref ? ref.catId : '__none__';
        if (!catIdSet.has(catId)) return false;
        return !existingKeys.has(`${job.id}::${resultIndex}`);
    });

    if (newEntries.length === 0) {
        alert('새로 검수할 항목이 없습니다. (선택했던 그룹에서 새로 생성된 결과물이 아직 없어요)');
        return;
    }

    const jumpTo = reviewState.queue.length; // 새로 추가되는 첫 항목의 위치
    reviewState.queue.push(...newEntries.map(({ jobIdx, resultIndex }) => ({ jobId: jobQueue[jobIdx].id, resultIndex })));
    reviewState.pos = jumpTo;
    persistReviewState();

    document.getElementById('review-setup-area').style.display = 'none';
    document.getElementById('review-area').style.display = 'flex';
    showCurrentReviewImage();
}
window.appendNewReviewItems = appendNewReviewItems;

/** 지금 검수 중인 job이 속한 그룹 안에서 실제로 몇 번째 조각인지 계산 (없으면 null).
 *  조각에 "지정 번호"(customNumber)가 직접 설정되어 있으면 그걸 우선 사용한다. */
function getGroupPositionForJob(job) {
    if (!job.sourceRefs || job.sourceRefs.length === 0) return null;
    const ref = job.sourceRefs[0];
    const cat = getAllCategories().find(c => c.id === ref.catId);
    if (!cat) return null;
    const item = cat.items.find(it => it.id === ref.itemId);
    if (!item) return null;
    if (item.customNumber !== undefined && item.customNumber !== null && item.customNumber !== '') {
        const n = parseInt(item.customNumber, 10);
        if (!isNaN(n)) return n;
    }
    const idx = cat.items.findIndex(it => it.id === ref.itemId);
    return idx === -1 ? null : idx + 1;
}

/** jobId로 현재 jobQueue 안에서 그 job을 찾는다 (없으면 null — 이미 제거된 상태일 수 있음) */
function findJobById(jobId) {
    return jobQueue.find(j => j.id === jobId) || null;
}

/** entry(jobId + resultIndex) 하나를 decisions/reviewed 추적용 고유 키 문자열로 변환 */
function reviewEntryKey(entry) {
    return `${entry.jobId}::${entry.resultIndex}`;
}

function isCurrentReviewPosDecided() {
    const entry = reviewState.queue[reviewState.pos];
    return !!(entry && reviewState.decisions[reviewEntryKey(entry)]);
}

/** 🆕 pos가 속한 "묶음"(같은 job.id를 공유하는 항목들 — 반복생성 결과)의 queue 인덱스 배열.
 *  반복생성(repeatCount>1)으로 한 job이 여러 장을 만들면 여러 entry가 같은 jobId를 갖는데,
 *  이걸 그리드로 한 화면에 모아 동시에 보고 각각 판정할 수 있게 하기 위한 그룹핑. */
function getReviewClusterIndices(pos) {
    const entry = reviewState.queue[pos];
    if (!entry) return [pos];
    const jobId = entry.jobId;
    const indices = [];
    reviewState.queue.forEach((e, i) => { if (e.jobId === jobId) indices.push(i); });
    return indices.length > 0 ? indices : [pos];
}

/** 🆕 검열본 result에 대응하는 원본(비검열) result를 같은 genGroupId에서 찾는다 (없으면 null).
 *  genGroupId/isCensored는 generate.js의 대기열 실행 루프에서 executeGeneration 한 번당 태그해서 넣어준다. */
function findOriginalPairForResult(job, result) {
    if (!job || !result || !result.isCensored || !result.genGroupId) return null;
    const all = job.lastResults || [];
    return all.find(r => r !== result && r.genGroupId === result.genGroupId && r.isCensored === false) || null;
}

function reviewGoPrev() {
    const cluster = getReviewClusterIndices(reviewState.pos);
    const firstOfCluster = cluster[0];
    if (firstOfCluster > 0) { reviewState.pos = firstOfCluster - 1; persistReviewState(); showCurrentReviewImage(); }
}
function reviewGoNext() {
    const cluster = getReviewClusterIndices(reviewState.pos);
    const lastOfCluster = cluster[cluster.length - 1];
    if (lastOfCluster < reviewState.queue.length - 1) { reviewState.pos = lastOfCluster + 1; persistReviewState(); showCurrentReviewImage(); }
}

/**
 * 🐛 버그 수정: 예전엔 대상 job/result를 못 찾으면(예: 다른 경로로 대기열에서 이미 제거된 항목)
 * 그냥 함수를 return해버려서, review-img/버튼 줄이 "이전 화면 그대로" 남아있었다.
 * 그래서 다음▶ 눌러도 내부 pos는 실제로 바뀌는데 화면(이미지)은 안 바뀌어서 "제자리에 멈춘 것처럼" 보였음.
 * → 이제 못 찾은 항목은 자동으로 건너뛰고(스킵), 그래도 안 되면 화면을 확실히 비워서 최소한 헷갈리지 않게 한다.
 */
function showCurrentReviewImage(skipDepth = 0) {
    const total = reviewState.queue.length;

    if (reviewState.pos >= total) { reviewState.pos = total - 1; }
    if (reviewState.pos < 0) { reviewState.pos = 0; }

    const gridFrame = document.getElementById('review-grid-frame');
    const imgFrame = document.getElementById('review-img-frame');
    const originalRef = document.getElementById('review-original-ref');
    const cluster = total > 0 ? getReviewClusterIndices(reviewState.pos) : [];

    document.getElementById('review-prev-btn').disabled = cluster.length > 0 ? cluster[0] <= 0 : true;
    document.getElementById('review-next-btn').disabled = cluster.length > 0 ? cluster[cluster.length - 1] >= total - 1 : true;

    if (total === 0) {
        document.getElementById('review-progress').textContent = '';
        document.getElementById('review-item-label').textContent = '✅ 검수할 항목이 없습니다.';
        document.getElementById('review-item-prompt').textContent = '더 생성하셨다면 위의 "🔄 새 항목 이어서" 버튼으로 처음부터 다시 시작하지 않고 이어서 검수할 수 있어요.';
        document.getElementById('review-img').removeAttribute('src');
        document.getElementById('review-edit-btn').style.display = 'none';
        document.getElementById('review-decide-row').style.display = 'none';
        document.getElementById('review-decided-row').style.display = 'none';
        imgFrame.style.display = 'flex';
        gridFrame.style.display = 'none';
        originalRef.style.display = 'none';
        document.getElementById('review-media-row').style.display = 'flex';
        return;
    }

    // 🆕 같은 job의 반복생성 결과가 여럿(cluster.length>1)이면, 한 장씩 넘기지 않고
    // 그리드로 한 화면에 동시에 보여주고 각각 개별 판정하게 한다.
    if (cluster.length > 1) {
        // 🆕 진짜 원인: img-frame/originalRef 개별로만 숨기고, 그 바깥 껍데기인 media-row(flex:1) 자체는
        // 안 숨겨서 빈 채로 공간을 그대로 차지하고 있었음 — 그 아래로 그리드가 밀려서 화면 밖으로 잘렸었다.
        document.getElementById('review-media-row').style.display = 'none';
        imgFrame.style.display = 'none';
        originalRef.style.display = 'none';
        document.getElementById('review-edit-btn').style.display = 'none';
        document.getElementById('review-decide-row').style.display = 'none';
        document.getElementById('review-decided-row').style.display = 'none';
        gridFrame.style.display = 'flex';

        const firstEntry = reviewState.queue[cluster[0]];
        const firstDecision = reviewState.decisions[reviewEntryKey(firstEntry)];
        const firstJob = firstDecision ? firstDecision.jobSnapshot : findJobById(firstEntry.jobId);
        const decidedCount = cluster.filter(i => reviewState.decisions[reviewEntryKey(reviewState.queue[i])]).length;
        document.getElementById('review-progress').textContent = `${reviewState.pos + 1} / ${total} — 묶음 ${decidedCount}/${cluster.length}개 판정됨`;
        document.getElementById('review-item-label').textContent = firstJob
            ? `${getJobDisplayLabel(firstJob)} (반복 ${cluster.length}장 — 아래에서 각각 판정)`
            : '(이 항목을 찾을 수 없습니다)';
        document.getElementById('review-item-prompt').textContent = firstJob ? (firstJob.fullPrompt || []).join(', ') : '';
        if (firstJob) appendNumCheckBadge(document.getElementById('review-item-label'), firstJob); // 🔢 번호표 대조 결과 표시

        gridFrame.innerHTML = cluster.map(i => {
            const e = reviewState.queue[i];
            const dKey = reviewEntryKey(e);
            const decision = reviewState.decisions[dKey];
            const job = decision ? decision.jobSnapshot : findJobById(e.jobId);
            const result = job ? (decision ? decision.resultSnapshot : (job.lastResults || (job.lastResult ? [job.lastResult] : []))[e.resultIndex]) : null;
            if (!job || !result) {
                return `<div style="width:340px; padding:10px; color:#888; font-size:0.8em;">(이 항목을 찾을 수 없음)</div>`;
            }
            const src = `/view?filename=${encodeURIComponent(result.filename)}&type=${encodeURIComponent(result.type)}&subfolder=${encodeURIComponent(result.subfolder)}&t=${Date.now()}`;
            // 🆕 검열 켜진 조각이면 이 셀 안에서 원본(비검열)을 검열본 왼쪽에 빈틈없이 붙여서 대조용으로 같이 보여줌
            const origPair = !decision ? findOriginalPairForResult(job, result) : null;
            const cellWidth = origPair ? 860 : 480;
            const imgHeight = 480;
            const imgHtml = origPair
                ? `<div style="display:flex; gap:0; width:100%; height:${imgHeight}px;">
                       <img src="/view?filename=${encodeURIComponent(origPair.filename)}&type=${encodeURIComponent(origPair.type)}&subfolder=${encodeURIComponent(origPair.subfolder)}&t=${Date.now()}"
                            style="flex:1; min-width:0; height:100%; object-fit:contain; background:#000; border:1px solid #e0a030; border-right:none;" title="🔓 원본(비검열) 대조용">
                       <img src="${src}" style="flex:1; min-width:0; height:100%; object-fit:contain; background:#000; border:1px solid #333;">
                   </div>
                   <div style="display:flex; font-size:0.75em; color:#e0a030; text-align:center;">
                       <span style="flex:1;">🔓 원본</span><span style="flex:1;">검열본(판정 대상)</span>
                   </div>`
                // 🆕 고정 정사각형 박스 대신 카드 폭만 채우고 높이는 이미지 비율 그대로(auto) 따라가게 해서
                // 세로로 긴 이미지에 생기던 좌우 검은 여백을 없앤다 (최대 높이만 한도로 제한).
                : `<img src="${src}" style="width:100%; height:auto; max-height:${imgHeight}px; display:block; object-fit:contain; border-radius:3px;">`;
            const decidedHtml = decision
                ? `<div style="padding:4px; font-size:0.75em; text-align:center; color:${decision.type === 'good' ? '#4CAF50' : '#e74c3c'};">
                       ${decision.type === 'good' ? '👍 좋음(저장됨)' : '👎 나쁨'}
                       <button onclick="reviewUndoGridCell(${i})" style="display:block; width:100%; margin-top:3px; padding:3px; background:#3a2a10; border:1px solid #FF9800; color:#FF9800; border-radius:4px; cursor:pointer; font-size:0.9em;">↩ 취소</button>
                   </div>`
                : `<div style="display:flex; gap:4px; padding:4px;">
                       <button onclick="reviewDecideGridCell(${i}, false)" style="flex:1; padding:6px; background:#3a1a1a; border:1px solid #e74c3c; color:#e74c3c; border-radius:4px; cursor:pointer;">👎</button>
                       <button onclick="reviewDecideGridCell(${i}, true)" style="flex:1; padding:6px; background:#1a3a1a; border:1px solid #4CAF50; color:#4CAF50; border-radius:4px; cursor:pointer;">👍</button>
                   </div>`;
            return `
                <div style="width:${cellWidth}px; background:#1a1a1a; border:1px solid #333; border-radius:6px; padding:6px;">
                    ${imgHtml}
                    <div style="font-size:0.7em; color:#777; text-align:center; margin-top:2px;">반복 ${e.resultIndex + 1}</div>
                    ${decidedHtml}
                </div>`;
        }).join('');
        return;
    }

    // ── 단일 이미지 모드 (묶음 안에 한 장뿐일 때) ──
    gridFrame.style.display = 'none';
    document.getElementById('review-media-row').style.display = 'flex';
    imgFrame.style.display = 'flex';

    const entry = reviewState.queue[reviewState.pos];
    const dKey = reviewEntryKey(entry);
    // job은 좋음 판정 시 대기열에서 빠질 수 있으므로, 원본 스냅샷(decisions에 저장됨)이나 현재 대기열에서 찾는다
    const decision = reviewState.decisions[dKey];
    const job = decision ? decision.jobSnapshot : findJobById(entry.jobId);
    const result = job ? (decision ? decision.resultSnapshot : (job.lastResults || (job.lastResult ? [job.lastResult] : []))[entry.resultIndex]) : null;

    if (!job || !result) {
        originalRef.style.display = 'none';
        // 이 항목은 대기열에서 다른 경로로 이미 사라진 깨진 참조 — 다음(또는 마지막이면 이전) 유효한 항목으로 자동 스킵.
        // skipDepth로 무한 재귀(전부 깨진 경우) 방지.
        if (skipDepth < total) {
            const canGoNext = reviewState.pos < total - 1;
            if (canGoNext) { reviewState.pos++; return showCurrentReviewImage(skipDepth + 1); }
            const canGoPrev = reviewState.pos > 0;
            if (canGoPrev) { reviewState.pos--; return showCurrentReviewImage(skipDepth + 1); }
        }
        // 더 스킵할 곳도 없으면(전부 깨졌으면) 화면을 확실히 비워서 멈춰있는 것처럼 보이지 않게 함
        document.getElementById('review-progress').textContent = `${reviewState.pos + 1} / ${total}`;
        document.getElementById('review-item-label').textContent = !job ? '(이 항목을 찾을 수 없습니다)' : '(이 결과 이미지를 찾을 수 없습니다)';
        document.getElementById('review-item-prompt').textContent = '';
        document.getElementById('review-img').removeAttribute('src');
        document.getElementById('review-edit-btn').style.display = 'none';
        document.getElementById('review-decide-row').style.display = 'none';
        document.getElementById('review-decided-row').style.display = 'none';
        return;
    }

    const groupPos = getGroupPositionForJob(job);
    const totalResultsOfJob = (job.lastResults || []).length;
    const dupSuffix = totalResultsOfJob > 1 ? ` (반복 ${entry.resultIndex + 1}/${totalResultsOfJob})` : '';
    const numberLabel = groupPos !== null ? `그룹 내 ${groupPos}번${dupSuffix}` : '(그룹 번호 확인 불가 — 순서대로 저장됨)';
    document.getElementById('review-progress').textContent = `${reviewState.pos + 1} / ${total} — ${numberLabel}`;
    document.getElementById('review-item-label').textContent = getJobDisplayLabel(job);
    appendNumCheckBadge(document.getElementById('review-item-label'), job); // 🔢 번호표 대조 결과 표시
    document.getElementById('review-item-prompt').textContent = (job.fullPrompt || []).join(', ');

    const { filename, subfolder, type } = result;
    document.getElementById('review-img').src =
        `/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}&subfolder=${encodeURIComponent(subfolder)}&t=${Date.now()}`;

    // 🆕 검열이 적용된 결과면, 제대로 가려졌는지 대조해볼 수 있게 원본(비검열)을 옆에 같이 보여줌
    const origPair = findOriginalPairForResult(job, result);
    if (origPair) {
        document.getElementById('review-original-ref-img').src =
            `/view?filename=${encodeURIComponent(origPair.filename)}&type=${encodeURIComponent(origPair.type)}&subfolder=${encodeURIComponent(origPair.subfolder)}&t=${Date.now()}`;
        originalRef.style.display = 'flex';
        // 원본|검열본 페어일 때는 화면을 정확히 반씩 나눠서 빈틈없이 붙임 (기존 방식 그대로)
        imgFrame.style.flex = '1 1 0';
        imgFrame.style.alignSelf = '';
        imgFrame.style.height = '';
        imgFrame.style.width = '';
        imgFrame.style.minWidth = '0';
        imgFrame.style.maxWidth = 'none';
        imgFrame.style.background = '#111';
    } else {
        originalRef.style.display = 'none';
        // 🆕 진짜 원인 찾음(flexbugs #1): flex item은 기본적으로 min-height:auto라서, 안의 내용
        // (이미지 원본 해상도)보다 작게 줄어들질 못한다. 그래서 %(퍼센트) height도 못 먹고, JS로 픽셀을
        // 재서 넣는 것도 다 미봉책이었음 — 진짜 해결책은 그냥 min-height:0 하나 넣어주는 것.
        // (템플릿의 #review-img-frame에 min-height:0 추가함) 이제 align-items:stretch가 정상적으로
        // media-row 높이에 맞춰 줄어들고, 이미지는 max-height:100%로 그 안에 딱 맞게 들어간다.
        // width는 flex-basis:auto + min-width:0으로 이미지 비율만큼만 shrink-to-fit해서 좌우 여백도 없앰.
        imgFrame.style.flex = '0 1 auto';
        imgFrame.style.alignSelf = 'stretch';
        imgFrame.style.height = '';
        imgFrame.style.width = 'auto';
        imgFrame.style.minWidth = '0';
        imgFrame.style.maxWidth = '100%';
        imgFrame.style.background = 'transparent';
    }

    if (decision) {
        document.getElementById('review-edit-btn').style.display = 'none';
        document.getElementById('review-decide-row').style.display = 'none';
        document.getElementById('review-decided-row').style.display = 'flex';
        document.getElementById('review-decided-label').textContent =
            decision.type === 'good' ? `👍 좋음으로 저장됨 (${decision.destPath || ''})` : '👎 나쁨으로 표시됨 (대기열에 남아있음)';
    } else {
        document.getElementById('review-edit-btn').style.display = 'inline-block';
        document.getElementById('review-decide-row').style.display = 'flex';
        document.getElementById('review-decided-row').style.display = 'none';
    }
}

/**
 * 🎨 검수 중인 이미지를 편집한다.
 * 새로 만들지 않고 기존 그림판 편집 기능(window.openPaintEditor, index.html에 정의됨)을 그대로 재사용한다.
 * 편집 완료 시 결과를 ComfyUI의 /upload/image로 올리고, 이 검수 항목이 참조하는
 * job.lastResults[entry.resultIndex]의 filename/subfolder/type을 편집본으로 바꿔치기한다.
 * (아직 "좋음/나쁨" 결정 전인 항목만 편집 가능 — 결정 후엔 이미 원본이 저장/기록됐으므로 되돌리기부터 해야 함)
 */
function openReviewImageEditor() {
    if (typeof isCurrentReviewPosDecided !== 'function' || isCurrentReviewPosDecided()) {
        alert('이미 결정된 항목은 편집할 수 없습니다. 먼저 "이 검수 취소(되돌리기)"를 눌러주세요.');
        return;
    }
    const entry = reviewState.queue[reviewState.pos];
    if (!entry) return;
    const job = findJobById(entry.jobId);
    if (!job) return;
    const result = (job.lastResults || (job.lastResult ? [job.lastResult] : []))[entry.resultIndex];
    if (!result) return;

    const srcUrl = document.getElementById('review-img')?.src;
    if (!srcUrl) return;

    // /view는 같은 출처(same-origin)라 CORS 문제 없이 바로 캔버스 → dataURL 변환 가능
    const tmpImg = new Image();
    tmpImg.crossOrigin = 'anonymous';
    tmpImg.onload = () => {
        const c = document.createElement('canvas');
        c.width = tmpImg.naturalWidth;
        c.height = tmpImg.naturalHeight;
        c.getContext('2d').drawImage(tmpImg, 0, 0);
        const dataUrl = c.toDataURL('image/png');

        window.openPaintEditor(dataUrl, async (editedDataUrl) => {
            try {
                const blob = await (await fetch(editedDataUrl)).blob();
                const formData = new FormData();
                formData.append('image', blob, 'review_edit.png');
                formData.append('overwrite', 'true');
                const uploadRes = await fetch('/upload/image', { method: 'POST', body: formData });
                if (!uploadRes.ok) throw new Error(`업로드 실패: HTTP ${uploadRes.status}`);
                const uploaded = await uploadRes.json(); // { name, subfolder, type } — type은 보통 'input'

                // 이 검수 항목이 참조하는 result 객체를 편집본으로 교체.
                // 이후 "좋음" 결정 시 review_accept가 이 filename/subfolder/type을 그대로 사용하므로
                // 별도 코드 추가 없이 편집본이 그대로 저장 대상이 된다.
                result.filename = uploaded.name;
                result.subfolder = uploaded.subfolder || '';
                result.type = uploaded.type || 'input';

                if (window.appStateManager) window.appStateManager.debounceSave();
                showCurrentReviewImage();
            } catch (e) {
                console.error('[검수 이미지 편집] 업로드 실패:', e);
                alert('편집한 이미지를 업로드하지 못했습니다. 다시 시도해 주세요.');
            }
        });
    };
    tmpImg.onerror = () => alert('이미지를 불러오지 못해 편집할 수 없습니다.');
    tmpImg.src = srcUrl;
}
window.openReviewImageEditor = openReviewImageEditor;

/** 🆕 entry(jobId+resultIndex) 하나를 좋음/나쁨으로 판정하는 공용 로직.
 *  단일모드(reviewDecide)와 그리드 동시검수 모드(reviewDecideGridCell) 둘 다 이 함수를 통해 처리한다.
 *  autoAdvance=true면 판정 후 reviewState.pos를 다음으로 넘긴다 (그리드모드는 호출부에서 직접 묶음 단위로 처리하므로 false로 넘김). */
async function reviewDecideEntry(queueIndex, isGood, autoAdvance) {
    const entry = reviewState.queue[queueIndex];
    if (!entry) return false;
    const dKey = reviewEntryKey(entry);
    if (reviewState.decisions[dKey]) return false; // 이미 결정된 항목은 되돌리기부터 해야 함

    const job = findJobById(entry.jobId);
    if (!job) return false;
    const result = (job.lastResults || (job.lastResult ? [job.lastResult] : []))[entry.resultIndex];
    if (!result) return false;

    const jobSnapshot = JSON.parse(JSON.stringify(job)); // 되돌리기용 스냅샷
    const resultSnapshot = JSON.parse(JSON.stringify(result));

    if (isGood) {
        const baseNumber = getGroupPositionForJob(job) ?? (queueIndex + 1);
        // 같은 조각을 반복생성해서 여러 장 나와도, 번호는 항상 그 조각 번호 그대로 사용한다.
        // "좋음"을 여러 번 누르면 마지막으로 누른 게 그 번호 파일을 덮어써서 최종본이 된다 (밑줄 접미사 없음).
        const number = baseNumber;

        let res;
        try {
            res = await API.post('/assetmanager/api/review_accept', {
                filename: result.filename,
                subfolder: result.subfolder,
                type: result.type,
                destFolder: reviewState.destFolder,
                number: number
            });
        } catch (e) {
            // 여기는 진짜 네트워크/통신 에러만 잡는다 (뒷정리 단계는 아래 별도 try로 분리했음)
            alert('서버 통신 오류로 저장하지 못했습니다.');
            return false;
        }
        if (!res.ok) { alert(`❌ 저장 실패: ${res.error}`); return false; }

        // 🆕 버그 수정: 저장(API 호출) 자체는 성공했는데, 그 다음 "뒷정리" 단계(대기열 정리, 렌더링 등)에서
        // 에러가 나면 예전엔 위의 catch에 걸려서 "서버 통신 오류로 저장 못함"이라고 잘못 떴었다.
        // (원인: totalResultsOfJob 변수를 다른 함수(showCurrentReviewImage)에서 선언해놓고 여기서 참조 —
        //  스코프가 달라서 참조 시 ReferenceError가 났음. 그 예외가 위의 try/catch에 잡혀서 오탐 발생.)
        // 실제 파일은 정상 저장됐으므로, 뒷정리 에러 때문에 검수 진행(다음으로 못 넘어가는 것)까지
        // 막히면 안 된다 — 뒷정리는 별도 try로 분리하고, 실패해도 결정(decision)은 반드시 기록한다.
        let removedAtIndex = null;
        let stillPending = true;
        try {
            markJobAsReviewed(dKey);

            // 이 job이 만든 결과 이미지를 전부 검수했을 때만 대기열에서 완전히 제거
            const totalResultsOfJob = (job.lastResults || (job.lastResult ? [job.lastResult] : [])).length;
            const reviewedSet = getReviewedJobIds();
            stillPending = Array.from({ length: totalResultsOfJob || 1 }, (_, i) => i)
                .some(i => !reviewedSet.has(`${job.id}::${i}`));
            if (!stillPending) {
                removedAtIndex = jobQueue.findIndex(j => j.id === job.id);
                if (removedAtIndex !== -1) jobQueue.splice(removedAtIndex, 1);
            }
            if (typeof renderJobQueue === 'function') renderJobQueue();
            if (window.appStateManager) window.appStateManager.debounceSave();
        } catch (cleanupErr) {
            console.error('[검수] 저장은 성공했지만 뒷정리 단계에서 에러가 났습니다 (검수 진행에는 지장 없음):', cleanupErr);
        }

        reviewState.decisions[dKey] = { type: 'good', jobSnapshot, resultSnapshot, removedAtIndex, fullyRemoved: !stillPending, destPath: res.destPath };
    } else {
        markJobAsReviewed(dKey);
        reviewState.decisions[dKey] = { type: 'bad', jobSnapshot, resultSnapshot };
    }

    // 결정 나면 자동으로 다음 항목으로 넘어감 (끝까지 왔으면 그대로 마지막에 머무름)
    if (autoAdvance && reviewState.pos < reviewState.queue.length - 1) reviewState.pos++;
    persistReviewState();
    return true;
}

async function reviewDecide(isGood) {
    const area = document.getElementById('review-area');
    if (!area || area.style.display === 'none') return;
    if (isCurrentReviewPosDecided()) return; // 이미 결정된 항목은 여기로 다시 결정 못함 (되돌리기부터)
    const ok = await reviewDecideEntry(reviewState.pos, isGood, true);
    if (ok) showCurrentReviewImage();
}

/** 🆕 그리드 동시검수 모드: 그리드 셀의 👍/👎 버튼에서 호출. pos는 그대로 두고 그리드만 다시 그리며,
 *  같은 묶음(cluster) 전체가 다 판정되면 자동으로 다음 묶음/항목으로 넘어간다. */
async function reviewDecideGridCell(queueIndex, isGood) {
    const ok = await reviewDecideEntry(queueIndex, isGood, false);
    if (!ok) { showCurrentReviewImage(); return; }
    const cluster = getReviewClusterIndices(reviewState.pos);
    const allDecided = cluster.every(i => {
        const e = reviewState.queue[i];
        return e && reviewState.decisions[reviewEntryKey(e)];
    });
    if (allDecided) {
        const lastIdx = cluster[cluster.length - 1];
        reviewState.pos = Math.min(lastIdx + 1, reviewState.queue.length - 1);
        persistReviewState();
    }
    showCurrentReviewImage();
}

/** 🆕 entry(jobId+resultIndex) 하나의 검수 결정을 되돌리는 공용 로직 — 단일모드/그리드모드 공용.
 *  좋음이었으면 대기열에 복귀, 검수완료 표시 해제. 반환값: 실제로 되돌렸으면 true. */
function undoReviewDecisionAt(queueIndex) {
    const entry = reviewState.queue[queueIndex];
    const dKey = entry && reviewEntryKey(entry);
    const decision = dKey && reviewState.decisions[dKey];
    if (!decision) return false;

    if (decision.type === 'good' && decision.fullyRemoved) {
        const insertAt = Math.min(decision.removedAtIndex, jobQueue.length);
        jobQueue.splice(insertAt, 0, decision.jobSnapshot);
        if (typeof renderJobQueue === 'function') renderJobQueue();
        if (window.appStateManager) window.appStateManager.debounceSave();
    }

    unmarkJobAsReviewed(dKey);
    delete reviewState.decisions[dKey];
    persistReviewState();
    return true;
}

/** 지금 보고 있는(이미 결정된) 항목의 검수를 되돌린다: 좋음이었으면 대기열에 복귀, 검수완료 표시 해제 */
function undoReviewDecision() {
    if (undoReviewDecisionAt(reviewState.pos)) showCurrentReviewImage();
}

/** 🆕 그리드 동시검수 모드: 그리드 셀의 "↩ 취소" 버튼에서 호출 */
function reviewUndoGridCell(queueIndex) {
    if (undoReviewDecisionAt(queueIndex)) showCurrentReviewImage();
}

/** 검수 중간에 종료 — 지금까지 결정한 것들은 그대로 유지되고, 나머지는 나중에 다시 열면 이어서 검수 가능 */
function cancelReview() {
    document.getElementById('review-modal').style.display = 'none';
}

document.addEventListener('keydown', (e) => {
    const area = document.getElementById('review-area');
    if (!area || area.style.display === 'none') return;
    if (isTypingInFormField()) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); reviewGoPrev(); }
    if (e.key === 'ArrowRight') { e.preventDefault(); if (isCurrentReviewPosDecided()) reviewGoNext(); else reviewDecide(true); }
});



/** "/" 키로 조각 검색창에 바로 포커스 (다른 입력창/모달이 열려있지 않을 때만) */
document.addEventListener('keydown', (e) => {
    if (e.key !== '/') return;
    const active = document.activeElement;
    const tag = active ? active.tagName : '';
    const isFormField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || (active && active.isContentEditable);
    if (isFormField) return;
    const openModal = Array.from(document.querySelectorAll('.modal-overlay'))
        .some(m => m.style.display && m.style.display !== 'none');
    if (openModal) return;
    const box = document.getElementById('item-search-box');
    if (box && box.style.display !== 'none') {
        e.preventDefault();
        box.focus();
    }
});

/* ──────────────────────────────────────────────
   🧭 큰 목차로 바로 이동 (빈 화면 클릭 → 숫자 입력으로 이동)
   - 숫자 하나만: 번호로 지정된 큰 섹션(설정/체크포인트/로라 등)으로 이동
   - "N,M" 또는 "N.M": 지금 작품의 N번째 그룹 → 그 안의 M번째 조각으로 이동
   - 글자+숫자(예: 행동78): 그룹 이름(부분일치)+조각번호로 이동 (기존 방식도 계속 지원)
   ────────────────────────────────────────────── */

/** 번호로 바로 이동할 수 있는 큰 섹션 목록 (전부 "이미지 생성" 탭 안에 있는 것만) */
const JUMP_SECTIONS = [
    { label: '공통 환경 설정', keyword: '공통 환경 설정' },
    { label: '고급 설정', keyword: '고급 설정' },
    { label: '베이스 프롬프트', keyword: '베이스 프롬프트' },
    { label: '참조 이미지(IP-Adapter)', keyword: '참조 이미지' },
    { label: '컨트롤넷', keyword: '컨트롤넷' },
    { label: 'Img2Img', keyword: '이미지 투 이미지' },
    { label: '인페인팅', keyword: '인페인팅' },
    { label: '후처리 옵션', keyword: '후처리' },
    { label: '대기열', keyword: '대기열' },
    { label: '프롬프트 라이브러리', keyword: '프롬프트 라이브러리' },
];

/** 🆕 상단 네비게이션 바에 섹션별 "빠른 이동" 아이콘을 붙인다.
 *  이미 있던 "Shift+숫자 = 미리보기 팝업 / 숫자만 = 실제 이동" 기능(JUMP_SECTIONS, peekSection, jumpToSection)을
 *  그대로 재사용 — 아이콘 클릭 = 팝업으로 미리보기, Ctrl(⌘)+클릭 = 그 섹션으로 실제 이동/스크롤. */
function ensureQuickJumpNavIcons() {
    const navLeft = document.querySelector('.navbar .nav-left');
    if (!navLeft || document.getElementById('quick-jump-icons')) return;

    const wrap = document.createElement('div');
    wrap.id = 'quick-jump-icons';
    wrap.style.cssText = 'display:flex; align-items:center; gap:2px; margin-left:8px; padding-left:8px; border-left:1px solid #444;';

    JUMP_SECTIONS.forEach(section => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = getSectionCollapseIcon(section.label);
        btn.title = `${section.label}\n클릭: 미리보기 팝업 / Ctrl+클릭: 이동`;
        btn.style.cssText = 'font-size:1.05em; padding:4px 7px; background:transparent; border:1px solid transparent; color:#ccc; cursor:pointer; border-radius:6px;';
        btn.onmouseenter = () => { btn.style.background = '#2a2a2a'; btn.style.borderColor = '#555'; };
        btn.onmouseleave = () => { btn.style.background = 'transparent'; btn.style.borderColor = 'transparent'; };
        btn.onclick = (e) => {
            if (e.ctrlKey || e.metaKey) {
                jumpToSection(section.keyword);
            } else {
                peekSection(section);
            }
        };
        wrap.appendChild(btn);
    });

    navLeft.appendChild(wrap);
}
document.addEventListener('DOMContentLoaded', () => setTimeout(ensureQuickJumpNavIcons, 300));
window.addEventListener('load', () => setTimeout(ensureQuickJumpNavIcons, 200));

function isTypingInFormField() {
    const active = document.activeElement;
    const tag = active ? active.tagName : '';
    return ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || (active && active.isContentEditable);
}

function isAnyModalOpen() {
    return Array.from(document.querySelectorAll('.modal-overlay'))
        .some(m => m.style.display && m.style.display !== 'none');
}

// 아무것도 포커스 안 된 상태에서 숫자(와 , .)를 그냥 입력하면, 잠깐 멈추는 순간 자동으로 이동됨.
// Shift를 누른 채 입력하면 화면 이동 없이 "미리보기 팝업"만 뜸.
// 이동창 없이 화면 오른쪽 아래에 지금 입력 중인 숫자만 작게 표시.
let numberJumpBuffer = '';
let numberJumpTimer = null;
let numberJumpShiftHeld = false;

function showNumberJumpIndicator(text, isPeek) {
    let el = document.getElementById('number-jump-indicator');
    if (!text) { if (el) el.remove(); return; }
    if (!el) {
        el = document.createElement('div');
        el.id = 'number-jump-indicator';
        el.style.cssText = `
            position:fixed; right:20px; bottom:20px; z-index:2000;
            font-size:1.1em; font-weight:bold; padding:8px 14px; border-radius:8px;
            box-shadow:0 4px 14px rgba(0,0,0,0.5);`;
        document.body.appendChild(el);
    }
    el.style.background = '#1c1c1c';
    el.style.border = isPeek ? '1px solid #FF9800' : '1px solid #4CAF50';
    el.style.color = isPeek ? '#FF9800' : '#4CAF50';
    el.textContent = (isPeek ? '👁 ' : '') + text;
}

document.addEventListener('keydown', (e) => {
    if (isTypingInFormField() || isAnyModalOpen()) return;

    // e.key는 Shift를 누르면 "1"→"!" 처럼 바뀌어버릴 수 있어서, 물리적 키 위치인 e.code로 판단한다
    const digitMatch = e.code.match(/^Digit([0-9])$/) || e.code.match(/^Numpad([0-9])$/);
    const isComma = e.code === 'Comma' || e.code === 'NumpadDecimal' || e.code === 'Period';

    if (digitMatch || isComma) {
        const char = digitMatch ? digitMatch[1] : ',';
        numberJumpBuffer += char;
        numberJumpShiftHeld = numberJumpShiftHeld || e.shiftKey;
        showNumberJumpIndicator(numberJumpBuffer, numberJumpShiftHeld);
        if (numberJumpTimer) clearTimeout(numberJumpTimer);
        numberJumpTimer = setTimeout(() => {
            const val = numberJumpBuffer;
            const wasShift = numberJumpShiftHeld;
            numberJumpBuffer = '';
            numberJumpShiftHeld = false;
            numberJumpTimer = null;
            showNumberJumpIndicator('');
            if (wasShift) peekJump(val); else executeJump(val);
        }, 500); // 0.5초간 추가 입력 없으면 자동 실행 (엔터 불필요)
        return;
    }

    if (e.key === 'Escape' && numberJumpBuffer) {
        numberJumpBuffer = '';
        numberJumpShiftHeld = false;
        if (numberJumpTimer) { clearTimeout(numberJumpTimer); numberJumpTimer = null; }
        showNumberJumpIndicator('');
    }
});

/**
 * 입력값을 분석해서 처리:
 * 1) "N,M" → 지금 작품의 N번째 그룹의 M번째 조각
 * 2) 숫자 하나만 → JUMP_SECTIONS의 N번째 섹션
 * 3) 글자+끝자리숫자(예: 행동78) → 그룹 이름(부분일치)+조각번호 (다른 곳에서 이 형식으로 호출 시에도 처리)
 */
function executeJump(raw) {
    if (!raw) return;

    const pairMatch = raw.match(/^(\d+)[,.](\d+)$/);
    if (pairMatch) {
        jumpToGroupItemByIndex(parseInt(pairMatch[1], 10), parseInt(pairMatch[2], 10));
        return;
    }

    if (/^\d+$/.test(raw)) {
        const idx = parseInt(raw, 10) - 1;
        const section = JUMP_SECTIONS[idx];
        if (!section) {
            alert(`${JUMP_SECTIONS.length}번까지만 있어요. (1~${JUMP_SECTIONS.length})`);
            return;
        }
        jumpToSection(section.keyword);
        return;
    }

    const nameMatch = raw.match(/^(.*?)(\d+)$/);
    if (nameMatch && nameMatch[1].trim()) {
        jumpToGroupItem(nameMatch[1].trim(), parseInt(nameMatch[2], 10));
        return;
    }

    jumpToSection(raw.trim());
}

/** 지금 작품의 N번째 그룹 → 그 안의 M번째 조각으로 이동 (번호 기반, 이름 몰라도 됨) */
function jumpToGroupItemByIndex(groupIndex, itemNumber) {
    const work = libraryData.works.find(w => w.id === activeWorkId) || libraryData.works[0];
    if (!work) return alert('열려있는 작품이 없습니다.');

    const cat = work.categories[groupIndex - 1];
    if (!cat) {
        alert(`"${work.name}" 작품에는 그룹이 ${work.categories.length}개뿐입니다. (${groupIndex}번째 그룹 없음)`);
        return;
    }
    if (itemNumber < 1 || itemNumber > cat.items.length) {
        alert(`"${cat.name}" 그룹에는 조각이 ${cat.items.length}개뿐입니다. (${itemNumber}번 없음)`);
        return;
    }

    const targetItem = cat.items[itemNumber - 1];
    goToLibraryFragment(cat.id, targetItem.id);
}

/** "그룹명(부분일치) + 조각 번호"로 바로 이동: 그룹을 열고, 그 안의 N번째 조각을 선택+스크롤 */
function jumpToGroupItem(groupQuery, itemNumber) {
    const q = groupQuery.toLowerCase();
    let found = null; // { work, cat }

    // 지금 작품 안에서 먼저 찾고, 없으면 전체 작품에서 찾음
    const activeWork = libraryData.works.find(w => w.id === activeWorkId);
    if (activeWork) {
        const cat = activeWork.categories.find(c => c.name.toLowerCase().includes(q));
        if (cat) found = { work: activeWork, cat };
    }
    if (!found) {
        for (const work of libraryData.works) {
            const cat = work.categories.find(c => c.name.toLowerCase().includes(q));
            if (cat) { found = { work, cat }; break; }
        }
    }

    if (!found) {
        alert(`"${groupQuery}" 라는 이름의 그룹을 찾을 수 없습니다.`);
        return;
    }
    if (itemNumber < 1 || itemNumber > found.cat.items.length) {
        alert(`"${found.cat.name}" 그룹에는 조각이 ${found.cat.items.length}개뿐입니다. (${itemNumber}번 없음)`);
        return;
    }

    const targetItem = found.cat.items[itemNumber - 1];
    goToLibraryFragment(found.cat.id, targetItem.id);
}

/** 큰 섹션(공통환경설정/대기열/체크포인트/로라/갤러리 등) 이름으로 바로 이동 */
function jumpToSection(keyword) {
    const k = keyword.toLowerCase();

    // 전부 "이미지 생성" 탭 안에 있는 섹션들이므로, 먼저 그 탭이 열려있게 함
    if (typeof openTab === 'function') openTab('tab-generate');

    // 1) 대기열은 특정 컨테이너로 스크롤 (접혀있으면 먼저 펼침 — 안 그러면 스크롤은
    //    되는데 display:none이라 아무것도 안 보이는 채로 "찾았는데 안 보인다" 상태가 됨)
    if (k.includes('대기열') || k.includes('큐') || k.includes('queue')) {
        const el = document.getElementById('job-queue-list');
        if (el) {
            const section = el.closest('.form-section');
            if (section && section.style && section.style.display === 'none' && typeof section._forceExpand === 'function') {
                section._forceExpand();
            }
            requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        }
        return;
    }

    // 2) 프롬프트 라이브러리는 <h2>라서 별도 처리
    if (k.includes('프롬프트') || k.includes('라이브러리')) {
        const el = document.getElementById('tab-prompt');
        if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        return;
    }

    // 3) 나머지는 제목(h2/h3) 텍스트로 찾아서 그 섹션(.form-section)으로 스크롤
    const headers = Array.from(document.querySelectorAll('#tab-generate h2, #tab-generate h3, h2, h3'));
    const match = headers.find(h => h.textContent.toLowerCase().includes(k));
    if (match) {
        const panel = match.closest('.tab-panel');
        if (panel && panel.id && typeof openTab === 'function') openTab(panel.id);
        const section = match.closest('.form-section') || match;
        // 접힌 섹션이면(display:none) 스크롤하기 전에 먼저 펼쳐야 실제로 보이고 조작도 가능함
        if (section.style && section.style.display === 'none' && typeof section._forceExpand === 'function') {
            section._forceExpand();
        }
        requestAnimationFrame(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        return;
    }

    alert(`"${keyword}" 에 해당하는 섹션을 찾을 수 없습니다.\n(예: 대기열, 공통 환경 설정, 컨트롤넷, 인페인팅, 후처리 등 — 전부 이미지 생성 탭 안의 항목)`);
}

/** Shift를 누른 채 숫자를 입력했을 때: 화면 이동 없이 팝업으로만 미리보기 */
function peekJump(raw) {
    if (!raw) return;

    const pairMatch = raw.match(/^(\d+)[,.](\d+)$/);
    if (pairMatch) {
        peekGroupItemByIndex(parseInt(pairMatch[1], 10), parseInt(pairMatch[2], 10));
        return;
    }

    if (/^\d+$/.test(raw)) {
        const idx = parseInt(raw, 10) - 1;
        const section = JUMP_SECTIONS[idx];
        if (!section) {
            alert(`${JUMP_SECTIONS.length}번까지만 있어요. (1~${JUMP_SECTIONS.length})`);
            return;
        }
        peekSection(section);
        return;
    }

    const nameMatch = raw.match(/^(.*?)(\d+)$/);
    if (nameMatch && nameMatch[1].trim()) {
        peekGroupItemByName(nameMatch[1].trim(), parseInt(nameMatch[2], 10));
    }
}

/** 팝업 오버레이 틀을 만들어서 body를 채워주고, 닫힐 때 정리 콜백을 실행한다 */
function openPeekPopup(title, bodyEl, onClose) {
    closePeekPopup();
    // 배경 전체를 덮는 오버레이가 아니라, 화면 한쪽에 떠있는 "창"으로 만든다 (뒤 화면 조작 가능하게)
    const box = document.createElement('div');
    box.id = 'peek-popup-overlay';
    box.style.cssText = `
        position:fixed; top:8vh; right:20px; z-index:2100;
        width:min(90vw, 640px); max-height:80vh; overflow-y:auto;
        background:#1c1c1c; border:1px solid #FF9800; border-radius:10px;
        box-shadow:0 8px 28px rgba(0,0,0,0.6);`;
    box._onClose = onClose || null;

    const header = document.createElement('div');
    header.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:10px 14px; border-bottom:1px solid #333; position:sticky; top:0; background:#1c1c1c; cursor:move; border-radius:10px 10px 0 0;';
    header.innerHTML = `<b style="color:#FF9800;">👁 ${title}</b> <span style="font-size:0.7em; color:#666; margin-left:8px;">(뒤 화면도 그대로 조작 가능)</span>`;
    const closeBtn = document.createElement('span');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'cursor:pointer; font-size:1.4em; color:#ff5555;';
    closeBtn.onclick = closePeekPopup;
    header.appendChild(closeBtn);

    // 헤더를 드래그해서 창 위치를 옮길 수 있게
    let dragging = false, offsetX = 0, offsetY = 0;
    header.addEventListener('mousedown', (e) => {
        if (e.target === closeBtn) return;
        dragging = true;
        const rect = box.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        box.style.right = 'auto';
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        box.style.left = (e.clientX - offsetX) + 'px';
        box.style.top = (e.clientY - offsetY) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });

    const body = document.createElement('div');
    body.style.cssText = 'padding:16px;';
    body.appendChild(bodyEl);

    box.appendChild(header);
    box.appendChild(body);
    document.body.appendChild(box);

    document.addEventListener('keydown', peekPopupEscHandler);
}

function peekPopupEscHandler(e) {
    if (e.key === 'Escape') closePeekPopup();
}

function closePeekPopup() {
    const overlay = document.getElementById('peek-popup-overlay');
    if (!overlay) return;
    if (typeof overlay._onClose === 'function') overlay._onClose();
    overlay.remove();
    document.removeEventListener('keydown', peekPopupEscHandler);
}

/** 조각 하나를 팝업으로 보기 — 실제로 수정도 가능 (이름/프롬프트를 고치면 자동저장됨) */
function showItemPeekPopup(work, cat, item, itemNumber) {
    const body = document.createElement('div');
    body.innerHTML = `
        <div style="margin-bottom:10px; color:#888; font-size:0.85em;">${work.name} / ${cat.name} — ${itemNumber}번</div>
        <input id="peek-item-name" type="text" value="${escapeHtml(item.name || '')}"
            style="width:100%; box-sizing:border-box; padding:6px 8px; margin-bottom:8px; background:#111; border:1px solid #333; border-radius:6px; color:#4CAF50; font-weight:bold;">
        <textarea id="peek-item-prompt" rows="6" placeholder="(빈 프롬프트)"
            style="width:100%; box-sizing:border-box; background:#111; border:1px solid #333; border-radius:6px; padding:10px; line-height:1.7; font-size:0.9em; color:#ddd; resize:vertical;">${escapeHtml(item.prompt || '')}</textarea>

        <div style="margin-top:14px; border-top:1px solid #444; padding-top:10px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                <label style="font-size:0.85em; color:#aaa;">이 조각 전용 로라 — 이 조각으로 생성할 때만 적용되고 화면 상단 설정은 그대로 유지됩니다</label>
                <button type="button" class="btn-secondary" id="peek-lora-add-btn" style="padding:3px 8px; font-size:0.8em; flex-shrink:0; margin-left:8px;">+ 로라 추가</button>
            </div>
            <div id="peek-item-loras" style="display:flex; flex-direction:column; gap:6px;"></div>
            <div style="font-size:0.78em; color:#666; margin-top:4px;">비워두면 평소처럼 화면 상단(공통) 로라 설정을 그대로 씁니다.</div>
        </div>

        <div style="display:flex; gap:8px; align-items:center; margin-top:12px;">
            <button id="peek-save-btn" class="btn-primary" style="padding:8px 14px;">💾 저장</button>
            <button id="peek-go-btn" class="btn-secondary" style="padding:8px 14px;">➡ 여기로 이동</button>
            <span id="peek-save-status" style="font-size:0.8em; color:#4CAF50;"></span>
        </div>
    `;

    const nameInput = () => document.getElementById('peek-item-name');
    const promptArea = () => document.getElementById('peek-item-prompt');

    /** ── 조각 전용 로라 목록 UI ── */
    const loraListEl = () => document.getElementById('peek-item-loras');

    const renderLoraRow = (entry, index) => {
        const row = document.createElement('div');
        row.className = 'lora-item';
        row.style.cssText = 'display:flex; align-items:center; gap:6px;';
        row.innerHTML = `<select style="flex:1;">${window.loraOptionsHTML || ''}</select>
            <input type="number" step="0.01" value="${entry.strength}" style="width:70px;">
            <button type="button" class="btn-secondary" style="padding:2px 8px;">X</button>`;
        const select = row.querySelector('select');
        select.value = entry.lora;
        const numInput = row.querySelector('input[type="number"]');
        const removeBtn = row.querySelector('button');

        const saveLoras = () => commitItemLoras();
        select.onchange = saveLoras;
        numInput.oninput = saveLoras;
        removeBtn.onclick = () => { row.remove(); commitItemLoras(); };

        return row;
    };

    const renderAllLoraRows = () => {
        const container = loraListEl();
        container.innerHTML = '';
        (item.loraOverride || []).forEach((entry, i) => container.appendChild(renderLoraRow(entry, i)));
    };

    /** 지금 팝업에 그려진 로라 행들을 읽어서 item.loraOverride에 저장 (비어있으면 필드 자체를 지움) */
    const commitItemLoras = () => {
        const rows = Array.from(loraListEl().querySelectorAll('.lora-item'));
        const list = rows.map(row => ({
            lora: row.querySelector('select').value,
            strength: parseFloat(row.querySelector('input[type="number"]').value) || 1
        })).filter(e => e.lora);

        if (list.length > 0) item.loraOverride = list;
        else delete item.loraOverride;

        if (typeof syncQueueJobsWithItem === 'function') syncQueueJobsWithItem(cat.id, item.id, item);
        if (typeof debounceLibrarySave === 'function') debounceLibrarySave();

        const statusEl = document.getElementById('peek-save-status');
        if (statusEl) { statusEl.textContent = '✓ 저장됨'; setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 1200); }
    };

    renderAllLoraRows();
    document.getElementById('peek-lora-add-btn').onclick = () => {
        if (!window.loraOptionsHTML) { alert('로라 목록이 아직 로딩되지 않았습니다. 잠시 후 다시 시도해 주세요.'); return; }
        const tempSelect = document.createElement('select');
        tempSelect.innerHTML = window.loraOptionsHTML;
        const firstOpt = Array.from(tempSelect.options).find(o => o.value);
        if (!firstOpt) { alert('선택 가능한 로라가 없습니다.'); return; }
        loraListEl().appendChild(renderLoraRow({ lora: firstOpt.value, strength: 1 }));
        commitItemLoras();
    };

    /** 이름/프롬프트가 바뀌었으면 실제 데이터에 반영 + 저장 (변경 없으면 아무 것도 안 함) */
    const commitChanges = () => {
        const nEl = nameInput(), pEl = promptArea();
        if (!nEl || !pEl) return; // 팝업이 이미 닫힌 뒤에 blur 등으로 다시 호출된 경우 방지
        const newName = nEl.value.trim();
        const newPrompt = pEl.value;
        if (newName === (item.name || '') && newPrompt === (item.prompt || '')) return; // 바뀐 게 없으면 스킵

        item.name = newName;
        item.prompt = newPrompt;
        if (item.variants && item.variants[item.activeVariant || 0]) {
            item.variants[item.activeVariant || 0].prompt = newPrompt;
        }
        if (typeof syncQueueJobsWithItem === 'function') syncQueueJobsWithItem(cat.id, item.id, item);
        if (typeof debounceLibrarySave === 'function') debounceLibrarySave();
        if (activeCategoryId === cat.id) renderItems(); // 지금 화면에 보이는 그룹이면 즉시 갱신

        const statusEl = document.getElementById('peek-save-status');
        if (statusEl) { statusEl.textContent = '✓ 저장됨'; setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 1200); }
    };

    // 팝업이 닫힐 때(X, Escape, 배경 클릭 등)도 마지막으로 한 번 더 저장 시도
    openPeekPopup(`${cat.name} #${itemNumber}`, body, commitChanges);

    // 입력창에서 포커스를 벗어날 때마다 자동저장 (엔터/저장 버튼 안 눌러도 안전하게)
    nameInput().addEventListener('blur', commitChanges);
    promptArea().addEventListener('blur', commitChanges);

    document.getElementById('peek-save-btn').onclick = commitChanges;
    document.getElementById('peek-go-btn').onclick = () => {
        commitChanges();
        closePeekPopup();
        goToLibraryFragment(cat.id, item.id);
    };
}

/** "N,M" 형식(그룹 번호+조각 번호)의 미리보기 */
function peekGroupItemByIndex(groupIndex, itemNumber) {
    const work = libraryData.works.find(w => w.id === activeWorkId) || libraryData.works[0];
    if (!work) return alert('열려있는 작품이 없습니다.');
    const cat = work.categories[groupIndex - 1];
    if (!cat) return alert(`"${work.name}" 작품에는 그룹이 ${work.categories.length}개뿐입니다.`);
    const item = cat.items[itemNumber - 1];
    if (!item) return alert(`"${cat.name}" 그룹에는 조각이 ${cat.items.length}개뿐입니다.`);
    showItemPeekPopup(work, cat, item, itemNumber);
}

/** "그룹이름+번호" 형식의 미리보기 */
function peekGroupItemByName(groupQuery, itemNumber) {
    const q = groupQuery.toLowerCase();
    let found = null;
    const activeWork = libraryData.works.find(w => w.id === activeWorkId);
    if (activeWork) {
        const cat = activeWork.categories.find(c => c.name.toLowerCase().includes(q));
        if (cat) found = { work: activeWork, cat };
    }
    if (!found) {
        for (const work of libraryData.works) {
            const cat = work.categories.find(c => c.name.toLowerCase().includes(q));
            if (cat) { found = { work, cat }; break; }
        }
    }
    if (!found) return alert(`"${groupQuery}" 라는 이름의 그룹을 찾을 수 없습니다.`);
    const item = found.cat.items[itemNumber - 1];
    if (!item) return alert(`"${found.cat.name}" 그룹에는 조각이 ${found.cat.items.length}개뿐입니다.`);
    showItemPeekPopup(found.work, found.cat, item, itemNumber);
}

/**
 * 섹션 번호 미리보기: 화면을 스크롤하지 않고, 그 섹션의 실제 DOM을 "잠깐 팝업 안으로 옮겨서" 보여준다.
 * 복제(clone)가 아니라 진짜 노드를 옮기는 방식이라 입력값 등 그대로 살아있고, 팝업 닫으면 원래 자리로 되돌아감.
 */
function peekSection(sectionEntry) {
    if (typeof openTab === 'function') openTab('tab-generate');

    // 🐛 버그 수정: '대기열' 노드(job-queue-list)는 renderJobQueue()가 매번 innerHTML을
    // 새로 써넣는 "살아있는" 실제 컨테이너라서, 아래쪽의 일반 이동 방식(원본 노드를 통째로
    // 팝업 안으로 옮겼다가 닫을 때 되돌리는 방식)을 쓰면 팝업이 비정상적으로 닫히는 경로에서
    // 노드가 원래 자리로 못 돌아와 대기열이 화면에서 사라지는 문제가 있었다.
    // → 대기열은 원본을 옮기지 않고, 항상 실시간 스냅샷(복제본)만 팝업에 보여주는 별도 경로로 처리.
    if (sectionEntry.keyword.includes('대기열')) {
        peekJobQueueSnapshot(sectionEntry.label);
        return;
    }

    let targetEl = null;
    if (sectionEntry.keyword.includes('프롬프트')) {
        targetEl = document.getElementById('tab-prompt');
    } else {
        const headers = Array.from(document.querySelectorAll('#tab-generate h2, #tab-generate h3, h2, h3'));
        const match = headers.find(h => h.textContent.toLowerCase().includes(sectionEntry.keyword.toLowerCase()));
        targetEl = match ? (match.closest('.form-section') || match) : null;
    }

    if (!targetEl) {
        alert(`"${sectionEntry.label}" 섹션을 찾을 수 없습니다.`);
        return;
    }

    // 🐛 수정: 이 노드가 지금 이미 미리보기 팝업 안에 들어가 있는 상태(=같은 아이콘을 팝업이
    // 열려있는 동안 한 번 더 누른 경우)에서 또 옮기려고 하면, openPeekPopup이 기존 팝업을
    // 먼저 닫으면서 그 팝업의 onClose가 "원래 자리"로 되돌리는데, 그 시점엔 이미 이 노드가
    // 새 팝업 쪽으로 옮겨진 뒤라 되돌아갈 "원래 부모"가 곧 사라질 옛 팝업 몸체가 되어버려서
    // 노드가 화면 어디에도 없는 채로 통째로 증발해버리던(이후 "찾을 수 없습니다" 계속 뜨던) 버그.
    // 이미 팝업 안에 있으면 다시 옮기지 않고 그냥 끝낸다(이미 보이고 있으니 할 일 없음).
    if (targetEl.closest('#peek-popup-overlay')) {
        return;
    }

    // 접힌 섹션이면 실제 노드가 display:none / 내부 입력요소 disabled 상태이므로
    // 팝업 안에서도 보이지도, 만져지지도 않는다 → 먼저 펼쳐서 진짜 상태로 만들어 둔다.
    if (targetEl.style && targetEl.style.display === 'none' && typeof targetEl._forceExpand === 'function') {
        targetEl._forceExpand();
    }

    const originalParent = targetEl.parentElement;
    const originalNextSibling = targetEl.nextSibling;
    const originalStyle = targetEl.getAttribute('style') || '';

    const body = document.createElement('div');
    body.appendChild(targetEl);
    targetEl.style.maxHeight = 'none';

    openPeekPopup(sectionEntry.label, body, () => {
        targetEl.setAttribute('style', originalStyle);
        if (originalNextSibling) originalParent.insertBefore(targetEl, originalNextSibling);
        else originalParent.appendChild(targetEl);
    });
}

/** 🆕 대기열 전용 미리보기: 실제 job-queue-list 노드는 절대 옮기지 않고, 지금 순간의
 *  내용만 복제해서 팝업에 보여준다. (실시간으로 갱신되진 않는 "스냅샷"이지만, 대신 원본
 *  큐 컨테이너가 사라지는 사고가 구조적으로 아예 발생할 수 없다.) */
function peekJobQueueSnapshot(label) {
    const original = document.getElementById('job-queue-list');
    if (!original) {
        alert(`"${label}" 섹션을 찾을 수 없습니다.`);
        return;
    }
    const body = document.createElement('div');
    body.innerHTML = original.innerHTML; // 복제(clone)일 뿐, 원본 노드는 그대로 제자리에 남음
    const note = document.createElement('div');
    note.style.cssText = 'font-size:0.75em; color:#888; margin-bottom:8px;';
    note.textContent = '📸 이 순간의 스냅샷입니다 (실시간 갱신 안 됨). 실제로 조작하려면 Ctrl+클릭으로 이동하세요.';
    body.insertBefore(note, body.firstChild);
    openPeekPopup(label, body, null); // 옮긴 게 없으므로 되돌릴 것도 없음 → onClose 불필요
}

/** 좌측 트리 하단("+ 그룹 추가" 옆)에 "전체 그룹 자동 병합" 버튼을 없으면 만들어 끼워넣는다 */
function ensureAutoMergeAllButton() {
    if (document.getElementById('btn-auto-merge-all')) return;
    const footer = document.querySelector('.tree-footer');
    if (!footer) return;
    const btn = document.createElement('button');
    btn.id = 'btn-auto-merge-all';
    btn.className = 'btn-secondary';
    btn.title = '모든 작품/그룹을 검사해서, 같은 그룹 안에서 이름이 같고 번호만 다른 조각들을 자동 병합 (그룹 자체는 합치지 않음)';
    btn.style.cssText = 'margin-left:6px;';
    btn.textContent = '🧩 전체 조각 자동 병합';
    btn.onclick = autoMergeAllCategories;
    footer.appendChild(btn);
}

/** 조각 이름 끝의 번호/버전 표시(숫자, .숫자, _숫자, (숫자), v숫자 등)를 제거해 그룹 묶기용 기준 이름을 뽑는다 */
function baseNameKey(name) {
    let n = (name || '').trim();
    n = n.replace(/[\s_\-.]*\(?v?\.?\s*\d+\)?\s*$/i, '').trim();
    return n;
}

/** 조각 이름 끝의 숫자를 추출 (버전 정렬용). 숫자가 없으면 맨 뒤로 보내기 위해 Infinity 반환 */
function extractVersionNumber(name) {
    const m = (name || '').trim().match(/(\d+)\s*\)?\s*$/);
    return m ? parseInt(m[1], 10) : Infinity;
}

/**
 * 특정 그룹(category) 안에서 이름 기준으로 자동 병합 가능한 묶음들을 찾는다.
 * 이미 병합된 조각(variants 보유)은 대상에서 제외.
 * @returns {[string, object[]][]} [기준이름, 해당 이름의 조각 배열][]
 */
function scanMergeableGroups(category) {
    const groups = {};
    category.items.forEach(item => {
        if (item.variants && item.variants.length > 1) return;
        const key = baseNameKey(item.name);
        if (!key) return;
        if (!groups[key]) groups[key] = [];
        groups[key].push(item);
    });
    return Object.entries(groups).filter(([, arr]) => arr.length > 1);
}

/** 특정 그룹(category) 안에서 조각 배열 하나를 실제로 병합 실행 (데이터만 변경, 렌더링/저장은 호출부 책임) */
function mergeGroupItems(category, key, arr) {
    // 이름 끝 숫자 기준 오름차순 정렬 → 오름차순으로 정렬해 번호 순서를 맞추고, 기본값은 맨 마지막(최신) 버전이 되도록
    const sortedArr = [...arr].sort((a, b) => extractVersionNumber(a.name) - extractVersionNumber(b.name));

    const variants = [];
    sortedArr.forEach(it => {
        if (it.variants && it.variants.length > 0) {
            it.variants.forEach(v => variants.push({ name: v.name, prompt: v.prompt }));
        } else {
            variants.push({ name: it.name, prompt: it.prompt });
        }
    });

    const catSet = selectedSet[category.id];
    const wasSelected = !!(catSet && arr.some(it => catSet.has(it.id)));
    const firstIdx = category.items.findIndex(i => i.id === arr[0].id);
    const mergedId = 'item_merged_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
    const lastIdx = variants.length - 1;
    const mergedItem = { id: mergedId, name: key, prompt: variants[lastIdx].prompt, variants, activeVariant: lastIdx };

    const reqSet = new Set();
    arr.forEach(it => (it.requires || []).forEach(r => reqSet.add(r)));
    if (reqSet.size > 0) mergedItem.requires = [...reqSet];

    const removeIds = new Set(arr.map(i => i.id));
    category.items = category.items.filter(i => !removeIds.has(i.id));
    const insertAt = Math.min(firstIdx, category.items.length);
    category.items.splice(insertAt, 0, mergedItem);

    if (selectedSet[category.id]) {
        removeIds.forEach(id => selectedSet[category.id].delete(id));
        if (wasSelected) selectedSet[category.id].add(mergedId);
        if (selectedSet[category.id].size === 0) delete selectedSet[category.id];
    }
}

function exitCompareModeIfActive() {
    if (!compareMode) return;
    compareMode = false;
    compareSelection.clear();
    const cbtn = document.getElementById('btn-compare-items');
    if (cbtn) { cbtn.textContent = '🔍 비교'; cbtn.style.background = ''; }
}

/**
 * 현재 활성 그룹의 조각들을 이름 기준으로 자동 스캔해서,
 * "기준 이름 + 번호"만 다른 조각들(예: 사과1, 사과2, 사과3...)을 찾아
 * 한번에 하나씩 병합한다 (버튼 한 번으로 여러 묶음을 동시에 처리).
 */
function autoMergeByName() {
    const category = getActiveCategory();
    if (!category) return;
    exitCompareModeIfActive();

    const mergeableGroups = scanMergeableGroups(category);
    if (mergeableGroups.length === 0) {
        alert('이름이 같고 번호만 다른(자동으로 묶을 수 있는) 조각이 없습니다.\n예: "사과1", "사과2", "사과3"');
        return;
    }

    const previewLines = mergeableGroups
        .map(([key, arr]) => `• "${key}" — ${arr.length}개 (${arr.map(i => i.name).join(', ')})`)
        .join('\n');
    if (!confirm(`아래 ${mergeableGroups.length}개 묶음을 자동으로 각각 하나씩 병합합니다:\n\n${previewLines}\n\n계속할까요?`)) return;

    mergeableGroups.forEach(([key, arr]) => mergeGroupItems(category, key, arr));

    saveSelectedSet();
    renderItems();
    renderBuilder();
    debounceLibrarySave();
    alert(`${mergeableGroups.length}개 묶음, 총 ${mergeableGroups.reduce((s, [, arr]) => s + arr.length, 0)}개 조각을 병합했습니다.`);
}

/**
 * 라이브러리 전체(모든 작품의 모든 그룹)를 대상으로 이름 기준 자동 병합을 한번에 실행한다.
 * 그룹이 여러 개여도 버튼 한 번으로 전부 처리.
 */
function autoMergeAllCategories() {
    const allCats = getAllCategories();
    if (allCats.length === 0) return alert('라이브러리에 그룹이 없습니다.');
    exitCompareModeIfActive();

    const perCategory = allCats
        .map(cat => ({ cat, groups: scanMergeableGroups(cat) }))
        .filter(entry => entry.groups.length > 0);

    if (perCategory.length === 0) {
        alert('전체 그룹을 검사했지만, 자동으로 묶을 수 있는(이름+번호 패턴) 조각이 있는 그룹이 없습니다.');
        return;
    }

    const totalGroups = perCategory.reduce((s, e) => s + e.groups.length, 0);
    const totalItems = perCategory.reduce((s, e) => s + e.groups.reduce((s2, [, arr]) => s2 + arr.length, 0), 0);
    const previewLines = perCategory
        .map(e => `▸ ${e.cat.name}: ${e.groups.length}개 묶음 (${e.groups.map(([k, arr]) => `${k}×${arr.length}`).join(', ')})`)
        .join('\n');

    if (!confirm(`전체 ${allCats.length}개 그룹을 검사한 결과:\n\n${previewLines}\n\n총 ${totalGroups}개 묶음 / ${totalItems}개 조각을 병합합니다.\n계속할까요?`)) return;

    perCategory.forEach(({ cat, groups }) => {
        groups.forEach(([key, arr]) => mergeGroupItems(cat, key, arr));
    });

    saveSelectedSet();
    renderWorkTree();
    renderItems();
    renderBuilder();
    debounceLibrarySave();
    alert(`${perCategory.length}개 그룹에서 총 ${totalGroups}개 묶음(${totalItems}개 조각)을 병합했습니다.`);
}


/** 비교 모드 on/off — 켜지면 조각 클릭 시 생성 선택이 아니라 비교 대상 선택으로 동작 */
function toggleCompareMode() {
    compareMode = !compareMode;
    compareSelection.clear();
    const btn = document.getElementById('btn-compare-items');
    if (btn) {
        btn.textContent = compareMode ? '✖ 비교 종료' : '🔍 비교';
        btn.style.background = compareMode ? '#c0392b' : '';
    }
    renderItems();
}

/** 비교 모드에서 조각 클릭 시 비교 대상 집합에 추가/제거 */
function toggleCompareSelection(itemId, event) {
    if (event) event.stopPropagation();
    if (compareSelection.has(itemId)) {
        compareSelection.delete(itemId);
    } else {
        compareSelection.add(itemId);
    }
    renderItems();
}

/** 화면 하단에 "N개 선택됨 — 비교하기" 플로팅 바를 렌더링 (비교 모드일 때만) */
function renderCompareBar() {
    let bar = document.getElementById('compare-float-bar');
    if (!compareMode || compareSelection.size < 1) {
        if (bar) bar.remove();
        return;
    }
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'compare-float-bar';
        bar.style.cssText = `
            position:fixed; bottom:20px; left:50%; transform:translateX(-50%);
            background:#2b2b2b; border:1px solid #FF9800; border-radius:8px;
            padding:10px 16px; display:flex; align-items:center; gap:12px;
            box-shadow:0 4px 12px rgba(0,0,0,0.4); z-index:500; font-size:0.9em; color:#fff;`;
        document.body.appendChild(bar);
    }
    bar.innerHTML = `
        <span>${compareSelection.size}개 선택됨</span>
        <button class="btn-primary" style="padding:6px 12px;" ${compareSelection.size < 2 ? 'disabled title="2개 이상 선택하세요"' : ''}
            onclick="openCompareModal()">📊 나란히 비교</button>
        <button class="btn-secondary" style="padding:6px 12px;" onclick="compareSelection.clear(); renderItems();">선택 해제</button>
    `;
}

/** 프롬프트를 콤마 기준으로 토큰화 (booru 태그 스타일 프롬프트 비교용) */
function tokenizePrompt(prompt) {
    return (prompt || '')
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0);
}

/** 선택된 조각들을 모달에 나란히 띄우고, 다른 것들에는 없는 태그를 강조 표시 */
function openCompareModal() {
    const category = getActiveCategory();
    if (!category || compareSelection.size < 2) return;
    const items = category.items.filter(i => compareSelection.has(i.id));
    if (items.length < 2) return;

    // 각 조각의 토큰 집합 계산 → 모든 조각에 공통으로 등장하는 태그는 흐리게, 그렇지 않은(차이나는) 태그는 강조
    const tokenSets = items.map(it => new Set(tokenizePrompt(it.prompt)));
    const commonTokens = [...tokenSets[0]].filter(t => tokenSets.every(s => s.has(t)));
    const commonSet = new Set(commonTokens);

    if (!document.getElementById('compare-modal')) {
        const modal = document.createElement('div');
        modal.id = 'compare-modal';
        modal.className = 'modal-overlay';
        modal.style.cssText = 'display:none;';
        modal.onclick = function (e) { if (e.target === this) closeCompareModal(); };
        document.body.appendChild(modal);
    }
    const modal = document.getElementById('compare-modal');

    const cardsHtml = items.map(item => {
        const tokens = tokenizePrompt(item.prompt);
        const tokensHtml = tokens.length > 0
            ? tokens.map(t => {
                const isCommon = commonSet.has(t);
                return `<span style="
                    display:inline-block; margin:2px; padding:2px 6px; border-radius:4px; font-size:0.82em;
                    ${isCommon ? 'color:#888; background:#2a2a2a;' : 'color:#FF9800; background:#3a2a10; font-weight:bold;'}
                ">${escapeHtml(t)}</span>`;
            }).join('')
            : '<span style="color:#666; font-size:0.85em;">(빈 프롬프트)</span>';
        const variantTag = (item.variants && item.variants.length > 1)
            ? `<span style="font-size:0.75em; color:#888; margin-left:6px;">(이미 ${item.variants.length}개 버전 병합됨)</span>` : '';

        return `
            <div style="flex:1; min-width:260px; background:#222; border:1px solid #444; border-radius:8px; padding:12px; display:flex; flex-direction:column; gap:8px;">
                <div style="font-weight:bold; color:#4CAF50;">${escapeHtml(item.name)}${variantTag}</div>
                <div style="line-height:1.9;">${tokensHtml}</div>
                <a href="#" style="margin-top:auto; font-size:0.78em; color:#888; text-decoration:underline;"
                   onclick="event.preventDefault(); useCompareChoice('${item.id}');">이 버전만 남기고 나머지는 목록에서 제외</a>
            </div>`;
    }).join('');

    modal.innerHTML = `
        <div class="modal-content" onclick="event.stopPropagation()" style="width:min(90vw, 900px); max-height:85vh; overflow-y:auto;">
            <div class="modal-header">
                <h3 style="margin:0; color:#4CAF50;">📊 조각 비교 — ${escapeHtml(category.name)} (${items.length}개)</h3>
                <span class="close-btn" style="position:static; font-size:1.5em; color:#ff5555;" onclick="closeCompareModal()">&times;</span>
            </div>
            <div class="modal-body">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin-bottom:10px;
                            background:#1c2a1c; border:1px solid #4CAF50; border-radius:6px; padding:10px 12px;">
                    <span style="font-size:0.85em; color:#ccc;">
                        🔗 이 ${items.length}개를 <b>하나의 조각</b>으로 합치고, 목록에서 버튼 하나로 버전을 전환하고 싶다면:
                    </span>
                    <button class="btn-primary" style="padding:8px 14px; white-space:nowrap;" onclick="mergeCompareSelection()">🔗 하나로 합치기</button>
                </div>
                <p style="font-size:0.82em; color:#aaa; margin:0 0 10px;">
                    <span style="color:#888;">회색</span> = 모든 버전에 공통된 태그 · <span style="color:#FF9800; font-weight:bold;">주황색</span> = 버전마다 다른(차이나는) 태그
                </p>
                <div style="display:flex; gap:12px; flex-wrap:wrap;">${cardsHtml}</div>
            </div>
        </div>`;
    modal.style.display = 'flex';
}

function closeCompareModal() {
    const modal = document.getElementById('compare-modal');
    if (modal) modal.style.display = 'none';
}

/** 비교 모달에서 "이 버전 사용" 클릭 시 → 해당 조각만 생성 선택으로 지정하고 비교 모드 종료 */
function useCompareChoice(itemId) {
    if (!activeCategoryId) return;
    selectedSet[activeCategoryId] = new Set([itemId]);
    saveSelectedSet();
    closeCompareModal();
    compareMode = false;
    compareSelection.clear();
    const btn = document.getElementById('btn-compare-items');
    if (btn) { btn.textContent = '🔍 비교'; btn.style.background = ''; }
    renderItems();
    renderBuilder();
}

/** 간단한 HTML 이스케이프 (비교 모달 렌더링용) */
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/**
 * 비교 중인 여러 조각을 "버전 전환 가능한 하나의 조각"으로 합친다.
 * 원본 조각들은 목록에서 사라지고, 그 자리에 병합된 조각 하나만 남는다.
 * 목록에서 🔁 버튼을 눌러 병합된 버전들 사이를 오갈 수 있다.
 */
function mergeCompareSelection() {
    const category = getActiveCategory();
    if (!category || compareSelection.size < 2) return;
    const items = category.items.filter(i => compareSelection.has(i.id));
    if (items.length < 2) return;

    if (!confirm(`${items.length}개의 조각을 하나로 합칩니다.\n원본 조각들은 목록에서 사라지고, 합쳐진 조각 하나에서 🔁 버튼으로 버전을 전환하게 됩니다.\n계속할까요?`)) return;

    // 이미 합쳐진 조각이 비교 대상에 섞여 있으면 그 안의 버전들도 함께 펼쳐서 합친다 (병합의 병합 지원)
    // 이름 끝 숫자 기준 오름차순 정렬 → 오름차순으로 정렬해 번호 순서를 맞추고, 기본값은 맨 마지막(최신) 버전이 되도록
    const sortedItems = [...items].sort((a, b) => extractVersionNumber(a.name) - extractVersionNumber(b.name));
    const variants = [];
    sortedItems.forEach(it => {
        if (it.variants && it.variants.length > 0) {
            it.variants.forEach(v => variants.push({ name: v.name, prompt: v.prompt }));
        } else {
            variants.push({ name: it.name, prompt: it.prompt });
        }
    });

    const wasSelected = !!(selectedSet[activeCategoryId] && items.some(it => selectedSet[activeCategoryId].has(it.id)));

    const firstIdx = category.items.findIndex(i => i.id === items[0].id);
    const mergedId = 'item_merged_' + Date.now();
    const lastIdx = variants.length - 1;
    const mergedItem = {
        id: mergedId,
        name: guessMergedName(items.map(i => i.name)),
        prompt: variants[lastIdx].prompt,
        variants: variants,
        activeVariant: lastIdx
    };

    // requires(부모 제약 조건)는 병합 대상들의 합집합으로 유지
    const reqSet = new Set();
    items.forEach(it => (it.requires || []).forEach(r => reqSet.add(r)));
    if (reqSet.size > 0) mergedItem.requires = [...reqSet];

    const removeIds = new Set(items.map(i => i.id));
    category.items = category.items.filter(i => !removeIds.has(i.id));
    const insertAt = Math.min(firstIdx, category.items.length);
    category.items.splice(insertAt, 0, mergedItem);

    if (selectedSet[activeCategoryId]) {
        removeIds.forEach(id => selectedSet[activeCategoryId].delete(id));
        if (wasSelected) selectedSet[activeCategoryId].add(mergedId);
        if (selectedSet[activeCategoryId].size === 0) delete selectedSet[activeCategoryId];
    }

    closeCompareModal();
    compareMode = false;
    compareSelection.clear();
    const btn = document.getElementById('btn-compare-items');
    if (btn) { btn.textContent = '🔍 비교'; btn.style.background = ''; }
    saveSelectedSet();
    renderItems();
    renderBuilder();
    debounceLibrarySave();
}

/** 합쳐질 조각들의 이름을 보고 대표 이름을 추측 (가장 많이 겹치는 이름 우선, 없으면 버전 표시만 제거) */
function guessMergedName(names) {
    const freq = {};
    names.forEach(n => { freq[n] = (freq[n] || 0) + 1; });
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0 && sorted[0][1] > 1) return sorted[0][0];
    return (names[0] || '').replace(/^\s*\d+[.)]\s*/, '').replace(/[\s_\-]*\(?v?\.?\s*\d+\)?\s*$/i, '').trim() || names[0];
}

/** 병합된 조각의 현재 표시 버전을 전환. dir: 1=다음 버전, -1=이전 버전 */
function cycleVariant(catId, itemId, dir) {
    const work = getActiveWork();
    const category = work ? work.categories.find(c => c.id === catId) : null;
    if (!category) return;
    const item = category.items.find(i => i.id === itemId);
    if (!item || !item.variants || item.variants.length < 2) return;

    const step = (dir === -1) ? -1 : 1;
    const len = item.variants.length;
    item.activeVariant = ((item.activeVariant || 0) + step + len) % len;
    item.prompt = item.variants[item.activeVariant].prompt;

    renderItems();
    renderBuilder();
    debounceLibrarySave();
}

/** 병합된 조각을 다시 개별 조각들로 분리 (편집 모달에서 호출) */
function splitMergedItem(itemId) {
    const category = getActiveCategory();
    if (!category) return;
    const item = category.items.find(i => i.id === itemId);
    if (!item || !item.variants || item.variants.length < 2) return;
    if (!confirm('이 조각을 각 버전별 개별 조각으로 다시 분리할까요?')) return;

    const idx = category.items.findIndex(i => i.id === itemId);
    const newItems = item.variants.map((v, i) => ({
        id: 'item_' + Date.now() + '_' + i,
        name: v.name || `${item.name} ${i + 1}`,
        prompt: v.prompt,
        ...(item.requires ? { requires: [...item.requires] } : {})
    }));
    category.items.splice(idx, 1, ...newItems);

    if (selectedSet[activeCategoryId] && selectedSet[activeCategoryId].has(itemId)) {
        selectedSet[activeCategoryId].delete(itemId);
        selectedSet[activeCategoryId].add(newItems[item.activeVariant || 0].id);
    }

    document.getElementById('prompt-edit-modal').style.display = 'none';
    renderItems();
    renderBuilder();
    debounceLibrarySave();
}

/* ──────────────────────────────────────────────
   병합된 조각의 버전 범위 지정 대기열 전송
   ────────────────────────────────────────────── */

/** 병합된 조각 하나의 여러 버전 중 범위를 지정해 한번에 대기열로 보내는 모달을 연다 */
function openVariantRangeSendModal(catId, itemId) {
    const cat = getAllCategories().find(c => c.id === catId);
    const item = cat && cat.items.find(i => i.id === itemId);
    if (!item || !item.variants || item.variants.length < 2) return;

    if (!document.getElementById('variant-range-modal')) {
        const modal = document.createElement('div');
        modal.id = 'variant-range-modal';
        modal.className = 'modal-overlay';
        modal.style.cssText = 'display:none;';
        modal.onclick = function (e) { if (e.target === this) closeVariantRangeSendModal(); };
        modal.innerHTML = `
            <div class="modal-content" onclick="event.stopPropagation()" style="width:420px;">
                <div class="modal-header">
                    <h3 id="variant-range-title" style="margin:0; color:#4CAF50;">📥 버전 범위 전송</h3>
                    <span class="close-btn" style="position:static; font-size:1.5em; color:#ff5555;" onclick="closeVariantRangeSendModal()">&times;</span>
                </div>
                <div class="modal-body" style="display:flex; flex-direction:column; gap:10px;">
                    <p id="variant-range-list" style="font-size:0.8em; color:#aaa; margin:0; line-height:1.6;"></p>
                    <div>
                        <label style="font-size:0.85em; color:#ccc;">보낼 버전 번호 (예: <code>1~3</code>, <code>1, 3, 5~6</code>)</label>
                        <input type="text" id="variant-range-input" placeholder="비우면 전체 버전"
                            oninput="updateVariantRangePreview()"
                            style="width:100%; box-sizing:border-box; padding:6px; margin-top:4px; background:#222; border:1px solid #555; color:#fff; border-radius:4px;">
                    </div>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <label style="font-size:0.9em; color:#aaa; white-space:nowrap;">버전당 반복 장수:</label>
                        <input type="number" id="variant-range-repeat" value="1" min="1"
                            style="width:60px; padding:4px; background:#222; border:1px solid #555; color:#fff; border-radius:4px;">
                    </div>
                    <div id="variant-range-preview" style="font-size:0.8em; color:#FF9800; min-height:18px;"></div>
                    <button class="btn-primary" onclick="executeVariantRangeSend()" style="padding:12px; margin-top:4px;">
                        📥 대기열에 전송
                    </button>
                </div>
            </div>`;
        document.body.appendChild(modal);
    }

    document.getElementById('variant-range-modal').dataset.catId = catId;
    document.getElementById('variant-range-modal').dataset.itemId = itemId;
    document.getElementById('variant-range-title').textContent = `📥 버전 범위 전송 — ${item.name}`;
    document.getElementById('variant-range-list').innerHTML = item.variants
        .map((v, i) => `<b>${i + 1}.</b> ${escapeHtml(v.name || '(이름없음)')} — ${escapeHtml((v.prompt || '').slice(0, 40))}${(v.prompt || '').length > 40 ? '…' : ''}`)
        .join('<br>');
    document.getElementById('variant-range-input').value = '';
    const globalRepeat = document.getElementById('global-repeat-count')?.value || '1';
    document.getElementById('variant-range-repeat').value = globalRepeat;
    document.getElementById('variant-range-modal').style.display = 'flex';
    updateVariantRangePreview();
    requestAnimationFrame(() => document.getElementById('variant-range-input').focus());
}

function closeVariantRangeSendModal() {
    const modal = document.getElementById('variant-range-modal');
    if (modal) modal.style.display = 'none';
}

/** 입력한 범위 문자열을 실시간 파싱해 몇 건이 전송될지 미리보기 (비워두면 전체) */
function updateVariantRangePreview() {
    const modal = document.getElementById('variant-range-modal');
    const cat = getAllCategories().find(c => c.id === modal.dataset.catId);
    const item = cat && cat.items.find(i => i.id === modal.dataset.itemId);
    if (!item) return;
    const raw = document.getElementById('variant-range-input').value;
    const indices = raw.trim() ? parseRangeString(raw, item.variants.length) : item.variants.map((_, i) => i);
    document.getElementById('variant-range-preview').textContent =
        indices.length > 0 ? `→ ${indices.length}개 버전이 전송됩니다 (${indices.map(i => i + 1).join(', ')})` : '해당하는 버전이 없습니다.';
}

/** 범위에 해당하는 버전들을 각각 개별 job으로 대기열에 추가 */
function executeVariantRangeSend() {
    resetSeedGroupRollsForBatch();
    const modal = document.getElementById('variant-range-modal');
    const catId = modal.dataset.catId;
    const cat = getAllCategories().find(c => c.id === catId);
    const item = cat && cat.items.find(i => i.id === modal.dataset.itemId);
    if (!item) return;

    const raw = document.getElementById('variant-range-input').value;
    const indices = raw.trim() ? parseRangeString(raw, item.variants.length) : item.variants.map((_, i) => i);
    if (indices.length === 0) return alert('전송할 버전이 없습니다. 범위를 확인해 주세요.');

    let rCount = parseInt(document.getElementById('variant-range-repeat')?.value || '1');
    if (isNaN(rCount) || rCount < 1) rCount = 1;

    indices.forEach((vIdx, i) => {
        const variant = item.variants[vIdx];
        const jobData = {
            id: Date.now() + i,
            labels: { [cat.name]: `${item.name} (v${vIdx + 1}${variant.name ? ' ' + variant.name : ''})` },
            fullPrompt: [variant.prompt],
            sourceRefs: [{ catId: cat.id, itemId: item.id, variantIndex: vIdx }],
            repeatCount: rCount
        };
        // 🆕 이 조각에 "기본 반복 횟수"가 지정돼 있으면 위의 전역 반복횟수 입력값 대신 그걸 우선 사용
        const itemRepeat = getItemDefaultRepeatCount(item);
        if (itemRepeat !== null) jobData.repeatCount = itemRepeat;
        const loraOverride = getItemLoraOverride(item);
        if (loraOverride.length > 0) jobData.loraOverride = loraOverride;
        const img2imgOverride = getItemSingleOverride(item, 'img2imgOverride');
        if (img2imgOverride) jobData.img2imgOverride = img2imgOverride;
        const controlnetOverride = getItemSingleOverride(item, 'controlnetOverride');
        if (controlnetOverride) jobData.controlnetOverride = controlnetOverride;
        const censorOverride = getItemSingleOverride(item, 'censorOverride');
        if (censorOverride) jobData.censorOverride = censorOverride;
        const negativeOverride = getItemNegativeOverride(item).join(', ');
        if (negativeOverride) jobData.negativeOverride = negativeOverride;
        const seedGroupSeed = getOrRollSeedForItem(item);
        if (seedGroupSeed !== null) jobData.seedGroupSeed = seedGroupSeed;
        if (item.backViewFaceWeightDown) jobData.backViewFaceWeightDown = true;
        addJobToQueue(jobData);
    });

    closeVariantRangeSendModal();
    document.getElementById('mode-batch').checked = true;
    toggleGenMode();
    alert(`${indices.length}개 버전이 대기열에 추가되었습니다.`);
}

/* ──────────────────────────────────────────────
   그룹 내 조각 일괄 수정 (찾아바꾸기)
   ────────────────────────────────────────────── */

/** "조각 목록" 헤더에 일괄수정(🔁) 버튼이 없으면 만들어서 +새조각 버튼 옆에 끼워넣는다 */
function ensureBulkEditButton() {
    ensureToolsMenu();
    addToolsMenuItem(
        'btn-bulk-edit', '🔁', '일괄 수정',
        '그룹 내 모든 조각의 프롬프트 일괄 찾아바꾸기',
        openBulkEditModal
    );
}

/** 일괄 수정 모달을 열고(없으면 생성) 현재 그룹 기준으로 내용을 초기화 */
function openBulkEditModal() {
    const category = getActiveCategory();
    if (!category) return;

    if (!document.getElementById('bulk-edit-modal')) {
        const modal = document.createElement('div');
        modal.id = 'bulk-edit-modal';
        modal.className = 'modal-overlay';
        modal.style.cssText = 'display:none;';
        modal.onclick = function (e) { if (e.target === this) closeBulkEditModal(); };
        modal.innerHTML = `
            <div class="modal-content" onclick="event.stopPropagation()" style="width:480px; max-height:80vh; overflow-y:auto;">
                <div class="modal-header">
                    <h3 id="bulk-edit-title" style="margin:0; color:#4CAF50;">🔁 일괄 수정</h3>
                    <span class="close-btn" style="position:static; font-size:1.5em; color:#ff5555;" onclick="closeBulkEditModal()">&times;</span>
                </div>
                <div class="modal-body" style="display:flex; flex-direction:column; gap:10px;">
                    <p style="font-size:0.85em; color:#aaa; margin:0;">
                        이 그룹의 <b>모든 조각(prompt)</b>에서 아래 텍스트를 찾아 바꿉니다.
                    </p>
                    <div>
                        <label style="font-size:0.85em; color:#ccc;">찾을 텍스트</label>
                        <input type="text" id="bulk-edit-find" placeholder="예: 1girl"
                            oninput="updateBulkEditPreview()"
                            style="width:100%; box-sizing:border-box; padding:6px; margin-top:4px; background:#222; border:1px solid #555; color:#fff; border-radius:4px;">
                    </div>
                    <div>
                        <label style="font-size:0.85em; color:#ccc;">바꿀 텍스트</label>
                        <input type="text" id="bulk-edit-replace" placeholder="예: 1woman"
                            oninput="updateBulkEditPreview()"
                            style="width:100%; box-sizing:border-box; padding:6px; margin-top:4px; background:#222; border:1px solid #555; color:#fff; border-radius:4px;">
                    </div>
                    <label style="display:flex; align-items:center; gap:6px; font-size:0.85em; color:#ccc; cursor:pointer;">
                        <input type="checkbox" id="bulk-edit-case-sensitive" onchange="updateBulkEditPreview()">
                        대소문자 구분
                    </label>
                    <div id="bulk-edit-preview" style="font-size:0.8em; color:#FF9800; min-height:18px;"></div>
                    <button class="btn-primary" onclick="executeBulkEdit()" style="padding:12px; margin-top:4px;">
                        ✅ 일괄 적용
                    </button>
                </div>
            </div>`;
        document.body.appendChild(modal);
    }

    document.getElementById('bulk-edit-title').textContent = `🔁 일괄 수정 — ${category.name}`;
    document.getElementById('bulk-edit-find').value = '';
    document.getElementById('bulk-edit-replace').value = '';
    document.getElementById('bulk-edit-case-sensitive').checked = false;
    document.getElementById('bulk-edit-preview').textContent = '';
    document.getElementById('bulk-edit-modal').style.display = 'flex';
    requestAnimationFrame(() => document.getElementById('bulk-edit-find').focus());
}

function closeBulkEditModal() {
    const modal = document.getElementById('bulk-edit-modal');
    if (modal) modal.style.display = 'none';
}

/** 찾을 텍스트를 이스케이프해서 안전한 정규식으로 만든다 (일반 텍스트 찾아바꾸기용) */
function escapeRegExpLiteral(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 입력값 기준으로 몇 개 조각의 몇 곳이 바뀔지 미리 계산해서 보여준다 */
function updateBulkEditPreview() {
    const category = getActiveCategory();
    const findText = document.getElementById('bulk-edit-find').value;
    const preview = document.getElementById('bulk-edit-preview');
    if (!category || !findText) {
        preview.textContent = '';
        return;
    }
    const caseSensitive = document.getElementById('bulk-edit-case-sensitive').checked;
    const re = new RegExp(escapeRegExpLiteral(findText), caseSensitive ? 'g' : 'gi');

    let itemHits = 0;
    let totalHits = 0;
    category.items.forEach(item => {
        const matches = (item.prompt || '').match(re);
        if (matches && matches.length > 0) {
            itemHits++;
            totalHits += matches.length;
        }
    });

    preview.textContent = totalHits > 0
        ? `→ 조각 ${itemHits}개, 총 ${totalHits}곳이 바뀝니다.`
        : '일치하는 항목이 없습니다.';
}

/** 모달 확인 버튼: 현재 그룹의 모든 조각 prompt에 찾아바꾸기 적용 */
function executeBulkEdit() {
    const category = getActiveCategory();
    if (!category) return;

    const findText = document.getElementById('bulk-edit-find').value;
    const replaceText = document.getElementById('bulk-edit-replace').value;
    if (!findText) { alert("찾을 텍스트를 입력해 주세요."); return; }

    const caseSensitive = document.getElementById('bulk-edit-case-sensitive').checked;
    const re = new RegExp(escapeRegExpLiteral(findText), caseSensitive ? 'g' : 'gi');

    let itemHits = 0;
    let totalHits = 0;
    category.items.forEach(item => {
        const original = item.prompt || '';
        const matches = original.match(re);
        if (matches && matches.length > 0) {
            itemHits++;
            totalHits += matches.length;
            item.prompt = original.replace(re, replaceText);
        }
    });

    if (totalHits === 0) {
        alert("일치하는 항목이 없습니다.");
        return;
    }

    closeBulkEditModal();
    renderItems();
    renderBuilder();
    debounceLibrarySave();
    alert(`조각 ${itemHits}개, 총 ${totalHits}곳을 변경했습니다.`);
}

/** 조각 삭제 */
function deleteItem(e, id) {
    if (e) e.stopPropagation();
    if (!confirm(`'${id}' 조각을 삭제하시겠습니까?`)) return;
    const category = getActiveCategory();
    if (!category) return;
    category.items = category.items.filter(i => i.id !== id);
    if (selectedSet[activeCategoryId] === id) delete selectedSet[activeCategoryId];
    compareSelection.delete(id);
    renderItems();
    renderBuilder();
    debounceLibrarySave();
}

/** 🙈 이 조각이 포함된 프롬프트에서 얼굴 관련 태그 가중치를 0.5로 낮출지 켜고/끈다
 *  (후방/뒷모습 구도 조각에 켜두면, 대기열 실행 시 자동으로 얼굴 태그 가중치가 내려감). */
/**
 * 조각을 선택 세트에 추가/제거.
 * 일반 클릭: 단일 토글, Shift 클릭: 같은 그룹 내 다중 추가/해제
 * (목록 전체를 다시 그리지 않고 클래스만 토글 — 스크롤 점프/더블클릭 오작동 방지)
 */
function selectItemToSet(itemId, event) {
    if (!activeCategoryId) return;
    const isShift = event && event.shiftKey;
    const isCtrl = event && (event.ctrlKey || event.metaKey);

    if (!selectedSet[activeCategoryId]) selectedSet[activeCategoryId] = new Set();
    const catSet = selectedSet[activeCategoryId];

    if (isShift && isCtrl) {
        // Shift+Ctrl+클릭: 이 그룹은 "합치기 모드" — 선택한 항목들을 전부 하나로 합쳐서 사용
        combineMode[activeCategoryId] = true;
        if (catSet.has(itemId)) catSet.delete(itemId);
        else catSet.add(itemId);
    } else if (isShift) {
        // Shift만: 기존 방식 — 선택한 항목들을 서로 다른 대안(택1)으로 사용
        combineMode[activeCategoryId] = false;
        if (catSet.has(itemId)) catSet.delete(itemId);
        else catSet.add(itemId);
    } else {
        combineMode[activeCategoryId] = false;
        if (catSet.size === 1 && catSet.has(itemId)) {
            catSet.clear();
        } else {
            catSet.clear();
            catSet.add(itemId);
        }
    }

    if (catSet.size === 0) { delete selectedSet[activeCategoryId]; delete combineMode[activeCategoryId]; }

    updateItemSelectionClasses();
    renderBuilder();
    saveSelectedSet();
}

/** #item-list를 다시 그리지 않고 현재 selectedSet 상태에 맞춰 .selected 클래스만 토글 */
function updateItemSelectionClasses() {
    const list = document.getElementById('item-list');
    if (!list) return;
    const catSet = selectedSet[activeCategoryId];
    list.querySelectorAll('.prompt-tag').forEach(tag => {
        const isSel = !!(catSet && catSet.has(tag.dataset.itemId));
        tag.classList.toggle('selected', isSel);
    });
}

/** 목록 전체를 다시 그리지 않고, 특정 조각(itemId)의 숨겨진 프롬프트 값 텍스트만 갱신 (대기열 편집 동기화용) */
function updateItemPromptDisplay(itemId, newPrompt) {
    const list = document.getElementById('item-list');
    if (!list) return;
    const tag = list.querySelector(`.prompt-tag[data-item-id="${itemId}"]`);
    if (!tag) return;
    const valueSpan = tag.querySelector('.tag-value');
    if (valueSpan) valueSpan.textContent = newPrompt;
}

/* ──────────────────────────────────────────────
   검색
   ────────────────────────────────────────────── */

/** 🐛 검색용 정규화: 소문자 + 밑줄(_)을 공백으로 + 연속 공백을 하나로.
 *  영어 태그는 "long_hair"와 "long hair"가 섞여 쓰이는데, 예전엔 글자 그대로 비교해서
 *  공백으로 저장된 프롬프트를 "long_hair"로 찾거나(또는 그 반대) "long_"까지 쳐도 못 찾았다.
 *  (일부러 trim은 안 함: "red_"처럼 밑줄로 끝나는 검색어는 "red 뒤에 뭔가 더 있는 태그"를 뜻하므로 끝 공백을 보존) */
function normalizeForSearch(s) {
    return String(s || '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
}
/** 조각 이름/프롬프트에 검색어가 들어있는지 ("_"와 공백은 같은 글자로 취급) */
function itemMatchesSearch(item, query) {
    const nq = normalizeForSearch(query);
    return normalizeForSearch(item.name).includes(nq) || normalizeForSearch(item.prompt).includes(nq);
}

/** 조각 목록을 검색어로 필터링하여 보이기/숨기기 처리 */
function filterPromptTags() {
    const input = document.getElementById('prompt-search-input');
    if (!input) return;
    const filter = input.value.toLowerCase().trim();
    document.querySelectorAll('#item-list .prompt-tag').forEach(tag => {
        tag.style.display = normalizeForSearch(tag.innerText).includes(normalizeForSearch(filter)) ? 'flex' : 'none';
    });
}

/* ──────────────────────────────────────────────
   세트 빌더 (선택 미리보기 & 배치 전송)
   ────────────────────────────────────────────── */

/** 선택된 모든 조각을 초기화 */
function clearSelectedSet() {
    selectedSet = {};
    renderItems();
    renderBuilder();
    saveSelectedSet();
}

/**
 * 여러 배열의 직교곱(Cartesian Product)을 생성.
 * 배치 전송 시 다중 선택된 그룹들의 모든 조합을 계산하는 데 사용된다.
 */
function cartesianProduct(arrays) {
    if (arrays.length === 0) return [[]];
    return arrays.reduce((acc, curr) => {
        const result = [];
        acc.forEach(a => curr.forEach(b => result.push([...a, b])));
        return result;
    }, [[]]);
}

/**
 * 조합 내 모든 requires 제약 조건이 충족되는지 검증.
 * 각 항목의 requires에 지정된 부모 ID가 같은 조합 내에 존재해야 유효하다.
 */
function isValidCombination(combo) {
    const selectedIds = new Set();
    combo.forEach(entry => selectedIds.add(`${entry.catId}_${entry.item.id}`));

    return combo.every(entry => {
        if (!entry.item.requires || entry.item.requires.length === 0) return true;
        return entry.item.requires.some(reqId => selectedIds.has(reqId));
    });
}

/**
 * selectedSet을 바탕으로 cartesianProduct에 넘길 groupArrays를 만든다.
 * combineMode[catId]가 true인 그룹은, 선택된 항목 여러 개를 "택1 대안"이 아니라
 * 프롬프트를 전부 이어붙인 "하나로 합쳐진 항목"으로 만들어서 넣는다.
 * (Shift+Ctrl+클릭으로 합치기 모드 on, Shift만 누르면 기존처럼 대안 모드)
 */
function buildSelectedGroupArrays() {
    const allCats = getAllCategories();
    const groupArrays = [];

    allCats.forEach(cat => {
        const catSet = selectedSet[cat.id];
        if (!catSet || catSet.size === 0) return;

        const items = [];
        for (const itemId of catSet) {
            const item = cat.items.find(i => i.id === itemId);
            if (item) items.push({ catId: cat.id, catName: cat.name, item });
        }
        if (items.length === 0) return;

        if (combineMode[cat.id] && items.length > 1) {
            const mergedPrompt = items.map(entry => entry.item.prompt).filter(Boolean).join(', ');
            const mergedName = items.map(entry => entry.item.name).join(' + ');
            const mergedItem = {
                id: `combined_${items.map(entry => entry.item.id).join('_')}`,
                name: mergedName,
                prompt: mergedPrompt,
                _combined: true,
                _sourceItems: items.map(entry => entry.item)
            };
            groupArrays.push([{ catId: cat.id, catName: cat.name, item: mergedItem }]);
        } else {
            groupArrays.push(items);
        }
    });

    return groupArrays;
}

/** 다중 선택 시 유효한 조합의 총 수를 계산하여 반환 */
function countValidCombinations() {
    const groupArrays = buildSelectedGroupArrays();
    if (groupArrays.length === 0) return 0;
    const combos = cartesianProduct(groupArrays);
    return combos.filter(isValidCombination).length;
}

/** 우측 빌더 패널에 현재 선택 상태를 렌더링 */
function renderBuilder() {
    const view = document.getElementById('selected-set-view');
    let pathParts = [];
    let html = "";
    let hasMulti = false;

    getAllCategories().forEach(cat => {
        const catSet = selectedSet[cat.id];
        if (catSet && catSet.size > 0) {
            const items = [];
            for (const itemId of catSet) {
                const item = cat.items.find(i => i.id === itemId);
                if (item) items.push(item);
            }

            if (items.length === 1) {
                pathParts.push(items[0].name);
                html += `<div class="list-item active" style="margin-bottom:10px;"><small>${cat.name}</small><span class="item-name">${items[0].name}</span></div>`;
            } else if (items.length > 1 && combineMode[cat.id]) {
                pathParts.push(`[${cat.name}=${items.map(i => i.name).join('+')}]`);
                const names = items.map(i => i.name).join(' + ');
                html += `<div class="list-item active" style="margin-bottom:10px; border-left: 4px solid #9C27B0;">
                    <small>${cat.name} <span style="color:#CE93D8; font-weight:bold;">(🔗 ${items.length}개 합침)</span></small>
                    <span class="item-name" style="font-size:0.85em;">${names}</span>
                </div>`;
            } else if (items.length > 1) {
                hasMulti = true;
                pathParts.push(`[${cat.name}×${items.length}]`);
                const names = items.map(i => i.name).join(', ');
                html += `<div class="list-item active" style="margin-bottom:10px; border-left: 4px solid #FF9800;">
                    <small>${cat.name} <span style="color:#FF9800; font-weight:bold;">(×${items.length})</span></small>
                    <span class="item-name" style="font-size:0.85em;">${names}</span>
                </div>`;
            }
        }
    });

    view.innerHTML = html || '<p class="empty-msg">조각을 선택해 보세요.</p>';
    document.getElementById('path-preview').innerText = pathParts.join('_') || "선택 없음";

    const sendBtn = document.getElementById('btn-send-set-queue');
    if (sendBtn) {
        const validCount = countValidCombinations();
        if (validCount > 1) {
            sendBtn.textContent = `📥 ${validCount}건 일괄 전송`;
            sendBtn.style.background = '#FF9800';
        } else {
            sendBtn.textContent = '📥 이 세트를 대기열로 전송';
            sendBtn.style.background = '';
        }
    }
}

/**
 * 선택된 조각들의 직교곱 조합을 생성하고,
 * requires 제약 조건을 검증한 후 유효한 조합만 배치 큐에 추가한다.
 */
/** 조각 칩을 더블클릭하면 그 조각 하나만 즉시 대기열로 전송 */
/** 조각(item) 하나의 "이 조각 전용 로라" 목록을 반환 (없으면 빈 배열). 합쳐진(_combined) 항목이면 원본 조각들의 로라를 모두 합쳐서 반환 */
function getItemLoraOverride(item) {
    if (!item) return [];
    if (item._combined && Array.isArray(item._sourceItems)) {
        return item._sourceItems.flatMap(it => it.loraOverride || []);
    }
    return item.loraOverride || [];
}

/** 조각(item) 하나의 특정 필드(img2imgOverride/controlnetOverride 등, 단일 값)를 반환. 합쳐진 항목이면 원본 조각들 중 처음 값을 가진 것을 반환 */
function getItemSingleOverride(item, key) {
    if (!item) return null;
    if (item[key]) return item[key];
    if (item._combined && Array.isArray(item._sourceItems)) {
        const found = item._sourceItems.find(it => it[key]);
        return found ? found[key] : null;
    }
    return null;
}

/* ──────────────────────────────────────────────
   🔗 시드 동일화 그룹 — 같은 item.seedGroup 이름을 가진 조각들을 "한 번에" 대기열에
   넣으면(배치 전송), 그 안에서만 공유되는 시드 하나를 새로 뽑아서 다 같이 쓰게 한다.
   같은 그룹을 나중에 다시 배치로 넣으면 그때는 또 새로운 시드가 뽑힌다(매번 랜덤,
   그룹 내부에서만 항상 일치). 배치 함수 맨 앞에서 resetSeedGroupRollsForBatch()를
   불러서 이전 배치의 롤을 지우고 시작해야 한다.
   ────────────────────────────────────────────── */
let _seedGroupRollsForCurrentBatch = {};

function resetSeedGroupRollsForBatch() {
    _seedGroupRollsForCurrentBatch = {};
}

/** item에 seedGroup이 있으면, 이번 배치에서 그 그룹에 이미 뽑아둔 시드가 있으면 그걸 재사용하고
 *  없으면 새로 하나 뽑아서 기억해뒀다가 반환한다. seedGroup이 없으면 null(개별 랜덤 시드로 처리됨). */
function getOrRollSeedForItem(item) {
    const groupName = getItemSingleOverride(item, 'seedGroup');
    if (!groupName) return null;
    if (!(groupName in _seedGroupRollsForCurrentBatch)) {
        _seedGroupRollsForCurrentBatch[groupName] = Math.floor(Math.random() * 10000000000000000);
    }
    return _seedGroupRollsForCurrentBatch[groupName];
}

/** 여러 카테고리가 합쳐진 조합(sourceRefs)일 때, 그 안의 조각들 중 seedGroup이 지정된
 *  첫 번째 조각을 찾아 그 그룹의 시드를 반환한다 (collectSingleOverrideForRefs와 같은 패턴). */
function getOrRollSeedForRefs(refs) {
    const allCats = getAllCategories();
    for (const ref of (refs || [])) {
        const cat = allCats.find(c => c.id === ref.catId);
        const item = cat && cat.items.find(i => i.id === ref.itemId);
        if (!item) continue;
        const groupName = getItemSingleOverride(item, 'seedGroup');
        if (groupName) return getOrRollSeedForItem(item);
    }
    return null;
}

/** sourceRefs(대기열 job이 어떤 조각들로 만들어졌는지)를 보고, 관련된 모든 조각의 전용 로라를 합쳐서 반환. 하나도 없으면 null */
/** 🆕 기능 추가: "프롬 조각에 생성 내역 기록" — 2번 기능(프롬프트 유사도로 이미지 찾기)이
 *  오탐(다른 프롬프트인데도 찾아짐)이 나서, 추측(프롬프트 비교) 대신 생성 성공 시점에 그
 *  결과 파일명을 만들어낸 조각(item) 쪽에 직접·정확하게 기록해두는 방식으로 바꾼 것.
 *  나중엔 추측 없이 item.generatedImages만 보면 "이 조각으로 전에 뭘 만들었는지" 바로 나옴.
 *  item._combined(여러 조각을 합친 가상 조각)이면 실제 원본 조각들 전부에 똑같이 기록한다. */
function recordGeneratedImagesForRefs(sourceRefs, images) {
    if (!Array.isArray(sourceRefs) || sourceRefs.length === 0 || !Array.isArray(images) || images.length === 0) return;
    const allCats = getAllCategories();
    const entries = images.map(img => ({
        filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output', timestamp: Date.now()
    }));
    const MAX_HISTORY_PER_ITEM = 500; // 조각 하나에 무한정 쌓이지 않게 최근 500장만 유지

    const recordOnItem = (item) => {
        if (!item) return;
        if (!Array.isArray(item.generatedImages)) item.generatedImages = [];
        item.generatedImages.push(...entries);
        if (item.generatedImages.length > MAX_HISTORY_PER_ITEM) {
            item.generatedImages = item.generatedImages.slice(-MAX_HISTORY_PER_ITEM);
        }
    };

    sourceRefs.forEach(ref => {
        const cat = allCats.find(c => c.id === ref.catId);
        const item = cat && cat.items.find(i => i.id === ref.itemId);
        if (!item) return;
        if (item._combined && Array.isArray(item._sourceItems)) {
            item._sourceItems.forEach(recordOnItem); // 합성 조각이면 실제 원본 조각들 전부에 기록
        } else {
            recordOnItem(item);
        }
    });
    debounceLibrarySave();
}
window.recordGeneratedImagesForRefs = recordGeneratedImagesForRefs;

/** 🆕(정확성 보강) 기록된 파일명이 "지금도 그때 그 파일이 맞는지" 확인.
 *  1단계(싸게): HEAD 요청으로 서버의 Last-Modified를 받아 기록해둔 timestamp와 같은 초 단위로
 *  맞아떨어지면 "그때 그 파일 그대로"로 보고 PNG 전체를 안 열어봄(매번 전부 검사할 필요 없게).
 *  2단계(확실하게): Last-Modified가 없거나 안 맞으면, 실제로 PNG를 받아 fragment_info를
 *  읽어서(component_metadata.js의 parseComfyUIMetadataFromPNG 재사용) 이 조각(itemId)이 맞는지 확인.
 *  @returns {Promise<'ok'|'missing'|'mismatch'>} */
async function verifyHistoryEntry(entry, itemId, url) {
    try {
        const head = await fetch(url, { method: 'HEAD' });
        if (!head.ok) return 'missing'; // 파일이 삭제된 경우 보통 404
        const lastMod = head.headers.get('Last-Modified');
        if (lastMod && entry.timestamp) {
            const serverTime = Math.floor(new Date(lastMod).getTime() / 1000);
            const recordedTime = Math.floor(entry.timestamp / 1000);
            if (Math.abs(serverTime - recordedTime) <= 2) return 'ok'; // 1~2초 오차는 저장 타이밍 차이로 허용
        }
    } catch (e) { return 'missing'; } // 네트워크 자체가 안 되면 일단 "못 불러옴" 취급

    // 여기까지 왔으면 HEAD만으론 확신 못 함 — PNG를 직접 열어서 fragment_info로 최종 확인
    try {
        const res = await fetch(url);
        if (!res.ok) return 'missing';
        const blob = await res.blob();
        const meta = (typeof parseComfyUIMetadataFromPNG === 'function') ? await parseComfyUIMetadataFromPNG(blob) : null;
        const frags = meta && meta.fragmentInfo;
        if (Array.isArray(frags) && frags.some(f => f.itemId === itemId)) return 'ok';
        return 'mismatch'; // 메타데이터가 없거나 다른 조각 거면, 그 자리에 다른 파일이 생긴 것으로 판단
    } catch (e) {
        return 'missing';
    }
}

/** 🆕 조각 편집 모달에서 "🖼 생성 내역 보기" 버튼이 호출 — item.generatedImages를 갤러리 그리드
 *  모양 모달로 보여준다. 최신 것부터 5장씩, 검증(verifyHistoryEntry)을 통과한 것만 채워서 보여주고
 *  "아니다" 판정 난 건 조용히 건너뛰고 그 다음 기록을 검사(그래서 "5장 보여주는 데 7장을 검사해야
 *  했다" 같은 일이 생길 수 있음 — 끝까지 가봤는데도 5장을 못 채우면 그만큼만 보여줌).
 *  ⚙️ 환경설정에서 "검증 건너뛰기"를 켜면 이 확인을 전혀 안 하고 최신 5장을 그냥 바로 보여줌(빠름,
 *  대신 파일이 지워졌거나 다른 파일로 바뀐 경우를 못 거름). */
function openItemGeneratedImagesModal(catId, itemId) {
    const cat = getAllCategories().find(c => c.id === catId);
    const item = cat && cat.items.find(i => i.id === itemId);
    if (!item) { alert('조각을 찾지 못했습니다.'); return; }

    const history = (item.generatedImages || []).slice().reverse(); // 최신 것부터
    const skipVerify = (typeof window.AppSettings !== 'undefined') && window.AppSettings.get('skipImageVerification') === true;
    const BATCH = 5;

    if (!document.getElementById('pif-style')) {
        const style = document.createElement('style');
        style.id = 'pif-style';
        style.textContent = `.pif-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:100050;display:flex;align-items:center;justify-content:center;}
.pif-modal-box{background:#1b1b1b;border:1px solid #444;border-radius:10px;width:min(900px,92vw);max-height:85vh;display:flex;flex-direction:column;}
.pif-modal-header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #333;}
.pif-modal-close{background:none;border:none;color:#aaa;font-size:1.3em;cursor:pointer;}
.pif-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;padding:14px;overflow-y:auto;}
.pif-item{position:relative;cursor:pointer;border-radius:6px;overflow:hidden;border:1px solid #333;}
.pif-item img{width:100%;height:140px;object-fit:cover;display:block;}
.pif-item .pif-name{position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.65);color:#ddd;font-size:0.68em;padding:2px 5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pif-empty{padding:30px;text-align:center;color:#888;}
.pif-loadmore{margin:0 14px 14px; padding:8px; text-align:center;}`;
        document.head.appendChild(style);
    }

    const modal = document.createElement('div');
    modal.className = 'pif-modal-overlay';
    modal.innerHTML = `<div class="pif-modal-box">
        <div class="pif-modal-header"><h3>🖼 "${(item.name || '').replace(/</g, '&lt;')}" 조각으로 생성한 이미지</h3>
            <button class="pif-modal-close" type="button">✕</button></div>
        <div class="pif-grid"></div>
        <div class="pif-loadmore"></div>
    </div>`;
    document.body.appendChild(modal);
    const grid = modal.querySelector('.pif-grid');
    const loadMoreBox = modal.querySelector('.pif-loadmore');
    const close = () => modal.remove();
    modal.querySelector('.pif-modal-close').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    if (history.length === 0) {
        grid.innerHTML = `<div class="pif-empty">이 조각으로 아직 생성한 적이 없습니다.<br>(이 기능을 추가하기 전에 생성한 이미지는 기록이 안 남아있습니다)</div>`;
        return;
    }

    let cursor = 0; // history 안에서 다음에 검사할 위치
    let shownCount = 0;

    const addItemToGrid = (h, url) => {
        const el = document.createElement('div');
        el.className = 'pif-item';
        el.innerHTML = `<img src="${url}" loading="lazy"><span class="pif-name" title="${h.filename}">${h.filename}</span>`;
        el.addEventListener('click', () => { if (typeof window.openLightbox === 'function') window.openLightbox(url); });
        grid.appendChild(el);
        shownCount++;
    };

    /** history를 cursor부터 순서대로 검사해서, 통과한 게 BATCH개 모이거나 history가 끝날 때까지 진행 */
    async function loadNextBatch() {
        loadMoreBox.innerHTML = `<span style="color:#888; font-size:0.85em;">⏳ 확인 중...</span>`;
        let addedThisBatch = 0;
        let excludedThisBatch = 0;

        while (cursor < history.length && addedThisBatch < BATCH) {
            const h = history[cursor];
            cursor++;
            const url = `/view?filename=${encodeURIComponent(h.filename)}&type=${encodeURIComponent(h.type || 'output')}&subfolder=${encodeURIComponent(h.subfolder || '')}`;

            if (skipVerify) {
                addItemToGrid(h, url);
                addedThisBatch++;
                continue;
            }
            const verdict = await verifyHistoryEntry(h, itemId, url);
            if (verdict === 'ok') {
                addItemToGrid(h, url);
                addedThisBatch++;
            } else {
                excludedThisBatch++; // 삭제됐거나 다른 파일로 바뀐 기록 — 목록에서 조용히 제외
            }
        }

        if (grid.children.length === 0) {
            grid.innerHTML = `<div class="pif-empty">검증을 통과한 이미지가 없습니다(전부 삭제됐거나 다른 파일로 바뀐 것으로 보입니다).</div>`;
        }

        if (cursor < history.length) {
            loadMoreBox.innerHTML = '';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn-secondary';
            btn.textContent = `더 보기 (지금까지 ${shownCount}장 표시, 검사 안 한 기록 ${history.length - cursor}개 더 있음)`;
            btn.addEventListener('click', loadNextBatch);
            loadMoreBox.appendChild(btn);
        } else {
            loadMoreBox.innerHTML = `<span style="color:#666; font-size:0.82em;">총 ${shownCount}장 표시 (기록 ${history.length}개 중)${skipVerify ? '' : ' — 검증 완료'}</span>`;
        }
    }

    loadNextBatch();
}
window.openItemGeneratedImagesModal = openItemGeneratedImagesModal;

function collectLoraOverrideForRefs(refs) {
    const allCats = getAllCategories();
    const merged = [];
    (refs || []).forEach(ref => {
        const cat = allCats.find(c => c.id === ref.catId);
        const item = cat && cat.items.find(i => i.id === ref.itemId);
        merged.push(...getItemLoraOverride(item));
    });
    return merged.length > 0 ? merged : null;
}

/** 🆕 조각(item) 하나의 전용 부정프롬프트를 배열로 반환 (합쳐진 항목이면 원본 조각들 것 전부). 로라와 같은 패턴 —
 *  여러 조각을 동시에 쓸 때 부정프롬프트도 전부 이어붙여야 하므로(단일 override 아님) 배열로 다룬다. */
function getItemNegativeOverride(item) {
    if (!item) return [];
    if (item._combined && Array.isArray(item._sourceItems)) {
        return item._sourceItems.map(it => it.negativeOverride).filter(Boolean);
    }
    return item.negativeOverride ? [item.negativeOverride] : [];
}

/** 🆕 조각 전용 "긍정프롬프트 키워드 무효화" 값(콤마 구분 문자열)들을 배열로 반환.
 *  (getItemNegativeOverride와 동일한 패턴 — _combined 합성 조각이면 소스 조각들 전부 취합) */
function getItemPosInvalidate(item) {
    if (!item) return [];
    if (item._combined && Array.isArray(item._sourceItems)) {
        return item._sourceItems.map(it => it.posInvalidate).filter(Boolean);
    }
    return item.posInvalidate ? [item.posInvalidate] : [];
}

/** 🔀 조각 전용 조건부 프롬프트 변화 규칙들을 하나의 배열로 반환 (_combined 합성 조각이면 소스 조각들 전부 취합) */
function getItemCondRules(item) {
    if (!item) return [];
    if (item._combined && Array.isArray(item._sourceItems)) {
        return item._sourceItems.flatMap(it => Array.isArray(it.condRules) ? it.condRules : []);
    }
    return Array.isArray(item.condRules) ? item.condRules : [];
}

/** 🧱 조각 전용 카테고리 차단 목록 (_combined 합성 조각이면 소스 조각들 전부 취합) */
function getItemBlockCategories(item) {
    if (!item) return [];
    if (item._combined && Array.isArray(item._sourceItems)) {
        return item._sourceItems.flatMap(it => Array.isArray(it.blockCategories) ? it.blockCategories : []);
    }
    return Array.isArray(item.blockCategories) ? item.blockCategories : [];
}

/** 🧱 sourceRefs 전체의 차단 카테고리를 중복 없이 모아 반환 (없으면 null) */
function collectBlockCategoriesForRefs(refs) {
    const allCats = getAllCategories();
    const merged = new Set();
    (refs || []).forEach(ref => {
        const cat = allCats.find(c => c.id === ref.catId);
        const item = cat && cat.items.find(i => i.id === ref.itemId);
        getItemBlockCategories(item).forEach(n => merged.add(n));
    });
    return merged.size > 0 ? Array.from(merged) : null;
}

/** 🔀 sourceRefs 전체의 조건부 규칙을 모아 반환 (없으면 null) */
function collectCondRulesForRefs(refs) {
    const allCats = getAllCategories();
    const merged = [];
    (refs || []).forEach(ref => {
        const cat = allCats.find(c => c.id === ref.catId);
        const item = cat && cat.items.find(i => i.id === ref.itemId);
        getItemCondRules(item).forEach(r => merged.push({ when: r.when, add: r.add, remove: r.remove }));
    });
    return merged.length > 0 ? merged : null;
}

/** 🆕 조각 전용 "부정프롬프트 키워드 무효화" 값(콤마 구분 문자열)들을 배열로 반환. */
function getItemNegInvalidate(item) {
    if (!item) return [];
    if (item._combined && Array.isArray(item._sourceItems)) {
        return item._sourceItems.map(it => it.negInvalidate).filter(Boolean);
    }
    return item.negInvalidate ? [item.negInvalidate] : [];
}

/** sourceRefs 전체를 훑어서 "긍정프롬프트 키워드 무효화" 값들을 하나의 콤마 구분 문자열로 합친다.
 *  (collectNegativeOverrideForRefs와 동일한 패턴) 없으면 null. */
/** 🆕 조각에 저장된 "기본 반복 횟수"(defaultRepeatCount)를 반환 (없거나 유효하지 않으면 null) */
function getItemDefaultRepeatCount(item) {
    if (!item || item.defaultRepeatCount === undefined || item.defaultRepeatCount === null) return null;
    const n = parseInt(item.defaultRepeatCount, 10);
    return (!isNaN(n) && n >= 1) ? n : null;
}

/** 🆕 sourceRefs 전체를 훑어서 "이 조각 기본 반복 횟수"가 지정된 게 있으면 그중 최댓값을 반환한다 (없으면 null).
 *  합치기(Shift+Ctrl)로 여러 조각이 한 job이 된 경우, 그중 하나라도 타율이 낮아 반복이 필요하다고
 *  지정돼 있으면 그 요구를 존중해서 더 큰 쪽을 따른다. */
function collectMaxRepeatCountForRefs(refs) {
    const allCats = getAllCategories();
    let max = null;
    (refs || []).forEach(ref => {
        const cat = allCats.find(c => c.id === ref.catId);
        const item = cat && cat.items.find(i => i.id === ref.itemId);
        const n = getItemDefaultRepeatCount(item);
        if (n !== null && (max === null || n > max)) max = n;
    });
    return max;
}

function collectPosInvalidateForRefs(refs) {
    const allCats = getAllCategories();
    const merged = [];
    (refs || []).forEach(ref => {
        const cat = allCats.find(c => c.id === ref.catId);
        const item = cat && cat.items.find(i => i.id === ref.itemId);
        getItemPosInvalidate(item).forEach(csv => {
            csv.split(',').map(t => t.trim()).filter(Boolean).forEach(tok => {
                if (!merged.some(m => m.toLowerCase() === tok.toLowerCase())) merged.push(tok); // 중복 키워드는 한 번만
            });
        });
    });
    return merged.length > 0 ? merged.join(', ') : null;
}

/** sourceRefs 전체를 훑어서 "부정프롬프트 키워드 무효화" 값들을 하나의 콤마 구분 문자열로 합친다. 없으면 null. */
function collectNegInvalidateForRefs(refs) {
    const allCats = getAllCategories();
    const merged = [];
    (refs || []).forEach(ref => {
        const cat = allCats.find(c => c.id === ref.catId);
        const item = cat && cat.items.find(i => i.id === ref.itemId);
        getItemNegInvalidate(item).forEach(csv => {
            csv.split(',').map(t => t.trim()).filter(Boolean).forEach(tok => {
                if (!merged.some(m => m.toLowerCase() === tok.toLowerCase())) merged.push(tok);
            });
        });
    });
    return merged.length > 0 ? merged.join(', ') : null;
}

/** 🆕 sourceRefs 전체에서 전용 부정프롬프트를 모아 합친다 (중복 문구는 한 번만). 하나도 없으면 null.
 *  반환값은 이미 ", "로 합쳐진 하나의 문자열 — 생성 시 공통 부정프롬프트 뒤에 그대로 붙이면 됨. */
function collectNegativeOverrideForRefs(refs) {
    const allCats = getAllCategories();
    const merged = [];
    (refs || []).forEach(ref => {
        const cat = allCats.find(c => c.id === ref.catId);
        const item = cat && cat.items.find(i => i.id === ref.itemId);
        getItemNegativeOverride(item).forEach(neg => {
            if (neg && !merged.includes(neg)) merged.push(neg); // 중복 문구는 한 번만
        });
    });
    return merged.length > 0 ? merged.join(', ') : null;
}

/** sourceRefs 중 지정한 key(img2imgOverride/controlnetOverride)를 가진 첫 조각의 값을 반환. 없으면 null.
    (Img2Img/ControlNet은 이미지 하나 기준 파이프라인이라 로라처럼 합칠 수 없어 "먼저 매칭되는 것 하나"만 사용) */
function collectSingleOverrideForRefs(refs, key) {
    const allCats = getAllCategories();
    for (const ref of (refs || [])) {
        const cat = allCats.find(c => c.id === ref.catId);
        const item = cat && cat.items.find(i => i.id === ref.itemId);
        const val = getItemSingleOverride(item, key);
        if (val) return val;
    }
    return null;
}

/** 🙈 조합(sourceRefs) 안의 조각들 중 하나라도 "후방뷰 얼굴가중치 하락"이 켜져 있으면 true */
function collectBackViewFaceFlagForRefs(refs) {
    const allCats = getAllCategories();
    for (const ref of (refs || [])) {
        const cat = allCats.find(c => c.id === ref.catId);
        const item = cat && cat.items.find(i => i.id === ref.itemId);
        if (item && item.backViewFaceWeightDown) return true;
    }
    return false;
}

function sendSingleItemToQueue(catId, itemId) {
    resetSeedGroupRollsForBatch();
    const cat = getAllCategories().find(c => c.id === catId);
    if (!cat) return;
    const item = cat.items.find(i => i.id === itemId);
    if (!item) return;

    let rCount = parseInt(document.getElementById('global-repeat-count')?.value || "1");
    if (isNaN(rCount) || rCount < 1) rCount = 1;

    const jobData = {
        id: Date.now(),
        labels: { [cat.name]: item.name },
        fullPrompt: [item.prompt],
        sourceRefs: [{ catId: cat.id, itemId: item.id }],
        repeatCount: rCount
    };
    // 🆕 이 조각에 "기본 반복 횟수"가 지정돼 있으면(타율 낮은 조각용) 위의 전역 반복횟수 입력값보다 우선한다
    const itemRepeat = getItemDefaultRepeatCount(item);
    if (itemRepeat !== null) jobData.repeatCount = itemRepeat;
    const loraOverride = getItemLoraOverride(item);
    if (loraOverride.length > 0) jobData.loraOverride = loraOverride;
    const img2imgOverride = getItemSingleOverride(item, 'img2imgOverride');
    if (img2imgOverride) jobData.img2imgOverride = img2imgOverride;
    const controlnetOverride = getItemSingleOverride(item, 'controlnetOverride');
    if (controlnetOverride) jobData.controlnetOverride = controlnetOverride;
    const censorOverride = getItemSingleOverride(item, 'censorOverride');
    if (censorOverride) jobData.censorOverride = censorOverride;
    const negativeOverride = getItemNegativeOverride(item).join(', ');
    if (negativeOverride) jobData.negativeOverride = negativeOverride;
    const seedGroupSeed = getOrRollSeedForItem(item);
    if (seedGroupSeed !== null) jobData.seedGroupSeed = seedGroupSeed;
    if (item.backViewFaceWeightDown) jobData.backViewFaceWeightDown = true;
    addJobToQueue(jobData);

    document.getElementById('mode-batch').checked = true;
    toggleGenMode();
}

/** 조각의 프롬프트를 공통 긍정(base-pos) 입력창 끝에 이어붙인다. 수정 모달이 열려있으면 지금 입력창에 있는 내용을 우선 사용. 이미 들어있는 태그는 중복 추가하지 않는다. */
function addToBasePositive(catId, itemId) {
    const cat = getAllCategories().find(c => c.id === catId);
    const item = cat && cat.items.find(i => i.id === itemId);
    if (!item) return;
    const textarea = document.getElementById('base-pos');
    if (!textarea) return;

    const editModal = document.getElementById('prompt-edit-modal');
    const editValueEl = document.getElementById('edit-prompt-value');
    const promptToAdd = (editModal && editModal.style.display !== 'none' && editValueEl) ? editValueEl.value : item.prompt;

    const current = textarea.value;
    const existingTokens = new Set(current.split(',').map(t => t.trim()).filter(Boolean));
    const newTokens = (promptToAdd || '').split(',').map(t => t.trim()).filter(t => t && !existingTokens.has(t));

    if (newTokens.length === 0) {
        flashTextareaFeedback(textarea, '이미 포함됨');
        return;
    }

    textarea.value = current.trim() ? `${current.trim()}, ${newTokens.join(', ')}` : newTokens.join(', ');
    flashTextareaFeedback(textarea, '추가됨 ✓');
}

/** 🆕 조각 편집 모달의 "🚀 저장 후 즉시 출력": 지금 편집중인 내용을 먼저 저장하고(대기열 동기화도 자동으로 됨),
 *  이 조각 하나만으로 바로 1장을 즉시 생성한다 (대기열에 쌓지 않음 — 화면 상단 공통 긍정/부정프롬프트 +
 *  이 조각 프롬프트를 합쳐서, 이 조각 전용 로라/Img2Img/ControlNet/검열/부정프롬프트까지 그대로 반영). */
async function saveAndGenerateNow(catId, itemId) {
    if (typeof savePromptEditModal === 'function') savePromptEditModal();

    const cat = getAllCategories().find(c => c.id === catId);
    const item = cat && cat.items.find(i => i.id === itemId);
    if (!item) return;

    if (typeof executeGeneration !== 'function') {
        alert('생성 기능을 찾을 수 없습니다. (generate.js가 로드됐는지 확인해 주세요)');
        return;
    }

    const basePos = document.getElementById('base-pos')?.value || '';
    const actionBatch = document.getElementById('action-pos')?.value?.trim();
    const basePosWithAction = actionBatch ? `${basePos}, ${actionBatch}` : basePos;
    const rawFullPos = item.prompt ? `${basePosWithAction}, ${item.prompt}` : basePosWithAction;
    const disabledFullPos = (typeof applyDisabledTokens === 'function') ? applyDisabledTokens(rawFullPos) : rawFullPos;
    // 🆕 이 조각 전용 "긍정프롬프트 키워드 무효화"
    const posInvalidate = (typeof getItemPosInvalidate === 'function') ? getItemPosInvalidate(item).join(', ') : '';
    const invalidatedPos = (typeof applyItemTokenInvalidation === 'function') ? applyItemTokenInvalidation(disabledFullPos, posInvalidate) : disabledFullPos;
    // 🔀 이 조각 전용 조건부 프롬프트 변화
    // 🧱 이 조각 전용 카테고리 차단
    const blockedPos = (typeof applyItemCategoryBlock === 'function') ? applyItemCategoryBlock(invalidatedPos, getItemBlockCategories(item)) : invalidatedPos;
    const conditionedPos = (typeof applyItemConditionalRules === 'function') ? applyItemConditionalRules(blockedPos, getItemCondRules(item)) : blockedPos;
    // 📷 카메라 구도 자동 적용(도구 탭)이 켜져 있으면 맨 뒤에 붙임
    const fullPos = (typeof applyCameraComposition === 'function') ? applyCameraComposition(conditionedPos) : conditionedPos;

    const baseNeg = document.getElementById('base-neg')?.value || '';
    const negativeOverride = getItemNegativeOverride(item).join(', ');
    const combinedNeg = negativeOverride ? `${negativeOverride}, ${baseNeg}` : baseNeg;
    // 🆕 이 조각 전용 "부정프롬프트 키워드 무효화"
    const negInvalidate = (typeof getItemNegInvalidate === 'function') ? getItemNegInvalidate(item).join(', ') : '';
    const fullNeg = (typeof applyItemTokenInvalidation === 'function') ? applyItemTokenInvalidation(combinedNeg, negInvalidate) : combinedNeg;

    const loraOverride = getItemLoraOverride(item);
    const img2imgOverride = getItemSingleOverride(item, 'img2imgOverride');
    const controlnetOverride = getItemSingleOverride(item, 'controlnetOverride');
    const censorOverride = getItemSingleOverride(item, 'censorOverride');

    await executeGeneration(
        fullPos, fullNeg, item.name || 'QuickGen',
        null, null,
        loraOverride.length > 0 ? loraOverride : null,
        img2imgOverride || null,
        controlnetOverride || null,
        censorOverride || null
    );
}
window.saveAndGenerateNow = saveAndGenerateNow;

/** 🆕 "📋 복사": 지금 보이는(활성) 프롬프트 딱 하나만 복사해서 완전히 새로운 별개의 조각으로 만든다.
 *  ➕ 버전 추가와 다름: 버전 추가는 같은 조각 안에 새 버전을 늘리는 것이고, 이건 이 조각과 완전히
 *  분리된 새 항목을 만드는 것 — 이후 서로 아무 영향도 안 줌. 다른 버전들은 복사되지 않는다.
 *  복사 후 자동으로: 1) 방금 만든 복사본으로 라이브러리에서 이동(선택/스크롤), 2) 대기열에도 바로 추가. */
function copyItemAsNewFragment(catId, itemId) {
    const cat = getAllCategories().find(c => c.id === catId);
    const item = cat && cat.items.find(i => i.id === itemId);
    if (!cat || !item) return;

    const newItemId = 'item_' + Date.now();
    cat.items.push({
        id: newItemId,
        name: (item.name || '새 조각') + ' 복사',
        prompt: item.prompt || '', // 지금 보이는 프롬프트만 복사 (다른 버전들은 안 가져옴)
    });
    renderItems();
    debounceLibrarySave();

    // 🆕 복사한 조각의 편집 입력창으로 바로 이동 (라이브러리 목록 선택이 아니라 실제 편집 모달을 염)
    if (typeof goToLibraryFragment === 'function') {
        goToLibraryFragment(catId, newItemId, { select: true, switchTab: true, openEdit: true });
    }
    // 🆕 대기열에도 바로 추가 (지금은 프롬프트가 이미 채워져 있으니 즉시 완성된 내용으로 들어감)
    if (typeof sendSingleItemToQueue === 'function') {
        sendSingleItemToQueue(catId, newItemId);
    }
}
window.copyItemAsNewFragment = copyItemAsNewFragment;

/** 입력창 테두리를 잠깐 초록색으로 깜빡여서 "적용됨" 피드백을 준다 */
function flashTextareaFeedback(el) {
    const orig = el.style.outline;
    el.style.outline = '2px solid #4CAF50';
    setTimeout(() => { el.style.outline = orig; }, 500);
}
function sendSetToQueue() {
    resetSeedGroupRollsForBatch();
    if (Object.keys(selectedSet).length === 0) return alert("선택된 조각이 없습니다.");
    let rCount = parseInt(document.getElementById('global-repeat-count')?.value || "1");
    if (isNaN(rCount) || rCount < 1) rCount = 1;

    const groupArrays = buildSelectedGroupArrays();

    if (groupArrays.length === 0) return alert("선택된 조각이 없습니다.");

    const allCombos = cartesianProduct(groupArrays);
    const validCombos = allCombos.filter(isValidCombination);
    const skippedCount = allCombos.length - validCombos.length;

    if (validCombos.length === 0) {
        return alert("선택한 조합이 모두 제약 조건(requires)에 의해 제외되었습니다.");
    }

    validCombos.forEach((combo, i) => {
        const jobData = { id: Date.now() + i, labels: {}, fullPrompt: [], sourceRefs: [], repeatCount: rCount };
        combo.forEach(entry => {
            jobData.labels[entry.catName] = entry.item.name;
            jobData.fullPrompt.push(entry.item.prompt);
            const refEntry = { catId: entry.catId, itemId: entry.item.id };
            // 합쳐진(Shift+Ctrl) 항목이면, 원래 어떤 조각들이 합쳐졌는지 각각의 프롬프트를 같이 보관해둔다
            // (generate.js가 이 항목을 공통 프롬프트에서 빼고 영역별로만 따로 쓰는 데 사용)
            if (entry.item._combined && Array.isArray(entry.item._sourceItems) && entry.item._sourceItems.length > 1) {
                refEntry.regionalPrompts = entry.item._sourceItems.map(it => it.prompt).filter(Boolean);
            }
            jobData.sourceRefs.push(refEntry);
        });
        const loraOverride = collectLoraOverrideForRefs(jobData.sourceRefs);
        if (loraOverride) jobData.loraOverride = loraOverride;
        const img2imgOverride = collectSingleOverrideForRefs(jobData.sourceRefs, 'img2imgOverride');
        if (img2imgOverride) jobData.img2imgOverride = img2imgOverride;
        const controlnetOverride = collectSingleOverrideForRefs(jobData.sourceRefs, 'controlnetOverride');
        if (controlnetOverride) jobData.controlnetOverride = controlnetOverride;
        const censorOverride = collectSingleOverrideForRefs(jobData.sourceRefs, 'censorOverride');
        if (censorOverride) jobData.censorOverride = censorOverride;
        const negativeOverride = collectNegativeOverrideForRefs(jobData.sourceRefs);
        if (negativeOverride) jobData.negativeOverride = negativeOverride;
        const seedGroupSeed = getOrRollSeedForRefs(jobData.sourceRefs);
        if (seedGroupSeed !== null) jobData.seedGroupSeed = seedGroupSeed;
        if (collectBackViewFaceFlagForRefs(jobData.sourceRefs)) jobData.backViewFaceWeightDown = true;
        // 🆕 조합에 포함된 조각 중 "기본 반복 횟수"가 지정된 게 있으면(타율 낮은 조각용) 그 최댓값을 우선 사용
        const itemRepeat = collectMaxRepeatCountForRefs(jobData.sourceRefs);
        if (itemRepeat !== null) jobData.repeatCount = itemRepeat;
        addJobToQueue(jobData);
    });

    document.getElementById('mode-batch').checked = true;
    toggleGenMode();


 
    clearSelectedSet();
}

/* ──────────────────────────────────────────────
   퀵생성 (Quick Send — N개씩 순차 전송)
   ────────────────────────────────────────────── */

const QUICK_OFFSETS_KEY = 'quickSendOffsets'; // localStorage 키

/** 전체 offset 객체를 localStorage에서 읽기 */
function loadQuickSendOffsets() {
    try { return JSON.parse(localStorage.getItem(QUICK_OFFSETS_KEY) || '{}'); }
    catch (e) { return {}; }
}

/** 특정 그룹의 offset 반환 (없으면 0) */
function getQuickSendOffset(catId) {
    return loadQuickSendOffsets()[catId] || 0;
}

/** 특정 그룹의 offset 설정 후 localStorage 저장 */
function setQuickSendOffset(catId, val) {
    const all = loadQuickSendOffsets();
    all[catId] = val;
    localStorage.setItem(QUICK_OFFSETS_KEY, JSON.stringify(all));
}

/** 현재 활성 그룹의 offset 초기화 버튼용 */
function resetQuickSendOffset() {
    if (!activeCategoryId) return;
    setQuickSendOffset(activeCategoryId, 0);
    updateQuickSendButton();
}

/**
 * "다음" 버튼: 대기열에 추가하지 않고 미리보기 구간만 size만큼 앞으로 이동.
 * (예: 1~5 표시 중 클릭 → 6~10으로 바로 건너뜀, 끝에 도달하면 처음으로 순환)
 */
function quickSendNext() {
    if (!activeCategoryId) return;
    const cat = getActiveCategory();
    if (!cat || cat.items.length === 0) return;

    const size = parseInt(document.getElementById('quick-send-size')?.value || '5', 10);
    const total = cat.items.length;
    let offset = getQuickSendOffset(activeCategoryId);

    offset += size;
    if (offset >= total) offset = 0; // 끝을 넘으면 처음으로 순환

    setQuickSendOffset(activeCategoryId, offset);
    updateQuickSendButton();
}

/**
 * "이전" 버튼: 대기열에 추가하지 않고 미리보기 구간만 size만큼 뒤로 이동.
 * (맨 앞에서 누르면 마지막 구간으로 순환)
 */
function quickSendPrev() {
    if (!activeCategoryId) return;
    const cat = getActiveCategory();
    if (!cat || cat.items.length === 0) return;

    const size = parseInt(document.getElementById('quick-send-size')?.value || '5', 10);
    const total = cat.items.length;
    let offset = getQuickSendOffset(activeCategoryId);

    offset -= size;
    if (offset < 0) {
        // 마지막 구간의 시작 offset으로 순환
        offset = total > 0 ? Math.floor((total - 1) / size) * size : 0;
    }

    setQuickSendOffset(activeCategoryId, offset);
    updateQuickSendButton();
}

/** 퀵생성 버튼 텍스트/상태를 현재 offset에 맞게 갱신 */
function updateQuickSendButton() {
    const btn = document.getElementById('btn-quick-send');
    if (!btn) return;

    const cat = getActiveCategory();
    if (!cat || cat.items.length === 0) {
        btn.textContent = '⚡ 퀵생성';
        btn.disabled = true;
        return;
    }

    const size = parseInt(document.getElementById('quick-send-size')?.value || '5', 10);
    const total = cat.items.length;
    const offset = getQuickSendOffset(activeCategoryId);
    const from = offset + 1;
    const to = Math.min(offset + size, total);

    btn.disabled = false;
    btn.textContent = `⚡ 퀵생성 [${from}~${to} / ${total}]`;
}

/**
 * 현재 활성 그룹에서 N개씩 순서대로 대기열에 추가.
 * 끝에 도달하면 처음으로 순환.
 */
function quickSendItems() {
    resetSeedGroupRollsForBatch();
    const cat = getActiveCategory();
    if (!cat) return alert("그룹을 먼저 선택하세요.");
    if (cat.items.length === 0) return alert("선택한 그룹에 조각이 없습니다.");

    const size = parseInt(document.getElementById('quick-send-size')?.value || '5', 10);
    const total = cat.items.length;
    let offset = getQuickSendOffset(activeCategoryId);

    // 끝 도달 시 순환
    if (offset >= total) offset = 0;

    const slice = cat.items.slice(offset, offset + size);
    let rCount = parseInt(document.getElementById('global-repeat-count')?.value || '1');
    if (isNaN(rCount) || rCount < 1) rCount = 1;

    slice.forEach((item, i) => {
        const jobData = {
            id: Date.now() + i,
            labels: { [cat.name]: item.name },
            fullPrompt: [item.prompt],
            sourceRefs: [{ catId: cat.id, itemId: item.id }],
            repeatCount: rCount
        };
        // 🆕 이 조각에 "기본 반복 횟수"가 지정돼 있으면(타율 낮은 조각용) 전역 반복횟수 입력값보다 우선한다
        const itemRepeat = getItemDefaultRepeatCount(item);
        if (itemRepeat !== null) jobData.repeatCount = itemRepeat;
        const loraOverride = getItemLoraOverride(item);
        if (loraOverride.length > 0) jobData.loraOverride = loraOverride;
        const img2imgOverride = getItemSingleOverride(item, 'img2imgOverride');
        if (img2imgOverride) jobData.img2imgOverride = img2imgOverride;
        const controlnetOverride = getItemSingleOverride(item, 'controlnetOverride');
        if (controlnetOverride) jobData.controlnetOverride = controlnetOverride;
        const censorOverride = getItemSingleOverride(item, 'censorOverride');
        if (censorOverride) jobData.censorOverride = censorOverride;
        const negativeOverride = getItemNegativeOverride(item).join(', ');
        if (negativeOverride) jobData.negativeOverride = negativeOverride;
        const seedGroupSeed = getOrRollSeedForItem(item);
        if (seedGroupSeed !== null) jobData.seedGroupSeed = seedGroupSeed;
        if (item.backViewFaceWeightDown) jobData.backViewFaceWeightDown = true;
        addJobToQueue(jobData);
    });

    setQuickSendOffset(activeCategoryId, offset + size);

    // 배치 모드 전환
    document.getElementById('mode-batch').checked = true;
    toggleGenMode();

    updateQuickSendButton();
}

/* ──────────────────────────────────────────────
   범위 지정 대기열 전송 (Range Batch Send)
   ────────────────────────────────────────────── */

/**
 * 범위 문자열 "1~5, 8, 10~12" → 0-based 인덱스 배열로 변환.
 * 빈 문자열이면 빈 배열 반환 (= 이 그룹 제외).
 */
function parseRangeString(raw, totalCount) {
    if (!raw || !raw.trim()) return [];
    const indices = new Set();
    raw.split(',').forEach(part => {
        const trimmed = part.trim();
        const rangeMatch = trimmed.match(/^(\d+)\s*[~\-]\s*(\d+)$/);
        if (rangeMatch) {
            let from = parseInt(rangeMatch[1], 10);
            let to   = parseInt(rangeMatch[2], 10);
            if (from > to) [from, to] = [to, from];
            for (let i = from; i <= to; i++) {
                if (i >= 1 && i <= totalCount) indices.add(i - 1);
            }
        } else {
            const n = parseInt(trimmed, 10);
            if (!isNaN(n) && n >= 1 && n <= totalCount) indices.add(n - 1);
        }
    });
    return [...indices].sort((a, b) => a - b);
}

/**
 * 범위 전송 모달을 열고 현재 라이브러리의 그룹 목록을
 * 범위 입력 행으로 렌더링한다.
 */
/** "전체" 버튼: 해당 그룹의 조각 범위칸을 1~N(전체)으로 채워준다 */
function fillFullItemRange(catId, count) {
    const el = document.querySelector(`input[data-cat-id="${catId}"]`);
    if (!el || count < 1) return;
    el.value = `1~${count}`;
    updateRangeSendPreview();
}

function openRangeSendModal() {
    const allCats = getAllCategories();
    if (allCats.length === 0) return alert("라이브러리에 그룹이 없습니다.");

    // 모달이 없으면 동적으로 생성
    if (!document.getElementById('range-send-modal')) {
        const modal = document.createElement('div');
        modal.id = 'range-send-modal';
        modal.className = 'modal-overlay';
        modal.style.cssText = 'display:none;';
        modal.onclick = function(e) { if (e.target === this) closeRangeSendModal(); };
        modal.innerHTML = `
            <div class="modal-content" onclick="event.stopPropagation()" style="width:500px; max-height:80vh; overflow-y:auto;">
                <div class="modal-header">
                    <h3 style="margin:0; color:#4CAF50;">📋 범위 지정 대기열 전송</h3>
                    <span class="close-btn" style="position:static; font-size:1.5em; color:#ff5555;" onclick="closeRangeSendModal()">&times;</span>
                </div>
                <div class="modal-body" style="display:flex; flex-direction:column; gap:12px;">
                    <p style="font-size:0.85em; color:#aaa; margin:0;">
                        각 그룹에서 전송할 조각 범위를 입력하세요. <b>비우면 해당 그룹 제외</b><br>
                        <b>예:</b> 조각 범위 <code>1,6,8</code> + 옆의 버전칸에 <code>3</code> → 1,6,8번 조각을 전부 3번째 버전으로 전송<br>
                        <span style="color:#FF9800;">버전</span>칸은 선택한 조각이 병합된(여러 버전) 조각일 때만 적용되며, 비우면 지금 보이는 버전을 씁니다. (<code>1~3</code>처럼 범위도 가능)
                    </p>
                    <div id="range-send-rows" style="display:flex; flex-direction:column; gap:8px;"></div>
                    <div style="display:flex; align-items:center; gap:8px; padding-top:8px; border-top:1px solid #444;">
                        <label style="font-size:0.9em; color:#aaa; white-space:nowrap;">기본 반복 장수:</label>
                        <input type="number" id="range-repeat-count" value="1" min="1"
                            style="width:60px; padding:4px; background:#222; border:1px solid #555; color:#fff; border-radius:4px;">
                    </div>
                    <div id="range-send-preview" style="font-size:0.8em; color:#FF9800; min-height:20px;"></div>
                    <button class="btn-primary" onclick="executeRangeSend()" style="padding:12px; margin-top:4px;">
                        📥 범위 대기열 전송
                    </button>
                </div>
            </div>`;
        document.body.appendChild(modal);
    }

    // 행 렌더링
    const rowsEl = document.getElementById('range-send-rows');
    rowsEl.innerHTML = allCats.map(cat => `
        <div style="display:flex; align-items:center; gap:6px;">
            <label style="width:100px; font-size:0.88em; color:#ccc; flex-shrink:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${cat.name}">
                ${cat.name} <small style="color:#666;">(${cat.items.length})</small>
            </label>
            <input type="text" data-cat-id="${cat.id}" placeholder="예: 1~5, 6, 8  (비우면 제외)"
                style="flex:1; padding:5px 8px; background:#222; border:1px solid #555; color:#fff; border-radius:4px; font-size:0.85em;"
                oninput="updateRangeSendPreview()">
            <input type="text" data-cat-version-id="${cat.id}" placeholder="버전"
                title="위에서 고른 조각들이 병합된(여러 버전) 조각이면, 여기 적은 버전으로 전송 (비우면 현재 버전)"
                style="width:56px; flex-shrink:0; padding:5px 6px; background:#1a1a1a; border:1px solid #FF9800; color:#FF9800; border-radius:4px; font-size:0.85em; text-align:center;"
                oninput="updateRangeSendPreview()">
            <button type="button" onclick="fillFullItemRange('${cat.id}', ${cat.items.length})" title="이 그룹의 전체 조각을 범위에 채우기"
                style="flex-shrink:0; padding:4px 8px; font-size:0.78em; border-radius:4px; background:#333; border:1px solid #4CAF50; color:#4CAF50; cursor:pointer;">전체</button>
        </div>
    `).join('');

    // 반복 횟수 동기화
    const globalRepeat = document.getElementById('global-repeat-count')?.value || '1';
    document.getElementById('range-repeat-count').value = globalRepeat;

    document.getElementById('range-send-modal').style.display = 'flex';
    updateRangeSendPreview();
}

function closeRangeSendModal() {
    const modal = document.getElementById('range-send-modal');
    if (modal) modal.style.display = 'none';
}

/** 범위 입력값을 실시간으로 파싱해 예상 조합 수를 미리보기 */
function updateRangeSendPreview() {
    const allCats = getAllCategories();
    const groupArrays = buildRangeGroupArrays(allCats);
    if (groupArrays === null) {
        document.getElementById('range-send-preview').textContent = '';
        return;
    }
    const total = groupArrays.reduce((acc, arr) => acc * arr.length, 1);
    document.getElementById('range-send-preview').textContent =
        total > 0 ? `→ 예상 job 수: ${total}건 (직교곱)` : '선택된 조각이 없습니다.';
}

/**
 * 모달 입력값을 읽어 그룹별 item 배열을 반환.
 * 비워둔 그룹은 건너뜀. 조각 범위(예: "1,6,8")로 고른 조각들에,
 * 옆 작은 "버전" 입력칸의 값을(예: "3" 또는 "1~3") 병합된 조각에 한해 적용해 펼친다.
 * 버전칸을 비우면 그 조각의 현재 활성 버전 하나만 사용.
 * 유효한 그룹이 하나도 없으면 null 반환.
 */
function buildRangeGroupArrays(allCats, debugLog) {
    const groupArrays = [];
    allCats.forEach(cat => {
        const rangeEl = document.querySelector(`#range-send-rows input[data-cat-id="${cat.id}"]`);
        const raw = rangeEl ? rangeEl.value : '';
        const indices = parseRangeString(raw, cat.items.length);
        if (debugLog) {
            debugLog.push(`"${cat.name}" (조각 ${cat.items.length}개): 입력칸 ${rangeEl ? '찾음' : '❌못찾음'}, 값="${raw}" → 인덱스 ${indices.length}개`);
        }
        if (indices.length === 0) return; // 비워두거나 해당 없음 → 건너뜀

        const versionEl = document.querySelector(`#range-send-rows input[data-cat-version-id="${cat.id}"]`);
        const versionRaw = versionEl ? versionEl.value.trim() : '';

        const expanded = [];
        indices.forEach(i => {
            const item = cat.items[i];
            if (!item) return;
            if (item.variants && item.variants.length > 1) {
                const vIndices = versionRaw
                    ? parseRangeString(versionRaw, item.variants.length)
                    : [item.activeVariant || 0];
                vIndices.forEach(vIdx => {
                    if (!item.variants[vIdx]) return;
                    expanded.push({
                        catId: cat.id,
                        catName: cat.name,
                        item,
                        variantIndex: vIdx,
                        promptOverride: item.variants[vIdx].prompt,
                        nameOverride: `${item.name} (v${vIdx + 1})`
                    });
                });
            } else {
                expanded.push({ catId: cat.id, catName: cat.name, item });
            }
        });

        if (expanded.length > 0) groupArrays.push(expanded);
    });
    return groupArrays.length > 0 ? groupArrays : null;
}

/** 모달 확인 버튼: 범위 직교곱 계산 후 대기열에 추가 */
function executeRangeSend() {
    resetSeedGroupRollsForBatch();
    const allCats = getAllCategories();
    const debugLog = [];
    const groupArrays = buildRangeGroupArrays(allCats, debugLog);

    if (!groupArrays) {
        console.log('[범위 전송 진단]\n' + debugLog.join('\n'));
        return alert("전송할 조각이 없습니다. 범위를 확인해 주세요.\n\n[진단 정보]\n" + debugLog.join('\n') + "\n\n(콘솔에도 같은 내용이 출력됐습니다)");
    }

    let rCount = parseInt(document.getElementById('range-repeat-count')?.value || '1');
    if (isNaN(rCount) || rCount < 1) rCount = 1;

    const allCombos = cartesianProduct(groupArrays);
    const validCombos = allCombos.filter(isValidCombination);
    const skipped = allCombos.length - validCombos.length;

    if (validCombos.length === 0) return alert("유효한 조합이 없습니다. (requires 제약 조건 확인)");

    validCombos.forEach((combo, i) => {
        const jobData = { id: Date.now() + i, labels: {}, fullPrompt: [], sourceRefs: [], repeatCount: rCount };
        combo.forEach(entry => {
            jobData.labels[entry.catName] = entry.nameOverride || entry.item.name;
            jobData.fullPrompt.push(entry.promptOverride !== undefined ? entry.promptOverride : entry.item.prompt);
            const ref = { catId: entry.catId, itemId: entry.item.id };
            if (entry.variantIndex !== undefined) ref.variantIndex = entry.variantIndex;
            jobData.sourceRefs.push(ref);
        });
        const loraOverride = collectLoraOverrideForRefs(jobData.sourceRefs);
        if (loraOverride) jobData.loraOverride = loraOverride;
        const img2imgOverride = collectSingleOverrideForRefs(jobData.sourceRefs, 'img2imgOverride');
        if (img2imgOverride) jobData.img2imgOverride = img2imgOverride;
        const controlnetOverride = collectSingleOverrideForRefs(jobData.sourceRefs, 'controlnetOverride');
        if (controlnetOverride) jobData.controlnetOverride = controlnetOverride;
        const censorOverride = collectSingleOverrideForRefs(jobData.sourceRefs, 'censorOverride');
        if (censorOverride) jobData.censorOverride = censorOverride;
        const negativeOverride = collectNegativeOverrideForRefs(jobData.sourceRefs);
        if (negativeOverride) jobData.negativeOverride = negativeOverride;
        const seedGroupSeed = getOrRollSeedForRefs(jobData.sourceRefs);
        if (seedGroupSeed !== null) jobData.seedGroupSeed = seedGroupSeed;
        if (collectBackViewFaceFlagForRefs(jobData.sourceRefs)) jobData.backViewFaceWeightDown = true;
        // 🆕 조합에 포함된 조각 중 "기본 반복 횟수"가 지정된 게 있으면(타율 낮은 조각용) 그 최댓값을 우선 사용
        const itemRepeat = collectMaxRepeatCountForRefs(jobData.sourceRefs);
        if (itemRepeat !== null) jobData.repeatCount = itemRepeat;
        addJobToQueue(jobData);
    });

    closeRangeSendModal();
    document.getElementById('mode-batch').checked = true;
    toggleGenMode();

    const msg = skipped > 0
        ? `${validCombos.length}건 전송 완료 (${skipped}건 제약 조건으로 제외)`
        : `${validCombos.length}건 대기열에 추가되었습니다.`;
    alert(msg);
}

/* ──────────────────────────────────────────────
   내보내기 / 가져오기
   ────────────────────────────────────────────── */

/** 현재 라이브러리 데이터를 JSON 파일로 다운로드 */
function exportLibrary() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(libraryData, null, 4));
    const a = document.createElement('a');
    a.setAttribute("href", dataStr);
    a.setAttribute("download", "prompt_library.json");
    a.click();
}

/** JSON 파일을 업로드하여 라이브러리 데이터를 교체 */
async function importLibrary(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            libraryData = migrateLibraryData(JSON.parse(e.target.result));
            await API.post('/assetmanager/api/library', libraryData);
            activeWorkId = null;
            activeCategoryId = null;
            renderWorkTree();
            renderItems();
            alert("라이브러리를 성공적으로 불러왔습니다.");
        } catch (err) { alert("잘못된 JSON 파일입니다."); }
    };
    reader.readAsText(file);
}
/* ──────────────────────────────────────────────
   작가 이름 → 로라 일괄 매칭
   화면 상단 공통 로라 목록(#selected-loras) 전용.
   NAI식({{}}, [[]]) / 콤파이·A1111식((name:1.2)) 가중치 문법을
   둘 다 인식해서, 현재 로라 목록에 있는 이름과 매칭되면
   그 가중치로 자동으로 로라 행을 추가해준다.
   ────────────────────────────────────────────── */

/** 비교용 정규화: 소문자로 바꾸고 공백/밑줄/괄호 등 구분기호만 지운다.
    (한글·일본어 등 비영어 글자도 살려야 매칭되므로 a-z0-9만 남기지 않고, 유니코드 문자/숫자는 전부 유지) */
function normalizeArtistName(s) {
    return (s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * 텍스트 한 덩어리에서 "이름 + 가중치" 쌍들을 뽑아낸다.
 * 지원 문법:
 *   - 콤파이/A1111식: (name:1.2), name:1.2
 *   - NAI 신식: 0.8::artist name::
 *   - NAI 구식 중첩 가중치: {name}(×1.05), {{name}}(×1.05²), [name](÷1.05), [[name]](÷1.05²) — 계산 후 소수 1자리로 반올림
 *   - 가중치 없는 이름은 1.0
 * 쉼표/줄바꿈으로 이름들을 구분한다.
 */
/** 토큰 하나(쉼표/줄바꿈으로 나뉜 조각 하나)를 "이름 + 가중치"로 파싱한다 */
function parseSingleArtistToken(token) {
    let name = (token || '').trim();
    let weight = 1.0;
    if (!name) return { name: '', weight };

    /* danbooru식 "artist:이름" 태그 접두어는 무시하고 이름만 취급 (콜론/공백/밑줄 어느 구분자든) */
    name = name.replace(/^artist[:\s_]+/i, '').trim();
    if (!name) return { name: '', weight };

    /* 0) NAI 신식 표기: 0.8::artist name:: (뒤쪽 ::와 공백은 있든 없든 다 제거) */
    const naiWeightMatch = name.match(/^([\d.]+)::(.*)$/);
    if (naiWeightMatch) {
        weight = parseFloat(naiWeightMatch[1]);
        name = naiWeightMatch[2].replace(/[\s:]+$/, '').trim();
    } else if (/^\(?(.+?):([\d.]+)\)?$/.test(name)) {
        /* 1) 명시적 가중치: (name:1.2) 또는 name:1.2 */
        const explicitMatch = name.match(/^\(?(.+?):([\d.]+)\)?$/);
        name = explicitMatch[1].trim();
        weight = parseFloat(explicitMatch[2]);
    } else {
        /* 2) NAI 중첩 가중치: 앞뒤로 짝지어진 { }, [ ] 개수를 세서 배율 계산 */
        let curlyCount = 0, bracketCount = 0;
        while (name.length >= 2 && name.startsWith('{') && name.endsWith('}')) {
            curlyCount++; name = name.slice(1, -1).trim();
        }
        while (name.length >= 2 && name.startsWith('[') && name.endsWith(']')) {
            bracketCount++; name = name.slice(1, -1).trim();
        }
        if (curlyCount > 0 || bracketCount > 0) {
            weight = Math.pow(1.05, curlyCount) * Math.pow(1 / 1.05, bracketCount);
        }
    }

    /* 가중치 추출 과정에서 "artist:이름" 형태가 뒤늦게 드러나는 경우(예: 0.8::artist:name::)도 있으므로 한 번 더 제거 */
    name = name.replace(/^artist[:\s_]+/i, '').trim();

    /* 로라 강도 입력칸이 소수 1자리까지만 받으므로 반올림 */
    weight = Math.round(weight * 100) / 100; // 소수 2자리까지 허용 (0.05 단위도 정상 작동 확인됨)
    return { name, weight };
}

function parseArtistWeightList(text) {
    const tokens = (text || '').split(/[\n,]+/).map(t => t.trim()).filter(Boolean);
    const results = [];

    tokens.forEach(token => {
        const { name, weight } = parseSingleArtistToken(token);
        if (name) results.push({ name, weight, raw: token });
    });

    return results;
}

/** 두 정규화 문자열 사이의 가장 긴 공통 부분 문자열(연속된 구간) 길이를 구한다 (간단한 DP) */
function longestCommonSubstringLength(a, b) {
    if (!a || !b) return 0;
    let best = 0;
    const dp = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
        let prev = 0;
        for (let j = 1; j <= b.length; j++) {
            const temp = dp[j];
            if (a[i - 1] === b[j - 1]) {
                dp[j] = prev + 1;
                if (dp[j] > best) best = dp[j];
            } else {
                dp[j] = 0;
            }
            prev = temp;
        }
    }
    return best;
}

/**
 * artistName과 가장 잘 맞는 로라 옵션(select의 option)을 찾는다.
 * 완전 일치가 없으면, 후보들 중 "겹치는 글자 수가 가장 긴" 것 하나만 고른다
 * (전에는 조건을 만족하는 첫 번째 후보를 그냥 골랐는데, 그러면 흔한 4글자 조합 때문에
 *  서로 다른 이름 여러 개가 전부 같은 엉뚱한 로라 하나로 쏠리는 문제가 있었음)
 * @param {string} artistName
 * @param {Array<{value:string, text:string}>} loraOptions
 * @returns {Object|null}
 */
/** artistName과 겹치는 후보들을 전부 점수와 함께 반환한다 (점수 내림차순 정렬) */
function findLoraCandidatesScored(artistName, loraOptions, minOverlap) {
    const target = normalizeArtistName(artistName);
    if (!target) return [];

    const exact = loraOptions.filter(o => normalizeArtistName(o.text) === target || normalizeArtistName(o.value) === target);
    if (exact.length > 0) return exact.map(o => ({ option: o, score: target.length }));

    const scored = loraOptions
        .map(o => {
            const n = normalizeArtistName(o.text);
            return { option: o, score: n ? longestCommonSubstringLength(target, n) : 0 };
        })
        .filter(s => s.score >= minOverlap)
        .sort((a, b) => b.score - a.score);

    return scored;
}

/**
 * artistName과 관련된 로라 후보 목록을 반환한다.
 * 완전 일치가 있으면 그것만, 없으면 최고 점수와 근소한 차이(1글자 이내)인 후보들을 전부 묶어서 반환한다
 * (여러 개면 "애매한 매칭"으로 취급해서 사용자가 직접 고르게 한다)
 * @returns {Array<Object>} 후보 옵션 배열 (0개=못 찾음, 1개=확실, 2개 이상=애매함)
 */
function findLoraCandidates(artistName, loraOptions) {
    const scored = findLoraCandidatesScored(artistName, loraOptions, 4);
    if (scored.length === 0) return [];
    const topScore = scored[0].score;
    return scored.filter(s => s.score >= topScore - 1).map(s => s.option);
}

/** 매칭된 로라가 실제로 적용됐을 때, 공통 긍정 프롬프트(#base-pos) 맨 앞에 "@작가이름" 태그를 붙인다.
    이미 같은 태그가 있으면 중복으로 또 붙이지 않는다. */
function prependArtistTagToPositivePrompt(name) {
    if (!name) return;
    const posEl = document.getElementById('base-pos');
    if (!posEl) return;
    const tag = `@${name}`;
    const current = posEl.value || '';
    if (current.includes(tag)) return;
    posEl.value = current ? `${tag}, ${current}` : tag;
    if (typeof appStateManager !== 'undefined' && appStateManager) appStateManager.debounceSave();
    if (typeof savePresetOverride === 'function') savePresetOverride();
}

/** 로라 목록이 바뀌었을 때 두 저장소에 다 반영한다.
    - appStateManager.debounceSave(): 세션 전체 상태 저장 (서버)
    - savePresetOverride(): 지금 선택된 프리셋의 "오버라이드"에 반영 — 이게 없으면 새로고침할 때
      main.js의 applyPreset()이 프리셋 오버라이드로 로라 목록을 강제로 덮어써버려서 방금 추가한 게 사라진다.
      (수동으로 드롭다운을 고르면 진짜 'change' 이벤트가 떠서 자동으로 불리지만, 스크립트로 .value를
       바꾸는 건 이벤트가 안 뜨기 때문에 직접 호출해줘야 한다) */
function persistLoraChange() {
    if (typeof appStateManager !== 'undefined' && appStateManager) appStateManager.debounceSave();
    if (typeof savePresetOverride === 'function') savePresetOverride();
}

/** "+ 로라 추가" 버튼(UIManager.addLoraRow)과 동일한 구조의 행을 만들어서 로라를 적용한다 (이미 있으면 가중치만 갱신) */
function applyLoraMatchToSelected(container, existingValues, loraOption, weight) {
    if (existingValues.has(loraOption.value)) {
        const row = Array.from(container.querySelectorAll('.lora-item')).find(r => r.querySelector('select').value === loraOption.value);
        if (row) row.querySelector('input[type="number"]').value = weight;
        return;
    }
    const row = document.createElement('div');
    row.className = 'lora-item';
    row.innerHTML = `<select style="flex: 1; margin-right: 10px;">${window.loraOptionsHTML || ''}</select>
        <label style="margin-bottom: 0; font-weight: normal;">가중치:</label><input type="number" step="0.01" value="${weight}" style="width: 70px; margin-left: 5px;"><button class="btn-secondary" style="margin-left: 10px;" onclick="this.parentElement.remove(); persistLoraChange();">X</button>`;
    row.querySelector('select').value = loraOption.value;
    container.appendChild(row);
    existingValues.add(loraOption.value);
}

/** 화면 상단 로라 섹션에 "작가 이름 일괄 추가" UI를 한 번만 끼워넣는다 */
function ensureArtistLoraMatchUI() {
    if (document.getElementById('artist-lora-match-box')) return;
    const loraContainer = document.getElementById('selected-loras');
    if (!loraContainer || !loraContainer.parentElement) return;

    const box = document.createElement('div');
    box.id = 'artist-lora-match-box';
    box.style.cssText = 'border:1px solid #333; border-radius:8px; padding:10px; margin-bottom:10px; position:relative;';
    box.innerHTML = `
        <label style="font-size:0.85em; color:#aaa;">작가 이름 일괄 추가 — NAI식({{}}, [[]])/콤파이식(name:1.2) 가중치 둘 다 인식, 현재 로라 목록과 이름이 맞으면 그 가중치로 자동 추가. 글자 위에 마우스를 올리면 앞 3글자로 비슷한 로라를 찾아 보여줍니다.</label>
        <textarea id="artist-lora-input" rows="2" placeholder="예: {{artist1}}, (artist2:1.3), artist3, [artist4]"
            style="width:100%; box-sizing:border-box; background:#111; border:1px solid #333; color:#fff; border-radius:6px; padding:6px; margin-top:6px; resize:vertical;"></textarea>
        <div style="display:flex; gap:8px; align-items:center; margin-top:6px;">
            <button type="button" class="btn-secondary" id="artist-lora-match-btn">매칭해서 추가</button>
            <span id="artist-lora-match-status" style="font-size:0.8em; color:#888;"></span>
        </div>
    `;
    loraContainer.parentElement.insertBefore(box, loraContainer);

    document.getElementById('artist-lora-match-btn').onclick = runArtistLoraMatch;
    setupArtistLoraHoverSuggest(document.getElementById('artist-lora-input'));

    ensureLoraWeightBalancerUI(loraContainer);
}

/* ──────────────────────────────────────────────
   로라 가중치 자동 조절 (총 가중치가 목표치를 넘으면 비율은 유지한 채 전부 낮춤)
   로라가 많아질수록 가중치 합이 커져서 그림이 깨지는 걸 막기 위한 기능
   ────────────────────────────────────────────── */

/** #selected-loras 바로 아래에 "가중치 자동 조절" UI를 한 번만 끼워넣는다 */
function ensureLoraWeightBalancerUI(loraContainer) {
    if (document.getElementById('lora-weight-balancer-box')) return;
    if (!loraContainer || !loraContainer.parentElement) return;

    const box = document.createElement('div');
    box.id = 'lora-weight-balancer-box';
    box.style.cssText = 'display:flex; align-items:center; gap:8px; margin-top:8px; flex-wrap:wrap;';
    box.innerHTML = `
        <label style="font-size:0.85em; color:#aaa; white-space:nowrap;">로라 총 가중치 목표</label>
        <input type="number" id="lora-weight-target" step="0.1" min="0.1" value="4.0" style="width:70px;">
        <label style="font-size:0.85em; color:#aaa; white-space:nowrap;">최소 보장</label>
        <input type="number" id="lora-weight-floor" step="0.01" min="0" value="0.05" style="width:70px;">
        <label style="font-size:0.85em; color:#ccc; white-space:nowrap; display:flex; align-items:center; gap:4px;">
            <input type="checkbox" id="lora-weight-preserve-floor" checked> 초과분만 축소 (약한 로라 보존)
        </label>
        <button type="button" class="btn-secondary" id="lora-weight-balance-btn">⚖ 가중치 자동 조절</button>
        <span id="lora-weight-balance-status" style="font-size:0.8em; color:#888; width:100%;"></span>
    `;
    loraContainer.parentElement.insertBefore(box, loraContainer.nextSibling);

    ensureRescaleCfgUI(box);

    document.getElementById('lora-weight-balance-btn').onclick = balanceLoraWeights;
}

/** 현재 #selected-loras의 모든 가중치 합이 목표치를 넘으면 낮춘다.
    - "초과분만 축소" 체크 시: 각 로라의 가중치 중 "최소 보장"을 넘는 부분(초과분)만 비례해서 깎는다.
      → 약하게 넣은(그림체에 살짝만 영향 주는) 로라는 거의 안 건드리고, 세게 넣은 로라 위주로 깎여서
        전체 그림체가 뭉개지지 않으면서 총 가중치만 낮아진다.
    - 체크 해제 시: 예전 방식대로 전부 똑같은 비율로 낮춘다.
    이미 목표치 이하면 아무것도 건드리지 않는다 (자동으로 올려서 세게 만들지는 않음). */
function balanceLoraWeights() {
    const statusEl = document.getElementById('lora-weight-balance-status');
    const target = parseFloat(document.getElementById('lora-weight-target')?.value || '4.0');
    const floor = parseFloat(document.getElementById('lora-weight-floor')?.value || '0.2');
    const preserveFloor = document.getElementById('lora-weight-preserve-floor')?.checked;

    if (isNaN(target) || target <= 0) {
        statusEl.textContent = '목표 가중치를 올바르게 입력해 주세요.';
        return;
    }
    if (isNaN(floor) || floor < 0) {
        statusEl.textContent = '최소 보장 가중치를 올바르게 입력해 주세요.';
        return;
    }

    const rows = Array.from(document.querySelectorAll('#selected-loras .lora-item'));
    if (rows.length === 0) {
        statusEl.textContent = '조절할 로라가 없습니다.';
        return;
    }

    const weightInputs = rows.map(r => r.querySelector('input[type="number"]')).filter(Boolean);
    const total = weightInputs.reduce((sum, inp) => sum + (parseFloat(inp.value) || 0), 0);

    if (total <= target) {
        statusEl.textContent = `현재 총합 ${total.toFixed(2)} — 목표(${target}) 이내라 조절하지 않았습니다.`;
        return;
    }

    if (preserveFloor) {
        const floorTotal = floor * weightInputs.length;
        if (floorTotal >= target) {
            /* 최소 보장치만 다 더해도 이미 목표를 넘는다 — 이럴 땐 초과분 축소가 의미 없으므로
               그냥 다들 최소 보장치로 맞춘다 (그래도 여전히 목표보단 클 수 있음을 안내) */
            weightInputs.forEach(inp => { inp.value = Math.round(floor * 100) / 100; });
            statusEl.textContent = `로라가 ${weightInputs.length}개라 "최소 보장(${floor})"만 다 더해도 목표(${target})를 넘습니다. 전부 최소 보장치로 맞췄지만 총합은 여전히 ${(floor * weightInputs.length).toFixed(2)}입니다 — 목표를 올리거나 최소 보장을 낮춰주세요.`;
        } else {
            const excesses = weightInputs.map(inp => Math.max(0, (parseFloat(inp.value) || 0) - floor));
            const totalExcess = excesses.reduce((a, b) => a + b, 0);
            const allowedExcessTotal = target - floorTotal;
            const scale = totalExcess > 0 ? (allowedExcessTotal / totalExcess) : 1;

            weightInputs.forEach((inp, i) => {
                const newVal = floor + excesses[i] * scale;
                inp.value = Math.round(newVal * 100) / 100;
            });
        }
    } else {
        const scale = target / total;
        weightInputs.forEach(inp => {
            const original = parseFloat(inp.value) || 0;
            inp.value = Math.round(original * scale * 100) / 100;
        });
    }

    const newTotal = weightInputs.reduce((sum, inp) => sum + (parseFloat(inp.value) || 0), 0);
    if (!statusEl.textContent) {
        statusEl.textContent = preserveFloor
            ? `총합 ${total.toFixed(2)} → ${newTotal.toFixed(2)} (최소 ${floor} 보장, 초과분만 축소 — 로라 ${rows.length}개)`
            : `총합 ${total.toFixed(2)} → ${newTotal.toFixed(2)}로 비율 유지하며 낮췄습니다 (로라 ${rows.length}개).`;
    }

    persistLoraChange();
}

/* ──────────────────────────────────────────────
   로라 개수가 많을 때 RescaleCFG 자동 적용
   (실제 워크플로우 삽입 로직은 generate.js의 executeGeneration에 있음.
    여기선 그 로직이 읽는 설정값(#rescalecfg-enabled/threshold/multiplier)만 화면에 만들어둔다)
   ────────────────────────────────────────────── */
function ensureRescaleCfgUI(afterEl) {
    if (document.getElementById('rescalecfg-box')) return;
    if (!afterEl || !afterEl.parentElement) return;

    const box = document.createElement('div');
    box.id = 'rescalecfg-box';
    box.style.cssText = 'display:flex; align-items:center; gap:8px; margin-top:8px; flex-wrap:wrap; border-top:1px solid #333; padding-top:8px;';
    box.innerHTML = `
        <label style="font-size:0.85em; color:#ccc; white-space:nowrap; display:flex; align-items:center; gap:4px;">
            <input type="checkbox" id="rescalecfg-enabled" checked> 로라 개수 많으면 RescaleCFG 자동 적용 (과포화 방지)
        </label>
        <label style="font-size:0.85em; color:#aaa; white-space:nowrap;">기준 개수(초과 시)</label>
        <input type="number" id="rescalecfg-threshold" step="1" min="1" value="5" style="width:60px;">
        <label style="font-size:0.85em; color:#aaa; white-space:nowrap;">multiplier</label>
        <input type="number" id="rescalecfg-multiplier" step="0.05" min="0" max="1" value="0.7" style="width:70px;">
    `;
    afterEl.insertAdjacentElement('afterend', box);

    ensureLoraMergeUI(box);
}

/* ──────────────────────────────────────────────
   로라 여러 개를 하나의 로라 파일로 병합해서 저장
   ComfyUI 내장 노드(ModelSubtract, CLIPSubtract, LoraSave)만 사용 — 별도 커스텀 노드 설치 불필요.
   원리: [로라 적용 전 모델/클립] vs [지금 선택된 로라들 다 적용한 모델/클립]의 "차이"를 통째로
         하나의 로라 파일로 뽑아낸다. 이후엔 그 파일 하나만 강도 1.0으로 쓰면 지금 조합과 동일한 결과.
   ⚠ 이 조합 그대로 고정되고(개별 가중치 재조정 불가), 대신 로라 파일 개수/용량은 크게 줄어든다.
   ────────────────────────────────────────────── */
function ensureLoraMergeUI(afterEl) {
    if (document.getElementById('lora-merge-btn')) return;
    if (!afterEl || !afterEl.parentElement) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'lora-merge-btn';
    btn.className = 'btn-secondary';
    btn.style.cssText = 'margin-top:8px; border-color:#4CAF50; color:#8BC34A;';
    btn.textContent = '🗜 이 로라 조합을 하나의 파일로 병합';
    btn.onclick = openLoraMergeModal;
    afterEl.insertAdjacentElement('afterend', btn);
}

function openLoraMergeModal() {
    let modal = document.getElementById('lora-merge-modal');
    if (modal) modal.remove();

    const loraCount = document.querySelectorAll('#selected-loras .lora-item select').length;

    modal = document.createElement('div');
    modal.id = 'lora-merge-modal';
    modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:1000; display:flex; align-items:center; justify-content:center;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    modal.innerHTML = `
        <div style="background:#1e1e1e; border:1px solid #444; border-radius:10px; width:min(460px, 92vw); padding:18px; box-sizing:border-box;" onclick="event.stopPropagation()">
            <h3 style="margin:0 0 6px; color:#4CAF50;">로라 병합해서 저장</h3>
            <p style="margin:0 0 12px; font-size:0.8em; color:#888;">지금 화면 상단 공통 로라 목록에 있는 ${loraCount}개를 하나의 로라 파일로 합칩니다. 이후엔 이 조합을 바꿀 수 없고(고정), 대신 파일 하나로 관리할 수 있습니다.</p>

            <div style="display:flex; flex-direction:column; gap:10px;">
                <div>
                    <label style="font-size:0.85em; color:#aaa;">저장할 파일명 (loras/ 폴더 아래에 저장됨)</label>
                    <input type="text" id="lora-merge-filename" value="merged_style_${new Date().toISOString().slice(0,10).replace(/-/g,'')}"
                        style="width:100%; box-sizing:border-box; background:#111; border:1px solid #333; color:#fff; border-radius:6px; padding:6px; margin-top:4px;">
                </div>
                <div style="display:flex; gap:10px;">
                    <div style="flex:1;">
                        <label style="font-size:0.85em; color:#aaa;">Rank (높을수록 원본에 가깝지만 용량 커짐)</label>
                        <input type="number" id="lora-merge-rank" value="32" min="1" max="4096" step="1"
                            style="width:100%; box-sizing:border-box; background:#111; border:1px solid #333; color:#fff; border-radius:6px; padding:6px; margin-top:4px;">
                    </div>
                    <div style="flex:1;">
                        <label style="font-size:0.85em; color:#aaa;">타입</label>
                        <select id="lora-merge-type" style="width:100%; box-sizing:border-box; background:#111; border:1px solid #333; color:#fff; border-radius:6px; padding:6px; margin-top:4px;">
                            <option value="standard">standard (권장)</option>
                            <option value="full_diff">full_diff (제일 정확, 용량 큼)</option>
                        </select>
                    </div>
                </div>
                <label style="font-size:0.85em; color:#ccc; display:flex; align-items:center; gap:6px;">
                    <input type="checkbox" id="lora-merge-bias" checked> bias 차이도 포함
                </label>
                <label style="font-size:0.85em; color:#ccc; display:flex; align-items:center; gap:6px;">
                    <input type="checkbox" id="lora-merge-include-clip"> CLIP(텍스트 인코더)도 포함 — 일부 레이어에서 매우 느려질 수 있음 (SVD 수렴 실패 시)
                </label>
                <div id="lora-merge-status" style="font-size:0.85em; color:#888; min-height:1.2em;"></div>
                <p style="margin:0; font-size:0.75em; color:#666;">이 작업은 이미지를 생성하지 않고, 로라 파일만 만들어서 저장합니다.</p>
                <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:4px;">
                    <button type="button" class="btn-secondary" onclick="document.getElementById('lora-merge-modal').remove()">취소</button>
                    <button type="button" class="btn-primary" id="lora-merge-submit-btn">병합 시작</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('lora-merge-submit-btn').onclick = submitLoraMerge;
}

async function submitLoraMerge() {
    const statusEl = document.getElementById('lora-merge-status');
    const submitBtn = document.getElementById('lora-merge-submit-btn');
    const filename = document.getElementById('lora-merge-filename').value.trim();
    const rank = parseInt(document.getElementById('lora-merge-rank').value || '32', 10);
    const loraType = document.getElementById('lora-merge-type').value;
    const biasDiff = document.getElementById('lora-merge-bias').checked;
    const includeClip = document.getElementById('lora-merge-include-clip').checked;

    if (!filename) { statusEl.textContent = '파일명을 입력해 주세요.'; statusEl.style.color = '#ff5555'; return; }
    if (typeof window.submitLoraMergeJob !== 'function') {
        statusEl.textContent = '병합 기능(generate.js)이 로드되지 않았습니다.';
        statusEl.style.color = '#ff5555';
        return;
    }

    statusEl.textContent = '⏳ 서버에 전송 중...';
    statusEl.style.color = '#FF9800';
    submitBtn.disabled = true;

    try {
        const result = await window.submitLoraMergeJob({ filename, rank, loraType, biasDiff, includeClip });
        if (result && result.prompt_id) {
            statusEl.textContent = `🚀 대기열에 전송했습니다. 완료되면 loras/${filename} 로 저장됩니다.`;
            statusEl.style.color = '#4CAF50';
        } else {
            statusEl.textContent = '전송에 실패했습니다.';
            statusEl.style.color = '#ff5555';
        }
    } catch (e) {
        statusEl.textContent = `오류: ${e.message}`;
        statusEl.style.color = '#ff5555';
    } finally {
        submitBtn.disabled = false;
    }
}


/** ambiguousList: [{name, weight, raw, candidates}] — 사용자가 각각 하나씩 골라서 확정하면 적용한다 */
function showAmbiguousLoraModal(ambiguousList, container, existingValues, onResolved) {
    let modal = document.getElementById('ambiguous-lora-modal');
    if (modal) modal.remove();

    modal = document.createElement('div');
    modal.id = 'ambiguous-lora-modal';
    modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:1000; display:flex; align-items:center; justify-content:center;';
    modal.onclick = (e) => { if (e.target === modal) closeAmbiguousModal(ambiguousList, onResolved); };

    const rowsHtml = ambiguousList.map((item, idx) => `
        <div style="border:1px solid #333; border-radius:6px; padding:8px; margin-bottom:8px;">
            <div style="font-size:0.85em; color:#aaa; margin-bottom:4px;">"${item.name}" 와 비슷한 로라가 여러 개 있습니다:</div>
            <select data-ambiguous-idx="${idx}" style="width:100%; box-sizing:border-box; background:#111; border:1px solid #333; color:#fff; border-radius:6px; padding:6px;">
                ${item.candidates.map(c => `<option value="${c.value}">${c.text}</option>`).join('')}
                <option value="">(건너뛰기 — 추가 안 함)</option>
            </select>
        </div>
    `).join('');

    modal.innerHTML = `
        <div style="background:#1e1e1e; border:1px solid #444; border-radius:10px; width:min(480px, 92vw); max-height:80vh; overflow-y:auto; padding:18px; box-sizing:border-box;" onclick="event.stopPropagation()">
            <h3 style="margin:0 0 10px; color:#4CAF50;">비슷한 로라가 여러 개예요 — 하나씩 골라주세요</h3>
            ${rowsHtml}
            <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:10px;">
                <button type="button" class="btn-secondary" id="ambiguous-lora-cancel">취소</button>
                <button type="button" class="btn-primary" id="ambiguous-lora-confirm">선택한 대로 추가</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('ambiguous-lora-cancel').onclick = () => closeAmbiguousModal(ambiguousList, onResolved);
    document.getElementById('ambiguous-lora-confirm').onclick = () => {
        const skippedRaw = [];
        ambiguousList.forEach((item, idx) => {
            const select = modal.querySelector(`select[data-ambiguous-idx="${idx}"]`);
            const chosenValue = select ? select.value : '';
            if (!chosenValue) { skippedRaw.push(item.raw); return; } // 건너뛰기 선택 — 원문을 보존해둔다
            const chosen = item.candidates.find(c => c.value === chosenValue);
            if (chosen) { applyLoraMatchToSelected(container, existingValues, chosen, item.weight); prependArtistTagToPositivePrompt(item.name); }
        });
        modal.remove();
        persistLoraChange();
        onResolved(skippedRaw); // 건너뛴 것만 입력창에 다시 돌려준다
    };
}

function closeAmbiguousModal(ambiguousList, onResolved) {
    const modal = document.getElementById('ambiguous-lora-modal');
    if (modal) modal.remove();
    /* 취소하면 애매했던 항목들의 원문(raw)을 그대로 돌려줘서 입력창에 남게 한다 */
    onResolved(ambiguousList.map(item => item.raw));
}

/** "매칭해서 추가" 버튼 핸들러: 텍스트를 파싱해서 매칭되는 로라들을 #selected-loras에 추가한다 */
function runArtistLoraMatch() {
    const statusEl = document.getElementById('artist-lora-match-status');
    const inputEl = document.getElementById('artist-lora-input');
    try {
        _runArtistLoraMatchInner(statusEl, inputEl);
    } catch (e) {
        console.error('[작가-로라 매칭] 오류:', e);
        statusEl.textContent = `오류가 발생했습니다: ${e.message}`;
    }
}

function _runArtistLoraMatchInner(statusEl, inputEl) {
    if (!window.loraOptionsHTML) {
        statusEl.textContent = '로라 목록이 아직 로딩되지 않았습니다. 잠시 후 다시 시도해 주세요.';
        return;
    }

    const tempSelect = document.createElement('select');
    tempSelect.innerHTML = window.loraOptionsHTML;
    const loraOptions = Array.from(tempSelect.options)
        .filter(o => o.value)
        .map(o => ({ value: o.value, text: o.text }));

    const parsed = parseArtistWeightList(inputEl.value);
    if (parsed.length === 0) {
        statusEl.textContent = '입력한 이름이 없습니다.';
        return;
    }

    const container = document.getElementById('selected-loras');
    const existingValues = new Set(
        Array.from(container.querySelectorAll('.lora-item select')).map(s => s.value)
    );

    let matchedCount = 0;
    const unmatched = [];
    const ambiguous = [];

    parsed.forEach(({ name, weight, raw }) => {
        const candidates = findLoraCandidates(name, loraOptions);
        if (candidates.length === 0) { unmatched.push(raw); return; }
        if (candidates.length > 1) { ambiguous.push({ name, weight, raw, candidates }); return; }

        applyLoraMatchToSelected(container, existingValues, candidates[0], weight);
        prependArtistTagToPositivePrompt(name);
        matchedCount++;
    });

    /* 매칭된 것들은 입력창에서 지우고, 못 찾은 것들만 남겨서 이어서 시도할 수 있게 한다 */
    inputEl.value = unmatched.join(', ');

    const ambiguousNote = ambiguous.length > 0 ? ` / 비슷한 후보 여러 개(선택 필요): ${ambiguous.length}개` : '';
    statusEl.textContent = unmatched.length > 0
        ? `${matchedCount}개 매칭 완료. 못 찾음(입력창에 남겨둠): ${unmatched.join(', ')}${ambiguousNote}`
        : `${matchedCount}개 매칭되어 추가되었습니다.${ambiguousNote}`;

    if (ambiguous.length > 0) {
        showAmbiguousLoraModal(ambiguous, container, existingValues, (leftoverRaw) => {
            /* 취소된 항목의 원문은 입력창 맨 앞에 다시 붙여준다 */
            if (leftoverRaw.length > 0) {
                const current = inputEl.value.trim();
                inputEl.value = current ? `${leftoverRaw.join(', ')}, ${current}` : leftoverRaw.join(', ');
            }
            statusEl.textContent += ' (선택 완료)';
        });
    } else {
        /* 저장은 루프 도중이 아니라 전체 작업이 끝난 뒤 딱 한 번만 */
        persistLoraChange();
    }
}

/* ──────────────────────────────────────────────
   입력창 위에 마우스를 올리면, 커서 아래 단어의 앞 3글자로
   비슷한 로라를 찾아 작은 목록을 띄워준다 (클릭하면 바로 추가됨)
   ────────────────────────────────────────────── */

/** 텍스트영역 안에서 (clientX, clientY) 픽셀 좌표가 텍스트의 몇 번째 글자 위치인지 알아낸다.
    네이티브 textarea는 caretRangeFromPoint를 직접 못 쓰므로, 완전히 동일한 스타일의 숨김 div를 하나 겹쳐두고
    그 위에서 caretRangeFromPoint를 호출해 얻은 문자 오프셋을 그대로 재사용한다. */
function getTextareaCharIndexAtPoint(textarea, clientX, clientY) {
    if (!document.caretRangeFromPoint) return -1;

    let mirror = document.getElementById('artist-lora-hover-mirror');
    if (!mirror) {
        mirror = document.createElement('div');
        mirror.id = 'artist-lora-hover-mirror';
        document.body.appendChild(mirror);
    }

    const cs = window.getComputedStyle(textarea);
    const rect = textarea.getBoundingClientRect();
    /* 측정하는 그 순간에만 실제 textarea보다 위(z-index 높음)에 올려서 caretRangeFromPoint가
       (뒤에 깔려서 절대 안 맞는) 이 미러 대신 진짜 textarea를 맞히는 걸 방지한다.
       pointer-events도 이 순간만 'auto'로 켜야 히트테스트에 잡힌다 (none이면 그냥 통과해버림). */
    mirror.style.cssText = `
        position:fixed; top:${rect.top}px; left:${rect.left}px; width:${rect.width}px; height:${rect.height}px;
        font:${cs.font}; letter-spacing:${cs.letterSpacing}; line-height:${cs.lineHeight};
        padding:${cs.padding}; border-width:${cs.borderWidth}; border-style:solid; box-sizing:${cs.boxSizing};
        white-space:pre-wrap; word-wrap:break-word; overflow:hidden;
        opacity:0; z-index:99999; pointer-events:auto;
    `;
    mirror.textContent = textarea.value;

    const range = document.caretRangeFromPoint(clientX, clientY);

    /* 측정 끝나면 곧바로 다시 안 걸리게 뒤로 숨겨서, 실제 textarea 조작(타이핑/클릭)을 막지 않는다 */
    mirror.style.pointerEvents = 'none';
    mirror.style.zIndex = '-1';

    if (!range || !mirror.contains(range.startContainer)) return -1;
    return range.startOffset;
}

/** charIndex를 포함하는 "토큰"(쉼표/줄바꿈으로 구분된 덩어리 하나)을 잘라서 반환 */
function extractTokenAt(text, charIndex) {
    if (charIndex < 0 || charIndex > text.length) return '';
    let start = charIndex, end = charIndex;
    while (start > 0 && !/[\n,]/.test(text[start - 1])) start--;
    while (end < text.length && !/[\n,]/.test(text[end])) end++;
    return text.slice(start, end).trim();
}

/** charIndex를 포함하는 "단어"(영문/숫자/밑줄/하이픈으로 이어진 덩어리)를 잘라서 반환 */
function extractWordAt(text, charIndex) {
    if (charIndex < 0 || charIndex > text.length) return '';
    const isWordChar = (ch) => ch && /[a-zA-Z0-9_\-']/.test(ch);
    let start = charIndex, end = charIndex;
    while (start > 0 && isWordChar(text[start - 1])) start--;
    while (end < text.length && isWordChar(text[end])) end++;
    return text.slice(start, end).trim();
}

/** 로라 후보 목록을 커서 근처에 작은 팝업으로 띄운다. 클릭하면 그 자리에서 바로(가중치 그대로) 로라 목록에 추가된다. */
function showHoverLoraSuggestPopup(candidates, clientX, clientY, weight, artistName) {
    let popup = document.getElementById('artist-lora-hover-popup');
    if (!popup) {
        popup = document.createElement('div');
        popup.id = 'artist-lora-hover-popup';
        document.body.appendChild(popup);
    }
    popup.style.cssText = `
        position:fixed; left:${clientX + 8}px; top:${clientY + 14}px; z-index:1200;
        background:#1e1e1e; border:1px solid #4CAF50; border-radius:6px; padding:4px;
        max-width:260px; max-height:200px; overflow-y:auto; box-shadow:0 4px 12px rgba(0,0,0,0.5);
    `;
    popup.innerHTML = candidates.slice(0, 8).map(c => `
        <div class="hover-lora-suggest-item" data-value="${c.value}"
            style="padding:5px 8px; font-size:0.82em; color:#ddd; cursor:pointer; border-radius:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${c.text} <span style="color:#4CAF50;">(${weight})</span></div>
    `).join('');
    popup.style.display = 'block';

    popup.querySelectorAll('.hover-lora-suggest-item').forEach(el => {
        el.onmouseenter = () => { el.style.background = '#2a2a2a'; };
        el.onmouseleave = () => { el.style.background = ''; };
        el.onclick = () => {
            const container = document.getElementById('selected-loras');
            const existingValues = new Set(Array.from(container.querySelectorAll('.lora-item select')).map(s => s.value));
            const match = { value: el.dataset.value, text: el.textContent };
            applyLoraMatchToSelected(container, existingValues, match, weight);
            prependArtistTagToPositivePrompt(artistName);
            persistLoraChange();
            hideHoverLoraSuggestPopup();
        };
    });
}

function hideHoverLoraSuggestPopup() {
    const popup = document.getElementById('artist-lora-hover-popup');
    if (popup) popup.style.display = 'none';
}

/** 좌표 위치의 단어(2글자 이상)를 로라 목록과 비교해서 후보를 찾고 팝업으로 보여준다.
    minLen: 최소 글자 수 (일반 마우스오버=3, Ctrl+Shift+우클릭 강제검색=2) */
function runLoraHoverSearchAt(textarea, clientX, clientY, minLen) {
    if (!window.loraOptionsHTML) return false;

    const charIndex = getTextareaCharIndexAtPoint(textarea, clientX, clientY);
    if (charIndex < 0) return false;

    const hoveredWord = extractWordAt(textarea.value, charIndex);
    if (hoveredWord.length < minLen) return false;

    /* 가중치는 커서가 놓인 "단어"가 아니라, 그 단어가 속한 토큰 전체({{}}, (name:1.2) 등)를 파싱해서 가져온다 */
    const token = extractTokenAt(textarea.value, charIndex);
    const { name: parsedName, weight } = parseSingleArtistToken(token);
    const searchName = parsedName || hoveredWord;

    const tempSelect = document.createElement('select');
    tempSelect.innerHTML = window.loraOptionsHTML;
    const loraOptions = Array.from(tempSelect.options).filter(o => o.value).map(o => ({ value: o.value, text: o.text }));

    const prefix = normalizeArtistName(searchName).slice(0, minLen);
    if (prefix.length < minLen) return false;

    const candidates = loraOptions.filter(o => normalizeArtistName(o.text).includes(prefix));
    if (candidates.length === 0) return false;

    showHoverLoraSuggestPopup(candidates, clientX, clientY, weight, searchName);
    return true;
}

/** 작가 이름 입력창에 마우스 hover 검색 기능을 붙인다 */
function setupArtistLoraHoverSuggest(textarea) {
    if (!textarea || textarea.dataset.hoverSuggestBound) return;
    textarea.dataset.hoverSuggestBound = '1';

    let lastWord = '';
    let hoverTimer = null;

    textarea.addEventListener('mousemove', (e) => {
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => {
            const charIndex = getTextareaCharIndexAtPoint(textarea, e.clientX, e.clientY);
            const hoveredWord = charIndex >= 0 ? extractWordAt(textarea.value, charIndex) : '';
            if (hoveredWord.length < 3) { hideHoverLoraSuggestPopup(); lastWord = ''; return; }
            if (hoveredWord === lastWord) return; // 같은 단어면 다시 계산 안 함 (깜빡임 방지)
            lastWord = hoveredWord;

            const found = runLoraHoverSearchAt(textarea, e.clientX, e.clientY, 3);
            if (!found) hideHoverLoraSuggestPopup();
        }, 180);
    });

    textarea.addEventListener('mouseleave', () => {
        clearTimeout(hoverTimer);
        hideHoverLoraSuggestPopup();
        lastWord = '';
    });

    /* Ctrl+Shift+우클릭 — 2글자짜리 짧은 작가 이름도 강제로 검색 (평소 hover는 3글자 미만이면 무시함) */
    textarea.addEventListener('contextmenu', (e) => {
        if (!e.ctrlKey || !e.shiftKey) return;
        e.preventDefault();
        clearTimeout(hoverTimer);
        const found = runLoraHoverSearchAt(textarea, e.clientX, e.clientY, 2);
        if (!found) hideHoverLoraSuggestPopup();
    });
}

/* 팝업 바깥을 클릭하면 hover 로라 추천 팝업을 닫는다 */
document.addEventListener('click', (e) => {
    const popup = document.getElementById('artist-lora-hover-popup');
    if (popup && popup.style.display !== 'none' && !popup.contains(e.target)) {
        hideHoverLoraSuggestPopup();
    }
});

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureArtistLoraMatchUI);
} else {
    ensureArtistLoraMatchUI();
}

/* ──────────────────────────────────────────────
   베이스 모델 정리 도구 — 체크포인트/Unet 파일이 어느 프리셋에서 쓰이는지 확인
   (용량 정리할 때 지워도 되는 파일인지 헷갈리지 않게)
   ────────────────────────────────────────────── */

/** 체크포인트 선택 줄 옆에 "모델 정리 도구" 버튼을 한 번만 끼워넣는다 */
function ensureModelCleanupToolUI() {
    if (document.getElementById('model-cleanup-btn')) return;
    const anchor = document.getElementById('sdxl-checkpoint-row');
    if (!anchor || !anchor.parentElement) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'model-cleanup-btn';
    btn.className = 'btn-secondary';
    btn.textContent = '🧹 모델 정리 도구 (프리셋 사용처 확인)';
    btn.style.cssText = 'margin: 6px 0 10px;';
    btn.onclick = openModelCleanupModal;
    anchor.insertAdjacentElement('afterend', btn);
}

/** 모든 프리셋(기본 제공 + 커스텀, 저장된 오버라이드 반영)을 훑어서
    "모델 파일명 → 그걸 쓰는 프리셋 이름들" 맵을 만든다 */
function getModelUsageMap() {
    const map = {}; // filename -> Set(presetLabel)
    const presets = window.MODEL_PRESETS || {};
    Object.keys(presets).forEach(key => {
        const p = (typeof getEffectivePreset === 'function') ? getEffectivePreset(key) : presets[key];
        if (!p) return;
        const label = p.label || key;
        /* sdxl은 checkpoint, anima는 unet(또는 animaCheckpoint) 필드에 모델명이 들어있음 */
        ['checkpoint', 'unet', 'animaCheckpoint'].forEach(field => {
            const val = p[field];
            if (val) {
                if (!map[val]) map[val] = new Set();
                map[val].add(label);
            }
        });
    });
    return map;
}

/** 화면의 체크포인트/Unet류 드롭다운들에 실제로 떠 있는 모델 파일명을 전부 모은다 (중복 제거) */
function collectAllModelFilenames() {
    const names = new Set();
    ['gen-checkpoint', 'gen-unet', 'gen-anima-ckpt', 'gen-sd3-unet'].forEach(selId => {
        const sel = document.getElementById(selId);
        if (!sel) return;
        Array.from(sel.options).forEach(o => { if (o.value) names.add(o.value); });
    });
    return Array.from(names).sort();
}

/** "모델 정리 도구" 모달을 연다. 각 모델 줄에 마우스를 올리면(네이티브 title 툴팁)
    그 모델을 쓰는 프리셋 이름들이 보이고, 안 쓰이는 모델은 주황색으로 표시된다. */
function openModelCleanupModal() {
    let modal = document.getElementById('model-cleanup-modal');
    if (modal) modal.remove();

    const usageMap = getModelUsageMap();
    const allModels = collectAllModelFilenames();

    modal = document.createElement('div');
    modal.id = 'model-cleanup-modal';
    modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:1000; display:flex; align-items:center; justify-content:center;';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    const escapeAttr = (s) => (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');

    const rowsHtml = allModels.map(name => {
        const usedBy = usageMap[name] ? Array.from(usageMap[name]) : [];
        const isUsed = usedBy.length > 0;
        const badge = isUsed
            ? `<span style="color:#4CAF50;">사용 중 (${usedBy.length}개 프리셋)</span>`
            : `<span style="color:#ff9800;">사용 안 함</span>`;
        const tooltip = isUsed ? `사용 중인 프리셋: ${usedBy.join(', ')}` : '이 파일을 쓰는 프리셋이 없습니다';
        return `
            <div class="model-cleanup-row" title="${escapeAttr(tooltip)}"
                style="display:flex; justify-content:space-between; gap:10px; padding:7px 8px; border-bottom:1px solid #333; cursor:default;">
                <span style="font-size:0.85em; color:#ddd; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${name}</span>
                <span style="font-size:0.8em; white-space:nowrap;">${badge}</span>
            </div>
        `;
    }).join('');

    modal.innerHTML = `
        <div style="background:#1e1e1e; border:1px solid #444; border-radius:10px; width:min(640px, 92vw); max-height:80vh; overflow-y:auto; padding:18px; box-sizing:border-box;" onclick="event.stopPropagation()">
            <h3 style="margin:0 0 4px; color:#4CAF50;">모델 정리 도구</h3>
            <p style="margin:0 0 10px; font-size:0.8em; color:#888;">각 모델 위에 마우스를 올리면 어느 프리셋에서 쓰이는지 보여줍니다. 주황색("사용 안 함")은 지금 등록된 프리셋 중 아무 데도 안 쓰이는 모델입니다 — 그래도 지우기 전에 워크플로우 등 다른 용도로 쓰이고 있진 않은지 한 번 더 확인하세요.</p>
            <div>${rowsHtml || '<div style="color:#888; font-size:0.85em;">표시할 모델이 없습니다. (모델 드롭다운이 아직 로딩 중일 수 있어요)</div>'}</div>
            <div style="display:flex; justify-content:flex-end; margin-top:12px;">
                <button type="button" class="btn-secondary" onclick="document.getElementById('model-cleanup-modal').remove()">닫기</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureModelCleanupToolUI);
} else {
    ensureModelCleanupToolUI();
}

/* ──────────────────────────────────────────────
   랜덤 프리셋으로 생성 — 프리셋 하나를 무작위로 골라 적용한 뒤 바로 단일 생성 시작
   ────────────────────────────────────────────── */

function ensureRandomPresetGenerateUI() {
    if (document.getElementById('random-preset-generate-btn')) return;
    const presetGroup = document.getElementById('gen-preset')?.closest('.form-group');
    if (!presetGroup || !presetGroup.parentElement) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'random-preset-generate-btn';
    btn.className = 'btn-secondary';
    btn.style.cssText = 'margin-top:6px; border-color:#9C27B0; color:#CE93D8;';
    btn.textContent = '🎲 랜덤 프리셋으로 생성';
    btn.onclick = randomPresetGenerate;
    presetGroup.insertAdjacentElement('afterend', btn);
}

async function randomPresetGenerate() {
    const presets = window.MODEL_PRESETS || {};
    const keys = Object.keys(presets);
    if (keys.length === 0) {
        alert('선택할 수 있는 프리셋이 없습니다.');
        return;
    }
    const randomKey = keys[Math.floor(Math.random() * keys.length)];
    const sel = document.getElementById('gen-preset');
    if (sel) sel.value = randomKey;

    if (typeof applyPreset === 'function') {
        await applyPreset();
    }
    if (typeof generateImage === 'function') {
        generateImage();
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureRandomPresetGenerateUI);
} else {
    ensureRandomPresetGenerateUI();
}

/* ──────────────────────────────────────────────
   💬 대화하며 이미지 뽑기 — 전 단계 완료:
   1단계: 채팅 UI + 공급자별 키/엔드포인트 저장
   2단계: 대화 → "답변 + 제안 프롬프트" 변환 (백엔드 /assetmanager/api/chatgen_message,
          Gemini/GPT/커스텀 공용, __init__.py의 api_chatgen_message())
   3단계: 제안된 프롬프트로 실제 생성 (기존 executeGeneration() 재사용 — 현재 Generate 탭에
          설정된 체크포인트/아키텍처/고급설정을 그대로 씀, 채팅은 프롬프트 작성만 담당)
   4단계: 생성된 이미지가 채팅창에 썸네일로 남고, 다음 메시지를 보낼 때 그 이미지를 함께
          보내서("머리색 바꿔줘" 등) 비전 지원 모델이 보고 수정 반영 → 재생성 가능
   공급자: Gemini / GPT(OpenAI) / 커스텀(OpenAI 호환 엔드포인트 — 로컬 LLM인 Ollama의
   llama3.2-vision 등도 여기로 연결 가능, 엔드포인트 URL+모델명을 직접 입력받음).
   이미지 생성용으로 이미 입력해둔 나노바나나/GPT API 키(nanoBananaApiKey/gptApiKey)와는
   완전히 분리된 별도 저장소(chatGenSettings)를 쓴다 — 사용자가 명시적으로 분리를 요청함.
   ────────────────────────────────────────────── */

const CHATGEN_SETTINGS_KEY = 'chatGenSettings';
const CHATGEN_HISTORY_KEY = 'chatGenHistory'; // 🆕 채팅 기록 영구 저장(새로고침/재접속해도 유지)

/** localStorage에서 채팅 기록 + 직전 제안 프롬프트/이미지를 복원한다. 손상됐거나 없으면 빈 상태로 시작. */
function loadChatGenHistory() {
    try {
        const raw = JSON.parse(localStorage.getItem(CHATGEN_HISTORY_KEY) || '{}');
        return {
            messages: Array.isArray(raw.messages) ? raw.messages : [],
            positive: raw.positive || '',
            negative: raw.negative || '',
            lastImage: raw.lastImage || null,
        };
    } catch (e) {
        return { messages: [], positive: '', negative: '', lastImage: null };
    }
}

/** 지금 상태를 그대로 localStorage에 저장한다(렌더링마다 호출 — 채팅 빈도가 낮아서 디바운스 불필요). */
function saveChatGenHistory() {
    try {
        localStorage.setItem(CHATGEN_HISTORY_KEY, JSON.stringify({
            messages: chatGenMessages,
            positive: chatGenState.positive,
            negative: chatGenState.negative,
            lastImage: chatGenState.lastImage,
        }));
    } catch (e) { /* 용량 초과 등은 조용히 무시(채팅 자체는 계속 동작) */ }
}

/** 채팅 기록을 전부 지우고 새 대화로 시작한다. */
function clearChatGenHistory() {
    if (chatGenMessages.length && !confirm('지금까지의 대화 기록을 전부 지울까요? 되돌릴 수 없습니다.')) return;
    chatGenMessages = [];
    chatGenState.positive = '';
    chatGenState.negative = '';
    chatGenState.lastImage = null;
    saveChatGenHistory();
    renderChatGenLog();
    renderChatGenPromptPreview();
}
window.clearChatGenHistory = clearChatGenHistory;

const __chatGenRestored = loadChatGenHistory();
let chatGenMessages = __chatGenRestored.messages; // [{role:'user'|'assistant', text, image?:{filename,subfolder,type}}] — localStorage(chatGenHistory)에서 복원됨
let chatGenState = { positive: __chatGenRestored.positive, negative: __chatGenRestored.negative, lastImage: __chatGenRestored.lastImage, busy: false }; // 현재 제안된 프롬프트 + 직전 생성 이미지(비전 입력용), 역시 복원됨

/** 채팅 전용 공급자 설정(제너레이션용 키와는 별도)을 읽어온다. */
function getChatGenSettings() {
    const defaults = { provider: 'gemini', geminiKey: '', gptKey: '', customEndpoint: '', customModel: '', customKey: '' };
    try {
        const raw = JSON.parse(localStorage.getItem(CHATGEN_SETTINGS_KEY) || '{}');
        return Object.assign(defaults, raw);
    } catch (e) {
        return defaults;
    }
}

function saveChatGenSettings(patch) {
    const next = Object.assign(getChatGenSettings(), patch);
    localStorage.setItem(CHATGEN_SETTINGS_KEY, JSON.stringify(next));
    return next;
}
window.getChatGenSettings = getChatGenSettings;
window.saveChatGenSettings = saveChatGenSettings;

/** 🎲 랜덤 프리셋으로 생성 버튼 옆에 "💬 대화하며 이미지 뽑기" 버튼을 한 번만 끼워넣는다. */
function ensureChatGenUI() {
    if (document.getElementById('chatgen-open-btn')) return;
    const presetGroup = document.getElementById('gen-preset')?.closest('.form-group');
    if (!presetGroup || !presetGroup.parentElement) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'chatgen-open-btn';
    btn.className = 'btn-secondary';
    btn.style.cssText = 'margin-top:6px; margin-left:6px; border-color:#4FC3F7; color:#4FC3F7;';
    btn.textContent = '💬 대화하며 이미지 뽑기';
    btn.onclick = openChatGenModal;

    const randomBtn = document.getElementById('random-preset-generate-btn');
    if (randomBtn) randomBtn.insertAdjacentElement('afterend', btn);
    else presetGroup.insertAdjacentElement('afterend', btn);

    buildChatGenModal();
}

/** 채팅 모달을 한 번만 만들어서 body에 붙인다(열고 닫는 건 display 토글로만 처리). */
function buildChatGenModal() {
    if (document.getElementById('chatgen-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'chatgen-modal';
    modal.style.cssText = 'display:none; position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; align-items:center; justify-content:center;';
    modal.innerHTML = `
      <div style="background:#1a1a1a; border:1px solid #444; border-radius:10px; width:min(560px,92vw); max-height:86vh; display:flex; flex-direction:column; overflow:hidden;">
        <div style="display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-bottom:1px solid #333;">
          <strong>💬 대화하며 이미지 뽑기</strong>
          <div style="display:flex; gap:6px;">
            <button type="button" id="chatgen-clear-btn" class="btn-secondary" style="padding:2px 10px; font-size:0.8em;" title="지금까지의 대화 기록을 전부 지웁니다">🗑 대화 초기화</button>
            <button type="button" id="chatgen-close-btn" class="btn-secondary" style="padding:2px 10px;">✕</button>
          </div>
        </div>
        <div style="padding:10px 16px; border-bottom:1px solid #333; display:flex; flex-wrap:wrap; gap:8px; align-items:center; font-size:0.85em;">
          <label style="margin:0;">공급자:</label>
          <select id="chatgen-provider" style="background:#222; border:1px solid #555; color:#fff; border-radius:4px; padding:4px 6px;">
            <option value="gemini">Gemini</option>
            <option value="gpt">GPT (OpenAI)</option>
            <option value="custom">커스텀 (OpenAI 호환 엔드포인트 — 로컬 LLM 등)</option>
          </select>
          <input type="password" id="chatgen-key" placeholder="API 키 (커스텀은 선택사항 — 로컬 서버는 보통 불필요)" style="flex:1; min-width:140px; background:#222; border:1px solid #555; color:#fff; border-radius:4px; padding:4px 6px;">
        </div>
        <div id="chatgen-custom-row" style="display:none; padding:0 16px 10px; flex-wrap:wrap; gap:8px; font-size:0.85em; border-bottom:1px solid #333;">
          <input type="text" id="chatgen-custom-endpoint" placeholder="엔드포인트 URL (예: http://localhost:11434/v1/chat/completions)" style="flex:2; min-width:220px; background:#222; border:1px solid #555; color:#fff; border-radius:4px; padding:4px 6px;">
          <input type="text" id="chatgen-custom-model" placeholder="모델명 (예: llama3.2-vision)" style="flex:1; min-width:140px; background:#222; border:1px solid #555; color:#fff; border-radius:4px; padding:4px 6px;">
        </div>
        <div id="chatgen-log" style="flex:1; overflow-y:auto; padding:12px 16px; display:flex; flex-direction:column; gap:8px; min-height:200px;"></div>
        <div id="chatgen-prompt-preview" style="display:none; padding:8px 16px; border-top:1px solid #333; background:#15202b; font-size:0.78em; color:#9fd3f7;"></div>
        <div style="display:flex; gap:8px; padding:10px 16px; border-top:1px solid #333;">
          <textarea id="chatgen-input" rows="2" placeholder="예: 비 오는 밤 골목길에 서 있는 여자아이 그려줘" style="flex:1; resize:none; background:#222; border:1px solid #555; color:#fff; border-radius:6px; padding:6px 8px;"></textarea>
          <div style="display:flex; flex-direction:column; gap:4px;">
            <button type="button" id="chatgen-send-btn" class="btn-primary">보내기</button>
            <button type="button" id="chatgen-generate-btn" class="btn-secondary" style="display:none; border-color:#81C784; color:#81C784;">🎨 생성</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const providerSel = modal.querySelector('#chatgen-provider');
    const keyInput = modal.querySelector('#chatgen-key');
    const customRow = modal.querySelector('#chatgen-custom-row');
    const endpointInput = modal.querySelector('#chatgen-custom-endpoint');
    const modelInput = modal.querySelector('#chatgen-custom-model');

    function loadIntoFields() {
        const s = getChatGenSettings();
        providerSel.value = s.provider;
        customRow.style.display = s.provider === 'custom' ? 'flex' : 'none';
        keyInput.value = s.provider === 'gemini' ? s.geminiKey : s.provider === 'gpt' ? s.gptKey : s.customKey;
        endpointInput.value = s.customEndpoint;
        modelInput.value = s.customModel;
    }
    loadIntoFields();

    providerSel.onchange = () => { saveChatGenSettings({ provider: providerSel.value }); loadIntoFields(); };
    keyInput.onchange = () => {
        const p = providerSel.value;
        if (p === 'gemini') saveChatGenSettings({ geminiKey: keyInput.value });
        else if (p === 'gpt') saveChatGenSettings({ gptKey: keyInput.value });
        else saveChatGenSettings({ customKey: keyInput.value });
    };
    endpointInput.onchange = () => saveChatGenSettings({ customEndpoint: endpointInput.value });
    modelInput.onchange = () => saveChatGenSettings({ customModel: modelInput.value });

    modal.querySelector('#chatgen-close-btn').onclick = closeChatGenModal;
    modal.querySelector('#chatgen-clear-btn').onclick = clearChatGenHistory;
    modal.addEventListener('click', (e) => { if (e.target === modal) closeChatGenModal(); });
    modal.querySelector('#chatgen-send-btn').onclick = sendChatGenMessage;
    modal.querySelector('#chatgen-generate-btn').onclick = chatGenGenerate;
    modal.querySelector('#chatgen-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatGenMessage(); }
    });
}

function openChatGenModal() {
    buildChatGenModal();
    document.getElementById('chatgen-modal').style.display = 'flex';
    renderChatGenLog();
    renderChatGenPromptPreview(); // 🆕 새로고침 전에 제안받아둔 프롬프트가 있으면 복원해서 바로 보여줌
}
window.openChatGenModal = openChatGenModal;

function closeChatGenModal() {
    const modal = document.getElementById('chatgen-modal');
    if (modal) modal.style.display = 'none';
}
window.closeChatGenModal = closeChatGenModal;

/** {filename, subfolder, type} → ComfyUI /view 주소. 이 앱 전체에서 쓰는 패턴과 동일. */
function chatGenImageUrl(img) {
    return `/view?filename=${encodeURIComponent(img.filename)}&type=${encodeURIComponent(img.type || 'output')}&subfolder=${encodeURIComponent(img.subfolder || '')}&t=${Date.now()}`;
}

function renderChatGenLog() {
    const log = document.getElementById('chatgen-log');
    if (!log) return;
    if (chatGenMessages.length === 0) {
        log.innerHTML = `<div style="color:#888; font-size:0.85em; text-align:center; margin-top:20px;">어떤 그림을 원하시는지 편하게 말씀해주세요.</div>`;
        return;
    }
    log.innerHTML = chatGenMessages.map(m => {
        const isUser = m.role === 'user';
        const safe = (m.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const img = m.image ? `<img src="${chatGenImageUrl(m.image)}" style="max-width:100%; border-radius:8px; margin-top:6px; display:block;">` : '';
        return `<div style="align-self:${isUser ? 'flex-end' : 'flex-start'}; max-width:80%; background:${isUser ? '#2a4d6e' : '#2a2a2a'}; color:#eee; padding:8px 12px; border-radius:10px; font-size:0.9em; white-space:pre-wrap;">${safe}${img}</div>`;
    }).join('');
    log.scrollTop = log.scrollHeight;
    saveChatGenHistory(); // 🆕 로그가 바뀔 때마다(메시지 추가/삭제) 바로 저장 — 새로고침해도 안 사라짐
}

/** 현재 제안된 프롬프트(chatGenState.positive/negative)를 입력창 위 미리보기 줄에 보여주고,
 *  있으면 "🎨 생성" 버튼을 드러낸다. */
function renderChatGenPromptPreview() {
    const bar = document.getElementById('chatgen-prompt-preview');
    const genBtn = document.getElementById('chatgen-generate-btn');
    if (!bar || !genBtn) return;
    if (!chatGenState.positive) {
        bar.style.display = 'none';
        genBtn.style.display = 'none';
        return;
    }
    bar.style.display = 'block';
    genBtn.style.display = 'block';
    bar.innerHTML = `<b>제안된 프롬프트:</b> ${chatGenState.positive.replace(/</g, '&lt;')}`
        + (chatGenState.negative ? `<br><b>네거티브:</b> ${chatGenState.negative.replace(/</g, '&lt;')}` : '');
}

/** 입력창에 보내기 버튼을 누르면: 사용자 메시지를 채팅에 쌓고, 백엔드(/assetmanager/api/chatgen_message)에
 *  전체 대화 기록(+직전 생성 이미지가 있으면 그것도 비전 입력으로) 보내서 "답변 + 제안 프롬프트"를 받아온다.
 *  받은 제안 프롬프트는 즉시 생성하지 않고 미리보기 줄 + 🎨 생성 버튼으로만 보여준다 —
 *  "대화가 먼저고, 뽑는 건 사용자가 원할 때" 요구사항에 맞춤. */
async function sendChatGenMessage() {
    const input = document.getElementById('chatgen-input');
    const sendBtn = document.getElementById('chatgen-send-btn');
    const text = (input.value || '').trim();
    if (!text || chatGenState.busy) return;

    const s = getChatGenSettings();
    const hasKey = s.provider === 'gemini' ? !!s.geminiKey : s.provider === 'gpt' ? !!s.gptKey : !!s.customEndpoint;

    chatGenMessages.push({ role: 'user', text });
    input.value = '';
    renderChatGenLog();

    if (!hasKey) {
        chatGenMessages.push({
            role: 'assistant',
            text: s.provider === 'custom' ? '⚠️ 커스텀 엔드포인트 URL이 비어있습니다. 위에서 입력해주세요.' : '⚠️ API 키가 비어있습니다. 위에서 입력해주세요.'
        });
        renderChatGenLog();
        return;
    }

    chatGenState.busy = true;
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '...'; }

    try {
        const body = {
            provider: s.provider,
            apiKey: s.provider === 'gemini' ? s.geminiKey : s.provider === 'gpt' ? s.gptKey : s.customKey,
            endpoint: s.customEndpoint,
            model: s.customModel,
            messages: chatGenMessages.map(m => ({ role: m.role, text: m.text })),
            image: chatGenState.lastImage
        };
        const res = await fetch('/assetmanager/api/chatgen_message', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!data.ok) {
            chatGenMessages.push({ role: 'assistant', text: `⚠️ ${data.error || '알 수 없는 오류'}` });
        } else {
            chatGenMessages.push({ role: 'assistant', text: data.reply || '(답변 없음)' });
            if (data.positive_prompt) {
                chatGenState.positive = data.positive_prompt;
                chatGenState.negative = data.negative_prompt || '';
            }
        }
    } catch (e) {
        chatGenMessages.push({ role: 'assistant', text: `⚠️ 서버 통신 오류: ${e}` });
    } finally {
        chatGenState.busy = false;
        if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '보내기'; }
        renderChatGenLog();
        renderChatGenPromptPreview();
    }
}
window.sendChatGenMessage = sendChatGenMessage;

/** 🎨 생성 버튼: 지금까지 대화로 다듬은 제안 프롬프트로 실제 생성한다. 기존 executeGeneration()을
 *  그대로 재사용하므로, 현재 Generate 탭에 골라둔 체크포인트/아키텍처/고급설정이 그대로 적용된다
 *  (채팅은 프롬프트를 짓는 역할만 하고, 모델/설정은 평소 쓰던 화면을 그대로 신뢰한다).
 *  생성된 이미지는 채팅창에 썸네일로 남고, chatGenState.lastImage에 저장돼서 다음 메시지를
 *  보낼 때 비전 입력으로 같이 전달된다("이 이미지에서 ~ 바꿔줘" 같은 수정 요청용). */
async function chatGenGenerate() {
    if (!chatGenState.positive || chatGenState.busy) return;
    if (typeof executeGeneration !== 'function') {
        alert('generateImage/executeGeneration을 찾을 수 없습니다 — generate.js가 로드됐는지 확인해주세요.');
        return;
    }
    const genBtn = document.getElementById('chatgen-generate-btn');
    chatGenState.busy = true;
    if (genBtn) { genBtn.disabled = true; genBtn.textContent = '생성 중...'; }
    chatGenMessages.push({ role: 'assistant', text: '🎨 생성 중입니다...' });
    renderChatGenLog();

    try {
        const results = await executeGeneration(chatGenState.positive, chatGenState.negative || '', 'chatgen');
        chatGenMessages.pop(); // "생성 중입니다..." 안내 제거
        if (results && results.length) {
            chatGenState.lastImage = { filename: results[0].filename, subfolder: results[0].subfolder, type: results[0].type };
            chatGenMessages.push({ role: 'assistant', text: '다 됐습니다! 더 바꾸고 싶은 부분이 있으면 편하게 말씀해주세요.', image: chatGenState.lastImage });
        } else {
            chatGenMessages.push({ role: 'assistant', text: '⚠️ 생성에 실패했습니다. 위쪽 생성 탭 설정(체크포인트/API 키 등)을 확인해주세요.' });
        }
    } catch (e) {
        chatGenMessages.pop();
        chatGenMessages.push({ role: 'assistant', text: `⚠️ 생성 중 오류: ${e}` });
    } finally {
        chatGenState.busy = false;
        if (genBtn) { genBtn.disabled = false; genBtn.textContent = '🎨 생성'; }
        renderChatGenLog();
    }
}
window.chatGenGenerate = chatGenGenerate;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureChatGenUI);
} else {
    ensureChatGenUI();
}

/* ──────────────────────────────────────────────
   로라 select 검색 기능 — 로라가 많아져서 드롭다운 스크롤이 힘드니
   타이핑하면 필터링되는 검색창으로 바꿔준다.
   수동 추가/랜덤 로라/매칭 기능 등 어떤 경로로 로라 행이 생기든
   MutationObserver로 자동 감지해서 검색 기능을 붙인다.
   ────────────────────────────────────────────── */

/** select 하나를 "검색 가능한 콤보박스"로 바꾼다. 원래 select는 숨겨진 채로 그대로 두고
    (generate.js 등 기존 코드는 여전히 select.value를 그대로 읽으므로 호환됨),
    그 위에 텍스트 입력 + 필터링되는 드롭다운 목록을 겹쳐서 보여준다. */
function enhanceLoraSelectWithSearch(select) {
    if (!select || select.dataset.searchEnhanced || !select.parentElement) return;
    select.dataset.searchEnhanced = '1';

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:relative; flex:1; min-width:0;';
    select.parentElement.insertBefore(wrapper, select);
    wrapper.appendChild(select);
    select.style.display = 'none';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '로라 검색...';
    input.autocomplete = 'off';
    input.style.cssText = 'width:100%; box-sizing:border-box; background:#111; border:1px solid #333; color:#fff; border-radius:6px; padding:6px;';
    wrapper.appendChild(input);

    const list = document.createElement('div');
    list.style.cssText = 'position:absolute; top:100%; left:0; right:0; z-index:500; background:#1e1e1e; border:1px solid #4CAF50; border-radius:6px; max-height:220px; overflow-y:auto; display:none; box-shadow:0 4px 12px rgba(0,0,0,0.5);';
    wrapper.appendChild(list);

    const getOptions = () => Array.from(select.options).filter(o => o.value).map(o => ({ value: o.value, text: o.text }));

    const syncInputFromSelect = () => {
        const opt = getOptions().find(o => o.value === select.value);
        input.value = opt ? opt.text : '';
    };
    syncInputFromSelect();

    const renderList = (filterText) => {
        const q = (filterText || '').toLowerCase();
        const options = getOptions();
        const filtered = q ? options.filter(o => o.text.toLowerCase().includes(q)) : options;

        if (filtered.length === 0) {
            list.innerHTML = '<div style="padding:8px; color:#888; font-size:0.85em;">일치하는 로라가 없습니다</div>';
        } else {
            list.innerHTML = filtered.slice(0, 150).map(o => `
                <div class="lora-search-option" data-value="${o.value.replace(/"/g, '&quot;')}"
                    style="padding:6px 8px; font-size:0.85em; color:#ddd; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${o.text}</div>
            `).join('');
            list.querySelectorAll('.lora-search-option').forEach(el => {
                el.onmouseenter = () => { el.style.background = '#2a2a2a'; };
                el.onmouseleave = () => { el.style.background = ''; };
                /* blur보다 클릭이 먼저 처리되게 mousedown에서 처리 (안 그러면 blur가 먼저 발동해서 클릭이 씹힘) */
                el.onmousedown = (ev) => {
                    ev.preventDefault();
                    select.value = el.dataset.value;
                    syncInputFromSelect();
                    list.style.display = 'none';
                    if (typeof persistLoraChange === 'function') persistLoraChange();
                };
            });
        }
        list.style.display = 'block';
    };

    input.addEventListener('focus', () => {
        input.select();
        renderList('');
    });
    input.addEventListener('input', () => renderList(input.value));
    input.addEventListener('blur', () => {
        setTimeout(() => { list.style.display = 'none'; syncInputFromSelect(); }, 120);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { list.style.display = 'none'; syncInputFromSelect(); input.blur(); }
    });
}

/** 지정한 컨테이너 안에 지금 있는(+ 앞으로 추가될) 모든 .lora-item select에
    자동으로 검색 기능을 붙인다 (수동 추가/랜덤 로라/매칭 기능 등 출처 상관없이 다 잡아냄) */
function ensureLoraSelectSearchObserver(containerId) {
    const container = document.getElementById(containerId);
    if (!container || container.dataset.searchObserverBound) return;
    container.dataset.searchObserverBound = '1';

    container.querySelectorAll('.lora-item select').forEach(enhanceLoraSelectWithSearch);

    const observer = new MutationObserver((mutations) => {
        mutations.forEach(m => {
            m.addedNodes.forEach(node => {
                if (node.nodeType !== 1) return;
                if (node.matches && node.matches('.lora-item')) {
                    const sel = node.querySelector('select');
                    if (sel) enhanceLoraSelectWithSearch(sel);
                } else if (node.querySelectorAll) {
                    node.querySelectorAll('.lora-item select').forEach(enhanceLoraSelectWithSearch);
                }
            });
        });
    });
    observer.observe(container, { childList: true, subtree: true });
}

function ensureAllLoraSelectSearchObservers() {
    /* 화면 상단 공통 로라 목록 + 조각 편집 모달의 "이 조각 전용 로라" 목록 둘 다 적용 */
    ensureLoraSelectSearchObserver('selected-loras');
    ensureLoraSelectSearchObserver('edit-prompt-loras');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureAllLoraSelectSearchObservers);
} else {
    ensureAllLoraSelectSearchObservers();
}


/* ══════════════════════════════════════════════
   🔢 조각 번호표 / 대조 (🛠️ 도구 탭 "조각 번호표/대조", index.html의 #tab-tools-numcheck)
   - 그룹을 고르면 "몇 번에 어떤 조각이 있는지"를 이름만 표로 보여주고, 번호/이름을 바로 수정
   - "(사과,딸기,바나나)" 같은 기대 목록을 번호 순서대로(첫 단어=1번 조각…) 조각 이름과 대조
   - 대조 결과(✅/❌)는 이미지 검수 화면의 조각 이름 옆에도 표시됨 (appendNumCheckBadge)
   번호 규칙은 검수 화면의 "그룹 내 N번"(getGroupPositionForJob)과 동일: 지정 번호(customNumber)가 있으면 그 값, 없으면 그룹 내 순서(1부터).
   ══════════════════════════════════════════════ */
const NUMCHECK_STORE_KEY = 'am_numcheck_v1';

function loadNumCheckStore() {
    try {
        const o = JSON.parse(localStorage.getItem(NUMCHECK_STORE_KEY) || '{}');
        return { badge: o.badge !== false, expected: o.expected || {}, lastCat: o.lastCat || '' };
    } catch (e) { return { badge: true, expected: {}, lastCat: '' }; }
}
function saveNumCheckStore(st) {
    try { localStorage.setItem(NUMCHECK_STORE_KEY, JSON.stringify(st)); } catch (e) {}
}

/** 조각의 번호: 지정 번호(customNumber)가 있으면 그 값, 없으면 그룹 안 순서(1부터) */
function getItemEffectiveNumber(cat, item) {
    if (item.customNumber !== undefined && item.customNumber !== null && item.customNumber !== '') {
        const n = parseInt(item.customNumber, 10);
        if (!isNaN(n)) return n;
    }
    return cat.items.indexOf(item) + 1;
}

/** "(사과,딸기,바나나)" → ['사과','딸기','바나나']
 *  - 바깥 괄호는 있어도 없어도 됨, 빈칸은 건너뜀 표시로 '' 유지
 *  - 🆕 따옴표로 감싸도 인식: ("사과","딸기"), '사과','딸기', “사과”, 「사과」 …
 *      · 항목마다 감싼 경우는 따옴표 안의 콤마도 그 항목의 일부로 본다: "사과, 빨강","딸기" → ['사과, 빨강','딸기']
 *      · 전체를 한 번에 감싼 경우("사과,딸기,바나나")는 바깥 따옴표만 벗기고 콤마로 나눈다
 *      · 따옴표는 "항목의 맨 앞/맨 뒤"에 있을 때만 따옴표로 취급해서 Pirate's Gold 같은 이름 중간의 ' 는 건드리지 않음
 *      · 짝이 안 맞는 따옴표는 항목 가장자리에서 그냥 지움 */
function parseNumCheckExpected(text) {
    let t = String(text || '').trim();
    if (!t) return [];
    t = t.replace(/^[\(\[（【]\s*/, '').replace(/\s*[\)\]）】]$/, '').trim();
    const OPEN = '"\'“”‘’「『', CLOSE = '"\'“”‘’」』';
    const isDelim = ch => ch === ',' || ch === '，' || ch === '\n';
    // 전체가 따옴표 한 쌍으로만 감싸진 경우 → 바깥 따옴표만 벗김
    if (t.length >= 2 && OPEN.includes(t[0]) && CLOSE.includes(t[t.length - 1]) && ![...t.slice(1, -1)].some(ch => OPEN.includes(ch) || CLOSE.includes(ch))) {
        t = t.slice(1, -1).trim();
    }
    const out = [];
    const n = t.length;
    let i = 0;
    while (true) {
        while (i < n && (t[i] === ' ' || t[i] === '\t')) i++;
        if (i < n && OPEN.includes(t[i])) {
            // 이 따옴표의 짝: 뒤에 (공백 후) 구분자나 끝이 오는 닫는 따옴표
            let found = -1;
            for (let j = i + 1; j < n; j++) {
                if (!CLOSE.includes(t[j])) continue;
                let k = j + 1;
                while (k < n && (t[k] === ' ' || t[k] === '\t')) k++;
                if (k >= n || isDelim(t[k])) { found = j; break; }
            }
            if (found !== -1) {
                out.push(t.slice(i + 1, found).trim());
                let k = found + 1;
                while (k < n && (t[k] === ' ' || t[k] === '\t')) k++;
                if (k >= n) break;
                i = k + 1; // 구분자 다음으로
                continue;
            }
        }
        let j = i;
        while (j < n && !isDelim(t[j])) j++;
        out.push(t.slice(i, j).trim().replace(/^["“”‘’「『]+|["“”‘’」』]+$/g, '').trim()); // 짝 없는 따옴표는 가장자리에서 제거
        if (j >= n) break;
        i = j + 1;
    }
    return out;
}
function numCheckNorm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ''); }
/** 조각 이름에 기대 단어가 들어있으면 true, 아니면 false, 기대 단어가 비었으면 null(건너뜀) */
function numCheckMatches(name, expected) {
    const e = numCheckNorm(expected);
    if (!e) return null;
    return numCheckNorm(name).includes(e);
}

/** 검수 화면용: job의 조각이 기대 목록과 맞는지 → {text,color} 또는 null(표시 안 함) */
function getNumCheckBadgeForJob(job) {
    const st = loadNumCheckStore();
    if (!st.badge) return null;
    if (!job || !job.sourceRefs || job.sourceRefs.length === 0) return null;
    const ref = job.sourceRefs[0];
    const cat = getAllCategories().find(c => c.id === ref.catId);
    if (!cat) return null;
    const text = st.expected[cat.id];
    if (!text || !text.trim()) return null;
    const item = cat.items.find(it => it.id === ref.itemId);
    if (!item) return null;
    const n = getItemEffectiveNumber(cat, item);
    const exp = parseNumCheckExpected(text)[n - 1];
    if (!exp) return null;
    return numCheckMatches(item.name, exp)
        ? { text: `✅ 대조 일치 (${exp})`, color: '#4CAF50' }
        : { text: `❌ 대조 불일치 — ${n}번 기대: ${exp} / 실제: ${item.name}`, color: '#ef5350' };
}
function appendNumCheckBadge(labelEl, job) {
    if (!labelEl) return;
    const b = getNumCheckBadgeForJob(job);
    if (!b) return;
    const span = document.createElement('span');
    span.style.cssText = `margin-left:10px; padding:2px 8px; border-radius:5px; font-size:0.85em; background:${b.color}33; color:${b.color};`;
    span.textContent = b.text;
    labelEl.appendChild(span);
}

function getNumCheckCurrentCat() {
    const sel = document.getElementById('numcheck-group');
    if (!sel) return null;
    return getAllCategories().find(c => c.id === sel.value) || null;
}
function getNumCheckRows(cat) {
    const rows = cat.items.map((item, idx) => ({ item, idx, n: getItemEffectiveNumber(cat, item) }));
    rows.sort((a, b) => a.n - b.n || a.idx - b.idx);
    return rows;
}
function numCheckPersistLibrary() {
    if (typeof debounceLibrarySave === 'function') debounceLibrarySave();
    if (typeof renderItems === 'function') { try { renderItems(); } catch (e) {} }
    if (typeof renderBuilder === 'function') { try { renderBuilder(); } catch (e) {} }
}

function ensureNumCheckUI() {
    const root = document.getElementById('numcheck-root');
    if (!root) return null;
    if (root.dataset.ready === '1') return root;
    root.dataset.ready = '1';
    const inputCss = 'background:#222; border:1px solid #555; color:#fff; border-radius:4px; padding:6px; box-sizing:border-box;';
    root.innerHTML = `
        <h2 style="margin:0 0 6px;">🔢 조각 번호표 / 대조</h2>
        <p style="color:#aaa; margin:0 0 14px; font-size:0.9em;">
            그룹 안에서 <b>몇 번에 어떤 조각</b>이 있는지(이름만) 확인·수정하고, "사과,딸기,바나나" 같은 목록과 번호 순서대로 <b>대조</b>합니다.
            대조 결과는 이미지 검수 화면에도 같이 표시됩니다.
        </p>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
            <label for="numcheck-group" style="color:#ccc;">그룹</label>
            <select id="numcheck-group" style="min-width:240px; ${inputCss}"></select>
            <button id="numcheck-refresh" class="btn-secondary" style="padding:6px 12px;">🔄 새로고침</button>
        </div>
        <div style="display:flex; gap:18px; flex-wrap:wrap; align-items:flex-start;">
            <div style="flex:1 1 460px; min-width:320px;">
                <h3 style="margin:0 0 6px;">번호표 (이름만)</h3>
                <div id="numcheck-table" style="max-height:55vh; overflow-y:auto; background:#1a1a1a; border:1px solid #333; border-radius:8px; padding:6px;"></div>
                <h4 style="margin:14px 0 4px;">텍스트로 한꺼번에 보기 / 수정</h4>
                <textarea id="numcheck-bulk" rows="4" style="width:100%; ${inputCss} resize:vertical;"></textarea>
                <div style="font-size:0.78em; color:#888; margin:3px 0 6px;">
                    형식: <b>1.사과, 2.딸기</b> (번호.이름 — 콤마나 줄바꿈으로 구분). 번호가 맞는 조각의 <b>이름만</b> 바뀝니다. 번호 자체는 위 표의 번호 칸에서 바꾸세요.
                </div>
                <button id="numcheck-bulk-apply" class="btn-secondary" style="padding:6px 12px;">✏️ 텍스트대로 이름 적용</button>
                <span id="numcheck-bulk-msg" style="margin-left:8px; font-size:0.85em;"></span>
            </div>
            <div style="flex:1 1 380px; min-width:300px;">
                <h3 style="margin:0 0 6px;">대조</h3>
                <textarea id="numcheck-expected" rows="3" placeholder="(사과,딸기,바나나)" style="width:100%; ${inputCss} resize:vertical;"></textarea>
                <div style="font-size:0.78em; color:#888; margin:3px 0 6px;">
                    첫 단어는 1번 조각, 둘째는 2번 조각… 과 비교해서 조각 이름에 그 단어가 <b>들어있으면 일치</b>. 빈칸(사과,,바나나)은 그 번호를 건너뜁니다. 따옴표로 감싸도 됩니다 ("사과","딸기","바나나").
                </div>
                <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:0.9em; color:#ccc;">
                    <input type="checkbox" id="numcheck-badge-toggle"> 이미지 검수 화면에 일치/불일치 표시
                </label>
                <div id="numcheck-result" style="margin-top:10px; background:#1a1a1a; border:1px solid #333; border-radius:8px; padding:8px; max-height:45vh; overflow-y:auto;"></div>
            </div>
        </div>`;

    document.getElementById('numcheck-refresh').onclick = () => renderNumCheckTool();
    document.getElementById('numcheck-group').addEventListener('change', () => {
        const st = loadNumCheckStore(); st.lastCat = document.getElementById('numcheck-group').value; saveNumCheckStore(st);
        renderNumCheckAll();
    });
    document.getElementById('numcheck-expected').addEventListener('input', () => {
        const cat = getNumCheckCurrentCat(); if (!cat) return;
        const st = loadNumCheckStore();
        const v = document.getElementById('numcheck-expected').value;
        if (v.trim()) st.expected[cat.id] = v; else delete st.expected[cat.id];
        saveNumCheckStore(st);
        renderNumCheckTable(); renderNumCheckResult();
    });
    document.getElementById('numcheck-badge-toggle').addEventListener('change', (e) => {
        const st = loadNumCheckStore(); st.badge = e.target.checked; saveNumCheckStore(st);
    });
    document.getElementById('numcheck-bulk-apply').onclick = applyNumCheckBulk;
    return root;
}

function renderNumCheckTool() {
    if (!ensureNumCheckUI()) return;
    const sel = document.getElementById('numcheck-group');
    const cats = getAllCategories();
    const st = loadNumCheckStore();
    const prev = sel.value || st.lastCat || ((typeof activeCategoryId !== 'undefined') ? activeCategoryId : '');
    sel.innerHTML = '';
    cats.forEach(c => {
        const o = document.createElement('option');
        o.value = c.id; o.textContent = `${c.name} (${c.items.length}개)`;
        sel.appendChild(o);
    });
    if (cats.some(c => c.id === prev)) sel.value = prev;
    document.getElementById('numcheck-badge-toggle').checked = st.badge;
    renderNumCheckAll();
}

function renderNumCheckAll() {
    const cat = getNumCheckCurrentCat();
    const exp = document.getElementById('numcheck-expected');
    if (exp) exp.value = cat ? (loadNumCheckStore().expected[cat.id] || '') : '';
    renderNumCheckTable();
    renderNumCheckResult();
}

function renderNumCheckTable() {
    const box = document.getElementById('numcheck-table');
    const bulk = document.getElementById('numcheck-bulk');
    if (!box) return;
    const cat = getNumCheckCurrentCat();
    box.innerHTML = '';
    if (!cat || cat.items.length === 0) {
        box.innerHTML = '<div style="color:#777; padding:10px;">(이 그룹에는 조각이 없습니다)</div>';
        if (bulk) bulk.value = '';
        return;
    }
    const rows = getNumCheckRows(cat);
    const countByN = {};
    rows.forEach(r => { countByN[r.n] = (countByN[r.n] || 0) + 1; });
    const expectedList = parseNumCheckExpected(loadNumCheckStore().expected[cat.id]);
    const hasExpected = expectedList.some(x => x);
    const inputCss = 'background:#222; border:1px solid #555; color:#fff; border-radius:4px; padding:4px 6px; box-sizing:border-box;';

    rows.forEach(({ item, n }) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:6px; padding:3px 2px; border-bottom:1px solid #2a2a2a;';

        const numInput = document.createElement('input');
        numInput.type = 'number'; numInput.value = n; numInput.min = '0';
        numInput.title = '조각 번호 (비우면 그룹 내 순서로 자동)';
        numInput.style.cssText = inputCss + ' width:64px;';
        numInput.addEventListener('change', () => {
            const v = numInput.value.trim();
            if (v === '') delete item.customNumber;
            else {
                const num = parseInt(v, 10);
                if (isNaN(num)) { numInput.value = n; return; }
                item.customNumber = num;
            }
            numCheckPersistLibrary();
            renderNumCheckTable(); renderNumCheckResult();
        });

        const nameInput = document.createElement('input');
        nameInput.type = 'text'; nameInput.value = item.name || '';
        nameInput.style.cssText = inputCss + ' flex:1; min-width:0;';
        nameInput.addEventListener('change', () => {
            const v = nameInput.value.trim();
            if (!v) { nameInput.value = item.name || ''; return; }
            item.name = v;
            numCheckPersistLibrary();
            renderNumCheckTable(); renderNumCheckResult();
        });

        row.appendChild(numInput);
        row.appendChild(nameInput);

        if (countByN[n] > 1) {
            const warn = document.createElement('span');
            warn.textContent = '⚠️'; warn.title = `같은 번호(${n})를 쓰는 조각이 ${countByN[n]}개 있습니다`;
            row.appendChild(warn);
        }
        if (hasExpected) {
            const exp = expectedList[n - 1];
            const res = exp ? numCheckMatches(item.name, exp) : null;
            const tag = document.createElement('span');
            tag.style.cssText = 'font-size:0.82em; white-space:nowrap; min-width:92px; text-align:right;';
            if (res === null) { tag.textContent = exp === undefined ? '목록 밖' : '건너뜀'; tag.style.color = '#777'; }
            else if (res) { tag.textContent = `✅ ${exp}`; tag.style.color = '#4CAF50'; }
            else { tag.textContent = `❌ ${exp}`; tag.style.color = '#ef5350'; }
            row.appendChild(tag);
        }
        box.appendChild(row);
    });
    if (bulk) bulk.value = rows.map(r => `${r.n}.${r.item.name}`).join(', ');
}

function renderNumCheckResult() {
    const box = document.getElementById('numcheck-result');
    if (!box) return;
    const cat = getNumCheckCurrentCat();
    const list = cat ? parseNumCheckExpected(loadNumCheckStore().expected[cat.id]) : [];
    if (!cat || !list.some(x => x)) {
        box.innerHTML = '<span style="color:#777;">위에 기대 목록(예: (사과,딸기,바나나))을 적으면 번호 순서대로 대조한 결과가 여기에 나옵니다.</span>';
        return;
    }
    const rows = getNumCheckRows(cat);
    let ok = 0, bad = 0, missing = 0, skipped = 0;
    const esc = s => String(s).replace(/</g, '&lt;');
    const lines = [];
    list.forEach((exp, i) => {
        const k = i + 1;
        if (!exp) { skipped++; return; }
        const hit = rows.find(r => r.n === k);
        if (!hit) { missing++; lines.push(`<div style="color:#FFB74D;">⚠️ ${k}번 — 해당 번호의 조각이 없음 (기대: ${esc(exp)})</div>`); return; }
        if (numCheckMatches(hit.item.name, exp)) { ok++; lines.push(`<div style="color:#4CAF50;">✅ ${k}번 — ${esc(hit.item.name)} (기대: ${esc(exp)})</div>`); }
        else { bad++; lines.push(`<div style="color:#ef5350;">❌ ${k}번 — ${esc(hit.item.name)} (기대: ${esc(exp)})</div>`); }
    });
    const extra = rows.filter(r => r.n > list.length || r.n < 1);
    const summary = `<div style="margin-bottom:6px; font-weight:bold;">✅ 일치 ${ok} · ❌ 불일치 ${bad} · ⚠️ 조각 없음 ${missing}${skipped ? ` · 건너뜀 ${skipped}` : ''}</div>`;
    const extraHtml = extra.length ? `<div style="margin-top:6px; color:#888; font-size:0.85em;">목록에 없는 조각 ${extra.length}개: ${esc(extra.map(r => `${r.n}.${r.item.name}`).join(', '))}</div>` : '';
    box.innerHTML = summary + lines.join('') + extraHtml;
}

function applyNumCheckBulk() {
    const cat = getNumCheckCurrentCat();
    const msg = document.getElementById('numcheck-bulk-msg');
    if (!cat) return;
    const text = document.getElementById('numcheck-bulk').value;
    const re = /(\d+)\s*[.:：)]\s*([^,，\n]+)/g;
    const edits = [];
    let m;
    while ((m = re.exec(text)) !== null) edits.push({ n: parseInt(m[1], 10), name: m[2].trim() });
    if (edits.length === 0) { msg.style.color = '#ef5350'; msg.textContent = '❌ "1.사과, 2.딸기" 형식으로 입력해 주세요.'; return; }
    const rows = getNumCheckRows(cat);
    let changed = 0;
    const notFound = [], dup = [];
    edits.forEach(({ n, name }) => {
        if (!name) return;
        const hits = rows.filter(r => r.n === n);
        if (hits.length === 0) { notFound.push(n); return; }
        if (hits.length > 1) dup.push(n);
        if (hits[0].item.name !== name) { hits[0].item.name = name; changed++; }
    });
    if (changed > 0) numCheckPersistLibrary();
    msg.style.color = '#4CAF50';
    msg.textContent = `✅ ${changed}개 이름 변경` + (notFound.length ? ` · 없는 번호: ${notFound.join(', ')}` : '') + (dup.length ? ` · 번호 중복(첫 조각만 적용): ${dup.join(', ')}` : '');
    renderNumCheckTable(); renderNumCheckResult();
}
window.renderNumCheckTool = renderNumCheckTool;


/* ══════════════════════════════════════════════
   🔎 프롬프트 특수 검색 (🛠️ 도구 탭 "프롬프트 특수 검색", index.html의 #tab-tools-psearch)
   찾을 프롬프트(태그)를 적으면, 선택한 대상(조각 프롬프트 / 조각 전용 부정 / 공통 긍정 / 공통 부정)마다
   그 태그가 있으면 🟢, 없으면 🔴 불이 켜진다. 불을 클릭하면 그 태그를 추가(🔴→🟢) / 제거(🟢→🔴) 한다.
   - 판정은 "태그 단위 정확 일치": 가중치 문법((apple:1.2))·대소문자·밑줄(_)/공백 차이는 무시
   - 제거는 해당 태그만 surgical하게 빼고 나머지 글자는 그대로 둠, 추가는 맨 뒤에 ", 태그"
   - 되돌리기: 마지막 변경(개별/일괄) 1회분을 원래대로 복원
   ══════════════════════════════════════════════ */
const PSEARCH_STORE_KEY = 'am_psearch_v1';
const PSEARCH_MAX_TAGS = 8;
const PSEARCH_MAX_ROWS = 400;
let psearchUndoRec = null; // { label, changes:[{target, before}] }

function psNorm(tag) {
    const base = (typeof stripWeightSyntax === 'function') ? stripWeightSyntax(tag) : tag;
    return String(base || '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}
function psParseTags(text) {
    const seen = new Set(), out = [];
    String(text || '').split(/[,\n，]/).map(t => t.trim()).filter(Boolean).forEach(t => {
        const n = psNorm(t);
        if (n && !seen.has(n)) { seen.add(n); out.push({ raw: t, norm: n }); }
    });
    return out.slice(0, PSEARCH_MAX_TAGS);
}
function psPromptHas(prompt, norm) { return String(prompt || '').split(',').some(p => psNorm(p) === norm); }
function psPromptRemove(prompt, norm) {
    const kept = String(prompt || '').split(',').filter(p => psNorm(p) !== norm);
    return kept.join(',').replace(/^\s+/, '').replace(/[,\s]+$/, '');
}
function psPromptAdd(prompt, tag) {
    const base = String(prompt || '').replace(/[\s,]+$/, '');
    return base ? `${base}, ${tag}` : tag;
}

function loadPSearchStore() {
    try { return JSON.parse(localStorage.getItem(PSEARCH_STORE_KEY) || '{}'); } catch (e) { return {}; }
}
function savePSearchStore() {
    try {
        localStorage.setItem(PSEARCH_STORE_KEY, JSON.stringify({
            tags: document.getElementById('psearch-input')?.value || '',
            target: document.getElementById('psearch-target')?.value || 'piece-pos',
            group: document.getElementById('psearch-group')?.value || '__all__',
            filter: document.getElementById('psearch-filter')?.value || 'all'
        }));
    } catch (e) {}
}

/** 선택된 대상 목록을 만든다. 각 target = { label, get(), set(v), cat?, item? } */
function psGetTargets() {
    const kind = document.getElementById('psearch-target')?.value || 'piece-pos';
    const targets = [];
    if (kind === 'common-pos' || kind === 'common-neg') {
        const el = document.getElementById(kind === 'common-pos' ? 'base-pos' : 'base-neg');
        if (el) {
            targets.push({
                label: kind === 'common-pos' ? '📝 공통 긍정프롬프트' : '🚫 공통 부정프롬프트',
                kind,
                get: () => el.value,
                set: (v) => {
                    el.value = v;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    if (window.appStateManager && typeof window.appStateManager.debounceSave === 'function') window.appStateManager.debounceSave();
                }
            });
        }
        return targets;
    }
    const groupVal = document.getElementById('psearch-group')?.value || '__all__';
    const cats = getAllCategories().filter(c => groupVal === '__all__' || c.id === groupVal);
    const showCat = groupVal === '__all__';
    cats.forEach(cat => {
        const rows = cat.items.map((item, idx) => ({ item, idx, n: getItemEffectiveNumber(cat, item) }));
        rows.sort((a, b) => a.n - b.n || a.idx - b.idx);
        rows.forEach(({ item, n }) => {
            const label = `${showCat ? cat.name + ' / ' : ''}${n}.${item.name || item.id}`;
            if (kind === 'piece-neg') {
                targets.push({
                    label, kind, cat, item,
                    get: () => item.negativeOverride || '',
                    set: (v) => { if (String(v).trim()) item.negativeOverride = v; else delete item.negativeOverride; }
                });
            } else {
                targets.push({
                    label, kind, cat, item,
                    get: () => item.prompt || '',
                    set: (v) => {
                        item.prompt = v;
                        if (item.variants && item.variants[item.activeVariant || 0]) item.variants[item.activeVariant || 0].prompt = v;
                    }
                });
            }
        });
    });
    return targets;
}

/** 변경 적용 + 저장/대기열 동기화 + 되돌리기 기록. changes = [{target, before, after}] */
function psApplyChanges(changes, label) {
    if (!changes.length) return;
    changes.forEach(c => c.target.set(c.after));
    psearchUndoRec = { label, changes: changes.map(c => ({ target: c.target, before: c.before })) };
    psAfterPieceEdit(changes.map(c => c.target));
    renderPSearchTable();
}
function psAfterPieceEdit(targets) {
    const touched = new Map();
    targets.forEach(t => { if (t.item && t.cat) touched.set(t.cat.id + '::' + t.item.id, t); });
    if (touched.size === 0) return;
    touched.forEach(t => {
        if (typeof syncQueueJobsWithItem === 'function') { try { syncQueueJobsWithItem(t.cat.id, t.item.id, t.item); } catch (e) {} }
    });
    if (typeof debounceLibrarySave === 'function') debounceLibrarySave();
    if (typeof renderItems === 'function') { try { renderItems(); } catch (e) {} }
    if (typeof renderBuilder === 'function') { try { renderBuilder(); } catch (e) {} }
}
function psUndo() {
    if (!psearchUndoRec) return;
    const rec = psearchUndoRec;
    rec.changes.forEach(c => c.target.set(c.before));
    psAfterPieceEdit(rec.changes.map(c => c.target));
    psearchUndoRec = null;
    renderPSearchTable();
}

function psToggleCell(target, tag) {
    const cur = target.get();
    const has = psPromptHas(cur, tag.norm);
    psApplyChanges([{ target, before: cur, after: has ? psPromptRemove(cur, tag.norm) : psPromptAdd(cur, tag.raw) }],
        `${target.label}: ${tag.raw} ${has ? '제거' : '추가'}`);
}
function psBulk(rows, tag, mode) {
    const changes = [];
    rows.forEach(t => {
        const cur = t.get();
        const has = psPromptHas(cur, tag.norm);
        if (mode === 'add' && !has) changes.push({ target: t, before: cur, after: psPromptAdd(cur, tag.raw) });
        if (mode === 'remove' && has) changes.push({ target: t, before: cur, after: psPromptRemove(cur, tag.norm) });
    });
    if (changes.length === 0) { alert(mode === 'add' ? '이미 전부 들어있습니다.' : '제거할 대상이 없습니다 (아무 데도 없음).'); return; }
    if (!confirm(`표시 중인 ${rows.length}곳 중 ${changes.length}곳에서 "${tag.raw}"를(을) ${mode === 'add' ? '추가' : '제거'}합니다.\n(↩ 되돌리기 버튼으로 한 번 복원할 수 있습니다)`)) return;
    psApplyChanges(changes, `"${tag.raw}" 일괄 ${mode === 'add' ? '추가' : '제거'} (${changes.length}곳)`);
}

function ensurePSearchUI() {
    const root = document.getElementById('psearch-root');
    if (!root) return null;
    if (root.dataset.ready === '1') return root;
    root.dataset.ready = '1';
    const inputCss = 'background:#222; border:1px solid #555; color:#fff; border-radius:4px; padding:6px; box-sizing:border-box;';
    root.innerHTML = `
        <h2 style="margin:0 0 6px;">🔎 프롬프트 특수 검색</h2>
        <p style="color:#aaa; margin:0 0 12px; font-size:0.9em;">
            찾을 프롬프트를 적으면 <b>있는 곳은 🟢, 없는 곳은 🔴</b> 불이 켜집니다. <b>불을 클릭</b>하면 그 프롬프트를 추가(🔴→🟢)/제거(🟢→🔴)합니다.
            태그 단위로 비교하며 (apple:1.2)·대소문자·밑줄(_)은 같은 태그로 봅니다.
        </p>
        <textarea id="psearch-input" rows="2" placeholder="찾을 프롬프트 (콤마로 여러 개, 최대 ${PSEARCH_MAX_TAGS}개 — 예: apple, red dress)" style="width:100%; ${inputCss} resize:vertical;"></textarea>
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:8px 0;">
            <select id="psearch-target" style="${inputCss}">
                <option value="piece-pos">🧩 조각의 프롬프트</option>
                <option value="piece-neg">🧩 조각의 전용 부정프롬프트</option>
                <option value="common-pos">📝 공통 긍정프롬프트</option>
                <option value="common-neg">🚫 공통 부정프롬프트</option>
            </select>
            <select id="psearch-group" style="min-width:200px; ${inputCss}"></select>
            <select id="psearch-filter" style="${inputCss}">
                <option value="all">전체 보기</option>
                <option value="any-on">🟢 하나라도 있는 것만</option>
                <option value="any-off">🔴 하나라도 없는 것만</option>
            </select>
            <button id="psearch-undo" class="btn-secondary" style="padding:6px 12px;" disabled>↩ 되돌리기</button>
        </div>
        <div id="psearch-summary" style="font-size:0.85em; color:#aaa; margin-bottom:6px;"></div>
        <div id="psearch-table" style="max-height:62vh; overflow:auto; background:#1a1a1a; border:1px solid #333; border-radius:8px; padding:6px;"></div>`;
    ['psearch-input', 'psearch-target', 'psearch-group', 'psearch-filter'].forEach(id => {
        const el = document.getElementById(id);
        const ev = el.tagName === 'TEXTAREA' ? 'input' : 'change';
        el.addEventListener(ev, () => { savePSearchStore(); renderPSearchTable(); });
    });
    document.getElementById('psearch-undo').onclick = psUndo;
    return root;
}

function renderPSearchTool() {
    if (!ensurePSearchUI()) return;
    const st = loadPSearchStore();
    const input = document.getElementById('psearch-input');
    if (!input.dataset.restored) { input.value = st.tags || ''; input.dataset.restored = '1'; if (st.target) document.getElementById('psearch-target').value = st.target; if (st.filter) document.getElementById('psearch-filter').value = st.filter; }
    const gsel = document.getElementById('psearch-group');
    const prevG = gsel.value || st.group || '__all__';
    gsel.innerHTML = '<option value="__all__">전체 그룹</option>';
    getAllCategories().forEach(c => {
        const o = document.createElement('option'); o.value = c.id; o.textContent = `${c.name} (${c.items.length}개)`; gsel.appendChild(o);
    });
    gsel.value = Array.from(gsel.options).some(o => o.value === prevG) ? prevG : '__all__';
    renderPSearchTable();
}

function renderPSearchTable() {
    const box = document.getElementById('psearch-table');
    if (!box) return;
    const kind = document.getElementById('psearch-target').value;
    document.getElementById('psearch-group').disabled = (kind === 'common-pos' || kind === 'common-neg');
    document.getElementById('psearch-undo').disabled = !psearchUndoRec;
    document.getElementById('psearch-undo').title = psearchUndoRec ? `되돌리기: ${psearchUndoRec.label}` : '되돌릴 변경이 없습니다';
    const summary = document.getElementById('psearch-summary');
    const tags = psParseTags(document.getElementById('psearch-input').value);
    box.innerHTML = '';
    if (tags.length === 0) {
        summary.textContent = '';
        box.innerHTML = '<div style="color:#777; padding:12px;">위에 찾을 프롬프트를 입력하세요. (예: apple, red dress)</div>';
        return;
    }
    const all = psGetTargets();
    const filter = document.getElementById('psearch-filter').value;
    const state = t => tags.map(tag => psPromptHas(t.get(), tag.norm));
    const rows = all.filter(t => {
        if (filter === 'all') return true;
        const s = state(t);
        return filter === 'any-on' ? s.some(Boolean) : s.some(v => !v);
    });
    const counts = tags.map((tag, i) => ({ on: rows.filter(t => state(t)[i]).length }));
    summary.textContent = `대상 ${all.length}곳 중 ${rows.length}곳 표시` + (rows.length > PSEARCH_MAX_ROWS ? ` (화면에는 앞 ${PSEARCH_MAX_ROWS}곳만 표시 — 일괄 추가/제거는 표시 중인 ${rows.length}곳 전체에 적용됩니다)` : '');
    if (rows.length === 0) { box.innerHTML = '<div style="color:#777; padding:12px;">조건에 맞는 대상이 없습니다.</div>'; return; }

    const table = document.createElement('table');
    table.style.cssText = 'border-collapse:collapse; width:100%;';
    const head = document.createElement('tr');
    const th0 = document.createElement('th'); th0.textContent = '대상'; th0.style.cssText = 'text-align:left; padding:6px; color:#aaa; position:sticky; top:0; background:#1a1a1a;'; head.appendChild(th0);
    tags.forEach((tag, i) => {
        const th = document.createElement('th');
        th.style.cssText = 'padding:6px; min-width:120px; position:sticky; top:0; background:#1a1a1a; vertical-align:top;';
        const off = rows.length - counts[i].on;
        th.innerHTML = `<div style="color:#fff; word-break:break-all;"></div><div style="font-size:0.8em; color:#aaa; margin:2px 0;">🟢 ${counts[i].on} · 🔴 ${off}</div>`;
        th.firstChild.textContent = tag.raw;
        const mk = (txt, mode, title) => {
            const b = document.createElement('button'); b.className = 'btn-secondary'; b.textContent = txt; b.title = title;
            b.style.cssText = 'padding:1px 6px; font-size:0.75em; margin:0 2px;';
            b.onclick = () => psBulk(rows, tag, mode);
            return b;
        };
        th.appendChild(mk('＋전체', 'add', `표시 중인 ${rows.length}곳 전부에 추가`));
        th.appendChild(mk('－전체', 'remove', `표시 중인 ${rows.length}곳 전부에서 제거`));
        head.appendChild(th);
    });
    table.appendChild(head);

    rows.slice(0, PSEARCH_MAX_ROWS).forEach(t => {
        const tr = document.createElement('tr');
        tr.style.cssText = 'border-top:1px solid #2a2a2a;';
        const td0 = document.createElement('td'); td0.textContent = t.label; td0.style.cssText = 'padding:5px 6px; color:#ddd; max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;'; td0.title = t.label;
        tr.appendChild(td0);
        const st = state(t);
        tags.forEach((tag, i) => {
            const td = document.createElement('td'); td.style.cssText = 'text-align:center; padding:4px;';
            const on = st[i];
            const light = document.createElement('button');
            light.type = 'button';
            light.className = 'ps-light';
            light.dataset.state = on ? 'on' : 'off';
            const color = on ? '#4CAF50' : '#ef5350';
            light.style.cssText = `width:22px; height:22px; border-radius:50%; border:1px solid #0006; cursor:pointer; background:${color}; box-shadow:0 0 ${on ? 9 : 5}px ${color}${on ? '' : '88'}; padding:0;`;
            light.title = on ? `🟢 있음 — 클릭: "${tag.raw}" 제거` : `🔴 없음 — 클릭: "${tag.raw}" 추가`;
            light.onclick = () => psToggleCell(t, tag);
            td.appendChild(light); tr.appendChild(td);
        });
        table.appendChild(tr);
    });
    box.appendChild(table);
}
window.renderPSearchTool = renderPSearchTool;


/* ══════════════════════════════════════════════
   🩺 에셋매니저 진단 (🛠️ 도구 탭 "에셋매니저 진단", index.html의 #tab-tools-diag)
   generate.js의 블랙박스 기록기(window.amDiag)가 모아둔 이벤트 + [지금 점검]으로 확인한 서버 상태를 합쳐서
   "어디서 막혔는지"를 규칙 기반으로 추정한다. (추정이지 확정이 아님 — 근거 이벤트를 같이 보여줌)
   보고서 복사/저장으로 그대로 공유할 수 있고, [서버 로그에 요약 기록]은 기존 /assetmanager/api/log를 사용한다.
   ══════════════════════════════════════════════ */
const AMDIAG_LEVEL_ORDER = { error: 0, warn: 1, info: 2, ok: 3 };
let amDiagTimer = null;
window.__amDiagChecks = window.__amDiagChecks || null;

async function amDiagFetchJson(url, ms) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), ms || 6000);
    const t0 = performance.now();
    try {
        const res = await fetch(url, { signal: ctl.signal, cache: 'no-store', __amDiagSilent: true });
        const dt = Math.round(performance.now() - t0);
        let json = null;
        if (res.ok) { try { json = await res.json(); } catch (e) {} }
        return { ok: res.ok, status: res.status, ms: dt, json };
    } catch (e) {
        return { ok: false, status: 0, ms: Math.round(performance.now() - t0), error: e && e.name === 'AbortError' ? '시간 초과(6초)' : String((e && e.message) || e) };
    } finally { clearTimeout(to); }
}

/** 지금 서버/환경 상태를 직접 확인해서 window.__amDiagChecks에 저장 */
async function amDiagRunChecks() {
    const [sys, que, back] = await Promise.all([
        amDiagFetchJson('/system_stats'),
        amDiagFetchJson('/queue'),
        amDiagFetchJson('/assetmanager/api/memo/all')
    ]);
    const c = { at: Date.now() };
    const dev = sys.json && sys.json.devices && sys.json.devices[0];
    c.comfy = { ok: sys.ok, status: sys.status, ms: sys.ms, error: sys.error || '',
        version: sys.json && sys.json.system && sys.json.system.comfyui_version || '',
        gpu: dev ? dev.name : '', vramFree: dev ? dev.vram_free : null, vramTotal: dev ? dev.vram_total : null };
    c.queue = { ok: que.ok, status: que.status, error: que.error || '',
        running: que.json && Array.isArray(que.json.queue_running) ? que.json.queue_running.length : null,
        pending: que.json && Array.isArray(que.json.queue_pending) ? que.json.queue_pending.length : null };
    c.backend = { ok: back.ok, status: back.status, ms: back.ms, error: back.error || '' };
    const rs = (window.ws && typeof window.ws.readyState === 'number') ? window.ws.readyState : -1;
    c.ws = { state: rs, name: ['연결 중', '연결됨', '닫는 중', '끊김'][rs] || '객체 없음' };
    let storageOk = true;
    try { localStorage.setItem('__amdiag', '1'); localStorage.removeItem('__amdiag'); } catch (e) { storageOk = false; }
    c.env = {
        online: navigator.onLine, protocol: location.protocol, storageOk,
        naiToken: !!(localStorage.getItem('naiApiToken')), nanoKey: !!(localStorage.getItem('nanoBananaApiKey')),
        categories: (typeof getAllCategories === 'function') ? getAllCategories().length : null,
        pieces: (typeof getAllCategories === 'function') ? getAllCategories().reduce((a, x) => a + x.items.length, 0) : null,
        queueJobs: (typeof jobQueue !== 'undefined' && Array.isArray(jobQueue)) ? jobQueue.length : null
    };
    window.__amDiagChecks = c;
    return c;
}

function amDiagNodeHint(title) {
    const t = String(title || '');
    if (/ckpt|checkpoint/i.test(t)) return '체크포인트(모델 파일) 로딩 단계입니다. 대용량 모델은 수 분 걸릴 수 있고, 디스크가 느리거나 RAM이 부족하면 더 오래 걸립니다.';
    if (/lora/i.test(t)) return 'LoRA 로딩/적용 단계입니다. 파일이 크거나 개수가 많으면 시간이 걸리고, 파일이 없으면 오류가 납니다.';
    if (/VAE/i.test(t) && /load/i.test(t)) return 'VAE 모델 로딩 단계입니다. 파일을 못 찾거나 디스크가 느리면 오래 걸립니다.';
    if (/VAE/i.test(t)) return 'VAE 디코딩 단계입니다. 큰 해상도에서는 VRAM 부족이 자주 납니다.';
    if (/KSampler/i.test(t)) return '샘플링 단계입니다. VRAM이 부족하면 극단적으로 느려지거나 멈춘 것처럼 보입니다 (해상도·배치·다른 프로그램의 GPU 사용 확인).';
    if (/Detailer/i.test(t)) return '디테일러(얼굴/눈/입/손) 단계입니다. 검출 모델 로딩이나 반복 샘플링 중일 수 있습니다.';
    if (/Upscale/i.test(t)) return '업스케일 단계입니다. 큰 배율은 VRAM과 시간이 많이 듭니다.';
    if (/\[Censor\]/i.test(t)) return '검열 파이프라인 단계입니다. 검출 모델이나 해당 커스텀 노드 문제일 수 있습니다.';
    if (/IPAdapter|ControlNet/i.test(t)) return '참조 이미지/컨트롤넷 단계입니다. 모델 파일이나 전처리기 문제일 수 있습니다.';
    if (/CLIP/i.test(t)) return 'CLIP(프롬프트 해석) 단계입니다. 텍스트 인코더 로딩이 오래 걸릴 수 있습니다.';
    if (/Save/i.test(t)) return '저장 단계입니다. 디스크 용량/폴더 권한/파일명 문제일 수 있습니다.';
    return '';
}
/** 문장 하나만 뽑는다 (로그 패널 간단 진단 한 줄용) */
function amDiagFirstSentence(text) {
    let s = String(text || '').split('\n')[0];
    const p = s.search(/[.!?]\s/);
    if (p > 0) s = s.slice(0, p + 1);
    return s.slice(0, 110);
}
function amDiagExecErrorHint(msg) {
    const m = String(msg || '').toLowerCase();
    if (/out of memory|oom/.test(m)) return 'GPU VRAM 부족입니다. 해상도·업스케일 배율·디테일러 수를 줄이거나, 다른 GPU 프로그램을 종료하고 ComfyUI를 재시작해 보세요.';
    if (/size mismatch|shape|dimension/.test(m)) return '모델 조합이 안 맞습니다 (체크포인트/로라/VAE/컨트롤넷의 아키텍처가 서로 다름 — 예: SDXL 체크포인트에 SD1.5 로라).';
    if (/no such file|not found|cannot find|does not exist/.test(m)) return '모델/이미지 파일을 찾지 못했습니다 (삭제되었거나 이름·경로가 바뀜).';
    if (/cuda/.test(m)) return 'CUDA 오류입니다. ComfyUI를 재시작하고, 반복되면 드라이버/VRAM 상태를 확인하세요.';
    if (/nonetype/.test(m)) return '앞 노드의 출력이 비어 있습니다 (노드 연결이나 입력값 문제).';
    return '';
}
function amDiagPromptRejectHint(p) {
    const types = [p.type].concat((p.nodeErrors || []).map(x => x.type)).filter(Boolean).join(' ');
    if (/missing_node_type/.test(types)) return '필요한 커스텀 노드가 설치돼 있지 않습니다 (노드 이름 불일치 포함). ComfyUI 콘솔에 import 실패가 없는지 확인하세요.';
    if (/value_not_in_list/.test(types)) return '목록에 없는 값입니다 — 체크포인트/로라/샘플러/업스케일 모델 파일이 삭제되었거나 이름이 바뀌었을 가능성이 큽니다.';
    if (/required_input_missing/.test(types)) return '필수 입력이 비어 있습니다 (워크플로우 노드 연결 문제).';
    if (/prompt_no_outputs/.test(types)) return '출력(저장) 노드가 없습니다. 워크플로우 구성을 확인하세요.';
    if (/prompt_outputs_failed_validation/.test(types)) return '출력 노드의 검증이 실패했습니다. 아래 노드 오류 내용을 확인하세요.';
    return '';
}
function amDiagExternalHint(status, url) {
    const name = String(url || '').split('/').pop();
    if (status === 0) return '요청이 서버에 닿지 못했거나 도중에 끊겼습니다 (ComfyUI가 꺼졌거나 터널/네트워크 문제).';
    if (status === 401 || status === 403) return 'API 키/토큰이 잘못되었거나 만료되었습니다. 설정 칸의 키를 다시 확인하세요.';
    if (status === 402) return '크레딧/결제 문제입니다 (NAI라면 Anlas 부족).';
    if (status === 404) return '백엔드 라우트가 서버에 없습니다 — __init__.py 코드가 서버 파일에 반영되지 않았거나 ComfyUI 재시작이 필요합니다.';
    if (status === 429) return '요청 과다 또는 사용량 한도 초과입니다 (무료 티어는 일일 한도가 낮음). 잠시 후 재시도하세요.';
    if (status === 400 || status === 422) return '요청 값 오류입니다 (해상도/옵션 조합). 위 메시지를 확인하세요.';
    if (status === 500) return /nai/.test(name) ? '서버 내부 오류입니다. NAI V5에 Vibe Transfer/Precise Reference 같은 미지원 조합이면 500이 납니다 (그 외에는 백엔드 ComfyUI 콘솔의 traceback 확인).' : '서버 내부 오류입니다. ComfyUI 콘솔의 traceback을 확인하세요.';
    if (status >= 502 && status <= 504) return '상대 서버의 일시 장애/시간 초과입니다. 잠시 후 다시 시도하세요.';
    return '';
}

/** 기록 + 점검 결과로 "어디서 막혔는지" 추정. 반환: [{level, title, detail, next[]}] (심각한 순) */
function amDiagInfer() {
    const out = [];
    const add = (level, title, detail, next, short) => out.push({ level, title, detail: detail || '', next: next || [], short: short || '' });
    const D = window.amDiag;
    if (!D) {
        add('warn', '진단 기록기가 설치돼 있지 않습니다', 'generate.js 최신본이 적용되지 않았습니다.', ['하드리프레시(Ctrl+Shift+R) 후 다시 열기']);
        return out;
    }
    const S = D.state, ex = S.exec, ck = window.__amDiagChecks || null, now = Date.now();
    const sec = ms => Math.round(ms / 1000);
    const recent = (t) => t && (now - t) < 15 * 60 * 1000;
    const running = !!(ex.startedAt && !ex.finishedAt);

    // 1) 웹소켓
    const rs = (window.ws && typeof window.ws.readyState === 'number') ? window.ws.readyState : -1;
    if (rs === -1) add('error', '웹소켓 객체가 없습니다', '페이지 로드 때 웹소켓 생성에 실패했습니다. 생성이 끝나도 앱이 진행 상황/결과를 받지 못합니다.', ['페이지 새로고침', 'https 터널(Cloudflare 등)이면 wss 연결이 허용되는지 확인']);
    else if (rs >= 2) add('error', '웹소켓이 끊겨 있습니다', 'ComfyUI가 작업을 끝내도 앱은 실시간 진행/결과 이벤트를 받지 못합니다. (앱에는 /history로 결과를 다시 찾는 보조 경로가 있지만 지연될 수 있습니다)', ['페이지 새로고침(Ctrl+Shift+R)', 'ComfyUI가 켜져 있는지, 터널/프록시가 끊기지 않았는지 확인']);
    else if (rs === 0 && now - S.installedAt > 10000) add('warn', '웹소켓이 계속 "연결 중"입니다', '서버가 응답하지 않거나 연결이 막혀 있을 수 있습니다.', ['ComfyUI 실행 상태 확인', '페이지 새로고침']);

    // 2) ComfyUI가 프롬프트를 거부
    const lp = S.lastPrompt;
    if (lp && !lp.ok && recent(lp.at)) {
        const hint = amDiagPromptRejectHint(lp);
        const ne = (lp.nodeErrors || []).map(x => `노드 #${x.id}(${x.classType || '?'}): ${x.message}${x.details ? ' — ' + x.details : ''}`);
        add('error', lp.status === 0 ? '프롬프트 전송 자체가 실패했습니다 (네트워크)' : `ComfyUI가 워크플로우를 거부했습니다 (HTTP ${lp.status})`,
            [lp.message, ...ne, hint].filter(Boolean).join('\n'),
            lp.status === 0 ? ['ComfyUI가 켜져 있는지, 주소/터널 확인'] : ['위 노드 오류의 파일/노드가 실제로 존재하는지 확인', '문제 되는 옵션(로라/업스케일/디테일러 등)을 끄고 다시 시도'], amDiagFirstSentence(hint || lp.message));
    }

    // 3) 실행 중 노드 오류
    if (ex.error && recent(ex.error.at)) {
        const h = amDiagExecErrorHint(ex.error.message);
        add('error', `노드 #${ex.error.node} (${ex.error.nodeType}) 실행 중 오류`, [ex.error.message, h].filter(Boolean).join('\n'), ['ComfyUI 콘솔(터미널)의 traceback 확인', '해당 노드와 관련된 옵션(모델/해상도)을 줄이거나 끄고 재시도'], amDiagFirstSentence(h || ex.error.message));
    }

    // 4) 실행 중인데 신호가 끊김(정체)
    if (running) {
        const idle = S.lastWsMsgAt ? now - S.lastWsMsgAt : now - ex.startedAt;
        const title = ex.nodeTitle || (ex.node ? `#${ex.node}` : '(시작 직후)');
        const prog = ex.progress ? ` 진행률 ${ex.progress.v}/${ex.progress.max}.` : '';
        const nodeFor = sec(now - (ex.nodeSince || ex.startedAt));
        if (idle > 90000) add('error', `"${title}" 단계에서 ${sec(idle)}초째 아무 신호가 없습니다`, `ComfyUI 실행이 시작된 뒤 마지막 신호 후 ${sec(idle)}초가 지났습니다.${prog} ${amDiagNodeHint(ex.nodeTitle)}`, ['ComfyUI 콘솔에 진행 중인지/에러가 있는지 확인', 'VRAM/RAM 사용량 확인', '계속 멈춰 있으면 ⏹ 중지 후 옵션을 줄여 재시도'], amDiagFirstSentence(amDiagNodeHint(ex.nodeTitle)));
        else if (idle > 30000) add('warn', `"${title}" 단계가 느리거나 멈춘 것 같습니다 (${sec(idle)}초 무신호)`, `이 노드에서 ${nodeFor}초째입니다.${prog} ${amDiagNodeHint(ex.nodeTitle)}`, ['조금 더 기다려 보고, 변화가 없으면 ComfyUI 콘솔 확인'], amDiagFirstSentence(amDiagNodeHint(ex.nodeTitle)));
        else add('info', `정상 진행 중: "${title}" ${nodeFor}초째`, `${prog} ${amDiagNodeHint(ex.nodeTitle)}`.trim(), []);
    }

    // 5) 프롬프트는 접수됐는데 실행이 시작되지 않음
    if (lp && lp.ok && S.appWait.length > 0 && S.inflight.length === 0 && !running && lp.at > ex.startedAt && now - lp.at > 30000) {
        const q = ck && ck.queue && ck.queue.ok ? ck.queue : null;
        if (q && (q.running > 0 || q.pending > 0)) add('warn', `실행 시작 전 대기 중 (ComfyUI 큐: 실행 ${q.running}개 · 대기 ${q.pending}개)`, `프롬프트는 ${sec(now - lp.at)}초 전에 접수됐지만 아직 시작 신호가 없습니다. 앞선 작업 뒤에서 기다리는 중일 가능성이 큽니다.`, ['앞선 작업이 끝날 때까지 대기', '다른 탭/프로그램이 ComfyUI 큐를 쓰고 있는지 확인']);
        else add('warn', '프롬프트는 접수됐는데 실행 시작 신호가 없습니다', `${sec(now - lp.at)}초 경과.${q ? ' ComfyUI 큐는 비어 있습니다 (이미 끝났거나 취소됐을 수 있음).' : ' [지금 점검]으로 큐 상태를 확인해 보세요.'}`, ['[지금 점검] 실행', '웹소켓이 끊겼다면 새로고침']);
    }

    // 6) 앱은 결과를 기다리는데 ComfyUI는 놀고 있음
    if (S.appWait.length > 0 && S.inflight.length === 0 && !running && ck && ck.queue && ck.queue.ok && ck.queue.running === 0 && ck.queue.pending === 0) {
        const age = sec(now - Math.min(...S.appWait.map(x => x.at)));
        if (age > 20) add('warn', 'ComfyUI는 놀고 있는데 앱이 결과를 기다리고 있습니다', `앱의 생성 요청이 ${age}초째 대기 중이지만 ComfyUI 큐가 비어 있습니다. 완료 이벤트(웹소켓)가 유실되었을 가능성이 큽니다.`, ['잠시 더 기다리기 (앱이 /history로 결과를 다시 찾습니다)', '계속되면 페이지 새로고침 후 같은 조각 다시 생성']);
    }

    // 7) 외부 API(NAI/나노바나나/Director)
    if (S.inflight.length > 0) {
        const age = sec(now - Math.min(...S.inflight.map(x => x.at)));
        add(age > 120 ? 'warn' : 'info', `외부 API 응답 대기 중 (${age}초째): ${S.inflight[0].url.split('/').pop()}`, age > 120 ? '응답이 매우 느립니다. 서버 혼잡이거나 요청이 멈췄을 수 있습니다.' : '', age > 120 ? ['조금 더 기다려 보고 안 되면 다시 시도'] : []);
    }
    const ef = S.lastExternalFail;
    if (ef && recent(ef.at)) {
        add('error', `외부 API 실패: ${ef.url.split('/').pop()} (HTTP ${ef.status || '연결 실패'})`, [ef.message, amDiagExternalHint(ef.status, ef.url)].filter(Boolean).join('\n'), ['메시지 내용 확인 후 옵션/키 수정', '반복되면 [보고서 복사]로 내용 공유']);
    }

    // 8) 백엔드(/assetmanager/api) 실패
    const bf = S.lastBackendFail;
    if (bf && recent(bf.at)) {
        add('error', `AssetManager 백엔드 요청 실패: ${bf.url.replace('/assetmanager/api/', '')} (HTTP ${bf.status || '연결 실패'})`, [bf.message, amDiagExternalHint(bf.status, bf.url)].filter(Boolean).join('\n'), ['ComfyUI 콘솔(터미널)의 traceback 확인', '404라면 백엔드 파일에 해당 라우트 코드가 있는지 + ComfyUI 재시작']);
    }

    // 9) 프론트 JS 오류
    const jsErr = D.events.filter(e => e.type === 'js' && recent(e.t));
    if (jsErr.length > 0) add('warn', `프론트 스크립트 오류 ${jsErr.length}건`, `가장 최근: ${jsErr[jsErr.length - 1].msg}`, ['오류가 난 기능 직전 동작이 멈춘 원인일 수 있음', '새로고침 후에도 반복되면 [보고서 복사]']);

    // 10) 직접 점검 결과
    if (ck) {
        if (!ck.comfy.ok) add('error', 'ComfyUI 서버가 응답하지 않습니다', `/system_stats → ${ck.comfy.status || '연결 실패'}${ck.comfy.error ? ' (' + ck.comfy.error + ')' : ''}`, ['ComfyUI가 실행 중인지 확인', '터널/프록시 주소 확인']);
        if (!ck.backend.ok) add(ck.comfy.ok ? 'error' : 'warn', 'AssetManager 백엔드가 응답하지 않습니다', `/assetmanager/api/memo/all → ${ck.backend.status || '연결 실패'}${ck.backend.error ? ' (' + ck.backend.error + ')' : ''}`, ck.backend.status === 404 ? ['백엔드 파일에 __init__.py의 라우트 코드가 반영됐는지 + ComfyUI 재시작'] : ['ComfyUI 콘솔의 에러 확인']);
        if (ck.comfy.ok && ck.comfy.vramFree !== null && ck.comfy.vramFree < 600 * 1024 * 1024) add('warn', `GPU 여유 VRAM이 매우 적습니다 (${(ck.comfy.vramFree / 1024 / 1024).toFixed(0)}MB)`, '생성이 느려지거나 OOM 오류가 날 수 있습니다.', ['다른 GPU 프로그램 종료', 'ComfyUI 재시작으로 VRAM 비우기']);
        if (!ck.env.storageOk) add('warn', '브라우저 저장소(localStorage)를 쓸 수 없습니다', '설정/번호표/진단 저장이 안 될 수 있습니다 (시크릿 모드·저장소 차단).', ['일반 창에서 열기']);
        if (!ck.env.online) add('warn', '브라우저가 오프라인 상태입니다', '', ['네트워크 연결 확인']);
    }

    if (!out.some(o => o.level === 'error' || o.level === 'warn')) {
        add('ok', '눈에 띄는 문제를 찾지 못했습니다', ck ? '기록과 서버 점검 모두 정상 범위입니다.' : '기록상 이상이 없습니다. [지금 점검]을 누르면 서버 상태까지 확인합니다.', []);
    }
    out.sort((a, b) => AMDIAG_LEVEL_ORDER[a.level] - AMDIAG_LEVEL_ORDER[b.level]);
    return out;
}

function amDiagStatusText() {
    const D = window.amDiag;
    if (!D) return '기록기 없음';
    const S = D.state, ex = S.exec, now = Date.now(), sec = ms => Math.round(ms / 1000);
    if (ex.startedAt && !ex.finishedAt) {
        const title = ex.nodeTitle || (ex.node ? `#${ex.node}` : '시작 직후');
        return `🔄 ComfyUI 실행 중 — 노드 ${title}, ${sec(now - (ex.nodeSince || ex.startedAt))}초째${ex.progress ? `, 진행 ${ex.progress.v}/${ex.progress.max}` : ''}`;
    }
    if (S.inflight.length) return `🌐 외부 API 응답 대기 중 — ${sec(now - S.inflight[0].at)}초째 (${S.inflight[0].url.split('/').pop()})`;
    if (S.appWait.length) return `⏳ 앱이 생성 결과를 기다리는 중 — ${sec(now - S.appWait[0].at)}초째`;
    return '💤 대기 중 (실행 중인 작업 없음)';
}

function amDiagFmtTime(t) {
    const d = new Date(t), p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function amDiagEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function amDiagBuildReport() {
    const D = window.amDiag, ck = window.__amDiagChecks, L = [];
    const inf = amDiagInfer();
    L.push(`# AssetManager 진단 보고서 (${new Date().toLocaleString()})`);
    L.push(`상태: ${amDiagStatusText()}`);
    L.push('');
    L.push('## 추정 결과');
    inf.forEach(i => { L.push(`- [${i.level.toUpperCase()}] ${i.title}`); if (i.detail) i.detail.split('\n').forEach(x => L.push(`    ${x}`)); i.next.forEach(n => L.push(`    → ${n}`)); });
    L.push('');
    L.push('## 서버/환경 점검' + (ck ? ` (${amDiagFmtTime(ck.at)})` : ' (아직 점검 안 함)'));
    if (ck) {
        L.push(`- ComfyUI: ${ck.comfy.ok ? 'OK' : 'FAIL'} (${ck.comfy.status || ck.comfy.error}, ${ck.comfy.ms}ms) ${ck.comfy.version ? 'v' + ck.comfy.version : ''} ${ck.comfy.gpu || ''}${ck.comfy.vramFree !== null ? ` VRAM 여유 ${(ck.comfy.vramFree / 1048576).toFixed(0)}/${(ck.comfy.vramTotal / 1048576).toFixed(0)}MB` : ''}`);
        L.push(`- 웹소켓: ${ck.ws.name}`);
        L.push(`- ComfyUI 큐: ${ck.queue.ok ? `실행 ${ck.queue.running} / 대기 ${ck.queue.pending}` : 'FAIL ' + (ck.queue.status || ck.queue.error)}`);
        L.push(`- AssetManager 백엔드: ${ck.backend.ok ? 'OK' : 'FAIL'} (${ck.backend.status || ck.backend.error}, ${ck.backend.ms}ms)`);
        L.push(`- 환경: online=${ck.env.online}, ${ck.env.protocol}, localStorage=${ck.env.storageOk}, NAI토큰=${ck.env.naiToken ? '있음' : '없음'}, 나노바나나키=${ck.env.nanoKey ? '있음' : '없음'}, 그룹 ${ck.env.categories}개/조각 ${ck.env.pieces}개/대기열 ${ck.env.queueJobs}개`);
    }
    L.push('');
    L.push('## 최근 이벤트 (오래된 것 → 최신)');
    (D ? D.events.slice(-120) : []).forEach(e => L.push(`${amDiagFmtTime(e.t)} [${e.level}] ${e.type}: ${e.msg}`));
    return L.join('\n');
}

function ensureAmDiagUI() {
    const root = document.getElementById('diag-root');
    if (!root) return null;
    if (root.dataset.ready === '1') return root;
    root.dataset.ready = '1';
    root.innerHTML = `
        <h2 style="margin:0 0 6px;">🩺 에셋매니저 진단</h2>
        <p style="color:#aaa; margin:0 0 12px; font-size:0.9em;">
            페이지가 열려 있는 동안 기록해 둔 이벤트(웹소켓·HTTP·오류·생성 요청)와 서버 점검 결과를 합쳐서 <b>어디서 막혔는지 추정</b>합니다.
            생성이 멈췄거나 이상할 때 열어서 [지금 점검]을 눌러보세요. (추정이며, 근거가 되는 이벤트를 아래에 같이 보여줍니다)
        </p>
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:12px;">
            <button id="diag-run-btn" class="btn-primary" style="padding:7px 14px;">🔍 지금 점검</button>
            <label style="display:flex; align-items:center; gap:5px; font-size:0.88em; color:#ccc; cursor:pointer;"><input type="checkbox" id="diag-autorefresh" checked> 5초마다 자동 점검</label>
            <button id="diag-report-btn" class="btn-secondary" style="padding:6px 12px;">📋 보고서 복사</button>
            <button id="diag-save-btn" class="btn-secondary" style="padding:6px 12px;">💾 보고서 저장</button>
            <button id="diag-serverlog-btn" class="btn-secondary" style="padding:6px 12px;">📤 서버 로그에 요약 기록</button>
            <button id="diag-clear-btn" class="btn-secondary" style="padding:6px 12px;">🧹 기록 지우기</button>
            <span id="diag-msg" style="font-size:0.85em;"></span>
        </div>
        <div id="diag-verdict" style="background:#1a1a1a; border:1px solid #333; border-radius:8px; padding:12px; margin-bottom:12px;"></div>
        <div style="display:flex; gap:16px; flex-wrap:wrap; align-items:flex-start;">
            <div style="flex:1 1 380px; min-width:300px;">
                <h3 style="margin:0 0 6px;">서버/환경 점검</h3>
                <div id="diag-checks" style="background:#1a1a1a; border:1px solid #333; border-radius:8px; padding:8px;"></div>
            </div>
            <div style="flex:1.4 1 460px; min-width:320px;">
                <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">
                    <h3 style="margin:0;">최근 이벤트</h3>
                    <label style="font-size:0.82em; color:#ccc; cursor:pointer;"><input type="checkbox" id="diag-only-problems"> 오류/경고만</label>
                </div>
                <div id="diag-timeline" style="max-height:52vh; overflow-y:auto; background:#1a1a1a; border:1px solid #333; border-radius:8px; padding:6px; font-family:monospace; font-size:0.82em;"></div>
            </div>
        </div>`;
    document.getElementById('diag-run-btn').onclick = async () => { await amDiagRunChecks(); renderAmDiagAll(); };
    document.getElementById('diag-only-problems').addEventListener('change', renderAmDiagAll);
    document.getElementById('diag-clear-btn').onclick = () => { if (window.amDiag) window.amDiag.clear(); renderAmDiagAll(); amDiagSay('🧹 기록을 지웠습니다.', '#4CAF50'); };
    document.getElementById('diag-report-btn').onclick = async () => {
        const text = amDiagBuildReport();
        try { await navigator.clipboard.writeText(text); amDiagSay('✅ 보고서를 클립보드에 복사했습니다.', '#4CAF50'); }
        catch (e) { window.prompt('복사가 막혀 있어 직접 복사해 주세요 (Ctrl+C):', text.slice(0, 4000)); }
    };
    document.getElementById('diag-save-btn').onclick = () => {
        const blob = new Blob([amDiagBuildReport()], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = `assetmanager_diag_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    };
    document.getElementById('diag-serverlog-btn').onclick = async () => {
        const inf = amDiagInfer();
        const top = inf[0];
        const message = `[진단] ${amDiagStatusText()} | 판정: ${top ? top.title : '-'} | 최근 오류 이벤트: ${(window.amDiag ? window.amDiag.events.filter(e => e.level === 'error').slice(-1)[0] : null)?.msg || '없음'}`.slice(0, 500);
        try {
            if (typeof API !== 'undefined' && API.post) await API.post('/assetmanager/api/log', { message });
            else await fetch('/assetmanager/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
            amDiagSay('✅ 서버 로그에 요약을 기록했습니다.', '#4CAF50');
        } catch (e) { amDiagSay('❌ 서버 로그 기록에 실패했습니다: ' + (e && e.message || e), '#ef5350'); }
    };
    return root;
}
function amDiagSay(text, color) {
    const el = document.getElementById('diag-msg');
    if (!el) return;
    el.style.color = color || '#aaa'; el.textContent = text;
    clearTimeout(amDiagSay._t); amDiagSay._t = setTimeout(() => { el.textContent = ''; }, 5000);
}

/** 판정 신호등 + 현재 상태 + 추정 원인 목록 HTML. limit이 있으면 앞에서 그 개수만 (빠른 진단 팝업용) */
function amDiagVerdictHtml(inf, limit) {
    const worst = inf[0] ? inf[0].level : 'ok';
    const light = { error: ['🔴', '#ef5350', '문제가 감지되었습니다'], warn: ['🟡', '#FFB74D', '의심되는 점이 있습니다'], info: ['🟢', '#4CAF50', '정상 진행 중입니다'], ok: ['🟢', '#4CAF50', '정상입니다'] }[worst];
    const lvIcon = { error: '🔴', warn: '🟡', info: '🔵', ok: '🟢' };
    const html = [`<div style="font-size:1.1em; font-weight:bold; color:${light[1]};">${light[0]} ${light[2]}</div>`,
        `<div style="color:#bbb; margin:4px 0 8px;">${amDiagEsc(amDiagStatusText())}</div>`];
    (limit ? inf.slice(0, limit) : inf).forEach(i => {
        html.push(`<div style="border-top:1px solid #2a2a2a; padding:7px 0;"><div style="font-weight:bold;">${lvIcon[i.level]} ${amDiagEsc(i.title)}</div>`
            + (i.detail ? `<div style="color:#ccc; white-space:pre-wrap; margin-top:3px; font-size:0.9em;">${amDiagEsc(i.detail)}</div>` : '')
            + (i.next.length ? `<div style="color:#8ab4f8; margin-top:3px; font-size:0.85em;">${i.next.map(n => '→ ' + amDiagEsc(n)).join('<br>')}</div>` : '') + '</div>');
    });
    if (limit && inf.length > limit) html.push(`<div style="color:#888; font-size:0.82em; padding-top:6px;">… 외 ${inf.length - limit}건 — [자세히]에서 전부 볼 수 있습니다</div>`);
    return html.join('');
}

function renderAmDiagAll() {
    if (!document.getElementById('diag-verdict')) return;
    document.getElementById('diag-verdict').innerHTML = amDiagVerdictHtml(amDiagInfer());

    // 점검 표
    const ck = window.__amDiagChecks, cbox = document.getElementById('diag-checks');
    if (!ck) cbox.innerHTML = '<div style="color:#777; padding:6px;">아직 점검하지 않았습니다. [지금 점검]을 눌러주세요.</div>';
    else {
        const row = (ok, name, val) => `<div style="display:flex; gap:6px; padding:3px 2px; border-bottom:1px solid #2a2a2a;"><span>${ok === null ? '⚪' : ok ? '🟢' : '🔴'}</span><span style="min-width:120px; color:#ddd;">${amDiagEsc(name)}</span><span style="color:#aaa; word-break:break-all;">${amDiagEsc(val)}</span></div>`;
        const vram = ck.comfy.vramFree !== null ? ` · VRAM 여유 ${(ck.comfy.vramFree / 1048576).toFixed(0)}/${(ck.comfy.vramTotal / 1048576).toFixed(0)}MB` : '';
        cbox.innerHTML = [
            row(ck.comfy.ok, 'ComfyUI 서버', ck.comfy.ok ? `응답 ${ck.comfy.ms}ms${ck.comfy.version ? ' · v' + ck.comfy.version : ''}${vram}` : `응답 없음 (${ck.comfy.status || ck.comfy.error})`),
            row(ck.ws.state === 1, '웹소켓', ck.ws.name),
            row(ck.queue.ok, 'ComfyUI 큐', ck.queue.ok ? `실행 ${ck.queue.running}개 · 대기 ${ck.queue.pending}개` : `확인 실패 (${ck.queue.status || ck.queue.error})`),
            row(ck.backend.ok, 'AssetManager 백엔드', ck.backend.ok ? `응답 ${ck.backend.ms}ms` : `응답 없음 (${ck.backend.status || ck.backend.error})`),
            row(ck.env.storageOk, '브라우저 저장소', ck.env.storageOk ? '사용 가능' : '사용 불가'),
            row(null, 'NAI 토큰 / 나노바나나 키', `${ck.env.naiToken ? '입력됨' : '비어있음'} / ${ck.env.nanoKey ? '입력됨' : '비어있음'}`),
            row(null, '라이브러리 / 대기열', `그룹 ${ck.env.categories}개 · 조각 ${ck.env.pieces}개 · 대기열 ${ck.env.queueJobs}개`),
            `<div style="color:#666; font-size:0.75em; margin-top:4px;">마지막 점검 ${amDiagFmtTime(ck.at)}</div>`
        ].join('');
    }

    // 타임라인
    const D = window.amDiag, tbox = document.getElementById('diag-timeline');
    const only = document.getElementById('diag-only-problems').checked;
    const evs = (D ? D.events : []).filter(e => !only || e.level === 'error' || e.level === 'warn').slice(-200).reverse();
    const color = { error: '#ef5350', warn: '#FFB74D', info: '#9aa0a6' };
    tbox.innerHTML = evs.length ? evs.map(e => `<div style="color:${color[e.level] || '#9aa0a6'}; padding:1px 2px; word-break:break-all;">${amDiagFmtTime(e.t)} <b>${amDiagEsc(e.type)}</b> ${amDiagEsc(e.msg)}</div>`).join('')
        : '<div style="color:#777; padding:6px;">기록된 이벤트가 없습니다.</div>';
}

async function renderAmDiagTool() {
    if (!ensureAmDiagUI()) return;
    renderAmDiagAll();
    await amDiagRunChecks();
    renderAmDiagAll();
    if (!amDiagTimer) {
        amDiagTimer = setInterval(async () => {
            const root = document.getElementById('diag-root');
            if (!root || root.offsetParent === null) return; // 탭이 안 보이면 쉼
            if (document.getElementById('diag-autorefresh')?.checked) await amDiagRunChecks();
            renderAmDiagAll();
        }, 5000);
    }
}
window.renderAmDiagTool = renderAmDiagTool;


/* ── 🩺 빠른 진단 (생성중지 옆 "📋 로그" 옆의 🩺 버튼) ──
   버튼에는 현재 상태 신호등(🔴 문제 / 🟡 의심 / 🟢 정상 진행)이 3초마다 갱신되고,
   누르면 팝업으로 지금 판정과 추정 원인을 보여준다. (자세한 건 🛠️ 도구 → 🩺 에셋매니저 진단) */
function renderAmDiagQuick() {
    const body = document.getElementById('diag-quick-body');
    if (body) body.innerHTML = amDiagVerdictHtml(amDiagInfer(), 4);
}
function openAmDiagQuick() {
    let m = document.getElementById('diag-quick-modal');
    if (!m) {
        m = document.createElement('div');
        m.id = 'diag-quick-modal';
        m.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.65); z-index:99999; display:none; align-items:center; justify-content:center;';
        m.innerHTML = `
            <div style="background:#1e1e1e; border:1px solid #555; border-radius:10px; width:min(580px, 92vw); max-height:82vh; overflow:auto; padding:16px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <h3 style="margin:0;">🩺 빠른 진단</h3>
                    <button id="diag-quick-close" class="btn-secondary" style="padding:2px 10px;">✕</button>
                </div>
                <div id="diag-quick-body"></div>
                <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px;">
                    <button id="diag-quick-run" class="btn-primary" style="padding:6px 12px;">🔍 지금 점검</button>
                    <button id="diag-quick-copy" class="btn-secondary" style="padding:6px 12px;">📋 보고서 복사</button>
                    <button id="diag-quick-more" class="btn-secondary" style="padding:6px 12px;">🩺 자세히 (도구 탭)</button>
                </div>
            </div>`;
        document.body.appendChild(m);
        const close = () => { m.style.display = 'none'; };
        m.addEventListener('mousedown', (e) => { if (e.target === m) close(); });
        document.getElementById('diag-quick-close').onclick = close;
        document.getElementById('diag-quick-run').onclick = async () => { await amDiagRunChecks(); renderAmDiagQuick(); updateAmDiagQuickButton(); };
        document.getElementById('diag-quick-copy').onclick = async () => {
            try { await navigator.clipboard.writeText(amDiagBuildReport()); document.getElementById('diag-quick-copy').textContent = '✅ 복사됨'; setTimeout(() => { const b = document.getElementById('diag-quick-copy'); if (b) b.textContent = '📋 보고서 복사'; }, 2000); }
            catch (e) { window.prompt('복사가 막혀 있어 직접 복사해 주세요 (Ctrl+C):', amDiagBuildReport().slice(0, 4000)); }
        };
        document.getElementById('diag-quick-more').onclick = () => {
            close();
            const tabBtn = document.querySelector('button[onclick*="tab-tools-diag"]');
            if (tabBtn) tabBtn.click();
        };
    }
    m.style.display = 'flex';
    renderAmDiagQuick();
    amDiagRunChecks().then(() => { if (m.style.display !== 'none') renderAmDiagQuick(); updateAmDiagQuickButton(); }).catch(() => {});
}
function updateAmDiagQuickButton() {
    const b = document.getElementById('diag-quick-btn');
    if (!b || !window.amDiag) return;
    const inf = amDiagInfer();
    const worst = inf[0] ? inf[0].level : 'ok';
    const dot = worst === 'error' ? ' 🔴' : worst === 'warn' ? ' 🟡' : worst === 'info' ? ' 🟢' : '';
    b.textContent = `🩺 진단${dot}`;
    b.title = (inf[0] && worst !== 'ok') ? `진단: ${inf[0].title} (클릭하면 자세히)` : '진단: 눈에 띄는 문제 없음 (클릭하면 상태 점검)';
}
window.openAmDiagQuick = openAmDiagQuick;
setInterval(() => { try { updateAmDiagQuickButton(); } catch (e) {} }, 3000);


/* ══════════════════════════════════════════════
   ⬆️ 검수 완료 후 "승인된 파일 일괄 업스케일"
   이미지 검수에서 "좋음"으로 저장된 파일(reviewState.decisions[].destPath)들을, 검수를 전부 끝낸 뒤에 나타나는
   버튼으로 한 번에 확대한다. 방식은 두 가지이고 창에서 위쪽(기본)이 "일반 업스케일", 아래쪽이 "NAI 업스케일":
     - 🖼️ 일반 업스케일(기본): 서버에서 Lanczos 보간으로 확대 — 빠르고 무료, 토큰 불필요, PNG 메타데이터 유지.
                               → 각 원본 폴더 안의 upscaled 폴더 (백엔드 /assetmanager/api/upscale_file)
     - 🎨 NAI 업스케일: NAI의 AI 업스케일(Anlas 안 듦, 토큰 필요)
                               → 각 원본 폴더 안의 upscaled_nai 폴더 (백엔드 /assetmanager/api/nai_upscale_file)
   두 방식의 결과 폴더를 나눈 이유: 같은 폴더를 쓰면 "이미 있으면 건너뛰기" 때문에 한쪽을 돌린 뒤 다른 쪽이 전부 건너뛰어짐.
   원본은 그대로 두고, 한 장씩 순서대로 처리하며, 이미 만든 파일은 건너뛰므로 중간에 멈춰도 다시 누르면 이어서 처리됨.
   NAI 쪽만: 장 사이 간격을 두고, 429(요청 과다)는 대기 후 재시도, 401·402(토큰·Anlas)는 계속해도 소용없어서 즉시 중단.
   ══════════════════════════════════════════════ */
let BATCH_UPSCALE_GAP_MS = 800;              // NAI: 장 사이 간격 (서버 부담/429 완화)
let BATCH_UPSCALE_RETRY_MS = [5000, 10000];  // NAI: 429일 때 재시도 전 대기 (2번 재시도)
let batchUpscaleRunning = false;
let batchUpscaleAbort = false;
let batchUpscaleMethod = '';

const BATCH_UPSCALE_METHODS = {
    plain: { label: '일반 업스케일', endpoint: '/assetmanager/api/upscale_file', subfolder: 'upscaled', startId: 'bu-start-plain', scaleId: 'bu-scale-plain', startLabel: '▶ 일반 업스케일 시작' },
    nai: { label: 'NAI 업스케일', endpoint: '/assetmanager/api/nai_upscale_file', subfolder: 'upscaled_nai', startId: 'bu-start-nai', scaleId: 'bu-scale-nai', startLabel: '▶ NAI 업스케일 시작' }
};

/** 이번 검수에서 "좋음"으로 저장된 파일 경로들 (같은 경로는 한 번만, 되돌리기한 건 이미 decisions에서 빠져 있음) */
function getReviewApprovedFiles() {
    const seen = new Set(), out = [];
    Object.values(reviewState.decisions || {}).forEach(d => {
        if (d && d.type === 'good' && d.destPath && !seen.has(d.destPath)) { seen.add(d.destPath); out.push(d.destPath); }
    });
    return out;
}
/** 검수 대기열의 모든 항목에 판정이 내려졌는가 */
function isReviewComplete() {
    return reviewState.queue.length > 0 && reviewState.queue.every(e => reviewState.decisions[reviewEntryKey(e)]);
}

/** 검수를 전부 끝내고 승인된 파일이 있을 때만 "일괄 업스케일" 버튼을 보여준다 */
function updateReviewUpscaleButton() {
    const progress = document.getElementById('review-progress');
    if (!progress || !progress.parentElement) return;
    let row = document.getElementById('review-upscale-row');
    const files = getReviewApprovedFiles();
    if (!(isReviewComplete() && files.length > 0)) { if (row) row.style.display = 'none'; return; }
    if (!row) {
        row = document.createElement('div');
        row.id = 'review-upscale-row';
        row.style.cssText = 'margin-top:6px;';
        row.innerHTML = '<button id="review-batch-upscale-btn" style="padding:7px 16px; background:#1a2a3a; border:1px solid #4a90d9; color:#7ab8f5; border-radius:6px; cursor:pointer; font-size:0.9em;"></button>';
        progress.parentElement.appendChild(row);
        row.querySelector('button').onclick = openBatchUpscaleModal;
    }
    row.style.display = 'block';
    row.querySelector('button').textContent = `⬆️ 승인된 ${files.length}장 일괄 업스케일`;
    row.querySelector('button').title = '검수에서 좋음으로 저장한 파일들을 한 번에 키웁니다. 기본은 일반 업스케일(빠름·무료), NAI 업스케일도 선택 가능. 원본은 그대로 두고 upscaled 폴더에 저장.';
}
// showCurrentReviewImage()는 여러 곳에서 호출되고 return 지점도 많아서, 감싸서 "항상 호출 후" 버튼 상태를 갱신한다.
(function wrapShowCurrentReviewImageForUpscale() {
    if (typeof showCurrentReviewImage !== 'function' || showCurrentReviewImage.__upscaleWrapped) return;
    const orig = showCurrentReviewImage;
    showCurrentReviewImage = function (...args) {
        const r = orig.apply(this, args);
        try { updateReviewUpscaleButton(); } catch (e) { /* 버튼 갱신 실패가 검수 화면을 막으면 안 됨 */ }
        return r;
    };
    showCurrentReviewImage.__upscaleWrapped = true;
})();

function buSleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function buBasename(p) { return String(p).split(/[\\/]/).pop(); }
function buLog(html, color) {
    const log = document.getElementById('bu-log'); if (!log) return;
    const d = document.createElement('div'); d.style.color = color || '#bbb'; d.innerHTML = html; log.appendChild(d); log.scrollTop = log.scrollHeight;
}
function buSetStatus(text) { const el = document.getElementById('bu-status'); if (el) el.textContent = text; }
function buSetBar(done, total) { const el = document.getElementById('bu-bar-fill'); if (el) el.style.width = (total ? Math.round(done / total * 100) : 0) + '%'; }

function openBatchUpscaleModal() {
    const files = getReviewApprovedFiles();
    if (files.length === 0) { alert('업스케일할 승인된 파일이 없습니다.'); return; }
    const old = document.getElementById('batch-upscale-modal'); if (old) old.remove();
    const m = document.createElement('div');
    m.id = 'batch-upscale-modal';
    m.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:100000; display:flex; align-items:center; justify-content:center;';
    const sample = files.slice(0, 5).map(f => amDiagEsc(buBasename(f))).join(', ') + (files.length > 5 ? ` … 외 ${files.length - 5}장` : '');
    const inputCss = 'background:#222; border:1px solid #555; color:#fff; border-radius:4px; padding:6px; box-sizing:border-box;';
    const badge = (txt, bg) => `<span style="font-size:0.72em; background:${bg}; color:#fff; padding:1px 7px; border-radius:8px; margin-left:6px; vertical-align:middle;">${txt}</span>`;
    m.innerHTML = `
        <div style="background:#1e1e1e; border:1px solid #555; border-radius:10px; width:min(640px, 94vw); max-height:90vh; overflow:auto; padding:16px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <h3 style="margin:0; color:#7ab8f5;">⬆️ 승인된 파일 일괄 업스케일</h3>
                <button id="bu-close" class="btn-secondary" style="padding:2px 10px;">✕</button>
            </div>
            <div style="font-size:0.88em; color:#ccc;">대상 <b>${files.length}장</b> — ${sample}</div>
            <div style="font-size:0.78em; color:#888; margin:4px 0 8px;">원본은 그대로 두고, 결과는 각 원본이 있는 폴더 안의 하위 폴더에 같은 파일명(.png)으로 저장합니다. 한 장씩 처리하고, 이미 만든 파일은 건너뛰어서 멈췄다 다시 눌러도 이어집니다.</div>
            <label style="font-size:0.88em; cursor:pointer; display:block; margin-bottom:10px;"><input type="checkbox" id="bu-skip" checked> 이미 업스케일된 파일은 건너뛰기</label>

            <div id="bu-section-plain" style="border:1px solid #4a90d9; background:#18222e; border-radius:8px; padding:10px; margin-bottom:10px;">
                <div style="font-weight:bold; color:#7ab8f5;">🖼️ 일반 업스케일${badge('기본', '#4a90d9')}</div>
                <div style="font-size:0.78em; color:#9ab; margin:4px 0 8px;">Lanczos 보간으로 확대 — 빠르고 무료, 토큰 불필요 (AI 업스케일이 아닌 일반 확대). PNG는 프롬프트 메타데이터도 그대로 유지. 저장: <code>upscaled</code> 폴더</div>
                <div style="display:flex; gap:10px; align-items:center;">
                    <label style="font-size:0.88em;">배율
                        <select id="bu-scale-plain" style="${inputCss}"><option value="2">2배</option><option value="3">3배</option><option value="4">4배</option><option value="1.5">1.5배</option></select>
                    </label>
                    <button id="bu-start-plain" class="btn-primary" style="flex:1; padding:9px;">${BATCH_UPSCALE_METHODS.plain.startLabel}</button>
                </div>
            </div>

            <div id="bu-section-nai" style="border:1px solid #444; border-radius:8px; padding:10px; margin-bottom:6px;">
                <div style="font-weight:bold; color:#ccc;">🎨 NAI 업스케일${badge('AI · 토큰 필요', '#6a5acd')}</div>
                <div style="font-size:0.78em; color:#888; margin:4px 0 8px;">NAI의 AI 업스케일(Anlas 안 듦)로 처리 — 더 선명하게 복원되지만 느리고 NAI 토큰이 필요합니다. 저장: <code>upscaled_nai</code> 폴더</div>
                <div style="display:flex; gap:10px; align-items:center; margin-bottom:8px;">
                    <label style="font-size:0.88em;">배율
                        <select id="bu-scale-nai" style="${inputCss}"><option value="4">4배</option><option value="2">2배</option></select>
                    </label>
                    <input type="password" id="bu-token" placeholder="NAI 토큰 (비우면 생성 탭/도구 탭에 넣어둔 토큰 사용)" style="flex:1; ${inputCss}">
                </div>
                <button id="bu-start-nai" class="btn-secondary" style="width:100%; padding:9px;">${BATCH_UPSCALE_METHODS.nai.startLabel}</button>
            </div>

            <div id="bu-bar" style="height:8px; background:#2a2a2a; border-radius:4px; margin-top:12px; overflow:hidden;"><div id="bu-bar-fill" style="height:100%; width:0%; background:#4a90d9;"></div></div>
            <div id="bu-status" style="font-size:0.88em; color:#ccc; margin-top:6px;"></div>
            <div id="bu-log" style="font-size:0.8em; max-height:26vh; overflow-y:auto; margin-top:6px; font-family:monospace;"></div>
        </div>`;
    document.body.appendChild(m);
    // 배율 기억 (방식별로 따로)
    const plainSel = document.getElementById('bu-scale-plain'), naiSel = document.getElementById('bu-scale-nai');
    const savedPlain = localStorage.getItem('am_batch_upscale_plain_scale');
    if (savedPlain && Array.from(plainSel.options).some(o => o.value === savedPlain)) plainSel.value = savedPlain;
    naiSel.value = localStorage.getItem('am_batch_upscale_scale') === '2' ? '2' : '4';
    plainSel.onchange = () => { try { localStorage.setItem('am_batch_upscale_plain_scale', plainSel.value); } catch (e) {} };
    naiSel.onchange = () => { try { localStorage.setItem('am_batch_upscale_scale', naiSel.value); } catch (e) {} };
    document.getElementById('bu-close').onclick = () => {
        if (batchUpscaleRunning) { alert('진행 중에는 닫을 수 없습니다. 먼저 ⏹ 중지를 눌러주세요.'); return; }
        m.remove();
    };
    document.getElementById('bu-start-plain').onclick = () => runBatchUpscale('plain');
    document.getElementById('bu-start-nai').onclick = () => runBatchUpscale('nai');
}

async function runBatchUpscale(method) {
    const cfg = BATCH_UPSCALE_METHODS[method];
    if (!cfg) return;
    const isNai = method === 'nai';
    const startBtn = document.getElementById(cfg.startId);
    if (batchUpscaleRunning) {
        if (batchUpscaleMethod === method) { batchUpscaleAbort = true; buSetStatus('⏹ 중지하는 중… (지금 처리 중인 한 장까지만 끝납니다)'); }
        return; // 다른 방식이 돌고 있는 동안엔 무시
    }
    const files = getReviewApprovedFiles();
    if (files.length === 0) { alert('업스케일할 승인된 파일이 없습니다.'); return; }
    let token = '';
    if (isNai) {
        token = document.getElementById('bu-token')?.value?.trim()
            || document.getElementById('nai-director-token')?.value?.trim()
            || document.getElementById('nai-api-token')?.value?.trim()
            || localStorage.getItem('naiApiToken') || '';
        if (!token) { alert('NAI API 토큰이 필요합니다. (이 창이나 생성 탭/도구 탭 어느 한쪽에 입력하면 됩니다)'); return; }
    }
    const scale = parseFloat(document.getElementById(cfg.scaleId)?.value || (isNai ? '4' : '2'));
    const skipExisting = !!document.getElementById('bu-skip')?.checked;
    const otherBtn = document.getElementById(isNai ? BATCH_UPSCALE_METHODS.plain.startId : BATCH_UPSCALE_METHODS.nai.startId);

    batchUpscaleRunning = true; batchUpscaleAbort = false; batchUpscaleMethod = method;
    startBtn.textContent = '⏹ 중지';
    if (otherBtn) otherBtn.disabled = true;
    document.getElementById('bu-log').innerHTML = '';
    buSetBar(0, files.length);
    let okN = 0, skipN = 0, failN = 0, processed = 0, fatal = '';

    for (let i = 0; i < files.length; i++) {
        if (batchUpscaleAbort) break;
        const path = files[i], name = buBasename(path);
        buSetStatus(`[${cfg.label}] ${i + 1} / ${files.length} 처리 중: ${name}`);
        const body = { path, scale, skipExisting, outSubfolder: cfg.subfolder };
        if (isNai) body.token = token;
        let result = null;
        const maxRetry = isNai ? BATCH_UPSCALE_RETRY_MS.length : 0; // 429 재시도는 NAI만
        for (let attempt = 0; attempt <= maxRetry; attempt++) {
            try {
                const res = await fetch(cfg.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                result = await res.json();
            } catch (e) { result = { ok: false, error: `서버 통신 오류: ${e}` }; }
            if (result.ok || result.status !== 429 || attempt >= maxRetry || batchUpscaleAbort) break;
            const wait = BATCH_UPSCALE_RETRY_MS[attempt];
            buLog(`⏳ ${amDiagEsc(name)}: 요청이 몰려 ${Math.round(wait / 1000)}초 후 다시 시도`, '#FFB74D');
            await buSleep(wait);
        }
        processed++;
        if (result.ok) {
            if (result.skipped) { skipN++; buLog(`⏭ ${amDiagEsc(name)} — 이미 있어서 건너뜀`, '#888'); }
            else { okN++; buLog(`✅ ${amDiagEsc(name)}${result.width ? ` → ${result.width}×${result.height}` : ''}`, '#4CAF50'); }
        } else {
            failN++;
            buLog(`❌ ${amDiagEsc(name)} — ${amDiagEsc(result.error || '알 수 없는 오류')}`, '#ef5350');
            if (isNai && (result.status === 401 || result.status === 402)) { fatal = result.status === 401 ? '토큰 오류' : 'Anlas/구독 문제'; break; } // 계속해도 전부 실패하므로 중단
        }
        buSetBar(processed, files.length);
        if (isNai && i < files.length - 1 && !batchUpscaleAbort && !result.skipped) await buSleep(BATCH_UPSCALE_GAP_MS);
    }

    batchUpscaleRunning = false;
    const left = files.length - processed;
    const summary = `✅ 업스케일 ${okN}장 · ⏭ 건너뜀 ${skipN}장 · ❌ 실패 ${failN}장` + (left > 0 ? ` · 남음 ${left}장` : '');
    if (fatal) buSetStatus(`🛑 [${cfg.label}] ${fatal}로 중단했습니다. ${summary}`);
    else if (batchUpscaleAbort) buSetStatus(`⏹ [${cfg.label}] 중지됨. ${summary}`);
    else buSetStatus(`🎉 [${cfg.label}] 완료. ${summary}`);
    if (startBtn) startBtn.textContent = (failN > 0 || left > 0) ? '▶ 다시 시작 (끝낸 파일은 건너뜀)' : '▶ 한 번 더 실행';
    if (otherBtn) otherBtn.disabled = false;
    batchUpscaleAbort = false; batchUpscaleMethod = '';
}
window.openBatchUpscaleModal = openBatchUpscaleModal;


/* ══════════════════════════════════════════════
   🧩 워크플로우 이미지 실행 (🛠️ 도구 탭 "워크플로우 이미지 실행", index.html의 #tab-tools-wfrun)
   다른 사람이 만든 ComfyUI 워크플로우가 들어 있는 이미지(PNG 등) 또는 API 형식 .json을 넣으면, 그 워크플로우를 그대로
   이 ComfyUI에서 실행해서 결과를 뽑는다. (ComfyUI가 저장한 이미지에는 "prompt"(API 형식, 실행 가능)와 "workflow"(편집기용)가 들어 있음)
   - 실행 전 사전 점검: 이 ComfyUI에 없는 노드 / 없는 모델 파일(체크포인트·로라 등)을 미리 알려줌 (막지는 않음, ComfyUI가 최종 판단)
   - 안전: 임의 코드를 실행할 수 있는 이름의 노드(exec/eval/python/shell 등)가 있으면 경고 후 확인을 받음
   - 시드 랜덤(기본 켬): ComfyUI는 같은 그래프를 또 보내면 캐시 때문에 새로 안 뽑으므로 매번 시드를 바꿈 / 횟수 지정 가능
   - 프롬프트 칸(CLIPTextEncode)은 고쳐서 실행 가능
   - 실행 중에는 window.isStandaloneExecution을 켜서(단독 검열기와 같은 방식) 생성 탭 UI/노드 로그가 남의 노드 번호로 오염되지 않게 함
   ══════════════════════════════════════════════ */
const WF_WEIGHT_EXT_RE = /\.(safetensors|ckpt|pt|pth|gguf|bin|onnx)$/i;
const WF_SUSPICIOUS_RE = /(exec|eval|python|shell|bash|subprocess|command|script|system|terminal|cmd)/i;
let WF_POLL_MS = 2000;
let WF_TIMEOUT_MS = 30 * 60 * 1000;

/** File/Blob → ArrayBuffer (오래된 브라우저/테스트 환경은 FileReader로) */
function wfReadBuffer(file) {
    if (file && typeof file.arrayBuffer === 'function') return file.arrayBuffer();
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error);
        fr.readAsArrayBuffer(file);
    });
}
function wfReadText(file) {
    if (file && typeof file.text === 'function') return file.text();
    return wfReadBuffer(file).then(buf => new TextDecoder('utf-8').decode(buf));
}
async function wfInflate(u8) {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
function wfDecodeText(u8) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch (e) { return new TextDecoder('latin1').decode(u8); }
}

/** PNG의 텍스트 청크(tEXt / zTXt / iTXt)를 {키: 글자}로 읽는다. PNG가 아니면 null. */
async function wfParsePngText(buf) {
    const u8 = new Uint8Array(buf);
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    if (u8.length < 8 || sig.some((b, i) => u8[i] !== b)) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const latin1 = (s, e) => { let r = ''; for (let i = s; i < e; i++) r += String.fromCharCode(u8[i]); return r; };
    const out = {};
    let p = 8;
    while (p + 8 <= u8.length) {
        const len = dv.getUint32(p), type = latin1(p + 4, p + 8), ds = p + 8, de = ds + len;
        if (de > u8.length) break;
        try {
            if (type === 'tEXt') {
                const z = u8.indexOf(0, ds);
                if (z > ds && z < de) out[latin1(ds, z)] = wfDecodeText(u8.subarray(z + 1, de));
            } else if (type === 'zTXt') {
                const z = u8.indexOf(0, ds);
                if (z > ds && z < de) out[latin1(ds, z)] = wfDecodeText(await wfInflate(u8.subarray(z + 2, de)));
            } else if (type === 'iTXt') {
                const z = u8.indexOf(0, ds);
                if (z > ds && z < de) {
                    const compressed = u8[z + 1] === 1;
                    let q = z + 3;                                // 압축 플래그(1) + 압축 방식(1) 다음
                    q = u8.indexOf(0, q) + 1;                     // 언어 태그
                    q = u8.indexOf(0, q) + 1;                     // 번역된 키워드
                    if (q > 0 && q <= de) {
                        const body = u8.subarray(q, de);
                        out[latin1(ds, z)] = wfDecodeText(compressed ? await wfInflate(body) : body);
                    }
                }
            }
        } catch (e) { /* 깨진 청크 하나 때문에 전체를 포기하지 않음 */ }
        if (type === 'IEND') break;
        p = de + 4; // CRC 건너뜀
    }
    return out;
}

/** 바이트 1개를 글자 1개로 읽은 문자열에서 "key:{...}" 패턴을 찾아 중괄호 짝이 맞는 데까지 잘라 돌려준다. (문자열 안의 "/{/}는 무시) */
function wfFindBalancedJsonByMarker(s, key) {
    const marker = `${key}:{`;
    const start = s.indexOf(marker);
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start + key.length + 1; i < s.length; i++) {
        const c = s[i];
        if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return s.slice(start + key.length + 1, i + 1); }
    }
    return null;
}
/** WebP/JPEG처럼 PNG가 아닌 파일: 파일 안에서 `prompt:{...}` / `workflow:{...}` 형태의 JSON 글자를 찾아낸다 (ComfyUI가 EXIF에 이렇게 저장).
 *  EXIF의 UserComment는 글자에 비ASCII(한글 등)가 하나라도 있으면 UTF-16으로 인코딩되는 경우가 많아서, ASCII로 읽으면 "prompt:{"
 *  글자 자체를 못 찾는 문제가 있었다(ComfyUI 자체 로더는 EXIF 태그 구조를 제대로 해석해서 문제없이 읽음). 이를 보강하기 위해
 *  ① 바이트 그대로(ASCII/UTF-8 마커가 그대로 보이는 경우), ② UTF-16LE, ③ UTF-16BE 세 가지로 각각 읽어보고,
 *  앞의 텍스트(헤더)가 짝수/홀수 바이트일 수 있어 자리가 한 칸씩 밀릴 수 있으므로 각 인코딩을 시작 위치 0/1 두 가지로도 시도한다. */
function wfScanEmbeddedJson(buf, key) {
    const u8 = new Uint8Array(buf);
    const candidates = [];
    // ① UTF-8(가장 흔한 경우, 멀티바이트 한글도 정확히 복원). TextDecoder가 없는 아주 예전 환경을 대비해 바이트=글자 방식도 뒤에 남겨둠(마커 자체는 ASCII라 못 찾는 일은 없지만 본문이 깨질 수 있음).
    if (typeof TextDecoder !== 'undefined') {
        try { candidates.push(new TextDecoder('utf-8', { fatal: false }).decode(u8)); } catch (e) { /* 폴백으로 넘어감 */ }
    }
    let ascii = '';
    for (let i = 0; i < u8.length; i += 0x8000) ascii += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    candidates.push(ascii);
    // ② UTF-16LE/BE: EXIF의 UserComment는 비ASCII(한글 등)가 섞이면 이렇게 인코딩되는 경우가 많음(① 방식으론 "prompt:{" 자체를 못 찾음).
    //    앞의 헤더 바이트 수가 짝수/홀수일 수 있어 정렬이 한 칸 밀릴 수 있으므로 시작 위치 0/1을 모두 시도한다.
    if (typeof TextDecoder !== 'undefined') {
        for (const enc of ['utf-16le', 'utf-16be']) {
            for (const offset of [0, 1]) {
                try { candidates.push(new TextDecoder(enc, { fatal: false }).decode(u8.subarray(offset))); }
                catch (e) { /* 이 환경이 해당 인코딩을 지원하지 않으면 건너뜀 */ }
            }
        }
    }
    for (const s of candidates) {
        const found = wfFindBalancedJsonByMarker(s, key);
        if (found) return found;
    }
    return null;
}

/** API 형식(바로 실행 가능해 보이는) 프롬프트인가: {"3": {inputs: {...}, ...}, ...} (모든 항목이 노드 모양이어야 함)
 *  ⚠️ class_type이 있는지는 여기서 요구하지 않는다. 일부 커스텀 노드 조합(프론트엔드 전용 보조 노드 등)이 class_type 없이
 *  inputs/_meta만 가진 항목을 내보내는 경우가 실제로 있었는데, 우리가 ComfyUI의 진짜 실행 가능 여부를 완벽히 재현할 수는
 *  없으므로 "노드 딕셔너리처럼 생겼다"는 느슨한 판정만 하고, 실제로 실행 가능한지(class_type 누락 등)는 ComfyUI의
 *  /prompt 쪽 검증에 맡긴다 — 거부되면 그 실제 오류 메시지를 그대로 보여준다(아래 wfRunOnce). */
function wfIsApiPrompt(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    const vals = Object.values(obj);
    return vals.length > 0 && vals.every(wfLooksLikeApiNode);
}
/** 값 하나가 "노드처럼 생겼는지"(inputs 객체를 가진 객체). class_type은 요구하지 않음(위 설명 참고). */
function wfLooksLikeApiNode(v) {
    return !!(v && typeof v === 'object' && !Array.isArray(v) && v.inputs && typeof v.inputs === 'object' && !Array.isArray(v.inputs));
}
/** obj에서 노드처럼 생긴 항목만 추려낸다. 전체 중 절반 이상이 노드 모양일 때만 "노드 목록"으로 보고, 그 외(노드가 아닌
 *  부가 정보 키)는 버린다. 노드가 하나도 없거나 비중이 낮으면(엉뚱한 JSON으로 오판 방지) null. */
function wfFilterApiNodes(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const entries = Object.entries(obj);
    const nodeEntries = entries.filter(([, v]) => wfLooksLikeApiNode(v));
    if (nodeEntries.length === 0 || nodeEntries.length < entries.length / 2) return null;
    return Object.fromEntries(nodeEntries);
}
/** obj → 실행 가능한 API 프롬프트로 최대한 너그럽게 뽑아본다 (아래로 갈수록 느슨함):
 *  ① obj 전체가 그대로 API 형식 ② {"prompt": {...}} 처럼 한 겹 감싼 형태(ComfyUI 버전에 따라 이렇게 내보내기도 함)
 *  ③ ①/②에서, 노드가 아닌 부가 정보 키(예: 최근 ComfyUI가 넣는 모델 해시 정보 등)가 섞여 있어도 노드만 추려서 사용 */
function wfExtractApiPrompt(obj) {
    if (wfIsApiPrompt(obj)) return obj;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        if (wfIsApiPrompt(obj.prompt)) return obj.prompt;
        const filtered = wfFilterApiNodes(obj);
        if (filtered) return filtered;
        if (obj.prompt) { const innerFiltered = wfFilterApiNodes(obj.prompt); if (innerFiltered) return innerFiltered; }
    }
    return null;
}
function wfTryJson(text) { try { return JSON.parse(text); } catch (e) { return null; } }

/** 파일 → { status: 'ok'|'workflow-only'|'none', prompt, workflow, kind } */
async function wfExtractFromFile(file) {
    const name = String(file.name || '');
    if (/\.json$/i.test(name) || file.type === 'application/json') {
        const obj = wfTryJson(await wfReadText(file));
        const api = wfExtractApiPrompt(obj);
        if (api) return { status: 'ok', prompt: api, workflow: (obj && obj.workflow) || null, kind: 'json' };
        if (obj && Array.isArray(obj.nodes)) return { status: 'workflow-only', prompt: null, workflow: obj, kind: 'json' };
        return { status: 'none', prompt: null, workflow: null, kind: 'json' };
    }
    const buf = await wfReadBuffer(file);
    let promptText = null, workflowText = null, kind = 'png';
    const chunks = await wfParsePngText(buf);
    if (chunks) { promptText = chunks.prompt || null; workflowText = chunks.workflow || null; }
    else { kind = 'exif'; promptText = wfScanEmbeddedJson(buf, 'prompt'); workflowText = wfScanEmbeddedJson(buf, 'workflow'); }
    const promptObj = promptText ? wfTryJson(promptText) : null;
    const workflow = workflowText ? wfTryJson(workflowText) : null;
    const prompt = wfExtractApiPrompt(promptObj);
    if (prompt) return { status: 'ok', prompt, workflow, kind };
    if (workflow) return { status: 'workflow-only', prompt: null, workflow, kind };
    return { status: 'none', prompt: null, workflow: null, kind };
}

function wfNodeTitle(id, node) { return (node && node._meta && node._meta.title) || (node && node.class_type) || `#${id}`; }
/** 노드 번호 → 표시 이름 (실행 중 "지금 어떤 노드" 표시와 로그/진단에 쓰임) */
function wfTitleMap(prompt) {
    const map = {};
    Object.entries(prompt).forEach(([id, node]) => { map[id] = wfNodeTitle(id, node); });
    return map;
}

/** 워크플로우 요약: 노드 수, 사용 모델 파일, 샘플러 설정, 이미지 크기, 고칠 수 있는 프롬프트 칸, 코드 실행 의심 노드 */
function wfSummarize(prompt) {
    const entries = Object.entries(prompt);
    const classes = [...new Set(entries.map(([, n]) => n.class_type))];
    const models = [], samplers = [], prompts = [], suspicious = [];
    let size = null;
    entries.forEach(([id, n]) => {
        const inp = n.inputs || {};
        Object.entries(inp).forEach(([k, v]) => {
            if (typeof v === 'string' && /_name$/.test(k) && WF_WEIGHT_EXT_RE.test(v)) models.push({ id, key: k, value: v });
        });
        if (/sampler/i.test(n.class_type) && ('steps' in inp || 'cfg' in inp)) {
            samplers.push({ id, steps: inp.steps, cfg: inp.cfg, sampler: inp.sampler_name, scheduler: inp.scheduler, seed: inp.seed ?? inp.noise_seed });
        }
        if (/CLIPTextEncode/.test(n.class_type) && typeof inp.text === 'string') prompts.push({ id, title: wfNodeTitle(id, n), text: inp.text });
        if (!size && typeof inp.width === 'number' && typeof inp.height === 'number' && /latent/i.test(n.class_type)) size = [inp.width, inp.height];
        if (WF_SUSPICIOUS_RE.test(n.class_type)) suspicious.push({ id, classType: n.class_type });
    });
    return { nodeCount: entries.length, classes, models, samplers, prompts, size, suspicious };
}

/** 시드를 매번 새로 뽑게 바꾼다 (이어진 링크 [노드, 번호] 로 받는 시드는 건드리지 않음). 바꾼 개수를 반환 */
function wfRandomizeSeeds(prompt) {
    let n = 0;
    Object.values(prompt).forEach(node => {
        const inp = node.inputs || {};
        ['seed', 'noise_seed'].forEach(k => {
            if (typeof inp[k] === 'number') { inp[k] = Math.floor(Math.random() * 1e15); n++; }
        });
    });
    return n;
}

/** 이 ComfyUI에 없는 노드/없는 모델 파일을 미리 찾는다. 반환: { missingNodes:[], missingValues:[{id,key,value,classType}], checked, failed } */
async function wfPreflight(prompt) {
    // class_type이 없는 노드(드물지만 실제로 있었음)는 뭘 점검해야 할지 알 수 없으니 건너뛴다 — "없는 노드: undefined"처럼
    // 잘못 표시되는 걸 막기 위함. 그런 노드가 실제로 실행 가능한지는 ComfyUI의 /prompt 응답으로 판가름난다.
    const classes = [...new Set(Object.values(prompt).map(n => n.class_type).filter(c => typeof c === 'string' && c))];
    const infoByClass = {};
    let failed = 0;
    const queue = classes.slice();
    const worker = async () => {
        while (queue.length) {
            const cls = queue.shift();
            try {
                const res = await fetch(`/object_info/${encodeURIComponent(cls)}`, { __amDiagSilent: true, cache: 'no-store' });
                if (!res.ok) { infoByClass[cls] = null; continue; }
                const json = await res.json();
                infoByClass[cls] = json && json[cls] ? json[cls] : null;
            } catch (e) { failed++; infoByClass[cls] = undefined; }
        }
    };
    await Promise.all(Array.from({ length: Math.min(6, classes.length) }, worker));
    const missingNodes = [], missingValues = [];
    const optionsOf = (spec) => {
        if (!Array.isArray(spec)) return null;
        if (Array.isArray(spec[0])) return spec[0];
        if (spec[0] === 'COMBO' && spec[1] && Array.isArray(spec[1].options)) return spec[1].options;
        return null;
    };
    // INT/FLOAT처럼 "숫자 입력칸"인 스펙. {isInt, min, max, step}을 뽑아준다 (없으면 null)
    const numberSpecOf = (spec) => {
        if (!Array.isArray(spec)) return null;
        if (spec[0] !== 'INT' && spec[0] !== 'FLOAT') return null;
        const cfg = (spec[1] && typeof spec[1] === 'object') ? spec[1] : {};
        return { isInt: spec[0] === 'INT', min: cfg.min, max: cfg.max, step: cfg.step };
    };
    // 시드는 "시드 랜덤" 체크박스가 따로 있어서 여기 다시 노출하면 혼동만 주므로 제외
    const WF_SKIP_NUMBER_KEYS = new Set(['seed', 'noise_seed']);
    classes.forEach(cls => { if (infoByClass[cls] === null) missingNodes.push(cls); });
    const comboFields = [];
    Object.entries(prompt).forEach(([id, node]) => {
        const info = infoByClass[node.class_type];
        if (!info || !info.input) return;
        const specs = Object.assign({}, info.input.optional || {}, info.input.required || {});
        Object.entries(node.inputs || {}).forEach(([key, value]) => {
            // 노드에 원래 콤보(드롭다운)나 숫자 입력칸이 있으면 — 불일치 여부와 무관하게 — 전부 고를 수 있게 모아둔다
            if (typeof value === 'string') {
                const options = optionsOf(specs[key]);
                if (!options || !options.length) return;
                if (!options.includes(value)) missingValues.push({ id, key, value, classType: node.class_type });
                comboFields.push({ id, key, value, classType: node.class_type, options, title: wfNodeTitle(id, node), type: 'combo' });
                return;
            }
            if (typeof value === 'number') {
                if (WF_SKIP_NUMBER_KEYS.has(key)) return;
                const ns = numberSpecOf(specs[key]);
                if (!ns) return;
                comboFields.push({ id, key, value, classType: node.class_type, title: wfNodeTitle(id, node), type: 'number', isInt: ns.isInt, min: ns.min, max: ns.max, step: ns.step });
            }
        });
    });
    return { missingNodes, missingValues, comboFields, checked: classes.length, failed };
}

/** 노드에 원래 있던 콤보(드롭다운)/숫자 입력칸들을 #wfrun-combos 영역에 그려준다.
 *  콤보: 내가 가진 값이면 그 값이 기본 선택, 없는 값("원본")이면 맨 위에 선택 불가 상태로 표시해 실수로 그대로 실행하는 걸 막는다.
 *  숫자(INT/FLOAT, 예: steps/cfg): 원래 값이 기본으로 채워진 숫자 입력칸으로 뜬다. */
function wfRenderComboFields(comboFields) {
    const box = document.getElementById('wfrun-combos');
    if (!box) return;
    if (!comboFields || !comboFields.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = 'block';
    box.innerHTML = `<div style="font-size:0.85em; color:#aaa; margin:8px 0 4px;">🎛️ 체크포인트/로라/샘플러/스텝 등 선택 (내 환경에 맞게 바꿀 수 있어요)</div>` +
        comboFields.map(f => {
            const label = `<div style="font-size:0.78em; color:#888; margin-bottom:2px;">#${wfEsc(f.id)} ${wfEsc(f.title)} — ${wfEsc(f.key)}</div>`;
            if (f.type === 'number') {
                const step = f.step != null ? f.step : (f.isInt ? 1 : 0.1);
                const bounds = [f.min != null ? `min="${f.min}"` : '', f.max != null ? `max="${f.max}"` : ''].filter(Boolean).join(' ');
                return `<div style="margin-bottom:6px;">${label}
                <input type="number" class="wfrun-number-input" data-node-id="${wfEsc(f.id)}" data-key="${wfEsc(f.key)}" data-int="${f.isInt ? '1' : '0'}" value="${wfEsc(f.value)}" step="${step}" ${bounds} style="width:100%; box-sizing:border-box; background:#222; border:1px solid #555; color:#fff; border-radius:4px; padding:5px; font-size:0.85em;">
            </div>`;
            }
            const hasValue = f.options.includes(f.value);
            const placeholder = hasValue ? '' : `<option value="${wfEsc(f.value)}" disabled selected>⚠️ 원본: ${wfEsc(f.value)} (내 목록에 없음)</option>`;
            const opts = f.options.map(o => `<option value="${wfEsc(o)}"${hasValue && o === f.value ? ' selected' : ''}>${wfEsc(o)}</option>`).join('');
            return `<div style="margin-bottom:6px;">${label}
                <select class="wfrun-combo-select" data-node-id="${wfEsc(f.id)}" data-key="${wfEsc(f.key)}" style="width:100%; box-sizing:border-box; background:#222; border:1px solid ${hasValue ? '#555' : '#8a4a2a'}; color:#fff; border-radius:4px; padding:5px; font-size:0.85em;">${placeholder}${opts}</select>
            </div>`;
        }).join('');
    box.querySelectorAll('select.wfrun-combo-select').forEach(sel => {
        sel.onchange = () => { wfState.fieldOverrides[`${sel.dataset.nodeId}::${sel.dataset.key}`] = sel.value; };
    });
    box.querySelectorAll('input.wfrun-number-input').forEach(inp => {
        inp.onchange = () => {
            const n = inp.dataset.int === '1' ? parseInt(inp.value, 10) : parseFloat(inp.value);
            if (!isNaN(n)) wfState.fieldOverrides[`${inp.dataset.nodeId}::${inp.dataset.key}`] = n;
        };
    });
}

/* ── 실행 엔진 + 화면 ── */
const wfState = { prompt: null, summary: null, fileName: '', running: false, abort: false, loadToken: 0, previewUrl: '', fieldOverrides: {} };

function wfEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').split(String.fromCharCode(34)).join('&quot;'); }
function wfSay(text, color) {
    const el = document.getElementById('wfrun-status');
    if (el) { el.textContent = text; el.style.color = color || '#ccc'; }
}
/** 지금 실행을 막아야 하는 이유 (없으면 ''). 이 앱의 생성/다른 단독 작업과 겹치면 서로 상태가 꼬이므로 막는다 */
function wfBusyReason() {
    if (wfState.running) return '이미 실행 중입니다.';
    if (window.isStandaloneExecution) return '다른 단독 작업(검열기 등)이 실행 중입니다. 끝난 뒤 실행하세요.';
    const D = window.amDiag;
    if (D && D.state.appWait.length > 0) return '이 앱의 생성이 진행 중입니다. 끝난 뒤 실행하세요.';
    return '';
}
/** ComfyUI가 /prompt를 거부했을 때의 응답을 사람이 읽을 문장으로 */
function wfFormatPromptError(json, status) {
    if (!json || typeof json !== 'object') return `HTTP ${status} — 응답을 해석하지 못했습니다.`;
    const lines = [];
    const err = json.error;
    if (err && (err.message || err.type)) lines.push(typeof err === 'string' ? err : (err.message || err.type));
    else if (typeof err === 'string') lines.push(err);
    const ne = json.node_errors || {};
    const nodeErrs = [];
    Object.keys(ne).slice(0, 8).forEach(id => {
        const e = ne[id] || {};
        (e.errors || []).slice(0, 2).forEach(er => {
            nodeErrs.push({ type: er.type });
            lines.push(`노드 #${id} (${e.class_type || '?'}): ${er.message}${er.details ? ' — ' + er.details : ''}`);
        });
    });
    if (typeof amDiagPromptRejectHint === 'function') {
        const hint = amDiagPromptRejectHint({ type: err && err.type, nodeErrors: nodeErrs });
        if (hint) lines.push('→ ' + hint);
    }
    return lines.length ? lines.join('\n') : `HTTP ${status}`;
}

/** 끝난 프롬프트의 결과 이미지 목록 (/history). 아직 기록 전이면 조금씩 기다리며 다시 확인 */
async function wfFetchHistoryImages(pid, tries) {
    for (let t = 0; t < (tries || 4); t++) {
        try {
            const res = await fetch(`/history/${encodeURIComponent(pid)}`, { __amDiagSilent: true, cache: 'no-store' });
            if (res.ok) {
                const json = await res.json();
                const entry = json && json[pid];
                if (entry && entry.outputs) {
                    const images = [];
                    Object.entries(entry.outputs).forEach(([nodeId, out]) => (out.images || []).forEach(img => images.push({ ...img, nodeId })));
                    images.sort((a, b) => (a.type === 'output' ? 0 : 1) - (b.type === 'output' ? 0 : 1));
                    return { found: true, images };
                }
            }
        } catch (e) { /* 다음 시도 */ }
        await buSleep(400);
    }
    return { found: false, images: [] };
}

/** 한 프롬프트가 끝날 때까지 기다린다 (웹소켓 이벤트 + /history 확인을 같이 씀). 반환: {ok, error?, interrupted?} */
function wfWaitForPrompt(pid, onProgress) {
    return new Promise(resolve => {
        let done = false, pollTimer = null, abortTimer = null, timeoutTimer = null;
        const ws = window.ws;
        const finish = (r) => {
            if (done) return; done = true;
            clearInterval(pollTimer); clearInterval(abortTimer); clearTimeout(timeoutTimer);
            if (ws && ws.removeEventListener) ws.removeEventListener('message', onMsg);
            resolve(r);
        };
        const onMsg = (ev) => {
            if (typeof ev.data !== 'string') { // 미리보기 프레임
                if (ev.data instanceof ArrayBuffer && ev.data.byteLength > 8) {
                    const dv = new DataView(ev.data);
                    if (dv.getUint32(0) === 1) {
                        const blob = new Blob([ev.data.slice(8)], { type: dv.getUint32(4) === 2 ? 'image/png' : 'image/jpeg' });
                        const url = URL.createObjectURL(blob);
                        const img = document.getElementById('wfrun-preview');
                        if (img) { img.src = url; img.style.display = 'block'; }
                        if (wfState.previewUrl) URL.revokeObjectURL(wfState.previewUrl);
                        wfState.previewUrl = url;
                    }
                }
                return;
            }
            let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
            const d = m.data || {};
            if (d.prompt_id && d.prompt_id !== pid) return; // 다른 프롬프트의 이벤트는 무시
            if (m.type === 'executing') {
                if (d.node === null && d.prompt_id === pid) finish({ ok: true });
                else if (d.node) onProgress && onProgress({ node: d.node });
            } else if (m.type === 'progress') onProgress && onProgress({ node: d.node, value: d.value, max: d.max });
            else if (m.type === 'execution_success') finish({ ok: true });
            else if (m.type === 'execution_error') finish({ ok: false, error: `노드 #${d.node_id} (${d.node_type}) 실행 오류: ${d.exception_message || d.exception_type || ''}`.trim() });
            else if (m.type === 'execution_interrupted') finish({ ok: false, interrupted: true, error: '중지되었습니다.' });
        };
        if (ws && ws.addEventListener) ws.addEventListener('message', onMsg);
        // 웹소켓 이벤트를 놓쳐도 끝나도록 /history도 주기적으로 확인
        pollTimer = setInterval(async () => {
            try {
                const res = await fetch(`/history/${encodeURIComponent(pid)}`, { __amDiagSilent: true, cache: 'no-store' });
                if (!res.ok) return;
                const json = await res.json();
                const st = json && json[pid] && json[pid].status;
                if (st && st.completed) finish({ ok: true });
                else if (st && st.status_str === 'error') finish({ ok: false, error: 'ComfyUI가 실행 중 오류로 끝냈다고 기록했습니다.' });
            } catch (e) { /* 다음 주기에 다시 */ }
        }, WF_POLL_MS);
        abortTimer = setInterval(() => { if (wfState.abort) finish({ ok: false, interrupted: true, error: '중지되었습니다.' }); }, 150);
        timeoutTimer = setTimeout(() => finish({ ok: false, error: '시간 초과: 응답이 없어 기다리기를 멈췄습니다. ComfyUI 상태를 확인하세요.' }), WF_TIMEOUT_MS);
    });
}

/** 프롬프트 한 번 제출 + 끝날 때까지 대기 + 결과 이미지 수집. 반환: {ok, images, error, interrupted} */
async function wfRunOnce(promptObj, onProgress) {
    let res, text;
    try {
        res = await fetch('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: promptObj, client_id: window.clientId }) });
        text = await res.text();
    } catch (e) { return { ok: false, error: `ComfyUI에 연결하지 못했습니다: ${e && e.message || e}` }; }
    let json = null; try { json = JSON.parse(text); } catch (e) { /* 아래에서 처리 */ }
    if (!res.ok) return { ok: false, error: wfFormatPromptError(json, res.status), rejected: true };
    const pid = json && json.prompt_id;
    if (!pid) return { ok: false, error: '전송은 됐지만 prompt_id를 받지 못했습니다.' };
    const waited = await wfWaitForPrompt(pid, onProgress);
    if (!waited.ok) return { ok: false, error: waited.error, interrupted: waited.interrupted };
    const hist = await wfFetchHistoryImages(pid);
    return { ok: true, images: hist.images, pid };
}

function wfAddResults(images) {
    const box = document.getElementById('wfrun-results');
    if (!box) return;
    if (box.dataset.empty !== '0') { box.innerHTML = ''; box.dataset.empty = '0'; }
    images.forEach(img => {
        const sub = String(img.subfolder || '').replace(/\\/g, '/');
        const url = `/view?filename=${encodeURIComponent(img.filename)}&type=${encodeURIComponent(img.type || 'output')}&subfolder=${encodeURIComponent(sub)}&t=${Date.now()}`;
        const a = document.createElement('a');
        a.href = url; a.target = '_blank'; a.title = `${img.filename} (${img.type || 'output'}) — 클릭하면 크게 보기`;
        a.style.cssText = 'display:block; width:150px;';
        const im = document.createElement('img');
        im.src = url; im.style.cssText = 'width:150px; height:150px; object-fit:cover; border-radius:6px; border:1px solid #444;';
        a.appendChild(im); box.appendChild(a);
        if (typeof addHistoryItemToPanel === 'function') { try { addHistoryItemToPanel(img, ''); } catch (e) { /* 히스토리 추가 실패가 결과 표시를 막으면 안 됨 */ } }
    });
}

async function wfRunAll() {
    const busy = wfBusyReason();
    if (busy) { alert(busy); return; }
    if (!wfState.prompt) { alert('먼저 워크플로우가 들어 있는 이미지(또는 API 형식 .json)를 넣어주세요.'); return; }
    const D = window.amDiag;
    if (D && D.state.exec.startedAt && !D.state.exec.finishedAt && !confirm('ComfyUI가 다른 작업을 실행 중인 것 같습니다. 그래도 이 워크플로우를 실행할까요? (앞선 작업이 끝나면 이어서 실행됩니다)')) return;
    const sus = (wfState.summary && wfState.summary.suspicious) || [];
    if (sus.length && !confirm(`⚠️ 이 워크플로우에는 임의의 코드를 실행할 수 있어 보이는 노드가 있습니다:\n\n${sus.map(s => `· #${s.id} ${s.classType}`).join('\n')}\n\n출처를 믿을 수 있을 때만 실행하세요. 그래도 실행할까요?`)) return;

    const count = Math.max(1, Math.min(20, parseInt(document.getElementById('wfrun-count')?.value || '1', 10) || 1));
    const seedRandom = !!document.getElementById('wfrun-seed-random')?.checked;
    const edits = {};
    document.querySelectorAll('#wfrun-prompts .wfrun-prompt-edit').forEach(t => { edits[t.dataset.nodeId] = t.value; });

    wfState.running = true; wfState.abort = false;
    const runBtn = document.getElementById('wfrun-run-btn'), stopBtn = document.getElementById('wfrun-stop-btn');
    if (runBtn) runBtn.disabled = true; if (stopBtn) stopBtn.disabled = false;
    const prevFlag = window.isStandaloneExecution, prevMap = window.globalNodeTitleMap;
    window.isStandaloneExecution = true;                                // 생성 탭 UI/노드 로그를 건드리지 않게 (단독 검열기와 같은 방식)
    window.globalNodeTitleMap = wfTitleMap(wfState.prompt);             // 진단/로그에 남의 노드가 이 앱의 노드 이름으로 보이지 않게
    const titles = window.globalNodeTitleMap;
    let okRuns = 0, total = 0;
    try {
        for (let i = 0; i < count; i++) {
            if (wfState.abort) break;
            const p = JSON.parse(JSON.stringify(wfState.prompt));
            Object.entries(edits).forEach(([id, text]) => { if (p[id] && p[id].inputs && typeof p[id].inputs.text === 'string') p[id].inputs.text = text; });
            Object.entries(wfState.fieldOverrides).forEach(([k, val]) => {
                const idx = k.indexOf('::'); if (idx < 0) return;
                const id = k.slice(0, idx), key = k.slice(idx + 2);
                if (p[id] && p[id].inputs) p[id].inputs[key] = val;
            });
            if (seedRandom) wfRandomizeSeeds(p);
            wfSay(`[${i + 1}/${count}] ComfyUI에 보내는 중…`, '#FF9800');
            const r = await wfRunOnce(p, (pg) => {
                const name = pg.node ? (titles[pg.node] || `#${pg.node}`) : '';
                wfSay(`[${i + 1}/${count}] 🔄 ${name}${pg.max ? ` ${pg.value}/${pg.max}` : ''}`, '#FF9800');
            });
            if (r.ok) {
                okRuns++; total += r.images.length;
                if (r.images.length) wfAddResults(r.images);
                else wfSay(`[${i + 1}/${count}] 끝났지만 출력 이미지가 없습니다. (같은 그래프라 캐시된 결과이거나, 이미지를 저장/미리보기하는 노드가 없는 워크플로우일 수 있어요. "시드 랜덤"을 켜면 매번 새로 뽑습니다.)`, '#FFB74D');
            } else {
                wfSay(`${r.interrupted ? '⏹' : '❌'} [${i + 1}/${count}] ${r.error}`, r.interrupted ? '#FFB74D' : '#ef5350');
                if (!r.interrupted && r.rejected) wfShowRejected(r.error);
                break;
            }
        }
        if (okRuns > 0 && !wfState.abort && okRuns === count && total > 0) wfSay(`✅ 완료 — ${okRuns}번 실행, 이미지 ${total}장 (오른쪽 히스토리에도 추가됨)`, '#4CAF50');
        else if (okRuns > 0 && wfState.abort) wfSay(`⏹ 중지됨 — ${okRuns}번 실행, 이미지 ${total}장`, '#FFB74D');
    } catch (e) {
        wfSay(`❌ 예기치 못한 오류: ${e && e.message || e}`, '#ef5350');
    } finally {
        window.isStandaloneExecution = !!prevFlag;
        window.globalNodeTitleMap = prevMap;
        wfState.running = false; wfState.abort = false;
        if (runBtn) runBtn.disabled = false; if (stopBtn) stopBtn.disabled = true;
    }
}
function wfShowRejected(text) {
    const box = document.getElementById('wfrun-errors');
    if (!box) return;
    box.style.display = 'block';
    box.textContent = text;
}
async function wfStop() {
    if (!wfState.running) return;
    wfState.abort = true;
    wfSay('⏹ 중지하는 중…', '#FFB74D');
    try { await fetch('/interrupt', { method: 'POST', __amDiagSilent: true }); } catch (e) { /* 이미 끝났거나 연결 문제 — abort 플래그로 대기는 풀림 */ }
}

/** 파일을 읽어서 화면에 요약/프롬프트 칸/사전 점검 결과를 채운다 */
async function wfLoadFile(file) {
    const token = ++wfState.loadToken;
    wfState.prompt = null; wfState.summary = null; wfState.fileName = file.name || ''; wfState.fieldOverrides = {};
    const info = document.getElementById('wfrun-info'), promptsBox = document.getElementById('wfrun-prompts'), err = document.getElementById('wfrun-errors');
    if (err) { err.style.display = 'none'; err.textContent = ''; }
    if (promptsBox) promptsBox.innerHTML = '';
    if (info) { info.style.display = 'block'; info.innerHTML = '<span style="color:#aaa;">⏳ 읽는 중…</span>'; }
    let ex;
    try { ex = await wfExtractFromFile(file); }
    catch (e) { if (info) info.innerHTML = `<span style="color:#ef5350;">❌ 파일을 읽지 못했습니다: ${wfEsc(e && e.message || e)}</span>`; return; }
    if (token !== wfState.loadToken) return;
    if (ex.status !== 'ok') {
        const msg = ex.status === 'workflow-only'
            ? '이 파일에는 편집기용 워크플로우만 있고, 바로 실행할 수 있는 <b>API 형식(prompt)</b>이 없습니다.<br>ComfyUI에서 그 워크플로우를 열고 <b>Workflow → Export (API)</b>로 저장한 .json을 넣거나, ComfyUI에서 직접 실행해 주세요.'
            : '워크플로우 정보를 찾지 못했습니다. ComfyUI가 만든 PNG/WebP가 아니거나, 메타데이터가 지워진 이미지일 수 있어요. (A1111 같은 다른 프로그램의 프롬프트 정보는 실행할 수 없습니다)';
        if (info) info.innerHTML = `<div style="color:#FFB74D;">⚠️ ${wfEsc(wfState.fileName)}<br>${msg}</div>`;
        return;
    }
    wfState.prompt = ex.prompt;
    const S = wfState.summary = wfSummarize(ex.prompt);
    const isImage = /\.(png|webp|jpe?g)$/i.test(wfState.fileName);
    let thumb = '';
    if (isImage && typeof URL !== 'undefined' && URL.createObjectURL) { try { thumb = URL.createObjectURL(file); } catch (e) { thumb = ''; } }
    const sampler = S.samplers[0];
    const lines = [
        `<b>${wfEsc(wfState.fileName)}</b> — 노드 ${S.nodeCount}개`,
        S.size ? `크기 ${S.size[0]}×${S.size[1]}` : '',
        sampler ? `샘플러 ${wfEsc(sampler.sampler || '?')} · steps ${wfEsc(sampler.steps ?? '?')} · cfg ${wfEsc(sampler.cfg ?? '?')}` : ''
    ].filter(Boolean);
    if (info) {
        info.innerHTML = `<div style="display:flex; gap:12px; align-items:flex-start;">${thumb ? `<img src="${thumb}" style="width:96px; height:96px; object-fit:cover; border-radius:6px; border:1px solid #444;">` : ''}
            <div style="flex:1; font-size:0.88em; line-height:1.6;">${lines.join('<br>')}
            <div id="wfrun-models" style="margin-top:4px;">${S.models.map(m => `<div data-model="${wfEsc(m.value)}" data-key="${wfEsc(m.key)}">📦 ${wfEsc(m.value)} <span style="color:#888;">(${wfEsc(m.key)})</span></div>`).join('')}</div>
            <div id="wfrun-warn" style="margin-top:6px;"><span style="color:#aaa;">🔍 이 ComfyUI에 필요한 노드/모델이 있는지 확인 중…</span></div></div></div>`;
    }
    if (promptsBox && S.prompts.length) {
        promptsBox.innerHTML = `<div style="font-size:0.85em; color:#aaa; margin:8px 0 4px;">✏️ 프롬프트 (고치면 이 내용으로 실행)</div>` + S.prompts.map(p =>
            `<div style="margin-bottom:6px;"><div style="font-size:0.78em; color:#888;">#${wfEsc(p.id)} ${wfEsc(p.title)}</div><textarea class="wfrun-prompt-edit" data-node-id="${wfEsc(p.id)}" rows="3" style="width:100%; box-sizing:border-box; background:#222; border:1px solid #555; color:#fff; border-radius:4px; padding:6px; resize:vertical;">${wfEsc(p.text)}</textarea></div>`).join('');
    }
    // 사전 점검 (막지는 않고 알려주기만)
    const pf = await wfPreflight(ex.prompt);
    if (token !== wfState.loadToken) return;
    const warn = document.getElementById('wfrun-warn');
    const parts = [];
    if (pf.missingNodes.length) parts.push(`<div style="color:#ef5350;">❌ 이 ComfyUI에 없는 노드: ${pf.missingNodes.map(wfEsc).join(', ')}<br><span style="color:#aaa;">커스텀 노드를 설치해야 실행됩니다.</span></div>`);
    if (pf.missingValues.length) {
        parts.push(`<div style="color:#ef5350;">❌ 없는 파일/값:<br>${pf.missingValues.slice(0, 12).map(v => `· #${wfEsc(v.id)} ${wfEsc(v.classType)} — ${wfEsc(v.key)} = ${wfEsc(v.value)}`).join('<br>')}${pf.missingValues.length > 12 ? `<br>… 외 ${pf.missingValues.length - 12}건` : ''}<br><span style="color:#aaa;">해당 모델 파일을 설치하거나, ComfyUI에서 다른 파일로 바꿔야 실행됩니다.</span></div>`);
        pf.missingValues.forEach(v => document.querySelectorAll('#wfrun-models [data-model]').forEach(el => { if (el.dataset.model === v.value && el.dataset.key === v.key) el.style.color = '#ef5350'; }));
    }
    if (pf.failed) parts.push(`<div style="color:#FFB74D;">⚠️ 일부 노드는 서버에 물어보지 못해 점검하지 못했습니다.</div>`);
    if (S.suspicious.length) parts.push(`<div style="color:#FFB74D;">⚠️ 코드를 실행할 수 있어 보이는 노드: ${S.suspicious.map(s => wfEsc(s.classType)).join(', ')} — 출처를 믿을 때만 실행하세요.</div>`);
    if (!parts.length) parts.push(`<div style="color:#4CAF50;">✅ 필요한 노드와 모델 파일이 모두 있습니다.</div>`);
    if (warn) warn.innerHTML = parts.join('');
    wfRenderComboFields(pf.comboFields);
}

function ensureWfRunUI() {
    const root = document.getElementById('wfrun-root');
    if (!root) return null;
    if (root.dataset.ready === '1') return root;
    root.dataset.ready = '1';
    root.innerHTML = `
        <h2 style="margin:0 0 6px;">🧩 워크플로우 이미지 실행</h2>
        <p style="color:#aaa; margin:0 0 12px; font-size:0.9em;">
            다른 사람이 만든 ComfyUI <b>워크플로우가 들어 있는 이미지</b>(PNG/WebP, 또는 API 형식 .json)를 넣으면 그 워크플로우를 그대로 이 ComfyUI에서 실행해 결과를 뽑습니다.
            없는 노드/모델은 미리 알려주고, 프롬프트는 고쳐서 실행할 수 있어요.
        </p>
        <div id="wfrun-drop" style="border:2px dashed #555; border-radius:10px; padding:26px; text-align:center; color:#888; cursor:pointer;">
            📂 워크플로우가 들어 있는 이미지를 여기에 끌어다 놓거나 클릭해서 선택
            <input type="file" id="wfrun-file" accept="image/*,.json,application/json" style="display:none;">
        </div>
        <div id="wfrun-info" style="display:none; margin-top:12px; background:#1a1a1a; border:1px solid #333; border-radius:8px; padding:10px;"></div>
        <div id="wfrun-combos" style="display:none; margin-top:10px; background:#1a1a1a; border:1px solid #333; border-radius:8px; padding:10px;"></div>
        <div id="wfrun-prompts"></div>
        <div id="wfrun-errors" style="display:none; margin-top:10px; white-space:pre-wrap; background:#2a1a1a; border:1px solid #6a2a2a; color:#ffb3b3; border-radius:8px; padding:10px; font-size:0.85em;"></div>
        <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-top:12px;">
            <label style="font-size:0.9em; cursor:pointer;"><input type="checkbox" id="wfrun-seed-random" checked> 시드 랜덤 (매번 새로 뽑기)</label>
            <label style="font-size:0.9em;">횟수 <input type="number" id="wfrun-count" value="1" min="1" max="20" style="width:64px; background:#222; border:1px solid #555; color:#fff; border-radius:4px; padding:4px;"></label>
            <button id="wfrun-run-btn" class="btn-primary" style="padding:8px 18px;">▶ 실행</button>
            <button id="wfrun-stop-btn" class="btn-secondary" style="padding:8px 14px;" disabled>⏹ 중지</button>
        </div>
        <div id="wfrun-status" style="margin-top:10px; font-size:0.9em; min-height:1.3em;"></div>
        <img id="wfrun-preview" style="display:none; max-width:320px; max-height:320px; margin-top:8px; border-radius:8px; border:1px solid #444;">
        <div id="wfrun-results" data-empty="1" style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;"><span style="color:#666; font-size:0.85em;">결과 이미지가 여기에 쌓입니다.</span></div>`;
    const drop = document.getElementById('wfrun-drop'), input = document.getElementById('wfrun-file');
    drop.onclick = () => input.click();
    input.onchange = () => { if (input.files && input.files[0]) wfLoadFile(input.files[0]); input.value = ''; };
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor = '#4a90d9'; });
    drop.addEventListener('dragleave', () => { drop.style.borderColor = '#555'; });
    drop.addEventListener('drop', e => { e.preventDefault(); drop.style.borderColor = '#555'; const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) wfLoadFile(f); });
    document.getElementById('wfrun-run-btn').onclick = wfRunAll;
    document.getElementById('wfrun-stop-btn').onclick = wfStop;
    return root;
}
function renderWfRunTool() { ensureWfRunUI(); }
window.renderWfRunTool = renderWfRunTool;
