/**
 * ui_manager.js — 순수 UI 로직 관리자
 * 탭 전환, 모달 제어, 라이트박스, 좌우 리사이저, 컨텍스트 메뉴 등
 * DOM 요소 조작에 관한 로직을 전담합니다.
 * 상태 저장이나 API 통신은 수행하지 않으며, 필요 시 appStateManager를 호출합니다.
 */

const UIManager = {
    /** UIManager 초기화. 레이아웃 리사이저와 컨텍스트 메뉴 리스너를 바인딩한다. */
    init() {
        this.initLayoutResizer();
        this.initContextMenuListener();
    },

    /**
     * 탭 전환. 지정된 tabId의 패널을 활성화하고 이전 탭을 비활성화한다.
     * 탭에 따라 필요한 데이터를 자동으로 Fetch한다 (체크포인트, 로라, 갤러리).
     * 탭 변경 후 상태를 즉시 저장한다.
     */
    openTab(tabId, btn) {
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        const panel = document.getElementById(tabId);
        if (panel) panel.classList.add('active');

        if (!btn) {
            btn = document.querySelector(`.tab-btn[onclick*="${tabId}"]`);
        }
        if (btn) btn.classList.add('active');

        const mainContent = document.getElementById('main-content');
        if (tabId === 'tab-generate') {
            mainContent.classList.add('full-screen');
        } else {
            mainContent.classList.remove('full-screen');
            if (tabId === 'tab-checkpoint') fetchGallery('checkpoints');
            if (tabId === 'tab-lora') fetchGallery('loras');
            if (tabId === 'tab-gallery') {
                const list = document.getElementById('gallery-folder-list');
                if (list && list.innerHTML.includes('데이터 로딩 중...')) {
                    fetchGalleryData();
                }
            }
        }

        if (typeof appStateManager !== 'undefined' && window.appStateLoaded) {
            appStateManager.saveState();
        }
    },

    /** 이미지 생성 탭의 좌우 패널 분할 드래그 리사이저 초기화 */
    initLayoutResizer() {
        const resizer = document.getElementById('gen-resizer');
        const leftSide = document.getElementById('gen-left');
        const rightSide = document.getElementById('gen-right');
        const generateContainer = document.getElementById('tab-generate');
        let isResizing = false;

        if (resizer) {
            resizer.addEventListener('mousedown', () => {
                isResizing = true; resizer.classList.add('resizing');
                document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
            });

            document.addEventListener('mousemove', (e) => {
                if (!isResizing) return;
                const containerRect = generateContainer.getBoundingClientRect();
                let newLeftWidth = ((e.clientX - containerRect.left) / containerRect.width) * 100;
                if (newLeftWidth > 40 && newLeftWidth < 90) {
                    leftSide.style.width = newLeftWidth + '%'; rightSide.style.width = (100 - newLeftWidth) + '%';
                }
            });

            document.addEventListener('mouseup', () => {
                if (isResizing) {
                    isResizing = false; resizer.classList.remove('resizing');
                    document.body.style.cursor = 'default'; document.body.style.userSelect = 'auto';
                }
            });
        }
    },

    /** 이미지를 전체 화면 라이트박스로 표시 */
    openLightbox(src) {
        document.getElementById('lightbox-img').src = src;
        document.getElementById('lightbox').style.display = 'flex';
    },

    /** 라이트박스 닫기 */
    closeLightbox() {
        document.getElementById('lightbox').style.display = 'none';
    },

    /** 메타데이터 모달 닫기 */
    closeMetadataModal() {
        document.getElementById('metadata-modal').style.display = 'none';
    },

    /**
     * 모델(체크포인트/로라) 상세 정보 모달을 열고 서버에서 정보를 불러와 표시.
     * CivitAI 이미지, 태그, 설명 등을 렌더링한다.
     */
    async showModelInfo(modelType, modelName) {
        if (!modelName || modelName.includes("로딩 중")) {
            alert("먼저 모델을 선택해 주세요.");
            return;
        }

        const modal = document.getElementById('model-info-modal');
        const titleEl = document.getElementById('model-info-title');
        const bodyEl = document.getElementById('model-info-body');

        titleEl.innerText = modelName;
        bodyEl.innerHTML = '<div style="text-align:center; padding: 20px;">정보를 불러오는 중입니다... ⏳</div>';
        modal.style.display = 'flex';

        try {
            const data = await API.get(`/assetmanager/api/model_info?type=${modelType}&name=${encodeURIComponent(modelName)}`);

            if (data.status === 'success' && data.info) {
                const info = data.info;
                let html = '';

                let imgUrl = null;
                if (info.civitai && info.civitai.images && info.civitai.images.length > 0) {
                    imgUrl = info.civitai.images[0].url;
                } else if (info.preview_url) {
                    imgUrl = `/assetmanager/api/view_image?path=${encodeURIComponent(info.preview_url)}`;
                }

                if (imgUrl) {
                    html += `<div style="text-align:center; margin-bottom:15px;"><img src="${imgUrl}" style="max-width:100%; max-height:400px; border-radius: 8px; object-fit: contain;"></div>`;
                }

                html += `<h4 style="color:#4CAF50; border-bottom:1px solid #444; padding-bottom:5px;">${info.model_name || info.name || "Model Info"}</h4>`;
                html += `<div style="margin-bottom:15px; font-size:0.9em; color:#ccc;">`;
                if (info.base_model) html += `<div style="margin-bottom:6px;"><b>Base Model:</b> ${info.base_model}</div>`;
                // 🆕 트리거 워드(trainedWords)와 태그(tags)는 더 이상 그냥 텍스트 나열이 아니라
                // 클릭 가능한 칩으로 렌더링 — 아래 renderClickableTagChips()에서 DOM으로 채움.
                if (info.trainedWords && info.trainedWords.length > 0) {
                    html += `<div style="margin-bottom:6px;"><b>Trigger Words:</b></div><div id="model-info-trigger-slot" style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:8px;"></div>`;
                }
                if (info.tags && info.tags.length > 0) {
                    html += `<div style="margin-bottom:6px;"><b>Tags:</b></div><div id="model-info-tags-slot" style="display:flex; flex-wrap:wrap; gap:4px;"></div>`;
                }
                html += `</div>`;

                const desc = info.modelDescription || (info.civitai && info.civitai.model && info.civitai.model.description) || "상세 설명이 존재하지 않습니다.";
                html += `<div style="background:#1e1e1e; padding:15px; border-radius:6px; border:1px solid #333; max-height: 300px; overflow-y:auto; line-height:1.6;">${desc}</div>`;

                bodyEl.innerHTML = html;

                // 🆕 모델 정보 모달 ↔ 태그 사전 연결: 트리거 워드/태그 칩을 클릭하면 공통 긍정
                // 프롬프트(#base-pos)에 바로 추가되고, "!" 버튼으로 태그 사전(tag_dictionary.js)
                // 풍선 설명을 그 자리에서 바로 확인할 수 있다. trainedWords(진짜 트리거 워드)와
                // tags(CivitAI가 매긴 넓은 범주의 스타일 태그, 트리거 워드와는 다름)를 구분해서 보여줌 —
                // tags 쪽은 danbooru 태그가 아닐 수 있어 "!" 를 눌러도 사전에 없을 수 있음(정상).
                if (info.trainedWords && info.trainedWords.length > 0) {
                    UIManager._renderModelInfoTagChips('model-info-trigger-slot', info.trainedWords, '#4CAF50');
                }
                if (info.tags && info.tags.length > 0) {
                    UIManager._renderModelInfoTagChips('model-info-tags-slot', info.tags.slice(0, 30), '#3a6ea5');
                }
            } else {
                bodyEl.innerHTML = `<div style="padding: 20px; color: #ff5555;">이 모델에 대한 .json 메타데이터 정보를 찾지 못했습니다. (${data.message || '파일 없음'})</div>`;
            }
        } catch (e) {
            bodyEl.innerHTML = `<div style="padding: 20px; color: #ff5555;">정보를 불러오는 중 서버 통신 에러가 발생했습니다.</div>`;
        }
    },

    /** 모델 정보 모달 닫기 */
    closeModelInfoModal() {
        document.getElementById('model-info-modal').style.display = 'none';
    },

    /**
     * 🆕 모델 정보 모달 ↔ 태그 사전 연결 — showModelInfo()에서만 쓰는 내부 헬퍼.
     * tagList의 각 단어를 "칩 + ! 버튼"으로 렌더링해서 slotId 안에 채운다.
     * 칩 본문을 클릭하면 #base-pos(공통 긍정 프롬프트)에 바로 추가되고,
     * "!" 버튼을 클릭하면 tag_dictionary.js의 풍선 설명이 그 자리에서 뜬다
     * (tag_dictionary.js가 아직 로드 전이거나 사전에 없는 단어면 "!" 버튼 없이 칩만 표시).
     */
    _renderModelInfoTagChips(slotId, tagList, color) {
        const slot = document.getElementById(slotId);
        if (!slot) return;
        slot.innerHTML = '';
        tagList.forEach(tagText => {
            if (!tagText) return;
            const wrap = document.createElement('span');
            wrap.style.cssText = `display:inline-flex; align-items:center; background:${color}26; border:1px solid ${color}55; border-radius:12px; overflow:hidden;`;

            const chip = document.createElement('button');
            chip.type = 'button';
            chip.textContent = tagText;
            chip.title = '클릭하면 공통 긍정 프롬프트에 추가됩니다';
            chip.style.cssText = `background:none; border:none; color:${color}; padding:3px 8px; font-size:0.82em; cursor:pointer;`;
            chip.addEventListener('click', () => {
                const posEl = document.getElementById('base-pos');
                if (!posEl) return;
                const current = posEl.value.trim();
                posEl.value = current ? `${current}, ${tagText}` : tagText;
                posEl.dispatchEvent(new Event('input', { bubbles: true }));
                chip.style.textDecoration = 'line-through'; // 추가됐다는 피드백(살짝 흐리게 처리)
                chip.style.opacity = '0.6';
            });
            wrap.appendChild(chip);

            // 태그 사전이 로드돼 있으면 "!" 버튼을 같이 붙임 — 없으면(아직 로딩 전/파일 미포함) 조용히 생략
            if (window.TagDictionary && typeof window.TagDictionary.createBangButton === 'function') {
                wrap.appendChild(window.TagDictionary.createBangButton(tagText));
            }
            slot.appendChild(wrap);
        });
    },

    /** 라이브 프리뷰 영역 접기/펼치기 토글 */
    toggleLivePreview() {
        const body = document.getElementById('live-preview-body');
        const container = document.getElementById('live-preview-container');
        const btn = document.getElementById('live-preview-toggle');
        const isCollapsed = body.classList.toggle('collapsed');
        container.classList.toggle('collapsed-mode', isCollapsed);
        btn.textContent = isCollapsed ? '▼ 펼치기' : '▲ 접기';
        if (typeof appStateManager !== 'undefined') appStateManager.debounceSave();
    },

    /** 우클릭 컨텍스트 메뉴를 마우스 위치에 표시 */
    openContextMenu(e, filename, subfolder) {
        e.preventDefault();
        const menu = document.getElementById('context-menu');
        menu.style.display = 'block';
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';
        window.currentTargetImg = { filename, subfolder: subfolder !== 'undefined' ? subfolder : '' };
    },

    /** 화면 아무 곳 클릭 시 컨텍스트 메뉴를 닫는 전역 리스너 등록 */
    initContextMenuListener() {
        document.addEventListener('click', () => {
            const menu = document.getElementById('context-menu');
            if (menu) menu.style.display = 'none';
        });
    },

    /** 체크박스 클릭 시 하위 옵션 영역을 표시/숨김 처리 */
    toggleSubOptions(id, checkbox) {
        document.getElementById(id).style.display = checkbox.checked ? 'block' : 'none';
    },

    /** 이미지 생성 탭에 로라 선택 행을 동적으로 추가 */
    addLoraRow() {
        const row = document.createElement('div'); row.className = 'lora-item';
        // 🐛 버그 수정: X(삭제) 버튼은 click 이벤트라서 #selected-loras에 걸린 change/input
        // 델리게이션(main.js, savePresetOverride 호출)에 안 걸린다. 그래서 로라를 지워도
        // 화면에서만 사라지고 실제 프리셋엔 계속 남아있다가, 프리셋을 나갔다 다시 들어오면
        // 지운 로라가 되살아나는 문제가 있었다. debounceSave 옆에 savePresetOverride도 같이 호출.
        row.innerHTML = `<select style="flex: 1; margin-right: 10px;">${window.loraOptionsHTML || ''}</select>
            <label style="margin-bottom: 0; font-weight: normal;">가중치:</label><input type="number" step="0.1" value="0.8" style="width: 70px; margin-left: 5px;"><button class="btn-secondary" style="margin-left: 10px;" onclick="this.parentElement.remove(); if(typeof savePresetOverride === 'function') savePresetOverride(); if(typeof appStateManager !== 'undefined') appStateManager.debounceSave();">X</button>`;
        document.getElementById('selected-loras').appendChild(row);
        if (typeof appStateManager !== 'undefined') appStateManager.debounceSave();
    }
};

window.UIManager = UIManager;

/* HTML onclick 속성에서 호출할 수 있도록 전역 래핑 함수 노출 */
window.openTab = (tabId, btn) => UIManager.openTab(tabId, btn);
window.openLightbox = (src) => UIManager.openLightbox(src);
window.closeLightbox = () => UIManager.closeLightbox();
window.closeMetadataModal = () => UIManager.closeMetadataModal();
window.showModelInfo = (modelType, modelName) => UIManager.showModelInfo(modelType, modelName);
window.closeModelInfoModal = () => UIManager.closeModelInfoModal();
window.toggleLivePreview = () => UIManager.toggleLivePreview();
window.openContextMenu = (e, filename, subfolder) => UIManager.openContextMenu(e, filename, subfolder);
window.toggleSubOptions = (id, check) => UIManager.toggleSubOptions(id, check);
window.addLoraRow = () => UIManager.addLoraRow();
