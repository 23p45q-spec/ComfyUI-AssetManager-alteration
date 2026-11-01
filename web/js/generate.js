/**
 * generate.js — 이미지 생성 및 대기열 관리 모듈 (재작성본)
 * ComfyUI 워크플로우 기반의 이미지 생성(단일/배치)과
 * 웹소켓을 통한 실시간 진행률·라이브 프리뷰 처리를 담당합니다.
 * 동적 파이프라인(업스케일/디테일러/검열)의 조합 및
 * 배치 큐 관리 UI도 이 모듈에서 제어합니다.
 *
 * [재작성 시 수정된 버그]
 * 1. posPrompt/negPrompt 인자가 실제로 워크플로우 노드에 주입되지 않던 문제 → 수정
 * 2. VAE 교체 시 [Detailer] ToDetailerPipe 노드(115,128,134,140)까지 잘못 건드려
 *    clip 연결이 끊기던 문제 → VAEDecode/Encode 노드만 정확히 교체하도록 수정
 * 3. 별도 CLIPLoader(gen-clip)를 선택했을 때 실제로 워크플로우에 반영되지 않던 문제 → 추가
 *
 * [추가됨] 아키텍처 프리셋 (SDXL / Anima)
 * 4. gen-architecture 드롭다운 값(sdxl|anima)에 따라 체크포인트 로딩 경로를 분기.
 *    Anima(NVIDIA Cosmos 기반 DiT, Qwen-3 0.6B 텍스트 인코더)는
 *    CheckpointLoaderSimple이 아니라 UNETLoader + CLIPLoader + VAELoader 조합을 쓰며,
 *    [Main] Sampling(90, ModelSamplingDiscrete/eps)과 [Main] Clip(89, CLIPSetLastLayer)은
 *    둘 다 SDXL 전용 개념이라 Anima 그래프에서는 완전히 우회한다.
 *    (실측 확인됨 — anima-preview3-base.safetensors + qwen_3_06b_base.safetensors + qwen_image_vae.safetensors:
 *     UNETLoader→KSampler 직결, CLIPSetLastLayer 미사용, CLIPLoader type 값은 "qwen_image"
 *     (Anima 텍스트 인코더가 Qwen-Image와 동일한 방식이라 이 값이 맞음, "stable_diffusion" 아님).
 *     샘플러: 표준 KSampler 기준 euler_ancestral + scheduler simple 조합으로 정상 동작 확인됨.
 *     (Comfyui-anima-sampler 노드팩의 AnimaFlowCorrectiveSampler로 바꾸면 더 정확한 flow-matching
 *     샘플링 가능 — flow_solver=flow_unipc2_x0, flow_schedule=flow_rf_linear_shift, flow_shift=5.0,
 *     cfg=7.0, steps=35. 단 노드팩 버전에 따라 fix_empty_latent_channels 관련 호환성 문제가
 *     있을 수 있으니 노드팩을 최신으로 유지할 것.)
 * ✅ Upscaler/Detailer(109,115,128,134,140)의 model/vae를 unet_custom_001/vae_custom_001로
 *    통일해서 SDXL 체크포인트 직접 참조 버그 수정 완료 (아래 코드 참고).
 */

let jobQueue = [];
window.isGenerationCancelled = false;

/* ──────────────────────────────────────────────
   🚫 프롬프트 무력화 (특정 키워드를 생성 시에만 일시적으로 제외)
   원본 조각/라이브러리 데이터는 전혀 건드리지 않고,
   실제 ComfyUI로 보내는 최종 프롬프트를 조립하는 시점에만 필터링한다.
   ────────────────────────────────────────────── */

/** localStorage에서 무력화 키워드 목록을 읽어온다 */
function getDisabledTokens() {
    try {
        const raw = localStorage.getItem('am_disabled_tokens');
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch (e) {
        return [];
    }
}

/** 무력화 키워드 목록을 localStorage에 저장 */
function setDisabledTokens(tokens) {
    try {
        localStorage.setItem('am_disabled_tokens', JSON.stringify(tokens));
    } catch (e) {}
}

/** "(단어:1.2)", "((단어))", "[단어]" 같은 가중치/강조 문법을 벗겨서 순수 텍스트만 남긴다 */
function stripWeightSyntax(tag) {
    let t = (tag || '').trim();
    let prev;
    do {
        prev = t;
        t = t.replace(/^\(+\s*/, '').replace(/\s*\)+$/, '');
        t = t.replace(/^\[+\s*/, '').replace(/\s*\]+$/, '');
        t = t.replace(/^\{+\s*/, '').replace(/\s*\}+$/, '');
    } while (t !== prev);
    t = t.replace(/:\s*[\d.]+\s*$/, ''); // 끝에 붙은 :1.2 같은 가중치 숫자 제거
    return t.trim();
}

/**
 * 프롬프트 문자열(콤마로 구분된 태그들)에서, 지정한 목록에 정확히(대소문자 무시,
 * 가중치/괄호 문법 무시) 일치하는 태그만 걸러내고 나머지는 그대로 이어붙여 반환한다.
 * 목록이 비어있으면 원본 그대로 반환. (전역 무력화/조각 전용 무효화가 이 함수를 공유)
 */
function filterTokensFromPromptByList(promptStr, tokenList) {
    if (!tokenList || !tokenList.length || !promptStr) return promptStr;
    const tokenListLower = tokenList.map(t => stripWeightSyntax(t).toLowerCase());
    return promptStr
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0 && !tokenListLower.includes(stripWeightSyntax(t).toLowerCase()))
        .join(', ');
}

/**
 * 프롬프트 문자열(콤마로 구분된 태그들)에서, 무력화 목록에 정확히(대소문자 무시,
 * 가중치/괄호 문법 무시) 일치하는 태그만 걸러내고 나머지는 그대로 이어붙여 반환한다.
 * 무력화 목록이 비어있으면 원본 그대로 반환.
 */
function applyDisabledTokens(promptStr) {
    return filterTokensFromPromptByList(promptStr, getDisabledTokens());
}

/**
 * 🆕 조각 전용 키워드 무효화: 이 조각을 쓸 때만, 공통 긍정/부정 프롬프트 중 지정한 키워드를
 * 최종 프롬프트 조립 시점에 제외한다. (원본 base-pos/base-neg 입력창 값은 전혀 안 건드림)
 * 예: 출력하려는 게 "사과"인데 공통 부정프롬프트에 "과일"이 들어있으면, 이 조각의
 * 부정프롬프트 무효화 키워드에 "과일"을 넣어두면 이 조각으로 생성할 때만 부정프롬프트에서
 * "과일"이 빠진다 (다른 조각으로 생성할 땐 그대로 "과일"이 부정프롬프트에 남아있음).
 * tokensCsv: "과일, 열매" 처럼 콤마로 구분된 문자열. 비어있으면 원본 그대로 반환.
 */
function applyItemTokenInvalidation(promptStr, tokensCsv) {
    if (!tokensCsv) return promptStr;
    const tokenList = tokensCsv.split(',').map(t => t.trim()).filter(Boolean);
    return filterTokensFromPromptByList(promptStr, tokenList);
}

/* ──────────────────────────────────────────────
   🔀 이 조각 전용 "조건부 프롬프트 변화" (item.condRules)
   예: "apple"이 긍정프롬프트에 있으면 → "red clothes"를 추가, "orange"가 있으면 → "orange clothes" 추가.
   규칙 하나 = { when: "apple, red apple", add: "red clothes", remove: "white dress" }
     - when  : 콤마로 여러 개 가능(하나라도 있으면 발동). 대소문자/밑줄(_)/가중치 문법 무시.
               태그 안에 그 단어(구)가 "단어 단위"로 들어있으면 일치 ("orange" → "orange hair"도 일치, "oranges"는 불일치)
     - add   : 발동하면 긍정프롬프트 맨 뒤에 추가 (이미 같은 태그가 있으면 중복 추가 안 함)
     - remove: (선택) 발동하면 이 태그들은 긍정프롬프트에서 제거 — 기존 옷 색 같은 걸 "대체"하고 싶을 때
   ⚠️ 판정 기준은 "최종 조립된 긍정프롬프트"(공통+행동+모든 조각) — 다른 조각에 들어있는 단어도 인식함.
   ⚠️ 규칙끼리 연쇄 발동하지 않음(한 번에 원본 기준으로 판정). 이 조각이 포함된 job에서만 적용됨.
   ────────────────────────────────────────────── */
function _condNorm(s) {
    return stripWeightSyntax(s || '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}
function _condKeywordMatchesTag(tagNorm, kwNorm) {
    if (!tagNorm || !kwNorm) return false;
    const esc = kwNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^\\p{L}\\p{N}])' + esc + '($|[^\\p{L}\\p{N}])', 'u').test(tagNorm);
}
function applyItemConditionalRules(promptStr, rules) {
    if (!promptStr || !Array.isArray(rules) || rules.length === 0) return promptStr;
    const tags = promptStr.split(',').map(t => t.trim()).filter(Boolean);
    const tagsNorm = tags.map(_condNorm);
    const removeSet = new Set();
    const adds = [];
    rules.forEach(rule => {
        const kws = String(rule.when || '').split(',').map(_condNorm).filter(Boolean);
        if (kws.length === 0) return;
        const hit = kws.some(kw => tagsNorm.some(t => _condKeywordMatchesTag(t, kw)));
        if (!hit) return;
        String(rule.remove || '').split(',').map(_condNorm).filter(Boolean).forEach(r => removeSet.add(r));
        String(rule.add || '').split(',').map(t => t.trim()).filter(Boolean).forEach(a => adds.push(a));
    });
    if (removeSet.size === 0 && adds.length === 0) return promptStr;
    const kept = tags.filter((_, i) => !removeSet.has(tagsNorm[i]));
    const keptNorm = new Set(kept.map(_condNorm));
    adds.forEach(a => {
        const n = _condNorm(a);
        if (!keptNorm.has(n)) { kept.push(a); keptNorm.add(n); }
    });
    return kept.join(', ');
}

/**
 * 🧱 이 조각 전용 "카테고리 차단" (item.blockCategories): 이 조각을 쓸 때만, 최종 긍정프롬프트에서
 * 지정한 카테고리(예: 의상/패션, 얼굴)로 분류되는 태그를 전부 제외한다. 분류는 프롬프트 색 미리보기와
 * 똑같은 classifyPromptTag()를 쓴다. (공통/행동/다른 조각/이 조각 자신의 태그 모두 대상)
 * cats가 비어있으면 원본 그대로 반환.
 *
 * 🐛 버그 수정: "red shirt"(색상+의상/패션), "hand in apple"(신체/외형+사물/아이템)처럼
 * 다중 색상 배지로 두 개 이상의 카테고리로 쪼개져 보이는 태그는, classifyPromptTag()(태그 전체를
 * "한 카테고리"로만 판정)로는 둘 중 하나만 잡히고 나머지 카테고리는 아예 안 걸렸었다
 * (예: "hand in apple"은 classifyPromptTag로는 통째로 "신체/외형"만 반환되는데, 실제로는
 * "apple" 부분이 사물/아이템이라 화면에도 두 색으로 나뉘어 보임 — 그런데 "사물/아이템"을
 * 차단해도 "신체/외형" 판정에 가려져서 이 태그가 전혀 안 걸러지고 있었음).
 * classifyPromptTagSegments()(배지 렌더링에 쓰는 바로 그 함수)로 태그를 세그먼트 단위로 쪼개서,
 * 그 세그먼트들 중 하나라도 차단 대상 카테고리면 태그 전체를 제외하도록 바꿨다.
 */
function applyItemCategoryBlock(promptStr, cats) {
    if (!promptStr || !Array.isArray(cats) || cats.length === 0) return promptStr;
    if (typeof classifyPromptTag !== 'function') return promptStr;
    const blocked = new Set(cats);
    return promptStr
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0 && !tagHasBlockedCategory(t, blocked))
        .join(', ');
}

/** 태그 하나가 가진 모든 세그먼트(다중 색상 배지와 동일한 분해 결과) 중 하나라도 blocked 안에
 *  있으면 true. classifyPromptTagSegments가 없으면(아주 예외적인 로딩 순서 문제 등) 기존처럼
 *  classifyPromptTag 단일 결과로 폴백. */
function tagHasBlockedCategory(tag, blocked) {
    const segments = (typeof classifyPromptTagSegments === 'function')
        ? classifyPromptTagSegments(tag)
        : [classifyPromptTag(tag)];
    return segments.some(seg => blocked.has(getCanonicalPromptCategoryName(seg.name)));
}

/** classifyPromptTag의 "영어 키워드 폴백"(tags_ko.json에 없는 태그용)은 "의상"/"감정"처럼 짧은 이름을 돌려주는데,
 *  카테고리 목록(PROMPT_CATEGORY_COLORS)의 이름은 "의상/패션"/"표정/감정"이라 서로 안 맞는다.
 *  카테고리 차단은 목록 이름 기준이므로, 폴백 이름을 목록 이름으로 통일해서 비교한다. */
const PROMPT_CATEGORY_NAME_ALIASES = { '감정': '표정/감정', '구도': '구도/스타일', '배경': '배경/장소', '행동': '행동/포즈', '의상': '의상/패션' };
function getCanonicalPromptCategoryName(name) {
    return PROMPT_CATEGORY_NAME_ALIASES[name] || name;
}
/** 🐛 수정 전 이름 그대로 유지 — 다른 곳에서 이 이름으로 이미 쓰고 있을 수 있어 하위호환용으로 남겨둠. */
function getCanonicalPromptCategory(tag) {
    return getCanonicalPromptCategoryName(classifyPromptTag(tag).name);
}

/** 📷 카메라 구도(공통 긍정프롬프트 옆 "📷 구도" 팝업) 연동: 최종 긍정프롬프트에 대해
 *  ① 끈 구도 태그(태그별 무효화 / 전부 무효화)를 빼고 ② "생성에 자동 적용"이 켜져 있으면 이 도구의 구도를 맨 뒤에 붙인다.
 *  (아무것도 안 켜져 있거나 도구가 없으면 원본 그대로. "프리셋 랜덤"이면 불릴 때마다 프리셋을 새로 뽑음 = 생성할 때마다 다른 구도)
 *  구도 인식/무효화/계산은 tools_camera.js(applyCameraCompositionToPrompt)가 담당한다. */
function applyCameraComposition(promptStr) {
    if (typeof applyCameraCompositionToPrompt !== 'function') return promptStr;
    try { return applyCameraCompositionToPrompt(promptStr); } catch (e) { return promptStr; }
}

/** 🙈 얼굴 관련 태그로 간주할 키워드 목록 (부분 일치, 소문자 비교). danbooru식 태그 기준. */
const FACE_RELATED_KEYWORDS = [
    'face', 'eyes', 'eye', 'mouth', 'lips', 'lip', 'nose', 'eyebrows', 'eyebrow',
    'eyelashes', 'blush', 'smile', 'smiling', 'expression', 'closed eyes', 'open mouth',
    'teeth', 'tongue', 'freckles', 'makeup', 'eyeshadow', 'eyeliner', 'lipstick',
    'cheek', 'forehead', 'chin', 'jaw', 'ear', 'earrings', 'looking at viewer',
    'wink', 'crying', 'tears', 'sweat drop', 'anger vein', 'pupils', 'iris',
];

/**
 * 🙈 후방/뒷모습 조각에 켜둔 "얼굴 가중치 하락" 토글이 있으면, 프롬프트 안에서
 * 얼굴 관련 태그로 보이는 것만 찾아 (태그:0.5) 형식으로 가중치를 낮춘다.
 * 이미 (태그:숫자) 형식으로 명시적 가중치가 붙어있는 태그는 사용자가 직접 정한 값이므로 건드리지 않는다.
 */
function applyFaceWeightReduction(promptStr) {
    if (!promptStr) return promptStr;
    return promptStr
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0)
        .map(t => {
            if (/^\(.*:[\d.]+\)$/.test(t)) return t; // 이미 명시적 가중치가 있으면 그대로 둠
            const bare = stripWeightSyntax(t).toLowerCase();
            const isFaceTag = FACE_RELATED_KEYWORDS.some(kw => bare.includes(kw));
            return isFaceTag ? `(${stripWeightSyntax(t)}:0.5)` : t;
        })
        .join(', ');
}

/** "3. 베이스 프롬프트" 섹션 아래에 무력화 키워드 입력 UI를 없으면 만들어 끼워넣는다 */
function ensureDisabledTokensUI() {
    if (document.getElementById('disabled-tokens-input')) return;
    const negGroup = document.getElementById('base-neg')?.closest('.form-group');
    if (!negGroup || !negGroup.parentElement) return;

    const wrap = document.createElement('div');
    wrap.className = 'form-group';
    wrap.innerHTML = `
        <label style="color:#e74c3c;">🚫 프롬프트 무력화 키워드 (콤마로 구분)</label>
        <input type="text" id="disabled-tokens-input" placeholder="예: 프론트뷰, from behind"
            style="width:100%; box-sizing:border-box; padding:8px; background:#221515; border:1px solid #e74c3c; color:#fff; border-radius:6px;">
        <p style="font-size:0.75em; color:#888; margin:4px 0 0;">
            여기 적은 단어와 정확히 일치하는 태그는, 조각 안 어디에 들어있든 원본은 그대로 두고 <b>생성할 때만</b> 자동으로 빠집니다.
        </p>
    `;
    negGroup.insertAdjacentElement('afterend', wrap);

    const input = wrap.querySelector('#disabled-tokens-input');
    input.value = getDisabledTokens().join(', ');
    input.addEventListener('input', () => {
        const tokens = input.value.split(',').map(t => t.trim()).filter(Boolean);
        setDisabledTokens(tokens);
    });
}

document.addEventListener('DOMContentLoaded', ensureDisabledTokensUI);

/* ──────────────────────────────────────────────
   🎨 프롬프트 카테고리 색상 미리보기 — 입력창(#base-pos/#base-neg/#action-pos) 자체는
   <textarea>라서 일부 글자만 색칠하는 게 기술적으로 불가능하므로, 바로 밑에 같은 내용을
   태그별 색깔 배지로 보여주는 읽기 전용 줄을 추가한다. 입력창은 전혀 안 건드림.

   분류 방식: korean_autocomplete.js가 쓰는 것과 같은 tags_ko.json 파일에는 태그마다
   실제 danbooru 위키 기준 category 필드가 "대분류 > 세부분류" 형태로 이미 들어있다
   (예: "패션 > 상의", "포즈 > 손", "작가 > 일본 작가"). 이 실제 분류 데이터를 규칙에 맞춰
   우리 8개 카테고리로 매핑해서 쓰는 게, 태그 하나하나 영어 키워드로 추측하는 것보다
   훨씬 정확하다. 이 파일에 없는 태그(고유명사, 커스텀 트리거워드 등)만 예전 방식의
   영어 키워드 목록으로 폴백 처리한다.
   ────────────────────────────────────────────── */
const PROMPT_CATEGORY_COLORS = {
    '작가': '#FFD54F',
    '얼굴': '#e91e63',
    '표정/감정': '#CE93D8',
    '신체/외형': '#A1887F',
    '인물/캐릭터': '#8D6E63',
    '의상/패션': '#4DB6AC',
    '행동/포즈': '#FFB74D',
    '구도/스타일': '#4FC3F7',
    '배경/장소': '#81C784',
    '사물/아이템': '#90A4AE',
    '2차창작/메타': '#7986CB',
    '성인용': '#EF5350',
    '기타': '#999999',
    // 🆕 "red shirt"/"two girls"처럼 태그 앞에 색상/수량 수식어가 붙은 경우, 그 수식어 부분만
    // 따로 표시하기 위한 전용 색 — classifyPromptTagSegments()에서만 쓰임(분류/차단 로직은 안 건드림).
    '색상': '#F06292',
    '수량': '#BA68C8',
    // 🆕 "big breasts", "tiny hands"처럼 태그 맨 앞에 오는 크기 수식어 전용 색(3번째 수식어 그룹).
    '크기': '#AED581',
};

// 🆕 "red shirt", "dark blue eyes"처럼 태그 맨 앞에 오는 색상 수식어 인식용.
// 2단어짜리(dark blue 등)를 먼저 시도하고, 안 맞으면 1단어로 폴백.
const PROMPT_COLOR_WORDS = new Set(['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'black',
    'white', 'brown', 'grey', 'gray', 'silver', 'gold', 'golden', 'cyan', 'teal', 'magenta', 'violet',
    'indigo', 'beige', 'tan', 'maroon', 'navy', 'olive', 'lavender', 'turquoise', 'multicolored',
    'rainbow', 'colored', 'pale', 'dark', 'light', 'bright', 'neon', 'two-tone', 'gradient', 'streaked']);

// 🆕 "two girls", "many weapons"처럼 태그 맨 앞에 오는 수량 수식어 인식용.
const PROMPT_QUANTITY_WORDS = new Set(['many', 'several', 'few', 'two', 'three', 'four', 'five', 'six',
    'seven', 'eight', 'nine', 'ten', 'multiple', 'single', 'lone', 'numerous', 'countless', 'paired',
    'couple', 'dozen', 'group']);

// 🆕 "big breasts", "tiny hands", "huge weapon"처럼 태그 맨 앞(수량 다음, 색상 앞)에 오는
// 크기 수식어 인식용 — 세 번째 수식어 그룹.
const PROMPT_SIZE_WORDS = new Set(['big', 'small', 'tiny', 'huge', 'giant', 'massive', 'large', 'tall',
    'short', 'long', 'wide', 'narrow', 'thick', 'thin', 'slim', 'enormous', 'mini', 'micro', 'oversized',
    'compact', 'colossal', 'petite', 'bulky', 'skinny']);

/** 실제 매칭되는 태그 수가 적은(=드문) 카테고리들 — 색만으로는 눈에 잘 안 띌 수 있어서
 *  배지 뒤에 ✦ 표시를 추가로 붙여준다. */
const PROMPT_CATEGORY_RARE_MARKERS = new Set(['얼굴', '표정/감정', '성인용', '구도/스타일']);

// 🆕(수식어 추가+잔여 태그 분류 세션) 실측 결과 catStr 구분자가 ">" 외에 "→"(전각 화살표)로
// 저장된 항목이 69개 있었고, top이 우리 13개 카테고리와 글자가 안 맞는 경우(출처 및 작가,
// 개념 및 테마, 성적 요소 등)나 top 자체가 이미 우리 카테고리명 그대로인 경우(인물/캐릭터,
// 2차창작/메타 등 — 예전 코드가 이 케이스를 아예 안 받아서 전부 null로 빠지고 있었음)가
// 다수 누락되어 있었다. 전체 589개 실제 top 중 커버리지가 큰 것 위주로 테이블을 크게 확장.
const PROMPT_TOP_BUCKET_MAP = {
    '작가': '작가', '출처 및 작가': '작가', '창작자': '작가', '아티스트': '작가', '제작자': '작가',
    '인물/캐릭터': '인물/캐릭터', '캐릭터': '인물/캐릭터', '인물': '인물/캐릭터', '등장인물': '인물/캐릭터',
    '종족': '인물/캐릭터', '직업': '인물/캐릭터', '관계': '인물/캐릭터', '그룹': '인물/캐릭터', '단체': '인물/캐릭터',
    '조직': '인물/캐릭터', '캐릭터/의상': '인물/캐릭터',
    '버튜버': '2차창작/메타', 'VTuber': '2차창작/메타', '함대 컬렉션': '2차창작/메타',
    '2차창작/메타': '2차창작/메타', '작품': '2차창작/메타', '시리즈': '2차창작/메타', '저작권': '2차창작/메타',
    '창작물': '2차창작/메타', '게임': '2차창작/메타', '미디어': '2차창작/메타', '설정': '2차창작/메타',
    '애니메이션': '2차창작/메타', '만화': '2차창작/메타', '장르': '2차창작/메타', '이벤트': '2차창작/메타',
    '밈': '2차창작/메타', '매체': '2차창작/메타', '음악': '2차창작/메타', '이미지 정보': '2차창작/메타',
    '문화': '2차창작/메타', '포켓몬스터': '2차창작/메타', '메타': '2차창작/메타', '정보': '2차창작/메타',
    '기호': '2차창작/메타', '형식': '2차창작/메타', '패러디': '2차창작/메타', '언어': '2차창작/메타',
    '신화': '2차창작/메타', '소프트웨어': '2차창작/메타', '테마': '2차창작/메타', '콘셉트': '2차창작/메타',
    '패션': '의상/패션', '의상/패션': '의상/패션', '의상': '의상/패션', '복장': '의상/패션', '의류': '의상/패션',
    '코스튬': '의상/패션', '복식': '의상/패션', '코스프레': '의상/패션', '액세서리': '의상/패션',
    '스킨': '의상/패션', '특정 의상': '의상/패션',
    '사물': '사물/아이템', '사물/아이템': '사물/아이템', '오브젝트': '사물/아이템', '무기': '사물/아이템',
    '아이템': '사물/아이템', '도구': '사물/아이템', '상징': '사물/아이템', '효과': '사물/아이템', '식물': '사물/아이템',
    '텍스트': '사물/아이템', '메카': '사물/아이템', '로봇': '사물/아이템', '브랜드': '사물/아이템', '도형': '사물/아이템',
    '무늬': '사물/아이템', '디자인/무늬': '사물/아이템', '글자': '사물/아이템', '음식': '사물/아이템',
    '신체/외형': '신체/외형', '신체': '신체/외형', '외형': '신체/외형', '헤어스타일': '신체/외형', '헤어': '신체/외형',
    '생물': '신체/외형', '동물': '신체/외형', '신체 특징': '신체/외형', '속성': '신체/외형',
    '특징': '신체/외형', '외모': '신체/외형', '신체적 특징': '신체/외형', '체형': '신체/외형', '신체 부위': '신체/외형',
    '얼굴': '얼굴', '메이크업': '얼굴', '미용': '얼굴', '눈': '얼굴',
    '표정/감정': '표정/감정', '표정': '표정/감정', '표현': '표정/감정',
    '행동': '행동/포즈', '행동/포즈': '행동/포즈', '자세': '행동/포즈', '동작': '행동/포즈', '행위': '행동/포즈',
    '포즈': '행동/포즈', '상태': '행동/포즈', '상황': '행동/포즈', '구성': '행동/포즈', '능력': '행동/포즈',
    '기술': '행동/포즈', '묘사': '행동/포즈', '스포츠': '행동/포즈',
    '개념 및 테마': '구도/스타일', '아트 및 연출': '구도/스타일', '구도/스타일': '구도/스타일', '구도': '구도/스타일',
    '연출': '구도/스타일', '스타일': '구도/스타일', '디자인': '구도/스타일', '아트': '구도/스타일', '패턴': '구도/스타일',
    '개념': '구도/스타일', '현상': '구도/스타일', '미술': '구도/스타일', '예술': '구도/스타일', '아트스타일': '구도/스타일',
    '화풍': '구도/스타일', '시점': '구도/스타일', '프레임': '구도/스타일',
    '배경/장소': '배경/장소', '배경': '배경/장소', '장소': '배경/장소', '자연': '배경/장소', '건축': '배경/장소',
    '성적 요소': '성인용', '성인용': '성인용', '성행위': '성인용', 'H': '성인용', '성': '성인용', '페티시': '성인용',
    '성적': '성인용', '성인': '성인용', '성적인': '성인용', '노출': '성인용', '검열': '성인용', '페티시즘': '성인용',
    '기타': '기타',
};

// 🆕 top이 매칭 안 될 때(특히 "블루 아카이브 > 등장인물"처럼 top 자리에 게임/시리즈명이 그대로
// 들어간 경우) sub 쪽으로 한 번 더 시도하기 위한 보조 테이블.
const PROMPT_SUB_BUCKET_MAP = {
    '등장인물': '인물/캐릭터', '캐릭터': '인물/캐릭터', '서번트': '인물/캐릭터', '종족': '인물/캐릭터',
    '오퍼레이터': '인물/캐릭터', '요괴': '인물/캐릭터', '몬스터': '인물/캐릭터', '그룹': '인물/캐릭터',
    '함선': '인물/캐릭터', '작가 오리지널 캐릭터': '인물/캐릭터',
    '캐릭터 코스튬': '의상/패션', '의상': '의상/패션', '무기': '사물/아이템', '소품': '사물/아이템',
    '머리카락': '신체/외형', '헤어스타일': '신체/외형', '손': '신체/외형', '꼬리': '신체/외형', '문신': '신체/외형',
    '손발톱': '신체/외형', '특정부위': '신체/외형', '분비': '신체/외형',
    '밈': '2차창작/메타', '시리즈': '2차창작/메타', '게임': '2차창작/메타', '장르': '2차창작/메타',
    '일러스트레이터': '작가', '기법': '구도/스타일', '색채': '구도/스타일', '스타일': '구도/스타일',
    '검열': '성인용', '의상 노출': '성인용', '가슴': '성인용',
};

/** tags_ko.json의 "대분류 > 세부분류" 문자열 하나를 우리 13개 카테고리 이름 중 하나로 매핑.
 *  🐛 수정(잔여 태그 분류 세션): 구분자가 "→"인 69개 항목을 놓치고 있었고, top이 우리
 *  카테고리명 그대로이거나("인물/캐릭터" 등) 동의어인 경우(출처 및 작가/개념 및 테마 등)
 *  다수가 테이블에 없어서 조용히 null(기타)로 빠지고 있었다 — PROMPT_TOP_BUCKET_MAP으로
 *  교체해 실제 top 589종 중 상위권을 대부분 커버. 그래도 못 찾으면 sub로 한 번 더 시도. */
function mapDanbooruCategoryToBucket(catStr) {
    if (!catStr) return null;
    const parts = catStr.split(/[>→]/).map(s => s.trim());
    const top = parts[0] || '';
    const sub = parts[1] || '';

    if (['작가', '창작자', '아티스트'].includes(top)) return '작가';
    if (top === '인물' && ['아티스트', '작가'].includes(sub)) return '작가';

    // 🐛 "표정 > 입"(smile), "표정 > 눈"(wink)처럼 표정/감정 대분류인데 세부분류가
    // 얼굴 부위 이름인 경우가 많아서, 얼굴 세부분류 체크보다 먼저 와야 함.
    if (['표정', '감정', '표현'].includes(top)) return '표정/감정';
    if (['감정', '미소', '웃음', '분노', '슬픔', '질투', '황홀', '부정적'].includes(sub)) return '표정/감정';

    if (['얼굴', '눈', '입', '코', '귀', '눈썹'].includes(sub)) return '얼굴';
    if (top === '얼굴') return '얼굴';

    // 🐛 "신체 > 자세"는 신체 부위가 아니라 포즈이므로, 일반 신체 체크보다 먼저 행동으로 분류
    if (top === '신체' && sub === '자세') return '행동/포즈';
    if (['행위', '포즈', '자세', '동작', '행동', '상태'].includes(top)) return '행동/포즈';

    if (top === '사물' && sub === '의류 액세서리') return '의상/패션';

    if (PROMPT_TOP_BUCKET_MAP[top]) return PROMPT_TOP_BUCKET_MAP[top];
    if (PROMPT_SUB_BUCKET_MAP[sub]) return PROMPT_SUB_BUCKET_MAP[sub];

    return null;
}

/** tags_ko.json을 한 번 통째로 불러와서 "영어태그(소문자) → 카테고리명" Map을 만든다.
 *  korean_autocomplete.js가 이미 같은 URL을 fetch(cache:"force-cache")로 받아두기 때문에,
 *  같은 주소로 다시 fetch해도 대부분 브라우저 캐시에서 즉시 응답돼 추가 다운로드가 거의 없다. */
let TAG_CATEGORY_MAP = null;
let tagCategoryMapLoadPromise = null;
const promptCategoryPreviewRerenderFns = [];

async function loadTagCategoryMap() {
    if (tagCategoryMapLoadPromise) return tagCategoryMapLoadPromise;
    tagCategoryMapLoadPromise = (async () => {
        const map = new Map();

        // 1) tags_ko.json 기반 분류 (danbooru 위키 category 필드 → 규칙 매핑)
        try {
            const res = await fetch('/assetmanager/static/js/tags_ko.json', { cache: 'force-cache' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const entries = await res.json();
            for (const entry of entries) {
                const en = entry[0];
                const catStr = entry[5];
                if (!en || !catStr) continue;
                const bucket = mapDanbooruCategoryToBucket(catStr);
                if (bucket) map.set(en.toLowerCase(), bucket);
            }
            console.log(`[프롬프트 카테고리] tags_ko.json 기반 1차 분류 ${map.size}개`);
        } catch (e) {
            console.warn('[프롬프트 카테고리] tags_ko.json 로드 실패:', e);
        }

        // 2) danbooru-tags-classified(작가 8만3천개 등 대규모) 기반 분류 — 이쪽이 카테고리당
        //    커버리지가 훨씬 넓으므로(특히 작가), 겹치는 태그는 이 값으로 덮어쓴다.
        try {
            const res2 = await fetch('/assetmanager/static/js/tag_categories_extra.json', { cache: 'force-cache' });
            if (!res2.ok) throw new Error('HTTP ' + res2.status);
            const extra = await res2.json();
            let added = 0;
            for (const [tag, bucket] of Object.entries(extra)) {
                map.set(tag, bucket);
                added++;
            }
            console.log(`[프롬프트 카테고리] tag_categories_extra.json 병합 ${added}개, 최종 합계 ${map.size}개`);
        } catch (e) {
            console.warn('[프롬프트 카테고리] tag_categories_extra.json 로드 실패(없어도 tags_ko.json 분류는 그대로 동작):', e);
        }

        TAG_CATEGORY_MAP = map;
        promptCategoryPreviewRerenderFns.forEach(fn => fn()); // 로드 완료 후 이미 그려진 미리보기 다시 그림
    })();
    return tagCategoryMapLoadPromise;
}
loadTagCategoryMap();

/** 🔙 tags_ko.json에 없는 태그(고유 트리거워드 등)를 위한 예전 방식 영어 키워드 폴백 목록.
 *  "artist:이름" 구조와 danbooru category 매핑에서 못 찾았을 때만 이걸로 한 번 더 검사한다. */
const PROMPT_CATEGORY_KEYWORD_FALLBACK = [
    // 🐛 수정: 아래 각 name이 PROMPT_CATEGORY_COLORS의 키와 글자 그대로 안 맞으면
    // PROMPT_CATEGORY_COLORS[cat.name]이 undefined가 돼서 색이 안 붙는다(예전엔 '감정','구도',
    // '배경','행동','의상'처럼 줄임말을 썼는데 PROMPT_CATEGORY_COLORS는 '표정/감정','구도/스타일',
    // '배경/장소','행동/포즈','의상/패션'처럼 긴 이름이라 전부 어긋나 있었음) — 전부 긴 이름으로 통일.
    { name: '성인용', keywords: ['nude', 'naked', 'nipples', 'pussy', 'penis', 'sex', 'cum', 'penetration',
        'masturbation', 'bondage', 'nsfw', 'vaginal', 'anal', 'fellatio', 'cunnilingus',
        'ejaculation', 'erection', 'orgasm', 'hentai', 'bukkake', 'creampie', 'dildo', 'vibrator',
        'spread legs', 'panty pull', 'undressing', 'see-through', 'pubic hair', 'rape', 'futanari',
        'gangbang', 'group sex', 'oral', 'handjob', 'facial', 'bulge', 'testicles'] },
    { name: '얼굴', keywords: ['face', 'eyes', 'eye', 'mouth', 'lips', 'lip', 'nose', 'eyebrows', 'eyebrow',
        'eyelashes', 'closed eyes', 'open mouth', 'teeth', 'tongue', 'freckles', 'makeup',
        'eyeshadow', 'eyeliner', 'lipstick', 'cheek', 'forehead', 'chin', 'jaw', 'ear',
        'earrings', 'pupils', 'iris', 'horn', 'horns'] },
    { name: '표정/감정', keywords: ['smile', 'smiling', 'grin', 'smirk', 'blush', 'angry', 'glare', 'sad', 'crying',
        'tears', 'happy', 'laughing', 'embarrassed', 'surprised', 'shy', 'scared', 'jealous',
        'pout', 'tsundere', 'serious', 'expressionless', 'wink', 'excited', 'nervous',
        'confused', 'bored', 'proud', 'shouting', 'frown', 'expression'] },
    { name: '구도/스타일', keywords: ['from behind', 'from side', 'from above', 'from below', 'looking back',
        'looking away', 'looking at viewer', 'close-up', 'upper body', 'full body',
        'cowboy shot', 'wide shot', 'dutch angle', 'perspective', 'depth of field', 'bokeh',
        'fisheye', 'portrait', 'profile', 'three-quarter view', 'back view', 'side view',
        'chibi', 'watercolor', 'sketch', 'monochrome', 'greyscale', 'pixel art', 'lineart',
        'realistic', 'photorealistic', '3d', 'flat color', 'retro', 'vintage'] },
    { name: '배경/장소', keywords: ['background', 'sky', 'forest', 'city', 'indoors', 'outdoors', 'beach',
        'mountain', 'sunset', 'sunrise', 'night', 'cloud', 'rain', 'snow', 'ocean', 'river',
        'garden', 'street', 'building', 'window', 'tree', 'grass', 'field', 'classroom',
        'bedroom', 'kitchen', 'cafe', 'park', 'room'] },
    { name: '행동/포즈', keywords: ['standing', 'sitting', 'lying', 'running', 'walking', 'jumping', 'holding',
        'eating', 'drinking', 'pointing', 'waving', 'dancing', 'fighting', 'sleeping',
        'crouching', 'kneeling', 'reaching', 'stretching', 'leaning', 'carrying', 'hugging',
        'kissing', 'arms up', 'arms crossed', 'hand on hip', 'peace sign', 'walking away'] },
    { name: '의상/패션', keywords: ['dress', 'shirt', 'skirt', 'uniform', 'jacket', 'coat', 'pants', 'shorts',
        'socks', 'shoes', 'boots', 'hat', 'glove', 'gloves', 'ribbon', 'bow', 'necktie', 'tie',
        'swimsuit', 'bikini', 'armor', 'cape', 'scarf', 'thighhighs', 'kimono', 'sweater',
        'hoodie', 'blazer', 'vest', 'cardigan', 'pajamas', 'apron', 'stockings', 'sandals',
        'sneakers', 'collar', 'hairband', 'headband', 'strap', 'latex', 'leotard', 'harness',
        'bodysuit', 'corset', 'garter'] },
    // 🆕 추가: 기존엔 없던 5개 카테고리용 키워드 목록 — 그동안 이 5개는 영어 키워드 폴백 자체가
    // 아예 없어서 사전에 없는 태그는 전부 무조건 '기타'로 빠지고 있었음.
    { name: '신체/외형', keywords: ['hair', 'ponytail', 'twintails', 'twin tails', 'braid', 'bun', 'bangs',
        'ahoge', 'skin', 'breasts', 'thighs', 'thigh', 'legs', 'leg', 'arms', 'arm', 'hands', 'hand', 'fingers',
        'nails', 'tail', 'wings', 'wing', 'tattoo', 'scar', 'muscular', 'slim', 'petite', 'tall',
        'short hair', 'curvy', 'abs', 'navel', 'collarbone', 'mole', 'wet', 'sweat', 'dark skin',
        'pale skin', 'tan', 'scales', 'claws', 'fangs', 'whiskers'] },
    { name: '인물/캐릭터', keywords: ['girl', 'boy', 'woman', 'man', 'child', 'loli', 'shota', 'elf', 'demon',
        'angel', 'maid', 'nurse', 'student', 'teacher', 'princess', 'queen', 'king', 'knight',
        'soldier', 'android', 'robot', 'monster', 'furry', 'catgirl', 'kemonomimi', 'mermaid',
        'vampire', 'witch', 'idol', 'twins', 'siblings', 'mother', 'father', 'sister', 'brother',
        'multiple girls', 'multiple boys', '1girl', '1boy', '2girls', '2boys', 'solo', 'couple'] },
    { name: '사물/아이템', keywords: ['sword', 'gun', 'weapon', 'shield', 'knife', 'staff', 'wand', 'book',
        'umbrella', 'bag', 'phone', 'cup', 'bottle', 'flower', 'food', 'cake', 'drink', 'chair',
        'table', 'bed', 'key', 'mask', 'mirror', 'camera', 'instrument', 'guitar', 'balloon',
        'candle', 'basket', 'backpack', 'chain', 'rope', 'spear', 'bow and arrow', 'shield'] },
    { name: '2차창작/메타', keywords: ['commentary', 'translated', 'fanart', 'parody', 'crossover', 'highres',
        'absurdres', 'lowres', 'sample', 'watermark', 'signature', 'speech bubble', 'english text',
        'japanese text', 'comic', 'doujin', 'pixiv', 'twitter', '4koma', 'cover', 'manga',
        'official art', 'fan art'] },
];

/** 태그 하나를 분류한다: 1) artist:구조 → 작가, 2) tags_ko.json 실제 category, 3) 영어 키워드 폴백, 4) 기타 */
function classifyPromptTag(tag) {
    // 🐛 수정: tag_categories_extra.json/tags_ko.json 매핑은 전부 "공백 표기"로 저장돼있는데
    // 실제 프롬프트에 danbooru식 "밑줄(_) 표기"가 그대로 들어오면 문자열이 안 맞아서 조회가
    // 실패하고 전부 "기타"로 빠지고 있었다 — 조회 직전에 밑줄을 공백으로 통일한다.
    const bare = (typeof stripWeightSyntax === 'function' ? stripWeightSyntax(tag) : tag).toLowerCase().replace(/_/g, ' ');
    if (!bare) return { name: '기타', color: PROMPT_CATEGORY_COLORS['기타'] };
    // "artist:이름" 뿐 아니라 "@이름" 형식(예: @wlop,)도 작가로 인식
    if (/^artist\s*:/.test(bare) || /^@/.test(bare)) return { name: '작가', color: PROMPT_CATEGORY_COLORS['작가'] };

    if (TAG_CATEGORY_MAP) {
        const bucket = TAG_CATEGORY_MAP.get(bare);
        if (bucket) return { name: bucket, color: PROMPT_CATEGORY_COLORS[bucket] };
    }

    for (const cat of PROMPT_CATEGORY_KEYWORD_FALLBACK) {
        if (cat.keywords.some(kw => bare.includes(kw))) return { name: cat.name, color: PROMPT_CATEGORY_COLORS[cat.name] };
    }
    return { name: '기타', color: PROMPT_CATEGORY_COLORS['기타'] };
}

// 🆕 단어 단위 폴백 분해에서 그냥 건너뛸 관사/전치사/접속사 — 이런 단어는 따로 "기타" 조각으로
// 안 만들고, 양옆 단어가 이어지는 것처럼 그냥 생략한다.
const PROMPT_STOPWORDS = new Set(['a', 'an', 'the', 'in', 'on', 'at', 'with', 'of', 'to', 'and', 'or',
    'from', 'by', 'for', 'over', 'under', 'through', 'into', 'onto', 'off', 'is', 'are', 'as']);

/** 통째로는 분류가 안 되는(기타로 빠지는) 여러 단어짜리 구를 단어 단위로 쪼개서 각각 분류해보고,
 *  서로 다른 카테고리가 2개 이상 나오면 그 조합을 세그먼트로 돌려준다. 관사/전치사는 건너뛰고,
 *  연속으로 같은 카테고리가 나오면 하나로 합친다. 쪼개봐도 다 "기타"거나 카테고리가 1종류뿐이면
 *  null을 돌려줘서 호출부가 기존처럼 통째로 1개 취급하게 한다(세그먼트가 너무 잘게 쪼개지는 것 방지). */
function classifyPromptTagByWords(phrase) {
    const words = phrase.split(/\s+/).filter(w => !PROMPT_STOPWORDS.has(w));
    if (words.length < 2) return null;
    const wordCats = words.map(w => classifyPromptTag(w));
    // 🆕 세그먼트별로 배지를 따로 감싸 보여주려면(🆕 배지 렌더링 방식 변경) 색만이 아니라
    // 그 세그먼트에 실제로 해당하는 단어들(text)도 같이 들고 있어야 함.
    const merged = [];
    for (let i = 0; i < words.length; i++) {
        const c = wordCats[i];
        if (merged.length && merged[merged.length - 1].name === c.name) {
            merged[merged.length - 1].text += ' ' + words[i]; // 연속 동일 카테고리는 글자를 이어붙임
            continue;
        }
        merged.push({ name: c.name, color: c.color, text: words[i] });
    }
    const distinctNonEtc = new Set(merged.filter(s => s.name !== '기타').map(s => s.name));
    if (distinctNonEtc.size < 1 || merged.length < 2 || merged.length > 4) return null; // 효과 없거나 너무 잘게 쪼개지면 포기
    return merged;
}

/** 🆕 "red shirt"/"two girls"/"two red hats"처럼 태그 맨 앞에 수량·색상 수식어가 붙은 경우,
 *  [수량?, 색상?, 나머지] 순서의 세그먼트 배열로 쪼개서 돌려준다(화면 표시 전용 — 🧱 조각 카테고리
 *  차단/🚫 키워드 무효화 같은 실제 분류·필터링 로직은 지금처럼 classifyPromptTag()의 단일 결과를
 *  그대로 쓰고, 이 함수는 절대 안 건드림). "나머지" 부분이 통째로는 분류 안 되는(기타) 여러 단어짜리
 *  구면("hand in apple" 등), 관사/전치사는 생략하고 단어 단위로 한 번 더 쪼개서 시도한다
 *  (classifyPromptTagByWords) — 인식되는 단어가 2종류 이상 나올 때만 적용, 아니면 기존처럼 1개로.
 *  @returns {{name:string,color:string}[]} 1개 이상 세그먼트 */
function classifyPromptTagSegments(tag) {
    const bare = (typeof stripWeightSyntax === 'function' ? stripWeightSyntax(tag) : tag).toLowerCase().replace(/_/g, ' ').trim();
    if (!bare) return [{ name: '기타', color: PROMPT_CATEGORY_COLORS['기타'], text: tag }];
    if (/^artist\s*:/.test(bare) || /^@/.test(bare)) return [{ name: '작가', color: PROMPT_CATEGORY_COLORS['작가'], text: tag }];

    const words = bare.split(/\s+/);
    if (words.length < 2) return [Object.assign({ text: tag }, classifyPromptTag(tag))]; // 한 단어짜리는 지금처럼 그대로

    // 🐛 버그 수정: "black hair", "large breasts"처럼 그 자체로 이미 tags_ko.json/
    // tag_categories_extra.json에 등록된 "완전한 태그"인 경우, 앞 단어(black/large)가
    // PROMPT_COLOR_WORDS·PROMPT_SIZE_WORDS에 우연히 걸려서 "수식어 + 나머지"로 쪼개져
    // 버렸다 — 원래는 하나의 태그인데 이중/삼중 배지로 잘못 나뉘는 버그였음.
    // 그래서 수식어 분해를 시도하기 전에, 태그 전체가 이미 알려진 단일 태그인지부터 확인하고
    // 맞으면 더 쪼개지 않고 그대로 통째로 1개 배지로 돌려준다.
    if (typeof TAG_CATEGORY_MAP !== 'undefined' && TAG_CATEGORY_MAP && TAG_CATEGORY_MAP.has(bare)) {
        return [Object.assign({ text: tag }, classifyPromptTag(tag))];
    }

    const segments = [];
    let idx = 0;
    if (PROMPT_QUANTITY_WORDS.has(words[idx])) {
        segments.push({ name: '수량', color: PROMPT_CATEGORY_COLORS['수량'], text: words[idx] });
        idx++;
    }
    // 🆕 크기는 수량 다음, 색상 앞 순서("two big red hats" → 수량/크기/색상/나머지)
    if (idx < words.length && PROMPT_SIZE_WORDS.has(words[idx])) {
        segments.push({ name: '크기', color: PROMPT_CATEGORY_COLORS['크기'], text: words[idx] });
        idx++;
    }
    // 색상은 2단어 조합("dark blue")을 먼저 시도, 안 맞으면 1단어로
    if (idx + 1 < words.length && PROMPT_COLOR_WORDS.has(words[idx]) && PROMPT_COLOR_WORDS.has(words[idx + 1])) {
        segments.push({ name: '색상', color: PROMPT_CATEGORY_COLORS['색상'], text: words[idx] + ' ' + words[idx + 1] });
        idx += 2;
    } else if (idx < words.length && PROMPT_COLOR_WORDS.has(words[idx])) {
        segments.push({ name: '색상', color: PROMPT_CATEGORY_COLORS['색상'], text: words[idx] });
        idx += 1;
    }

    const rest = words.slice(idx).join(' ');
    if (!rest) return segments.length ? segments : [Object.assign({ text: tag }, classifyPromptTag(tag))];

    // "hand in apple" 같은 경우, 전체 문자열에 "hand"가 부분문자열로 들어있어서 키워드 폴백이
    // 통째로 신체/외형이라고 오판할 수 있다 — 그래서 restWhole 결과만 보고 판단하지 않고,
    // 항상 단어 단위 분해를 먼저 시도해서 "2종류 이상 인식되는" 더 정보가 많은 쪽을 우선 쓴다.
    const byWords = classifyPromptTagByWords(rest);
    const restResult = byWords || [Object.assign({ text: rest }, classifyPromptTag(rest))];
    if (segments.length === 0) return restResult; // 수식어가 하나도 안 걸리면 기존과 동일(배열만 그대로 반환)
    return segments.concat(restResult);
}

/** 🆕(배지 렌더링 방식 변경) 세그먼트 하나를 "자기 색으로 두른" 작은 배지 HTML 한 조각으로 만든다.
 *  예전엔 배지 하나를 그라데이션으로 나눠 칠해서 글자가 색 경계선 위에 걸치면 가독성이 떨어졌는데,
 *  이제는 세그먼트마다 글자를 독립된 알약 모양으로 감싸서 보여준다 — "(수량)(색상)(나머지)"처럼.
 *  여러 조각을 묶어서 하나의 태그라는 걸 보여주려고, 조각 사이는 거의 안 붙지만(margin 최소화)
 *  바깥쪽만 둥글게(첫/끝 조각) 나머지는 각지게 해서 "이어붙인 하나"라는 느낌을 준다. */
function promptSegmentBadgeHtml(seg, isFirst, isLast, isOnly, marker) {
    const c = seg.color;
    const radius = isOnly ? '5px'
        : isFirst ? '5px 0 0 5px'
        : isLast ? '0 5px 5px 0'
        : '0';
    const marginRight = isLast ? '3px' : '1px';
    // 🆕 ✦(희귀 카테고리 표시)는 바깥에 따로 떠 있으면 어색해 보여서, 마지막 조각 배지 "안쪽"
    // 글자 바로 뒤에 붙여서 같은 알약 안에 들어가게 한다.
    return `<span style="display:inline-block; background:${c}26; color:${c}; border:1px solid ${c}55; `
        + `${isFirst ? '' : 'border-left:none; '}padding:2px 6px; border-radius:${radius}; margin:2px ${marginRight} 2px 0; `
        + `font-size:0.82em;">${seg.text.replace(/</g, '&lt;')}${marker || ''}</span>`;
}

/** 프롬프트 문자열을 콤마로 쪼개서 카테고리별 색깔 배지 HTML로 렌더링.
 *  🆕 "red shirt"처럼 색상/수량 수식어가 붙은 태그는 classifyPromptTagSegments()로 쪼개서,
 *  세그먼트마다 자기 색으로 두른 작은 배지를 이어붙여 보여준다(예: (two)(red)(hats)). */
function renderCategorizedPromptHtml(promptStr) {
    const tags = (promptStr || '').split(',').map(t => t.trim()).filter(Boolean);
    if (tags.length === 0) return '<span style="color:#666; font-size:0.8em;">(비어있음)</span>';
    return tags.map(tag => {
        const segments = (typeof classifyPromptTagSegments === 'function') ? classifyPromptTagSegments(tag) : [Object.assign({ text: tag }, classifyPromptTag(tag))];
        const marker = segments.some(s => PROMPT_CATEGORY_RARE_MARKERS.has(s.name)) ? ' ✦' : '';
        const n = segments.length;
        const title = n > 1 ? ` title="${segments.map(s => s.name).join(' + ')}"` : '';
        // 🆕 ✦는 더 이상 바깥에 따로 안 띄우고, 마지막 조각 배지 안쪽 글자 뒤에 붙인다.
        const badges = segments.map((s, i) => promptSegmentBadgeHtml(s, i === 0, i === n - 1, n === 1, i === n - 1 ? marker : '')).join('');
        return `<span${title} style="display:inline-flex;">${badges}</span>`;
    }).join('');
}

const PROMPT_CATEGORY_LEGEND_HTML = Object.entries(PROMPT_CATEGORY_COLORS)
    .map(([name, color]) => `<span style="margin-right:10px;"><span style="display:inline-block; width:9px; height:9px; border-radius:2px; background:${color}; margin-right:3px;"></span>${name}${PROMPT_CATEGORY_RARE_MARKERS.has(name) ? ' ✦' : ''}</span>`)
    .join('');

/** 지정된 textarea(input) 바로 밑에, 그 내용을 색깔 배지로 보여주는 읽기 전용 줄을 붙인다.
 *  입력할 때마다(input 이벤트) 그 줄만 다시 그리고, 원본 입력창은 전혀 건드리지 않는다. */
function attachCategoryPreview(inputId) {
    const input = document.getElementById(inputId);
    if (!input || document.getElementById(`${inputId}-category-preview`)) return;

    const preview = document.createElement('div');
    preview.id = `${inputId}-category-preview`;
    preview.style.cssText = 'margin-top:4px; padding:6px 8px; background:#1a1a1a; border:1px solid #333; border-radius:6px; line-height:1.9;';

    input.insertAdjacentElement('afterend', preview);

    const render = () => { preview.innerHTML = renderCategorizedPromptHtml(input.value); };
    render();
    input.addEventListener('input', render);
    promptCategoryPreviewRerenderFns.push(render); // tags_ko.json 로드 완료 후 재렌더링용
}

/** #base-pos, #base-neg, #action-pos 아래에 색상 미리보기 줄 + 범례를 한 번만 붙인다 */
function ensurePromptCategoryPreviewUI() {
    if (document.getElementById('prompt-category-legend')) return;
    ['base-pos', 'base-neg', 'action-pos'].forEach(attachCategoryPreview);

    // 범례는 base-pos 미리보기 바로 아래에 한 번만 표시
    const anchor = document.getElementById('base-pos-category-preview');
    if (anchor) {
        const legend = document.createElement('div');
        legend.id = 'prompt-category-legend';
        legend.style.cssText = 'margin-top:4px; font-size:0.75em; color:#888;';
        legend.innerHTML = PROMPT_CATEGORY_LEGEND_HTML;
        anchor.insertAdjacentElement('afterend', legend);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensurePromptCategoryPreviewUI);
} else {
    ensurePromptCategoryPreviewUI();
}

/** 아무 입력창/모달도 포커스/열려있지 않은 상태에서 Enter를 누르면
 *  "🚀 큐 전체 순차 생성 시작" 버튼을 누른 것처럼 배치 생성을 바로 시작한다. */
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;

    const active = document.activeElement;
    const tag = active ? active.tagName : '';
    const isFormField = ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(tag) || (active && active.isContentEditable);
    if (isFormField) return;

    // 열려있는 모달이 있으면 그쪽 엔터 동작을 방해하지 않도록 무시
    const openModal = Array.from(document.querySelectorAll('.modal-overlay'))
        .some(m => m.style.display && m.style.display !== 'none');
    if (openModal) return;

    e.preventDefault();
    if (typeof startBatchGeneration === 'function') startBatchGeneration();
});

/** "범위 지정" 입력칸에 값이 남아있으면, 새로 추가한 항목이 조용히 건너뛰어지는 걸 눈치채기 쉽게
 *  경고 문구 + 빠른 초기화 버튼을 옆에 달아준다. */
function ensureBatchRangeWarning() {
    const rangeInput = document.getElementById('batch-range-input');
    if (!rangeInput || document.getElementById('batch-range-warning')) return;

    const warn = document.createElement('div');
    warn.id = 'batch-range-warning';
    warn.style.cssText = 'display:none; margin-top:6px; font-size:0.8em; color:#FF9800; align-items:center; gap:8px;';
    warn.innerHTML = `
        <span>⚠️ 범위 지정이 남아있어서, 이 범위 밖의 항목(새로 추가한 것 포함)은 생성이 건너뛰어집니다.</span>
        <button type="button" style="padding:2px 8px; font-size:0.85em; background:#333; border:1px solid #FF9800; color:#FF9800; border-radius:4px; cursor:pointer;"
            onclick="document.getElementById('batch-range-input').value=''; document.getElementById('batch-range-warning').style.display='none';">범위 지우기</button>
    `;
    rangeInput.insertAdjacentElement('afterend', warn);

    const updateWarning = () => {
        warn.style.display = rangeInput.value.trim() ? 'flex' : 'none';
    };
    rangeInput.addEventListener('input', updateWarning);
    updateWarning();
}
document.addEventListener('DOMContentLoaded', () => setTimeout(ensureBatchRangeWarning, 300));

window.clientId = Math.random().toString(36).substring(2, 15);

/**
 * 히스토리(미리보기) 이미지를 Ctrl+클릭했을 때, 검수 도구와 같은 백엔드(review_accept)를 재사용해서
 * 폴더+번호를 물어보고 바로 그 번호로 파일 복사한다. (검수 흐름 안 거치고 한 번에 보내는 단축 기능)
 */
/** Ctrl+클릭으로 이미 저장 보낸 파일들(filename::subfolder) 기록 — 새로고침해도 유지되도록 localStorage 사용 */
function getQuickSentFileKeys() {
    try { return new Set(JSON.parse(localStorage.getItem('quickSentFileKeys') || '[]')); }
    catch (e) { return new Set(); }
}
function markQuickSentFile(key) {
    const set = getQuickSentFileKeys();
    set.add(key);
    localStorage.setItem('quickSentFileKeys', JSON.stringify([...set].slice(-2000)));
}

async function quickSendNumberedFile(filename, subfolder, type, promptId) {
    // 🐛 버그 수정: 예전엔 "이미 보낸 파일" 판별 키가 filename+subfolder뿐이었는데, ComfyUI 파일명은
    // 카운터 기반(ComfyUI_00001_.png 등)이라 시간이 지나면 다른 이미지끼리도 이름이 재사용/중복될 수 있다.
    // localStorage 기록은 세션을 넘어 영구 보존되므로, 예전에 보냈던 것과 우연히 같은 이름의 "전혀 다른
    // 새 이미지"를 Ctrl+클릭 한 번도 안 했는데도 "이미 저장했다"고 오인하는 문제가 있었다.
    // → 이번 생성에서만 존재하는 prompt_id(사실상 유일값)를 키에 포함시켜서, 우연한 파일명 재사용으로
    //   인한 오판을 방지한다. promptId가 없는 경우(구버전 호출 등)에만 기존 방식으로 폴백.
    const sentKey = promptId
        ? `${filename}::${subfolder || ''}::${promptId}`
        : `${filename}::${subfolder || ''}`;
    if (getQuickSentFileKeys().has(sentKey)) {
        alert('✅ 이 이미지는 이미 저장했습니다. (다시 저장하려면 검수 도구를 이용해 주세요)');
        return;
    }

    // 폴더는 더 이상 물어보지 않고, 검수 도구에서 입력했던 폴더를 그대로 재사용한다.
    const dest = (typeof reviewState !== 'undefined' && reviewState.destFolder)
        ? reviewState.destFolder
        : localStorage.getItem('reviewDestFolder');
    if (!dest) {
        alert('먼저 🖼 이미지 검수 도구를 한 번 열어서 저장 폴더를 입력해 주세요.\n(그 폴더를 Ctrl+클릭 저장에도 그대로 사용합니다)');
        return;
    }

    // 대기열 안에서 이 결과 파일을 만든 job과, 그 job 안에서 몇 번째 결과인지 찾는다
    // (job.lastResults는 반복 생성 시 여러 개가 쌓일 수 있음)
    let matchedJob = null, matchedResultIndex = -1;
    if (typeof jobQueue !== 'undefined') {
        for (const job of jobQueue) {
            const results = job.lastResults || (job.lastResult ? [job.lastResult] : []);
            // 🐛 subfolder 경로 구분자 불일치 버그 수정: 히스토리 썸네일의 onclick 핸들러는 subfolder를
            // '\'→'/' 로 정규화해서 넘기는데(HTML 속성 이스케이프 때문), job.lastResults에 저장된 subfolder는
            // ComfyUI가 준 원본 그대로(Windows에선 '\' 포함)라서 문자열 비교가 항상 실패했다.
            // → 대기열 매칭이 안 되니 저장은 성공해도 대기열에서 안 빠지는 것처럼 보였음. 양쪽 다 정규화해서 비교.
            const normSlash = (s) => (s || '').replace(/\\/g, '/');
            const ri = results.findIndex(r => r.filename === filename && normSlash(r.subfolder) === normSlash(subfolder));
            if (ri !== -1) { matchedJob = job; matchedResultIndex = ri; break; }
        }
    }

    let number;
    if (matchedJob && typeof getGroupPositionForJob === 'function') {
        const groupPos = getGroupPositionForJob(matchedJob);
        // 같은 조각을 반복생성해서 여러 장이어도, 번호는 항상 그 조각 번호 그대로 (밑줄 접미사 없이 덮어쓰기)
        if (groupPos !== null) number = groupPos;
    }
    if (number === undefined || number === null) {
        const numberStr = prompt('번호를 입력하세요: (그룹 정보를 찾지 못해 자동 계산할 수 없습니다)', '');
        if (numberStr === null || numberStr.trim() === '') return;
        number = parseInt(numberStr.trim(), 10);
        if (isNaN(number)) return alert('숫자를 입력해 주세요.');
    }

    // 실제 저장(서버 통신)은 여기서 끝. 이 아래(대기열 정리 등)에서 에러가 나도
    // "저장 자체는 이미 성공"이므로 저장 실패로 잘못 보고하지 않는다.
    let res;
    try {
        res = await API.post('/assetmanager/api/review_accept', { filename, subfolder, type, destFolder: dest, number });
    } catch (e) {
        alert('서버 통신 오류로 저장하지 못했습니다.');
        return;
    }
    if (!res.ok) return alert(`❌ 저장 실패: ${res.error}`);
    localStorage.setItem('reviewDestFolder', dest);
    markQuickSentFile(sentKey);

    // 저장은 이미 끝났으니, 이후 대기열 정리 단계에서 문제가 생겨도 조용히 넘어가고 성공 메시지는 그대로 띄운다
    try {
        if (matchedJob) {
            const dKey = `${matchedJob.id}::${matchedResultIndex}`;
            if (typeof markJobAsReviewed === 'function') markJobAsReviewed(dKey);

            const total = (matchedJob.lastResults || []).length;
            const reviewedSet = (typeof getReviewedJobIds === 'function') ? getReviewedJobIds() : new Set();
            const stillPending = Array.from({ length: total }, (_, i) => i)
                .some(i => !reviewedSet.has(`${matchedJob.id}::${i}`));

            // 이 job에서 나온 결과 이미지를 전부 다 처리했을 때만 대기열에서 완전히 제거
            if (!stillPending) {
                const idx = jobQueue.findIndex(j => j.id === matchedJob.id);
                if (idx !== -1) jobQueue.splice(idx, 1);
            }
            if (typeof renderJobQueue === 'function') renderJobQueue();
            if (window.appStateManager) window.appStateManager.debounceSave();
        }
    } catch (e) {
        console.error('저장은 성공했지만 대기열 정리 중 오류:', e);
    }

    alert(`✅ ${number}번으로 저장했습니다.${matchedJob ? ' (대기열에서도 처리됨)' : ''}\n${res.destPath}`);
}

/* HTTPS(Cloudflare 터널 등) 환경에서는 wss://, 그 외에는 ws:// 자동 선택 */
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
try {
    window.ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws?clientId=${window.clientId}`);
} catch (e) {
    console.error("[AssetManager] WebSocket 연결 실패:", e);
    window.ws = { addEventListener: () => {}, removeEventListener: () => {}, send: () => {} };
}

/* ══════════════════════════════════════════════
   🩺 AssetManager 진단용 "블랙박스 기록기" (window.amDiag)
   페이지가 열려있는 동안 아래 이벤트를 조용히 기록해두고, 🛠️ 도구 ▶ 🩺 에셋매니저 진단 탭이
   이 기록 + 현재 서버 상태 점검으로 "어디서 막혔는지"를 추정한다. (기록만 할 뿐 기존 동작은 바꾸지 않음)
     - ComfyUI 웹소켓: 연결/끊김, 큐 상태, 실행 시작, 노드 전환, 진행률, 완료, 오류, 중지
     - HTTP: /prompt, /queue, /history, /interrupt, /upload, /assetmanager/api/* 응답 코드·소요시간·오류 내용
       (NAI/나노바나나/NAI Director 호출은 따로 "외부 API"로 구분해서 진행 중/실패 추적)
     - 프론트 JS 오류(error/unhandledrejection), console.error/warn
     - executeGeneration() 시작/종료 (앱이 결과를 기다리는 중인지 판단용)
   ⚠️ 전부 try/catch로 감쌌고, 원래 함수는 그대로 호출한다(fetch/console/executeGeneration은 얇은 래퍼).
   ────────────────────────────────────────────── */
(function installAmDiagRecorder() {
    if (window.amDiag) return;
    const MAX_EVENTS = 400;
    const D = window.amDiag = {
        events: [],
        _seq: 0,
        state: {
            installedAt: Date.now(),
            lastWsMsgAt: 0, lastWsType: '', wsOpenAt: 0, wsCloseAt: 0, queueRemaining: null,
            exec: { promptId: '', startedAt: 0, finishedAt: 0, node: '', nodeTitle: '', nodeSince: 0, progress: null, error: null, cachedCount: 0 },
            lastPrompt: null,        // 마지막 /prompt 요청 결과 {at, ok, status, promptId, message, nodeErrors[]}
            lastExternalFail: null,  // 마지막 NAI/나노바나나/Director 실패 {at, url, status, message}
            lastBackendFail: null,   // 마지막 /assetmanager/api/* 실패 {at, url, status, message}
            appWait: [],             // 진행 중인 executeGeneration {id, at, name}
            inflight: [],            // 진행 중인 외부 API 호출 {id, at, url}
            jsErrors: 0
        },
        log(level, type, msg, extra) {
            try {
                D.events.push({ t: Date.now(), level, type, msg: String(msg).slice(0, 400), extra });
                if (D.events.length > MAX_EVENTS) D.events.splice(0, D.events.length - MAX_EVENTS);
            } catch (e) {}
        },
        clear() {
            D.events.length = 0;
            const S = D.state;
            S.lastPrompt = null; S.lastExternalFail = null; S.lastBackendFail = null; S.jsErrors = 0;
            S.exec = { promptId: '', startedAt: 0, finishedAt: 0, node: '', nodeTitle: '', nodeSince: 0, progress: null, error: null, cachedCount: 0 };
        }
    };
    const S = D.state;
    const short = (s, n) => String(s == null ? '' : s).slice(0, n || 300);

    /* ── 1) 웹소켓 ── */
    try {
        const ws = window.ws;
        if (ws && typeof ws.addEventListener === 'function') {
            ws.addEventListener('open', () => { S.wsOpenAt = Date.now(); D.log('info', 'ws', '웹소켓 연결됨'); });
            ws.addEventListener('close', (e) => { S.wsCloseAt = Date.now(); D.log('error', 'ws', `웹소켓 끊김 (code ${e && e.code}${e && e.reason ? ', ' + e.reason : ''})`); });
            ws.addEventListener('error', () => D.log('error', 'ws', '웹소켓 오류 발생'));
            ws.addEventListener('message', (event) => {
                try {
                    const now = Date.now();
                    S.lastWsMsgAt = now;
                    if (typeof event.data !== 'string') { S.lastWsType = 'preview'; return; } // 미리보기 이미지(바이너리)도 "살아있다" 신호
                    const m = JSON.parse(event.data);
                    const t = m.type, d = m.data || {};
                    S.lastWsType = t;
                    const ex = S.exec;
                    if (t === 'status') {
                        const q = d.status && d.status.exec_info ? d.status.exec_info.queue_remaining : null;
                        if (q !== null && q !== undefined) { S.queueRemaining = q; D.log('info', 'ws', `ComfyUI 큐 상태: 남은 작업 ${q}개`); }
                    } else if (t === 'execution_start') {
                        S.exec = { promptId: d.prompt_id || '', startedAt: now, finishedAt: 0, node: '', nodeTitle: '', nodeSince: now, progress: null, error: null, cachedCount: 0 };
                        D.log('info', 'exec', `실행 시작 (prompt ${short(d.prompt_id, 8)})`);
                    } else if (t === 'execution_cached') {
                        ex.cachedCount = (d.nodes || []).length;
                        D.log('info', 'exec', `캐시된 노드 ${ex.cachedCount}개는 건너뜀`);
                    } else if (t === 'executing') {
                        if (d.node) {
                            ex.node = d.node; ex.nodeTitle = (window.globalNodeTitleMap || {})[d.node] || ''; ex.nodeSince = now; ex.progress = null;
                            D.log('info', 'exec', `노드 실행: ${ex.nodeTitle || ('#' + d.node)}`);
                        } else {
                            ex.finishedAt = now; D.log('info', 'exec', '실행 완료 (마지막 노드 종료)');
                        }
                    } else if (t === 'progress') {
                        ex.progress = { v: d.value, max: d.max, t: now };
                        if (d.value <= 1 || d.value === d.max) D.log('info', 'exec', `진행 ${d.value}/${d.max}`);
                    } else if (t === 'executed') {
                        const n = d.output && d.output.images ? d.output.images.length : 0;
                        D.log('info', 'exec', `노드 #${d.node} 출력 완료${n ? ` (이미지 ${n}장)` : ''}`);
                    } else if (t === 'execution_success') {
                        ex.finishedAt = now; D.log('info', 'exec', '실행 성공으로 종료');
                    } else if (t === 'execution_error') {
                        ex.error = { at: now, node: d.node_id, nodeType: d.node_type, message: short(d.exception_message, 400), type: d.exception_type };
                        ex.finishedAt = now;
                        D.log('error', 'exec', `노드 #${d.node_id} (${d.node_type}) 실행 오류: ${short(d.exception_message, 200)}`);
                    } else if (t === 'execution_interrupted') {
                        ex.finishedAt = now; D.log('warn', 'exec', '실행이 중지됨(인터럽트)');
                    }
                } catch (e) {}
            });
        } else {
            D.log('warn', 'ws', '웹소켓 객체를 만들지 못했습니다 (연결 실패)');
        }
    } catch (e) {}

    /* ── 2) HTTP (fetch 얇은 래퍼) ── */
    const EXTERNAL_RE = /\/assetmanager\/api\/(nai_generate|nanobanana_generate|gpt_generate|nai_director)$/;
    function peekBody(res, cb) {
        try { res.clone().text().then(cb).catch(() => cb('')); } catch (e) { cb(''); }
    }
    function errMessageFromBody(txt) {
        if (!txt) return '';
        try {
            const j = JSON.parse(txt);
            if (j && typeof j === 'object') {
                const m = (j.error && (j.error.message || j.error)) || j.message || j.detail || '';
                return short(typeof m === 'string' ? m : JSON.stringify(m), 300);
            }
        } catch (e) {}
        return short(txt, 300);
    }
    function summarizePromptError(txt) {
        const out = { message: '', nodeErrors: [] };
        try {
            const j = JSON.parse(txt);
            if (j.error) out.message = short(j.error.message || j.error.type || JSON.stringify(j.error), 200);
            if (j.error && j.error.type) out.type = j.error.type;
            const ne = j.node_errors || {};
            Object.keys(ne).slice(0, 5).forEach(id => {
                const e = ne[id] || {};
                (e.errors || []).slice(0, 2).forEach(er => out.nodeErrors.push({ id, classType: e.class_type, type: er.type, message: short(er.message, 120), details: short(er.details, 120) }));
            });
        } catch (e) { out.message = short(txt, 200); }
        return out;
    }
    try {
        if (typeof window.fetch === 'function' && !window.fetch.__amDiagWrapped) {
            const origFetch = window.fetch.bind(window);
            const wrapped = function (input, init) {
                let shortUrl = '';
                try {
                    const raw = typeof input === 'string' ? input : (input && input.url) || String(input);
                    shortUrl = raw.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
                } catch (e) {}
                const silent = init && init.__amDiagSilent;
                const watched = !silent && (/(^|\/)(prompt|queue|interrupt)$/.test(shortUrl) || /(^|\/)(history|upload)\//.test(shortUrl) || /\/assetmanager\/api\//.test(shortUrl))
                    && !/\/assetmanager\/api\/log$/.test(shortUrl);
                if (!watched) return origFetch(input, init);
                const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
                const isPrompt = method === 'POST' && /\/prompt$/.test(shortUrl);
                const isExternal = EXTERNAL_RE.test(shortUrl);
                const isBackend = /\/assetmanager\/api\//.test(shortUrl) && !isExternal;
                const t0 = performance.now();
                let inflightRec = null;
                if (isExternal) { inflightRec = { id: ++D._seq, at: Date.now(), url: shortUrl }; S.inflight.push(inflightRec); D.log('info', 'http', `외부 API 요청 시작: ${shortUrl.split('/').pop()}`); }
                const done = () => { if (inflightRec) S.inflight = S.inflight.filter(x => x.id !== inflightRec.id); };
                return origFetch(input, init).then(res => {
                    done();
                    try {
                        const ms = Math.round(performance.now() - t0);
                        const noisy = res.ok && method === 'GET' && ms < 4000;
                        if (!noisy) D.log(res.ok ? 'info' : 'error', 'http', `${method} ${shortUrl} → ${res.status} (${ms}ms)`);
                        if (isPrompt) {
                            S.lastPrompt = { at: Date.now(), ok: res.ok, status: res.status, promptId: '', message: '', nodeErrors: [] };
                            peekBody(res, txt => {
                                try {
                                    if (res.ok) {
                                        const j = JSON.parse(txt); S.lastPrompt.promptId = j.prompt_id || '';
                                        const ne = j.node_errors || {};
                                        if (Object.keys(ne).length) { const s = summarizePromptError(txt); S.lastPrompt.nodeErrors = s.nodeErrors; D.log('warn', 'http', `프롬프트 접수됐지만 일부 노드 경고: ${s.nodeErrors.map(x => `#${x.id} ${x.message}`).join(' / ')}`); }
                                    } else {
                                        const s = summarizePromptError(txt); Object.assign(S.lastPrompt, s);
                                        D.log('error', 'http', `ComfyUI가 프롬프트를 거부: ${s.message}${s.nodeErrors.length ? ' / ' + s.nodeErrors.map(x => `#${x.id}(${x.classType}) ${x.message}`).join(' / ') : ''}`);
                                    }
                                } catch (e) {}
                            });
                        } else if (!res.ok && (isExternal || isBackend)) {
                            peekBody(res, txt => {
                                const rec = { at: Date.now(), url: shortUrl, status: res.status, message: errMessageFromBody(txt) };
                                if (isExternal) S.lastExternalFail = rec; else S.lastBackendFail = rec;
                                D.log('error', 'http', `${shortUrl.split('/').pop()} 실패 응답: ${rec.message || '(내용 없음)'}`);
                            });
                        }
                    } catch (e) {}
                    return res;
                }, err => {
                    done();
                    try {
                        const ms = Math.round(performance.now() - t0);
                        const msg = short(err && err.message, 200);
                        D.log('error', 'http', `${method} ${shortUrl} → 네트워크 오류: ${msg} (${ms}ms)`);
                        const rec = { at: Date.now(), url: shortUrl, status: 0, message: msg };
                        if (isPrompt) S.lastPrompt = { at: Date.now(), ok: false, status: 0, promptId: '', message: msg, nodeErrors: [] };
                        else if (isExternal) S.lastExternalFail = rec;
                        else if (isBackend) S.lastBackendFail = rec;
                    } catch (e) {}
                    throw err;
                });
            };
            wrapped.__amDiagWrapped = true;
            window.fetch = wrapped;
        }
    } catch (e) {}

    /* ── 3) JS 오류 / console ── */
    try {
        window.addEventListener('error', (e) => {
            if (e && e.message) { S.jsErrors++; D.log('error', 'js', `${short(e.message, 200)} (${String(e.filename || '').split('/').pop()}:${e.lineno || '?'})`); }
        });
        window.addEventListener('unhandledrejection', (e) => {
            S.jsErrors++;
            const r = e && e.reason;
            D.log('error', 'js', `처리 안 된 Promise 오류: ${short((r && r.message) || r, 200)}`);
        });
        ['error', 'warn'].forEach(kind => {
            const orig = console[kind];
            console[kind] = function (...args) {
                try {
                    const text = args.map(a => a instanceof Error ? a.message : (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch (e) { return String(a); } })())).join(' ');
                    D.log(kind === 'error' ? 'error' : 'warn', 'console', short(text, 300));
                } catch (e) {}
                return orig.apply(console, args);
            };
        });
    } catch (e) {}

    /* ── 4) executeGeneration 시작/종료 (앱이 결과를 기다리는 중인지) ── */
    try {
        if (typeof window.executeGeneration === 'function' && !window.executeGeneration.__amDiagWrapped) {
            const origExec = window.executeGeneration;
            const wrappedExec = async function (...args) {
                const rec = { id: ++D._seq, at: Date.now(), name: short(args[2], 60) };
                S.appWait.push(rec);
                D.log('info', 'app', `생성 요청 시작: ${rec.name || '(이름 없음)'}`);
                try {
                    const r = await origExec.apply(this, args);
                    D.log('info', 'app', `생성 요청 완료 (${Math.round((Date.now() - rec.at) / 1000)}초)`);
                    return r;
                } catch (e) {
                    D.log('error', 'app', `생성 요청 실패: ${short(e && e.message || e, 200)}`);
                    throw e;
                } finally {
                    S.appWait = S.appWait.filter(x => x.id !== rec.id);
                }
            };
            wrappedExec.__amDiagWrapped = true;
            window.executeGeneration = wrappedExec;
        }
    } catch (e) {}
    /* ── 5) 📋 로그 패널 보강 (로그가 펼쳐져 있을 때만 동작 — 접혀있으면 아무것도 안 함) ──
       (a) 패널 맨 위에 "🩺 간단 진단" 한 줄: 지금 어느 노드에서 막힌 것 같은지(예: VAE, 체크포인트 로더)를 신호등과 함께 보여줌.
           판정은 library.js의 amDiagInfer()를 그대로 쓰며(🩺 버튼/진단 탭과 같은 결과), 클릭하면 빠른 진단 팝업이 열린다.
       (b) 실행 중인 줄(.log-entry.active)에 경과 초를 1초마다 갱신하고, 마지막 신호 후 30초↑는 주황+⚠️, 90초↑는 빨강으로 바꾼다.
           끝난 줄에는 그 노드의 마지막 경과 시간이 그대로 남는다(= 노드별 소요 시간).
       pushNodeExecutionLog()/resetNodeExecutionLog()는 건드리지 않는다. reset이 패널 내용을 통째로 지워도 1초 안에 헤더를 다시 만든다. */
    function ensureNodeLogDiagHeader(panel) {
        let el = panel.querySelector('#node-log-diag');
        if (!el) {
            el = document.createElement('div');
            el.id = 'node-log-diag';
            el.style.cssText = 'position:sticky; top:0; z-index:1; background:#1a1a1a; border-bottom:1px solid #333; padding:3px 2px 5px; margin-bottom:4px; cursor:pointer; line-height:1.35; word-break:break-word;';
            el.addEventListener('click', () => { if (typeof openAmDiagQuick === 'function') openAmDiagQuick(); });
        }
        if (panel.firstChild !== el) panel.insertBefore(el, panel.firstChild); // 항상 맨 위(로그 줄들은 그 아래로 쌓임)
        return el;
    }
    function updateNodeLogDiag(panel) {
        if (typeof amDiagInfer !== 'function') return;
        const el = ensureNodeLogDiagHeader(panel);
        const inf = amDiagInfer();
        const top = inf[0] || { level: 'ok', title: '', detail: '', next: [] };
        const icon = { error: '🔴', warn: '🟡', info: '🟢', ok: '⚪' }[top.level] || '⚪';
        const color = { error: '#ff5555', warn: '#FF9800', info: '#4CAF50', ok: '#888' }[top.level] || '#888';
        const line1 = top.level === 'ok' ? '이상 없음' : top.title;
        let line2 = '';
        if (top.level === 'error' || top.level === 'warn') { // 원인 한 줄: 판정이 준 short(예: "VAE 디코딩 단계입니다. …") 우선, 없으면 설명의 첫 문장
            line2 = top.short || String(top.detail || '').split('\n')[0].slice(0, 110);
        }
        const key = `${top.level}|${line1}|${line2}`;
        if (el.dataset.k !== key) {
            el.dataset.k = key;
            el.style.color = color;
            el.textContent = '';
            const a = document.createElement('div'); a.style.fontWeight = 'bold'; a.textContent = `🩺 ${icon} ${line1}`; el.appendChild(a);
            if (line2) { const b = document.createElement('div'); b.style.cssText = 'color:#bbb; font-size:0.92em;'; b.textContent = line2; el.appendChild(b); }
        }
        el.title = [top.title, top.detail, ...top.next.map(n => '→ ' + n), '(클릭: 자세한 진단)'].filter(Boolean).join('\n');
    }
    setInterval(() => {
        try {
            const panel = document.getElementById('node-log-panel');
            if (!panel || panel.offsetParent === null) return; // 📋 로그가 접혀있거나 화면에 안 보이면 아무것도 안 함
            updateNodeLogDiag(panel);
            const ex = S.exec;
            if (!ex.startedAt || ex.finishedAt) return;
            const active = panel.querySelector('.log-entry.active');
            if (!active) return;
            const now = Date.now();
            const idle = S.lastWsMsgAt ? now - S.lastWsMsgAt : 0;
            let span = active.querySelector('.log-elapsed');
            if (!span) {
                span = document.createElement('span');
                span.className = 'log-elapsed';
                span.style.cssText = 'margin-left:auto; flex-shrink:0; opacity:0.9; padding-left:4px;';
                active.appendChild(span);
            }
            span.textContent = `${Math.round((now - (ex.nodeSince || ex.startedAt)) / 1000)}s${idle > 30000 ? ' ⚠️' : ''}`;
            span.title = idle > 30000 ? `마지막 신호 후 ${Math.round(idle / 1000)}초째 무신호 — 🩺 진단으로 원인 확인` : '이 노드가 실행된 시간';
            active.style.color = idle > 90000 ? '#ff5555' : (idle > 30000 ? '#FF9800' : '#FFC107');
        } catch (e) {}
    }, 1000);
    D.log('info', 'app', '진단 기록기 시작');
})();

/** state_manager.js에서 저장된 큐 데이터를 복원하기 위한 브릿지 함수 */
function restoreJobQueue(savedQueue) {
    jobQueue = savedQueue;
    renderJobQueue();
}

/** state_manager.js의 getCurrentState에서 현재 큐 데이터를 읽어가기 위한 getter */
function getJobQueue() {
    return jobQueue;
}

window.globalNodeTitleMap = {};
window.currentStepText = "이미지를 생성하는 중";

/* ──────────────────────────────────────────────
   노드 실행 로그 패널 (실시간 렌더링 뷰어 옆에 표시)
   ────────────────────────────────────────────── */

function resetNodeExecutionLog() {
    const panel = document.getElementById('node-log-panel');
    if (!panel) return;
    panel.innerHTML = '<div id="node-log-placeholder" style="color: #555; text-align: center; margin-top: 10px;">실행 로그가<br>여기에 표시됩니다</div>';
}

function pushNodeExecutionLog(nodeId, title) {
    const panel = document.getElementById('node-log-panel');
    if (!panel) return;

    const placeholder = document.getElementById('node-log-placeholder');
    if (placeholder) placeholder.remove();

    // 이전 항목들은 완료(✓) 표시로 전환
    panel.querySelectorAll('.log-entry.active').forEach(el => {
        el.classList.remove('active');
        el.style.color = '#5c8a5c';
        const icon = el.querySelector('.log-icon');
        if (icon) icon.textContent = '✓';
    });

    const displayName = title ? title.replace(/^\[.*?\]\s*/, '') || title : `노드 #${nodeId}`;

    const entry = document.createElement('div');
    entry.className = 'log-entry active';
    entry.style.cssText = 'color: #FFC107; display: flex; gap: 5px; align-items: flex-start; line-height: 1.3;';
    entry.innerHTML = `<span class="log-icon" style="flex-shrink:0;">▶</span><span>${displayName}</span>`;
    panel.appendChild(entry);

    panel.scrollTop = panel.scrollHeight;
}

function toggleNodeLogPanel() {
    const panel = document.getElementById('node-log-panel');
    const btn = document.getElementById('node-log-toggle');
    if (!panel || !btn) return;

    const isCollapsed = panel.style.display === 'none';
    panel.style.display = isCollapsed ? 'flex' : 'none';
    btn.innerText = isCollapsed ? '📋 로그 ▼' : '📋 로그 ▶';

    try { localStorage.setItem('nodeLogPanelCollapsed', isCollapsed ? '0' : '1'); } catch (e) {}
}

/* 마지막 접기 상태 복원 */
(function restoreNodeLogPanelState() {
    try {
        const collapsed = localStorage.getItem('nodeLogPanelCollapsed') === '1';
        if (collapsed) {
            document.addEventListener('DOMContentLoaded', () => {
                const panel = document.getElementById('node-log-panel');
                const btn = document.getElementById('node-log-toggle');
                if (panel) panel.style.display = 'none';
                if (btn) btn.innerText = '📋 로그 ▶';
            });
        }
    } catch (e) {}
})();

/* ──────────────────────────────────────────────
   웹소켓 실시간 이벤트 처리 (진행률, 라이브 프리뷰, 결과 수신)
   ────────────────────────────────────────────── */

window.ws.binaryType = "arraybuffer";

window.ws.onmessage = function (event) {
    /* 바이너리 데이터: 라이브 프리뷰 썸네일 (ComfyUI Preview Format) */
    if (event.data instanceof ArrayBuffer) {
        const view = new DataView(event.data);
        const eventType = view.getUint32(0);
        if (eventType === 1) {
            const imageFormat = view.getUint32(4);
            const mimeType = imageFormat === 2 ? "image/png" : "image/jpeg";
            const imageBlob = new Blob([event.data.slice(8)], { type: mimeType });
            const imageUrl = URL.createObjectURL(imageBlob);

            if (window.isStandaloneExecution) {
                const imgEl = document.getElementById('censor-preview-img');
                if (imgEl) {
                    imgEl.src = imageUrl;
                    if (imgEl.dataset.prevUrl) URL.revokeObjectURL(imgEl.dataset.prevUrl);
                    imgEl.dataset.prevUrl = imageUrl;
                }
            } else {
                document.getElementById('live-preview-placeholder').style.display = 'none';
                const imgEl = document.getElementById('live-preview-img');
                imgEl.style.display = 'block';
                imgEl.src = imageUrl;
                if (imgEl.dataset.prevUrl) {
                    URL.revokeObjectURL(imgEl.dataset.prevUrl);
                }
                imgEl.dataset.prevUrl = imageUrl;
            }
        }
        return;
    }

    /* JSON 텍스트 데이터 */
    if (typeof event.data !== "string") return;
    const data = JSON.parse(event.data);

    /* 단독검열기 모드 중에는 Generate 탭 UI를 건드리지 않고 리턴 */
    if (window.isStandaloneExecution) return;

    /* 생성 시작 (UI 리셋) */
    if (data.type === 'execution_start' && data.data && data.data.prompt_id) {
        document.getElementById('live-status-text').innerText = `🚀 렌더링 큐 배정됨...`;
        document.getElementById('live-status-text').style.color = '#FF9800';
        document.getElementById('live-preview-placeholder').style.display = 'block';
        document.getElementById('live-preview-img').style.display = 'none';
        document.getElementById('progress-container').style.display = 'none';
        document.getElementById('progress-bar').style.width = '0%';
        resetNodeExecutionLog();
    }

    /* 노드 실행 시작 (상태 텍스트를 현재 실행 중인 노드에 맞게 갱신) */
    if (data.type === 'executing' && data.data && data.data.node) {
        const nodeId = data.data.node;
        const title = window.globalNodeTitleMap[nodeId];
        if (title) {
            if (title.includes("Upscale")) window.currentStepText = "업스케일링을 하는 중";
            else if (title.includes("Face Detailer")) window.currentStepText = "얼굴 디테일링을 하는 중";
            else if (title.includes("Eye Detailer")) window.currentStepText = "눈 디테일링을 하는 중";
            else if (title.includes("Mouth Detailer")) window.currentStepText = "입 디테일링을 하는 중";
            else if (title.includes("Hand Detailer")) window.currentStepText = "손 디테일링을 하는 중";
            else if (title.includes("[Censor]")) window.currentStepText = "검열 처리를 하는 중";
            else if (title.includes("[IPAdapter]")) window.currentStepText = "IP-Adapter를 적용하는 중";
            else if (title.includes("Lora")) window.currentStepText = "LoRA를 적용하는 중";
            else if (title.includes("KSampler")) window.currentStepText = "이미지를 생성하는 중";
            else if (title.includes("VAE")) window.currentStepText = "이미지를 디코딩하는 중";
            else if (title.includes("ckpt") || title.includes("Checkpoint")) window.currentStepText = "모델을 불러오는 중";
            else if (title.includes("CLIP")) window.currentStepText = "CLIP을 처리하는 중";
            else if (title.includes("Save")) window.currentStepText = "이미지를 저장하는 중";
            else window.currentStepText = "처리하는 중";

            document.getElementById('live-status-text').innerText = `🔄 ${window.currentStepText}...`;
            document.getElementById('live-status-text').style.color = '#FF9800';
        }
        pushNodeExecutionLog(nodeId, title);
    }

    /* 진행률 업데이트 (프로그레스 바 갱신) */
    if (data.type === 'progress') {
        const progress = data.data.value;
        const max = data.data.max;
        document.getElementById('progress-container').style.display = 'block';
        document.getElementById('progress-bar').style.width = ((progress / max) * 100) + '%';
        document.getElementById('live-status-text').innerText = `🔄 ${window.currentStepText}... (${progress} / ${max})`;
    }

    /* 생성 중지(인터럽트) 처리: 대기 중인 Promise를 풀어주고 상태 표시를 갱신 */
    if (data.type === 'execution_interrupted') {
        document.getElementById('progress-container').style.display = 'none';
        document.getElementById('progress-bar').style.width = '0%';
        document.getElementById('live-status-text').innerText = '⏹ 생성이 중지되었습니다';
        document.getElementById('live-status-text').style.color = '#ff5555';

        const logPanel = document.getElementById('node-log-panel');
        if (logPanel) {
            logPanel.querySelectorAll('.log-entry.active').forEach(el => {
                el.classList.remove('active');
                el.style.color = '#ff5555';
                const icon = el.querySelector('.log-icon');
                if (icon) icon.textContent = '⏹';
            });
        }
    }

    /* 생성 완료: 히스토리 스택에 결과 이미지 추가 */
    if (data.type === 'executed' && data.data.output && data.data.output.images) {
        const images = data.data.output.images;
        if (images.length > 0) {
            const imgInfo = images[0];
            const fixedSubfolder = (imgInfo.subfolder || '').replace(/\\/g, '/');
            const imgSrc = `/view?filename=${encodeURIComponent(imgInfo.filename)}&type=${imgInfo.type}&subfolder=${encodeURIComponent(fixedSubfolder)}&t=${new Date().getTime()}`;

            document.getElementById('progress-container').style.display = 'none';
            document.getElementById('progress-bar').style.width = '0%';
            document.getElementById('live-status-text').innerText = `✅ 작업 완료`;
            document.getElementById('live-status-text').style.color = '#4CAF50';

            const logPanel = document.getElementById('node-log-panel');
            if (logPanel) {
                logPanel.querySelectorAll('.log-entry.active').forEach(el => {
                    el.classList.remove('active');
                    el.style.color = '#5c8a5c';
                    const icon = el.querySelector('.log-icon');
                    if (icon) icon.textContent = '✓';
                });
            }

            addHistoryItemToPanel(imgInfo, data.data.prompt_id || '');
        }
    }
};

/** 🆕 방금 생성된 이미지 1장을 오른쪽 "히스토리 스택" 패널에 추가한다(맨 위에 prepend).
 *  원래 ComfyUI 웹소켓의 'executed' 이벤트에서만 호출되던 걸 공용 함수로 뽑아서,
 *  ComfyUI를 거치지 않는 나노바나나/NAI 생성 완료 후에도 똑같이 호출할 수 있게 함
 *  (안 그러면 "생성완료"라고만 뜨고 오른쪽에 썸네일이 하나도 안 나타나는 문제가 있었음). */
/** 🆕 나노바나나/NAI처럼 ComfyUI 웹소켓 미리보기 스트림이 없는 생성 경로에서, 결과가 나온 뒤
 *  큰 미리보기 박스(live-preview-img)에도 최종 이미지를 채워서 보여준다.
 *  (ComfyUI 경로는 디노이즈 도중 프레임이 실시간으로 흘러들어와서 자동으로 채워지지만,
 *   나노바나나/NAI는 한 번에 결과만 오기 때문에 이게 없으면 미리보기 박스가 계속 비어있게 됨) */
function showResultInLivePreview(imgInfo) {
    const placeholder = document.getElementById('live-preview-placeholder');
    const imgEl = document.getElementById('live-preview-img');
    if (!imgEl) return;
    const fixedSubfolder = (imgInfo.subfolder || '').replace(/\\/g, '/');
    imgEl.src = `/view?filename=${encodeURIComponent(imgInfo.filename)}&type=${imgInfo.type}&subfolder=${encodeURIComponent(fixedSubfolder)}&t=${Date.now()}`;
    imgEl.style.display = 'block';
    if (placeholder) placeholder.style.display = 'none';
}

function addHistoryItemToPanel(imgInfo, rerollPromptId = '') {
    const fixedSubfolder = (imgInfo.subfolder || '').replace(/\\/g, '/');
    const imgSrc = `/view?filename=${encodeURIComponent(imgInfo.filename)}&type=${imgInfo.type}&subfolder=${encodeURIComponent(fixedSubfolder)}&t=${new Date().getTime()}`;

    const stack = document.getElementById('history-stack');
    if (!stack) return;
    if (stack.innerHTML.includes('아직 생성된 이미지가 없습니다')) stack.innerHTML = '';

    const item = document.createElement('div');
    item.className = 'history-item';
    item.style.position = 'relative';
    const filePath = imgInfo.subfolder ? imgInfo.subfolder + '/' + imgInfo.filename : 'output/' + imgInfo.filename;

    const safeFilename = imgInfo.filename.replace(/'/g, "%27");
    const safeSubfolder = (imgInfo.subfolder || '').replace(/'/g, "%27").replace(/\\/g, "/");

    item.innerHTML = `
        <div style="width: 100%; aspect-ratio: 1; overflow: hidden; border-radius: 6px;">
            <img src="${imgSrc}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 6px; cursor: pointer; border: 1px solid #444;"
                title="클릭=크게 보기 · Ctrl+클릭=번호 매겨서 폴더로 저장 · Ctrl+우클릭=다시 뽑기"
                onclick="if(event.ctrlKey){ event.preventDefault(); quickSendNumberedFile('${safeFilename}', '${safeSubfolder}', '${imgInfo.type}', '${rerollPromptId}'); } else { openLightbox('${imgSrc}') }"
                oncontextmenu="if(event.ctrlKey && '${rerollPromptId}'){ event.preventDefault(); openRegenModal('${rerollPromptId}'); } else { openContextMenu(event, '${safeFilename}', '${safeSubfolder}') }">
        </div>
        <div class="file-name" style="margin-top: 5px; font-size: 0.9em; font-weight: bold; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${imgInfo.filename}">${imgInfo.filename}</div>
        <div class="file-path" style="font-size: 0.8em; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${filePath}">${filePath}</div>
    `;
    stack.prepend(item);
}

/* ──────────────────────────────────────────────
   워크플로우 템플릿 로딩
   ────────────────────────────────────────────── */

window.baseWorkflow = null;

/** 서버에서 워크플로우 JSON을 불러온다 */
async function fetchWorkflowTemplate() {
    try {
        const data = await API.get('/assetmanager/api/workflow');
        if (data.status === 'success') {
            window.baseWorkflow = data.workflow;
        } else {
            console.error("Workflow JSON 로드 실패:", data.message);
        }
    } catch (e) {
        console.error("fetchWorkflowTemplate 에러:", e);
    }
}

fetchWorkflowTemplate();

/** 워크플로우 내에서 노드 타이틀로 해당 노드 ID를 검색 */
window.findNodeIdByTitle = function (workflow, targetTitle) {
    const entry = Object.entries(workflow).find(([id, node]) => node._meta && node._meta.title === targetTitle);
    return entry ? entry[0] : null;
};

/* ──────────────────────────────────────────────
   단일 생성 (버튼 클릭 → 즉시 실행)
   ────────────────────────────────────────────── */

/** 단일 모드: 현재 프롬프트로 이미지를 1장 생성 */
async function generateImage() {
    window.isGenerationCancelled = false;
    const pos = document.getElementById('base-pos').value;
    // 행동 프롬프트는 항상 메인(긍정) 프롬프트 쪽으로 텍스트 결합해서 보낸다.
    const action = document.getElementById('action-pos')?.value?.trim();
    const fullPos = applyDisabledTokens(action ? `${pos}, ${action}` : pos);
    const neg = document.getElementById('base-neg').value;
    executeGeneration(fullPos, neg, "AssetManager_Output");
}

/* ──────────────────────────────────────────────
   배치 생성 (큐 전체를 순차 실행)
   ────────────────────────────────────────────── */

/**
 * 대기열 범위 선택 파서
 * "1~5, 8, 10~12" 같은 입력을 파싱해 0-based 인덱스 Set으로 반환.
 * 입력이 비어 있거나 파싱 실패 시 null을 반환 → 전체 실행.
 */
function parseJobRangeInput(raw, totalJobs) {
    if (!raw || !raw.trim()) return null;
    const indices = new Set();
    const parts = raw.split(',');
    for (const part of parts) {
        const trimmed = part.trim();
        // "N~M" 또는 "N-M" 범위
        const rangeMatch = trimmed.match(/^(\d+)\s*[~\-]\s*(\d+)$/);
        if (rangeMatch) {
            let from = parseInt(rangeMatch[1], 10);
            let to   = parseInt(rangeMatch[2], 10);
            if (from > to) [from, to] = [to, from];
            for (let i = from; i <= to; i++) {
                if (i >= 1 && i <= totalJobs) indices.add(i - 1); // 1-based → 0-based
            }
            continue;
        }
        // 단일 숫자
        const singleMatch = trimmed.match(/^(\d+)$/);
        if (singleMatch) {
            const n = parseInt(singleMatch[1], 10);
            if (n >= 1 && n <= totalJobs) indices.add(n - 1);
        }
    }
    return indices.size > 0 ? indices : null;
}

/** 배치 모드: 대기열의 모든 작업을 경로 템플릿에 따라 순차 생성 */
async function startBatchGeneration() {
    if (jobQueue.length === 0) return alert("대기열에 작업이 없습니다.");

    window.isGenerationCancelled = false;

    const template = document.getElementById('path-template').value;

    /* 범위 선택 입력값 파싱 */
    const rangeRaw = document.getElementById('batch-range-input')?.value || '';
    const selectedIndices = parseJobRangeInput(rangeRaw, jobQueue.length);

    for (const [idx, job] of jobQueue.entries()) {
        if (window.isGenerationCancelled) break;
        /* 범위 지정이 있으면 해당 인덱스만 실행 */
        if (selectedIndices && !selectedIndices.has(idx)) continue;
        /* 비활성화된 항목은 건너뜀 */
        if (job.disabled) { console.log(`[Queue] #${idx + 1} 비활성화됨, 건너뜀`); continue; }
        let finalPath = template;
        Object.entries(job.labels).forEach(([key, val]) => {
            finalPath = finalPath.replace(`[${key}]`, val);
        });

        // 행동 프롬프트는 항상 메인(긍정) 프롬프트 쪽에 텍스트로 합쳐서 보낸다
        const actionBatch = document.getElementById('action-pos')?.value?.trim();
        const basePosWithAction = actionBatch
            ? `${document.getElementById('base-pos').value}, ${actionBatch}`
            : document.getElementById('base-pos').value;
        // 이 job에 "합치기(Shift+Ctrl)"로 만들어진 캐릭터 조합이 있으면, 그 캐릭터별 프롬프트를
        // 따로 뽑아서 리저널(영역별) 컨디셔닝에 쓴다. (한 캐릭으로 뭉개져 나오는 문제 방지)
        const regionalRefIndex = (job.sourceRefs || []).findIndex(r => r.regionalPrompts && r.regionalPrompts.length > 1);
        const regionalPrompts = regionalRefIndex !== -1 ? job.sourceRefs[regionalRefIndex].regionalPrompts : null;

        // 리저널로 쓰는 캐릭터 조합 텍스트는 공통 프롬프트에서 빼둔다 — 안 빼면
        // "공통 프롬프트에 이미 다 들어있는데 + 영역마다 또 넣는" 중복이 생김
        const commonFullPromptParts = regionalPrompts
            ? job.fullPrompt.filter((_, idx) => idx !== regionalRefIndex)
            : job.fullPrompt;
        const fullPos = (() => {
            const base = applyDisabledTokens(basePosWithAction + (commonFullPromptParts.length > 0 ? ", " + commonFullPromptParts.join(', ') : ""));
            const withBackview = job.backViewFaceWeightDown ? applyFaceWeightReduction(base) : base;
            // 🆕 이 job에 조각 전용 "긍정프롬프트 키워드 무효화"가 있으면 최종 조립 시점에 제외
            const invalidated = applyItemTokenInvalidation(withBackview, job.posInvalidateOverride);
            // 🧱 이 조각 전용 카테고리 차단 (무효화 다음, 조건부 변화 전)
            const blocked = applyItemCategoryBlock(invalidated, job.blockCategoriesOverride);
            // 🔀 이 조각 전용 조건부 프롬프트 변화 (무효화/차단까지 끝난 최종 긍정프롬프트 기준으로 판정)
            // 📷 마지막으로, 카메라 구도 자동 적용이 켜져 있으면 구도 프롬프트를 맨 뒤에 붙임
            const withCamera = applyCameraComposition(applyItemConditionalRules(blocked, job.condRulesOverride));
            // 🆕 "{color}" 플레이스홀더를 이 job에 선택된(또는 기본) 색으로 치환 — 조각 자체의
            // prompt 텍스트는 안 건드리고, 실제 전송 직전에만 치환한다.
            return withCamera.includes('{color}') ? withCamera.replace(/\{color\}/g, job.colorChoice || JOB_COLOR_PALETTE[0]) : withCamera;
        })();
        // 🆕 이 job에 조각 전용 부정프롬프트가 있으면 공통 부정프롬프트 뒤에 이어붙인다
        const baseNegText = document.getElementById('base-neg').value;
        const combinedNeg = job.negativeOverride ? `${job.negativeOverride}, ${baseNegText}` : baseNegText;
        // 🆕 이 job에 조각 전용 "부정프롬프트 키워드 무효화"가 있으면 최종 조립 시점에 제외
        // (예: 이 조각이 "사과"인데 공통 부정프롬프트에 "과일"이 있으면, 여기서 "과일"만 제외됨)
        const fullNeg = applyItemTokenInvalidation(combinedNeg, job.negInvalidateOverride);

        // 🆕 기능 추가: 이 job이 어떤 조각(들)에서 왔는지를 PNG 파일 자체에 박아넣을 수 있게 미리
        // {catId, itemId, itemName, catName} 배열로 정리해둔다(job.sourceRefs → 실제 조각 조회).
        // job당 한 번만 계산하면 되므로 반복(repeatCount) 루프 바깥에서 미리 구함.
        const fragmentInfo = (() => {
            if (!Array.isArray(job.sourceRefs) || job.sourceRefs.length === 0) return null;
            if (typeof getAllCategories !== 'function') return null;
            const allCats = getAllCategories();
            const list = job.sourceRefs.map(ref => {
                const cat = allCats.find(c => c.id === ref.catId);
                const item = cat && cat.items.find(i => i.id === ref.itemId);
                if (!item) return null;
                return { catId: ref.catId, catName: cat.name, itemId: ref.itemId, itemName: item.name || '' };
            }).filter(Boolean);
            return list.length > 0 ? list : null;
        })();

        for (let i = 0; i < job.repeatCount; i++) {
            if (window.isGenerationCancelled) break;
            const result = await executeGeneration(fullPos, fullNeg, finalPath, regionalPrompts, job.regionalLayout, job.loraOverride || null, job.img2imgOverride || null, job.controlnetOverride || null, job.censorOverride || null, (job.seedGroupSeed !== undefined ? job.seedGroupSeed : null), fragmentInfo);
            if (result && result.length > 0) {
                // 반복 생성(repeatCount>1) 또는 🔁반복출력으로 같은 job이 여러 번 실행돼도
                // 결과를 배열에 계속 쌓아서 전부 검수 대상이 되게 한다 (예전엔 마지막 것만 남고 덮어써졌음)
                // 🆕 검열이 켜져있으면 result 자체가 [원본, 검열본] 등 여러 장일 수 있는데, 전부 넣어서
                // 원본/검열본 둘 다 검수 목록에 뜨게 한다 (예전엔 마지막에 실행된 한 장만 잡혔음)
                // 🆕 이번 executeGeneration 한 번에서 나온 이미지들을 같은 genGroupId로 태그해둔다.
                // 검수 화면에서 "검열본 옆에 원본을 대조용으로 같이 보여주는" 페어링에 쓰인다.
                // (파일명 패턴으로 나중에 추측하는 건 카운터 번호가 어긋날 수 있어 불안정해서, 생성 시점에 확정해서 저장)
                if (!job.lastResults) job.lastResults = [];
                const genGroupId = `${job.id}_${Date.now()}_${i}`;
                const isPair = result.length > 1;
                result.forEach(img => {
                    job.lastResults.push({
                        filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output',
                        genGroupId,
                        isCensored: isPair ? (img.filename || '').includes('_censored') : false
                    });
                });
                job.lastResult = job.lastResults[job.lastResults.length - 1]; // 구버전 코드 호환용

                // 🆕 기능 추가(프롬 조각 생성 내역): 프롬프트 유사도 추측 대신, 이 결과를 만들어낸
                // 조각(item) 쪽에 파일명을 직접 기록해둔다. job.sourceRefs가 없으면(공통 프롬프트만으로
                // 생성한 경우 등) 기록할 대상 조각이 없으므로 조용히 아무 일도 안 함.
                if (typeof recordGeneratedImagesForRefs === 'function') {
                    recordGeneratedImagesForRefs(job.sourceRefs, result);
                }

                // 🔁 부분 재생성용: 이번에 나온 최종 결과를 다음 "일부만 다시 생성"의 기초 이미지로 쓸 수 있게 저장
                // (여러 장이 나온 경우 마지막 장 — 검열이 켜져있으면 보통 검열본이 마지막에 실행되므로,
                //  다음 부분 재생성의 기초로는 그쪽을 쓰는 게 자연스럽다)
                if (regionalPrompts && job.regionalLayout) {
                    const lastImg = result[result.length - 1];
                    const dimUsed = getResolutionFromDimensionsString(document.getElementById('adv-dimensions')?.value);
                    job.regionalLayout.lastResultImage = {
                        filename: lastImg.filename, subfolder: lastImg.subfolder || '', type: lastImg.type || 'output',
                        width: (job.regionalLayout.sketchImage || job.regionalLayout.baseImage)?.width || dimUsed.width,
                        height: (job.regionalLayout.sketchImage || job.regionalLayout.baseImage)?.height || dimUsed.height
                    };
                }
            }
        }
    }
}

/**
 * 🔁 반복출력: 대기열 전체를 N번 반복 실행한다.
 * (각 회차마다 startBatchGeneration을 그대로 재사용 — 대기열 항목은 검수 등으로
 *  직접 지우지 않는 한 그대로 남아있으므로 다음 회차에도 같은 목록이 다시 실행됨)
 */
async function startBatchGenerationRepeatedPrompt() {
    const nStr = prompt('대기열 전체를 몇 번 반복 실행할까요?', '2');
    if (nStr === null) return;
    const n = parseInt(nStr.trim(), 10);
    if (isNaN(n) || n < 1) return alert('1 이상의 숫자를 입력해 주세요.');
    await startBatchGenerationRepeated(n);
}

async function startBatchGenerationRepeated(times) {
    if (jobQueue.length === 0) return alert("대기열에 작업이 없습니다.");
    window.isGenerationCancelled = false;
    const statusEl = document.getElementById('live-status-text');

    for (let round = 1; round <= times; round++) {
        if (window.isGenerationCancelled) break;
        if (jobQueue.length === 0) {
            alert(`대기열이 비어서 ${round - 1}회차까지 실행 후 중단했습니다.`);
            break;
        }
        if (statusEl) statusEl.innerText = `🔁 반복 실행 중 (${round}/${times}회차)...`;
        await startBatchGeneration();
    }

    if (statusEl && !window.isGenerationCancelled) statusEl.innerText = `✅ 반복출력 완료 (${times}회차)`;
}
window.startBatchGenerationRepeatedPrompt = startBatchGenerationRepeatedPrompt;
window.startBatchGenerationRepeated = startBatchGenerationRepeated;

/* ──────────────────────────────────────────────
   생성 중지 (인터럽트)
   ────────────────────────────────────────────── */

/**
 * 현재 ComfyUI에서 실행 중인 작업을 중단하고,
 * 배치 큐 순차 실행 루프도 다음 차례에 멈추도록 플래그를 세운다.
 */
async function stopGeneration() {
    window.isGenerationCancelled = true;
    try {
        await fetch('/interrupt', { method: 'POST' });
    } catch (e) {
        console.error("생성 중지 요청 실패:", e);
    }
    const statusEl = document.getElementById('live-status-text');
    if (statusEl) {
        statusEl.innerText = '⏹ 중지 요청됨...';
        statusEl.style.color = '#ff5555';
    }
}

/* ──────────────────────────────────────────────
   공통 이미지 생성 통신 로직 (핵심)
   ────────────────────────────────────────────── */

/**
 * 워크플로우 JSON을 복제하여 UI 설정값을 적용한 후 ComfyUI /prompt API로 전송.
 * 업스케일러/디테일러/검열 파이프라인을 동적으로 연결하고,
 * 웹소켓을 통해 실행 완료 시점을 감지하여 Promise를 resolve한다.
 */
/**
 * 웹소켓 이벤트(executed / executing node:null)를 놓쳤을 때 쓰는 안전장치.
 * ComfyUI의 /history/{prompt_id}를 조회해서 실제로 저장된 출력 이미지를 찾아낸다.
 * 못 찾으면 null을 반환한다 (예: 진짜로 인터럽트되어 이미지가 없는 경우).
 */
async function fetchHistoryImageFallback(promptId) {
    try {
        const res = await fetch(`/history/${promptId}`);
        if (!res.ok) return null;
        const hist = await res.json();
        const entry = hist[promptId];
        const outputs = entry && entry.outputs;
        if (!outputs) return null;
        // 🆕 이 prompt에서 나온 이미지를 전부(원본 저장 노드 + 검열본 저장 노드 등) 모아서 배열로 반환.
        // 예전엔 마지막으로 발견된 이미지 하나만 반환해서, 웹소켓을 놓쳐 이 fallback을 타는 경우에도
        // 검열본만 잡히고 원본이 검수 목록에서 빠지는 문제가 있었다.
        const images = [];
        for (const nodeOutput of Object.values(outputs)) {
            if (nodeOutput.images && nodeOutput.images.length > 0) {
                nodeOutput.images.forEach(img => images.push(img));
            }
        }
        return images.length > 0 ? images : null;
    } catch (e) {
        console.error("history fallback 조회 실패:", e);
        return null;
    }
}

/** 캔버스에 그린 마스크(data URL)를 ComfyUI 서버에 업로드해서, LoadImage에서 쓸 수 있는 파일명을 받아온다 */
async function uploadImageDataUrlToComfy(dataUrl, filenamePrefix) {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const formData = new FormData();
    formData.append('image', blob, `${filenamePrefix}_${Date.now()}.png`);
    formData.append('overwrite', 'true');

    const uploadRes = await fetch('/upload/image', { method: 'POST', body: formData });
    if (!uploadRes.ok) throw new Error(`마스크 업로드 실패: HTTP ${uploadRes.status}`);
    return await uploadRes.json(); // { name, subfolder, type }
}

/**
 * 🆕 프롬프트 문자열의 괄호 짝이 맞는지 검사한다. "\(" "\)"(리터럴 괄호 문자 자체를 넣을 때
 * 쓰는 이스케이프 문법)는 가중치 강조용 괄호가 아니므로 검사에서 제외한다.
 * 문제가 있으면 사람이 읽을 안내 문자열을, 없으면 null을 반환한다.
 */
function findUnbalancedParenMessage(posPrompt, negPrompt) {
    function netDepth(str) {
        const cleaned = (str || '').replace(/\\\(/g, '').replace(/\\\)/g, '');
        let depth = 0;
        for (const ch of cleaned) {
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
        }
        return depth;
    }
    const messages = [];
    const posDepth = netDepth(posPrompt);
    if (posDepth > 0) messages.push(`긍정프롬프트: "(" 가 ${posDepth}개 더 많음 (닫는 ")" 부족)`);
    else if (posDepth < 0) messages.push(`긍정프롬프트: ")" 가 ${-posDepth}개 더 많음 (여는 "(" 부족)`);
    const negDepth = netDepth(negPrompt);
    if (negDepth > 0) messages.push(`부정프롬프트: "(" 가 ${negDepth}개 더 많음 (닫는 ")" 부족)`);
    else if (negDepth < 0) messages.push(`부정프롬프트: ")" 가 ${-negDepth}개 더 많음 (여는 "(" 부족)`);
    return messages.length ? messages.join('\n') : null;
}

/**
 * 🆕 기능 추가: GPT/나노바나나처럼 외부(OpenAI·Google) API로 나가는 생성 전에, 프롬프트에
 * 🔞 성인용으로 분류되는 태그가 있으면 경고 확인창을 띄운다. 로컬 ComfyUI 생성(NAI 포함)에는
 * 적용 안 함 — 외부 상업 API만 콘텐츠 정책/계정 제재 위험이 있어서 이 두 경로에서만 호출됨.
 * ⚙️ 환경설정(AppSettings.nsfwWarningEnabled, 기본 켜짐)에서 끌 수 있다.
 * @returns {boolean} true면 그대로 진행, false면 사용자가 취소함(호출부는 null 반환하고 끝내야 함)
 */
function confirmProceedWithAdultPrompt(posPrompt, serviceLabel) {
    try {
        if (typeof window.AppSettings !== 'undefined' && window.AppSettings.get('nsfwWarningEnabled') === false) {
            return true; // 설정에서 꺼둔 경우
        }
        if (!posPrompt || typeof classifyPromptTagSegments !== 'function') return true;

        const foundTags = [];
        posPrompt.split(',').map(t => t.trim()).filter(Boolean).forEach(tag => {
            const segments = classifyPromptTagSegments(tag);
            if (segments.some(s => s.name === '성인용')) foundTags.push(tag);
        });
        if (foundTags.length === 0) return true;

        const preview = foundTags.slice(0, 8).join(', ') + (foundTags.length > 8 ? ` 외 ${foundTags.length - 8}개` : '');
        return window.confirm(
            `⚠️ ${serviceLabel}로 보낼 프롬프트에 🔞 성인용으로 분류되는 태그가 ${foundTags.length}개 포함되어 있습니다:\n\n` +
            `${preview}\n\n` +
            `OpenAI/Google 쪽 API는 이런 내용을 서버에서 거부하거나(요청 낭비) 계정에 불이익을 줄 수 있습니다.\n` +
            `그래도 계속 보낼까요?\n\n(이 경고는 ⚙️ 환경설정에서 끌 수 있습니다)`
        );
    } catch (e) {
        console.error('[성인용 경고 체크 실패]', e);
        return true; // 체크 자체가 실패해도 생성을 막지는 않음
    }
}

/**
 * 🍌 나노바나나(Google Gemini 이미지 생성, gemini-2.5-flash-image) 전용 생성 경로.
 * ComfyUI 워크플로우를 전혀 안 쓰고, 백엔드의 /assetmanager/api/nanobanana_generate로
 * 프롬프트+API키만 보내서 서버가 Google API를 대신 호출하게 한다(브라우저에서 직접 호출하면
 * CORS에 막히고, API 키가 네트워크 탭에 그대로 노출되는 문제도 있음).
 * 반환값은 ComfyUI 결과와 똑같은 [{filename, subfolder, type}] 배열 형태라서, 이후 검수/저장
 * 파이프라인(job.lastResults 등)을 그대로 재사용할 수 있다.
 */
/**
 * 🆕 나노바나나/GPT/NAI 공통 — "생성 직후 자동 업스케일" 체크박스(#toggle-api-post-upscale)가 켜져
 * 있으면, 방금 저장된 결과 이미지({filename,subfolder,type})를 체크포인트가 필요 없는 일반 업스케일
 * (/assetmanager/api/upscale_file, Pillow Lanczos)에 그대로 돌린다. 원본은 그대로 두고 같은 폴더의
 * upscaled 하위 폴더에 확대본을 추가로 저장 — 모델 기반 업스케일/디테일러/모자이크(체크포인트 필요)는
 * 이 세 아키텍처엔 아직 못 붙임(별도 작업 필요). 실패해도 원본 생성 자체는 이미 끝난 뒤라 조용히
 * 경고만 띄우고 원본 imgInfo를 그대로 돌려준다(검수 흐름이 끊기지 않게).
 * @param {{filename:string, subfolder:string, type:string}} imgInfo
 * @returns {Promise<{filename:string, subfolder:string, type:string}>} 성공 시 업스케일본, 실패/비활성 시 원본 그대로
 */
async function autoUpscaleApiResult(imgInfo) {
    const toggle = document.getElementById('toggle-api-post-upscale');
    if (!toggle || !toggle.checked || !imgInfo) return imgInfo;

    const scale = parseFloat(document.getElementById('api-post-upscale-scale')?.value || '2');
    try {
        const res = await fetch('/assetmanager/api/upscale_file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename: imgInfo.filename, subfolder: imgInfo.subfolder || '', type: imgInfo.type || 'output',
                scale, outSubfolder: 'upscaled'
            })
        });
        const data = await res.json();
        if (!data.ok || !data.outPath) {
            console.warn('[생성 후 자동 업스케일] 실패:', data.error);
            return imgInfo;
        }
        // outPath는 서버 절대경로 — 원본과 같은 폴더 구조(output/<subfolder>/upscaled/<파일명>)이므로
        // subfolder만 "/upscaled"를 덧붙여서 재구성한다(filename/type은 그대로).
        const upscaledInfo = {
            filename: imgInfo.filename,
            subfolder: (imgInfo.subfolder ? imgInfo.subfolder + '/' : '') + 'upscaled',
            type: imgInfo.type || 'output'
        };
        return upscaledInfo;
    } catch (e) {
        console.warn('[생성 후 자동 업스케일] 서버 통신 오류:', e);
        return imgInfo;
    }
}

/**
 * 🆕 나노바나나/GPT/NAI 공통 — "고급 설정"의 업스케일링/디테일러/검열(#toggle-upscale/
 * #toggle-detailer/#toggle-mosaic) 중 하나라도 켜져 있으면, 방금 생성된 외부 API 이미지를
 * 체크포인트 기반 후처리 파이프라인(pipeline_upscaler.js/detailer.js/censor.js, 기존 로컬
 * 생성과 완전히 같은 함수)에 통과시킨다.
 *
 * 완료를 기다리지 않고 /prompt에 제출만 하고 바로 반환한다(submitRegen()과 동일한 방식) —
 * 결과는 작업이 끝나면 기존 전역 웹소켓 리스너가 알아서 히스토리 패널에 따로 추가해준다.
 * 체크포인트를 안 골랐거나 셋 다 꺼져있으면 조용히 아무것도 안 하고 반환.
 *
 * @param {{filename:string, subfolder:string, type:string}} imgInfo - 방금 저장된 결과 이미지
 */
async function applyLocalPostProcessToExternalImage(imgInfo) {
    const wantsUpscale = document.getElementById('toggle-upscale')?.checked;
    const wantsDetailer = document.getElementById('toggle-detailer')?.checked;
    const wantsCensor = document.getElementById('toggle-mosaic')?.checked;
    if (!wantsUpscale && !wantsDetailer && !wantsCensor) return; // 셋 다 꺼져있으면 할 일 없음

    if (!window.baseWorkflow) {
        console.warn('[로컬 후처리] workflow.json이 로드되지 않아 건너뜁니다.');
        return;
    }
    const checkpointName = document.getElementById('gen-checkpoint')?.value;
    if (!checkpointName) {
        alert('⚠️ 업스케일링/디테일러/검열 체크박스가 켜져 있는데 체크포인트가 선택되지 않아 후처리를 건너뜁니다.\n(나노바나나/GPT/NAI 결과 자체는 정상적으로 저장됐습니다)');
        return;
    }

    try {
        /* ── 1. 방금 저장된 이미지를 ComfyUI input 폴더로 재업로드 ──
           LoadImage 노드는 input 폴더 목록에 있는 파일만 받아줘서, output 폴더에 저장된
           외부 API 결과물을 그대로는 못 먹인다(pipeline_img2img.js 등과 동일한 제약). */
        const fixedSubfolder = (imgInfo.subfolder || '').replace(/\\/g, '/');
        const viewUrl = `/view?filename=${encodeURIComponent(imgInfo.filename)}&type=${imgInfo.type || 'output'}&subfolder=${encodeURIComponent(fixedSubfolder)}`;
        const blob = await (await fetch(viewUrl)).blob();
        const uploadForm = new FormData();
        uploadForm.append('image', blob, imgInfo.filename);
        uploadForm.append('type', 'input');
        uploadForm.append('overwrite', 'true');
        const uploadRes = await fetch('/upload/image', { method: 'POST', body: uploadForm });
        if (!uploadRes.ok) throw new Error(`재업로드 실패 (HTTP ${uploadRes.status})`);
        const uploadData = await uploadRes.json();
        const uploadedName = uploadData.subfolder ? `${uploadData.subfolder}/${uploadData.name}` : uploadData.name;

        /* ── 2. baseWorkflow 복제 + 체크포인트/로라 적용 ── */
        const promptData = JSON.parse(JSON.stringify(window.baseWorkflow));
        const ckptId = findNodeIdByTitle(promptData, "[Main] ckpt loader");
        const loraId = findNodeIdByTitle(promptData, "[Main] Lora Loader");
        const imageSaveId = findNodeIdByTitle(promptData, "[Main] Image Save");
        if (!ckptId || !imageSaveId) {
            console.warn('[로컬 후처리] 필요한 노드를 찾지 못해 건너뜁니다.');
            return;
        }
        promptData[ckptId].inputs.ckpt_name = checkpointName;

        if (loraId) {
            const loraList = Array.from(document.querySelectorAll('#selected-loras .lora-item')).map(item => ({
                lora: item.querySelector('select').value,
                strength: parseFloat(item.querySelector('input[type="number"]').value)
            }));
            delete promptData[loraId].inputs["lora_1"];
            if (loraList.length > 0) {
                loraList.forEach((entry, index) => {
                    promptData[loraId].inputs[`lora_${index + 1}`] = { on: true, lora: entry.lora, strength: entry.strength };
                });
            } else {
                promptData[loraId].inputs["lora_1"] = { on: false, lora: "None", strength: 1 };
            }
        }

        /* ── 3. LoadImage 노드 신설 → 파이프라인 시작점으로 사용 ──
           [Main] KSampler/VAE Decode 등 로컬 생성 전용 노드는 그대로 두지만, 아래서
           [Main] Image Save의 입력을 이 LoadImage 쪽으로 돌려버리므로 더 이상 어떤
           출력 노드의 조상도 아니게 돼서 ComfyUI가 알아서 실행을 건너뛴다. */
        const loadImageId = 'postproc_loadimage_001';
        promptData[loadImageId] = {
            inputs: { image: uploadedName, upload: 'image' },
            class_type: 'LoadImage',
            _meta: { title: '[PostProcess] Load Image' }
        };
        let currentImageSource = [loadImageId, 0];

        /* ── 4. 기존 로컬 생성과 완전히 같은 함수로 업스케일→디테일러→검열 순서 적용 ──
           각 함수가 내부적으로 자기 토글(#toggle-upscale 등)을 다시 읽어서 켜져있는 것만 적용함. */
        if (window.applyUpscalerPipeline) {
            currentImageSource = window.applyUpscalerPipeline(promptData, currentImageSource, findNodeIdByTitle);
        }
        if (window.applyDetailerPipeline) {
            currentImageSource = window.applyDetailerPipeline(promptData, currentImageSource, findNodeIdByTitle);
        }
        const preCensorSource = [...currentImageSource];
        const isCensorOn = wantsCensor || false;
        if (window.applyCensorPipeline) {
            currentImageSource = window.applyCensorPipeline(promptData, currentImageSource, findNodeIdByTitle);
        }

        /* ── 5. 중간 단계 미리보기 Save 노드 정리 (최종 Save만 유지) — executeGeneration()과 동일 ── */
        const redundantSaves = [
            "[Upscaler] Image Save",
            "[Detailer] Face Detailer Image Save", "[Detailer] Eye Detailer Image Save",
            "[Detailer] Mouth Detailer Image Save", "[Detailer] Hand Detailer Image Save",
        ];
        if (!isCensorOn) redundantSaves.push("[Censor] Image Save");
        redundantSaves.forEach(title => {
            const rId = findNodeIdByTitle(promptData, title);
            if (rId) delete promptData[rId];
        });

        /* ── 6. 최종 Save 노드 연결 + 제출 (완료를 기다리지 않음 — submitRegen()과 동일) ── */
        const baseName = (imgInfo.filename || 'image').replace(/\.[^.]+$/, '');
        promptData[imageSaveId].inputs.images = preCensorSource;
        promptData[imageSaveId].inputs.filename_prefix = `postprocess_api/${baseName}`;

        const data = await API.post('/prompt', { prompt: promptData, client_id: window.clientId, extra_data: { preview_method: 'taesd' } });
        if (data.prompt_id) {
            console.log(`[로컬 후처리] 큐에 추가됨 (prompt_id: ${data.prompt_id}) — 완료되면 히스토리 패널에 따로 나타납니다.`);
        } else {
            console.warn('[로컬 후처리] /prompt 제출에 실패했습니다:', data);
        }
    } catch (e) {
        console.warn('[로컬 후처리] 적용 중 오류:', e);
        // 후처리가 실패해도 원본 생성 자체는 이미 끝난 뒤이므로 조용히 넘어간다.
    }
}

async function executeNanoBananaGeneration(posPrompt, filenamePrefix) {
    const apiKey = document.getElementById('nanobanana-api-key')?.value?.trim()
        || localStorage.getItem('nanoBananaApiKey') || '';
    if (!apiKey) {
        alert("🍌 나노바나나 API 키가 비어있습니다. 아키텍처 드롭다운 밑의 API 키 입력칸을 채워주세요.");
        return null;
    }
    // 🆕 기능 추가: 성인용 키워드 경고 — ⚙️ 환경설정에서 켜고 끌 수 있음(기본 켜짐)
    if (!confirmProceedWithAdultPrompt(posPrompt, '🍌 나노바나나(Google)')) return null;

    document.getElementById('progress-container').style.display = 'block';
    document.getElementById('progress-bar').style.width = '0%';
    document.getElementById('live-status-text').innerText = '🍌 나노바나나(Google) 서버에 요청 중...';

    try {
        const res = await fetch('/assetmanager/api/nanobanana_generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey, prompt: posPrompt, filenamePrefix })
        });
        const data = await res.json();
        if (!data.ok) {
            alert(`🍌 나노바나나 생성 실패: ${data.error}`);
            document.getElementById('live-status-text').innerText = '❌ 나노바나나 생성 실패';
            return null;
        }
        document.getElementById('progress-bar').style.width = '100%';
        document.getElementById('live-status-text').innerText = '✅ 나노바나나 생성 완료';
        let nanoImgInfo = { filename: data.filename, subfolder: data.subfolder, type: data.type };
        nanoImgInfo = await autoUpscaleApiResult(nanoImgInfo); // 🆕 체크돼 있으면 업스케일본으로 교체
        await applyLocalPostProcessToExternalImage(nanoImgInfo); // 🆕 모델 기반 업스케일/디테일러/검열(체크포인트 필요) — 완료 안 기다림
        addHistoryItemToPanel(nanoImgInfo);
        showResultInLivePreview(nanoImgInfo);
        return [nanoImgInfo];
    } catch (e) {
        alert(`🍌 나노바나나 서버 통신 오류: ${e}`);
        document.getElementById('live-status-text').innerText = '❌ 서버 통신 오류';
        return null;
    }
}

/**
 * 🤖 GPT(OpenAI 이미지 생성, gpt-image-1) 전용 생성 경로. 🍌 나노바나나와 완전히 동일한 구조
 * (ComfyUI 워크플로우 안 씀, 백엔드의 /assetmanager/api/gpt_generate로 프롬프트+API키만 보내서
 * 서버가 OpenAI API를 대신 호출하게 함 — CORS/키 노출 방지). 반환값도 똑같은
 * [{filename, subfolder, type}] 배열이라 검수/저장 파이프라인을 그대로 재사용한다.
 */
async function executeGptGeneration(posPrompt, filenamePrefix) {
    const apiKey = document.getElementById('gpt-api-key')?.value?.trim()
        || localStorage.getItem('gptApiKey') || '';
    if (!apiKey) {
        alert("🤖 GPT API 키가 비어있습니다. 아키텍처 드롭다운 밑의 API 키 입력칸을 채워주세요.");
        return null;
    }
    // 🆕 기능 추가: 성인용 키워드 경고 — ⚙️ 환경설정에서 켜고 끌 수 있음(기본 켜짐)
    if (!confirmProceedWithAdultPrompt(posPrompt, '🤖 GPT(OpenAI)')) return null;

    document.getElementById('progress-container').style.display = 'block';
    document.getElementById('progress-bar').style.width = '0%';
    document.getElementById('live-status-text').innerText = '🤖 GPT(OpenAI) 서버에 요청 중...';

    try {
        const res = await fetch('/assetmanager/api/gpt_generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey, prompt: posPrompt, filenamePrefix })
        });
        const data = await res.json();
        if (!data.ok) {
            alert(`🤖 GPT 생성 실패: ${data.error}`);
            document.getElementById('live-status-text').innerText = '❌ GPT 생성 실패';
            return null;
        }
        document.getElementById('progress-bar').style.width = '100%';
        document.getElementById('live-status-text').innerText = '✅ GPT 생성 완료';
        let gptImgInfo = { filename: data.filename, subfolder: data.subfolder, type: data.type };
        gptImgInfo = await autoUpscaleApiResult(gptImgInfo); // 🆕 체크돼 있으면 업스케일본으로 교체
        await applyLocalPostProcessToExternalImage(gptImgInfo); // 🆕 모델 기반 업스케일/디테일러/검열(체크포인트 필요) — 완료 안 기다림
        addHistoryItemToPanel(gptImgInfo);
        showResultInLivePreview(gptImgInfo);
        return [gptImgInfo];
    } catch (e) {
        alert(`🤖 GPT 서버 통신 오류: ${e}`);
        document.getElementById('live-status-text').innerText = '❌ 서버 통신 오류';
        return null;
    }
}

/** ComfyUI(A1111) 가중치 문법을 NAI 문법으로 변환: (단어:1.2) → 1.2::단어::, (단어) → 1.1::단어::
 *  이스케이프된 리터럴 괄호 \( \) 는 변환 대상에서 빼고 마지막에 일반 괄호로 되돌린다.
 *  중첩 괄호는 안쪽부터 여러 번 돌면서 풀어준다(단, 아주 복잡한 중첩은 완벽하지 않을 수 있음). */
function convertWeightsForNai(text) {
    if (!text) return text;
    let t = text.replace(/\\\(/g, '\u0001').replace(/\\\)/g, '\u0002');
    for (let i = 0; i < 5; i++) {
        const before = t;
        t = t.replace(/\(([^()]+?):(-?\d+(?:\.\d+)?)\)/g, '$2::$1::');
        // 바깥이 그냥 괄호이고 안쪽이 이미 "가중치::글자::" 형태면(중첩) 가중치를 1.1배로 곱해서 하나로 합친다
        t = t.replace(/\(([^()]+)\)/g, (m, inner) => {
            const w = inner.match(/^(-?\d+(?:\.\d+)?)::([\s\S]*)::$/);
            if (w) return (Math.round(parseFloat(w[1]) * 1.1 * 100) / 100) + '::' + w[2] + '::';
            return '1.1::' + inner + '::';
        });
        if (t === before) break;
    }
    return t.replace(/\u0001/g, '(').replace(/\u0002/g, ')');
}

/**
 * 🎨 NovelAI(NAI) 전용 생성 경로. 로컬 ComfyUI 워크플로우는 안 쓰고, 백엔드의
 * /assetmanager/api/nai_generate로 요청 값을 보내면 서버가 NAI API를 대신 호출한다.
 * 화면의 고급설정(해상도/샘플러/스케줄러/스텝/CFG/시드)을 NAI 형식으로 바꿔서 그대로 사용하고,
 * 반환값은 ComfyUI 결과와 같은 [{filename, subfolder, type}] 배열이라 검수/저장 흐름을 그대로 탄다.
 */
async function executeNaiGeneration(posPrompt, negPrompt, filenamePrefix, seedOverride = null) {
    const token = document.getElementById('nai-api-token')?.value?.trim()
        || localStorage.getItem('naiApiToken') || '';
    if (!token) {
        alert("🎨 NAI API 토큰이 비어있습니다. 아키텍처 드롭다운 밑의 토큰 입력칸(pst-...)을 채워주세요.");
        return null;
    }

    // 🆕 NAI 전용 설정을 그대로 사용 — 샘플러/스케줄 드롭다운이 이미 NAI 고유 값이라 별도 매핑 불필요.
    const resSel = document.getElementById('nai-resolution')?.value || '832x1216';
    let width, height;
    if (resSel === 'custom') {
        width = parseInt(document.getElementById('nai-custom-width')?.value || '832', 10);
        height = parseInt(document.getElementById('nai-custom-height')?.value || '1216', 10);
    } else {
        [width, height] = resSel.split('x').map(n => parseInt(n, 10));
    }

    const isSeedRandom = document.getElementById('nai-seed-random')?.checked !== false;
    const userSeed = document.getElementById('nai-seed')?.value;
    const rawSeed = (seedOverride !== null && seedOverride !== undefined)
        ? seedOverride
        : ((isSeedRandom || !userSeed) ? Math.floor(Math.random() * 4294967296) : parseInt(userSeed, 10));

    const convert = document.getElementById('nai-convert-weights')?.checked !== false;
    let prompt = convert ? convertWeightsForNai(posPrompt) : posPrompt;
    const negative = convert ? convertWeightsForNai(negPrompt || '') : (negPrompt || '');

    // 🆕 Text Rendering — 입력해둔 글자가 있으면 NAI 공식 문법대로 프롬프트 맨 끝에 "Text: ..."를 붙인다(V4+ 전용 문법).
    const textRenderInput = document.getElementById('nai-text-render-input')?.value?.trim();
    if (textRenderInput) {
        prompt = prompt.replace(/,\s*$/, '') + `\n\nText: ${textRenderInput}`;
    }

    const body = {
        token,
        prompt,
        negativePrompt: negative,
        model: document.getElementById('nai-model')?.value || 'nai-diffusion-4-5-full',
        width, height,
        steps: parseInt(document.getElementById('nai-steps')?.value || '28', 10),
        scale: parseFloat(document.getElementById('nai-cfg')?.value || '5'),
        cfgRescale: parseFloat(document.getElementById('nai-cfg-rescale')?.value || '0'),
        sampler: document.getElementById('nai-sampler')?.value || 'k_euler_ancestral',
        noiseSchedule: document.getElementById('nai-noise-schedule')?.value || 'karras',
        sm: document.getElementById('nai-sm')?.checked === true,
        smDyn: document.getElementById('nai-sm-dyn')?.checked === true,
        // 🆕 NAI V4/V4.5 캐릭터별 프롬프트+위치 (index.html의 naiCharacters 배열). 텍스트를 아예 안 적은 캐릭터는 빼고 보냄.
        characters: (typeof naiCharacters !== 'undefined' ? naiCharacters : [])
            .filter(c => (c.positive || '').trim())
            .map(c => ({
                positive: convert ? convertWeightsForNai(c.positive) : c.positive,
                negative: convert ? convertWeightsForNai(c.negative || '') : (c.negative || ''),
                x: c.x, y: c.y
            })),
        // 🆕 Vibe Transfer — 참조 이미지들(index.html의 naiVibeImages)을 정보추출/적용강도와 함께 전달
        vibeTransfer: (typeof naiVibeImages !== 'undefined' ? naiVibeImages : []).map(v => ({
            imageBase64: v.base64, extracted: v.extracted, strength: v.strength
        })),
        // 🆕 Precise Reference — V4.5 전용 정밀 참조(캐릭터/스타일/강도/충실도). V4.5가 아니면 UI 자체가 숨겨져 있어 보통 비어있음.
        preciseReference: (typeof naiPreciseRefImages !== 'undefined' ? naiPreciseRefImages : []).map(v => ({
            imageBase64: v.base64, refType: v.refType, strength: v.strength, fidelity: v.fidelity
        })),
        // 🆕 투명 배경 (V5 전용)
        transparentBg: document.getElementById('nai-transparent-bg')?.checked === true,
        seed: rawSeed,
        qualityToggle: document.getElementById('nai-quality-toggle')?.checked !== false,
        ucPreset: parseInt(document.getElementById('nai-uc-preset')?.value || '0', 10),
        filenamePrefix
    };

    // 🆕 Img2Img — 원본 이미지가 업로드돼 있으면(index.html의 naiImg2ImgBase64) img2img 요청으로 전환
    // 🆕 인페인팅 — 거기에 마스크(naiInpaintMaskBase64, 그림판 diff로 생성됨)까지 있으면 부분 재생성(infill)으로 전환
    if (typeof naiImg2ImgBase64 !== 'undefined' && naiImg2ImgBase64) {
        body.img2img = {
            imageBase64: naiImg2ImgBase64,
            strength: parseFloat(document.getElementById('nai-img2img-strength')?.value || '0.7'),
            noise: parseFloat(document.getElementById('nai-img2img-noise')?.value || '0'),
            maskBase64: (typeof naiInpaintMaskBase64 !== 'undefined' ? naiInpaintMaskBase64 : null),
            maskBlur: parseFloat(document.getElementById('nai-inpaint-mask-blur')?.value || '8')
        };
    }

    document.getElementById('progress-container').style.display = 'block';
    document.getElementById('progress-bar').style.width = '0%';
    document.getElementById('live-status-text').innerText = '🎨 NovelAI 서버에 요청 중...';

    try {
        const res = await fetch('/assetmanager/api/nai_generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!data.ok) {
            alert(`🎨 NAI 생성 실패: ${data.error}`);
            document.getElementById('live-status-text').innerText = '❌ NAI 생성 실패';
            return null;
        }
        document.getElementById('progress-bar').style.width = '100%';
        document.getElementById('live-status-text').innerText = `✅ NAI 생성 완료 (시드 ${data.seed})`;
        let naiImgInfo = { filename: data.filename, subfolder: data.subfolder, type: data.type };
        naiImgInfo = await autoUpscaleApiResult(naiImgInfo); // 🆕 체크돼 있으면 업스케일본으로 교체
        await applyLocalPostProcessToExternalImage(naiImgInfo); // 🆕 모델 기반 업스케일/디테일러/검열(체크포인트 필요) — 완료 안 기다림
        addHistoryItemToPanel(naiImgInfo);
        showResultInLivePreview(naiImgInfo);
        return [naiImgInfo];
    } catch (e) {
        alert(`🎨 NAI 서버 통신 오류: ${e}`);
        document.getElementById('live-status-text').innerText = '❌ 서버 통신 오류';
        return null;
    }
}

/**
 * 🎬 NAI Director 도구(선화추출/스케치/채색/감정변경/배경제거/배경정리) — "🛠️ 도구" 탭 전용 독립 기능.
 * 생성 탭의 큐/반복 흐름과는 무관하게 이미지 한 장을 즉석에서 변환한다.
 */
function toggleNaiDirectorPromptRow() {
    const type = document.getElementById('nai-director-type').value;
    const needsPrompt = type === 'colorize' || type === 'emotion';
    document.getElementById('nai-director-prompt-row').style.display = needsPrompt ? 'block' : 'none';
    document.getElementById('nai-director-prompt-label').textContent =
        type === 'emotion' ? '목표 감정/표정 프롬프트' : '채색 지시 프롬프트';
    document.getElementById('nai-director-upscale-row').style.display = type === 'upscale' ? 'block' : 'none';
}

let naiDirectorBase64 = null;
function handleNaiDirectorFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        naiDirectorBase64 = e.target.result.split(',')[1];
        document.getElementById('nai-director-preview').src = e.target.result;
        document.getElementById('nai-director-preview').style.display = 'block';
        document.getElementById('nai-director-placeholder').style.display = 'none';
    };
    reader.readAsDataURL(file);
}

async function runNaiDirectorTool() {
    if (!naiDirectorBase64) { alert('먼저 왼쪽에 원본 이미지를 넣어주세요.'); return; }
    // 토큰을 따로 안 적었으면 생성 탭에 넣어둔 NAI 토큰을 그대로 재사용
    const token = document.getElementById('nai-director-token')?.value?.trim()
        || document.getElementById('nai-api-token')?.value?.trim()
        || localStorage.getItem('naiApiToken') || '';
    if (!token) { alert('NAI API 토큰이 필요합니다. (이 화면이나 생성 탭 어느 한쪽에 입력하면 됩니다)'); return; }

    const reqType = document.getElementById('nai-director-type').value;
    const prompt = document.getElementById('nai-director-prompt')?.value || '';
    const defry = parseInt(document.getElementById('nai-director-defry')?.value || '0', 10);

    document.getElementById('nai-director-status').textContent = '🎬 NAI Director 처리 중...';
    document.getElementById('nai-director-result').style.display = 'none';
    document.getElementById('nai-director-result-empty').style.display = 'block';
    document.getElementById('nai-director-download').style.display = 'none';

    try {
        const scale = parseInt(document.getElementById('nai-director-upscale-scale')?.value || '4', 10);
        const res = await fetch('/assetmanager/api/nai_director', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, reqType, imageBase64: naiDirectorBase64, prompt, defry, scale })
        });
        const data = await res.json();
        if (!data.ok) {
            alert(`🎬 NAI Director 실패: ${data.error}`);
            document.getElementById('nai-director-status').textContent = '❌ 실패';
            return;
        }
        const resultUrl = `/view?filename=${encodeURIComponent(data.filename)}&type=${data.type}&subfolder=${encodeURIComponent(data.subfolder)}&t=${Date.now()}`;
        document.getElementById('nai-director-result').src = resultUrl;
        document.getElementById('nai-director-result').style.display = 'block';
        document.getElementById('nai-director-result-empty').style.display = 'none';
        const dl = document.getElementById('nai-director-download');
        dl.href = resultUrl;
        dl.download = data.filename;
        dl.style.display = 'inline-block';
        document.getElementById('nai-director-status').textContent = '✅ 완료';
    } catch (e) {
        alert(`🎬 서버 통신 오류: ${e}`);
        document.getElementById('nai-director-status').textContent = '❌ 서버 통신 오류';
    }
}

async function executeGeneration(posPrompt, negPrompt, filenamePrefix, regionalPrompts = null, regionalLayout = null, loraOverride = null, img2imgOverride = null, controlnetOverride = null, censorOverride = null, seedOverride = null, fragmentInfo = null) {
    // 🍌 나노바나나(Google Gemini 이미지 생성)는 로컬 ComfyUI 워크플로우를 아예 안 쓰는
    // 완전히 다른 경로라서, workflow.json 로딩 체크보다도 먼저 여기서 분기해서 별도 함수로 보낸다.
    // (샘플러/스텝/CFG/시드/로라/후처리 파이프라인은 나노바나나에 적용되지 않음 — 추후 지원 예정. 단, 일반 업스케일만은 autoUpscaleApiResult()로 적용 가능)
    const archForBranch = document.getElementById('gen-architecture')?.value || 'sdxl';
    if (archForBranch === 'nanobanana') {
        return await executeNanoBananaGeneration(posPrompt, filenamePrefix);
    }
    if (archForBranch === 'gpt') {
        return await executeGptGeneration(posPrompt, filenamePrefix);
    }
    // 🎨 NAI(NovelAI)도 마찬가지로 별도 경로. 나노바나나와 달리 부정 프롬프트/시드/스텝/CFG/샘플러/해상도는 그대로 씀.
    if (archForBranch === 'nai') {
        return await executeNaiGeneration(posPrompt, negPrompt, filenamePrefix, seedOverride);
    }

    if (!window.baseWorkflow) {
        alert("Workflow.json 파일이 로드되지 않았습니다. 잠시 후 다시 시도해주세요.");
        return;
    }

    // 🆕 출력 직전 괄호 짝 검사: "("/")" 개수가 안 맞으면(가중치 강조 괄호를 열어놓고 안 닫은
    // 흔한 실수) 경고 없이 그대로 생성이 진행돼서, 이상한 프롬프트로 몇 장을 날려버리는 일이
    // 있었다. 여기서 한 번 걸러서 계속 진행할지 확인받는다. (다중 조각을 합쳐 만든 프롬프트는
    // 이 시점에야 완성되므로, 조각 하나하나가 아니라 최종 조립된 문자열 기준으로 검사)
    const parenCheckMsg = findUnbalancedParenMessage(posPrompt, negPrompt);
    if (parenCheckMsg) {
        const proceed = confirm(`⚠️ 괄호가 안 닫힌 것 같습니다!\n\n${parenCheckMsg}\n\n그래도 계속 진행할까요?`);
        if (!proceed) {
            document.getElementById('live-status-text').innerText = '⏸ 괄호 오류로 생성이 취소되었습니다.';
            return;
        }
    }

    document.getElementById('progress-container').style.display = 'block';
    document.getElementById('progress-bar').style.width = '0%';
    document.getElementById('live-preview-placeholder').style.display = 'block';
    document.getElementById('live-preview-img').style.display = 'none';

    window.currentStepText = "작업을 준비하는 중";
    document.getElementById('live-status-text').innerText = '⏳ 서버에 전송 중...';

    const promptData = JSON.parse(JSON.stringify(window.baseWorkflow));

    /* 노드 타이틀 → ID 매핑 캐시 구축 (웹소켓 진행 상태 표시용) */
    window.globalNodeTitleMap = {};
    for (const [id, node] of Object.entries(promptData)) {
        if (node._meta && node._meta.title) {
            window.globalNodeTitleMap[id] = node._meta.title;
        }
    }

    /* ── 핵심 노드 ID 조회 ── */
    const ckptId = findNodeIdByTitle(promptData, "[Main] ckpt loader");
    const clipSetLayerId = findNodeIdByTitle(promptData, "[Main] Clip");
    const promptId = findNodeIdByTitle(promptData, "[Main] Text Prompt");
    const ksamplerId = findNodeIdByTitle(promptData, "[Main] KSampler");
    const loraId = findNodeIdByTitle(promptData, "[Main] Lora Loader");
    const positiveT2CId = findNodeIdByTitle(promptData, "[Main] T2C(Positive)");
    const upscalerSamplerId = findNodeIdByTitle(promptData, "[Upscaler] KSampler");
    const imageSaveId = findNodeIdByTitle(promptData, "[Main] Image Save");
    const vaeDecodeId = findNodeIdByTitle(promptData, "[Main] VAE decode");

    /* ── 아키텍처 프리셋 (SDXL / Anima) ──
       gen-architecture 드롭다운(sdxl|anima, 없으면 sdxl 취급)에 따라
       체크포인트 로딩 경로 자체를 분기한다. Anima는 UNETLoader + CLIPLoader(Qwen) +
       VAELoader 조합을 쓰고, 90([Main] Sampling)과 89([Main] Clip)는 완전히 우회한다. */
    const architecture = document.getElementById('gen-architecture')?.value || 'sdxl';

    if (architecture === 'anima') {
        const useAnimaCheckpoint = document.getElementById('anima-use-checkpoint')?.checked || false;
        const unetName = document.getElementById('gen-unet')?.value;
        const animaCkptName = document.getElementById('gen-anima-ckpt')?.value;
        const qwenClipName = document.getElementById('gen-clip')?.value;
        const qwenVaeName = document.getElementById('gen-vae')?.value;

        if (useAnimaCheckpoint) {
            if (!animaCkptName || !qwenClipName || !qwenVaeName) {
                alert("Anima(체크포인트 모드)는 체크포인트 / Clip(Qwen) / VAE를 모두 선택해야 합니다.");
                return;
            }
        } else if (!unetName || !qwenClipName || !qwenVaeName) {
            alert("Anima 모델은 Unet / Clip(Qwen) / VAE를 모두 선택해야 합니다.");
            return;
        }

        if (useAnimaCheckpoint) {
            // 체크포인트(unet+clip+vae 통합) 파일에서 UNET(MODEL)만 뽑아 쓴다.
            // 이 체크포인트에 같이 들어있는 CLIP/VAE는 쓰지 않고, 아래 Qwen용 CLIPLoader/VAELoader를 그대로 사용한다.
            promptData["unet_custom_001"] = {
                inputs: { ckpt_name: animaCkptName },
                class_type: "CheckpointLoaderSimple",
                _meta: { title: "[Anima] Checkpoint Loader (UNET only)" }
            };
        } else {
            promptData["unet_custom_001"] = {
                inputs: { unet_name: unetName, weight_dtype: "default" },
                class_type: "UNETLoader",
                _meta: { title: "[Anima] Unet Loader" }
            };
        }
        // CheckpointLoaderSimple의 0번 출력도 UNETLoader와 동일하게 MODEL이라, 아래 참조 코드는 두 경우 모두 동일하게 동작한다.
        promptData["clip_custom_001"] = {
            inputs: { clip_name: qwenClipName, type: "qwen_image", device: "default" },
            class_type: "CLIPLoader",
            _meta: { title: "[Anima] Clip Loader" }
        };
        promptData["vae_custom_001"] = {
            inputs: { vae_name: qwenVaeName },
            class_type: "VAELoader",
            _meta: { title: "[Anima] VAE Loader" }
        };

        /* Lora Loader(93)의 model/clip 입력을 90([Main] Sampling)·89([Main] Clip)를
           거치지 않고 새 로더로 직결한다. (ModelSamplingDiscrete=eps 수학,
           CLIPSetLastLayer=클립 스킵 모두 SDXL 전용 개념이라 Anima에 부적합) */
        if (loraId && promptData[loraId]?.inputs) {
            promptData[loraId].inputs.model = ["unet_custom_001", 0];
            promptData[loraId].inputs.clip = ["clip_custom_001", 0];
        }
        /* T2C(Positive, 101)도 체크포인트 clip이 아닌 새 CLIPLoader 사용 */
        if (positiveT2CId && promptData[positiveT2CId]?.inputs && "clip" in promptData[positiveT2CId].inputs) {
            promptData[positiveT2CId].inputs.clip = ["clip_custom_001", 0];
        }
        /* VAE Decode(99) 교체 */
        if (vaeDecodeId && promptData[vaeDecodeId]?.inputs && "vae" in promptData[vaeDecodeId].inputs) {
            promptData[vaeDecodeId].inputs.vae = ["vae_custom_001", 0];
        }
        /* 🐛 수정: 업스케일 VAE 인코드/디코드(106,108)와 얼굴/눈/입/손 디테일러(115,128,134,140)도
           여전히 87(SDXL 체크포인트)의 VAE를 직접 참조하고 있어서, Anima에서 이 VAE로
           디코드/인코드하면 잠식된 이미지처럼 깨져 보였다(공식 지적된 "작은 그림+검은 배경"
           증상의 실제 원인). 이 6곳도 전부 Qwen VAE로 통일한다. */
        ["106", "108", "115", "128", "134", "140"].forEach(nodeId => {
            if (promptData[nodeId]?.inputs && "vae" in promptData[nodeId].inputs) {
                promptData[nodeId].inputs.vae = ["vae_custom_001", 0];
            }
        });

        /* 🐛 94([Main] Latent Image = "SDXL Empty Latent Image (rgthree)")도 SDXL 전용 노드라서
           Anima 공식 워크플로우와 다르다 (공식은 순정 EmptyLatentImage에 width/height 숫자를 직접 넣음).
           이 프리셋 드롭다운 문자열을 그대로 파싱해서 순정 EmptyLatentImage 노드로 바꿔치기하고,
           KSampler의 latent_image 입력도 새 노드로 새로 연결한다. */
        if (ksamplerId && promptData[ksamplerId]?.inputs) {
            const dim = getResolutionFromDimensionsString(document.getElementById('adv-dimensions')?.value);
            promptData["latent_custom_001"] = {
                inputs: { width: dim.width, height: dim.height, batch_size: 1 },
                class_type: "EmptyLatentImage",
                _meta: { title: "[Anima] Empty Latent Image" }
            };
            promptData[ksamplerId].inputs.latent_image = ["latent_custom_001", 0];
        }
        /* 94 자신은 이제 아무도 참조하지 않으므로 ComfyUI가 실행에서 자동 제외한다. */

        /* 87([Main] ckpt loader)/89([Main] Clip)/90([Main] Sampling)은 이제 아무 노드도
           참조하지 않으므로 ComfyUI가 출력 노드 기준 역추적 시 자동으로 실행에서 제외한다.
           (JSON에서 삭제할 필요 없음) */

        /* ✅ 업스케일러(109)/디테일러 4개(115,128,134,140)의 model과 vae를 위에서
           unet_custom_001/vae_custom_001로 이미 통일했으므로("작은 그림+검은 배경" 원인이던
           SDXL VAE 직접 참조 버그 수정), 더 이상 호환 안 된다는 경고는 필요 없다.
           모자이크 검열은 픽셀 후처리라 애초에 체크포인트와 무관하게 항상 정상 동작한다. */
    } else if (architecture === 'sd3') {
        /* ── 체크포인트 (SD3 / SD3.5) ──
           SD3는 CheckpointLoaderSimple 대신 UNETLoader + CLIPLoader(triple) + VAELoader 구성.
           CLIP은 clip_l, clip_g, t5xxl 3개가 필요하므로 CLIPLoader type을 "sd3"으로 설정.
           [Main] Sampling(ModelSamplingDiscrete)과 [Main] Clip(CLIPSetLastLayer)은 우회. */
        const sd3UnetName  = document.getElementById('gen-sd3-unet')?.value;
        const sd3ClipName  = document.getElementById('gen-clip')?.value;
        const sd3VaeName   = document.getElementById('gen-vae')?.value;

        if (!sd3UnetName) {
            alert("SD3 모델은 UNet을 선택해야 합니다.");
            return;
        }

        promptData["unet_custom_001"] = {
            inputs: { unet_name: sd3UnetName, weight_dtype: "default" },
            class_type: "UNETLoader",
            _meta: { title: "[SD3] Unet Loader" }
        };

        if (sd3ClipName) {
            promptData["clip_custom_001"] = {
                inputs: { clip_name: sd3ClipName, type: "sd3", device: "default" },
                class_type: "CLIPLoader",
                _meta: { title: "[SD3] Clip Loader" }
            };
            if (loraId && promptData[loraId]?.inputs) {
                promptData[loraId].inputs.clip = ["clip_custom_001", 0];
            }
            if (positiveT2CId && promptData[positiveT2CId]?.inputs && "clip" in promptData[positiveT2CId].inputs) {
                promptData[positiveT2CId].inputs.clip = ["clip_custom_001", 0];
            }
        }

        if (sd3VaeName) {
            promptData["vae_custom_001"] = {
                inputs: { vae_name: sd3VaeName },
                class_type: "VAELoader",
                _meta: { title: "[SD3] VAE Loader" }
            };
            if (vaeDecodeId && promptData[vaeDecodeId]?.inputs && "vae" in promptData[vaeDecodeId].inputs) {
                promptData[vaeDecodeId].inputs.vae = ["vae_custom_001", 0];
            }
        }

        // LoRA의 model 입력을 SD3 UNet으로 연결
        if (loraId && promptData[loraId]?.inputs) {
            promptData[loraId].inputs.model = ["unet_custom_001", 0];
        }

        const sd3Incompatible = document.getElementById('toggle-upscale')?.checked
            || document.getElementById('toggle-detailer')?.checked
            || document.getElementById('toggle-mosaic')?.checked;
        if (sd3Incompatible) {
            console.warn("[AssetManager] SD3 프리셋에서는 Upscaler/Detailer/Censor가 SDXL 체크포인트를 직접 참조합니다. 끄고 테스트하세요.");
        }
    } else {
        /* ── 체크포인트 (SDXL) ── */
        if (ckptId) {
            promptData[ckptId].inputs.ckpt_name = document.getElementById('gen-checkpoint').value;
        }
    }

    /* ── 긍정/부정 프롬프트 주입 (★ 기존에 누락되어 있던 부분) ── */
    if (promptId) {
        promptData[promptId].inputs.pos = posPrompt;
        promptData[promptId].inputs.neg = negPrompt;
    }

    /* ── VAE 선택값 적용 (SDXL 전용 — 선택 시 체크포인트 VAE 대신 사용) ──
       VAEDecode/VAEEncode 노드만 정확히 교체한다.
       [Detailer] ToDetailerPipe 노드(115,128,134,140)는 vae와 clip을 함께
       묶어서 받는 basic_pipe 구조이므로 절대 건드리지 않는다.
       Anima는 위 분기에서 이미 VAE를 필수로 연결했으므로 여기서는 건너뛴다. */
    const selectedVae = document.getElementById('gen-vae')?.value;
    if (architecture !== 'anima' && selectedVae) {
        promptData["vae_custom_001"] = {
            inputs: { vae_name: selectedVae },
            class_type: "VAELoader",
            _meta: { title: "[Main] VAE Loader (Custom)" }
        };
        ["99", "106", "108"].forEach(nodeId => {
            if (promptData[nodeId] && promptData[nodeId].inputs && "vae" in promptData[nodeId].inputs) {
                promptData[nodeId].inputs.vae = ["vae_custom_001", 0];
            }
        });
    }

    /* ── CLIP 선택값 적용 (SDXL 전용 — 체크포인트 내장 CLIP 대신 외부 CLIPLoader 사용) ──
       89번([Main] Clip / CLIPSetLastLayer)과 101번([Main] T2C Positive)이
       둘 다 체크포인트의 clip 출력을 직접 참조하므로, 외부 CLIP을 쓸 경우
       두 곳 모두 새 CLIPLoader 출력으로 일관되게 바꿔준다.
       Anima는 위 분기에서 이미 CLIP을 필수로 연결(89는 우회)했으므로 여기서는 건너뛴다. */
    const selectedClip = document.getElementById('gen-clip')?.value;
    if (architecture !== 'anima' && selectedClip) {
        promptData["clip_custom_001"] = {
            inputs: { clip_name: selectedClip, type: "stable_diffusion" },
            class_type: "CLIPLoader",
            _meta: { title: "[Main] CLIP Loader (Custom)" }
        };
        if (clipSetLayerId && promptData[clipSetLayerId]?.inputs && "clip" in promptData[clipSetLayerId].inputs) {
            promptData[clipSetLayerId].inputs.clip = ["clip_custom_001", 0];
        }
        if (positiveT2CId && promptData[positiveT2CId]?.inputs && "clip" in promptData[positiveT2CId].inputs) {
            promptData[positiveT2CId].inputs.clip = ["clip_custom_001", 0];
        }
    }

    /* ── 캐릭터별 영역 분리는 고급 설정(steps/cfg/sampler 등) 주입이 끝난 뒤,
       아래쪽에서 "순차 마스크 리페인트" 방식으로 처리한다 (자세한 설명은 아래 참고). ── */

    /* ── 고급 설정(Steps/CFG/Sampler/Scheduler/해상도) → 워크플로우 노드에 주입 ── */
    const stepNodeId = findNodeIdByTitle(promptData, "[Main] Step");
    const cfgNodeId = findNodeIdByTitle(promptData, "[Main] CFG");
    const samplerSchedulerNodeId = findNodeIdByTitle(promptData, "[Main] Sampler, Scheduler");
    const latentNodeId = findNodeIdByTitle(promptData, "[Main] Latent Image");

    const advSteps = parseInt(document.getElementById('adv-steps')?.value || '28', 10);
    const advCfg = parseFloat(document.getElementById('adv-cfg')?.value || '5');
    const advSampler = document.getElementById('adv-sampler')?.value || 'euler_ancestral';
    const advScheduler = document.getElementById('adv-scheduler')?.value || 'normal';
    const advDimensions = document.getElementById('adv-dimensions')?.value || '1024 x 1024  (square)';

    if (stepNodeId) promptData[stepNodeId].inputs.value = advSteps;
    if (cfgNodeId) promptData[cfgNodeId].inputs.value = advCfg;
    if (samplerSchedulerNodeId) {
        promptData[samplerSchedulerNodeId].inputs.sampler_name = advSampler;
        promptData[samplerSchedulerNodeId].inputs.scheduler = advScheduler;
    }
    if (latentNodeId) promptData[latentNodeId].inputs.dimensions = advDimensions;

    /* ── 시드 처리: 랜덤 체크 시 난수 생성, 해제 시 사용자 지정 시드 사용 ──
       단, seedOverride가 있으면(🔗 시드 동일화 그룹) 그 값을 그대로 강제 사용 —
       같은 그룹으로 묶인 조각들이 같은 시드를 공유해서 일관성을 유지하기 위함. */
    const isSeedRandom = document.getElementById('adv-seed-random')?.checked !== false;
    const userSeed = document.getElementById('adv-seed')?.value;
    const seedValue = (seedOverride !== null && seedOverride !== undefined)
        ? seedOverride
        : ((isSeedRandom || !userSeed) ? Math.floor(Math.random() * 10000000000000000) : parseInt(userSeed, 10));

    if (ksamplerId) promptData[ksamplerId].inputs.seed = seedValue;
    if (upscalerSamplerId) {
        promptData[upscalerSamplerId].inputs.seed = seedValue;
        const upscaleSteps = parseInt(document.getElementById('upscale-steps')?.value || '10', 10);
        promptData[upscalerSamplerId].inputs.steps = upscaleSteps;
    }

    /* ── "다시 뽑기" 스냅샷 ──
       이 생성에 실제로 쓰인 핵심 값들을 독립된 객체로 떠서 남겨둔다.
       현재 UI(DOM) 값이 나중에 바뀌어도 이 스냅샷 자체는 영향받지 않으며,
       prompt_id를 알게 되는 즉시 window.generationSettingsByPromptId에 저장해서
       Ctrl+우클릭 시 "그때 그 값"을 그대로 불러올 수 있게 한다. */
    const regenSnapshot = {
        architecture,
        checkpoint: document.getElementById('gen-checkpoint')?.value || '',
        unet: document.getElementById('gen-unet')?.value || '',
        animaCkpt: document.getElementById('gen-anima-ckpt')?.value || '',
        animaUseCheckpoint: document.getElementById('anima-use-checkpoint')?.checked || false,
        sd3Unet: document.getElementById('gen-sd3-unet')?.value || '',
        clip: selectedClip || '',
        vae: selectedVae || '',
        posPrompt, negPrompt,
        steps: advSteps, cfg: advCfg,
        sampler: advSampler, scheduler: advScheduler,
        dimensions: advDimensions,
        seed: seedValue,
        loraOverride: loraOverride || null,
        img2imgOverride: img2imgOverride || null,
        controlnetOverride: controlnetOverride || null,
        censorOverride: censorOverride || null
    };

    /* ── 캐릭터별 영역 분리: "스케치 위에서 박스(칠한 부분)만 다시 그리기" 방식 ──
       사용자가 원하는 동작: 스케치에서 박스/붓칠로 지정한 부분만 그 캐릭터 프롬프트로 새로 그리고,
       나머지(칠 안 한 부분)는 스케치 그대로 유지한다.

       이걸 위해 "빈 캔버스"가 아니라 "스케치 이미지를 VAEEncode한 latent"에서 시작한다.
       SetLatentNoiseMask + KSampler는 마스크 있는 부분만 새로 그리고, 마스크 없는 부분은
       입력 latent(=스케치)를 그대로 보존하는 성질이 있으므로, 박스 바깥은 자동으로 스케치가 유지된다.
       (예전엔 빈 latent에서 시작해서 박스 바깥이 완전히 미생성 상태로 남았다가, 마지막에
        스케치와 무관한 새 배경을 강제로 덧그려서 "칠 안 한 부분이 스케치와 딴판으로 나오는" 문제가 있었음.
        스케치 latent에서 시작하면 그 마무리 배경 재생성 단계 자체가 필요 없어짐.) */
    if (regionalPrompts && regionalPrompts.length > 1 && ksamplerId && promptData[ksamplerId] && positiveT2CId && vaeDecodeId) {
        const n = regionalPrompts.length;
        const boxes = (regionalLayout && Array.isArray(regionalLayout.boxes) && regionalLayout.boxes.length === n)
            ? regionalLayout.boxes
            : makeEqualBoxes(n); // 캐릭터 수만큼 가로로 균등 배치 (기본값)
        // 🔁 부분 재생성: redoIndices가 있으면(빈 배열 포함) "다시 그릴 캐릭터만" 골라서 처리한다.
        // 이 경우 기초 이미지는 지난번 최종 결과물을 써야 나머지 캐릭터가 그대로 유지됨.
        const isPartialRedo = regionalLayout && Array.isArray(regionalLayout.redoIndices);
        const sketchImage = isPartialRedo
            ? (regionalLayout.lastResultImage || regionalLayout.baseImage || regionalLayout.sketchImage)
            : (regionalLayout && (regionalLayout.baseImage || regionalLayout.sketchImage));

        // 박스/마스크/포즈 추출 해상도는 "지금 드롭다운 값"이 아니라 "스케치가 실제로 만들어진 해상도"를 써야 한다.
        // 둘이 다르면 VAEEncode된 latent 크기와 마스크/포즈 크기가 어긋나서 구도가 통째로 깨진다.
        const dim = (sketchImage && sketchImage.width && sketchImage.height)
            ? { width: sketchImage.width, height: sketchImage.height }
            : getResolutionFromDimensionsString(document.getElementById('adv-dimensions')?.value || '1024 x 1024 (square)');
        const baseModelLink = promptData[ksamplerId].inputs.model;
        const baseClipLink = promptData[positiveT2CId].inputs.clip;
        const baseNegativeLink = promptData[ksamplerId].inputs.negative;
        const baseVaeLink = promptData[vaeDecodeId].inputs.vae;
        const baseKs = promptData[ksamplerId].inputs;

        if (baseModelLink && baseClipLink && baseNegativeLink && (sketchImage || latentNodeId)) {
            // 자유배치 박스(0~1 비율) → 실제 픽셀 사각형으로 변환 (박스형 영역에만 씀, 자유그리기는 별도 처리)
            const regionsPx = boxes.map(box => ({
                x: Math.round(box.x * dim.width),
                y: Math.round(box.y * dim.height),
                w: Math.max(1, Math.round(box.w * dim.width)),
                h: Math.max(1, Math.round(box.h * dim.height))
            }));

            let prevLatent;
            if (sketchImage && baseVaeLink) {
                // 스케치 이미지를 불러와서 VAEEncode → 이게 시작 latent (박스 바깥은 이 내용이 그대로 유지됨)
                promptData["region_sketch_load"] = {
                    inputs: { image: `${sketchImage.subfolder ? sketchImage.subfolder + '/' : ''}${sketchImage.filename} [${sketchImage.type || 'output'}]` },
                    class_type: "LoadImage",
                    _meta: { title: "[Region] 스케치 이미지 불러오기" }
                };
                promptData["region_sketch_encode"] = {
                    inputs: { pixels: ["region_sketch_load", 0], vae: baseVaeLink },
                    class_type: "VAEEncode",
                    _meta: { title: "[Region] 스케치 → latent 인코딩" }
                };
                prevLatent = ["region_sketch_encode", 0];
            } else {
                // 스케치가 없으면(옛날 job 등) 예전처럼 빈 캔버스에서 시작 — 이 경우엔 박스 바깥이
                // 미생성 상태가 되므로, 가급적 "🖼 스케치"를 먼저 뽑고 쓰는 걸 권장.
                prevLatent = [latentNodeId, 0];
            }

            // ── 🦴 포즈 가이드 (ControlNet): 편집창에서 켠 경우에만, 스케치 전체에서 뽑은 포즈
            //    스켈레톤을 각 캐릭터 재생성에 가이드로 걸어서 구도/포즈가 안 무너지게 한다.
            //    (디테일·색·의상 등은 그대로 자유롭게 새로 그려지고, 뼈대만 따라감) ──
            let poseControlNetLink = null; // [ControlNetLoader 노드id, 0] — 없으면 포즈 가이드 미사용
            let posePreprocessedLink = null; // [전처리된 포즈 이미지 노드id, 0]
            if (regionalLayout && regionalLayout.poseGuideEnabled && promptData["region_sketch_load"]) {
                promptData["region_pose_cn_loader"] = {
                    inputs: { control_net_name: "OpenPoseXL2.safetensors" },
                    class_type: "ControlNetLoader",
                    _meta: { title: "[Region] 포즈 ControlNet 모델 불러오기" }
                };
                promptData["region_pose_preprocess"] = {
                    inputs: {
                        image: ["region_sketch_load", 0],
                        detect_hand: "enable",
                        detect_body: "enable",
                        detect_face: "enable",
                        resolution: Math.max(dim.width, dim.height)
                    },
                    class_type: "OpenposePreprocessor",
                    _meta: { title: "[Region] 스케치 → 포즈 스켈레톤 추출" }
                };
                poseControlNetLink = ["region_pose_cn_loader", 0];
                posePreprocessedLink = ["region_pose_preprocess", 0];
            }

            // denoise=1.0: 박스 안은 스케치에 뭐가 있었든 완전히 무시하고 새로 그린다. 박스 바깥은 전혀 안 건드림.
            const repaintDenoise = 1.0;


            for (let i = 0; i < boxes.length; i++) {
                if (isPartialRedo && !regionalLayout.redoIndices.includes(i)) continue; // 이 캐릭터는 이번엔 안 건드림 (지난 결과 그대로 유지)

                const box = boxes[i];
                const rect = regionsPx[i];
                let compositeId; // 이 영역의 "원본" 마스크 노드 id (박스형이든 자유그리기든 결과는 동일하게 이 변수에 담김)

                if (box.freeform && box.maskDataUrl) {
                    // 자유 그리기 마스크: 캔버스에 그린 PNG를 ComfyUI 서버에 업로드하고, LoadImage + ImageToMask로 변환
                    const uploaded = await uploadImageDataUrlToComfy(box.maskDataUrl, `region_mask_${i}`);
                    const loadId = `region_freeform_load_${i}`;
                    const toMaskId = `region_freeform_tomask_${i}`;
                    promptData[loadId] = {
                        inputs: { image: uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name },
                        class_type: "LoadImage",
                        _meta: { title: `[Region ${i + 1}] 자유그리기 마스크 불러오기` }
                    };
                    promptData[toMaskId] = {
                        inputs: { image: [loadId, 0], channel: "red" },
                        class_type: "ImageToMask",
                        _meta: { title: `[Region ${i + 1}] 이미지 → 마스크 변환` }
                    };
                    compositeId = toMaskId;
                } else {
                    // 박스형: SolidMask(검은 배경, 캔버스 전체) + SolidMask(흰 사각형) + MaskComposite(그 위치에 합성)
                    const blackId = `region_black_${i}`;
                    const whiteId = `region_white_${i}`;
                    compositeId = `region_composite_${i}`;
                    promptData[blackId] = {
                        inputs: { value: 0, width: dim.width, height: dim.height },
                        class_type: "SolidMask",
                        _meta: { title: `[Region ${i + 1}] 검은 배경` }
                    };
                    promptData[whiteId] = {
                        inputs: { value: 1, width: Math.max(1, rect.w), height: Math.max(1, rect.h) },
                        class_type: "SolidMask",
                        _meta: { title: `[Region ${i + 1}] 흰 영역` }
                    };
                    promptData[compositeId] = {
                        inputs: { destination: [blackId, 0], source: [whiteId, 0], x: rect.x, y: rect.y, operation: "add" },
                        class_type: "MaskComposite",
                        _meta: { title: `[Region ${i + 1}] 마스크 합성` }
                    };
                }

                // 겹치는 부분은 그냥 나중에 처리되는 캐릭터가 자연스럽게 덮어쓰게 둔다.
                // (순서대로 재생성하기 때문에, 뒤 캐릭터의 denoise=1.0 리페인트가 겹친 자리를
                //  자동으로 새로 그려서 마지막에 그려진 쪽이 남음 — 별도 제외 처리 필요 없음)
                const finalMaskId = compositeId;

                const encodeId = `region_encode_${i}`;
                promptData[encodeId] = {
                    inputs: { text: `${regionalPrompts[i]}, ${posPrompt}`, clip: baseClipLink },
                    class_type: "CLIPTextEncode",
                    _meta: { title: `[Region ${i + 1}] CLIPTextEncode` }
                };

                // 포즈 가이드가 켜져 있으면, 이 캐릭터의 conditioning에 ControlNet을 걸어준다
                let regionPositiveLink = [encodeId, 0];
                let regionNegativeLink = baseNegativeLink;
                if (poseControlNetLink && posePreprocessedLink) {
                    const cnApplyId = `region_pose_cn_apply_${i}`;
                    promptData[cnApplyId] = {
                        inputs: {
                            positive: [encodeId, 0],
                            negative: baseNegativeLink,
                            control_net: poseControlNetLink,
                            image: posePreprocessedLink,
                            strength: (regionalLayout.poseGuideStrength ?? 0.85),
                            start_percent: 0.0,
                            end_percent: 1.0
                        },
                        class_type: "ControlNetApplyAdvanced",
                        _meta: { title: `[Region ${i + 1}] 포즈 ControlNet 적용` }
                    };
                    regionPositiveLink = [cnApplyId, 0];
                    regionNegativeLink = [cnApplyId, 1];
                }

                const noiseMaskId = `region_noisemask_${i}`;
                promptData[noiseMaskId] = {
                    inputs: { samples: prevLatent, mask: [finalMaskId, 0] },
                    class_type: "SetLatentNoiseMask",
                    _meta: { title: `[Region ${i + 1}] 노이즈 마스크 적용` }
                };

                const repaintKsId = `region_ksampler_${i}`;
                promptData[repaintKsId] = {
                    inputs: {
                        seed: baseKs.seed,
                        steps: baseKs.steps,
                        cfg: baseKs.cfg,
                        sampler_name: baseKs.sampler_name,
                        scheduler: baseKs.scheduler,
                        denoise: repaintDenoise,
                        model: baseModelLink,
                        positive: regionPositiveLink,
                        negative: regionNegativeLink,
                        latent_image: [noiseMaskId, 0]
                    },
                    class_type: "KSampler",
                    _meta: { title: `[Region ${i + 1}] 리페인트 KSampler` }
                };

                prevLatent = [repaintKsId, 0];
            }

            // 박스 바깥(칠 안 한 부분)은 SetLatentNoiseMask의 성질상 각 단계에서 입력 latent(스케치)가
            // 그대로 보존되므로, 별도의 "배경 재생성" 단계가 필요 없다.

            // ── 🧹 마무리 정리: 캐릭터별로 따로따로 완전 재생성하다 보니 생기는 경계 이음새/조명
            //    불일치를 낮은 denoise로 전체를 한 번 더 훑어서 자연스럽게 다듬는다.
            //    (denoise가 낮아서 각 캐릭터 특징/포즈는 거의 그대로 유지되고, 미세한 부분만 정리됨) ──
            if (regionalLayout && regionalLayout.finishPassEnabled) {
                const finishDenoise = regionalLayout.finishPassDenoise ?? 0.25;
                promptData["region_finish_encode"] = {
                    inputs: { text: posPrompt, clip: baseClipLink },
                    class_type: "CLIPTextEncode",
                    _meta: { title: "[Region] 마무리 정리 CLIPTextEncode (공통 프롬프트)" }
                };
                promptData["region_finish_ksampler"] = {
                    inputs: {
                        seed: baseKs.seed,
                        steps: baseKs.steps,
                        cfg: baseKs.cfg,
                        sampler_name: baseKs.sampler_name,
                        scheduler: baseKs.scheduler,
                        denoise: finishDenoise,
                        model: baseModelLink,
                        positive: ["region_finish_encode", 0],
                        negative: baseNegativeLink,
                        latent_image: prevLatent
                    },
                    class_type: "KSampler",
                    _meta: { title: "[Region] 마무리 정리 (전체 낮은 디노이즈)" }
                };
                prevLatent = ["region_finish_ksampler", 0];
            }

            // 최종 VAEDecode가 마지막 단계(마무리 정리 켰으면 그것까지)의 latent를 보게 바꿔치기
            if (promptData[vaeDecodeId]?.inputs && "samples" in promptData[vaeDecodeId].inputs) {
                promptData[vaeDecodeId].inputs.samples = prevLatent;
            }
        }
    }

    /* ── 미리보기 전용 노드 제거 (서버 부하 방지) ── */
    [
        "[Main] Image Preview",
        "[Upscaler] Image Preview",
        "[Detailer] Face Detailer Image Preview",
        "[Detailer] Eye Detailer Image Preview",
        "[Detailer] Mouth Detailer Image Preview",
        "[Detailer] Hand Detailer Image Preview",
    ].forEach(title => {
        const nId = findNodeIdByTitle(promptData, title);
        if (nId) delete promptData[nId];
    });

    /* ── 로라 설정 적용 (Power Lora Loader rgthree 형식) ──
       loraOverride가 넘어왔으면(=이 조각 전용 로라가 지정된 job) 화면 상단의 공통 로라(#selected-loras)는
       건드리지 않고, 넘겨받은 값만 이번 생성 한 번에 적용한다. */
    let appliedLoraCount = 0;
    if (loraId) {
        const loraList = loraOverride
            ? loraOverride.map(e => ({ lora: e.lora, strength: e.strength }))
            : Array.from(document.querySelectorAll('#selected-loras .lora-item')).map(item => ({
                lora: item.querySelector('select').value,
                strength: parseFloat(item.querySelector('input[type="number"]').value)
            }));

        delete promptData[loraId].inputs["lora_1"];
        if (loraList.length > 0) {
            loraList.forEach((entry, index) => {
                promptData[loraId].inputs[`lora_${index + 1}`] = { on: true, lora: entry.lora, strength: entry.strength };
            });
            appliedLoraCount = loraList.length;
        } else {
            promptData[loraId].inputs["lora_1"] = { on: false, lora: "None", strength: 1 };
        }
    }

    /* ── 로라 개수가 많을 때 RescaleCFG 자동 적용 ──
       로라를 많이 겹칠수록 CFG 증폭 때문에 과포화/색번짐이 심해지는데, RescaleCFG로
       조건부 예측값 기준으로 다시 눌러주면 훨씬 덜 깨진다. 화면에서 켠 "기준 개수"를
       넘었을 때만 KSampler 앞(로라 로더 출력과 KSampler의 model 입력 사이)에 끼워넣는다. */
    if (ksamplerId) {
        const rescaleEnabled = document.getElementById('rescalecfg-enabled')?.checked;
        const rescaleThreshold = parseInt(document.getElementById('rescalecfg-threshold')?.value || '5', 10);
        const rescaleMultiplier = parseFloat(document.getElementById('rescalecfg-multiplier')?.value || '0.7');

        if (rescaleEnabled && appliedLoraCount > rescaleThreshold && promptData[ksamplerId]?.inputs?.model) {
            const rescaleNodeId = 'rescalecfg_auto_001';
            promptData[rescaleNodeId] = {
                inputs: {
                    model: promptData[ksamplerId].inputs.model, // 지금 KSampler로 들어가던 model(로라 적용된 것)을 그대로 가져와서
                    multiplier: isNaN(rescaleMultiplier) ? 0.7 : rescaleMultiplier
                },
                class_type: "RescaleCFG",
                _meta: { title: "[Auto] RescaleCFG (로라 다수 적용시 자동 삽입)" }
            };
            promptData[ksamplerId].inputs.model = [rescaleNodeId, 0]; // KSampler는 이제 RescaleCFG를 거친 model을 받는다
        }
    }

    /* ── 동적 노드 우회 파이프라인 (Rewiring Pipeline) ──
       파이프라인 순서: [IP-Adapter] → VAE Decode → 업스케일러 → 디테일러 → 검열
       IP-Adapter는 model 연결을 교체하므로 이미지 소스보다 먼저 처리한다.
       각 단계의 마지막 출력 노드를 추적하여 다음 단계의 입력에 연결한다. */

    /* IP-Adapter: KSampler의 model 입력을 교체 (비동기 업로드 포함) */
    if (window.applyIPAdapterPipeline) {
        try {
            await window.applyIPAdapterPipeline(promptData, findNodeIdByTitle);
            const statusEl = document.getElementById('ipadapter-upload-status');
            if (statusEl && document.getElementById('toggle-ipadapter')?.checked) {
                statusEl.textContent = '✅ 업로드 완료';
            }
        } catch (e) {
            console.error('[IPAdapter] 파이프라인 적용 실패:', e);
            const statusEl = document.getElementById('ipadapter-upload-status');
            if (statusEl) statusEl.textContent = '❌ 업로드 실패 — IP-Adapter 없이 생성합니다.';
        }
    }

    /* ControlNet: KSampler의 positive/negative conditioning을 교체 (이미지 소스보다 먼저 처리)
       controlnetOverride가 넘어왔으면(=이 조각 전용 컨트롤넷이 지정된 job) 화면 상단의 공통 ControlNet
       설정(#toggle-controlnet 등)은 건드리지 않고, 넘겨받은 값만 이번 생성 한 번에 적용한다. */
    if (window.applyControlNetPipeline) {
        try {
            await window.applyControlNetPipeline(promptData, findNodeIdByTitle, controlnetOverride);
            const statusEl = document.getElementById('controlnet-upload-status');
            if (!controlnetOverride && statusEl && document.getElementById('toggle-controlnet')?.checked) {
                statusEl.textContent = '✅ 업로드 완료';
            }
        } catch (e) {
            console.error('[ControlNet] 파이프라인 적용 실패:', e);
            const statusEl = document.getElementById('controlnet-upload-status');
            if (!controlnetOverride && statusEl) statusEl.textContent = '❌ 업로드 실패 — ControlNet 없이 생성합니다.';
        }
    }

    /* Img2Img: LoadImage → VAEEncode → KSampler.latent_image 교체 + denoise 적용
       img2imgOverride가 넘어왔으면(=이 조각 전용 Img2Img가 지정된 job) 화면 상단의 공통 Img2Img
       설정(#toggle-img2img 등)은 건드리지 않고, 넘겨받은 값만 이번 생성 한 번에 적용한다. */
    if (window.applyImg2ImgPipeline) {
        try {
            await window.applyImg2ImgPipeline(promptData, findNodeIdByTitle, img2imgOverride);
            const statusEl = document.getElementById('img2img-upload-status');
            if (!img2imgOverride && statusEl && document.getElementById('toggle-img2img')?.checked) {
                statusEl.textContent = '✅ 업로드 완료';
            }
        } catch (e) {
            console.error('[Img2Img] 파이프라인 적용 실패:', e);
            const statusEl = document.getElementById('img2img-upload-status');
            if (!img2imgOverride && statusEl) statusEl.textContent = '❌ 업로드 실패 — Img2Img 없이 생성합니다.';
        }
    }

    /* Inpaint: KSampler의 latent_image를 교체 (VAE Decode 이전 단계이므로 이미지 소스보다 먼저 처리) */
    if (window.applyInpaintPipeline) {
        try {
            await window.applyInpaintPipeline(promptData, findNodeIdByTitle);
            const statusEl = document.getElementById('inpaint-upload-status');
            if (statusEl && document.getElementById('toggle-inpaint')?.checked) {
                statusEl.textContent = '✅ 업로드 완료';
            }
        } catch (e) {
            console.error('[Inpaint] 파이프라인 적용 실패:', e);
            const statusEl = document.getElementById('inpaint-upload-status');
            if (statusEl) statusEl.textContent = '❌ 업로드 실패 — Inpaint 없이 생성합니다.';
        }
    }

    let currentImageSource = [vaeDecodeId, 0];

    if (window.applyUpscalerPipeline) {
        currentImageSource = window.applyUpscalerPipeline(promptData, currentImageSource, findNodeIdByTitle);
    }

    if (window.applyDetailerPipeline) {
        currentImageSource = window.applyDetailerPipeline(promptData, currentImageSource, findNodeIdByTitle);
    }

    /* 검열 파이프라인 적용 전 원본 이미지 소스를 백업 (이중 저장: 원본+검열본)
       censorOverride가 넘어왔으면(=이 조각 전용 검열이 지정된 job) 화면 상단의 공통 검열
       설정(#toggle-mosaic 등)은 건드리지 않고, 넘겨받은 값만 이번 생성 한 번에 적용한다. */
    const preCensorSource = [...currentImageSource];
    const isCensorOn = censorOverride ? !!censorOverride.enabled : (document.getElementById('toggle-mosaic')?.checked || false);

    if (window.applyCensorPipeline) {
        const censorPipelineOverrides = censorOverride ? {
            isCensorOn: !!censorOverride.enabled,
            labels: censorOverride.labels || [],
            censorMode: censorOverride.mode || 'mosaic',
            censorIntensity: censorOverride.intensity || 15
        } : null;
        currentImageSource = window.applyCensorPipeline(promptData, currentImageSource, window.findNodeIdByTitle, censorPipelineOverrides);
    }

    /* ── 중간 단계 Save 노드 제거 (최종 Save만 유지) ── */
    const redundantSaves = [
        "[Upscaler] Image Save",
        "[Detailer] Face Detailer Image Save",
        "[Detailer] Eye Detailer Image Save",
        "[Detailer] Mouth Detailer Image Save",
        "[Detailer] Hand Detailer Image Save",
    ];
    if (!isCensorOn) redundantSaves.push("[Censor] Image Save");

    redundantSaves.forEach(title => {
        const rId = window.findNodeIdByTitle(promptData, title);
        if (rId) delete promptData[rId];
    });

    /* ── 최종 Save 노드 연결 ── */
    if (imageSaveId) {
        promptData[imageSaveId].inputs.images = preCensorSource;
        promptData[imageSaveId].inputs.filename_prefix = filenamePrefix;
    }

    if (isCensorOn) {
        const censorSaveId = window.findNodeIdByTitle(promptData, "[Censor] Image Save");
        if (censorSaveId) {
            promptData[censorSaveId].inputs.images = currentImageSource;
            promptData[censorSaveId].inputs.filename_prefix = filenamePrefix + "_censored";
        }
    }

    /* ── 서버 로그 기록 ── */
    try {
        const logParts = [];
        logParts.push(`Gen: ${document.getElementById('gen-checkpoint')?.value}`);
        logParts.push(`P: ${posPrompt.substring(0, 30)}...`);

        if (document.getElementById('toggle-upscale')?.checked) {
            logParts.push(`Upscale: ON [${document.getElementById('upscale-model')?.value}] x${document.getElementById('upscale-ratio')?.value}`);
        } else {
            logParts.push(`Upscale: OFF`);
        }

        if (document.getElementById('toggle-detailer')?.checked) {
            const dParts = [];
            if (document.getElementById('detailer-face-toggle')?.checked) dParts.push('Face');
            if (document.getElementById('detailer-eye-toggle')?.checked) dParts.push('Eye');
            if (document.getElementById('detailer-mouth-toggle')?.checked) dParts.push('Mouth');
            if (document.getElementById('detailer-hand-toggle')?.checked) dParts.push('Hand');
            logParts.push(`Detailer: ON [${dParts.length > 0 ? dParts.join(", ") : "None"}]`);
        } else {
            logParts.push(`Detailer: OFF`);
        }

        if (isCensorOn) {
            const cMode = censorOverride ? (censorOverride.mode || 'mosaic') : (document.getElementById('censor-mode')?.value || 'mosaic');
            const cInt = censorOverride ? (censorOverride.intensity || 15) : (document.getElementById('censor-intensity')?.value || '15');
            logParts.push(`Censor: ON [${cMode.toUpperCase()}] Intensity: ${cInt}`);
        } else {
            logParts.push(`Censor: OFF`);
        }

        const finalLogMessage = logParts.join(" | ");
        API.post('/assetmanager/api/log', { message: finalLogMessage }).catch(err => console.error("Logging failed:", err));
    } catch (e) {
        console.error("Error while preparing log:", e);
    }

    /* ── ComfyUI /prompt API 요청 후 웹소켓 완료 이벤트를 기다리는 Promise ──
       resolve값으로 결과 이미지 정보(filename/subfolder/type)를 같이 넘겨서,
       호출부(배치 루프 등)가 "이 job의 결과가 정확히 이 파일이다"를 알 수 있게 한다. */
    return new Promise(async (resolve, reject) => {
        // 🆕 검열 파이프라인이 켜져있으면 "원본 저장" 노드 + "[Censor] Image Save" 노드가
        // 각각 따로 executed 이벤트를 발생시켜서 이미지 2장(원본+검열본)이 만들어지는데,
        // 예전엔 latestImage 하나만 계속 덮어써서 마지막에 실행된 노드(주로 검열본)만 남고
        // 나머지 한 장은 디스크에는 저장되지만 검수 목록에는 아예 안 잡혔다.
        // → 이제 이번 생성에서 나온 이미지를 전부(중복 제외) 모아서 배열로 반환한다.
        const images = [];
        const pushImage = (img) => {
            if (!img) return;
            const key = `${img.filename}::${img.subfolder || ''}::${img.type || 'output'}`;
            if (images.some(i => `${i.filename}::${i.subfolder || ''}::${i.type || 'output'}` === key)) return;
            images.push(img);
        };
        let myPromptId = null;
        let pendingEvents = []; // prompt_id를 아직 모르는 사이 도착한 이벤트를 임시 보관
        let settled = false;
        let fallbackTimer = null;

        const finish = async (result) => {
            if (settled) return;
            settled = true;
            if (fallbackTimer) clearTimeout(fallbackTimer);
            window.ws.removeEventListener('message', tempHandler);

            // 안전장치: 웹소켓 이벤트를 놓쳐서 result가 비어있으면,
            // ComfyUI의 /history에서 실제 결과를 한 번 더 조회해본다.
            // (검수 목록에서 "가끔 안 뜨는" 문제의 근본 원인 — 대기열을 지나간 작업은
            //  실제로 이미지가 만들어졌다면 최대한 검수 대상에 잡히도록 함)
            if ((!result || result.length === 0) && myPromptId) {
                result = await fetchHistoryImageFallback(myPromptId);
            }
            resolve(result && result.length > 0 ? result : null);
        };

        // 안전장치: "완전히 끝남" 신호(node:null)를 못 받는 ComfyUI 버전/상황을 대비해,
        // 이미지를 받은 뒤 8초 동안 추가 신호가 없으면 그때까지 모인 이미지들로 그냥 확정한다.
        const armFallback = () => {
            if (fallbackTimer) clearTimeout(fallbackTimer);
            fallbackTimer = setTimeout(() => finish(images.slice()), 8000);
        };

        const processEvent = (data) => {
            if (data.type === 'executed') {
                const outImages = data.data.output && data.data.output.images;
                if (outImages && outImages.length > 0) { outImages.forEach(pushImage); armFallback(); }
            } else if (data.type === 'executing' && data.data.node === null) {
                finish(images.slice());
            } else if (data.type === 'execution_interrupted') {
                finish(null);
            }
        };

        const tempHandler = function (event) {
            if (typeof event.data !== "string") return;
            const data = JSON.parse(event.data);
            if (!data.data) return;

            if (myPromptId === null) {
                pendingEvents.push(data); // 아직 prompt_id를 몰라서 필터링 불가 → 일단 쌓아둠
                return;
            }
            if (data.data.prompt_id !== myPromptId) return; // 다른 프롬프트의 무관한 이벤트는 무시
            processEvent(data);
        };
        window.ws.addEventListener('message', tempHandler);

        try {
            // TAESD는 SDXL/SD1.5 계열 latent로 학습된 초소형 디코더라서, 아니마처럼 latent 구조가
            // 다른 아키텍처에 그대로 쓰면 프리뷰가 흐릿/왜곡되게 나온다.
            // latent2rgb도 여전히 흐리면, "auto"로 ComfyUI가 모델에 등록된 디코더를 알아서 고르게 해본다.
            const previewMethod = (architecture === 'anima') ? 'auto' : 'taesd';
            // 🆕 기능 추가: 어떤 조각(들)으로 만들었는지를 PNG 파일 자체에 박아넣는다. ComfyUI의
            // 표준 SaveImage 노드는 extra_data.extra_pnginfo에 넣은 키를 전부 "workflow"/"prompt"와
            // 똑같은 방식으로 PNG tEXt 청크에 저장해준다(이미 있는 공식 메커니즘, 커스텀 노드 불필요) —
            // 그래서 이 정보는 파일을 이동/복사/압축해도 그대로 남고, library.json과도 독립적이다.
            const extraData = { preview_method: previewMethod };
            if (fragmentInfo) extraData.extra_pnginfo = { fragment_info: JSON.stringify(fragmentInfo) };
            const data = await API.post('/prompt', { prompt: promptData, client_id: window.clientId, extra_data: extraData });
            if (!data.prompt_id) {
                document.getElementById('progress-container').style.display = 'none';
                window.ws.removeEventListener('message', tempHandler);
                reject(new Error("Job enqueue failed"));
                return;
            }
            myPromptId = data.prompt_id;
            window.generationSettingsByPromptId = window.generationSettingsByPromptId || {};
            window.generationSettingsByPromptId[myPromptId] = regenSnapshot;
            // 쌓아뒀던 이벤트 중 실제로 이 prompt_id에 해당하는 것들을 그제서야 처리
            pendingEvents.filter(d => d.data.prompt_id === myPromptId).forEach(processEvent);
            pendingEvents = [];
        } catch (e) {
            document.getElementById('progress-container').style.display = 'none';
            window.ws.removeEventListener('message', tempHandler);
            reject(e);
        }
    });
}

/* ──────────────────────────────────────────────
   대기열(Queue) 관리 UI 함수
   ────────────────────────────────────────────── */

/** 작업 객체를 대기열에 추가하고 UI 갱신 */
/* ──────────────────────────────────────────────
   🆕 🎨 {color} 플레이스홀더 — 조각(의상 등) 프롬프트에 "{color}"라고 적어두면,
   그 조각이 포함된 대기열 항목마다 서로 다른 기본 색이 자동 배정되고(한 세트를
   전부 같은 색으로 뽑으면 어색하므로), 대기열 카드에서 원클릭으로 바꿀 수 있다.
   실제 치환은 startBatchGeneration()에서 생성 직전에만 일어나고, 조각 자체의
   prompt 텍스트("{color}" 문자 그대로)는 절대 건드리지 않는다 — 그래서 의상
   조각을 수정해도(예: 디자인/소재만 바꾸고 "{color}"는 그대로 둠) 이미 대기열에
   들어간 항목들은 syncQueueJobsWithItem()으로 평소처럼 같이 갱신되면서 색상
   선택(job.colorChoice)은 유지된다.
   ────────────────────────────────────────────── */
const JOB_COLOR_PALETTE = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'black', 'white', 'brown'];

/** job.fullPrompt(아직 안 합친 배열) 중 하나라도 "{color}" 토큰을 포함하면 true */
function jobHasColorPlaceholder(job) {
    return Array.isArray(job.fullPrompt) && job.fullPrompt.some(p => typeof p === 'string' && p.includes('{color}'));
}

/** 지금 대기열에서 가장 덜 쓰인 색을 다음 기본값으로 고른다(최대한 겹치지 않게 분산). */
function pickNextJobColor() {
    const used = {};
    JOB_COLOR_PALETTE.forEach(c => { used[c] = 0; });
    (jobQueue || []).forEach(j => { if (j.colorChoice && used[j.colorChoice] !== undefined) used[j.colorChoice]++; });
    let best = JOB_COLOR_PALETTE[0];
    let bestCount = Infinity;
    for (const c of JOB_COLOR_PALETTE) {
        if (used[c] < bestCount) { bestCount = used[c]; best = c; }
    }
    return best;
}

/** 대기열 카드에서 색 스와치를 클릭했을 때 호출 */
function setJobColor(index, color) {
    const job = jobQueue[index];
    if (!job) return;
    job.colorChoice = color;
    renderJobQueue();
    if (window.appStateManager) window.appStateManager.debounceSave();
}
window.setJobColor = setJobColor;

/** job 카드 안에 넣을 색상 스와치 한 줄 HTML. "{color}" 플레이스홀더가 없는 job이면 빈 문자열. */
function jobColorSwatchHtml(job, index) {
    if (!jobHasColorPlaceholder(job)) return '';
    const current = job.colorChoice || JOB_COLOR_PALETTE[0];
    const dots = JOB_COLOR_PALETTE.map(c => {
        const activeStyle = (c === current) ? 'outline:2px solid #fff; outline-offset:1px;' : '';
        return `<span onclick="event.stopPropagation(); setJobColor(${index}, '${c}')" title="${c}" style="display:inline-block; width:14px; height:14px; border-radius:50%; background:${c}; cursor:pointer; margin-right:4px; border:1px solid rgba(0,0,0,0.4); ${activeStyle}"></span>`;
    }).join('');
    return `<div style="margin-top:5px; display:flex; align-items:center; flex-wrap:wrap;" title="이 항목의 {color} 자리에 들어갈 색(클릭으로 변경)">🎨 ${dots}<span style="font-size:0.75em; color:#aaa; margin-left:4px;">${current}</span></div>`;
}

function addJobToQueue(job) {
    // 🆕 "{color}" 플레이스홀더가 있는 job은 대기열에 들어가는 시점에 기본 색을 바로 배정해둔다
    // (아직 색을 안 골랐을 때만 — 이미 colorChoice가 있으면 그대로 둠).
    if (job.colorChoice === undefined && jobHasColorPlaceholder(job)) {
        job.colorChoice = pickNextJobColor();
    }
    if (job.disabled === undefined) job.disabled = false;
    // 🆕 조각 전용 키워드 무효화: sourceRefs가 있으면 자동으로 채워준다 (호출부마다 따로 안 챙겨도 됨)
    if (job.sourceRefs && job.posInvalidateOverride === undefined && typeof collectPosInvalidateForRefs === 'function') {
        const v = collectPosInvalidateForRefs(job.sourceRefs);
        if (v) job.posInvalidateOverride = v;
    }
    if (job.sourceRefs && job.negInvalidateOverride === undefined && typeof collectNegInvalidateForRefs === 'function') {
        const v = collectNegInvalidateForRefs(job.sourceRefs);
        if (v) job.negInvalidateOverride = v;
    }
    // 🔀 조각 전용 조건부 프롬프트 변화 규칙도 sourceRefs에서 자동으로 채움
    if (job.sourceRefs && job.condRulesOverride === undefined && typeof collectCondRulesForRefs === 'function') {
        const v = collectCondRulesForRefs(job.sourceRefs);
        if (v) job.condRulesOverride = v;
    }
    // 🧱 조각 전용 카테고리 차단도 sourceRefs에서 자동으로 채움
    if (job.sourceRefs && job.blockCategoriesOverride === undefined && typeof collectBlockCategoriesForRefs === 'function') {
        const v = collectBlockCategoriesForRefs(job.sourceRefs);
        if (v) job.blockCategoriesOverride = v;
    }
    jobQueue.push(job);
    renderJobQueue();
    if (window.appStateManager) window.appStateManager.debounceSave();
}

/** 대기열 항목 비활성화 토글 */
function toggleJobDisabled(index) {
    jobQueue[index].disabled = !jobQueue[index].disabled;
    renderJobQueue();
    if (window.appStateManager) window.appStateManager.debounceSave();
}

/**
 * 라이브러리에서 조각을 수정했을 때, 이미 대기열에 들어가 있는 job들 중
 * 그 조각(같은 catId+itemId, 같은 버전 인덱스)을 참조하는 항목의 fullPrompt를
 * 최신 내용으로 즉시 갱신한다. (조각 ID가 바뀐 경우 sourceRef의 itemId도 함께 갱신)
 * @param {string} catId
 * @param {string} oldItemId 수정 전 조각 ID (ID 변경 없었으면 item.id와 동일)
 * @param {object} item 수정된 최신 조각 객체 (item.id, item.prompt, item.variants, item.activeVariant)
 */
function syncQueueJobsWithItem(catId, oldItemId, item) {
    if (!Array.isArray(jobQueue) || jobQueue.length === 0 || !item) return;
    let touched = false;
    jobQueue.forEach(job => {
        if (!job.sourceRefs) return;
        let thisJobTouched = false;
        job.sourceRefs.forEach((ref, idx) => {
            if (ref.catId !== catId || ref.itemId !== oldItemId) return;

            let newPrompt;
            if (ref.variantIndex !== undefined) {
                if (item.variants && item.variants[ref.variantIndex]) {
                    newPrompt = item.variants[ref.variantIndex].prompt;
                } else {
                    return; // 참조하던 특정 버전이 사라진 경우는 건드리지 않음
                }
            } else {
                newPrompt = item.prompt; // 특정 버전을 지정하지 않은 참조는 항상 현재 표시되는 프롬프트를 따라감
            }

            ref.itemId = item.id;
            job.fullPrompt[idx] = newPrompt;
            touched = true;
            thisJobTouched = true;
        });

        // 🔧 버그 수정: 여기서 fullPrompt(텍스트)만 갱신하고 로라/Img2Img/ControlNet/검열/부정프롬프트 같은
        // "조각 전용 설정"은 안 건드리고 있었음. 그래서 이미 대기열에 들어간 뒤에 조각의 전용 부정프롬프트
        // (또는 로라 등)를 새로 추가/수정해도 이미 만들어진 job에는 전혀 반영이 안 되는 문제가 있었다.
        // → 이 job에 관련된 조각이 하나라도 갱신됐으면, 지금 sourceRefs 전체를 기준으로 모든 전용 설정을
        //   다시 계산해서 채워 넣는다 (fullPrompt와 같은 시점에 항상 같이 최신화되도록).
        if (thisJobTouched && typeof getAllCategories === 'function' &&
            typeof collectLoraOverrideForRefs === 'function' &&
            typeof collectNegativeOverrideForRefs === 'function' &&
            typeof collectSingleOverrideForRefs === 'function') {
            const loraOverride = collectLoraOverrideForRefs(job.sourceRefs);
            if (loraOverride) job.loraOverride = loraOverride; else delete job.loraOverride;

            const negativeOverride = collectNegativeOverrideForRefs(job.sourceRefs);
            if (negativeOverride) job.negativeOverride = negativeOverride; else delete job.negativeOverride;

            const img2imgOverride = collectSingleOverrideForRefs(job.sourceRefs, 'img2imgOverride');
            if (img2imgOverride) job.img2imgOverride = img2imgOverride; else delete job.img2imgOverride;

            const controlnetOverride = collectSingleOverrideForRefs(job.sourceRefs, 'controlnetOverride');
            if (controlnetOverride) job.controlnetOverride = controlnetOverride; else delete job.controlnetOverride;

            const censorOverride = collectSingleOverrideForRefs(job.sourceRefs, 'censorOverride');
            if (censorOverride) job.censorOverride = censorOverride; else delete job.censorOverride;

            // 🆕 조각 전용 키워드 무효화(긍정/부정)도 fullPrompt와 같은 시점에 같이 최신화
            if (typeof collectPosInvalidateForRefs === 'function') {
                const posInvalidate = collectPosInvalidateForRefs(job.sourceRefs);
                if (posInvalidate) job.posInvalidateOverride = posInvalidate; else delete job.posInvalidateOverride;
            }
            if (typeof collectNegInvalidateForRefs === 'function') {
                const negInvalidate = collectNegInvalidateForRefs(job.sourceRefs);
                if (negInvalidate) job.negInvalidateOverride = negInvalidate; else delete job.negInvalidateOverride;
            }
            // 🔀 조각 전용 조건부 프롬프트 변화 규칙도 같이 최신화
            if (typeof collectCondRulesForRefs === 'function') {
                const condRules = collectCondRulesForRefs(job.sourceRefs);
                if (condRules) job.condRulesOverride = condRules; else delete job.condRulesOverride;
            }
            // 🧱 조각 전용 카테고리 차단도 같이 최신화
            if (typeof collectBlockCategoriesForRefs === 'function') {
                const blockCats = collectBlockCategoriesForRefs(job.sourceRefs);
                if (blockCats) job.blockCategoriesOverride = blockCats; else delete job.blockCategoriesOverride;
            }
        }
    });
    if (touched && typeof renderJobQueue === 'function') renderJobQueue();
    if (touched && window.appStateManager) window.appStateManager.debounceSave();
}

/** job의 labels/sourceRefs를 합쳐서 "그룹명: 조각명 #번호" 형태 HTML로 변환 (그룹명 중복 방지) + 클릭 시 그룹으로 이동
 *  버전 전환/표시는 여기(목록)에는 넣지 않고, ✏️ 편집 모달의 입력창 안에서만 보이도록 함 */
function formatJobLabels(job, jobIndex) {
    const allCats = (typeof getAllCategories === 'function') ? getAllCategories() : [];
    const refs = job.sourceRefs || [];

    // sourceRefs 기준으로 그룹명/조각명/번호를 한 번에 조립 (클릭 시 해당 그룹으로 이동)
    if (refs.length > 0) {
        const parts = refs.map((ref, fragIdx) => {
            const cat = allCats.find(c => c.id === ref.catId);
            if (!cat) return null;
            const idx = cat.items.findIndex(it => it.id === ref.itemId);
            const item = idx !== -1 ? cat.items[idx] : null;

            if (!item) {
                // 합쳐진(Shift+Ctrl) 항목은 cat.items에 실제로 없는 합성 id라서 못 찾는다.
                // job.labels에 저장된 합쳐진 이름을 대신 보여준다 (클릭 이동은 안 되지만 이름은 표시됨).
                const fallbackName = job.labels && job.labels[cat.name];
                if (fallbackName) {
                    return `<span title="여러 조각이 하나로 합쳐진 항목"><b>${cat.name}:</b> 🔗 ${fallbackName}</span>`;
                }
                return null;
            }

            const numTag = ` #${idx + 1}`;
            return `<span style="cursor:pointer;" `
                 + `onclick="event.stopPropagation(); navigateToSourceRef('${cat.id}', '${item.id}', ${jobIndex}, ${fragIdx})" `
                 + `title="이 그룹으로 이동"><b>${cat.name}:</b> ${item.name}${numTag}</span>`;
        }).filter(Boolean);
        if (parts.length > 0) return parts.join(' | ');
    }

    // sourceRefs가 없거나 매칭 실패 시 labels로 폴백 (번호 없음, 이동 불가)
    return Object.entries(job.labels).map(([k, v]) => `<b>${k}:</b> ${v}`).join(' | ');
}

/** 대기열 항목 하나의 특정 조각(프롬 조각)만, 병합된 버전들 중 다른 버전으로 즉시 교체 (원본 조각의 activeVariant는 건드리지 않음) */
function switchQueueJobVariant(jobIndex, fragIndex, dir) {
    const job = jobQueue[jobIndex];
    if (!job || !job.sourceRefs || !job.sourceRefs[fragIndex]) return;
    const ref = job.sourceRefs[fragIndex];
    const allCats = (typeof getAllCategories === 'function') ? getAllCategories() : [];
    const cat = allCats.find(c => c.id === ref.catId);
    const item = cat && cat.items.find(i => i.id === ref.itemId);
    if (!item || !item.variants || item.variants.length < 2) return;

    const len = item.variants.length;
    const curIdx = (ref.variantIndex !== undefined ? ref.variantIndex : (item.activeVariant || 0));
    const newIdx = ((curIdx + dir) % len + len) % len;
    ref.variantIndex = newIdx;
    job.fullPrompt[fragIndex] = item.variants[newIdx].prompt;

    renderJobQueue();
    if (window.appStateManager) window.appStateManager.debounceSave();
}

/** 대기열 편집 모달에서 ◀▶로 버전 전환하기 전, 지금 입력창에 있는(아직 저장 안 한) 내용을
 *  떠나는 버전에 먼저 반영(원본 조각+대기열 항목 둘 다)해서 덮어써지지 않게 한 뒤 전환한다. */
function switchVariantInJobModal(jobIndex, fragIndex, dir) {
    const job = jobQueue[jobIndex];
    if (!job || !job.sourceRefs || !job.sourceRefs[fragIndex]) return;
    const ref = job.sourceRefs[fragIndex];
    const allCats = (typeof getAllCategories === 'function') ? getAllCategories() : [];
    const cat = allCats.find(c => c.id === ref.catId);
    const item = cat && cat.items.find(i => i.id === ref.itemId);

    const textarea = document.querySelector(`#job-edit-modal .job-edit-frag[data-idx="${fragIndex}"]`);
    if (textarea) {
        const currentText = textarea.value;
        job.fullPrompt[fragIndex] = currentText;
        if (item) {
            const curIdx = ref.variantIndex !== undefined ? ref.variantIndex : (item.activeVariant || 0);
            if (item.variants && item.variants[curIdx]) {
                item.variants[curIdx].prompt = currentText;
                if (curIdx === (item.activeVariant || 0)) item.prompt = currentText;
            } else if (!item.variants) {
                item.prompt = currentText;
            }
        }
    }

    switchQueueJobVariant(jobIndex, fragIndex, dir);

    if (typeof renderItems === 'function') renderItems();
    if (typeof debounceLibrarySave === 'function') debounceLibrarySave();
    openJobEditModal(jobIndex);
}

/** 대기열 편집 모달의 특정 조각 칸에 지금 적혀 있는 내용을 원본 조각의 새 버전으로 추가 저장.
 *  아직 병합 안 된 단일 조각이면 자동으로 병합형(variants)으로 전환. 대기열 항목도 새 버전으로 즉시 갱신. */
function addVariantFromQueue(jobIndex, fragIndex) {
    const job = jobQueue[jobIndex];
    if (!job || !job.sourceRefs || !job.sourceRefs[fragIndex]) return;
    const ref = job.sourceRefs[fragIndex];
    const allCats = (typeof getAllCategories === 'function') ? getAllCategories() : [];
    const cat = allCats.find(c => c.id === ref.catId);
    const item = cat && cat.items.find(i => i.id === ref.itemId);
    if (!item) return alert('원본 조각을 찾을 수 없습니다 (삭제되었을 수 있습니다).');

    const textarea = document.querySelector(`#job-edit-modal .job-edit-frag[data-idx="${fragIndex}"]`);
    if (!textarea) return;
    const newPrompt = textarea.value;

    if (!item.variants || item.variants.length < 2) {
        item.variants = [{ name: item.name, prompt: item.prompt }];
        item.activeVariant = 0;
    }
    const newIdx = item.variants.length;
    item.variants.push({ name: `${item.name} ${newIdx + 1}`, prompt: newPrompt });
    item.activeVariant = newIdx;
    item.prompt = newPrompt;

    ref.variantIndex = newIdx;
    job.fullPrompt[fragIndex] = newPrompt;

    if (typeof renderItems === 'function') renderItems();
    if (typeof renderBuilder === 'function') renderBuilder();
    if (typeof debounceLibrarySave === 'function') debounceLibrarySave();

    // 모달을 새로 열어서 버전 뱃지(개수/번호)를 갱신
    openJobEditModal(jobIndex);
}

/** 대기열 편집 모달에서 지금 표시된 버전을 원본 조각에서 삭제. 버전이 1개만 남으면 병합을 풀고 일반 조각으로 되돌림. */
function deleteVariantFromQueue(jobIndex, fragIndex) {
    const job = jobQueue[jobIndex];
    if (!job || !job.sourceRefs || !job.sourceRefs[fragIndex]) return;
    const ref = job.sourceRefs[fragIndex];
    const allCats = (typeof getAllCategories === 'function') ? getAllCategories() : [];
    const cat = allCats.find(c => c.id === ref.catId);
    const item = cat && cat.items.find(i => i.id === ref.itemId);
    if (!item || !item.variants || item.variants.length < 2) return;

    const curIdx = (ref.variantIndex !== undefined ? ref.variantIndex : (item.activeVariant || 0));
    const label = item.variants[curIdx].name || `${curIdx + 1}번째 버전`;
    if (!confirm(`"${label}" 버전을 원본 조각에서 삭제할까요? 되돌릴 수 없습니다.`)) return;

    item.variants.splice(curIdx, 1);

    let newPrompt;
    if (item.variants.length <= 1) {
        const last = item.variants[0];
        newPrompt = last ? last.prompt : item.prompt;
        item.prompt = newPrompt;
        delete item.variants;
        delete item.activeVariant;
        delete ref.variantIndex;
    } else {
        item.activeVariant = Math.min(curIdx, item.variants.length - 1);
        newPrompt = item.variants[item.activeVariant].prompt;
        item.prompt = newPrompt;
        ref.variantIndex = item.activeVariant;
    }
    job.fullPrompt[fragIndex] = newPrompt;

    if (typeof renderItems === 'function') renderItems();
    if (typeof renderBuilder === 'function') renderBuilder();
    if (typeof debounceLibrarySave === 'function') debounceLibrarySave();

    openJobEditModal(jobIndex);
}

/** 대기열 항목의 그룹/조각 참조를 클릭했을 때, 좌측 라이브러리에서 해당 조각의 편집 모달을 바로 연다.
 *  (라이브러리에서 조각을 직접 우클릭하는 것과 완전히 동일한 동작 — 로라/Img2Img/ControlNet/검열 등
 *  조각 전용 설정을 그 자리에서 바로 만질 수 있음). 이동/하이라이트 로직은 library.js의
 *  goToLibraryFragment()로 통일되어 있음.
 *  jobIndex/fragIndex가 주어지면(=대기열에서 열린 경우) library.js 쪽에 "이 모달에서 버전을
 *  바꾸면 이 대기열 항목도 즉시 따라가야 함"을 알려준다 — 그래야 ◀▶ 버전 전환이 대기열에도 반영됨. */
function navigateToSourceRef(catId, itemId, jobIndex, fragIndex) {
    if (typeof goToLibraryFragment !== 'function') return;
    const queueSync = (jobIndex !== undefined && fragIndex !== undefined) ? { jobIndex, fragIndex } : null;
    goToLibraryFragment(catId, itemId, { openEdit: true, queueSync });
}

/** 대기열 목록을 HTML로 렌더링 */
function renderJobQueue() {
    const container = document.getElementById('job-queue-list');
    if (jobQueue.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: #666; margin: 0;">대기열이 비어 있습니다.</p>';
        return;
    }

    // 활성/비활성 카운트
    const activeCount = jobQueue.filter(j => !j.disabled).length;
    const totalCount = jobQueue.length;

    const summaryHtml = `<div style="font-size:0.8em; color:#888; margin-bottom:10px; padding:6px 8px; background:#1a1a1a; border-radius:4px; border:1px solid #333;">
        📋 전체 <b style="color:#fff;">${totalCount}</b>개 · 활성 <b style="color:#4CAF50;">${activeCount}</b>개 · 비활성 <b style="color:#888;">${totalCount - activeCount}</b>개
        <button onclick="toggleAllJobs(true)" style="margin-left:10px; padding:2px 8px; font-size:0.85em; background:#2a4a2a; border:1px solid #4CAF50; border-radius:3px; color:#4CAF50; cursor:pointer;">전체 활성화</button>
        <button onclick="toggleAllJobs(false)" style="margin-left:4px; padding:2px 8px; font-size:0.85em; background:#333; border:1px solid #555; border-radius:3px; color:#888; cursor:pointer;">전체 비활성화</button>
    </div>`;

    container.innerHTML = summaryHtml + jobQueue.map((job, index) => {
        const isDisabled = !!job.disabled;
        const borderColor = isDisabled ? '#555' : '#4CAF50';
        const badgeBg = isDisabled ? '#444' : '#4CAF50';
        const textOpacity = isDisabled ? 'opacity:0.4;' : '';
        const toggleLabel = isDisabled ? '▶ 활성화' : '⏸ 비활성';
        const toggleBg = isDisabled ? 'background:#2a4a2a; color:#4CAF50; border:1px solid #4CAF50;' : 'background:#333; color:#aaa; border:1px solid #555;';
        const disabledBadge = isDisabled ? '<span style="font-size:0.7em; background:#444; color:#888; border-radius:3px; padding:1px 5px; margin-left:6px;">비활성</span>' : '';

        const regionalRef = (job.sourceRefs || []).find(r => r.regionalPrompts && r.regionalPrompts.length > 1);
        const layoutBtn = regionalRef
            ? `<button class="btn-secondary" onclick="event.stopPropagation(); openRegionalLayoutEditor(${index})" style="padding:3px 8px; font-size:0.78em;" title="캐릭터별 화면 구도 설정 (${regionalRef.regionalPrompts.length}명)">🎨 구도</button>`
            : '';
        const sketchBtn = regionalRef
            ? `<button class="btn-secondary" onclick="event.stopPropagation(); generateRegionalSketch(${index})" style="padding:3px 8px; font-size:0.78em; border-color:#FF9800; color:#FFB74D;" title="공통 프롬프트만으로 전체 구도 스케치를 먼저 뽑아서, 그 위에 박스를 정확히 맞출 수 있게">🖼 스케치</button>`
            : '';

        return `
        <div class="lora-item" style="justify-content: space-between; border-left: 4px solid ${borderColor}; ${isDisabled ? 'background:#1a1a1a;' : ''}">
            <div style="display:flex; align-items:flex-start; gap:8px; flex:1; ${textOpacity}">
                <span style="min-width:22px; height:22px; border-radius:50%; background:${badgeBg}; color:#fff; font-size:0.75em; font-weight:bold; display:flex; align-items:center; justify-content:center; flex-shrink:0; margin-top:1px;">${index + 1}</span>
                <div style="flex:1; cursor:pointer;" onclick="handleQueueItemBodyClick(${index})" title="클릭하여 프롬프트 편집 (조각 1개짜리면 조각 편집, 여러 개 합쳐진 항목이면 대기열 항목 편집)">
                    <div style="font-size:0.9em; margin-bottom:5px;">${formatJobLabels(job, index)}${disabledBadge}</div>
                    <div style="font-size:0.75em; color:#aaa; white-space:pre-wrap; word-break:break-all; line-height:1.9;">${(() => {
                        // 🆕 미리보기도 실제 생성될 내용과 똑같이 "{color}"를 선택된 색으로 치환해서 보여줌
                        const previewText = job.fullPrompt.join(', ').replace(/\{color\}/g, job.colorChoice || JOB_COLOR_PALETTE[0]);
                        return (typeof renderCategorizedPromptHtml === 'function') ? renderCategorizedPromptHtml(previewText) : previewText;
                    })()}</div>
                    ${jobColorSwatchHtml(job, index)}
                    <div style="font-size:0.7em; color:#555; margin-top:3px;">✏️ 클릭해서 프롬 편집</div>
                </div>
            </div>
            <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
                ${sketchBtn}
                ${layoutBtn}
                <button onclick="toggleJobDisabled(${index})" style="padding:3px 8px; font-size:0.78em; border-radius:4px; cursor:pointer; ${toggleBg} white-space:nowrap;">${toggleLabel}</button>
                <label style="font-size:0.8em; ${textOpacity}">반복:</label>
                <input type="number" value="${job.repeatCount}" style="width:50px; padding:3px; ${isDisabled ? 'opacity:0.4;' : ''}" onchange="updateJobRepeat(${index}, this.value)" ${isDisabled ? 'disabled' : ''}>
                <button class="btn-secondary" onclick="removeJob(${index})" style="background:#844; padding: 2px 8px;">×</button>
            </div>
        </div>
    `;
    }).join('');
}

/** 전체 대기열 활성화/비활성화 */
function toggleAllJobs(activate) {
    jobQueue.forEach(job => { job.disabled = !activate; });
    renderJobQueue();
    if (window.appStateManager) window.appStateManager.debounceSave();
}

/**
 * 🎨 캐릭터 구도 설정: 리저널(합치기) job의 화면 분할 비율/방향을 조절한다.
 * job.regionalLayout = { orientation: 'horizontal'|'vertical', division: [1,1,1,...] } 형태로 저장되고,
 * executeGeneration이 이 값을 읽어서 TiledAttentionCouple 워크플로우에 그대로 넘긴다.
 */
/** "896 x 1152  (portrait)" 같은 문자열에서 {width, height} 숫자만 뽑아낸다 */
function getResolutionFromDimensionsString(raw) {
    const m = (raw || '').match(/(\d+)\s*x\s*(\d+)/i);
    return m ? { width: parseInt(m[1], 10), height: parseInt(m[2], 10) } : { width: 896, height: 1152 };
}

function getResolutionForLayout() {
    return getResolutionFromDimensionsString(document.getElementById('adv-dimensions')?.value);
}

/** 기존(division/orientation) 또는 없는 경우, 캐릭터 수(n)에 맞는 기본 균등 가로 배치 박스 배열을 만든다.
 *  좌표는 전부 0~1 사이 비율(fraction)로 저장한다 (해상도 안 가리는 상대값). */
function makeEqualBoxes(n) {
    const boxes = [];
    for (let i = 0; i < n; i++) {
        boxes.push({ x: i / n, y: 0, w: 1 / n, h: 1 });
    }
    return boxes;
}

function ensureRegionalLayoutBoxes(job, n) {
    if (!job.regionalLayout || !Array.isArray(job.regionalLayout.boxes) || job.regionalLayout.boxes.length !== n) {
        job.regionalLayout = job.regionalLayout || {}; // 기존 값(sketchImage, baseImage, poseGuideEnabled 등) 보존
        // 예전 division/orientation 형식이 남아있으면 최대한 그 비율을 살려서 박스로 변환, 아니면 균등분할
        if (Array.isArray(job.regionalLayout.division) && job.regionalLayout.division.length === n) {
            const total = job.regionalLayout.division.reduce((a, b) => a + b, 0) || 1;
            const isH = job.regionalLayout.orientation !== 'vertical';
            let acc = 0;
            job.regionalLayout.boxes = job.regionalLayout.division.map(d => {
                const start = acc / total;
                acc += d;
                const size = d / total;
                return isH ? { x: start, y: 0, w: size, h: 1 } : { x: 0, y: start, w: 1, h: size };
            });
        } else {
            job.regionalLayout.boxes = makeEqualBoxes(n);
        }
    }
}

/**
 * 🖼 스케치 생성: 캐릭터별 특정 프롬프트 없이, 공통 프롬프트(긍정+행동+기타 조각)만으로
 * 전체 구도를 빠르게 하나 뽑는다. 이 결과 위에 박스를 정확히 맞춰서 배치할 수 있게 됨.
 */
async function generateRegionalSketch(jobIndex) {
    const job = jobQueue[jobIndex];
    if (!job) return;
    const regionalRef = (job.sourceRefs || []).find(r => r.regionalPrompts && r.regionalPrompts.length > 1);
    if (!regionalRef) return;

    const regionalRefIndex = job.sourceRefs.indexOf(regionalRef);
    const actionBatch = document.getElementById('action-pos')?.value?.trim();
    const basePosWithAction = actionBatch
        ? `${document.getElementById('base-pos').value}, ${actionBatch}`
        : document.getElementById('base-pos').value;
    const commonFullPromptParts = job.fullPrompt.filter((_, idx) => idx !== regionalRefIndex);
    const fullPos = (() => {
        const base = applyDisabledTokens(basePosWithAction + (commonFullPromptParts.length > 0 ? ", " + commonFullPromptParts.join(', ') : ""));
        const withBackview = job.backViewFaceWeightDown ? applyFaceWeightReduction(base) : base;
        const invalidated = applyItemTokenInvalidation(withBackview, job.posInvalidateOverride);
        const blocked = applyItemCategoryBlock(invalidated, job.blockCategoriesOverride);
        return applyCameraComposition(applyItemConditionalRules(blocked, job.condRulesOverride));
    })();
    // 🆕 이 job에 조각 전용 부정프롬프트가 있으면 공통 부정프롬프트 뒤에 이어붙인다 (본 생성과 동일하게)
    const baseNegText = document.getElementById('base-neg').value;
    const combinedNeg = job.negativeOverride ? `${job.negativeOverride}, ${baseNegText}` : baseNegText;
    const fullNeg = applyItemTokenInvalidation(combinedNeg, job.negInvalidateOverride);

    const btn = event?.target;
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 생성 중...'; }

    const dimAtGenTime = getResolutionFromDimensionsString(document.getElementById('adv-dimensions')?.value); // 나중에 편집창 비율 계산에 씀 (드롭다운이 그 사이 바뀌어도 안 틀어지게)

    try {
        const result = await executeGeneration(fullPos, fullNeg, "RegionalSketch", null, null);
        if (result && result.length > 0) {
            const img = result[0];
            job.regionalLayout = job.regionalLayout || {};
            job.regionalLayout.sketchImage = { filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output', width: dimAtGenTime.width, height: dimAtGenTime.height };
            if (window.appStateManager) window.appStateManager.debounceSave();
            openRegionalLayoutEditor(jobIndex); // 스케치 위에 박스 다시 배치할 수 있게 바로 열기
        } else {
            alert('스케치 생성에 실패했습니다 (결과 이미지를 못 받음).');
        }
    } catch (e) {
        console.error(e);
        alert('스케치 생성 중 오류가 발생했습니다.');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🖼 스케치'; }
    }
}
window.generateRegionalSketch = generateRegionalSketch;

function openRegionalLayoutEditor(jobIndex) {
    const job = jobQueue[jobIndex];
    if (!job) return;
    const regionalRef = (job.sourceRefs || []).find(r => r.regionalPrompts && r.regionalPrompts.length > 1);
    if (!regionalRef) return;

    const n = regionalRef.regionalPrompts.length;
    ensureRegionalLayoutBoxes(job, n);

    if (!document.getElementById('regional-layout-modal')) {
        const modal = document.createElement('div');
        modal.id = 'regional-layout-modal';
        modal.className = 'modal-overlay';
        modal.style.cssText = 'display:none;';
        modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
        document.body.appendChild(modal);
    }

    const modal = document.getElementById('regional-layout-modal');
    const sketch = job.regionalLayout.sketchImage;
    const baseImg = job.regionalLayout.baseImage;
    const previewImg = baseImg || sketch; // 기초 이미지가 있으면 그게 우선 (스케치보다 위에 표시)
    // 캔버스 비율은 실제 이미지의 진짜 해상도 기준으로 (해상도 드롭다운이 그 뒤에 바뀌어도 안 틀어지게).
    // 저장된 값이 없는 옛날 job이면 어쩔 수 없이 지금 드롭다운 값으로 대체.
    const res = (previewImg && previewImg.width && previewImg.height)
        ? { width: previewImg.width, height: previewImg.height }
        : getResolutionForLayout();
    const maxDim = 460;
    const scale = Math.min(maxDim / res.width, maxDim / res.height);
    const boxW = Math.round(res.width * scale);
    const boxH = Math.round(res.height * scale);

    const sketchUrl = previewImg
        ? `/view?filename=${encodeURIComponent(previewImg.filename)}&type=${encodeURIComponent(previewImg.type)}&subfolder=${encodeURIComponent(previewImg.subfolder)}`
        : null;

    modal.innerHTML = `
        <div class="modal-content" onclick="event.stopPropagation()" style="width:min(94vw, 700px); max-height:88vh; overflow-y:auto;">
            <div class="modal-header">
                <h3 style="margin:0; color:#CE93D8;">🎨 캐릭터 구도 설정 (자유배치)</h3>
                <span class="close-btn" style="position:static; font-size:1.5em; color:#ff5555;" onclick="document.getElementById('regional-layout-modal').style.display='none';">&times;</span>
            </div>
            <div class="modal-body" style="display:flex; flex-direction:column; gap:10px;">
                <p style="font-size:0.8em; color:#aaa; margin:0;">
                    ${previewImg
                        ? '이미지 위에 박스를 실제 캐릭터 위치에 맞춰 옮겨보세요.'
                        : '먼저 "🖼 스케치"를 뽑거나 "📁 기초 이미지"를 업로드하면, 그 위에 박스를 정확히 맞출 수 있어요. (지금은 빈 캔버스 기준으로만 배치)'}
                    박스 안쪽을 드래그하면 이동, 오른쪽 아래 모서리(◢)를 드래그하면 크기 조절돼요. (해상도 ${res.width}×${res.height} 기준)
                </p>
                <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
                    <button class="btn-secondary" onclick="generateRegionalSketch(${jobIndex})" style="font-size:0.8em; border-color:#FF9800; color:#FFB74D;">🖼 ${sketch ? '스케치 다시뽑기' : '스케치 생성'}</button>
                    <label class="btn-secondary" style="font-size:0.8em; border-color:#4CAF50; color:#81C784; cursor:pointer; display:inline-flex; align-items:center;">
                        📁 기초 이미지 업로드
                        <input type="file" accept="image/*" style="display:none;" onchange="uploadRegionalBaseImage(${jobIndex}, this.files[0])">
                    </label>
                    ${baseImg ? `<button class="btn-secondary" onclick="clearRegionalBaseImage(${jobIndex})" style="font-size:0.8em; border-color:#844; color:#e88;">기초 이미지 제거</button>` : ''}
                    <button class="btn-secondary" onclick="setEqualRegionalBoxes(${jobIndex})" style="font-size:0.8em; border-color:#2196F3; color:#64B5F6;">⚖️ 균등분할로 리셋</button>
                    <button class="btn-secondary" onclick="clearAllRegionalPaintMasks(${jobIndex})" style="font-size:0.8em; border-color:#FF5252; color:#FF8A80;" title="모든 캐릭터의 붓칠 마스크를 한번에 지웁니다 (박스 위치/기초 이미지는 그대로 유지)">🗑 붓칠 마스크 일괄초기화</button>
                </div>
                ${baseImg ? '<p style="font-size:0.72em; color:#81C784; margin:0;">✅ 기초 이미지 사용 중 — 생성 시 자동 스케치 대신 이 이미지에서 바로 시작합니다.</p>' : ''}
                <label style="display:flex; align-items:center; gap:6px; font-size:0.8em; color:#ccc; cursor:pointer;">
                    <input type="checkbox" id="regional-pose-guide-toggle" ${job.regionalLayout.poseGuideEnabled ? 'checked' : ''} onchange="toggleRegionalPoseGuide(${jobIndex}, this.checked)">
                    🦴 포즈 가이드 (ControlNet) — 켜면 스케치/기초 이미지의 포즈·구도를 따라가면서 새로 그립니다
                </label>
                <div style="display:flex; align-items:center; gap:8px; font-size:0.78em; color:#aaa; padding-left:22px;">
                    포즈 강도
                    <input type="range" id="regional-pose-strength-slider" min="0" max="1" step="0.05"
                        value="${job.regionalLayout.poseGuideStrength ?? 0.85}"
                        oninput="document.getElementById('regional-pose-strength-val').textContent = this.value; setRegionalPoseGuideStrength(${jobIndex}, this.value);"
                        style="flex:1;">
                    <span id="regional-pose-strength-val" style="width:32px; text-align:right; color:#FFB74D;">${job.regionalLayout.poseGuideStrength ?? 0.85}</span>
                </div>
                <label style="display:flex; align-items:center; gap:6px; font-size:0.8em; color:#ccc; cursor:pointer; padding-top:4px; border-top:1px solid #333;">
                    <input type="checkbox" id="regional-finish-pass-toggle" ${job.regionalLayout.finishPassEnabled ? 'checked' : ''} onchange="toggleRegionalFinishPass(${jobIndex}, this.checked)">
                    🧹 마무리 정리 — 캐릭터들을 따로 그려서 생기는 이음새/부자연스러운 부분을 마지막에 한번 전체적으로 살짝 다듬어요
                </label>
                <div style="display:flex; align-items:center; gap:8px; font-size:0.78em; color:#aaa; padding-left:22px;">
                    정리 강도 (낮을수록 원본 유지, 높을수록 많이 바뀜)
                    <input type="range" id="regional-finish-strength-slider" min="0.1" max="0.5" step="0.05"
                        value="${job.regionalLayout.finishPassDenoise ?? 0.25}"
                        oninput="document.getElementById('regional-finish-strength-val').textContent = this.value; setRegionalFinishPassDenoise(${jobIndex}, this.value);"
                        style="flex:1;">
                    <span id="regional-finish-strength-val" style="width:32px; text-align:right; color:#81C784;">${job.regionalLayout.finishPassDenoise ?? 0.25}</span>
                </div>
                ${job.regionalLayout.lastResultImage ? `
                <div style="border-top:1px solid #333; padding-top:8px; display:flex; flex-direction:column; gap:6px;">
                    <p style="font-size:0.78em; color:#BA68C8; margin:0; font-weight:bold;">🔁 부분 재생성 — 마음에 안 드는 캐릭터만 골라서 다시 그리기 (나머지는 지난 결과 유지)</p>
                    <div style="display:flex; flex-wrap:wrap; gap:8px;">
                        ${regionalRef.regionalPrompts.map((p, i) => `
                            <label style="display:flex; align-items:center; gap:4px; font-size:0.75em; color:#ccc; cursor:pointer; background:#222; padding:3px 8px; border-radius:4px;">
                                <input type="checkbox" class="regional-redo-check" data-idx="${i}" checked>
                                ${i + 1}. ${(p || '').slice(0, 14)}
                            </label>`).join('')}
                    </div>
                    <div style="display:flex; gap:6px;">
                        <button class="btn-secondary" onclick="regenerateSelectedRegionalCharacters(${jobIndex})" style="font-size:0.78em; border-color:#BA68C8; color:#CE93D8;">🔁 체크된 캐릭터만 다시 생성</button>
                        <button class="btn-secondary" onclick="regenerateRegionalFinishOnly(${jobIndex})" style="font-size:0.78em; border-color:#4CAF50; color:#81C784;" ${job.regionalLayout.finishPassEnabled ? '' : 'disabled title="마무리 정리가 꺼져 있어요"'}>🧹 마무리만 다시 생성</button>
                    </div>
                </div>` : ''}
                <div style="display:flex; gap:10px; align-items:flex-start; justify-content:center;">
                    <div id="regional-layout-sidebar" style="width:120px; flex-shrink:0; display:flex; flex-direction:column; gap:6px;"></div>
                    <div id="regional-layout-canvas" style="position:relative; width:${boxW}px; height:${boxH}px; min-width:${boxW}px; min-height:${boxH}px; flex-shrink:0; background:#111; border:1px solid #555; border-radius:4px; overflow:hidden;">${sketchUrl ? `<img id="regional-sketch-img" src="${sketchUrl}" style="position:absolute; inset:0; width:${boxW}px; height:${boxH}px; z-index:0; pointer-events:none; user-select:none;" onerror="this.insertAdjacentHTML('afterend', '<div style=&quot;position:absolute;inset:0;z-index:0;color:#f88;font-size:11px;padding:6px;overflow:auto;&quot;>이미지 로드 실패: '+this.src+'</div>');">` : ''}</div>
                </div>
                <div style="text-align:right;">
                    <button class="btn-primary" onclick="document.getElementById('regional-layout-modal').style.display='none'; if(window.appStateManager) appStateManager.debounceSave();">완료</button>
                </div>
            </div>
        </div>`;
    modal.style.display = 'flex';

    renderRegionalLayoutCanvas(jobIndex);
}
window.openRegionalLayoutEditor = openRegionalLayoutEditor;

/** 📁 기초 이미지 업로드: 사용자가 직접 고른 이미지 파일을 ComfyUI 서버(input 폴더)에 올리고,
 *  job.regionalLayout.baseImage에 저장한다. 이게 있으면 생성 시 자동 스케치 대신 이 이미지로 바로 시작. */
async function uploadRegionalBaseImage(jobIndex, file) {
    if (!file) return;
    const job = jobQueue[jobIndex];
    if (!job) return;

    try {
        const formData = new FormData();
        formData.append('image', file, file.name);
        formData.append('overwrite', 'true');
        const uploadRes = await fetch('/upload/image', { method: 'POST', body: formData });
        if (!uploadRes.ok) throw new Error(`업로드 실패: HTTP ${uploadRes.status}`);
        const uploaded = await uploadRes.json(); // { name, subfolder, type } — type은 보통 'input'

        // 실제 이미지 픽셀 크기를 읽어서 같이 저장 (편집창 캔버스 비율을 여기 맞출 것 — 해상도 드롭다운과 무관하게)
        const naturalSize = await new Promise(resolve => {
            const img = new Image();
            img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = () => resolve(null);
            img.src = URL.createObjectURL(file);
        });

        job.regionalLayout = job.regionalLayout || {};
        job.regionalLayout.baseImage = {
            filename: uploaded.name,
            subfolder: uploaded.subfolder || '',
            type: uploaded.type || 'input',
            width: naturalSize?.width,
            height: naturalSize?.height
        };
        if (window.appStateManager) window.appStateManager.debounceSave();
        openRegionalLayoutEditor(jobIndex); // 새로 올린 이미지가 바로 보이게 다시 열기
    } catch (e) {
        console.error(e);
        alert('기초 이미지 업로드 중 오류가 발생했습니다.');
    }
}
window.uploadRegionalBaseImage = uploadRegionalBaseImage;

function clearRegionalBaseImage(jobIndex) {
    const job = jobQueue[jobIndex];
    if (!job || !job.regionalLayout) return;
    delete job.regionalLayout.baseImage;
    if (window.appStateManager) window.appStateManager.debounceSave();
    openRegionalLayoutEditor(jobIndex);
}
window.clearRegionalBaseImage = clearRegionalBaseImage;

/** 지정한 jobIndex 하나만 실행되도록 배치 범위 입력칸을 잠깐 그 번호로 바꿨다가 원복하면서
 *  기존 startBatchGeneration()을 그대로 재사용한다 (전체 로직 중복 없이 안전하게 한 job만 실행). */
async function runSingleJobViaBatchRange(jobIndex) {
    const rangeInput = document.getElementById('batch-range-input');
    const prevRange = rangeInput ? rangeInput.value : '';
    if (rangeInput) rangeInput.value = String(jobIndex + 1); // 1-based
    try {
        await startBatchGeneration();
    } finally {
        if (rangeInput) rangeInput.value = prevRange;
    }
}

/** 🔁 체크된 캐릭터만 다시 생성: 나머지 캐릭터는 지난 최종 결과 그대로 유지하고,
 *  체크된 캐릭터의 박스만 다시 완전 재생성한다 (denoise=1.0). 마무리 정리가 켜져 있으면 그것도 다시 돈다. */
async function regenerateSelectedRegionalCharacters(jobIndex) {
    const job = jobQueue[jobIndex];
    if (!job || !job.regionalLayout || !job.regionalLayout.lastResultImage) {
        alert('아직 전체 생성 결과가 없어서 부분 재생성을 할 수 없습니다. 먼저 한 번 생성해주세요.');
        return;
    }
    const checks = Array.from(document.querySelectorAll('.regional-redo-check'));
    const indices = checks.filter(c => c.checked).map(c => parseInt(c.dataset.idx, 10));
    if (indices.length === 0) { alert('다시 생성할 캐릭터를 하나 이상 체크해주세요.'); return; }

    job.regionalLayout.redoIndices = indices;
    document.getElementById('regional-layout-modal').style.display = 'none';
    try {
        await runSingleJobViaBatchRange(jobIndex);
    } finally {
        delete job.regionalLayout.redoIndices; // 한번 쓰고 원상복구 (다음엔 다시 명시적으로 선택해야 함)
        if (window.appStateManager) window.appStateManager.debounceSave();
    }
}
window.regenerateSelectedRegionalCharacters = regenerateSelectedRegionalCharacters;

/** 🧹 마무리만 다시 생성: 캐릭터는 하나도 안 건드리고(redoIndices=[]), 마무리 정리 단계만 다시 돈다. */
async function regenerateRegionalFinishOnly(jobIndex) {
    const job = jobQueue[jobIndex];
    if (!job || !job.regionalLayout || !job.regionalLayout.lastResultImage) {
        alert('아직 전체 생성 결과가 없어서 다시 할 수 없습니다.');
        return;
    }
    if (!job.regionalLayout.finishPassEnabled) { alert('"🧹 마무리 정리" 체크박스가 꺼져 있어요. 먼저 켜주세요.'); return; }

    job.regionalLayout.redoIndices = []; // 캐릭터는 전부 스킵, 마무리 정리만 실행됨
    document.getElementById('regional-layout-modal').style.display = 'none';
    try {
        await runSingleJobViaBatchRange(jobIndex);
    } finally {
        delete job.regionalLayout.redoIndices;
        if (window.appStateManager) window.appStateManager.debounceSave();
    }
}
window.regenerateRegionalFinishOnly = regenerateRegionalFinishOnly;

/** 🦴 포즈 가이드 체크박스: job.regionalLayout.poseGuideEnabled에 저장.
 *  켜져 있으면 생성 시 스케치/기초 이미지 전체에서 OpenPose로 뼈대를 뽑아 각 캐릭터
 *  재생성에 ControlNet으로 걸어준다 (OpenPoseXL2.safetensors 필요). */
function toggleRegionalPoseGuide(jobIndex, checked) {
    const job = jobQueue[jobIndex];
    if (!job || !job.regionalLayout) return;
    job.regionalLayout.poseGuideEnabled = checked;
    if (window.appStateManager) window.appStateManager.debounceSave();
}
window.toggleRegionalPoseGuide = toggleRegionalPoseGuide;

/** 🦴 포즈 ControlNet 강도 슬라이더 (0~1, 기본 0.85) */
function setRegionalPoseGuideStrength(jobIndex, value) {
    const job = jobQueue[jobIndex];
    if (!job || !job.regionalLayout) return;
    job.regionalLayout.poseGuideStrength = parseFloat(value);
    if (window.appStateManager) window.appStateManager.debounceSave();
}
window.setRegionalPoseGuideStrength = setRegionalPoseGuideStrength;

/** 🧹 마무리 정리 체크박스: job.regionalLayout.finishPassEnabled에 저장.
 *  켜져 있으면 모든 캐릭터 재생성이 끝난 뒤, 전체 캔버스에 낮은 denoise로 한 번 더
 *  KSampler를 돌려서 캐릭터들 사이 이음새/조명 불일치 등을 살짝 다듬어준다. */
function toggleRegionalFinishPass(jobIndex, checked) {
    const job = jobQueue[jobIndex];
    if (!job || !job.regionalLayout) return;
    job.regionalLayout.finishPassEnabled = checked;
    if (window.appStateManager) window.appStateManager.debounceSave();
}
window.toggleRegionalFinishPass = toggleRegionalFinishPass;

/** 🧹 마무리 정리 강도(denoise) 슬라이더 (0.1~0.5, 기본 0.25) */
function setRegionalFinishPassDenoise(jobIndex, value) {
    const job = jobQueue[jobIndex];
    if (!job || !job.regionalLayout) return;
    job.regionalLayout.finishPassDenoise = parseFloat(value);
    if (window.appStateManager) window.appStateManager.debounceSave();
}
window.setRegionalFinishPassDenoise = setRegionalFinishPassDenoise;

/** 🗑 붓칠 마스크 일괄초기화: 이 job의 모든 캐릭터 박스 중 자유그리기(freeform)로 그려둔
 *  마스크(box.maskDataUrl)를 한번에 전부 지운다. 박스 위치/모드(freeform 여부)나 기초 이미지는
 *  그대로 유지되고, 그려둔 그림만 비워져서 처음부터 다시 칠할 수 있게 된다.
 *  (옛날 색상 버그로 저장된 마스크들을 한번에 정리할 때 유용) */
function clearAllRegionalPaintMasks(jobIndex) {
    const job = jobQueue[jobIndex];
    if (!job || !job.regionalLayout || !Array.isArray(job.regionalLayout.boxes)) return;

    const paintedCount = job.regionalLayout.boxes.filter(b => b.freeform && b.maskDataUrl).length;
    if (paintedCount === 0) { alert('지울 붓칠 마스크가 없습니다.'); return; }
    if (!confirm(`이 캐릭터 조합의 붓칠 마스크 ${paintedCount}개를 전부 지울까요? (박스 위치는 유지됩니다)`)) return;

    job.regionalLayout.boxes.forEach(b => { if (b.freeform) delete b.maskDataUrl; });
    if (window.appStateManager) window.appStateManager.debounceSave();
    renderRegionalLayoutCanvas(jobIndex);
}
window.clearAllRegionalPaintMasks = clearAllRegionalPaintMasks;

function setEqualRegionalBoxes(jobIndex) {
    const job = jobQueue[jobIndex];
    if (!job) return;
    const regionalRef = (job.sourceRefs || []).find(r => r.regionalPrompts && r.regionalPrompts.length > 1);
    if (!regionalRef) return;
    job.regionalLayout = job.regionalLayout || {};
    job.regionalLayout.boxes = makeEqualBoxes(regionalRef.regionalPrompts.length); // 박스 위치만 리셋, 스케치/기초 이미지는 유지
    renderRegionalLayoutCanvas(jobIndex);
    if (window.appStateManager) window.appStateManager.debounceSave();
}
window.setEqualRegionalBoxes = setEqualRegionalBoxes;

function renderRegionalLayoutCanvas(jobIndex) {
    const job = jobQueue[jobIndex];
    if (!job || !job.regionalLayout) return;
    const canvas = document.getElementById('regional-layout-canvas');
    if (!canvas) return;

    const regionalRef = (job.sourceRefs || []).find(r => r.regionalPrompts && r.regionalPrompts.length > 1);
    const prompts = regionalRef.regionalPrompts;
    const boxes = job.regionalLayout.boxes;
    const colors = ['#4CAF50', '#2196F3', '#FF9800', '#E91E63', '#9C27B0', '#00BCD4'];
    const MIN_SIZE = 0.06; // 박스가 너무 작아지지 않게 최소 크기(비율)
    let paintingIdx = null; // 지금 붓으로 그리는 중인 영역 인덱스 (null이면 아무도 안 그리는 중)
    let brushSize = 28;

    // innerHTML을 매번 통째로 새로 그리기 때문에, 스케치/기초 이미지도 매번 같이 다시 넣어줘야 안 사라짐
    const sketch = job.regionalLayout.baseImage || job.regionalLayout.sketchImage; // 기초 이미지가 있으면 그게 우선
    const canvasRectNow = canvas.getBoundingClientRect();
    const cssW = canvasRectNow.width || canvas.clientWidth;
    const cssH = canvasRectNow.height || canvas.clientHeight;
    const sketchImgHtml = sketch
        ? `<img id="regional-sketch-img" src="/view?filename=${encodeURIComponent(sketch.filename)}&type=${encodeURIComponent(sketch.type)}&subfolder=${encodeURIComponent(sketch.subfolder)}"
             style="position:absolute; inset:0; width:${cssW}px; height:${cssH}px; z-index:0; pointer-events:none; user-select:none; background:#300;"
             onerror="this.style.background='#500'; this.insertAdjacentHTML('afterend', '<div style=&quot;position:absolute;inset:0;z-index:0;color:#f88;font-size:11px;padding:6px;overflow:auto;&quot;>이미지 로드 실패: '+this.src+'</div>');">`
        : '';

    function draw() {
        if (paintingIdx !== null) { drawPaintMode(); return; }

        // ── 왼쪽 사이드바: 캐릭터별 이름표 + ✏️ 붓 버튼 (이미지 위에서 빼서 여기로) ──
        const sidebar = document.getElementById('regional-layout-sidebar');
        if (sidebar) {
            sidebar.innerHTML = boxes.map((box, i) => {
                const color = colors[i % colors.length];
                const shortText = (prompts[i] || '').slice(0, 20);
                return `<div style="display:flex; align-items:center; gap:5px; background:#1a1a1a; border:1px solid ${color}66; border-radius:5px; padding:4px 6px;">
                    <span style="width:8px; height:8px; border-radius:50%; background:${color}; flex-shrink:0;"></span>
                    <span style="font-size:0.68em; color:${color}; flex:1; word-break:break-all; line-height:1.3;">${i + 1}. ${shortText}${prompts[i] && prompts[i].length > 20 ? '…' : ''}</span>
                    <button data-idx="${i}" class="regional-sidebar-paint-btn" style="font-size:0.7em; background:#222; color:${color}; border:1px solid ${color}; border-radius:4px; padding:2px 5px; cursor:pointer; flex-shrink:0;" title="붓으로 직접 그리기">✏️</button>
                </div>`;
            }).join('');
            sidebar.querySelectorAll('.regional-sidebar-paint-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    paintingIdx = parseInt(btn.dataset.idx, 10);
                    draw();
                });
            });
        }

        const parts = [];
        boxes.forEach((box, i) => {
            const color = colors[i % colors.length];

            if (box.freeform && box.maskDataUrl) {
                // 자유 그리기로 만들어진 영역: 저장된 마스크 이미지를 그대로 오버레이로 보여줌 (편집은 사이드바 ✏️로)
                parts.push(`<div class="regional-box" data-idx="${i}" style="position:absolute; inset:0; pointer-events:none;">
                    <img src="${box.maskDataUrl}" style="position:absolute; inset:0; width:100%; height:100%; opacity:0.45; mix-blend-mode:screen; filter:hue-rotate(${i * 60}deg);">
                    <span style="position:absolute; left:${(box.x || 0.02) * 100}%; top:${(box.y || 0.02) * 100}%;
                        font-size:0.68em; background:${color}; color:#111; border-radius:4px; padding:1px 5px; z-index:${30 + i};">${i + 1}</span>
                </div>`);
            } else {
                parts.push(`<div class="regional-box" data-idx="${i}" style="position:absolute;
                    left:${(box.x * 100).toFixed(2)}%; top:${(box.y * 100).toFixed(2)}%;
                    width:${(box.w * 100).toFixed(2)}%; height:${(box.h * 100).toFixed(2)}%;
                    background:${color}22; border:2px solid ${color}; box-sizing:border-box; cursor:move; z-index:${5 + i};">
                    <span style="position:absolute; left:3px; top:2px; font-size:0.72em; color:${color}; font-weight:bold; pointer-events:none; text-shadow:0 0 3px #000;">${i + 1}</span>
                    <div class="regional-resize-handle" data-idx="${i}" style="position:absolute; right:-5px; bottom:-5px; width:14px; height:14px;
                        background:${color}; border:1px solid #fff; border-radius:3px; cursor:nwse-resize; z-index:${20 + i};"></div>
                </div>`);
            }
        });
        canvas.innerHTML = sketchImgHtml + parts.join('');

        // ✏️ 붓 모드 진입은 이제 사이드바 버튼에서 처리 (위 sidebar.querySelectorAll 부분)

        // 박스 이동 (박스 본체 드래그, 리사이즈는 별도 처리하므로 여기선 제외)
        canvas.querySelectorAll('.regional-box').forEach(el => {
            el.addEventListener('mousedown', (e) => {
                if (e.target.classList.contains('regional-resize-handle')) return;
                e.preventDefault();
                const idx = parseInt(el.dataset.idx, 10);
                if (boxes[idx].freeform) return; // 자유그리기 영역은 이동 대신 위치 고정(재그리기로만 수정)
                const rect = canvas.getBoundingClientRect();
                const box = boxes[idx];
                const startX = e.clientX, startY = e.clientY;
                const origX = box.x, origY = box.y;
                const onMove = (moveEvt) => {
                    const dxFrac = (moveEvt.clientX - startX) / rect.width;
                    const dyFrac = (moveEvt.clientY - startY) / rect.height;
                    box.x = Math.max(0, Math.min(1 - box.w, origX + dxFrac));
                    box.y = Math.max(0, Math.min(1 - box.h, origY + dyFrac));
                    draw();
                };
                const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    if (window.appStateManager) window.appStateManager.debounceSave();
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        });

        // 박스 크기 조절 (오른쪽 아래 모서리 핸들)
        canvas.querySelectorAll('.regional-resize-handle').forEach(handle => {
            handle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const idx = parseInt(handle.dataset.idx, 10);
                const rect = canvas.getBoundingClientRect();
                const box = boxes[idx];
                const startX = e.clientX, startY = e.clientY;
                const origW = box.w, origH = box.h;
                const onMove = (moveEvt) => {
                    const dwFrac = (moveEvt.clientX - startX) / rect.width;
                    const dhFrac = (moveEvt.clientY - startY) / rect.height;
                    box.w = Math.max(MIN_SIZE, Math.min(1 - box.x, origW + dwFrac));
                    box.h = Math.max(MIN_SIZE, Math.min(1 - box.y, origH + dhFrac));
                    draw();
                };
                const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    if (window.appStateManager) window.appStateManager.debounceSave();
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        });
    }

    function drawPaintMode() {
        const i = paintingIdx;
        const color = colors[i % colors.length]; // 라벨 표시용 색상 (마스크에는 안 씀)
        // 실제 마스크는 항상 순백색으로 그린다. ImageToMask가 "red" 채널만 읽기 때문에,
        // 캐릭터별 색(보라/파랑/하늘색 등)으로 칠하면 R값이 낮아서 마스크가 약하거나 아예 0이 되어버림
        // (예: #00BCD4는 R=0이라 아무리 칠해도 마스크가 전혀 안 먹힘 → 그 부분이 미생성 상태로 남아
        //  보라색 얼룩으로 출력되는 원인이었음). 흰색(R=255,G=255,B=255)으로 고정해서 항상 마스크 100%.
        const maskColor = '#ffffff';
        const rect = canvas.getBoundingClientRect();
        const cw = Math.round(rect.width) || canvas.clientWidth;
        const ch = Math.round(rect.height) || canvas.clientHeight;

        canvas.innerHTML = sketchImgHtml + `
            <canvas id="regional-paint-surface" width="${cw}" height="${ch}" style="position:absolute; inset:0; z-index:1; cursor:crosshair; opacity:0.7;"></canvas>
            <div style="position:absolute; left:4px; top:4px; right:4px; background:#000c; border-radius:4px; padding:5px 8px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; z-index:50; pointer-events:none;">
                <span style="font-size:0.75em; color:${color}; font-weight:bold; pointer-events:auto;">✏️ ${i + 1}. ${(prompts[i] || '').slice(0, 18)}</span>
                <label style="font-size:0.7em; color:#ccc; display:flex; align-items:center; gap:4px; pointer-events:auto;">붓 크기
                    <input type="range" id="regional-brush-size" min="6" max="80" value="${brushSize}" style="width:70px;">
                </label>
                <button id="regional-paint-clear" class="btn-secondary" style="font-size:0.7em; padding:2px 6px; pointer-events:auto;">지우기</button>
                <button id="regional-paint-tobox" class="btn-secondary" style="font-size:0.7em; padding:2px 6px; pointer-events:auto;">□ 박스로 전환</button>
                <button id="regional-paint-done" class="btn-primary" style="font-size:0.7em; padding:2px 8px; margin-left:auto; pointer-events:auto;">✔ 완료</button>
            </div>`;
        // ↑ 툴바 바탕은 pointer-events:none으로 뚫어놔서, 버튼/입력칸이 없는 빈 공간은
        //   마우스 이벤트가 캔버스로 그대로 통과해 붓칠 가능. 버튼/입력칸만 auto로 살려둠.

        const surface = document.getElementById('regional-paint-surface');
        const ctx = surface.getContext('2d');
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = maskColor;
        ctx.fillStyle = maskColor;

        // 기존에 그려둔 마스크가 있으면 이어서 편집할 수 있게 미리 불러옴
        const box = boxes[i];
        if (box.freeform && box.maskDataUrl) {
            const img = new Image();
            img.onload = () => ctx.drawImage(img, 0, 0, cw, ch);
            img.src = box.maskDataUrl;
        }

        let isDrawing = false;
        const paintAt = (x, y) => {
            ctx.beginPath();
            ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
            ctx.fill();
        };
        surface.addEventListener('mousedown', (e) => {
            isDrawing = true;
            const r = surface.getBoundingClientRect();
            paintAt(e.clientX - r.left, e.clientY - r.top);
        });
        surface.addEventListener('mousemove', (e) => {
            if (!isDrawing) return;
            const r = surface.getBoundingClientRect();
            const x = e.clientX - r.left, y = e.clientY - r.top;
            ctx.beginPath();
            ctx.lineWidth = brushSize;
            ctx.strokeStyle = maskColor;
            ctx.moveTo(x - 1, y - 1);
            ctx.lineTo(x, y);
            ctx.stroke();
            paintAt(x, y);
        });
        document.addEventListener('mouseup', () => { isDrawing = false; });

        document.getElementById('regional-brush-size').addEventListener('input', (e) => {
            brushSize = parseInt(e.target.value, 10);
        });
        document.getElementById('regional-paint-clear').addEventListener('click', () => {
            ctx.clearRect(0, 0, cw, ch);
        });
        document.getElementById('regional-paint-tobox').addEventListener('click', () => {
            box.freeform = false;
            delete box.maskDataUrl;
            if (typeof box.x !== 'number') Object.assign(box, makeEqualBoxes(boxes.length)[i]);
            paintingIdx = null;
            draw();
            if (window.appStateManager) window.appStateManager.debounceSave();
        });
        document.getElementById('regional-paint-done').addEventListener('click', () => {
            box.freeform = true;
            box.maskDataUrl = surface.toDataURL('image/png');
            // 라벨 버튼 위치용으로 대략적인 x,y는 남겨둠 (그려진 영역의 실제 형태와는 무관, 표시 위치 참고용)
            paintingIdx = null;
            draw();
            if (window.appStateManager) window.appStateManager.debounceSave();
        });
    }

    draw();
}
window.renderRegionalLayoutCanvas = renderRegionalLayoutCanvas;

/** 대기열 job의 프롬프트를 편집하는 모달 열기.
 *  sourceRefs가 있으면 조각별로 textarea를 분리해서 보여준다.
 *  (한 조각 안에 쉼표가 여러 개 들어있어도 안전하게 1:1 매칭되도록)
 */
/** 대기열 항목 본문(프롬프트 텍스트/여백 등, 조각 이름 라벨 제외)을 클릭했을 때 어떤 편집 모달을 열지 결정.
 *  - 이 대기열 항목이 라이브러리 조각 정확히 1개에서만 온 경우: 그 조각의 편집 모달을 바로 연다
 *    (조각 이름 라벨을 직접 클릭한 것과 동일하게 동작 — 사용자가 "이름 말고 텍스트/여백을 눌러도 조각 편집이 열리길" 원함)
 *  - 조각이 여러 개 합쳐진 항목(리저널 등)이거나 조각을 못 찾는 경우: 어느 조각을 열지 알 수 없으므로
 *    기존처럼 대기열 항목 편집(여러 조각을 한번에 보는 화면)을 연다 */
function handleQueueItemBodyClick(jobIndex) {
    const job = jobQueue[jobIndex];
    const refs = job ? (job.sourceRefs || []) : [];
    const allCats = (typeof getAllCategories === 'function') ? getAllCategories() : [];

    const resolved = refs
        .map((ref, fragIdx) => {
            const cat = allCats.find(c => c.id === ref.catId);
            if (!cat) return null;
            const item = cat.items.find(it => it.id === ref.itemId);
            return item ? { catId: cat.id, itemId: item.id, fragIdx } : null;
        })
        .filter(Boolean);

    if (resolved.length === 1) {
        navigateToSourceRef(resolved[0].catId, resolved[0].itemId, jobIndex, resolved[0].fragIdx);
        return;
    }

    openJobEditModal(jobIndex);
}

function openJobEditModal(index) {
    const job = jobQueue[index];
    if (!job) return;

    // 기존 모달 제거
    const existing = document.getElementById('job-edit-modal');
    if (existing) existing.remove();

    const hasRefs = Array.isArray(job.sourceRefs) && job.sourceRefs.length === job.fullPrompt.length;
    const labelNames = Object.values(job.labels || {});

    let bodyHtml;
    if (hasRefs) {
        bodyHtml = job.fullPrompt.map((p, i) => {
            const ref = job.sourceRefs[i];
            const allCats = (typeof getAllCategories === 'function') ? getAllCategories() : [];
            const cat = allCats.find(c => c.id === ref.catId);
            const item = cat && cat.items.find(it => it.id === ref.itemId);
            const hasVariants = item && item.variants && item.variants.length > 1;
            const vIdx = hasVariants ? (ref.variantIndex !== undefined ? ref.variantIndex : (item.activeVariant || 0)) : 0;
            const switcher = hasVariants ? `
                <span onclick="event.stopPropagation();" style="display:inline-flex; align-items:center; gap:1px; margin-left:6px; vertical-align:middle;">
                    <button type="button" onclick="switchVariantInJobModal(${index}, ${i}, -1);" title="이전 버전"
                        style="font-size:0.75em; padding:0 5px; background:#333; border:1px solid #FF9800; color:#FF9800; border-radius:4px 0 0 4px; cursor:pointer;">◀</button>
                    <span style="font-size:0.75em; padding:0 5px; background:#333; border-top:1px solid #FF9800; border-bottom:1px solid #FF9800; color:#FF9800;">${vIdx + 1}/${item.variants.length}</span>
                    <button type="button" onclick="switchVariantInJobModal(${index}, ${i}, 1);" title="다음 버전"
                        style="font-size:0.75em; padding:0 5px; background:#333; border:1px solid #FF9800; color:#FF9800; border-radius:0 4px 4px 0; cursor:pointer;">▶</button>
                </span>` : '';
            const vCountBadge = hasVariants ? `<span style="color:#FF9800; margin-left:6px;">🔁 ${item.variants.length}개 버전${switcher}</span>` : '';
            return `
            <div style="margin-bottom:12px;">
                <label style="font-size:0.8em;color:#8bc34a;margin-bottom:4px;display:block;">${labelNames[i] || ('조각 ' + (i + 1))} <span style="color:#666;">(원본 조각도 같이 수정됨)</span>${vCountBadge}</label>
                <textarea class="job-edit-frag" data-idx="${i}" rows="3" style="width:100%;box-sizing:border-box;background:#111;color:#fff;border:1px solid #444;border-radius:6px;padding:8px;font-size:0.85em;resize:vertical;">${p}</textarea>
                <div style="display:flex; gap:6px; margin-top:4px;">
                    <button type="button" onclick="addVariantFromQueue(${index}, ${i})" title="지금 이 칸에 있는 내용을 새 버전으로 추가 저장"
                        style="padding:3px 8px; font-size:0.78em; border-radius:4px; background:#333; border:1px solid #4CAF50; color:#4CAF50; cursor:pointer;">➕ 버전 추가</button>
                    ${hasVariants ? `<button type="button" onclick="deleteVariantFromQueue(${index}, ${i})" title="지금 표시된 버전을 원본에서 삭제"
                        style="padding:3px 8px; font-size:0.78em; border-radius:4px; background:#333; border:1px solid #e74c3c; color:#e74c3c; cursor:pointer;">🗑 버전 삭제</button>` : ''}
                </div>
            </div>
        `;
        }).join('');
    } else {
        bodyHtml = `
            <label style="font-size:0.85em;color:#ccc;margin-bottom:6px;display:block;">프롬프트 조각 (쉼표로 구분, 대기열 항목만 수정됨)</label>
            <textarea id="job-edit-prompt" rows="6" style="width:100%;box-sizing:border-box;background:#111;color:#fff;border:1px solid #444;border-radius:6px;padding:10px;font-size:0.9em;resize:vertical;">${job.fullPrompt.join(', ')}</textarea>
        `;
    }

    const modal = document.createElement('div');
    modal.id = 'job-edit-modal';
    modal.dataset.jobIndex = index;
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
        <div style="background:#2a2a2a;border:1px solid #555;border-radius:10px;padding:24px;width:520px;max-width:90vw;max-height:80vh;overflow-y:auto;display:flex;flex-direction:column;gap:16px;" onclick="event.stopPropagation()">
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <h3 style="margin:0;color:#4CAF50;">✏️ 대기열 항목 편집 (${index + 1}번)</h3>
                <div style="display:flex; align-items:center; gap:8px;">
                    <span style="display:inline-flex; gap:2px;">
                        <button type="button" onclick="navigateJobEditModal(${index}, -1)" title="이전 대기열 항목 (Alt+↑)"
                            style="font-size:0.85em; padding:3px 8px; background:#333; border:1px solid #FF9800; color:#FF9800; border-radius:4px 0 0 4px; cursor:pointer;">◀</button>
                        <button type="button" onclick="navigateJobEditModal(${index}, 1)" title="다음 대기열 항목 (Alt+↓)"
                            style="font-size:0.85em; padding:3px 8px; background:#333; border:1px solid #FF9800; color:#FF9800; border-radius:0 4px 4px 0; cursor:pointer;">▶</button>
                    </span>
                    <span onclick="closeJobEditModal()" style="cursor:pointer;font-size:1.4em;color:#ff5555;">×</span>
                </div>
            </div>
            <div style="font-size:0.85em;color:#aaa;">${Object.entries(job.labels).map(([k,v])=>`<b>${k}:</b> ${v}`).join(' | ')}</div>
            <div>${bodyHtml}</div>
            <div style="display:flex;gap:10px;justify-content:flex-end;">
                <button onclick="closeJobEditModal()" style="padding:8px 18px;background:#444;border:none;border-radius:6px;color:#fff;cursor:pointer;">취소</button>
                <button onclick="saveJobEdit(${index})" style="padding:8px 18px;background:#4CAF50;border:none;border-radius:6px;color:#fff;cursor:pointer;font-weight:bold;">저장</button>
            </div>
        </div>
    `;
    modal.addEventListener('click', () => closeJobEditModal());
    document.body.appendChild(modal);

    // 모달이 열리면 첫 번째 textarea에 바로 포커스 + 전체 선택
    // (포커스가 없으면 Ctrl+A가 페이지 전체를 선택해버림)
    const firstTextarea = modal.querySelector('textarea');
    if (firstTextarea) {
        requestAnimationFrame(() => {
            firstTextarea.focus();
            firstTextarea.select();
        });
    }
}

/** 대기열 편집 모달 닫기 — X/취소/배경클릭 모두 저장 버튼과 동일하게 처리 */
function closeJobEditModal() {
    // jobQueue 인덱스를 모달에서 읽어서 saveJobEdit 호출
    const modal = document.getElementById('job-edit-modal');
    if (!modal) return;
    const indexAttr = modal.dataset.jobIndex;
    if (indexAttr !== undefined) {
        saveJobEdit(parseInt(indexAttr));
    } else {
        modal.remove();
        if (window.appStateManager) window.appStateManager.debounceSave();
    }
}

/** 대기열 job 편집 저장 — 조각별 textarea가 있으면 그대로 1:1 반영, 없으면 기존(쉼표 split) 방식 */
function saveJobEdit(index) {
    const job = jobQueue[index];
    if (!job) return;

    const fragEls = document.querySelectorAll('#job-edit-modal .job-edit-frag');
    let newPrompts;
    let useRefs = false;

    if (fragEls.length > 0) {
        // 조각별 textarea 모드: 쉼표 개수와 무관하게 textarea 1개 = 조각 1개로 그대로 매칭
        newPrompts = Array.from(fragEls)
            .sort((a, b) => parseInt(a.dataset.idx) - parseInt(b.dataset.idx))
            .map(el => el.value);
        useRefs = Array.isArray(job.sourceRefs) && job.sourceRefs.length === newPrompts.length;
    } else {
        const textarea = document.getElementById('job-edit-prompt');
        if (!textarea) return;
        newPrompts = textarea.value.split(',').map(s => s.trim()).filter(Boolean);
        useRefs = Array.isArray(job.sourceRefs) && job.sourceRefs.length === newPrompts.length;
    }

    job.fullPrompt = newPrompts;

    let updatedOriginals = 0;
    if (useRefs && typeof getAllCategories === 'function') {
        const allCats = getAllCategories();
        job.sourceRefs.forEach((ref, i) => {
            const cat = allCats.find(c => c.id === ref.catId);
            const item = cat && cat.items.find(it => it.id === ref.itemId);
            if (item) {
                if (ref.variantIndex !== undefined && item.variants && item.variants[ref.variantIndex]) {
                    item.variants[ref.variantIndex].prompt = newPrompts[i];
                    if (ref.variantIndex === (item.activeVariant || 0)) item.prompt = newPrompts[i];
                } else if (!item.variants) {
                    item.prompt = newPrompts[i];
                }
                updatedOriginals++;
                if (typeof updateItemPromptDisplay === 'function') updateItemPromptDisplay(ref.itemId, item.prompt);
            }
        });
        if (updatedOriginals > 0 && typeof debounceLibrarySave === 'function') debounceLibrarySave();
    }

    document.getElementById('job-edit-modal')?.remove();
    renderJobQueue();
    if (window.appStateManager) window.appStateManager.debounceSave();

}

/** 🆕 대기열 편집 모달을 열어둔 채로 이전/다음 항목으로 바로 이동한다.
 *  (지금 항목의 편집 내용은 saveJobEdit로 먼저 저장한 뒤 다음 모달을 연다 — 데이터 유실 없음)
 *  direction: -1(이전) 또는 1(다음). 범위를 벗어나면 아무 것도 안 함(맨 끝/맨 앞이라는 뜻).
 *  비활성화(disabled)된 항목은 건너뛰고 그 다음/이전 "활성" 항목으로 이동한다.
 */
function navigateJobEditModal(currentIndex, direction) {
    let target = currentIndex + direction;
    while (target >= 0 && target < jobQueue.length && jobQueue[target].disabled) {
        target += direction;
    }
    if (target < 0 || target >= jobQueue.length) return; // 맨 앞/맨 뒤에 도달 — 더 이동할 곳 없음
    saveJobEdit(currentIndex);
    // 🔧 다음/이전 항목이 조각 1개짜리면 그 조각 편집 모달을, 여러 개 조합이면 이 모달을 다시 —
    // handleQueueItemBodyClick이 그 판단을 이미 하고 있어서 그대로 재사용 (일관성 유지)
    if (typeof handleQueueItemBodyClick === 'function') {
        handleQueueItemBodyClick(target);
    } else {
        openJobEditModal(target);
    }
}

/** 🆕 대기열 편집 모달이 열려있는 동안 커스텀 단축키(기본: Alt+↑ 이전 / Alt+↓ 다음)로 이동.
 *  ⌨️ 단축키 도움말 모달에서 다른 키 조합으로 바꿀 수 있음 (SHORTCUT_DEFS: queuePrevItem/queueNextItem — library.js).
 *  job-edit-modal(조각 여러 개 조합 항목)과 prompt-edit-modal(조각 1개짜리 항목, 대기열에서 열린 경우)
 *  둘 다에서 작동한다. */
document.addEventListener('keydown', (e) => {
    if (typeof matchesShortcutCombo !== 'function') return;
    const isPrev = matchesShortcutCombo(e, 'queuePrevItem');
    const isNext = matchesShortcutCombo(e, 'queueNextItem');
    if (!isPrev && !isNext) return;
    const direction = isPrev ? -1 : 1;

    // 1) 대기열 전용 편집 모달(여러 조각 조합)이 열려있는 경우
    const jobModal = document.getElementById('job-edit-modal');
    if (jobModal) {
        const index = parseInt(jobModal.dataset.jobIndex, 10);
        if (isNaN(index)) return;
        e.preventDefault();
        navigateJobEditModal(index, direction);
        return;
    }

    // 2) 조각 1개짜리 항목이 대기열에서 열린 경우 (prompt-edit-modal + activeQueueSyncTarget)
    const promptModal = document.getElementById('prompt-edit-modal');
    const isPromptModalOpen = promptModal && promptModal.style.display !== 'none' && promptModal.style.display !== '';
    if (isPromptModalOpen && typeof activeQueueSyncTarget !== 'undefined' && activeQueueSyncTarget &&
        typeof navigateQueueEditorFromPromptModal === 'function') {
        e.preventDefault();
        navigateQueueEditorFromPromptModal(direction);
    }
});

/** 대기열 전체 비우기 (확인 팝업 포함) */
function clearJobQueue() {
    if (jobQueue.length === 0) return;
    jobQueue = [];
    renderJobQueue();
    if (window.appStateManager) window.appStateManager.debounceSave();
}

/** 대기열 항목의 반복 횟수 변경 */
function updateJobRepeat(index, val) {
    jobQueue[index].repeatCount = parseInt(val);
    if (window.appStateManager) window.appStateManager.debounceSave();
}

/** 대기열에서 특정 항목 제거 */
function removeJob(index) {
    jobQueue.splice(index, 1);
    renderJobQueue();
    if (window.appStateManager) window.appStateManager.debounceSave();
}

/* ──────────────────────────────────────────────
   생성 모드 전환 (단일/배치) UI
   ────────────────────────────────────────────── */

/** 라디오 버튼에 따라 단일 모드 영역과 배치 모드 영역의 표시를 전환 */
function toggleGenMode() {
    const isBatch = document.getElementById('mode-batch').checked;
    document.getElementById('single-mode-area').style.display = isBatch ? 'none' : 'block';
    document.getElementById('batch-mode-area').style.display = isBatch ? 'block' : 'none';
}

/* ──────────────────────────────────────────────
   다시 뽑기 (히스토리 이미지 재생성 — Ctrl+우클릭)
   "이 설정으로 생성"(메타데이터 → 현재 UI에 덮어쓰기)과는 완전히 다른 기능이다.
   여기서는 현재 화면(Generate 탭)의 입력값을 절대 건드리지 않고,
   그 이미지를 만들 때 저장해둔 스냅샷(regenSnapshot)을 별도의 팝업 안에서만
   자유롭게 수정한 뒤, 그 팝업 안의 값으로만 다시 생성 요청을 보낸다.
   (Img2Img/컨트롤넷/인페인팅/업스케일/디테일러/검열 등 고급 파이프라인은
   이미지별로 저장해두지 않으므로 재현 대상에서 제외 — 기본 생성 파라미터만 재현)
   ────────────────────────────────────────────── */

window.generationSettingsByPromptId = window.generationSettingsByPromptId || {};

/** 팝업을 처음 열 때 한 번만 모달 DOM을 만들어둔다 */
function ensureRegenModal() {
    if (document.getElementById('regen-modal')) return;

    const overlay = document.createElement('div');
    overlay.id = 'regen-modal';
    overlay.style.cssText = 'display:none; position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:1000; align-items:center; justify-content:center;';
    overlay.onclick = (e) => { if (e.target === overlay) closeRegenModal(); };

    overlay.innerHTML = `
        <div style="background:#1e1e1e; border:1px solid #444; border-radius:10px; width:min(560px, 92vw); max-height:88vh; overflow-y:auto; padding:20px; box-sizing:border-box;" onclick="event.stopPropagation()">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <h3 style="margin:0; color:#4CAF50;">다시 뽑기</h3>
                <span style="cursor:pointer; color:#888; font-size:1.3em; line-height:1;" onclick="closeRegenModal()">&times;</span>
            </div>
            <p style="margin:4px 0 16px; font-size:0.82em; color:#888;">이 이미지를 만들 때 쓰인 값입니다. 여기서 자유롭게 바꿔도 현재 화면(Generate 탭)의 설정에는 전혀 영향을 주지 않습니다.</p>

            <div style="display:flex; flex-direction:column; gap:12px;">
                <div>
                    <label style="font-size:0.85em; color:#aaa;">Positive 프롬프트</label>
                    <textarea id="regen-pos" rows="3" style="width:100%; box-sizing:border-box; background:#111; border:1px solid #333; color:#fff; border-radius:6px; padding:6px; resize:vertical;"></textarea>
                </div>
                <div>
                    <label style="font-size:0.85em; color:#aaa;">Negative 프롬프트</label>
                    <textarea id="regen-neg" rows="2" style="width:100%; box-sizing:border-box; background:#111; border:1px solid #333; color:#fff; border-radius:6px; padding:6px; resize:vertical;"></textarea>
                </div>

                <div id="regen-model-fields" style="display:flex; flex-direction:column; gap:8px; background:#181818; border:1px solid #333; border-radius:8px; padding:10px;">
                    <!-- 아키텍처(sdxl/anima/sd3)에 맞는 모델 선택 필드가 여기 동적으로 채워짐 -->
                </div>

                <div style="display:flex; gap:10px; flex-wrap:wrap;">
                    <div style="flex:1; min-width:100px;">
                        <label style="font-size:0.85em; color:#aaa;">Steps</label>
                        <input type="number" id="regen-steps" min="1" max="150" style="width:100%; box-sizing:border-box; background:#111; border:1px solid #333; color:#fff; border-radius:6px; padding:6px;">
                    </div>
                    <div style="flex:1; min-width:100px;">
                        <label style="font-size:0.85em; color:#aaa;">CFG</label>
                        <input type="number" id="regen-cfg" step="0.1" min="0" max="30" style="width:100%; box-sizing:border-box; background:#111; border:1px solid #333; color:#fff; border-radius:6px; padding:6px;">
                    </div>
                </div>

                <div style="display:flex; gap:10px; flex-wrap:wrap;">
                    <div style="flex:1; min-width:140px;">
                        <label style="font-size:0.85em; color:#aaa;">샘플러</label>
                        <select id="regen-sampler" style="width:100%; box-sizing:border-box; background:#111; border:1px solid #333; color:#fff; border-radius:6px; padding:6px;"></select>
                    </div>
                    <div style="flex:1; min-width:140px;">
                        <label style="font-size:0.85em; color:#aaa;">스케줄러</label>
                        <select id="regen-scheduler" style="width:100%; box-sizing:border-box; background:#111; border:1px solid #333; color:#fff; border-radius:6px; padding:6px;"></select>
                    </div>
                </div>

                <div>
                    <label style="font-size:0.85em; color:#aaa;">해상도</label>
                    <select id="regen-dimensions" style="width:100%; box-sizing:border-box; background:#111; border:1px solid #333; color:#fff; border-radius:6px; padding:6px;"></select>
                </div>

                <div style="display:flex; gap:10px; align-items:flex-end;">
                    <div style="flex:1;">
                        <label style="font-size:0.85em; color:#aaa;">시드</label>
                        <input type="number" id="regen-seed" style="width:100%; box-sizing:border-box; background:#111; border:1px solid #333; color:#fff; border-radius:6px; padding:6px;">
                    </div>
                    <label style="display:flex; align-items:center; gap:5px; font-size:0.85em; color:#ccc; padding-bottom:8px; cursor:pointer;">
                        <input type="checkbox" id="regen-seed-random"> 랜덤
                    </label>
                </div>

                <div id="regen-status" style="font-size:0.85em; color:#888; min-height:1.2em;"></div>

                <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:6px;">
                    <button type="button" class="btn-secondary" onclick="closeRegenModal()">닫기</button>
                    <button type="button" class="btn-primary" id="regen-submit-btn" onclick="submitRegen()">이 값으로 다시 생성</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('regen-seed-random').onchange = function () {
        document.getElementById('regen-seed').disabled = this.checked;
    };
}

/** <select id="source">의 옵션 목록을 그대로 복제해서 모달 select에 채워넣고, value로 선택해준다 */
function cloneSelectOptions(sourceId, targetSelect, valueToSelect) {
    const source = document.getElementById(sourceId);
    targetSelect.innerHTML = '';
    if (source) {
        Array.from(source.options).forEach(opt => {
            targetSelect.appendChild(new Option(opt.text, opt.value));
        });
    }
    if (valueToSelect !== undefined && valueToSelect !== '') {
        if (![...targetSelect.options].some(o => o.value === valueToSelect)) {
            targetSelect.appendChild(new Option(valueToSelect, valueToSelect));
        }
        targetSelect.value = valueToSelect;
    }
}

/** 스냅샷의 architecture 값에 맞는 모델 선택 필드(체크포인트/Unet/Clip/VAE 등)를 동적으로 그려준다 */
function renderRegenModelFields(snap) {
    const box = document.getElementById('regen-model-fields');
    box.innerHTML = '';

    const addField = (labelText, id, sourceSelectId, value) => {
        const wrap = document.createElement('div');
        const label = document.createElement('label');
        label.style.cssText = 'font-size:0.85em; color:#aaa;';
        label.textContent = labelText;
        const select = document.createElement('select');
        select.id = id;
        select.style.cssText = 'width:100%; box-sizing:border-box; background:#111; border:1px solid #333; color:#fff; border-radius:6px; padding:6px; margin-top:2px;';
        wrap.appendChild(label);
        wrap.appendChild(select);
        box.appendChild(wrap);
        cloneSelectOptions(sourceSelectId, select, value);
    };

    if (snap.architecture === 'anima') {
        addField('아니마 Unet', 'regen-unet', 'gen-unet', snap.unet);
        addField('아니마 체크포인트(대체)', 'regen-anima-ckpt', 'gen-anima-ckpt', snap.animaCkpt);
        addField('Clip (Qwen)', 'regen-clip', 'gen-clip', snap.clip);
        addField('VAE', 'regen-vae', 'gen-vae', snap.vae);
    } else if (snap.architecture === 'sd3') {
        addField('SD3 Unet', 'regen-sd3-unet', 'gen-sd3-unet', snap.sd3Unet);
        addField('Clip', 'regen-clip', 'gen-clip', snap.clip);
        addField('VAE', 'regen-vae', 'gen-vae', snap.vae);
    } else {
        addField('체크포인트', 'regen-checkpoint', 'gen-checkpoint', snap.checkpoint);
        addField('Clip (선택)', 'regen-clip', 'gen-clip', snap.clip);
        addField('VAE (선택)', 'regen-vae', 'gen-vae', snap.vae);
    }
}

/** Ctrl+우클릭 → 저장된 스냅샷을 "복사"해서 팝업에 채운다 (원본 스냅샷은 건드리지 않음) */
function openRegenModal(promptId) {
    const original = window.generationSettingsByPromptId && window.generationSettingsByPromptId[promptId];
    if (!original) {
        alert('이 이미지의 생성 당시 설정을 찾을 수 없습니다. (페이지를 새로고침했거나, 이 세션에서 생성된 이미지가 아닐 수 있어요)');
        return;
    }
    // 독립된 복사본 — 팝업에서 뭘 바꾸든 원본 스냅샷과 현재 UI 둘 다 절대 변하지 않는다.
    const snap = JSON.parse(JSON.stringify(original));

    ensureRegenModal();

    document.getElementById('regen-pos').value = snap.posPrompt || '';
    document.getElementById('regen-neg').value = snap.negPrompt || '';
    document.getElementById('regen-steps').value = snap.steps;
    document.getElementById('regen-cfg').value = snap.cfg;
    document.getElementById('regen-seed').value = snap.seed;
    document.getElementById('regen-seed-random').checked = false;
    document.getElementById('regen-seed').disabled = false;

    cloneSelectOptions('adv-sampler', document.getElementById('regen-sampler'), snap.sampler);
    cloneSelectOptions('adv-scheduler', document.getElementById('regen-scheduler'), snap.scheduler);
    cloneSelectOptions('adv-dimensions', document.getElementById('regen-dimensions'), snap.dimensions);
    renderRegenModelFields(snap);

    document.getElementById('regen-status').textContent = '';
    document.getElementById('regen-modal').dataset.architecture = snap.architecture;
    document.getElementById('regen-modal').style.display = 'flex';
}

function closeRegenModal() {
    const modal = document.getElementById('regen-modal');
    if (modal) modal.style.display = 'none';
}

/** 모달 안의 값만 읽어서 새 워크플로우를 만들고 제출한다. 현재 Generate 탭의 어떤 input도 건드리지 않는다. */
async function submitRegen() {
    if (!window.baseWorkflow) {
        alert('Workflow.json 파일이 로드되지 않았습니다. 잠시 후 다시 시도해주세요.');
        return;
    }
    const statusEl = document.getElementById('regen-status');
    const submitBtn = document.getElementById('regen-submit-btn');
    const architecture = document.getElementById('regen-modal').dataset.architecture || 'sdxl';

    const promptData = JSON.parse(JSON.stringify(window.baseWorkflow));

    const ckptId = findNodeIdByTitle(promptData, "[Main] ckpt loader");
    const clipSetLayerId = findNodeIdByTitle(promptData, "[Main] Clip");
    const promptNodeId = findNodeIdByTitle(promptData, "[Main] Text Prompt");
    const ksamplerId = findNodeIdByTitle(promptData, "[Main] KSampler");
    const loraId = findNodeIdByTitle(promptData, "[Main] Lora Loader");
    const positiveT2CId = findNodeIdByTitle(promptData, "[Main] T2C(Positive)");
    const vaeDecodeId = findNodeIdByTitle(promptData, "[Main] VAE decode");
    const stepNodeId = findNodeIdByTitle(promptData, "[Main] Step");
    const cfgNodeId = findNodeIdByTitle(promptData, "[Main] CFG");
    const samplerSchedulerNodeId = findNodeIdByTitle(promptData, "[Main] Sampler, Scheduler");
    const latentNodeId = findNodeIdByTitle(promptData, "[Main] Latent Image");

    const clipValue = document.getElementById('regen-clip')?.value || '';
    const vaeValue = document.getElementById('regen-vae')?.value || '';

    if (architecture === 'anima') {
        const unetName = document.getElementById('regen-unet')?.value;
        const animaCkptName = document.getElementById('regen-anima-ckpt')?.value;
        if (!unetName && !animaCkptName) {
            alert('아니마 Unet 또는 체크포인트 중 하나는 선택해야 합니다.');
            return;
        }
        if (unetName) {
            promptData["unet_custom_001"] = { inputs: { unet_name: unetName, weight_dtype: "default" }, class_type: "UNETLoader", _meta: { title: "[Anima] Unet Loader (Regen)" } };
        } else {
            promptData["unet_custom_001"] = { inputs: { ckpt_name: animaCkptName }, class_type: "CheckpointLoaderSimple", _meta: { title: "[Anima] Checkpoint Loader (Regen)" } };
        }
        promptData["clip_custom_001"] = { inputs: { clip_name: clipValue, type: "qwen_image", device: "default" }, class_type: "CLIPLoader", _meta: { title: "[Anima] Clip Loader (Regen)" } };
        promptData["vae_custom_001"] = { inputs: { vae_name: vaeValue }, class_type: "VAELoader", _meta: { title: "[Anima] VAE Loader (Regen)" } };
        if (loraId && promptData[loraId]?.inputs) {
            promptData[loraId].inputs.model = ["unet_custom_001", 0];
            promptData[loraId].inputs.clip = ["clip_custom_001", 0];
        }
        if (positiveT2CId && promptData[positiveT2CId]?.inputs && "clip" in promptData[positiveT2CId].inputs) {
            promptData[positiveT2CId].inputs.clip = ["clip_custom_001", 0];
        }
        if (vaeDecodeId && promptData[vaeDecodeId]?.inputs && "vae" in promptData[vaeDecodeId].inputs) {
            promptData[vaeDecodeId].inputs.vae = ["vae_custom_001", 0];
        }
        /* 🐛 수정: 메인 생성 함수와 동일하게, 업스케일/디테일러 4개도 여기서 VAE를 교체해야
           함. 이전엔 vaeDecodeId(99)만 바뀌고 나머지는 87번 VAE를 그대로 참조하고 있었음. */
        ["106", "108", "115", "128", "134", "140"].forEach(nodeId => {
            if (promptData[nodeId]?.inputs && "vae" in promptData[nodeId].inputs) {
                promptData[nodeId].inputs.vae = ["vae_custom_001", 0];
            }
        });
        if (ksamplerId && promptData[ksamplerId]?.inputs) {
            const dim = getResolutionFromDimensionsString(document.getElementById('regen-dimensions')?.value);
            promptData["latent_custom_001"] = {
                inputs: { width: dim.width, height: dim.height, batch_size: 1 },
                class_type: "EmptyLatentImage",
                _meta: { title: "[Anima] Empty Latent Image (Regen)" }
            };
            promptData[ksamplerId].inputs.latent_image = ["latent_custom_001", 0];
        }
    } else if (architecture === 'sd3') {
        /* 🐛 수정: 이전엔 이 SD3 블록이 anima 블록 안에 그대로 이어져 있어서(else if 누락),
           재생성 모달에서 아니마를 고르면 정의도 안 된 sd3UnetName을 참조해 즉시 에러로
           멈추던 버그였다. 별도 분기로 제대로 분리함. */
        const sd3UnetName = document.getElementById('regen-sd3-unet')?.value;
        if (!sd3UnetName) { alert('SD3 Unet을 선택해야 합니다.'); return; }
        promptData["unet_custom_001"] = { inputs: { unet_name: sd3UnetName, weight_dtype: "default" }, class_type: "UNETLoader", _meta: { title: "[SD3] Unet Loader (Regen)" } };
        if (clipValue) {
            promptData["clip_custom_001"] = { inputs: { clip_name: clipValue, type: "sd3", device: "default" }, class_type: "CLIPLoader", _meta: { title: "[SD3] Clip Loader (Regen)" } };
            if (loraId && promptData[loraId]?.inputs) promptData[loraId].inputs.clip = ["clip_custom_001", 0];
            if (positiveT2CId && promptData[positiveT2CId]?.inputs && "clip" in promptData[positiveT2CId].inputs) promptData[positiveT2CId].inputs.clip = ["clip_custom_001", 0];
        }
        if (vaeValue) {
            promptData["vae_custom_001"] = { inputs: { vae_name: vaeValue }, class_type: "VAELoader", _meta: { title: "[SD3] VAE Loader (Regen)" } };
            if (vaeDecodeId && promptData[vaeDecodeId]?.inputs && "vae" in promptData[vaeDecodeId].inputs) promptData[vaeDecodeId].inputs.vae = ["vae_custom_001", 0];
        }
        if (loraId && promptData[loraId]?.inputs) promptData[loraId].inputs.model = ["unet_custom_001", 0];
    } else {
        const checkpointName = document.getElementById('regen-checkpoint')?.value;
        if (ckptId && checkpointName) promptData[ckptId].inputs.ckpt_name = checkpointName;
        if (vaeValue) {
            promptData["vae_custom_001"] = { inputs: { vae_name: vaeValue }, class_type: "VAELoader", _meta: { title: "[Main] VAE Loader (Regen)" } };
            ["99", "106", "108", "115", "128", "134", "140"].forEach(nodeId => {
                if (promptData[nodeId] && promptData[nodeId].inputs && "vae" in promptData[nodeId].inputs) promptData[nodeId].inputs.vae = ["vae_custom_001", 0];
            });
        }
        if (clipValue) {
            promptData["clip_custom_001"] = { inputs: { clip_name: clipValue, type: "stable_diffusion" }, class_type: "CLIPLoader", _meta: { title: "[Main] CLIP Loader (Regen)" } };
            if (clipSetLayerId && promptData[clipSetLayerId]?.inputs && "clip" in promptData[clipSetLayerId].inputs) promptData[clipSetLayerId].inputs.clip = ["clip_custom_001", 0];
            if (positiveT2CId && promptData[positiveT2CId]?.inputs && "clip" in promptData[positiveT2CId].inputs) promptData[positiveT2CId].inputs.clip = ["clip_custom_001", 0];
        }
    }

    const posPrompt = document.getElementById('regen-pos').value;
    const negPrompt = document.getElementById('regen-neg').value;
    if (promptNodeId) {
        promptData[promptNodeId].inputs.pos = posPrompt;
        promptData[promptNodeId].inputs.neg = negPrompt;
    }

    const steps = parseInt(document.getElementById('regen-steps').value || '28', 10);
    const cfg = parseFloat(document.getElementById('regen-cfg').value || '5');
    const sampler = document.getElementById('regen-sampler').value;
    const scheduler = document.getElementById('regen-scheduler').value;
    const dimensions = document.getElementById('regen-dimensions').value;

    if (stepNodeId) promptData[stepNodeId].inputs.value = steps;
    if (cfgNodeId) promptData[cfgNodeId].inputs.value = cfg;
    if (samplerSchedulerNodeId) {
        promptData[samplerSchedulerNodeId].inputs.sampler_name = sampler;
        promptData[samplerSchedulerNodeId].inputs.scheduler = scheduler;
    }
    if (latentNodeId) promptData[latentNodeId].inputs.dimensions = dimensions;

    const isRandom = document.getElementById('regen-seed-random').checked;
    const userSeed = document.getElementById('regen-seed').value;
    const seedValue = (isRandom || !userSeed) ? Math.floor(Math.random() * 10000000000000000) : parseInt(userSeed, 10);
    if (ksamplerId) promptData[ksamplerId].inputs.seed = seedValue;

    statusEl.textContent = '⏳ 서버에 전송 중...';
    statusEl.style.color = '#FF9800';
    submitBtn.disabled = true;

    try {
        const previewMethod = (architecture === 'anima') ? 'auto' : 'taesd';
        const data = await API.post('/prompt', { prompt: promptData, client_id: window.clientId, extra_data: { preview_method: previewMethod } });
        if (data.prompt_id) {
            // 이 재생성 자체도 다시 뽑기가 가능하도록, 이번에 실제로 쓰인 값으로 스냅샷을 남겨둔다.
            window.generationSettingsByPromptId[data.prompt_id] = {
                architecture,
                checkpoint: document.getElementById('regen-checkpoint')?.value || '',
                unet: document.getElementById('regen-unet')?.value || '',
                animaCkpt: document.getElementById('regen-anima-ckpt')?.value || '',
                sd3Unet: document.getElementById('regen-sd3-unet')?.value || '',
                clip: clipValue, vae: vaeValue,
                posPrompt, negPrompt, steps, cfg, sampler, scheduler, dimensions,
                seed: seedValue
            };
            statusEl.textContent = '대기열에 전송했습니다. 완료되면 히스토리에 나타납니다.';
            statusEl.style.color = '#4CAF50';
        } else {
            statusEl.textContent = '❌ 전송에 실패했습니다.';
            statusEl.style.color = '#ff5555';
        }
    } catch (e) {
        statusEl.textContent = '❌ 서버 통신 오류가 발생했습니다.';
        statusEl.style.color = '#ff5555';
    } finally {
        submitBtn.disabled = false;
    }
}

/* ──────────────────────────────────────────────
   로라 병합 — 지금 화면 상단 공통 로라 목록에 있는 로라들을 하나의 로라 파일로 합쳐서 저장한다.
   ComfyUI 내장 노드만 사용 (ModelSubtract, CLIPSubtract, LoraSave) — 별도 커스텀 노드 설치 불필요.
   원리: "[Main] Lora Loader"가 로라들을 적용하기 직전(model/clip)과 적용한 직후(그 노드의 출력)의
         "차이"를 통째로 계산해서, 그 차이 전체를 로라 파일 하나로 뽑아낸다.
   이미지 생성엔 필요 없는 나머지 노드(KSampler, 프롬프트, 이미지 저장 등)는 전부 제거하고
   병합에 필요한 노드만 남겨서 보낸다 — 그래야 안 채운 값 때문에 그래프 검증에서 400이 안 난다.
   ────────────────────────────────────────────── */
window.submitLoraMergeJob = async function ({ filename, rank, loraType, biasDiff, includeClip }) {
    if (!window.baseWorkflow) {
        throw new Error('Workflow.json 파일이 로드되지 않았습니다.');
    }

    const promptData = JSON.parse(JSON.stringify(window.baseWorkflow));
    const loraId = findNodeIdByTitle(promptData, "[Main] Lora Loader");
    if (!loraId) throw new Error('로라 로더 노드를 찾을 수 없습니다.');

    /* 병합 전용으로 그래프를 새로 만드는 게 아니라 baseWorkflow 템플릿을 그대로 복제해서 쓰다 보니,
       템플릿에 박혀있는 옛날 체크포인트/클립 값이 아니라 지금 화면에서 실제로 고른 값을 반영해줘야 한다.
       (VAE는 이미지 디코딩에만 쓰이고 병합 결과엔 영향이 없으므로 여기선 건드리지 않는다) */
    const architecture = document.getElementById('gen-architecture')?.value || 'sdxl';
    const ckptId = findNodeIdByTitle(promptData, "[Main] ckpt loader");
    const clipSetLayerId = findNodeIdByTitle(promptData, "[Main] Clip");

    if (architecture === 'anima') {
        const unetName = document.getElementById('gen-unet')?.value;
        const animaCkptName = document.getElementById('gen-anima-ckpt')?.value;
        const useCheckpoint = document.getElementById('anima-use-checkpoint')?.checked;

        if (useCheckpoint && animaCkptName) {
            promptData["merge_unet_custom_001"] = { inputs: { ckpt_name: animaCkptName }, class_type: "CheckpointLoaderSimple", _meta: { title: "[Anima] Checkpoint Loader (Merge)" } };
        } else if (unetName) {
            promptData["merge_unet_custom_001"] = { inputs: { unet_name: unetName, weight_dtype: "default" }, class_type: "UNETLoader", _meta: { title: "[Anima] Unet Loader (Merge)" } };
        } else {
            throw new Error('아니마 Unet 또는 체크포인트 중 하나는 선택해야 합니다.');
        }
        const clipName = document.getElementById('gen-clip')?.value;
        if (!clipName) throw new Error('Clip을 선택해야 합니다.');
        promptData["merge_clip_custom_001"] = { inputs: { clip_name: clipName, type: "qwen_image", device: "default" }, class_type: "CLIPLoader", _meta: { title: "[Anima] Clip Loader (Merge)" } };

        promptData[loraId].inputs.model = ["merge_unet_custom_001", 0];
        promptData[loraId].inputs.clip = ["merge_clip_custom_001", 0];
    } else {
        const checkpointName = document.getElementById('gen-checkpoint')?.value;
        if (ckptId && checkpointName) promptData[ckptId].inputs.ckpt_name = checkpointName;

        const clipName = document.getElementById('gen-clip')?.value;
        if (clipName) {
            promptData["merge_clip_custom_001"] = { inputs: { clip_name: clipName, type: "stable_diffusion" }, class_type: "CLIPLoader", _meta: { title: "[Main] CLIP Loader (Merge)" } };
            if (clipSetLayerId && promptData[clipSetLayerId]?.inputs && "clip" in promptData[clipSetLayerId].inputs) {
                promptData[clipSetLayerId].inputs.clip = ["merge_clip_custom_001", 0];
            }
        }
    }

    /* 지금 화면(#selected-loras)에 있는 로라들을 그대로 적용 (평소 생성 때와 동일한 로직) */
    const loraList = Array.from(document.querySelectorAll('#selected-loras .lora-item')).map(item => ({
        lora: item.querySelector('select').value,
        strength: parseFloat(item.querySelector('input[type="number"]').value)
    }));
    if (loraList.length === 0) throw new Error('선택된 로라가 없습니다.');

    delete promptData[loraId].inputs["lora_1"];
    loraList.forEach((entry, index) => {
        promptData[loraId].inputs[`lora_${index + 1}`] = { on: true, lora: entry.lora, strength: entry.strength };
    });

    /* 로라 로더 자신이 원래 받던 "적용 전" model/clip 참조를 그대로 재사용 (커스텀 VAE/Clip/Unet 설정도 그대로 반영됨) */
    const baseModelRef = promptData[loraId].inputs.model;
    const baseClipRef = promptData[loraId].inputs.clip;
    if (!baseModelRef || !baseClipRef) throw new Error('로라 로더의 model/clip 연결을 찾을 수 없습니다.');

    promptData["lora_merge_modelsub_001"] = {
        inputs: { model1: [loraId, 0], model2: baseModelRef, multiplier: 1.0 },
        class_type: "ModelMergeSubtract",
        _meta: { title: "[Merge] Model Diff" }
    };

    /* CLIP(텍스트 인코더) 차이 계산은 선택사항이다 — 일부 레이어에서 SVD가 잘 수렴하지 않으면
       극단적으로 느려질 수 있는데(수십 초~수 분/레이어), 그림체는 대부분 모델(UNet) 쪽 차이가
       만들기 때문에 꺼둬도 스타일 재현에 큰 지장이 없는 경우가 많다. */
    const lorasaveInputs = {
        filename_prefix: `loras/${filename}`,
        rank: isNaN(rank) ? 32 : rank,
        lora_type: loraType || 'standard',
        bias_diff: !!biasDiff,
        model_diff: ["lora_merge_modelsub_001", 0]
    };

    if (includeClip) {
        promptData["lora_merge_clipsub_001"] = {
            inputs: { clip1: [loraId, 1], clip2: baseClipRef, multiplier: 1.0 },
            class_type: "CLIPMergeSubtract",
            _meta: { title: "[Merge] CLIP Diff" }
        };
        lorasaveInputs.text_encoder_diff = ["lora_merge_clipsub_001", 0];
    }

    promptData["lora_merge_lorasave_001"] = {
        inputs: lorasaveInputs,
        class_type: "LoraSave",
        _meta: { title: "[Merge] Save Combined Lora" }
    };

    /* 이 요청엔 이미지 생성이 필요 없으므로, 병합에 실제로 필요한 노드만 남기고
       나머지(KSampler, 프롬프트, 이미지 저장 등)는 전부 지운다.
       ⚠ 로라 로더로 들어가는 model/clip은 체크포인트 로더 하나가 아니라
       ModelSamplingDiscrete, CLIPSetLastLayer 같은 중간 노드를 여러 단계 거칠 수 있으므로,
       "이 노드가 참조하는 다른 노드"를 재귀적으로 전부 따라가면서 필요한 노드를 다 남긴다.
       (한 단계만 보고 남기면, 그 중간 노드가 또 필요로 하는 노드가 지워져서 400 에러가 난다) */
    const keepIds = new Set([loraId, "lora_merge_modelsub_001", "lora_merge_lorasave_001"]);
    if (includeClip) keepIds.add("lora_merge_clipsub_001");
    const queue = [...keepIds];
    while (queue.length > 0) {
        const currentId = queue.shift();
        const node = promptData[currentId];
        if (!node || !node.inputs) continue;
        Object.values(node.inputs).forEach(val => {
            if (Array.isArray(val) && val.length === 2 && (typeof val[0] === 'string' || typeof val[0] === 'number') && typeof val[1] === 'number') {
                const refId = String(val[0]);
                if (!keepIds.has(refId)) {
                    keepIds.add(refId);
                    queue.push(refId);
                }
            }
        });
    }
    Object.keys(promptData).forEach(id => {
        if (!keepIds.has(id)) delete promptData[id];
    });

    const data = await API.post('/prompt', { prompt: promptData, client_id: window.clientId });
    return data;
};
