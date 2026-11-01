/**
 * outfit_set_wizard.js — 🆕 "🎭 의상 세트 일괄 만들기" 마법사 (칩 기반 조각 편집기)
 *
 * 목적: 프롬프트 라이브러리의 "그룹" 안에 조각(의상 등)을 여러 개 쉽게 만들고 관리하기 위한
 * 도구. 대기열/생성과는 무관 — 만들어진 조각은 평소처럼 라이브러리에서 선택해서 쓰면 된다.
 *
 * 핵심 규칙:
 *   - 의상(조각)은 "칩" 여러 개로 구성된다(예: [하얀 티셔츠][검은 바지]).
 *   - 칩 클릭 = 선택(아래 색상/품질 버튼의 적용 대상). 다시 클릭하면 선택 해제.
 *   - 색상 버튼(10개): 선택된 칩이 있으면 그 칩 안의 알려진 색상 단어만 교체(없으면 맨 앞에
 *     추가), 나머지 글자는 안 건드림. 선택된 칩이 없으면 그 색 이름만 담은 새 칩을 추가.
 *   - 품질 버튼(14종): 선택된 칩 맨 앞에 추가(누적 가능). [품질] 버튼을 누르면 색상 버튼
 *     10개가 품질 버튼들로 통째로 바뀌고 버튼 자체는 [색상]으로 바뀜 — 다시 누르면 원복.
 *   - 칩 우클릭 = 비활성화 토글(최종 프롬프트에서 제외, 목록엔 남음). ◀▶ = 순서 변경.
 *   - "+추가"(직접 입력), "🎲 랜덤 색상 조각", "🧩 기존 조각에서 선택"(라이브러리의 다른
 *     조각을 그대로 새 칩으로 가져옴 — 이 의상에만 적용, 다른 의상엔 영향 없음).
 *   - 의상은 여러 벌 만들 수 있다("+ 의상 추가"). 각 의상은 서로 완전히 독립.
 *   - 저장할 그룹은 기존 그룹 중에서 고르거나("작품" 구분 없이 그룹 이름만 나열), 새 그룹을
 *     만들 수 있다.
 *   - 제출하면 칩이 하나 이상 있는 의상마다 그룹 안에 조각 하나씩 생성된다.
 */

(function () {
    "use strict";

    // 🆕 label은 버튼에 보여주는 한글 표시용, enWord는 실제로 프롬프트 칩에 삽입되는 영문 태그
    // (danbooru 계열 프롬프트는 보통 영문이라서 — "빨강"이 그대로 들어가면 태그로 인식이 안 됨)
    const COLOR_BUTTONS = [
        { key: 'red', label: '빨강', enWord: 'red', swatch: '#e53935', synonyms: ['빨간색', '빨간', '빨강', '적색', '레드', 'red'] },
        { key: 'blue', label: '파랑', enWord: 'blue', swatch: '#1e88e5', synonyms: ['파란색', '파란', '파랑', '청색', '블루', 'blue'] },
        { key: 'green', label: '초록', enWord: 'green', swatch: '#43a047', synonyms: ['초록색', '초록', '녹색', '그린', 'green'] },
        { key: 'black', label: '검정', enWord: 'black', swatch: '#222222', synonyms: ['검은색', '검은', '까만', '검정', '흑색', '블랙', 'black'] },
        { key: 'yellow', label: '노랑', enWord: 'yellow', swatch: '#fdd835', synonyms: ['노란색', '노란', '노랑', '황색', '옐로우', 'yellow'] },
        { key: 'white', label: '하양', enWord: 'white', swatch: '#f5f5f5', synonyms: ['하얀색', '하얀', '흰색', '백색', '하양', '화이트', 'white'] },
        { key: 'purple', label: '보라', enWord: 'purple', swatch: '#8e24aa', synonyms: ['보라색', '보라', '자주색', '퍼플', 'purple'] },
        { key: 'pink', label: '분홍', enWord: 'pink', swatch: '#ec407a', synonyms: ['분홍색', '분홍', '핑크', 'pink'] },
        { key: 'orange', label: '주황', enWord: 'orange', swatch: '#fb8c00', synonyms: ['주황색', '주황', '오렌지색', '오렌지', 'orange'] },
        { key: 'brown', label: '갈색', enWord: 'brown', swatch: '#6d4c41', synonyms: ['갈색', '브라운', 'brown'] },
    ];
    const QUALITY_WORDS = ['light', 'dark', 'pale', 'deep', 'vibrant', 'bright', 'muted', 'neon', 'pastel', 'metallic', 'glossy', 'matte', 'translucent', 'sheer'];
    const NEW_GROUP_OPTION_VALUE = '__new_group__';

    // 🆕 "+ 색상" = 프롬프트에 바로 적용하는 게 아니라, 팔레트 자체에 새 색상 버튼을 추가하는 기능.
    // 모든 의상이 공유하고, 브라우저에 영구 저장돼서 다음에 열어도 그대로 남아있음.
    const CUSTOM_COLORS_KEY = 'outfitWizardCustomColors';
    let customColorButtons = [];
    try {
        const raw = JSON.parse(localStorage.getItem(CUSTOM_COLORS_KEY) || '[]');
        if (Array.isArray(raw)) customColorButtons = raw;
    } catch (e) { /* 손상된 데이터는 무시하고 빈 팔레트로 시작 */ }

    function saveCustomColors() {
        try { localStorage.setItem(CUSTOM_COLORS_KEY, JSON.stringify(customColorButtons)); } catch (e) { /* 무시 */ }
    }

    /** 기본 10색 + 사용자가 추가한 커스텀 색상을 합쳐서 반환(항상 이걸로 팔레트/매칭에 사용) */
    function getAllColorButtons() { return COLOR_BUTTONS.concat(customColorButtons); }
    function getAllColorSynonyms() { return getAllColorButtons().flatMap(c => c.synonyms).sort((a, b) => b.length - a.length); }

    let outfitSeq = 0, chipSeq = 0;
    let outfitRows = [];
    let fragmentPickerTargetOutfitId = null;
    let sharedActionRefs = []; // [{catId, itemId}] — 🆕 "기본" 행동: 전용(outfit.extraActionRefs)과 달리 모든 의상에 공통 적용
    const SHARED_ACTION_TARGET = '__shared__';

    /* ──────────────────────────────────────────────
       작은 유틸
       ────────────────────────────────────────────── */
    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    function newChip(text) { return { id: 'chip_' + (chipSeq++), text: text || '', disabled: false }; }
    function newOutfitRow(name) {
        // comboItemIds: "조각 만들기"를 이미 눌러서 만든 적 있는 실제 라이브러리 조각들의 id 기억.
        // key는 행동 조각 ref('catId::itemId') 또는 행동이 없을 때는 '__none__'. 다음에 또
        // "조각 만들기"를 누르면(예: 색만 바꾸고 다시) 새로 만들지 않고 이 id의 조각을 업데이트한다.
        // pendingText: 아직 콤마/Enter로 칩 확정 안 되고 입력창에 타이핑만 돼있던 글자.
        // 🐛 이걸 안 챙겨서 새로고침하면 "방금 타이핑하던 것"이 통째로 사라지는 버그가 있었음 — 수정.
        return { id: 'outfit_' + (outfitSeq++), customName: name || '', mode: 'color', selectedChipId: null, chips: [], extraActionRefs: [], excludedSharedRefs: [], quickColorChipId: null, comboItemIds: {}, pendingText: '' };
    }
    function buildOutfitPromptText(outfit) {
        return outfit.chips.filter(c => !c.disabled && c.text.trim()).map(c => c.text.trim()).join(', ');
    }

    /** 이 의상 전용 행동 조각들을 "(이름x)" 형태의 초소형 인라인 표기로 렌더링 + 맨 끝에 빈 "( )" 추가 슬롯 */
    function extraActionTagsHtml(outfit) {
        const cats = (typeof getAllCategories === 'function') ? getAllCategories() : [];
        const tags = outfit.extraActionRefs.map(ref => {
            const cat = cats.find(c => c.id === ref.catId);
            const item = cat && cat.items.find(i => i.id === ref.itemId);
            const label = item ? (item.name || '(이름없음)') : '(찾을 수 없음)';
            return `<span style="color:#9ad29a; font-size:0.86em; white-space:nowrap;">(${escapeHtml(label)}<span onclick="removeExtraActionRef('${outfit.id}','${ref.catId}','${ref.itemId}')" title="제거" style="cursor:pointer; color:#e57373; margin-left:1px;">x</span>)</span>`;
        }).join('');
        const addSlot = `<span onclick="openActionPickerFor('${outfit.id}')" title="이 의상 전용 행동 추가" style="cursor:pointer; color:#555; font-size:0.86em;">( )</span>`;
        return tags + addSlot;
    }

    function removeExtraActionRef(outfitId, catId, itemId) {
        const outfit = outfitRows.find(o => o.id === outfitId);
        if (!outfit) return;
        outfit.extraActionRefs = outfit.extraActionRefs.filter(r => !(r.catId === catId && r.itemId === itemId));
        renderOutfitRows();
    }
    window.removeExtraActionRef = removeExtraActionRef;

    /** 🆕 "기본" 행동(모든 의상 공유) 목록을 같은 "(이름x)" 방식으로 렌더링 + 빈 "( )" 추가 슬롯 */
    function sharedActionTagsHtml() {
        const cats = (typeof getAllCategories === 'function') ? getAllCategories() : [];
        const tags = sharedActionRefs.map(ref => {
            const cat = cats.find(c => c.id === ref.catId);
            const item = cat && cat.items.find(i => i.id === ref.itemId);
            const label = item ? (item.name || '(이름없음)') : '(찾을 수 없음)';
            return `<span style="color:#9ad2d2; font-size:0.86em; white-space:nowrap;">(${escapeHtml(label)}<span onclick="removeSharedActionRef('${ref.catId}','${ref.itemId}')" title="제거" style="cursor:pointer; color:#e57373; margin-left:1px;">x</span>)</span>`;
        }).join('');
        const addSlot = `<span onclick="openSharedActionPicker()" title="모든 의상에 적용되는 기본 행동 추가" style="cursor:pointer; color:#555; font-size:0.86em;">( )</span>`;
        return tags + addSlot;
    }

    function removeSharedActionRef(catId, itemId) {
        sharedActionRefs = sharedActionRefs.filter(r => !(r.catId === catId && r.itemId === itemId));
        renderOutfitRows();
    }
    window.removeSharedActionRef = removeSharedActionRef;

    function openSharedActionPicker() {
        fragmentPickerTargetOutfitId = SHARED_ACTION_TARGET;
        fragmentPickerMode = 'action';
        ensureFragmentPicker();
        document.getElementById('outfit-fragment-picker-title').textContent = '🏃 기본 행동 추가 (모든 의상 공유)';
        populateFragmentGroupSelect();
        document.getElementById('outfit-fragment-search').value = '';
        renderFragmentPickerList();
        document.getElementById('outfit-fragment-picker').style.display = 'flex';
    }
    window.openSharedActionPicker = openSharedActionPicker;

    /* ──────────────────────────────────────────────
       🆕 영구 저장 — 이 마법사는 "한 번 쓰고 끝"이 아니라 계속 다시 열어서 의상에 행동을
       추가하거나 색을 바꾸는 용도라서, 닫았다 열어도 전부 그대로 남아있어야 한다.
       (서버 동기화 없이 이 브라우저의 localStorage에만 저장 — 조각 자체는 "조각 만들기"를
       눌러야 실제 라이브러리에 반영됨. 이건 "아직 제출 전인 작업 중 상태"를 기억하는 것.)
       ────────────────────────────────────────────── */
    const WIZARD_STATE_KEY = 'outfitSetWizardState';

    window.saveWizardState = () => saveWizardState(); // 새 그룹 이름 입력칸의 oninput="saveWizardState()"용(인라인 핸들러는 전역 스코프에서 실행됨)
    function saveWizardState() {
        try {
            const payload = JSON.stringify({
                outfitRows,
                sharedActionRefs,
                groupSelectValue: document.getElementById('outfit-set-group-select')?.value || '',
                newGroupName: document.getElementById('outfit-set-new-group-name')?.value || '',
            });
            localStorage.setItem(WIZARD_STATE_KEY, payload);
            // 🔍 진단용 — 저장이 실제로 되는지, 뭐가 저장되는지 콘솔에서 바로 확인 가능하게.
            // 문제가 계속되면 F12 → Console에서 "[의상에셋매니저] 저장됨" 로그가 실제로 찍히는지,
            // 그리고 localStorage.getItem('outfitSetWizardState')를 직접 쳐서 값이 있는지 확인해주세요.
            console.log('[의상에셋매니저] 저장됨:', outfitRows.length, '개 의상,', payload.length, 'bytes');
        } catch (e) {
            console.error('[의상에셋매니저] 저장 실패!', e);
        }
    }

    function loadWizardState() {
        try {
            const stored = localStorage.getItem(WIZARD_STATE_KEY);
            console.log('[의상에셋매니저] 복원 시도 — localStorage 원본:', stored ? `${stored.length} bytes` : '(없음/null)');
            const raw = JSON.parse(stored || 'null');
            if (!raw || !Array.isArray(raw.outfitRows) || raw.outfitRows.length === 0) {
                console.log('[의상에셋매니저] 복원할 데이터 없음 — 빈 상태로 시작');
                return null;
            }
            console.log('[의상에셋매니저] 복원됨:', raw.outfitRows.length, '개 의상');
            return raw;
        } catch (e) {
            console.error('[의상에셋매니저] 복원 실패!', e);
            return null;
        }
    }

    /* ──────────────────────────────────────────────
       버튼 삽입 (➕ 새 조각 옆)
       ────────────────────────────────────────────── */
    function ensureOutfitSetButton() {
        if (document.getElementById('btn-outfit-set-wizard')) return;
        const addBtn = document.getElementById('btn-add-item');
        if (!addBtn || !addBtn.parentElement) return;
        const btn = document.createElement('button');
        btn.id = 'btn-outfit-set-wizard';
        btn.className = 'btn-secondary';
        btn.title = '의상(조각) 여러 개를 칩 형태로 쉽게 만들고, 수정하면 바로 반영됩니다';
        btn.style.cssText = 'padding:4px 10px; font-size:0.9em; margin-right:6px;';
        btn.textContent = '👗 의상에셋매니저';
        btn.onclick = openOutfitSetModal;
        addBtn.parentElement.insertBefore(btn, addBtn);
    }

    /* ──────────────────────────────────────────────
       그룹 선택 드롭다운(작품 구분 없이 그룹 이름만 나열) + 새 그룹 만들기
       ────────────────────────────────────────────── */
    let lastMainGroupSelectValue = null; // 🆕 '저장할 그룹' 선택을 기억 — 목록을 다시 그려도(innerHTML 교체는 브라우저가 항상 첫 옵션으로 리셋시킴) 유지되게

    function populateGroupSelect() {
        const select = document.getElementById('outfit-set-group-select');
        if (!select) return;
        const works = (typeof libraryData !== "undefined" && libraryData.works) || [];
        const options = [];
        works.forEach(work => {
            (work.categories || []).forEach(cat => options.push({ id: cat.id, label: cat.name, workName: work.name || '' }));
        });
        const nameCount = {};
        options.forEach(o => { nameCount[o.label] = (nameCount[o.label] || 0) + 1; });
        select.innerHTML = options.map(o =>
            `<option value="${o.id}">${escapeHtml(o.label)}${nameCount[o.label] > 1 ? ` (${escapeHtml(o.workName)})` : ''}</option>`
        ).join('') + `<option value="${NEW_GROUP_OPTION_VALUE}">➕ 새 그룹 만들기...</option>`;
        // innerHTML을 통째로 갈아끼우면 브라우저가 선택값을 첫 옵션으로 되돌리므로, 기억해둔 값으로 다시 맞춰줌
        if (lastMainGroupSelectValue && Array.from(select.options).some(opt => opt.value === lastMainGroupSelectValue)) {
            select.value = lastMainGroupSelectValue;
        }
        onGroupSelectChange();
    }
    window.populateGroupSelect = populateGroupSelect;

    function onGroupSelectChange() {
        const select = document.getElementById('outfit-set-group-select');
        const newGroupInput = document.getElementById('outfit-set-new-group-name');
        if (!select || !newGroupInput) return;
        lastMainGroupSelectValue = select.value || null;
        newGroupInput.style.display = (select.value === NEW_GROUP_OPTION_VALUE) ? 'block' : 'none';
        saveWizardState();
    }
    window.onGroupSelectChange = onGroupSelectChange;

    /* ──────────────────────────────────────────────
       메인 모달
       ────────────────────────────────────────────── */
    function ensureModal() {
        if (document.getElementById('outfit-set-modal')) return document.getElementById('outfit-set-modal');
        const overlay = document.createElement('div');
        overlay.id = 'outfit-set-modal';
        overlay.className = 'modal-overlay';
        overlay.style.display = 'none';
        overlay.onclick = closeOutfitSetModal;
        overlay.innerHTML = `
            <div class="modal-content" onclick="event.stopPropagation()" style="max-width:96vw; width:1400px;">
                <div class="modal-header">
                    <h3 style="margin:0; color:#4CAF50;">👗 의상에셋매니저</h3>
                    <button class="btn-secondary" style="padding:2px 10px;" onclick="closeOutfitSetModal()">✕</button>
                </div>
                <div style="padding:14px; max-height:72vh; overflow-y:auto;">
                    <p style="font-size:0.8em; color:#999; margin-top:0;">
                        의상(조각)을 여러 개 만들어서 한 그룹에 한꺼번에 저장합니다. 각 의상의 칩을
                        클릭해서 고른 다음 색상/품질 버튼을 누르면 그 칩만 바뀝니다(우클릭 = 비활성화).
                    </p>

                    <label style="display:block; margin-bottom:4px; font-weight:600;">저장할 그룹</label>
                    <select id="outfit-set-group-select" onchange="onGroupSelectChange()"
                        style="width:100%; box-sizing:border-box; padding:6px; margin-bottom:6px; background:#222; color:#fff; border:1px solid #555; border-radius:4px;"></select>
                    <input type="text" id="outfit-set-new-group-name" placeholder="새 그룹 이름 (예: 🎭 의상 세트)" oninput="saveWizardState()"
                        style="display:none; width:100%; box-sizing:border-box; padding:6px; margin-bottom:14px; background:#222; color:#fff; border:1px solid #555; border-radius:4px;">

                    <label style="display:block; margin-bottom:6px; font-weight:600;">👗 의상들</label>
                    <div id="outfit-set-outfits-container"></div>

                    <label style="display:block; margin:12px 0 4px; font-weight:600;">🏃 기본 행동 (모든 의상 공유)</label>
                    <div id="outfit-set-shared-actions"></div>
                </div>
                <div style="padding:10px 14px; border-top:1px solid #333; display:flex; justify-content:space-between; align-items:center; gap:8px;">
                    <span id="outfit-set-summary" style="font-size:0.8em; color:#888;"></span>
                    <div style="display:flex; gap:8px;">
                        <button class="btn-primary" onclick="closeOutfitSetModal()">닫기</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        return overlay;
    }

    function openOutfitSetModal() {
        const overlay = ensureModal();

        // 🐛 수정: populateGroupSelect()를 먼저 부르면, 그 안에서 onGroupSelectChange()가
        // saveWizardState()를 호출하는데 이게 아래 복원 코드보다 먼저 실행되는 바람에 아직 비어있는
        // outfitRows([])로 기존 저장분을 그 자리에서 덮어써버렸다(= 새로고침하면 날아가던 진짜 원인).
        // 그래서 데이터 복원을 populateGroupSelect()보다 반드시 먼저 하도록 순서를 바꿈.
        const saved = loadWizardState();
        if (saved) {
            outfitRows = saved.outfitRows.map(o => ({
                id: o.id, customName: o.customName || o.name || '', mode: o.mode || 'color',
                selectedChipId: null, // 선택 상태 자체는 굳이 복원 안 함(혼란 방지)
                chips: Array.isArray(o.chips) ? o.chips : [],
                extraActionRefs: Array.isArray(o.extraActionRefs) ? o.extraActionRefs : [],
                excludedSharedRefs: Array.isArray(o.excludedSharedRefs) ? o.excludedSharedRefs : [],
                quickColorChipId: o.quickColorChipId || null,
                comboItemIds: o.comboItemIds || {},
                pendingText: o.pendingText || '',
            }));
            sharedActionRefs = Array.isArray(saved.sharedActionRefs) ? saved.sharedActionRefs : [];
            outfitSeq = outfitRows.length; // 다음에 "+ 의상 추가"할 때 id가 안 겹치게
            chipSeq = outfitRows.reduce((max, o) => Math.max(max, ...o.chips.map(c => parseInt((c.id || '').replace('chip_', ''), 10) || 0), 0), 0) + 1;
        } else {
            outfitRows = [newOutfitRow(''), newOutfitRow('')];
            sharedActionRefs = [];
        }

        populateGroupSelect(); // outfitRows 복원이 끝난 뒤에 호출 — 이 안에서 saveWizardState()가 돌아도 이제 안전함

        if (saved) {
            const groupSelect = document.getElementById('outfit-set-group-select');
            if (groupSelect && saved.groupSelectValue && Array.from(groupSelect.options).some(opt => opt.value === saved.groupSelectValue)) {
                groupSelect.value = saved.groupSelectValue;
            }
            document.getElementById('outfit-set-new-group-name').value = saved.newGroupName || '';
            onGroupSelectChange();
        } else {
            document.getElementById('outfit-set-new-group-name').value = '';
        }

        renderOutfitRows();
        // 🆕 아직 칩으로 확정 안 됐던(콤마/Enter 전) 입력중 텍스트를 입력창에 되돌려놓음
        outfitRows.forEach(o => {
            if (!o.pendingText) return;
            const el = document.getElementById(`${o.id}_newchip`);
            if (el) el.value = o.pendingText;
        });
        overlay.style.display = 'flex';
    }
    window.openOutfitSetModal = openOutfitSetModal;

    function closeOutfitSetModal() {
        clearTimeout(syncDebounceTimer);
        syncOutfitsToLibrary(); // 🆕 따로 저장 버튼 안 눌러도, 닫을 때(바깥 클릭 포함) 바로 반영
        const overlay = document.getElementById('outfit-set-modal');
        if (overlay) overlay.style.display = 'none';
    }
    window.closeOutfitSetModal = closeOutfitSetModal;

    let lastSyncLabel = ''; // 🆕 자동 저장 상태 문구(동기화 성공/대상 그룹 없음 등)

    function updateOutfitSetSummary() {
        const el = document.getElementById('outfit-set-summary');
        if (!el) return;
        el.textContent = lastSyncLabel;
    }

    /* ──────────────────────────────────────────────
       의상 카드 렌더링
       ────────────────────────────────────────────── */
    function renderOutfitRows() {
        const wrap = document.getElementById('outfit-set-outfits-container');
        if (!wrap) return;
        wrap.innerHTML = outfitRows.map(outfit => renderOutfitLine(outfit)).join('')
            + `<div onclick="addOutfitRow()" style="cursor:pointer; color:#4CAF50; font-size:1.1em; padding:4px 0;" title="의상 추가">+</div>`;
        const sharedWrap = document.getElementById('outfit-set-shared-actions');
        if (sharedWrap) sharedWrap.innerHTML = sharedActionTagsHtml();
        updateOutfitSetSummary();
        saveWizardState(); // 🆕 칩 추가/삭제/색상변경/행동추가 등 모든 변경이 결국 이 함수를 거치므로 여기 한 곳에서 저장
        scheduleSync(); // 🆕 같은 이유로, 실제 라이브러리 조각 생성/수정도 여기서 디바운스로 예약
    }

    /** 편집을 멈추고 900ms 지나면 자동으로 라이브러리에 반영(타이핑 중엔 계속 미뤄짐). 닫을 때는 바로 flush. */
    let syncDebounceTimer = null;
    function scheduleSync() {
        clearTimeout(syncDebounceTimer);
        // 🆕 900ms → 350ms로 단축: 너무 길면 수정하고 바로 새로고침했을 때 서버에 반영되기 전에
        // 날아갈 수 있어서(디바운스 중이던 걸 못 기다림), 창을 닫거나 새로고침해도 어지간하면
        // 이미 저장이 끝나 있도록 짧게 줄임.
        syncDebounceTimer = setTimeout(() => syncOutfitsToLibrary(), 350);
    }

    // 🆕 새로고침/탭 닫기 직전에 디바운스를 기다리지 않고 바로 동기화 — "새로고침하면 날아간다" 문제의
    // 핵심 대응. (완전히 100% 보장은 안 되지만—브라우저가 비동기 저장 요청을 끝까지 안 기다려줄 수
    // 있음—그래도 디바운스 대기 없이 즉시 시도하는 것만으로 유실 가능성이 크게 줄어듦)
    window.addEventListener('beforeunload', () => {
        clearTimeout(syncDebounceTimer);
        syncOutfitsToLibrary();
    });

    /** 의상 한 벌 = 한 줄: [칩, 칩, ...입력칸](행동x)(행동x)( )
     *  칩을 클릭해서 선택했을 때만 바로 아래에 색상/품질 팔레트가 나타난다. */
    function renderOutfitLine(outfit) {
        const chipSpans = outfit.chips.map(chip => {
            const selected = chip.id === outfit.selectedChipId;
            const style = `cursor:pointer; ${selected ? 'color:#4CAF50; text-decoration:underline;' : 'color:#ddd;'} ${chip.disabled ? 'opacity:0.4; text-decoration:line-through;' : ''}`;
            return `<span id="chipspan_${chip.id}" onclick="selectOutfitChip('${outfit.id}','${chip.id}')"
                oncontextmenu="event.preventDefault(); toggleOutfitChipDisabled('${outfit.id}','${chip.id}')"
                title="클릭: 선택(색상/품질/수정 대상) · 우클릭: 비활성화" style="${style}">${escapeHtml(chip.text)}</span>`;
        });
        const chipsInline = chipSpans.join('<span style="color:#666;">,</span>');

        const selectedChip = outfit.chips.find(c => c.id === outfit.selectedChipId);
        const toolbar = selectedChip ? renderChipToolbar(outfit) : '';

        return `
        <div style="padding:5px 0; font-size:0.92em;">
            <input type="text" value="${escapeHtml(outfit.customName)}" placeholder="(이름=첫 칩)" title="이름을 적으면 이 이름으로 조각이 만들어지고, 이미 만들어진 조각도 자동으로 이름이 바뀝니다"
                oninput="renameOutfitLive('${outfit.id}', this.value)"
                style="width:90px; background:transparent; border:none; border-bottom:1px dashed #555; color:#9ad29a; font-size:0.86em; margin-right:4px; padding:0 1px;">
            <span style="color:#666;">[</span><span>${chipsInline}</span><input type="text" id="${outfit.id}_newchip" class="job-edit-frag"
                placeholder="${outfit.chips.length ? '' : '여기에 입력, 콤마로 구분'}"
                oninput="handleOutfitChipTyping('${outfit.id}', this)"
                onkeydown="if(event.key==='Enter' && !document.querySelector('.ko-ac-dropdown')){ event.preventDefault(); addOutfitChipFromInput('${outfit.id}'); }"
                style="background:transparent; border:none; outline:none; color:#fff; width:120px; font-size:0.95em; padding:0 2px;"><span style="color:#666;">]</span>
            ${extraActionTagsHtml(outfit)}
            <span onclick="toggleExcludePanel('${outfit.id}')" title="기본 행동 중 일부를 이 의상에서만 제외" style="cursor:pointer; color:#777; font-size:0.86em; margin-left:2px;">🚫</span>
            <span onclick="deleteOutfitAndItems('${outfit.id}')" title="이 의상과, 이걸로 만들어진 조각들 전부 삭제" style="cursor:pointer; color:#777; font-size:0.86em; margin-left:2px;">🗑</span>
            ${toolbar}
            ${excludePanelHtml(outfit)}
        </div>`;
    }

    /** 칩이 선택됐을 때만 나타나는 툴바 — 🆕 수정 입력창 + 색상/품질을 모드 전환 없이 한 줄에 전부 표시 + 원하는 색상 직접 추가 */
    function renderChipToolbar(outfit) {
        const selectedChip = outfit.chips.find(c => c.id === outfit.selectedChipId);
        const editInputHtml = selectedChip ? `<input type="text" value="${escapeHtml(selectedChip.text)}" class="job-edit-frag"
            oninput="editChipTextLive('${outfit.id}','${selectedChip.id}', this.value)"
            title="이 칩의 텍스트를 직접 수정(순서는 그대로 유지됨)"
            style="width:160px; background:#222; border:1px solid #555; color:#fff; border-radius:4px; padding:3px 6px; font-size:0.82em; margin:1px 8px 1px 0;">` : '';
        const colorBtns = getAllColorButtons().map(c => `<button onclick="applyOutfitColor('${outfit.id}','${c.key}')"
            oncontextmenu="event.preventDefault(); removeCustomColor('${c.key}')" title="${c.label}${c.key.startsWith('custom_') ? ' (우클릭: 팔레트에서 제거)' : ''}"
            style="width:20px; height:20px; border-radius:50%; margin:1px; border:1px solid #0007; background:${c.swatch}; cursor:pointer;"></button>`).join('');
        const randomColorBtn = `<button onclick="applyRandomColor('${outfit.id}')" title="기본 색상 + 커스텀 색상 전체 중에서 무작위로 하나 적용"
            style="margin:1px; padding:2px 7px; font-size:0.78em; border-radius:4px; border:1px solid #888; background:#222; color:#ccc; cursor:pointer;">🎲</button>`;
        const randomCustomColorBtn = `<button onclick="applyRandomCustomColor('${outfit.id}')" title="내가 추가한 커스텀 색상 중에서만 무작위로 하나 적용"
            style="margin:1px; padding:2px 7px; font-size:0.78em; border-radius:4px; border:1px solid #888; background:#222; color:#ccc; cursor:pointer;">🎲 커스텀</button>`;
        const customColorBtn = `<button onclick="addCustomColorToPalette()" title="원하는 색상을 팔레트에 새로 추가(모든 의상이 공유, 계속 남아있음)"
            style="margin:1px 8px 1px 2px; padding:2px 8px; font-size:0.72em; border-radius:4px; border:1px dashed #888; background:#222; color:#aaa; cursor:pointer;">+ 색상</button>`;
        const qualityBtns = QUALITY_WORDS.map(q => `<button onclick="applyOutfitQuality('${outfit.id}','${q}')"
            style="margin:1px; padding:2px 6px; font-size:0.72em; border-radius:4px; border:1px solid #555; background:#333; color:#ddd; cursor:pointer;">${q}</button>`).join('');
        return `<div style="display:flex; align-items:center; flex-wrap:wrap; gap:2px; margin-top:4px; padding:4px 6px; background:#1a1a1a; border-radius:6px;">
            ${editInputHtml}${colorBtns}${randomColorBtn}${randomCustomColorBtn}${customColorBtn}${qualityBtns}
        </div>`;
    }

    /** 🆕 콤마를 치는 순간(Enter 없이) 그 앞부분을 바로 칩으로 확정하고, 나머지는 계속 입력 중인 상태로 유지 */
    function handleOutfitChipTyping(outfitId, inputEl) {
        const val = inputEl.value;
        const outfit = findOutfit(outfitId);
        if (!outfit) return;
        if (!val.includes(',')) {
            // 🆕 아직 콤마 없어도(칩으로 확정 전이어도) 입력중 텍스트는 바로바로 저장해둠 — 새로고침해도 안 날아가게
            outfit.pendingText = val;
            saveWizardState();
            return;
        }
        const parts = val.split(',');
        const remainder = parts.pop();
        const completed = parts.map(s => s.trim()).filter(Boolean);
        outfit.pendingText = remainder;
        if (completed.length === 0) { inputEl.value = remainder; saveWizardState(); return; }
        completed.forEach(text => outfit.chips.push(newChip(text)));
        renderOutfitRows();
        // renderOutfitRows()가 입력창을 통째로 새로 그려서 커서가 풀리므로, 남은 글자를 그대로 넣고 다시 포커스
        setTimeout(() => {
            const el = document.getElementById(`${outfitId}_newchip`);
            if (el) { el.value = remainder; el.focus(); el.setSelectionRange(remainder.length, remainder.length); }
        }, 0);
    }
    window.handleOutfitChipTyping = handleOutfitChipTyping;

    /* ──────────────────────────────────────────────
       칩 조작
       ────────────────────────────────────────────── */
    function findOutfit(outfitId) { return outfitRows.find(o => o.id === outfitId); }

    function selectOutfitChip(outfitId, chipId) {
        const outfit = findOutfit(outfitId);
        if (!outfit) return;
        outfit.selectedChipId = (outfit.selectedChipId === chipId) ? null : chipId;
        renderOutfitRows();
    }
    window.selectOutfitChip = selectOutfitChip;

    function toggleOutfitChipDisabled(outfitId, chipId) {
        const outfit = findOutfit(outfitId);
        const chip = outfit && outfit.chips.find(c => c.id === chipId);
        if (!chip) return;
        chip.disabled = !chip.disabled;
        renderOutfitRows();
    }
    window.toggleOutfitChipDisabled = toggleOutfitChipDisabled;

    function moveOutfitChip(outfitId, chipId, dir) {
        const outfit = findOutfit(outfitId);
        if (!outfit) return;
        const idx = outfit.chips.findIndex(c => c.id === chipId);
        const newIdx = idx + dir;
        if (idx === -1 || newIdx < 0 || newIdx >= outfit.chips.length) return;
        const [chip] = outfit.chips.splice(idx, 1);
        outfit.chips.splice(newIdx, 0, chip);
        renderOutfitRows();
    }
    window.moveOutfitChip = moveOutfitChip;

    function removeOutfitChip(outfitId, chipId) {
        const outfit = findOutfit(outfitId);
        if (!outfit) return;
        outfit.chips = outfit.chips.filter(c => c.id !== chipId);
        if (outfit.selectedChipId === chipId) outfit.selectedChipId = null;
        renderOutfitRows();
    }
    window.removeOutfitChip = removeOutfitChip;

    /** 🆕 콤마로 구분해서 여러 개를 한 번에 입력해도 전부 따로따로 칩으로 추가됨
     *  (예: "하얀 티셔츠, 검은 바지" 입력 후 Enter → 칩 2개가 한 번에 생김) */
    function addOutfitChipFromInput(outfitId) {
        const outfit = findOutfit(outfitId);
        const input = document.getElementById(`${outfitId}_newchip`);
        if (!outfit || !input) return;
        const texts = input.value.split(',').map(t => t.trim()).filter(Boolean);
        if (texts.length === 0) return;
        texts.forEach(text => outfit.chips.push(newChip(text)));
        outfit.pendingText = '';
        input.value = '';
        renderOutfitRows();
        // renderOutfitRows()가 입력창을 통째로 새로 그려서 포커스가 풀리므로, 바로 이어서 입력할 수 있게 다시 포커스
        setTimeout(() => { const el = document.getElementById(`${outfitId}_newchip`); if (el) el.focus(); }, 0);
    }
    window.addOutfitChipFromInput = addOutfitChipFromInput;

    /** 칩 텍스트 맨 앞에 붙어있는 품질 단어들(연속으로 몇 개든)과 나머지를 분리.
     *  "light pastel red dress" → { qualityPart: "light pastel", rest: "red dress" } */
    function splitLeadingQualityWords(text) {
        const words = text.split(/\s+/).filter(Boolean);
        let i = 0;
        while (i < words.length && QUALITY_WORDS.includes(words[i].toLowerCase())) i++;
        return { qualityPart: words.slice(0, i).join(' '), rest: words.slice(i).join(' ') };
    }

    /** colorEnWord를 text(품질 단어는 이미 제외된 상태)에 적용 — 알려진 색상 단어가 있으면 교체, 없으면 맨 앞에 추가 */
    function applyColorToText(text, colorEnWord) {
        const pattern = new RegExp('(' + getAllColorSynonyms().map(escapeRegExp).join('|') + ')', 'i');
        return pattern.test(text) ? text.replace(pattern, colorEnWord) : `${colorEnWord} ${text}`.trim();
    }

    function applyOutfitColor(outfitId, colorKey) {
        const outfit = findOutfit(outfitId);
        if (!outfit) return;
        const colorInfo = getAllColorButtons().find(c => c.key === colorKey);
        if (!colorInfo) return;

        // 🆕 팔레트는 이제 칩을 선택했을 때만 나타나므로 항상 선택된 칩이 있다고 가정 가능(방어적으로 한 번 더 확인)
        const chip = outfit.chips.find(c => c.id === outfit.selectedChipId);
        if (!chip) return;
        // 🆕 품질 단어(light/dark 등)는 색상보다 항상 앞에 와야 하므로, 먼저 떼어냈다가 색만 바꾸고 다시 붙인다.
        const { qualityPart, rest } = splitLeadingQualityWords(chip.text);
        chip.text = [qualityPart, applyColorToText(rest, colorInfo.enWord)].filter(Boolean).join(' ');
        renderOutfitRows();
    }
    window.applyOutfitColor = applyOutfitColor;

    /** 🆕 기본 10색 + 커스텀 색상까지 전부 합친 풀에서 무작위로 하나 골라 선택된 칩에 적용 */
    function applyRandomColor(outfitId) {
        const pool = getAllColorButtons();
        if (pool.length === 0) return;
        const pick = pool[Math.floor(Math.random() * pool.length)];
        applyOutfitColor(outfitId, pick.key);
    }
    window.applyRandomColor = applyRandomColor;

    /** 🆕 기본 10색 말고 사용자가 추가한 커스텀 색상 중에서만 무작위로 하나 골라 적용 */
    function applyRandomCustomColor(outfitId) {
        if (customColorButtons.length === 0) { alert('아직 추가한 커스텀 색상이 없습니다. "+ 색상"으로 먼저 추가해주세요.'); return; }
        const pick = customColorButtons[Math.floor(Math.random() * customColorButtons.length)];
        applyOutfitColor(outfitId, pick.key);
    }
    window.applyRandomCustomColor = applyRandomCustomColor;

    function applyOutfitQuality(outfitId, qualityWord) {
        const outfit = findOutfit(outfitId);
        if (!outfit) return;
        if (!outfit.selectedChipId) { alert('먼저 품질을 적용할 조각(칩)을 클릭해서 선택해주세요.'); return; }
        const chip = outfit.chips.find(c => c.id === outfit.selectedChipId);
        if (!chip) return;
        // 품질 단어는 항상 맨 앞(기존 품질 단어들보다도 앞)에 쌓인다 — 결과적으로 "품질... 색상 나머지" 순서 유지됨
        chip.text = `${qualityWord} ${chip.text}`.trim();
        renderOutfitRows();
    }
    window.applyOutfitQuality = applyOutfitQuality;

    /** 🆕 선택된 칩을 지우고 다시 만드는 대신, 텍스트를 직접 고쳐서 제자리에서 바로 수정.
     *  전체를 다시 그리면(renderOutfitRows) 입력창 포커스가 끊기므로, 칩 span의 글자만
     *  직접 바꾸고 전체 재배치는 하지 않는다 — 그래서 순서가 안 바뀐다("순서 뒤바뀜" 버그 해결). */
    function editChipTextLive(outfitId, chipId, value) {
        const outfit = findOutfit(outfitId);
        const chip = outfit && outfit.chips.find(c => c.id === chipId);
        if (!chip) return;
        chip.text = value;
        const span = document.getElementById(`chipspan_${chipId}`);
        if (span) span.textContent = value;
        saveWizardState();
        scheduleSync();
    }
    window.editChipTextLive = editChipTextLive;

    /** 🆕 "+ 색상" — 칩에 바로 적용하는 게 아니라, 팔레트 자체에 새 색상 버튼을 추가한다(모든 의상이
     *  공유, localStorage에 영구 저장돼서 다음에 열어도 남아있음). 추가만 하고 바로 적용은 안 하므로,
     *  쓰려면 평소처럼 칩을 선택한 뒤 새로 생긴 버튼을 눌러야 한다. */
    /** 🆕 색상 단어 + 실제 스와치 색(RGB/hex, 네이티브 색상 선택기)을 같이 입력받는 작은 팝업 */
    function ensureCustomColorPopup() {
        if (document.getElementById('custom-color-popup')) return document.getElementById('custom-color-popup');
        const popup = document.createElement('div');
        popup.id = 'custom-color-popup';
        popup.className = 'modal-overlay';
        popup.style.cssText = 'display:none; z-index:100003;';
        popup.onclick = closeCustomColorPopup;
        popup.innerHTML = `
            <div class="modal-content" onclick="event.stopPropagation()" style="max-width:300px;">
                <div class="modal-header">
                    <h3 style="margin:0; color:#4CAF50; font-size:1em;">🎨 색상 팔레트에 추가</h3>
                    <button class="btn-secondary" style="padding:2px 10px;" onclick="closeCustomColorPopup()">✕</button>
                </div>
                <div style="padding:12px;">
                    <label style="display:block; margin-bottom:4px; font-size:0.85em;">프롬프트 태그(영문 권장)</label>
                    <input type="text" id="custom-color-word" placeholder="예: magenta, mint green"
                        style="width:100%; box-sizing:border-box; padding:6px; margin-bottom:10px; background:#222; color:#fff; border:1px solid #555; border-radius:4px;">
                    <label style="display:block; margin-bottom:4px; font-size:0.85em;">버튼에 쓸 스와치 색(RGB/hex — 눈으로 구분용, 태그와 꼭 같을 필요 없음)</label>
                    <input type="color" id="custom-color-swatch" value="#888888" style="width:100%; height:36px; border:1px solid #555; border-radius:4px; background:#222; margin-bottom:12px; cursor:pointer;">
                    <button class="btn-primary" style="width:100%;" onclick="confirmAddCustomColor()">팔레트에 추가</button>
                </div>
            </div>`;
        document.body.appendChild(popup);
        return popup;
    }

    function addCustomColorToPalette() {
        ensureCustomColorPopup();
        document.getElementById('custom-color-word').value = '';
        document.getElementById('custom-color-swatch').value = '#888888';
        document.getElementById('custom-color-popup').style.display = 'flex';
    }
    window.addCustomColorToPalette = addCustomColorToPalette;

    function closeCustomColorPopup() {
        const el = document.getElementById('custom-color-popup');
        if (el) el.style.display = 'none';
    }
    window.closeCustomColorPopup = closeCustomColorPopup;

    function confirmAddCustomColor() {
        const word = (document.getElementById('custom-color-word')?.value || '').trim();
        const swatchColor = document.getElementById('custom-color-swatch')?.value || '#888888';
        if (!word) { alert('프롬프트 태그를 입력해주세요.'); return; }
        const key = 'custom_' + Date.now();
        customColorButtons.push({ key, label: word, enWord: word, swatch: swatchColor, synonyms: [word] });
        saveCustomColors();
        closeCustomColorPopup();
        renderOutfitRows();
    }
    window.confirmAddCustomColor = confirmAddCustomColor;

    /** 커스텀 색상 버튼 우클릭 → 팔레트에서 제거(기본 10색은 제거 대상이 아니라서 key가 'custom_'일 때만 동작) */
    function removeCustomColor(colorKey) {
        if (!colorKey.startsWith('custom_')) return;
        customColorButtons = customColorButtons.filter(c => c.key !== colorKey);
        saveCustomColors();
        renderOutfitRows();
    }
    window.removeCustomColor = removeCustomColor;

    function addOutfitRow() {
        outfitRows.push(newOutfitRow(''));
        renderOutfitRows();
    }
    window.addOutfitRow = addOutfitRow;

    function removeOutfitRow(outfitId) {
        outfitRows = outfitRows.filter(o => o.id !== outfitId);
        renderOutfitRows();
    }
    window.removeOutfitRow = removeOutfitRow;


    /* ──────────────────────────────────────────────
       🧩 기존 조각에서 선택해서 칩으로 추가 (해당 의상에만 적용)
       ────────────────────────────────────────────── */
    function ensureFragmentPicker() {
        if (document.getElementById('outfit-fragment-picker')) return document.getElementById('outfit-fragment-picker');
        const overlay = document.createElement('div');
        overlay.id = 'outfit-fragment-picker';
        overlay.className = 'modal-overlay';
        overlay.style.cssText = 'display:none; z-index:100002;';
        overlay.onclick = closeFragmentPicker;
        overlay.innerHTML = `
            <div class="modal-content" onclick="event.stopPropagation()" style="max-width:420px;">
                <div class="modal-header">
                    <h3 id="outfit-fragment-picker-title" style="margin:0; color:#4CAF50; font-size:1em;">🧩 기존 조각에서 선택</h3>
                    <button class="btn-secondary" style="padding:2px 10px;" onclick="closeFragmentPicker()">✕</button>
                </div>
                <div style="padding:10px;">
                    <select id="outfit-fragment-group-select" onchange="onFragmentGroupChange()"
                        style="width:100%; box-sizing:border-box; padding:6px; margin-bottom:6px; background:#222; color:#fff; border:1px solid #555; border-radius:4px;"></select>
                    <input type="text" id="outfit-fragment-search" placeholder="이 그룹 안에서 검색..."
                        style="width:100%; box-sizing:border-box; padding:6px; margin-bottom:8px; background:#222; color:#fff; border:1px solid #555; border-radius:4px;"
                        oninput="renderFragmentPickerList()">
                    <div id="outfit-fragment-picker-list" style="max-height:320px; overflow-y:auto;"></div>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        return overlay;
    }

    const LAST_FRAGMENT_GROUP_KEY = 'outfitWizardLastFragmentGroup';
    // 🆕 마지막으로 고르던 그룹을 기억 — 모달을 다시 열 때는 물론, 새로고침해도 그대로 유지되게 localStorage에도 저장
    let lastFragmentPickerGroupId = (() => {
        try { return localStorage.getItem(LAST_FRAGMENT_GROUP_KEY) || null; } catch (e) { return null; }
    })();

    function populateFragmentGroupSelect() {
        const select = document.getElementById('outfit-fragment-group-select');
        if (!select) return;
        const works = (typeof libraryData !== "undefined" && libraryData.works) || [];
        const options = [];
        works.forEach(work => {
            (work.categories || []).forEach(cat => options.push({ id: cat.id, label: cat.name, workName: work.name || '' }));
        });
        const nameCount = {};
        options.forEach(o => { nameCount[o.label] = (nameCount[o.label] || 0) + 1; });
        select.innerHTML = options.map(o =>
            `<option value="${o.id}">${escapeHtml(o.label)}${nameCount[o.label] > 1 ? ` (${escapeHtml(o.workName)})` : ''}</option>`
        ).join('') || '<option value="">(그룹 없음)</option>';
        if (lastFragmentPickerGroupId && Array.from(select.options).some(opt => opt.value === lastFragmentPickerGroupId)) {
            select.value = lastFragmentPickerGroupId;
        }
    }

    function onFragmentGroupChange() {
        lastFragmentPickerGroupId = document.getElementById('outfit-fragment-group-select')?.value || null;
        try { localStorage.setItem(LAST_FRAGMENT_GROUP_KEY, lastFragmentPickerGroupId || ''); } catch (e) { /* 무시 */ }
        renderFragmentPickerList();
    }
    window.onFragmentGroupChange = onFragmentGroupChange;

    let fragmentPickerMode = 'chip'; // 'chip' = 의상 칩으로 추가 / 'action' = 이 의상 전용 행동으로 추가

    function openFragmentPickerFor(outfitId) {
        fragmentPickerTargetOutfitId = outfitId;
        fragmentPickerMode = 'chip';
        ensureFragmentPicker();
        document.getElementById('outfit-fragment-picker-title').textContent = '🧩 기존 조각에서 선택 (의상 칩으로 추가)';
        populateFragmentGroupSelect();
        document.getElementById('outfit-fragment-search').value = '';
        renderFragmentPickerList();
        document.getElementById('outfit-fragment-picker').style.display = 'flex';
    }
    window.openFragmentPickerFor = openFragmentPickerFor;

    /** 🆕 이 의상 "전용" 행동 조각 추가 — 공유 행동 목록과는 별개로 이 의상에만 적용됨 */
    function openActionPickerFor(outfitId) {
        fragmentPickerTargetOutfitId = outfitId;
        fragmentPickerMode = 'action';
        ensureFragmentPicker();
        document.getElementById('outfit-fragment-picker-title').textContent = '🎯 이 의상 전용 행동 조각 추가';
        populateFragmentGroupSelect();
        document.getElementById('outfit-fragment-search').value = '';
        renderFragmentPickerList();
        document.getElementById('outfit-fragment-picker').style.display = 'flex';
    }
    window.openActionPickerFor = openActionPickerFor;

    function closeFragmentPicker() {
        const el = document.getElementById('outfit-fragment-picker');
        if (el) el.style.display = 'none';
    }
    window.closeFragmentPicker = closeFragmentPicker;

    /** action 모드에서 이 항목이 이미 선택돼 있는지(공유 타겟이면 sharedActionRefs, 아니면 그 의상의 extraActionRefs 기준) */
    function isFragmentPicked(catId, itemId) {
        if (fragmentPickerTargetOutfitId === SHARED_ACTION_TARGET) {
            return sharedActionRefs.some(r => r.catId === catId && r.itemId === itemId);
        }
        const outfit = findOutfit(fragmentPickerTargetOutfitId);
        return outfit ? outfit.extraActionRefs.some(r => r.catId === catId && r.itemId === itemId) : false;
    }

    function renderFragmentPickerList() {
        const listEl = document.getElementById('outfit-fragment-picker-list');
        if (!listEl) return;
        const catId = document.getElementById('outfit-fragment-group-select')?.value;
        const q = (document.getElementById('outfit-fragment-search')?.value || '').trim().toLowerCase();
        const cats = (typeof getAllCategories === 'function') ? getAllCategories() : [];
        const cat = cats.find(c => c.id === catId);
        if (!cat) {
            listEl.innerHTML = '<p style="color:#666; font-size:0.85em; padding:10px; margin:0;">먼저 그룹을 선택해주세요.</p>';
            return;
        }
        const rows = (cat.items || []).filter(item => {
            if (!item.prompt) return false;
            if (!q) return true;
            return `${item.name || ''} ${item.prompt}`.toLowerCase().includes(q);
        });
        // 🆕 action 모드에선 체크박스로 여러 개 동시에 선택 상태를 보여줌(클릭해도 안 닫힘)
        listEl.innerHTML = rows.length === 0
            ? '<p style="color:#666; font-size:0.85em; padding:10px; margin:0;">이 그룹엔 조각이 없거나 검색 결과가 없습니다.</p>'
            : rows.map(item => {
                const picked = fragmentPickerMode === 'action' && isFragmentPicked(cat.id, item.id);
                return `<div onclick="pickFragmentIntoOutfit('${item.id}')" style="display:flex; align-items:flex-start; gap:8px; padding:6px 8px; border-bottom:1px solid #2a2a2a; cursor:pointer; ${picked ? 'background:#1f3a1f;' : ''}">
                    ${fragmentPickerMode === 'action' ? `<input type="checkbox" ${picked ? 'checked' : ''} style="margin-top:3px; pointer-events:none;">` : ''}
                    <div style="flex:1; min-width:0;">
                        <div style="font-size:0.85em; color:#fff;">${escapeHtml(item.name || '(이름없음)')}</div>
                        <div style="font-size:0.75em; color:#999; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(item.prompt)}</div>
                    </div>
                </div>`;
            }).join('');
    }
    window.renderFragmentPickerList = renderFragmentPickerList;

    /** 🆕 더 이상 한 번 고르면 닫히지 않음 — action 모드는 토글(여러 개 선택/해제), chip 모드는 클릭할 때마다 계속 칩 추가.
     *  다 골랐으면 ✕ 버튼으로 직접 닫으면 됨. */
    function pickFragmentIntoOutfit(itemId) {
        const catId = document.getElementById('outfit-fragment-group-select')?.value;
        const cats = (typeof getAllCategories === 'function') ? getAllCategories() : [];
        const cat = cats.find(c => c.id === catId);
        const found = cat && cat.items.find(i => i.id === itemId);
        if (!found) return;

        // 🆕 "기본"(모든 의상 공유) 타겟이면 특정 의상이 아니라 sharedActionRefs를 토글
        if (fragmentPickerMode === 'action' && fragmentPickerTargetOutfitId === SHARED_ACTION_TARGET) {
            const idx = sharedActionRefs.findIndex(r => r.catId === catId && r.itemId === itemId);
            if (idx === -1) sharedActionRefs.push({ catId, itemId }); else sharedActionRefs.splice(idx, 1);
            renderOutfitRows();
            renderFragmentPickerList();
            return;
        }

        const outfit = findOutfit(fragmentPickerTargetOutfitId);
        if (!outfit) return;

        if (fragmentPickerMode === 'action') {
            const idx = outfit.extraActionRefs.findIndex(r => r.catId === catId && r.itemId === itemId);
            if (idx === -1) outfit.extraActionRefs.push({ catId, itemId }); else outfit.extraActionRefs.splice(idx, 1);
        } else {
            outfit.chips.push(newChip(found.prompt));
        }
        renderOutfitRows();
        renderFragmentPickerList();
    }
    window.pickFragmentIntoOutfit = pickFragmentIntoOutfit;

    /* ──────────────────────────────────────────────
       제출: 칩이 있는 의상마다 선택된 그룹에 조각 하나씩 생성
       ────────────────────────────────────────────── */
    function resolveTargetCategory() {
        const select = document.getElementById('outfit-set-group-select');
        if (!select) return null;
        if (select.value === NEW_GROUP_OPTION_VALUE) {
            const name = (document.getElementById('outfit-set-new-group-name').value || '').trim();
            if (!name) return null; // 자동 동기화라 조용히 대기(요약줄에서 안내)
            if (typeof getActiveWork !== 'function') return null;
            const work = getActiveWork() || (typeof libraryData !== "undefined" && libraryData.works && libraryData.works[0]);
            if (!work) return null;
            let catId = 'cat_' + Date.now();
            while (typeof getAllCategories === 'function' && getAllCategories().some(c => c.id === catId)) catId += '_';
            const category = { id: catId, name, items: [] };
            work.categories.push(category);
            // 🆕 모달이 제출해도 안 닫히므로, 다음 번 "조각 만들기"에서 같은 이름의 그룹이 또
            // 생기지 않도록 드롭다운을 방금 만든 이 그룹으로 바로 전환해둔다.
            populateGroupSelect();
            select.value = catId;
            onGroupSelectChange();
            return category;
        }
        const cats = (typeof getAllCategories === 'function') ? getAllCategories() : [];
        return cats.find(c => c.id === select.value) || null;
    }

    function createItemInCategory(category, name, promptText) {
        let itemId = 'item_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
        while (typeof getAllCategories === 'function' && getAllCategories().some(c => c.items.some(it => it.id === itemId))) {
            itemId = 'item_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
        }
        const item = { id: itemId, name: String(name || '새 조각'), prompt: String(promptText || '') };
        category.items.push(item);
        return item;
    }

    /** ref({catId,itemId})를 실제 조각({name, prompt})으로 바꿔준다. 못 찾으면 null. */
    function resolveActionRef(ref, cats) {
        const cat = cats.find(c => c.id === ref.catId);
        const item = cat && cat.items.find(i => i.id === ref.itemId);
        return item ? { name: item.name || '행동', prompt: item.prompt } : null;
    }

    /** key(comboItemIds의 키)에 해당하는 조각이 이미 만들어져 있으면 그 내용만 업데이트하고,
     *  없으면 새로 만든다. 색만 바꿔서 재제출할 때 중복 생성되지 않는 핵심 로직. */
    function upsertComboItem(category, outfit, key, name, promptText) {
        const existingId = outfit.comboItemIds[key];
        const existingItem = existingId && category.items.find(it => it.id === existingId);
        if (existingItem) {
            existingItem.name = name;
            existingItem.prompt = promptText;
            return false; // created 아님(업데이트)
        }
        const item = createItemInCategory(category, name, promptText);
        outfit.comboItemIds[key] = item.id;
        return true; // created
    }

    /** 🆕 더 이상 버튼으로 수동 호출하지 않음 — 편집 후 900ms 지나면 자동으로, 모달을 닫을 때는
     *  즉시 호출된다("따로 저장 버튼 안 누르고 바깥 눌러 꺼도 저장되게"). 알림(alert) 없이 조용히
     *  동작하고, 결과는 하단 요약줄(lastSyncLabel)에만 짧게 표시한다. */
    function syncOutfitsToLibrary() {
        const validOutfits = outfitRows.filter(o => buildOutfitPromptText(o));
        if (validOutfits.length === 0) { lastSyncLabel = ''; updateOutfitSetSummary(); return; }

        const category = resolveTargetCategory();
        if (!category) {
            lastSyncLabel = '⚠️ 저장할 그룹을 선택하거나 새 그룹 이름을 입력해주세요';
            updateOutfitSetSummary();
            return;
        }

        const cats = (typeof getAllCategories === 'function') ? getAllCategories() : [];
        let createdCount = 0, updatedCount = 0, deletedCount = 0;

        validOutfits.forEach((outfit, i) => {
            const firstChipText = outfit.chips.find(c => !c.disabled && c.text.trim())?.text.trim();
            // 🆕 이름칸(outfit.customName)을 우선 쓰고, 안 적었으면 첫 칩을 이름으로 — 둘 다 없으면 "의상 N"
            const outfitName = (outfit.customName || '').trim() || firstChipText || `의상 ${i + 1}`;
            const promptText = buildOutfitPromptText(outfit);

            // 이 의상의 실제 행동 목록 = 🏃 기본(모든 의상 공유) ∪ 🎯 이 의상 전용, 단 🚫 제외한 건 뺌
            const refMap = new Map();
            [...sharedActionRefs, ...outfit.extraActionRefs].forEach(r => refMap.set(`${r.catId}::${r.itemId}`, r));
            outfit.excludedSharedRefs.forEach(r => refMap.delete(`${r.catId}::${r.itemId}`));
            const actionRefs = Array.from(refMap.values());

            const usedKeys = new Set();
            if (actionRefs.length === 0) {
                const created = upsertComboItem(category, outfit, '__none__', outfitName, promptText);
                created ? createdCount++ : updatedCount++;
                usedKeys.add('__none__');
            } else {
                actionRefs.forEach(ref => {
                    const action = resolveActionRef(ref, cats);
                    if (!action) return; // 그 사이 삭제된 조각 등 — 조용히 건너뜀
                    const combinedPrompt = [promptText, action.prompt].filter(Boolean).join(', ');
                    const key = `${ref.catId}::${ref.itemId}`;
                    const created = upsertComboItem(category, outfit, key, `${outfitName} - ${action.name}`, combinedPrompt);
                    created ? createdCount++ : updatedCount++;
                    usedKeys.add(key);
                });
            }

            // 🆕 "의상칸에서 수정하면 그걸로 생성된 조각도 변화" — 행동을 제외/삭제해서 더 이상
            // 안 쓰는 조합은, 이전에 만들어둔 조각도 같이 정리(고아로 남기지 않음).
            Object.keys(outfit.comboItemIds).forEach(key => {
                if (usedKeys.has(key)) return;
                const staleId = outfit.comboItemIds[key];
                cats.forEach(cat => { cat.items = cat.items.filter(it => it.id !== staleId); });
                delete outfit.comboItemIds[key];
                deletedCount++;
            });
        });

        if (typeof renderWorkTree === 'function') { try { renderWorkTree(); } catch (e) { /* 저장은 계속 진행 */ } }
        if (typeof renderItems === 'function') { try { renderItems(); } catch (e) { /* 위와 같음 */ } }
        if (typeof debounceLibrarySave === 'function') debounceLibrarySave();
        saveWizardState(); // comboItemIds가 갱신됐으니 작업 상태도 다시 저장

        const parts = [];
        if (createdCount) parts.push(`생성 ${createdCount}`);
        if (updatedCount) parts.push(`수정 ${updatedCount}`);
        if (deletedCount) parts.push(`삭제 ${deletedCount}`);
        lastSyncLabel = parts.length ? `✅ "${category.name}" 그룹에 반영됨 (${parts.join(', ')})` : '';
        updateOutfitSetSummary();
    }
    window.syncOutfitsToLibrary = syncOutfitsToLibrary;

    /** 🆕 의상 전체 삭제 — 의상 자체뿐 아니라, 이 의상으로 만들어진 조각들도 전부 같이 지운다. */
    function deleteOutfitAndItems(outfitId) {
        const outfit = findOutfit(outfitId);
        if (!outfit) return;
        const itemIds = Object.values(outfit.comboItemIds || {});
        if (!confirm(`이 의상과, 이걸로 만들어진 조각 ${itemIds.length}개를 전부 삭제할까요?\n되돌릴 수 없습니다.`)) return;

        if (itemIds.length > 0 && typeof getAllCategories === 'function') {
            getAllCategories().forEach(cat => { cat.items = cat.items.filter(it => !itemIds.includes(it.id)); });
        }
        outfitRows = outfitRows.filter(o => o.id !== outfitId);

        if (typeof renderWorkTree === 'function') { try { renderWorkTree(); } catch (e) { /* 계속 진행 */ } }
        if (typeof renderItems === 'function') { try { renderItems(); } catch (e) { /* 위와 같음 */ } }
        if (typeof debounceLibrarySave === 'function') debounceLibrarySave();
        renderOutfitRows();
    }
    window.deleteOutfitAndItems = deleteOutfitAndItems;

    /** 🆕 이름칸 입력 — 전체 리렌더(renderOutfitRows)는 포커스가 끊겨서 여기선 상태만 갱신하고
     *  디바운스 동기화만 예약한다(이름이 바뀌면 이미 만들어진 조각들의 이름도 같이 바뀜). */
    function renameOutfitLive(outfitId, value) {
        const outfit = findOutfit(outfitId);
        if (!outfit) return;
        outfit.customName = value;
        saveWizardState();
        scheduleSync();
    }
    window.renameOutfitLive = renameOutfitLive;

    /* ──────────────────────────────────────────────
       🚫 제외 — 기본(공유) 행동 중 특정 의상에서만 빼고 싶을 때
       ────────────────────────────────────────────── */
    let excludePanelOpenFor = new Set(); // 패널이 펼쳐진 의상 id들(UI 상태라 저장 안 함)

    function toggleExcludePanel(outfitId) {
        if (excludePanelOpenFor.has(outfitId)) excludePanelOpenFor.delete(outfitId); else excludePanelOpenFor.add(outfitId);
        renderOutfitRows();
    }
    window.toggleExcludePanel = toggleExcludePanel;

    function toggleExcludeSharedAction(outfitId, catId, itemId) {
        const outfit = findOutfit(outfitId);
        if (!outfit) return;
        const idx = outfit.excludedSharedRefs.findIndex(r => r.catId === catId && r.itemId === itemId);
        if (idx === -1) outfit.excludedSharedRefs.push({ catId, itemId }); else outfit.excludedSharedRefs.splice(idx, 1);
        renderOutfitRows();
    }
    window.toggleExcludeSharedAction = toggleExcludeSharedAction;

    /** 🚫 버튼을 눌렀을 때만, 현재 기본 행동들을 클릭 가능한 목록으로 보여줌(클릭 = 이 의상에서 제외 토글) */
    function excludePanelHtml(outfit) {
        if (!excludePanelOpenFor.has(outfit.id)) return '';
        if (sharedActionRefs.length === 0) {
            return `<div style="margin-top:4px; padding:4px 6px; background:#1a1a1a; border-radius:6px; font-size:0.76em; color:#777;">기본 행동이 아직 없습니다.</div>`;
        }
        const cats = (typeof getAllCategories === 'function') ? getAllCategories() : [];
        const chips = sharedActionRefs.map(ref => {
            const cat = cats.find(c => c.id === ref.catId);
            const item = cat && cat.items.find(i => i.id === ref.itemId);
            const label = item ? (item.name || '(이름없음)') : '(찾을 수 없음)';
            const excluded = outfit.excludedSharedRefs.some(r => r.catId === ref.catId && r.itemId === ref.itemId);
            const style = `cursor:pointer; font-size:0.78em; padding:2px 6px; margin:2px; border-radius:4px; border:1px solid ${excluded ? '#e57373' : '#555'}; color:${excluded ? '#e57373' : '#ccc'}; ${excluded ? 'text-decoration:line-through;' : ''}`;
            return `<span onclick="toggleExcludeSharedAction('${outfit.id}','${ref.catId}','${ref.itemId}')" style="${style}">${escapeHtml(label)}</span>`;
        }).join('');
        return `<div style="margin-top:4px; padding:4px 6px; background:#1a1a1a; border-radius:6px;"><span style="font-size:0.74em; color:#888;">클릭하면 이 의상에서 제외/포함:</span> ${chips}</div>`;
    }

    document.addEventListener('DOMContentLoaded', ensureOutfitSetButton);
    setTimeout(ensureOutfitSetButton, 1000);
})();
