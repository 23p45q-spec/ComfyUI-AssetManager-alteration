/**
 * state_manager.js — 애플리케이션 전역 상태 관리자
 * 화면(DOM)의 설정값을 수집하여 JSON 객체로 직렬화하고,
 * 백엔드 /assetmanager/api/save_state 엔드포인트와 동기화합니다.
 * 페이지 새로고침 시 이전 세션의 설정을 복원하는 역할도 담당합니다.
 */

class AppStateManager {
    constructor() {
        this.saveTimeout = null;
    }

    /**
     * 현재 화면(DOM)의 모든 설정값을 수집하여 JSON 직렬화 가능한 객체로 반환.
     * 반환된 객체가 그대로 app_state.json에 저장된다.
     */
    getCurrentState() {
        const detailerOpts = {
            face: document.getElementById('detailer-face-toggle')?.checked || false,
            eye: document.getElementById('detailer-eye-toggle')?.checked || false,
            mouth: document.getElementById('detailer-mouth-toggle')?.checked || false,
            hand: document.getElementById('detailer-hand-toggle')?.checked || false,
            faceModel: document.getElementById('detailer-face-model')?.value || '',
            eyeModel: document.getElementById('detailer-eye-model')?.value || '',
            mouthModel: document.getElementById('detailer-mouth-model')?.value || '',
            handModel: document.getElementById('detailer-hand-model')?.value || ''
        };

        const mosaicOpts = {
            nipples: document.getElementById('censor-nipples')?.checked || false,
            pussy: document.getElementById('censor-pussy')?.checked || false,
            penis: document.getElementById('censor-penis')?.checked || false,
            anus: document.getElementById('censor-anus')?.checked || false,
            testicles: document.getElementById('censor-testicles')?.checked || false,
            xray: document.getElementById('censor-xray')?.checked || false,
            'cross-section': document.getElementById('censor-cross-section')?.checked || false,
            mode: document.getElementById('censor-mode')?.value || 'mosaic',
            intensity: document.getElementById('censor-intensity')?.value || '15'
        };

        const standaloneCensorOpts = {
            nipples: document.getElementById('tool-censor-nipples')?.checked !== false,
            pussy: document.getElementById('tool-censor-pussy')?.checked !== false,
            penis: document.getElementById('tool-censor-penis')?.checked !== false,
            anus: document.getElementById('tool-censor-anus')?.checked !== false,
            testicles: document.getElementById('tool-censor-testicles')?.checked !== false,
            xray: document.getElementById('tool-censor-xray')?.checked !== false,
            'cross-section': document.getElementById('tool-censor-cross-section')?.checked !== false,
            mode: document.getElementById('tool-censor-mode')?.value || 'mosaic',
            intensity: document.getElementById('tool-censor-intensity')?.value || '3.0'
        };

        const loraOpts = Array.from(document.querySelectorAll('#selected-loras .lora-item')).map(row => ({
            model: row.querySelector('select').value,
            weight: parseFloat(row.querySelector('input[type="number"]').value)
        }));

        const genModeInput = document.querySelector('input[name="gen-mode"]:checked');
        const activeTabEl = document.querySelector('.tab-panel.active');

        let currentTabId = 'tab-generate';
        if (activeTabEl && activeTabEl.id) {
            currentTabId = activeTabEl.id;
        }

        return {
            activeTab: currentTabId,
            globalRepeatCount: document.getElementById('global-repeat-count')?.value || 1,
            checkpoint: document.getElementById('gen-checkpoint')?.value || '',
            basePos: document.getElementById('base-pos')?.value || '',
            baseNeg: document.getElementById('base-neg')?.value || '',

            upscaleOn: document.getElementById('toggle-upscale')?.checked || false,
            upscaleModel: document.getElementById('upscale-model')?.value || '',
            upscaleScale: document.getElementById('upscale-scale')?.value || '1.5',
            upscaleSteps: document.getElementById('upscale-steps')?.value || '10',

            detailerOn: document.getElementById('toggle-detailer')?.checked || false,
            detailerOpts: detailerOpts,

            mosaicOn: document.getElementById('toggle-mosaic')?.checked || false,
            mosaicOpts: mosaicOpts,

            standaloneCensorOpts: standaloneCensorOpts,

            resizerOpts: {
                mode: document.getElementById('resizer-mode')?.value || 'none',
                scale: document.getElementById('resizer-val-scale')?.value || '50',
                longest: document.getElementById('resizer-val-longest')?.value || '1024',
                width: document.getElementById('resizer-val-width')?.value || '512',
                height: document.getElementById('resizer-val-height')?.value || '512',
                format: document.getElementById('resizer-format')?.value || 'webp',
                quality: document.getElementById('resizer-quality')?.value || '85'
            },

            loraOpts: loraOpts,
            genMode: genModeInput ? genModeInput.value : 'txt2img',
            templatePath: document.getElementById('template-path')?.value || 'workflows/SD1.5/Base/V1',
            // 🐛 수정: '|| true'는 체크박스를 꺼서 .checked가 false가 돼도 "false || true" → true가
            // 돼버려서 이 설정을 절대 끌 수 없었음(항상 true로 저장됨). '??'는 null/undefined일 때만
            // 기본값(true)을 쓰고 false는 false 그대로 저장하므로 의도대로 동작함.
            civitaiMetadataOn: document.getElementById('toggle-civitai-metadata')?.checked ?? true,
            livePreviewCollapsed: document.getElementById('live-preview-body')?.classList.contains('collapsed') || false,

            advancedOpts: {
                dimensions: document.getElementById('adv-dimensions')?.value || '1024 x 1024  (square)',
                sampler: document.getElementById('adv-sampler')?.value || 'euler_ancestral',
                scheduler: document.getElementById('adv-scheduler')?.value || 'normal',
                steps: document.getElementById('adv-steps')?.value || '28',
                cfg: document.getElementById('adv-cfg')?.value || '5',
                seedRandom: document.getElementById('adv-seed-random')?.checked !== false,
                seed: document.getElementById('adv-seed')?.value || ''
            },

            /* generate.js의 let jobQueue는 로컬 변수이므로 getter 함수로 접근 */
            img2imgOn: document.getElementById('toggle-img2img')?.checked || false,
            img2imgDenoise: document.getElementById('img2img-denoise')?.value || '0.65',

            inpaintOn: document.getElementById('toggle-inpaint')?.checked || false,
            inpaintDenoise: document.getElementById('inpaint-denoise')?.value || '0.75',

            jobQueue: typeof getJobQueue === 'function' ? getJobQueue() : [],
            pathTemplate: document.getElementById('path-template')?.value || ''
        };
    }

    /**
     * 백엔드에서 불러온 JSON 객체를 바탕으로 화면(DOM) 설정값들을 채움.
     * 각 필드가 존재할 때만 해당 DOM 요소에 값을 반영한다.
     */
    applyState(state) {
        if (!state) return;

        /* 활성 탭 복원 */
        if (state.activeTab && window.UIManager) {
            window.UIManager.openTab(state.activeTab);
        }

        /* 전역 반복 횟수 */
        if (state.globalRepeatCount && document.getElementById('global-repeat-count')) {
            document.getElementById('global-repeat-count').value = state.globalRepeatCount;
            if (document.getElementById('global-repeat-count-str')) {
                document.getElementById('global-repeat-count-str').innerText = state.globalRepeatCount;
            }
        }

        /* 체크포인트 / 프롬프트 텍스트 */
        if (state.checkpoint && document.getElementById('gen-checkpoint')) {
            document.getElementById('gen-checkpoint').value = state.checkpoint;
        }
        if (state.basePos !== undefined && document.getElementById('base-pos')) {
            document.getElementById('base-pos').value = state.basePos;
        }
        if (state.baseNeg !== undefined && document.getElementById('base-neg')) {
            document.getElementById('base-neg').value = state.baseNeg;
        }

        /* 업스케일 설정 */
        if (state.upscaleOn !== undefined && document.getElementById('toggle-upscale')) {
            document.getElementById('toggle-upscale').checked = state.upscaleOn;
        }
        if (state.upscaleModel && document.getElementById('upscale-model')) document.getElementById('upscale-model').value = state.upscaleModel;
        if (state.upscaleSteps && document.getElementById('upscale-steps')) {
            document.getElementById('upscale-steps').value = state.upscaleSteps;
            if (document.getElementById('upscale-steps-val')) document.getElementById('upscale-steps-val').innerText = state.upscaleSteps;
        }
        const upscaleVal = state.upscaleScale || state.upscaleRatio;
        if (upscaleVal && document.getElementById('upscale-scale')) {
            document.getElementById('upscale-scale').value = upscaleVal;
        }

        /* 디테일러 설정 */
        if (state.detailerOn !== undefined && document.getElementById('toggle-detailer')) {
            document.getElementById('toggle-detailer').checked = state.detailerOn;
        }
        if (state.detailerOpts) {
            const dOpts = state.detailerOpts;
            if (dOpts.face !== undefined && document.getElementById('detailer-face-toggle')) document.getElementById('detailer-face-toggle').checked = dOpts.face;
            if (dOpts.eye !== undefined && document.getElementById('detailer-eye-toggle')) document.getElementById('detailer-eye-toggle').checked = dOpts.eye;
            if (dOpts.mouth !== undefined && document.getElementById('detailer-mouth-toggle')) document.getElementById('detailer-mouth-toggle').checked = dOpts.mouth;
            if (dOpts.hand !== undefined && document.getElementById('detailer-hand-toggle')) document.getElementById('detailer-hand-toggle').checked = dOpts.hand;
            if (dOpts.faceModel && document.getElementById('detailer-face-model')) document.getElementById('detailer-face-model').value = dOpts.faceModel;
            if (dOpts.eyeModel && document.getElementById('detailer-eye-model')) document.getElementById('detailer-eye-model').value = dOpts.eyeModel;
            if (dOpts.mouthModel && document.getElementById('detailer-mouth-model')) document.getElementById('detailer-mouth-model').value = dOpts.mouthModel;
            if (dOpts.handModel && document.getElementById('detailer-hand-model')) document.getElementById('detailer-hand-model').value = dOpts.handModel;
        }

        /* 모자이크 설정 */
        if (state.mosaicOn !== undefined && document.getElementById('toggle-mosaic')) {
            document.getElementById('toggle-mosaic').checked = state.mosaicOn;
        }
        if (state.mosaicOpts) {
            const mOpts = state.mosaicOpts;
            const mosaicChecks = ['nipples', 'pussy', 'penis', 'anus', 'testicles', 'xray', 'cross-section'];
            mosaicChecks.forEach(id => {
                if (mOpts[id] !== undefined && document.getElementById(`censor-${id}`)) {
                    document.getElementById(`censor-${id}`).checked = mOpts[id];
                }
            });
            if (mOpts.mode && document.getElementById('censor-mode')) {
                document.getElementById('censor-mode').value = mOpts.mode;
            }
            if (mOpts.intensity && document.getElementById('censor-intensity')) {
                document.getElementById('censor-intensity').value = mOpts.intensity;
                if (document.getElementById('censor-val')) document.getElementById('censor-val').innerText = mOpts.intensity;
            }
        }

        /* 단독 검열기 */
        if (state.standaloneCensorOpts) {
            const censorChecks = ['nipples', 'pussy', 'penis', 'anus', 'testicles', 'xray', 'cross-section'];
            censorChecks.forEach(id => {
                const el = document.getElementById(`tool-censor-${id}`);
                if (el) el.checked = state.standaloneCensorOpts[id] !== false;
            });
            if (state.standaloneCensorOpts.mode && document.getElementById('tool-censor-mode')) {
                document.getElementById('tool-censor-mode').value = state.standaloneCensorOpts.mode;
            }
            if (state.standaloneCensorOpts.intensity && document.getElementById('tool-censor-intensity')) {
                document.getElementById('tool-censor-intensity').value = state.standaloneCensorOpts.intensity;
                if (document.getElementById('tool-censor-val')) {
                    document.getElementById('tool-censor-val').innerText = state.standaloneCensorOpts.intensity;
                }
            }
        }

        /* 퀵 리사이저 */
        if (state.resizerOpts) {
            if (state.resizerOpts.mode && document.getElementById('resizer-mode')) {
                document.getElementById('resizer-mode').value = state.resizerOpts.mode;
                if (typeof toggleResizerInputs === 'function') toggleResizerInputs();
            }
            if (state.resizerOpts.scale && document.getElementById('resizer-val-scale')) document.getElementById('resizer-val-scale').value = state.resizerOpts.scale;
            if (state.resizerOpts.longest && document.getElementById('resizer-val-longest')) document.getElementById('resizer-val-longest').value = state.resizerOpts.longest;
            if (state.resizerOpts.width && document.getElementById('resizer-val-width')) document.getElementById('resizer-val-width').value = state.resizerOpts.width;
            if (state.resizerOpts.height && document.getElementById('resizer-val-height')) document.getElementById('resizer-val-height').value = state.resizerOpts.height;

            if (state.resizerOpts.format && document.getElementById('resizer-format')) {
                document.getElementById('resizer-format').value = state.resizerOpts.format;
                if (typeof toggleResizerQuality === 'function') toggleResizerQuality();
            }
            if (state.resizerOpts.quality && document.getElementById('resizer-quality')) {
                document.getElementById('resizer-quality').value = state.resizerOpts.quality;
                if (document.getElementById('resizer-quality-str')) {
                    document.getElementById('resizer-quality-str').innerText = state.resizerOpts.quality;
                }
            }
        }

        /* 생성 모드(단일/배치) 및 UI 토글 */
        if (state.genMode) {
            const modeRadio = document.querySelector(`input[name="gen-mode"][value="${state.genMode}"]`);
            if (modeRadio) {
                modeRadio.checked = true;
                if (typeof toggleGenMode === 'function') toggleGenMode();
            }
        }

        if (state.templatePath && document.getElementById('template-path')) {
            document.getElementById('template-path').value = state.templatePath;
        }

        if (state.civitaiMetadataOn !== undefined && document.getElementById('toggle-civitai-metadata')) {
            document.getElementById('toggle-civitai-metadata').checked = state.civitaiMetadataOn;
        }

        /* LoRA 복원: 로라 옵션 HTML이 로딩된 후에 실행되도록 약간 지연
           ⚠ 이 지연(최대 0.5초+재시도) 사이에 사용자가 다른 프리셋으로 바꾸거나
           main.js가 프리셋을 강제로 재적용하면, 그 시점 이후에 이 타이머가 뒤늦게 실행되면서
           지금 켜져있는(로라 없는) 프리셋 위에 예전(로라 있는) 상태를 그대로 덧씌워버리는
           경쟁 상태(race condition) 버그가 있었음 — window._presetAppliedAt 타임스탬프로
           "그 사이에 프리셋이 다시 적용됐는지"를 확인해서, 그랬으면 이 복원을 건너뛴다. */
        if (state.loraOpts && state.loraOpts.length > 0) {
            const loraRestoreScheduledAt = Date.now();
            const restoreLoras = () => {
                if (!window.loraOptionsHTML) { setTimeout(restoreLoras, 300); return; }
                if (window._presetAppliedAt && window._presetAppliedAt >= loraRestoreScheduledAt) {
                    console.log('[상태 복원] 그 사이 프리셋이 다시 적용되어, 오래된 로라 복원을 건너뜁니다.');
                    return;
                }
                state.loraOpts.forEach(lora => {
                    if (window.addLoraRow) window.addLoraRow();
                    const rows = document.querySelectorAll('#selected-loras .lora-item');
                    const lastRow = rows[rows.length - 1];
                    if (lastRow) {
                        const sel = lastRow.querySelector('select');
                        const inp = lastRow.querySelector('input[type="number"]');
                        if (sel) sel.value = lora.model;
                        if (inp) inp.value = lora.weight;
                    }
                });
            };
            setTimeout(restoreLoras, 500);
        }

        /* 고급 설정 복원 */
        if (state.advancedOpts) {
            const a = state.advancedOpts;
            if (a.dimensions && document.getElementById('adv-dimensions')) document.getElementById('adv-dimensions').value = a.dimensions;
            if (a.sampler && document.getElementById('adv-sampler')) document.getElementById('adv-sampler').value = a.sampler;
            if (a.scheduler && document.getElementById('adv-scheduler')) document.getElementById('adv-scheduler').value = a.scheduler;
            if (a.steps && document.getElementById('adv-steps')) document.getElementById('adv-steps').value = a.steps;
            if (a.cfg && document.getElementById('adv-cfg')) document.getElementById('adv-cfg').value = a.cfg;
            if (a.seedRandom !== undefined && document.getElementById('adv-seed-random')) {
                document.getElementById('adv-seed-random').checked = a.seedRandom;
                const seedInput = document.getElementById('adv-seed');
                if (seedInput) { seedInput.disabled = a.seedRandom; if (!a.seedRandom && a.seed) seedInput.value = a.seed; }
            }
        }

        /* 후처리 옵션: 활성화 되어있으면 자동 펼침 */
        const togglePairs = [
            ['toggle-upscale', 'upscale-opts'],
            ['toggle-detailer', 'detailer-opts'],
            ['toggle-mosaic', 'mosaic-opts']
        ];
        togglePairs.forEach(([toggleId, optsId]) => {
            const toggle = document.getElementById(toggleId);
            const opts = document.getElementById(optsId);
            if (toggle && opts) opts.style.display = toggle.checked ? 'block' : 'none';
        });

        /* 라이브 프리뷰 접힘 상태 */
        if (state.livePreviewCollapsed !== undefined) {
            const body = document.getElementById('live-preview-body');
            const container = document.getElementById('live-preview-container');
            const btn = document.getElementById('live-preview-toggle');
            if (body && state.livePreviewCollapsed) {
                body.classList.add('collapsed');
                if (container) container.classList.add('collapsed-mode');
                if (btn) btn.textContent = '▼ 펼치기';
            }
        }


        /* Img2Img 설정 복원 */
        if (state.img2imgOn !== undefined && document.getElementById("toggle-img2img")) {
            document.getElementById("toggle-img2img").checked = state.img2imgOn;
            const optsEl = document.getElementById("img2img-opts");
            if (optsEl) optsEl.style.display = state.img2imgOn ? "block" : "none";
        }
        if (state.img2imgDenoise) {
            const v = parseFloat(state.img2imgDenoise);
            const slider = document.getElementById("img2img-denoise");
            const num = document.getElementById("img2img-denoise-num");
            const val = document.getElementById("img2img-denoise-val");
            if (slider) slider.value = v;
            if (num) num.value = v.toFixed(2);
            if (val) val.innerText = v.toFixed(2);
            /* localStorage도 동기화 — index.html의 DOMContentLoaded 복원이
               나중에 다시 실행되더라도 항상 서버 값과 일치하도록 덮어씀 */
            try { localStorage.setItem('img2img-denoise', v); } catch(e) {}
        }

        /* Inpaint denoise 복원 */
        if (state.inpaintOn !== undefined && document.getElementById("toggle-inpaint")) {
            document.getElementById("toggle-inpaint").checked = state.inpaintOn;
            const optsEl = document.getElementById("inpaint-opts");
            if (optsEl) optsEl.style.display = state.inpaintOn ? "block" : "none";
        }
        if (state.inpaintDenoise) {
            const v = parseFloat(state.inpaintDenoise);
            const slider = document.getElementById("inpaint-denoise");
            const val = document.getElementById("inpaint-denoise-val");
            if (slider) slider.value = v;
            if (val) val.innerText = v.toFixed(2);
            /* localStorage도 동기화 — index.html의 DOMContentLoaded 복원이
               나중에 다시 실행되더라도 항상 서버 값과 일치하도록 덮어씀 */
            try { localStorage.setItem('inpaint-denoise', v); } catch(e) {}
        }
        /* 배치 큐 복원 (generate.js의 restoreJobQueue 브릿지 함수 사용) */
        if (state.jobQueue && Array.isArray(state.jobQueue)) {
            if (typeof restoreJobQueue === 'function') {
                restoreJobQueue(state.jobQueue);
            }
        }
        if (state.pathTemplate && document.getElementById('path-template')) {
            document.getElementById('path-template').value = state.pathTemplate;
        }
    }

    /**
     * 백엔드에서 저장된 상태를 불러온다.
     * 응답 형식: { status: "success", state: {...} } 또는 { status: "not_found" }
     * 실제 상태 객체(state)만 반환하며, 실패 시 null 반환.
     */
    async loadStateFromServer() {
        try {
            const data = await API.get('/assetmanager/api/load_state');
            if (data && data.status === 'success' && data.state) {
                return data.state;
            }
            console.warn("저장된 상태 없음 (status:", data?.status, ")");
            return null;
        } catch (e) {
            console.error("상태 로드 에러:", e);
        }
        return null;
    }

    /** 현재 화면 상태를 서버에 즉시 저장. 초기 로딩 중에는 덮어쓰기를 방지한다. */
    saveState() {
        if (!window.appStateLoaded) return;
        const state = this.getCurrentState();
        API.post('/assetmanager/api/save_state', state)
            .catch(err => console.error("상태 저장 실패:", err));
    }

    /** 0.5초 디바운싱이 적용된 저장 함수. input/change 이벤트에 주로 사용. */
    debounceSave() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        this.saveTimeout = setTimeout(() => {
            this.saveState();
        }, 500);
    }

    /** 타이머 대기 없이 즉시 저장. beforeunload 등 긴급 저장 시 사용. */
    flushSave() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }
        this.saveState();
    }
}

/* const는 window 속성을 만들지 않으므로 반드시 window에 명시적으로 할당 */
window.appStateManager = new AppStateManager();
