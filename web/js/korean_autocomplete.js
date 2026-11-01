/**
 * korean_autocomplete.js — 한글 → 단부루 태그 자동완성 모듈
 *
 * 적용 대상: #base-pos, #base-neg, #edit-prompt-value, #job-edit-prompt, .job-edit-frag (콤마로 구분된 태그 입력창)
 *
 * 동작:
 *  - 현재 커서가 위치한 "토큰"(콤마/줄바꿈으로 구분된 구간)을 추출해서
 *    한글 사전(tags_ko.json)과 비교한다.
 *  - 정확히 일치하는 한글 표현이 하나의 태그에만 대응되면 → 자동으로 영어 태그로 치환.
 *  - 정확히 일치하지만 여러 태그에 걸리면 → 후보 목록을 보여주고 직접 선택.
 *  - 정확히 일치하는 게 없으면 → 유사한(포함 관계) 표현들을 후보 목록으로 보여주고
 *    (자동 치환 없음) 사용자가 클릭/Enter로 직접 선택해야 삽입됨.
 *
 * 데이터 파일: tags_ko.json (같은 폴더, build_tags_ko.py로 autocomplete.csv에서 생성)
 *   형식: [["en태그", 사용횟수, "한글명"|null, ["키워드", ...]], ...]
 */

(function () {
    "use strict";

    const TARGET_SELECTOR = "#base-pos, #base-neg, #edit-prompt-value, #edit-negative-value, #job-edit-prompt, .job-edit-frag";
    const DATA_URL = "/assetmanager/static/js/tags_ko.json"; // 절대경로 (상대경로는 현재 페이지 주소 기준으로 풀려서 404 남)
    // 🆕 최대 후보 개수: 예전엔 8개라 "1개만 뜨는" 느낌이 들 정도로 적었음 → 넉넉하게 확대
    const MAX_SUGGESTIONS = 20;
    const MIN_FUZZY_LEN = 2; // 유사 검색을 시작할 최소 글자 수
    const DEBOUNCE_MS = 150;

    /** exactIndex: Map<한글표현, [{en, count}, ...]> (정확 일치용, ko명 + 키워드 모두 등록) */
    const exactIndex = new Map();
    /** allTerms: [{term, en, count}, ...] (유사 검색용 플랫 리스트) */
    let allTerms = [];
    /** allEnTags: [{en, count}, ...] (영어 태그 자동완성용) */
    let allEnTags = [];
    const enToKo = new Map(); // 🆕 영어 태그 → 한글명 (영어로 타이핑할 때 옆에 한글 뜻을 보여주기 위함)
    let dataReady = false;

    /** 공백을 제거해서 정규화 (띄어쓰기 차이 무시용) */
    function normalizeKo(str) {
        return str.replace(/\s+/g, "");
    }

    /**
     * 한글 어간 추출 — 마지막 음절의 어미/조사를 제거
     * 예: 감는 → 감, 씹다 → 씹, 눈을 → 눈, 달리는 → 달리
     */
    function extractStem(word) {
        if (!word || !isHangul(word)) return word;
        const suffixes = [
            // 긴 패턴 먼저
            "고있는", "고있음", "고있어", "하고있는", "하고있음",
            "는중인", "는중에", "는중",
            "하려는", "하려고", "하면서",
            "스러운", "스러워", "스럽게",
            "시키는", "시키기", "시킴",
            "하고있", "고있다", "하는중",
            // 2음절
            "하는", "하기", "하다", "하며", "하고", "하여", "한다", "했다",
            "되는", "되기", "되다", "되어", "된다", "됐다",
            "있는", "있기", "있다", "있어",
            "없는", "없기", "없다",
            "이는", "이기", "이다",
            "받는", "받기", "받다",
            "당하는", "당하기",
            // 1음절 어미/조사
            "는", "은", "을", "를", "이", "가", "의", "로", "에", "와", "과",
            "도", "만", "고", "며", "다", "기", "음", "어", "아",
            "던", "면",
        ];
        for (const suffix of suffixes) {
            if (word.endsWith(suffix) && word.length > suffix.length) {
                return word.slice(0, word.length - suffix.length);
            }
        }
        return word;
    }

    /**
     * 각 단어별 어간 추출 후 공백 제거해서 합침
     * 예: "눈을 감는" → ["눈","감"] → "눈감"
     *     "사과를 씹는" → ["사과","씹"] → "사과씹"
     */
    function stemNormalize(str) {
        return str.trim().split(/\s+/).map(extractStem).join("");
    }

    function addToIndex(term, en, count) {
        if (!term) return;

        // 1) 원본 등록
        let list = exactIndex.get(term);
        if (!list) { list = []; exactIndex.set(term, list); }
        if (!list.some((x) => x.en === en)) list.push({ en, count });

        // 2) 공백 제거 버전 등록
        const norm = normalizeKo(term);
        if (norm !== term) {
            let normList = exactIndex.get(norm);
            if (!normList) { normList = []; exactIndex.set(norm, normList); }
            if (!normList.some((x) => x.en === en)) normList.push({ en, count });
        }

        // 3) 어간 정규화 버전 등록 (어미/조사 제거 후 공백 제거)
        // 🐛 버그 수정: 이 어간추출은 "달리는"→"달리" 같은 동사/서술형 태그를 위한 것인데,
        // 1음절 어미 목록("기","이","가","다" 등)이 너무 흔해서, "미소기"(캐릭터명, Misogi)처럼
        // 우연히 그 글자로 끝나는 고유명사까지 "미소"로 뭉개버려 실제 "미소"(smile) 계열 태그와
        // 충돌 — 사용횟수가 높은 캐릭터 태그가 진짜 "미소"를 밀어내는 사고가 있었다(2026-09).
        // → en 태그에 \(...\) 프랜차이즈/캐릭터 구분자가 붙은 항목(고유명사/로마자 음역일 확률이
        // 매우 높음, danbooru 표기 관례)은 애초에 한국어 동사 활용형일 수 없으므로 어간추출 자체를 건너뜀.
        const isProperNounLike = /\\\(/.test(en);
        const stemmed = isProperNounLike ? term : stemNormalize(term);
        if (stemmed !== term && stemmed !== norm && stemmed.length > 0) {
            let stemList = exactIndex.get(stemmed);
            if (!stemList) { stemList = []; exactIndex.set(stemmed, stemList); }
            if (!stemList.some((x) => x.en === en)) stemList.push({ en, count });
        }

        allTerms.push({ term, en, count });
    }

    async function loadData() {
        try {
            const res = await fetch(DATA_URL, { cache: "force-cache" });
            if (!res.ok) throw new Error("HTTP " + res.status);
            const entries = await res.json();
            for (const [en, count, ko, kw] of entries) {
                if (ko) addToIndex(ko, en, count);
                if (Array.isArray(kw)) {
                    for (const k of kw) addToIndex(k, en, count);
                }
                // 영어 태그 자체를 별도 리스트에 등록
                allEnTags.push({ en, count: count || 0 });
                // 🆕 영어로 타이핑할 때도 옆에 한글 뜻을 같이 보여주기 위해 en → 한글명 매핑 저장
                if (ko && !enToKo.has(en)) enToKo.set(en, ko);
            }
            // 같은 한글 표현에 여러 태그가 매핑된 경우, 사용횟수 내림차순으로 정렬해둔다.
            for (const list of exactIndex.values()) {
                list.sort((a, b) => b.count - a.count);
            }
            dataReady = true;
            console.log(
                `[한글 자동완성] 로드 완료: ${entries.length}개 태그, ${exactIndex.size}개 한글 표현`
            );
        } catch (e) {
            console.error("[한글 자동완성] tags_ko.json 로드 실패:", e);
        }
    }

    /** 텍스트와 커서 위치를 받아 현재 콤마/줄바꿈 구간(토큰)의 [start, end, text]를 반환.
     *  end는 항상 cursor를 넘어가지 않는다 — 커서 뒤에 이미 입력된 단어가 있으면
     *  그 부분은 토큰에 포함시키지 않고 그대로 보존한다 (자동완성 확정 시 뒷단어가
     *  같이 지워지던 버그의 원인이었음). "콤마를 막 입력한 직후" 확정 케이스는
     *  cursor로 그 콤마 위치 자체가 넘어오므로 이 방식으로도 동일하게 동작한다.
     *  '(' 도 콤마/줄바꿈과 동일하게 왼쪽 경계로 취급한다 — (단어:1.2) 같은 강조 문법 안에서
     *  자동완성을 확정하면 여는 괄호까지 토큰에 포함되어 같이 지워지던 버그 방지. */
    function getCurrentToken(text, cursor) {
        let start = 0;
        for (let i = cursor - 1; i >= 0; i--) {
            const c = text[i];
            if (c === "," || c === "\n" || c === "(") {
                start = i + 1;
                break;
            }
        }
        const end = cursor;
        const raw = text.slice(start, end);
        const leftTrim = raw.match(/^\s*/)[0].length;
        const rightTrim = raw.match(/\s*$/)[0].length;
        const trimmedStart = start + leftTrim;
        const trimmedEnd = end - rightTrim;
        return {
            start: trimmedStart,
            end: trimmedEnd,
            text: text.slice(trimmedStart, trimmedEnd),
        };
    }

    function isHangul(str) {
        return /[\uac00-\ud7a3]/.test(str);
    }

    function getFuzzySuggestions(query) {
        const q = stemNormalize(query).toLowerCase();
        const scored = [];
        for (const { term, en, count } of allTerms) {
            const t = stemNormalize(term).toLowerCase();
            let score;
            if (t === q) continue; // 정확 일치는 별도 처리되므로 제외
            // 🆕 단어경계 일치: "은은한 미소"처럼 띄어쓰기로 나뉜 단어들 중 하나가 쿼리와
            // 완전히 같으면, 그냥 앞부분만 우연히 겹치는 복합어("미소년" 등)보다 훨씬 더
            // 관련성이 높다고 보고 최우선으로 취급한다. (stemNormalize는 공백을 없애버려서
            // t로는 단어경계를 알 수 없으므로, 공백이 살아있는 원본 term에서 따로 계산)
            const wordMatch = term
                .trim()
                .split(/\s+/)
                .some((w) => extractStem(w).toLowerCase() === q || w.toLowerCase() === q);
            if (wordMatch) score = 4;
            else if (t.startsWith(q)) score = 3;
            else if (t.includes(q)) score = 2;
            else if (q.includes(t)) score = 1;
            else continue;
            scored.push({ term, en, count, score });
        }
        scored.sort((a, b) => b.score - a.score || b.count - a.count);

        // en 태그 기준 중복 제거 (같은 태그가 여러 키워드로 여러 번 뜨는 것 방지)
        const seen = new Set();
        const result = [];
        for (const s of scored) {
            // 🆕 밑줄/공백만 다른 같은 태그도 한 번만 (먼저 나온 = 상위 순위 표기를 남김)
            const variantKey = tagVariantKey(s.en);
            if (seen.has(variantKey)) {
                // 🆕 이미 같은 태그(표기만 다름)가 목록에 있다면, 이번 표기가 사용횟수가 더 많거나
                // (같으면) 한글 뜻이 더 길 때만 그 자리에서 교체 (목록 내 순위 자리는 유지)
                const idx = result.findIndex(r => tagVariantKey(r.en) === variantKey);
                const curr = idx !== -1 ? result[idx] : null;
                const better = curr && ((s.count || 0) > (curr.count || 0) ||
                    ((s.count || 0) === (curr.count || 0) && tagDescLength(s.en) > tagDescLength(curr.en)));
                if (better) {
                    const ck = enToKo.get(s.en) || '';
                    result[idx] = { ...s, gloss: (ck && ck !== s.term) ? ck : '' };
                }
                continue;
            }
            seen.add(variantKey);
            // 🆕 매칭된 단어(term, 초록색으로 보이는 부분)와 그 태그의 "대표" 한글명이 다르면,
            // 대표 한글명도 gloss로 같이 보여준다. (영어로 칠 때는 이미 gloss가 붙어있었는데
            // 한글로 칠 때는 이 필드 자체가 항상 비어있어서 "!" 옆에 아무것도 안 붙어보였음)
            // 예: "미소"로 검색해서 keyword 매칭으로 뜬 항목이라도, 그 태그의 진짜 ko가
            // "은은한 미소"라면 그것도 같이 보여줘서 어떤 태그인지 바로 알 수 있게 함.
            const canonicalKo = enToKo.get(s.en) || '';
            const gloss = (canonicalKo && canonicalKo !== s.term) ? canonicalKo : '';
            result.push({ ...s, gloss });
            if (result.length >= MAX_SUGGESTIONS) break;
        }
        return result;
    }

    /** 영어 입력에 대한 태그 자동완성: 앞부분 일치 우선, 포함 일치 후순위.
     *  🆕 태그에 언더스코어(_)가 있어도, 사용자가 띄어쓰기로 쳐도 같은 걸로 인식하도록
     *  양쪽 다 "언더스코어→공백"으로 정규화해서 비교한다 (한쪽만 바꾸는 것보다 더 안전함 —
     *  사용자가 언더스코어를 그대로 쳐도, 띄어쓰기로 쳐도 둘 다 매칭됨). */
    function normalizeTagForMatch(s) {
        return s.toLowerCase().replace(/_/g, ' ');
    }

    /* ──────────────────────────────────────────────
       🆕 표기 변형 중복 합치기: tags_ko.json에 "smile gesture"와 "smile_gesture"처럼
       밑줄(_)만 다른 같은 태그가 따로 들어있으면, 후보 목록에 둘이 따로 떠서 헷갈리고
       (한글 정확일치도 "후보 2개"로 잡혀 자동 치환이 안 됨) → 같은 태그는 하나로 합친다.
       어느 표기를 남길지 (위에서부터 우선순위):
         1) 사용횟수(count)가 더 많은 쪽
         2) 사용횟수가 같으면: 한글 뜻(설명)이 더 긴 쪽 (한쪽에만 뜻이 있으면 그쪽)
         3) 그래도 같으면: 입력 중인 글자에 "_"가 있으면 밑줄 표기, 띄어쓰기가 있으면 공백 표기
         4) 그래도 못 정하면(한 단어만 침, 한글 입력 등): DEFAULT_TAG_FORM 설정을 따름
       DEFAULT_TAG_FORM: 'count'(사용횟수 많은 쪽) | 'space'(공백 표기) | 'underscore'(밑줄 표기)
       ────────────────────────────────────────────── */
    // 🆕 환경설정 탭에서 바꿀 수 있게: am_app_settings_v1(localStorage, library.js의 AppSettings가
    // 관리하는 바로 그 키)에 저장된 값이 있으면 그걸 우선 쓰고, 없으면 기존 기본값('count')을 씀.
    let DEFAULT_TAG_FORM = 'count';
    try {
        const savedSettings = JSON.parse(localStorage.getItem('am_app_settings_v1') || '{}');
        if (savedSettings && ['count', 'space', 'underscore'].includes(savedSettings.defaultTagForm)) {
            DEFAULT_TAG_FORM = savedSettings.defaultTagForm;
        }
    } catch (e) { /* 저장된 값이 깨져있으면 그냥 기본값 사용 */ }

    /** 설정 탭에서 즉시 반영되도록 외부에서 호출 가능한 setter(새로고침 불필요). */
    window.setDefaultTagForm = function (val) {
        if (['count', 'space', 'underscore'].includes(val)) DEFAULT_TAG_FORM = val;
    };

    function tagVariantKey(en) {
        return String(en || '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    }

    /** query(사용자가 치던 글자)를 보고 선호 표기를 정한다: 'underscore' | 'space' | null(판단 불가) */
    function preferredFormFromQuery(query) {
        if (/_/.test(query || '')) return 'underscore';
        if (/\s/.test((query || '').trim())) return 'space';
        return null;
    }

    /** 이 영어 태그에 등록된 한글 뜻(설명)의 길이. 없으면 0. (표기 변형 중 "설명이 더 긴 쪽" 판정용) */
    function tagDescLength(en) {
        return (enToKo.get(en) || '').length;
    }

    /** items(순위 순서 유지, 각 항목에 .en 필요)에서 같은 태그의 표기 변형을 하나로 합친다.
     *  대표 선정: ① 사용횟수 최다 → ② 동률이면 한글 뜻이 가장 긴 것 → ③ 동률이면 선호 표기(입력한 글자 기준)
     *  → ④ DEFAULT_TAG_FORM → ⑤ 가장 앞(상위 순위) 것. */
    function collapseTagVariants(items, preferredForm) {
        const groups = new Map(); // key → [items...] (처음 등장 순서 유지)
        for (const it of items) {
            const k = tagVariantKey(it.en);
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(it);
        }
        const form = preferredForm || (DEFAULT_TAG_FORM === 'space' ? 'space' : DEFAULT_TAG_FORM === 'underscore' ? 'underscore' : null);
        const out = [];
        for (const members of groups.values()) {
            let rep = members[0];
            if (members.length > 1) {
                // ① 사용횟수가 가장 많은 것들만 후보로 추림
                const maxCount = Math.max(...members.map(m => m.count || 0));
                let cands = members.filter(m => (m.count || 0) === maxCount);
                // ② 사용횟수가 같은 후보들 중 한글 뜻(설명)이 가장 긴 것들만 남김 (아무도 뜻이 없으면 그대로)
                if (cands.length > 1) {
                    const maxLen = Math.max(...cands.map(m => tagDescLength(m.en)));
                    if (maxLen > 0) cands = cands.filter(m => tagDescLength(m.en) === maxLen);
                }
                rep = cands[0]; // ⑤ 기본: 후보 중 가장 앞(상위 순위)
                if (cands.length > 1) {
                    // ③④ 횟수·설명 길이까지 같은 후보들 사이에서만 표기 선호를 적용
                    if (form === 'underscore') rep = cands.find(m => m.en.includes('_')) || rep;
                    else if (form === 'space') rep = cands.find(m => !m.en.includes('_')) || rep;
                }
            }
            out.push(rep);
        }
        return out;
    }

    /** 한글 정확일치 조회(원본/공백제거/어간 순)를 하고, 표기 변형은 합쳐서 돌려준다. 없으면 null. */
    function lookupExact(query) {
        const raw = exactIndex.get(query) || exactIndex.get(normalizeKo(query)) || exactIndex.get(stemNormalize(query));
        if (!raw || !raw.length) return null;
        return collapseTagVariants(raw, null);
    }

    function getEnSuggestions(query) {
        const q = normalizeTagForMatch(query);
        const starts = [];
        const includes = [];
        for (const { en, count } of allEnTags) {
            const t = normalizeTagForMatch(en);
            if (t === q) continue; // 완전 일치는 이미 입력된 것
            if (t.startsWith(q)) starts.push({ en, count });
            else if (t.includes(q)) includes.push({ en, count });
        }
        starts.sort((a, b) => b.count - a.count);
        includes.sort((a, b) => b.count - a.count);
        // 🆕 term은 계속 빈 채로(정확도 매칭 표시용이 아니므로), gloss에 한글 뜻을 따로 담아서 보여줌
        const merged = [...starts, ...includes].map(x => ({ en: x.en, term: '', gloss: enToKo.get(x.en) || '', count: x.count }));
        // 🆕 "smile gesture" / "smile_gesture" 같은 표기 변형은 하나로 합친 뒤 개수 제한을 건다
        return collapseTagVariants(merged, preferredFormFromQuery(query)).slice(0, MAX_SUGGESTIONS);
    }

    /* ────────────────────────────────────────────
       드롭다운 UI
       ──────────────────────────────────────────── */

    let dropdownEl = null;
    let activeTextarea = null;
    let activeToken = null; // {start, end, text}
    let highlightIndex = -1;

    function ensureStyles() {
        if (document.getElementById("ko-autocomplete-style")) return;
        const style = document.createElement("style");
        style.id = "ko-autocomplete-style";
        style.textContent = `
            .ko-ac-dropdown {
                position: fixed;
                z-index: 99999;
                background: #2b2b2b;
                border: 1px solid #555;
                border-radius: 6px;
                box-shadow: 0 4px 14px rgba(0,0,0,0.5);
                max-height: 240px;
                overflow-y: auto;
                font-size: 13px;
                min-width: 220px;
            }
            .ko-ac-item {
                padding: 6px 10px;
                cursor: pointer;
                color: #eee;
                display: flex;
                justify-content: space-between;
                gap: 10px;
                white-space: nowrap;
            }
            .ko-ac-item:hover, .ko-ac-item.active {
                background: #4CAF50;
                color: #111;
            }
            .ko-ac-item .ko-ac-en {
                font-weight: 600;
            }
            .ko-ac-item .ko-ac-term {
                color: #9ad29a;
                font-size: 11px;
            }
            .ko-ac-item.active .ko-ac-term {
                color: #205020;
            }
            .ko-ac-item .ko-ac-gloss {
                color: #7fb3ff;
                font-size: 11px;
                margin-left: auto;
            }
            .ko-ac-item.active .ko-ac-gloss {
                color: #16305a;
            }
        `;
        document.head.appendChild(style);
    }

    function closeDropdown() {
        if (dropdownEl) {
            dropdownEl.remove();
            dropdownEl = null;
        }
        activeToken = null;
        highlightIndex = -1;
    }

    function renderDropdown(items, textarea, token, fromExactAmbiguous) {
        ensureStyles();
        closeDropdown();
        if (!items.length) return;

        activeTextarea = textarea;
        activeToken = token;
        highlightIndex = -1;

        dropdownEl = document.createElement("div");
        dropdownEl.className = "ko-ac-dropdown";

        items.forEach((item, idx) => {
            const row = document.createElement("div");
            row.className = "ko-ac-item";
            row.dataset.index = String(idx);
            const enSpan = document.createElement("span");
            enSpan.className = "ko-ac-en";
            enSpan.textContent = item.en;
            const termSpan = document.createElement("span");
            termSpan.className = "ko-ac-term";
            termSpan.textContent = fromExactAmbiguous ? "" : item.term;
            row.appendChild(enSpan);
            row.appendChild(termSpan);
            // 🆕 영어 태그 자동완성일 때 옆에 한글 뜻을 같이 보여줌 (term과는 별개 — term은
            // "어떤 한글 키워드로 매칭됐는지" 표시용이고, gloss는 "이 영어 태그의 한글 뜻" 자체)
            if (item.gloss) {
                const glossSpan = document.createElement("span");
                glossSpan.className = "ko-ac-gloss";
                glossSpan.textContent = item.gloss;
                row.appendChild(glossSpan);
            }
            row.addEventListener("mousedown", (e) => {
                // mousedown으로 처리해야 textarea의 blur보다 먼저 실행됨
                e.preventDefault();
                applySelection(item.en);
            });
            dropdownEl.appendChild(row);
        });

        document.body.appendChild(dropdownEl);
        positionDropdown(textarea);
    }

    function positionDropdown(textarea) {
        if (!dropdownEl) return;
        const rect = textarea.getBoundingClientRect();
        dropdownEl.style.left = rect.left + "px";
        dropdownEl.style.top = rect.bottom + 4 + "px";
        dropdownEl.style.width = Math.max(rect.width, 220) + "px";
    }

    function applySelection(enTag) {
        if (!activeTextarea || !activeToken) return;
        const ta = activeTextarea;
        const { start, end } = activeToken;
        const text = ta.value;
        const before = text.slice(0, start);
        const after = text.slice(end);
        // after가 이미 콤마로 시작하거나, ")"/(강조 문법의) ":"로 이어지는 경우엔 콤마를 넣지 않는다.
        // 예: "(귀여운" → "(cute" 확정 시 "(cute)"가 되어야지 "(cute, )"가 되면 안 됨.
        const suffix = /^\s*[,):]/.test(after) ? "" : ", ";
        const newText = before + enTag + suffix + after;
        ta.value = newText;
        const newCursor = (before + enTag + suffix).length;
        ta.setSelectionRange(newCursor, newCursor);
        ta.focus();
        // 다른 모듈(저장/프리뷰 등)이 input 이벤트를 듣고 있을 수 있으므로 디스패치
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        closeDropdown();
    }

    function moveHighlight(delta) {
        if (!dropdownEl) return;
        const items = dropdownEl.querySelectorAll(".ko-ac-item");
        if (!items.length) return;
        highlightIndex = (highlightIndex + delta + items.length) % items.length;
        items.forEach((el, i) => el.classList.toggle("active", i === highlightIndex));
        items[highlightIndex].scrollIntoView({ block: "nearest" });
    }

    function selectHighlighted() {
        if (!dropdownEl || highlightIndex < 0) return false;
        const items = dropdownEl.querySelectorAll(".ko-ac-item");
        const el = items[highlightIndex];
        if (!el) return false;
        const idx = Number(el.dataset.index);
        const enSpan = el.querySelector(".ko-ac-en");
        applySelection(enSpan.textContent);
        return true;
    }

    /* ────────────────────────────────────────────
       메인 입력 처리
       ──────────────────────────────────────────── */

    let debounceTimer = null;

    function handleInput(e) {
        const ta = e.target;
        if (!ta.matches(TARGET_SELECTOR)) return;
        if (!dataReady) return;

        // 콤마나 줄바꿈을 "지금 막" 입력한 경우 → 그 직전 토큰을 확정 처리(자동 치환 가능)
        const isDelimiterJustTyped =
            (e.inputType === "insertText" && e.data === ",") ||
            e.inputType === "insertLineBreak" ||
            (e.inputType === "insertText" && e.data === "\n");

        clearTimeout(debounceTimer);
        if (isDelimiterJustTyped) {
            finalizeJustClosedToken(ta);
        } else {
            debounceTimer = setTimeout(() => liveProcess(ta), DEBOUNCE_MS);
        }
    }

    /** 타이핑 중(아직 확정 전): 후보만 보여줄 뿐, 절대 자동 치환하지 않음 */
    function liveProcess(ta) {
        const cursor = ta.selectionStart;
        const token = getCurrentToken(ta.value, cursor);
        const query = token.text;

        if (!query) {
            closeDropdown();
            return;
        }

        // 영어 입력 처리 (한글이 아닌 경우)
        if (!isHangul(query)) {
            if (query.length >= 2) {
                const enSuggestions = getEnSuggestions(query);
                renderDropdown(enSuggestions, ta, token, true);
            } else {
                closeDropdown();
            }
            return;
        }

        const exact = lookupExact(query);
        if (exact && exact.length) {
            const items = exact.map((x) => { const canonicalKo = enToKo.get(x.en) || ''; return { en: x.en, term: query, count: x.count, gloss: (canonicalKo && canonicalKo !== query) ? canonicalKo : '' }; });
            renderDropdown(items, ta, token, true);
            highlightIndex = 0; // Enter/Tab으로 바로 확정할 수 있도록 1순위 미리 하이라이트
            updateHighlightClass();
            return;
        }

        if (query.length >= MIN_FUZZY_LEN) {
            const suggestions = getFuzzySuggestions(query);
            renderDropdown(suggestions, ta, token, false);
        } else {
            closeDropdown();
        }
    }

    /** 콤마/줄바꿈으로 막 닫힌 토큰을 확정 처리: 정확 일치 1개면 자동 치환, 그 외엔 후보만 표시 */
    function finalizeJustClosedToken(ta) {
        const text = ta.value;
        const cursor = ta.selectionStart; // 구분자 바로 다음 위치
        const delimiterPos = cursor - 1; // 방금 입력된 ',' 또는 '\n'의 위치
        if (delimiterPos < 0) return;

        const token = getCurrentToken(text, delimiterPos);
        const query = token.text;

        if (!query) {
            closeDropdown();
            return;
        }

        // 영어 입력 처리 (한글이 아닌 경우)
        if (!isHangul(query)) {
            if (query.length >= 2) {
                const enSuggestions = getEnSuggestions(query);
                renderDropdown(enSuggestions, ta, token, true);
            } else {
                closeDropdown();
            }
            return;
        }

        const exact = lookupExact(query);
        if (exact && exact.length === 1) {
            activeTextarea = ta;
            activeToken = token;
            applySelection(exact[0].en);
            return;
        }
        if (exact && exact.length > 1) {
            const items = exact.map((x) => { const canonicalKo = enToKo.get(x.en) || ''; return { en: x.en, term: query, count: x.count, gloss: (canonicalKo && canonicalKo !== query) ? canonicalKo : '' }; });
            renderDropdown(items, ta, token, true);
            return;
        }

        if (query.length >= MIN_FUZZY_LEN) {
            const suggestions = getFuzzySuggestions(query);
            renderDropdown(suggestions, ta, token, false);
        } else {
            closeDropdown();
        }
    }

    function updateHighlightClass() {
        if (!dropdownEl) return;
        const items = dropdownEl.querySelectorAll(".ko-ac-item");
        items.forEach((el, i) => el.classList.toggle("active", i === highlightIndex));
    }

    function handleKeydown(e) {
        if (!dropdownEl) return;
        if (!e.target.matches(TARGET_SELECTOR)) return;

        if (e.key === "ArrowDown") {
            e.preventDefault();
            moveHighlight(1);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            moveHighlight(-1);
        } else if (e.key === "Enter") {
            if (selectHighlighted()) {
                e.preventDefault();
            }
        } else if (e.key === "Escape") {
            closeDropdown();
        }
    }

    function handleScrollResize() {
        if (dropdownEl && activeTextarea) positionDropdown(activeTextarea);
    }

    function handleDocClick(e) {
        if (dropdownEl && !dropdownEl.contains(e.target) && e.target !== activeTextarea) {
            closeDropdown();
        }
    }

    document.addEventListener("input", handleInput);
    document.addEventListener("keydown", handleKeydown);
    document.addEventListener("click", handleDocClick);
    document.addEventListener(
        "focusout",
        (e) => {
            if (!e.target.matches || !e.target.matches(TARGET_SELECTOR)) return;
            // 드롭다운 항목 클릭으로 인한 blur는 그쪽 mousedown 핸들러가 이미 처리하므로 건드리지 않음
            if (dropdownEl && dropdownEl.contains(document.activeElement)) return;
            finalizeOnBlur(e.target);
        },
        true
    );
    window.addEventListener("scroll", handleScrollResize, true);
    window.addEventListener("resize", handleScrollResize);

    function finalizeOnBlur(ta) {
        if (!dataReady) return;
        const cursor = ta.selectionStart;
        const token = getCurrentToken(ta.value, cursor);
        const query = token.text;
        if (!query || !isHangul(query)) {
            closeDropdown();
            return;
        }
        const exact = lookupExact(query);
        if (exact && exact.length === 1) {
            activeTextarea = ta;
            activeToken = token;
            applySelection(exact[0].en);
        } else {
            closeDropdown();
        }
    }

    loadData();
})();
