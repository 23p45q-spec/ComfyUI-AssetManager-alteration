// SPDX-FileCopyrightText: 2026 灰暗x
// SPDX-FileCopyrightText: 2026 ComfyUI-KR-Camera-Control contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 카메라 구도 프롬프트 도구 (공통 긍정프롬프트 옆 "📷 구도" 팝업)
//
// 이 파일은 ComfyUI-KR-Camera-Control 의 camera_control.js 에서 파생(이식)한 것입니다.
//   원본: ComfyUI-KR-Camera-Control (camera_control.js / camera_control.py / README.md)
//         그 원본은 ComfyUI_bsk_UI 의 카메라 프롬프트 알고리즘과 조작 방식에서 파생 — Copyright (c) 2026 灰暗x, AGPL-3.0-or-later
//   수정(이 파일에서 바뀐 점):
//     - "원본 코드 그대로" 구간(아래 상수/가중치 계산/설정 정규화 함수들)은 원본에서 한 글자도 안 바꾸고 옮겼습니다.
//     - ComfyUI 노드에 묶여 있던 화면(app.registerExtension, 위젯, preset_index 입력 잠금)을 걷어내고
//       AssetManager 도구 탭용 독립 화면으로 다시 구성했습니다.
//     - 구도 프롬프트를 공통 긍정프롬프트에 추가/복사하는 기능, 생성할 때 자동으로 붙이는 기능(프리셋 랜덤 포함)을 새로 넣었습니다.
//     - 기본 가중치를 낮췄습니다 (방위/높이/거리 총 가중치 5 → 1.5, 각 태그 가중치 상한 10 → 1.5). 원본 기본값은 기본 구도(정면)만
//       넣어도 (from front:5.00), (medium shot:3.00)처럼 나와서 그림이 깨졌습니다. 계산 알고리즘은 그대로이고 "기본 설정값"만 바뀐 것입니다.
//       가중치가 1.6을 넘으면 화면에 경고와 "안전 가중치로 맞추기" 버튼이 나옵니다.
//     - 도구 탭이 아니라 공통 긍정프롬프트 옆 "📷 구도" 버튼으로 여는 팝업으로 옮겼습니다.
//     - 긍정프롬프트에 든 구도 태그 인식 / 새 구도로 자동 교체 / 태그별·전체 무효화(끄기) / 조각으로 만들기를 새로 넣었습니다.
//   라이선스: 이 파일은 AGPL-3.0-or-later 입니다. 이 파일을 포함해 배포하거나 네트워크로 서비스한다면
//             AGPL 조건(소스 제공 등)을 따라야 합니다. 재배포 전에 원본 BSK UI의 현재 배포 조건도 확인하세요.

(function () {
"use strict";

const DEFAULT_CAMERA_PRESETS = [
    { name: "정면", pos_x: 0.0, pos_y: 0.0, pos_z: 0.0, user_prompt: "" },
    { name: "왼쪽", pos_x: 0.5, pos_y: 0.0, pos_z: 0.0, user_prompt: "" },
    { name: "오른쪽", pos_x: -0.5, pos_y: 0.0, pos_z: 0.0, user_prompt: "" },
    { name: "후면", pos_x: 1.0, pos_y: 0.0, pos_z: 0.0, user_prompt: "" },
];

const DEFAULT_CONFIG = {
    weight_min: 0.1,
    weight_max: 10.0,
    no_weight: false,
    no_weight_threshold: 0.5,
    active_user_prompt: "",
    camera_presets: DEFAULT_CAMERA_PRESETS,
    azimuth: {
        enabled: true,
        weight: 5.0,
        deadzone_ratio: 0.2,
        directions: {
            front: { tag: "from front", enabled: true },
            back: { tag: "from behind", enabled: true },
            left: { tag: "from right", enabled: true },
            right: { tag: "from left", enabled: true },
        },
    },
    elevation: {
        enabled: true,
        weight: 5.0,
        categories: {
            bird: { tag: "directly above, from above, aerial view", enabled: true },
            high: { tag: "high angle, from above", enabled: true },
            eye: { tag: "eye-level", enabled: true },
            low: { tag: "low angle, from below", enabled: true },
            worm: { tag: "directly below", enabled: true },
        },
    },
    distance: {
        enabled: true,
        weight: 5.0,
        categories: {
            ecu: { tag: "extreme close-up", enabled: true },
            cu: { tag: "close-up", enabled: true },
            medium: { tag: "medium shot", enabled: true },
            full: { tag: "full body", enabled: true },
            wide: { tag: "wide shot", enabled: true },
        },
    },
    tilt: {
        enabled: true,
        deadzone: 0.15,
        extra: 0.0,
        dutch_tag: "dutch angle",
    },
    wheel_step: 0.0003,
    extras: {
        lens: { enabled: false, value: "85mm lens" },
        dof: { enabled: false, value: "shallow depth of field", weight: 1.3 },
        movement: { enabled: false, value: "handheld camera" },
        composition: { enabled: false, value: "rule of thirds" },
        style: { enabled: false, value: "cinematic" },
    },
};

const DISTANCE_RANGES = {
    ecu: [0.7, 1.0],
    cu: [0.2, 0.7],
    medium: [-0.2, 0.2],
    full: [-0.7, -0.2],
    wide: [-1.0, -0.7],
};
const FARTHER_IS_STRONGER = new Set(["medium", "full", "wide"]);

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function mergeDefaults(target, defaults) {
    for (const [key, value] of Object.entries(defaults)) {
        if (!(key in target)) target[key] = clone(value);
        else if (value && typeof value === "object" && !Array.isArray(value) && target[key] && typeof target[key] === "object") {
            mergeDefaults(target[key], value);
        }
    }
    return target;
}

function normalizePreset(item, index) {
    if (!item || typeof item !== "object") return null;
    return {
        name: String(item.name || `프리셋 ${index}`),
        pos_x: clamp(item.pos_x),
        pos_y: clamp(item.pos_y),
        pos_z: clamp(item.pos_z),
        user_prompt: String(item.user_prompt ?? item.prompt ?? ""),
    };
}

function loadConfig(raw) {
    try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : clone(raw);
        const legacyTotalWeight = Number(parsed?.total_weight);
        const hadCameraPresets = Array.isArray(parsed?.camera_presets);
        const legacyPresetPrompts = parsed?.preset_prompts;
        const config = parsed && typeof parsed === "object" ? mergeDefaults(parsed, clone(DEFAULT_CONFIG)) : clone(DEFAULT_CONFIG);
        if (Number.isFinite(legacyTotalWeight)) {
            for (const name of ["azimuth", "elevation", "distance"]) config[name].weight = legacyTotalWeight;
        }
        delete config.total_weight;
        if (config.elevation) delete config.elevation.extra;
        if (config.distance) delete config.distance.extra;
        delete config.extra_master;
        config.camera_presets = (Array.isArray(config.camera_presets) ? config.camera_presets : clone(DEFAULT_CAMERA_PRESETS))
            .map(normalizePreset)
            .filter(Boolean);
        if (!hadCameraPresets && legacyPresetPrompts && typeof legacyPresetPrompts === "object") {
            config.camera_presets.forEach((preset, index) => {
                preset.user_prompt = String(legacyPresetPrompts[index] || "");
            });
        }
        delete config.preset_prompts;
        delete config.preset_library_version;
        delete config.legacy_presets_imported;
        return config;
    } catch {
        return clone(DEFAULT_CONFIG);
    }
}

function clamp(value, min = -1, max = 1) {
    return Math.max(min, Math.min(max, Number(value) || 0));
}

function splitTags(tag) {
    return String(tag || "").split(",").map((part) => part.trim()).filter(Boolean);
}

function weighted(tag, weight) {
    return splitTags(tag).map((part) => `(${part}:${Number(weight).toFixed(2)})`);
}

function appendUserPrompt(prompt, userPrompt) {
    const extra = splitTags(userPrompt);
    if (!extra.length) return prompt;
    const base = String(prompt || "").replace(/,\s*$/, "").trim();
    return `${[...(base ? [base] : []), ...extra].join(", ")},`;
}

function elevationKey(value) {
    if (value > 0.7) return "bird";
    if (value > 0.2) return "high";
    if (value >= -0.2) return "eye";
    if (value >= -0.7) return "low";
    return "worm";
}

function distanceKey(value) {
    if (value > 0.7) return "ecu";
    if (value > 0.2) return "cu";
    if (value >= -0.2) return "medium";
    if (value >= -0.7) return "full";
    return "wide";
}

function azimuthRatios(value) {
    const angle = value * Math.PI;
    const ratios = {
        front: Math.max(0, Math.cos(angle)),
        back: Math.max(0, -Math.cos(angle)),
        right: Math.max(0, Math.sin(angle)),
        left: Math.max(0, -Math.sin(angle)),
    };
    const total = Object.values(ratios).reduce((sum, part) => sum + part, 0);
    if (total) for (const key of Object.keys(ratios)) ratios[key] /= total;
    return ratios;
}

function computePrompt(posX, posY, posZ, roll, config) {
    if (config.no_weight) return computePlainPrompt(posX, posY, posZ, roll, config);
    const parts = [];
    const minWeight = Number(config.weight_min ?? 0.1);
    const maxWeight = Number(config.weight_max ?? 10.0);
    const azimuthWeight = clamp(Number(config.azimuth?.weight ?? 5.0), minWeight, maxWeight);
    const elevationWeight = clamp(Number(config.elevation?.weight ?? 5.0), minWeight, maxWeight);
    const distanceWeight = clamp(Number(config.distance?.weight ?? 5.0), minWeight, maxWeight);
    const deadzone = Number(config.azimuth?.deadzone_ratio ?? 0.2);

    if (config.azimuth?.enabled !== false) {
        const ratios = azimuthRatios(posX);
        const poleGate = clamp((1 - Math.abs(posY)) / 0.1, 0, 1);
        const budget = azimuthWeight * poleGate;
        for (const name of ["front", "back", "left", "right"]) {
            const direction = config.azimuth.directions?.[name] || {};
            const weight = ratios[name] * budget;
            if (direction.enabled === false || !direction.tag || ratios[name] <= 0 || weight < deadzone) continue;
            parts.push(...weighted(direction.tag, clamp(weight, minWeight, maxWeight)));
        }
    }

    if (config.elevation?.enabled !== false) {
        const category = config.elevation.categories?.[elevationKey(posY)] || {};
        const weight = Math.abs(posY) * elevationWeight;
        if (category.enabled !== false && category.tag && weight >= deadzone) {
            parts.push(...weighted(category.tag, clamp(weight, minWeight, maxWeight)));
        }
    }

    if (config.distance?.enabled !== false) {
        const key = distanceKey(posZ);
        const category = config.distance.categories?.[key] || {};
        if (category.enabled !== false && category.tag) {
            const [start, end] = DISTANCE_RANGES[key];
            const rawFraction = FARTHER_IS_STRONGER.has(key) ? (end - posZ) / (end - start) : (posZ - start) / (end - start);
            const fraction = clamp(rawFraction, 0, 1);
            const weight = 1 + fraction * Math.max(0, distanceWeight - 1);
            parts.push(...weighted(category.tag, clamp(weight, minWeight, maxWeight)));
        }
    }

    if (config.tilt?.enabled !== false && Math.abs(roll) >= Number(config.tilt.deadzone ?? 0.15)) {
        const weight = 1 + Number(config.tilt.extra ?? 0);
        parts.push(...weighted(config.tilt.dutch_tag, clamp(weight, 0.1, maxWeight)));
    }

    for (const name of ["lens", "dof", "movement", "composition", "style"]) {
        const extra = config.extras?.[name];
        const value = String(extra?.value || "").trim();
        if (!extra?.enabled || !value) continue;
        parts.push(name === "dof" ? `(${value}:${Number(extra.weight ?? 1.3).toFixed(2)})` : value);
    }
    return parts.length ? `${parts.join(", ")},` : "";
}

function computePlainPrompt(posX, posY, posZ, roll, config) {
    const parts = [];
    const threshold = Number(config.no_weight_threshold ?? 0.5);
    if (config.azimuth?.enabled !== false && Math.abs(posY) < 1) {
        const ratios = azimuthRatios(posX);
        const enabled = Object.entries(ratios).filter(([name]) => config.azimuth.directions?.[name]?.enabled !== false);
        if (enabled.length) {
            const dominant = enabled.reduce((best, item) => item[1] > best[1] ? item : best);
            parts.push(...splitTags(config.azimuth.directions[dominant[0]]?.tag));
            for (const [name, ratio] of enabled) {
                if (name !== dominant[0] && ratio >= threshold) parts.push(...splitTags(config.azimuth.directions[name]?.tag));
            }
        }
    }

    const elev = elevationKey(posY);
    if (config.elevation?.enabled !== false && elev !== "eye") {
        const category = config.elevation.categories?.[elev];
        if (category?.enabled !== false) parts.push(...splitTags(category?.tag));
    }
    const distance = distanceKey(posZ);
    if (config.distance?.enabled !== false && distance !== "medium") {
        const category = config.distance.categories?.[distance];
        if (category?.enabled !== false) parts.push(...splitTags(category?.tag));
    }
    if (config.tilt?.enabled !== false && Math.abs(roll) >= Number(config.tilt.deadzone ?? 0.15)) {
        parts.push(...splitTags(config.tilt.dutch_tag));
    }
    for (const name of ["lens", "dof", "movement", "composition", "style"]) {
        const extra = config.extras?.[name];
        const value = String(extra?.value || "").trim();
        if (extra?.enabled && value) parts.push(value);
    }
    return parts.length ? `${parts.join(", ")},` : "";
}

function getPath(object, path) {
    return path.split(".").reduce((value, key) => value?.[key], object);
}

function setPath(object, path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    const owner = keys.reduce((value, key) => value[key], object);
    owner[last] = value;
}

function element(tag, className, text) {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = text;
    return value;
}


/* ══════════════════════════════════════════════
   AssetManager 연동부 (위쪽 알고리즘은 원본 그대로, 아래부터가 이식하면서 새로 쓴 부분)
   원본은 ComfyUI 노드 위젯(app.registerExtension/addDOMWidget, preset_index 입력 잠금)에 묶여 있었고,
   여기서는 독립 화면(🛠️ 도구 탭)으로 옮겼다. 상태(구도 값/설정/프리셋)는 이 앱의 localStorage "am_camera_v1"에 저장된다.
   ══════════════════════════════════════════════ */
/* ── 앱 기본값 조정: 가중치 (알고리즘은 위의 원본 그대로, 바뀐 건 "기본 설정값"뿐) ── */
const SAFE_WEIGHT = 1.5;      // 보통 모델이 견디는 가중치 범위(약 1.0~1.5)의 위쪽 끝
const CONFIG_VERSION = 2;     // 저장본 버전: 2부터 안전 가중치 기본값
function applySafeWeights(cfg) {
    cfg.azimuth.weight = SAFE_WEIGHT;
    cfg.elevation.weight = SAFE_WEIGHT;
    cfg.distance.weight = SAFE_WEIGHT;
    cfg.weight_max = SAFE_WEIGHT;
    return cfg;
}
applySafeWeights(DEFAULT_CONFIG); // 새로 만드는 설정/초기화의 기본값

const STORE_KEY = "am_camera_v1";

function loadStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "null") || {}; } catch { return {}; }
}
const store = loadStore();
let config = loadConfig(store.config ?? clone(DEFAULT_CONFIG));
const state = {
    pos_x: clamp(store.state?.pos_x),
    pos_y: clamp(store.state?.pos_y),
    pos_z: clamp(store.state?.pos_z),
    roll: clamp(store.state?.roll),
};
let autoApply = store.autoApply === true;
let autoMode = store.autoMode === "random" ? "random" : "current";
let syncBasePos = store.syncBasePos !== false;        // 바꿀 때마다 공통 긍정프롬프트에 자동 반영(기존 구도 교체), 기본 켬
let invalidateAll = store.invalidateAll === true;     // 긍정프롬프트의 구도 태그를 생성할 때 전부 제외
const offTags = new Set(Array.isArray(store.offTags) ? store.offTags.map(String) : []); // 태그별로 끈 구도 태그(정규화된 글자)
let lastInserted = typeof store.lastInserted === "string" ? store.lastInserted : "";     // 마지막으로 긍정프롬프트에 넣은 구도 문구(교체 때 같이 지움)
// 예전 기본값(5/5/5, 상한 10)을 그대로 쓰던 저장본은 한 번만 안전 가중치로 올린다. 직접 바꿔 둔 값은 건드리지 않는다.
let configMigrated = false;
if (store.cfgVersion !== CONFIG_VERSION && store.config
    && config.azimuth.weight === 5 && config.elevation.weight === 5 && config.distance.weight === 5 && config.weight_max === 10) {
    applySafeWeights(config);
    configMigrated = true;
}
let activePresetIndex = null;
let viewYaw = 0;
let viewPitch = 0.42;
let saveTimer = 0;

function loadPreviewView() {
    const savedYaw = Number(config.preview_view?.yaw);
    const savedPitch = Number(config.preview_view?.pitch);
    viewYaw = Number.isFinite(savedYaw) ? savedYaw : 0;
    viewPitch = Number.isFinite(savedPitch) ? clamp(savedPitch, 0.12, 1.15) : 0.42;
}
loadPreviewView();

function saveStoreNow() {
    clearTimeout(saveTimer);
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ config, state, autoApply, autoMode, cfgVersion: CONFIG_VERSION, syncBasePos, invalidateAll, offTags: [...offTags], lastInserted })); } catch { /* 저장소 사용 불가 시 이번 세션에서만 유지 */ }
}
function saveStoreSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveStoreNow, 150);
}

if (configMigrated) saveStoreNow();

/** 지금 화면에 맞춰둔 구도의 프롬프트 (원본 노드의 STRING 출력과 같은 값) */
function computeCurrentPrompt() {
    const base = computePrompt(state.pos_x, state.pos_y, state.pos_z, state.roll, config);
    return appendUserPrompt(base, config.active_user_prompt);
}

/** 생성할 때 긍정프롬프트에 자동으로 붙일 구도 프롬프트 (generate.js의 applyCameraComposition이 호출). 꺼져 있으면 ''.
 *  "프리셋 랜덤"이면 매번 저장된 프리셋 중 하나를 골라 그 좌표 + 그 프리셋의 사용자 프롬프트를 쓴다
 *  (원본 노드에서 preset_index에 Random Int를 연결한 것과 같은 동작. 롤은 화면 값 그대로). */
function getCameraCompositionPrompt() {
    if (!autoApply) return "";
    try {
        const presets = config.camera_presets;
        if (autoMode === "random" && presets.length) {
            const preset = presets[Math.floor(Math.random() * presets.length)];
            return appendUserPrompt(computePrompt(preset.pos_x, preset.pos_y, preset.pos_z, state.roll, config), preset.user_prompt);
        }
        return computeCurrentPrompt();
    } catch { return ""; }
}

/* ══════ 구도 태그 인식 / 교체 / 무효화 ══════
   "구도 태그"란 이 도구가 만들어낼 수 있는 태그(설정의 사용자 프롬프트 칸: 방위·높이·거리·더치 앵글, 켜 둔 렌즈/심도 등)이다.
   (from front:1.50) / 1.5::from front:: / from_front 처럼 가중치·밑줄 표기가 달라도 같은 태그로 본다. */
function normCompTag(tag) {
    let s = String(tag == null ? "" : tag).trim();
    const nai = s.match(/^-?\d*\.?\d+::(.*?)(?:::)?$/);
    if (nai) s = nai[1];
    s = s.replace(/^[(\[{]+/, "").replace(/[)\]}]+$/, "").replace(/:\s*-?\d*\.?\d+$/, "");
    return s.trim().toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");
}
function compositionTagSet() {
    const set = new Set();
    const add = (value) => String(value || "").split(",").forEach((part) => { const n = normCompTag(part); if (n) set.add(n); });
    for (const item of Object.values(config.azimuth?.directions || {})) add(item?.tag);
    for (const item of Object.values(config.elevation?.categories || {})) add(item?.tag);
    for (const item of Object.values(config.distance?.categories || {})) add(item?.tag);
    add(config.tilt?.dutch_tag);
    for (const item of Object.values(config.extras || {})) if (item?.enabled) add(item?.value);
    return set;
}
function splitPromptSegments(text) { return String(text == null ? "" : text).split(","); }
function joinSegments(parts) { return parts.join(",").replace(/^\s+/, ""); }
/** 프롬프트에서 인식된 구도 태그 (중복 제외, 순서 유지) → [{raw, norm}] */
function recognizeCompositionTags(text) {
    const set = compositionTagSet();
    const seen = new Set();
    const out = [];
    for (const part of splitPromptSegments(text)) {
        const norm = normCompTag(part);
        if (norm && set.has(norm) && !seen.has(norm)) { seen.add(norm); out.push({ raw: part.trim(), norm }); }
    }
    return out;
}
/** shouldRemove(정규화된 태그, 원문)이 true인 태그만 빼고, 나머지 글자(쉼표/공백/줄바꿈)는 그대로 둔다 */
function stripPromptTags(text, shouldRemove) {
    return joinSegments(splitPromptSegments(text).filter((part) => { const n = normCompTag(part); return !(n && shouldRemove(n, part)); }));
}
/** 프롬프트 안의 기존 구도 태그(+ 마지막으로 넣었던 구도 문구)를 빼고, 첫 번째가 있던 자리에 새 구도를 넣는다. 없으면 맨 뒤에 붙인다. */
function replaceCompositionInPrompt(text, composition) {
    const comp = String(composition || "").replace(/[,\s]+$/, "").trim();
    const remove = compositionTagSet();
    for (const part of splitPromptSegments(lastInserted)) { const n = normCompTag(part); if (n) remove.add(n); }
    const parts = splitPromptSegments(text);
    const flags = parts.map((part) => { const n = normCompTag(part); return !!n && remove.has(n); });
    if (flags.indexOf(true) === -1) {
        if (!comp) return String(text == null ? "" : text);
        const base = String(text == null ? "" : text).replace(/[\s,]+$/, "");
        return base ? `${base}, ${comp}` : comp;
    }
    const out = [];
    let placed = false;
    parts.forEach((part, index) => {
        if (flags[index]) {
            if (!placed) { placed = true; if (comp) out.push(out.length ? ` ${comp}` : comp); }
            return;
        }
        out.push(part);
    });
    return joinSegments(out);
}
function writeBasePos(nextText) {
    const target = document.getElementById("base-pos");
    if (!target || target.value === nextText) return false;
    target.value = nextText;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    try { window.appStateManager?.debounceSave?.(); } catch { /* 저장 훅이 없어도 무시 */ }
    return true;
}
/** 지금 구도를 공통 긍정프롬프트에 반영 (이전에 넣은 구도는 교체) */
function applyCompositionToBasePos() {
    const target = document.getElementById("base-pos");
    if (!target) return { ok: false, changed: false };
    const comp = computeCurrentPrompt();
    const changed = writeBasePos(replaceCompositionInPrompt(target.value, comp));
    lastInserted = comp.replace(/[,\s]+$/, "");
    saveStoreSoon();
    return { ok: true, changed };
}
/** 생성할 때: 무효화로 끈 구도 태그를 빼 준다 (글자 원본은 안 건드리고 이번 생성 프롬프트에서만) */
function invalidateCameraCompositionTags(text) {
    if (invalidateAll) { const set = compositionTagSet(); return stripPromptTags(text, (n) => set.has(n)); }
    if (offTags.size) return stripPromptTags(text, (n) => offTags.has(n));
    return String(text == null ? "" : text);
}
/** generate.js가 최종 긍정프롬프트에 대해 호출: ① 무효화 적용 ② "생성에 자동 적용"이 켜져 있으면 이 도구의 구도를 붙임
 *  (자동 반영으로 긍정프롬프트에 넣어 둔 구도는 새 구도로 교체, 이미 같은 태그가 있으면 중복해서 붙이지 않음). 아무것도 안 켰으면 원문 그대로. */
function applyCameraCompositionToPrompt(promptStr) {
    let prompt = invalidateCameraCompositionTags(promptStr);
    const cam = getCameraCompositionPrompt();
    if (!cam) return prompt;
    const previous = new Set(splitPromptSegments(lastInserted).map(normCompTag).filter(Boolean));
    if (previous.size) prompt = stripPromptTags(prompt, (n) => previous.has(n));
    const existing = new Set(splitPromptSegments(prompt).map(normCompTag).filter(Boolean));
    const add = splitPromptSegments(cam).map((part) => part.trim()).filter((part) => part && !existing.has(normCompTag(part)));
    if (!add.length) return prompt;
    const base = prompt.replace(/[\s,]+$/, "");
    return base ? `${base}, ${add.join(", ")}` : add.join(", ");
}

/* ══════ 긍정프롬프트 옆 팝업 ══════ */
function ensureCameraPopup() {
    let popup = document.getElementById("camera-popup");
    if (popup) return popup;
    ensureStyles();
    popup = element("div");
    popup.id = "camera-popup";
    popup.style.cssText = "position:fixed; top:70px; right:24px; width:min(560px, 94vw); max-height:88vh; display:none; flex-direction:column; z-index:99990; background:#22272e; border:1px solid #556270; border-radius:10px; box-shadow:0 10px 36px rgba(0,0,0,.65);";
    const header = element("div");
    header.id = "camera-popup-header";
    header.style.cssText = "display:flex; align-items:center; justify-content:space-between; padding:8px 12px; cursor:move; user-select:none; border-bottom:1px solid #3b424c; color:#8fc8ff; font-weight:650;";
    header.appendChild(element("span", "", "📷 카메라 구도 (드래그해서 옮길 수 있어요)"));
    const close = element("button", "", "✕");
    close.id = "camera-popup-close";
    close.type = "button";
    close.style.cssText = "padding:2px 9px; background:#343b44; color:#eee; border:1px solid #4b5563; border-radius:5px; cursor:pointer;";
    close.addEventListener("click", closeCameraPopup);
    header.appendChild(close);
    const body = element("div");
    body.style.cssText = "overflow:auto; padding:8px;";
    const host = element("div");
    host.id = "camera-root";
    body.appendChild(host);
    popup.append(header, body);
    document.body.appendChild(popup);
    let drag = null;
    header.addEventListener("mousedown", (event) => {
        if (event.target === close) return;
        const rect = popup.getBoundingClientRect();
        drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
        event.preventDefault();
    });
    document.addEventListener("mousemove", (event) => {
        if (!drag) return;
        popup.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, event.clientX - drag.dx))}px`;
        popup.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, event.clientY - drag.dy))}px`;
        popup.style.right = "auto";
    });
    document.addEventListener("mouseup", () => { drag = null; });
    return popup;
}
function openCameraPopup() {
    const popup = ensureCameraPopup();
    popup.style.display = "flex";
    renderCameraTool();
    uiApi?.refreshRecognized?.();
}
function closeCameraPopup() {
    const popup = document.getElementById("camera-popup");
    if (popup) popup.style.display = "none";
}
function toggleCameraPopup() {
    const popup = document.getElementById("camera-popup");
    if (popup && popup.style.display !== "none") closeCameraPopup(); else openCameraPopup();
}

function ensureStyles() {
    if (document.getElementById("am-camera-styles")) return;
    const style = document.createElement("style");
    style.id = "am-camera-styles";
    style.textContent = `
        .am-camera { box-sizing:border-box; width:100%; max-width:720px; padding:10px; display:flex; flex-direction:column; gap:8px; color:#ecf2f8; background:#22272e; border:1px solid #3b424c; border-radius:9px; font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic",sans-serif; }
        .am-camera * { box-sizing:border-box; }
        .am-camera-toolbar { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
        .am-camera button, .am-camera select { min-height:30px; padding:4px 9px; color:#eaf0f6; background:#343b44; border:1px solid #4b5563; border-radius:5px; cursor:pointer; }
        .am-camera button:hover { background:#46515e; }
        .am-camera select { flex:1; min-width:150px; }
        .am-camera-canvas-wrap { position:relative; width:100%; }
        .am-camera canvas { display:block; width:100%; aspect-ratio:14/9; background:#171b20; border:1px solid #414955; border-radius:8px; cursor:crosshair; touch-action:none; user-select:none; }
        .am-camera-overlay { position:absolute; inset:8px 10px auto; display:flex; justify-content:space-between; color:#abb5c0; pointer-events:none; font-size:12px; }
        .am-camera-overlay span:last-child { color:#ffae6b; font-family:Consolas,monospace; text-align:right; white-space:pre; }
        .am-camera-axis { display:grid; grid-template-columns:72px minmax(120px,1fr) 72px; gap:8px; align-items:center; }
        .am-camera-axis input[type=range] { width:100%; accent-color:#75b9ff; }
        .am-camera-axis input[type=number], .am-camera-setting input[type=number], .am-camera-setting input[type=text], .am-camera-preset-prompt input, .am-camera textarea { width:100%; min-width:0; padding:5px 7px; color:#eaf0f6; background:#171b20; border:1px solid #4b5563; border-radius:4px; }
        .am-camera details { border:1px solid #424b56; border-radius:6px; background:#292f37; }
        .am-camera summary { padding:8px 10px; cursor:pointer; font-weight:650; user-select:none; }
        .am-camera-details { display:flex; flex-direction:column; gap:7px; padding:2px 10px 10px; }
        .am-camera-setting { display:grid; grid-template-columns:112px 1fr 52px; gap:8px; align-items:center; }
        .am-camera-setting.wide { grid-template-columns:112px 28px 1fr; }
        .am-camera-setting label { color:#cbd5df; }
        .am-camera-setting input[type=checkbox] { width:17px; height:17px; accent-color:#67aef5; }
        .am-camera-group-title { margin-top:5px; padding-top:7px; color:#8fc8ff; border-top:1px solid #3b434d; font-weight:650; }
        .am-camera-prompt { min-height:58px; resize:vertical; color:#fff2a6 !important; font-family:Consolas,monospace; }
        .am-camera-preset-prompt { display:grid; grid-template-columns:148px minmax(0,1fr); gap:8px; align-items:center; }
        .am-camera-preset-prompt label { color:#8fc8ff; font-weight:650; }
        .am-camera-help { color:#9ba7b3; font-size:11px; }
        .am-camera-warn { display:none; padding:7px 10px; color:#ffcf87; background:#3a2f1a; border:1px solid #7a5a22; border-radius:6px; font-size:12px; line-height:1.5; }
        .am-camera-warn button { margin-left:6px; min-height:24px; padding:2px 8px; }
        .am-camera-apply { border:1px solid #424b56; border-radius:6px; background:#292f37; padding:8px 10px; display:flex; flex-direction:column; gap:6px; }
        .am-camera-toast { position:fixed; top:18px; left:50%; z-index:100000; transform:translateX(-50%); padding:7px 14px; color:#fff; background:rgba(20,24,29,.94); border:1px solid #53606d; border-radius:6px; pointer-events:none; }
    `;
    document.head.appendChild(style);
}

function createCameraUI(host) {
    ensureStyles();
    host.replaceChildren();
    const axisControls = {};
    let uiReady = false;
    let syncTimer = 0;
    const root = element("div", "am-camera");
    root.id = "camera-ui";
    const toolbar = element("div", "am-camera-toolbar");
    const presetSelect = element("select");
    presetSelect.id = "camera-preset-select";
    const promptOutput = element("textarea", "am-camera-prompt");
    promptOutput.id = "camera-prompt-output";
    promptOutput.readOnly = true;
    const weightWarn = element("div", "am-camera-warn");
    weightWarn.id = "camera-weight-warn";
    const presetUserPrompt = element("input");
    presetUserPrompt.type = "text";
    presetUserPrompt.placeholder = "예: eye focus, back focus";
    const presetPromptRow = element("div", "am-camera-preset-prompt");
    presetPromptRow.append(element("label", "", "프리셋 사용자 프롬프트"), presetUserPrompt);
    const presetIndexHelp = element("div", "am-camera-help");

    function toast(message) {
        const notice = element("div", "am-camera-toast", message);
        document.body.appendChild(notice);
        setTimeout(() => notice.remove(), 1500);
    }
    function button(label, handler, id) {
        const value = element("button", "", label);
        value.type = "button";
        if (id) value.id = id;
        value.addEventListener("click", (event) => { event.stopPropagation(); handler(event); });
        return value;
    }

    function updatePrompt() {
        promptOutput.value = computeCurrentPrompt();
        updateWeightWarning();
    }
    /** 프롬프트에 1.6을 넘는 가중치가 있으면 경고 (그런 값은 대부분의 모델에서 그림이 깨짐) */
    function updateWeightWarning() {
        let max = 0;
        for (const match of promptOutput.value.matchAll(/:(\d+(?:\.\d+)?)\)/g)) max = Math.max(max, Number(match[1]));
        if (max > 1.6) {
            weightWarn.replaceChildren(`⚠️ 가중치가 ${max.toFixed(2)}까지 올라갑니다. 보통 1.6을 넘으면 그림이 깨지기 쉽습니다. `);
            weightWarn.appendChild(button("⚖️ 안전 가중치로 맞추기", makeSafe, "camera-weight-warn-btn"));
            weightWarn.appendChild(document.createTextNode(" 또는 설정의 \"가중치 제거\"를 켜보세요."));
            weightWarn.style.display = "block";
        } else {
            weightWarn.style.display = "none";
        }
    }
    function makeSafe() {
        applySafeWeights(config);
        rebuildSettings();
        updateAll();
        toast(`가중치를 안전 범위(총 ${SAFE_WEIGHT} · 상한 ${SAFE_WEIGHT})로 맞췄습니다.`);
    }
    function updateAxisControls() {
        for (const [key, controls] of Object.entries(axisControls)) {
            controls.range.value = state[key];
            controls.number.setAttribute("aria-valuenow", String(state[key]));
            if (document.activeElement !== controls.number) controls.number.value = Number(state[key]).toFixed(2);
        }
    }
    function updateAll(redraw = true) {
        updateAxisControls();
        if (document.activeElement !== presetUserPrompt) presetUserPrompt.value = String(config.active_user_prompt || "");
        updatePrompt();
        if (redraw) drawCamera();
        refreshApplyHelp();
        saveStoreSoon();
        if (uiReady && syncBasePos) { clearTimeout(syncTimer); syncTimer = setTimeout(() => { applyCompositionToBasePos(); refreshRecognized(); }, 250); }
    }
    function applySnapshot(snapshot) {
        if (!snapshot || typeof snapshot !== "object") throw new Error("올바른 설정이 아닙니다.");
        activePresetIndex = null;
        config = loadConfig(snapshot.config ?? snapshot);
        loadPreviewView();
        for (const key of ["pos_x", "pos_y", "pos_z", "roll"]) {
            if (Number.isFinite(Number(snapshot[key]))) state[key] = clamp(Number(snapshot[key]));
        }
        rebuildSettings();
        refreshPresets();
        updateAll();
    }
    function snapshot() { return { ...state, config: clone(config) }; }
    function applyPreset(index) {
        const presets = config.camera_presets;
        if (!presets.length) throw new Error("저장된 프리셋이 없습니다.");
        const wrapped = ((Math.trunc(Number(index)) % presets.length) + presets.length) % presets.length;
        const preset = presets[wrapped];
        state.pos_x = preset.pos_x;
        state.pos_y = preset.pos_y;
        state.pos_z = preset.pos_z;
        activePresetIndex = wrapped;
        config.active_user_prompt = String(preset.user_prompt || "");
        presetSelect.value = String(wrapped);
        updateAll();
        return preset;
    }
    function refreshPresets(selected = activePresetIndex) {
        presetSelect.replaceChildren();
        const placeholder = element("option", "", config.camera_presets.length ? "프리셋 불러오기" : "프리셋 없음");
        placeholder.value = "";
        presetSelect.appendChild(placeholder);
        for (const [index, preset] of config.camera_presets.entries()) {
            const coordinates = [preset.pos_x, preset.pos_y, preset.pos_z].map((value) => Number(value).toFixed(2)).join(", ");
            const option = element("option", "", `${index} · ${preset.name} (${coordinates})`);
            option.value = String(index);
            presetSelect.appendChild(option);
        }
        presetSelect.value = selected === null || selected === "" ? "" : String(selected);
        const count = config.camera_presets.length;
        presetIndexHelp.textContent = count
            ? `프리셋 ${count}개 (번호 0~${count - 1}). 아래 "생성에 자동 적용"에서 "프리셋 랜덤"을 고르면 생성할 때마다 이 목록에서 무작위로 골라 씁니다.`
            : "프리셋이 없습니다. 현재 상태를 저장하면 번호 0부터 생성됩니다.";
    }

    presetSelect.addEventListener("change", () => {
        if (!presetSelect.value) return;
        try {
            const preset = applyPreset(Number(presetSelect.value));
            toast(`[${activePresetIndex}] '${preset.name}' 프리셋을 불러왔습니다.`);
        } catch (error) { toast(error.message); }
    });
    toolbar.append(
        button("초기화", () => applySnapshot({ pos_x: 0, pos_y: 0, pos_z: 0, roll: 0, config: clone(DEFAULT_CONFIG) }), "camera-reset-btn"),
        button("저장", () => {
            const name = window.prompt("프리셋 이름", `카메라 ${new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`)?.trim();
            if (!name) return;
            const entry = { name, pos_x: state.pos_x, pos_y: state.pos_y, pos_z: state.pos_z, user_prompt: String(config.active_user_prompt || "") };
            const existingIndex = config.camera_presets.findIndex((preset) => preset.name === name);
            if (existingIndex >= 0) {
                config.camera_presets[existingIndex] = entry;
                activePresetIndex = existingIndex;
            } else {
                config.camera_presets.push(entry);
                activePresetIndex = config.camera_presets.length - 1;
            }
            refreshPresets(activePresetIndex);
            updateAll();
            toast(`[${activePresetIndex}] '${name}' 프리셋을 저장했습니다.`);
        }, "camera-save-btn"),
        presetSelect,
        button("랜덤", () => {
            activePresetIndex = null;
            presetSelect.value = "";
            for (const key of ["pos_x", "pos_y", "pos_z"]) state[key] = Math.round((Math.random() * 2 - 1) * 100) / 100;
            updateAll();
            toast(`X ${state.pos_x.toFixed(2)} · Y ${state.pos_y.toFixed(2)} · Z ${state.pos_z.toFixed(2)}`);
        }, "camera-random-btn"),
        button("삭제", () => {
            if (presetSelect.value === "") return toast("삭제할 프리셋을 선택하세요.");
            const index = Number(presetSelect.value);
            const [removed] = config.camera_presets.splice(index, 1);
            activePresetIndex = null;
            refreshPresets();
            updateAll();
            toast(`[${index}] '${removed.name}' 프리셋을 삭제했습니다. 남은 번호를 다시 매겼습니다.`);
        }, "camera-delete-btn"),
        button("설정 복사", async () => {
            await navigator.clipboard.writeText(JSON.stringify(snapshot(), null, 2));
            toast("카메라 설정을 복사했습니다.");
        }, "camera-copy-config-btn"),
        button("📐 전체 각도 일괄 생성", () => {
            if (typeof window.generateAllPresetAngles === "function") window.generateAllPresetAngles();
        }, "camera-gen-all-angles-btn"),
        button("설정 붙여넣기", async () => {
            try {
                applySnapshot(JSON.parse(await navigator.clipboard.readText()));
                toast("카메라 설정을 붙여넣었습니다.");
            } catch { toast("클립보드에서 올바른 설정을 읽지 못했습니다."); }
        }, "camera-paste-config-btn"),
    );
    root.appendChild(toolbar);
    refreshPresets();

    presetUserPrompt.addEventListener("input", () => {
        config.active_user_prompt = presetUserPrompt.value;
        if (activePresetIndex !== null && config.camera_presets[activePresetIndex]) {
            config.camera_presets[activePresetIndex].user_prompt = presetUserPrompt.value;
        }
        updateAll(false);
    });

    const canvasWrap = element("div", "am-camera-canvas-wrap");
    const canvas = element("canvas");
    canvas.id = "camera-canvas";
    const overlay = element("div", "am-camera-overlay");
    const overlayHelp = element("span", "", "좌드래그: 카메라 · 우드래그: 보기 회전 · 휠: 거리 · Shift+휠: 롤");
    const overlayStatus = element("span");
    overlay.append(overlayHelp, overlayStatus);
    canvasWrap.append(canvas, overlay);
    root.appendChild(canvasWrap);

    const WIDTH = 560;
    const HEIGHT = 360;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.scale(dpr, dpr);

    function project(x, y, z) {
        const cosine = Math.cos(viewYaw);
        const sine = Math.sin(viewYaw);
        const horizontal = x * cosine + z * sine;
        const depth = -x * sine + z * cosine;
        const scale = 78;
        return {
            x: WIDTH / 2 + horizontal * scale,
            y: HEIGHT / 2 - (y - 0.7) * scale * Math.cos(viewPitch) + depth * scale * Math.sin(viewPitch),
            depth,
        };
    }
    function ellipse(radius, elevation, color, dashed = true) {
        ctx.beginPath();
        for (let index = 0; index <= 80; index++) {
            const angle = index / 80 * Math.PI * 2;
            const point = project(radius * Math.sin(angle), elevation, radius * Math.cos(angle));
            if (index) ctx.lineTo(point.x, point.y); else ctx.moveTo(point.x, point.y);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.8;
        ctx.setLineDash(dashed ? [5, 7] : []);
        ctx.stroke();
        ctx.setLineDash([]);
    }
    function verticalOrbit(radius, azimuth, color) {
        ctx.beginPath();
        for (let index = 0; index <= 80; index++) {
            const angle = index / 80 * Math.PI * 2;
            const horizontal = radius * Math.cos(angle);
            const point = project(horizontal * Math.sin(azimuth), 0.7 + radius * Math.sin(angle), horizontal * Math.cos(azimuth));
            if (index) ctx.lineTo(point.x, point.y); else ctx.moveTo(point.x, point.y);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.8;
        ctx.setLineDash([5, 7]);
        ctx.stroke();
        ctx.setLineDash([]);
    }
    function elevationOrbit(radius, elevation, color) {
        const horizontal = radius * Math.cos(elevation);
        const height = 0.7 + radius * Math.sin(elevation);
        ctx.beginPath();
        for (let index = 0; index <= 80; index++) {
            const angle = index / 80 * Math.PI * 2;
            const point = project(horizontal * Math.sin(angle), height, horizontal * Math.cos(angle));
            if (index) ctx.lineTo(point.x, point.y); else ctx.moveTo(point.x, point.y);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.4;
        ctx.setLineDash([3, 7]);
        ctx.stroke();
        ctx.setLineDash([]);
    }
    function point3d(x, y, z, label) {
        const point = project(x, y, z);
        ctx.fillStyle = "#75d9e9";
        ctx.beginPath();
        ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#eef8ff";
        ctx.font = "700 13px Consolas";
        ctx.textAlign = "center";
        ctx.fillText(label, point.x, point.y - 10);
    }
    function drawCamera() {
        const degrees = Math.round(state.pos_x * 180);
        const side = Math.abs(state.pos_x) > 0.85 ? "뒤" : state.pos_x < -0.05 ? `왼쪽 ${Math.abs(degrees)}°` : state.pos_x > 0.05 ? `오른쪽 ${degrees}°` : "정면 0°";
        overlayStatus.textContent = `${side}\n롤 ${Math.round(state.roll * 45)}°`;
        if (!ctx) return;
        ctx.clearRect(0, 0, WIDTH, HEIGHT);
        const background = ctx.createLinearGradient(0, 0, 0, HEIGHT);
        background.addColorStop(0, "#151a20");
        background.addColorStop(1, "#222932");
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, WIDTH, HEIGHT);

        const radius = 1.7 - 0.7 * state.pos_z;
        ellipse(radius, 0.7, "rgba(74,201,217,.34)");
        const angle = state.pos_x * Math.PI;
        const elevation = state.pos_y * Math.PI / 2;
        verticalOrbit(radius, angle, "rgba(255,137,75,.38)");
        elevationOrbit(radius, elevation, "rgba(111,215,235,.25)");
        const horizontal = radius * Math.cos(elevation);
        const camera = { x: horizontal * Math.sin(angle), y: 0.7 + radius * Math.sin(elevation), z: horizontal * Math.cos(angle) };

        point3d(0, 0.7, radius, "F");
        point3d(0, 0.7, -radius, "B");
        point3d(radius, 0.7, 0, "L");
        point3d(-radius, 0.7, 0, "R");
        const center = project(0, 0.7, 0);
        const cameraPoint = project(camera.x, camera.y, camera.z);
        ctx.strokeStyle = "rgba(255,210,103,.7)";
        ctx.setLineDash([5, 6]);
        ctx.beginPath();
        ctx.moveTo(center.x, center.y);
        ctx.lineTo(cameraPoint.x, cameraPoint.y);
        ctx.stroke();
        ctx.setLineDash([]);

        const centerGlow = ctx.createRadialGradient(center.x - 4, center.y - 5, 2, center.x, center.y, 17);
        centerGlow.addColorStop(0, "#d9ffff");
        centerGlow.addColorStop(1, "#348a96");
        ctx.fillStyle = centerGlow;
        ctx.beginPath();
        ctx.arc(center.x, center.y, 15, 0, Math.PI * 2);
        ctx.fill();

        ctx.save();
        ctx.translate(cameraPoint.x, cameraPoint.y);
        ctx.rotate(Math.atan2(center.y - cameraPoint.y, center.x - cameraPoint.x) + state.roll * Math.PI / 4);
        ctx.fillStyle = "#ff9555";
        ctx.fillRect(-13, -8, 26, 16);
        ctx.fillStyle = "#10151b";
        ctx.beginPath();
        ctx.arc(6, 0, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
    function canvasPoint(event) {
        const rect = canvas.getBoundingClientRect();
        return { x: (event.clientX - rect.left) * WIDTH / (rect.width || WIDTH), y: (event.clientY - rect.top) * HEIGHT / (rect.height || HEIGHT) };
    }

    let dragging = null;
    canvas.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        try { canvas.setPointerCapture?.(event.pointerId); } catch { /* 일부 환경은 지원 안 함 */ }
        const point = canvasPoint(event);
        const mode = event.button === 2 || event.altKey ? "view" : "camera";
        dragging = { mode, pointerId: event.pointerId, x: point.x, y: point.y, posX: state.pos_x, posY: state.pos_y, viewYaw, viewPitch };
        canvas.style.cursor = mode === "view" ? "move" : "grabbing";
        event.preventDefault();
    });
    canvas.addEventListener("pointermove", (event) => {
        if (!dragging || dragging.pointerId !== event.pointerId) return;
        const point = canvasPoint(event);
        if (dragging.mode === "view") {
            viewYaw = dragging.viewYaw - (point.x - dragging.x) / WIDTH * Math.PI * 2;
            viewPitch = clamp(dragging.viewPitch + (point.y - dragging.y) / HEIGHT * 1.5, 0.12, 1.15);
            config.preview_view = { yaw: viewYaw, pitch: viewPitch };
        } else {
            activePresetIndex = null;
            presetSelect.value = "";
            let value = dragging.posX + (point.x - dragging.x) / (WIDTH / 2);
            while (value > 1) value -= 2;
            while (value < -1) value += 2;
            state.pos_x = value;
            state.pos_y = clamp(dragging.posY - (point.y - dragging.y) / (HEIGHT / 2));
        }
        updateAll();
        event.preventDefault();
    });
    function stopDrag(event) {
        if (!dragging || dragging.pointerId !== event.pointerId) return;
        dragging = null;
        canvas.style.cursor = "crosshair";
    }
    canvas.addEventListener("pointerup", stopDrag);
    canvas.addEventListener("pointercancel", stopDrag);
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("wheel", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const amount = event.deltaY * Number(config.wheel_step || 0.0003);
        if (event.shiftKey) state.roll = clamp(state.roll - amount * 3);
        else {
            activePresetIndex = null;
            presetSelect.value = "";
            state.pos_z = clamp(state.pos_z - amount);
        }
        updateAll();
    }, { passive: false });
    canvas.addEventListener("dblclick", (event) => {
        if (event.shiftKey) {
            viewYaw = 0;
            viewPitch = 0.42;
            config.preview_view = { yaw: viewYaw, pitch: viewPitch };
        } else {
            activePresetIndex = null;
            presetSelect.value = "";
            state.pos_x = 0;
            state.pos_y = 0;
        }
        updateAll();
    });

    function createAxis(label, key) {
        const row = element("div", "am-camera-axis");
        const title = element("label", "", label);
        const range = element("input");
        range.type = "range";
        range.min = "-1";
        range.max = "1";
        range.step = "0.01";
        range.id = `camera-axis-range-${key}`;
        const number = element("input");
        number.type = "number";
        number.min = "-1";
        number.max = "1";
        number.step = "0.01";
        number.id = `camera-axis-number-${key}`;
        number.inputMode = "decimal";
        number.autocomplete = "off";
        number.spellcheck = false;
        number.setAttribute("aria-label", label);
        number.title = "Enter 적용 · Esc 취소 · Shift+↑↓ 0.10 조절";
        function clearPreset() {
            if (key === "roll") return;
            activePresetIndex = null;
            presetSelect.value = "";
        }
        function change(value) { clearPreset(); state[key] = clamp(value); updateAll(); }
        range.addEventListener("input", () => change(range.value));
        number.addEventListener("input", () => {
            const raw = number.value.trim();
            if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return;
            const value = Number(raw);
            if (!Number.isFinite(value)) return;
            clearPreset();
            state[key] = clamp(value);
            range.value = state[key];
            number.setAttribute("aria-valuenow", String(state[key]));
            updatePrompt();
            drawCamera();
            saveStoreSoon();
        });
        number.addEventListener("change", () => {
            const value = Number(number.value);
            if (Number.isFinite(value)) { clearPreset(); state[key] = clamp(value); }
            number.value = Number(state[key]).toFixed(2);
            updateAll();
        });
        number.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                const value = Number(number.value);
                if (Number.isFinite(value)) { clearPreset(); state[key] = clamp(value); }
                number.value = Number(state[key]).toFixed(2);
                updateAll();
            } else if (event.key === "Escape") {
                event.preventDefault();
                number.value = Number(state[key]).toFixed(2);
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                clearPreset();
                const step = event.shiftKey ? 0.1 : 0.01;
                state[key] = clamp(state[key] + (event.key === "ArrowUp" ? step : -step));
                number.value = Number(state[key]).toFixed(2);
                updateAll();
            }
        });
        axisControls[key] = { range, number };
        row.append(title, range, number);
        return row;
    }
    root.append(createAxis("좌우 (X)", "pos_x"), createAxis("상하 (Y)", "pos_y"), createAxis("거리 (Z)", "pos_z"), createAxis("롤 (R)", "roll"));
    root.appendChild(presetIndexHelp);
    root.appendChild(element("div", "am-camera-help", "숫자 칸의 화살표로 0.01씩 조절할 수 있습니다. Enter로 적용, Esc로 취소, Shift+↑↓로 0.10씩 조절할 수 있습니다."));

    function details(title, open = false) {
        const container = element("details");
        container.open = open;
        container.appendChild(element("summary", "", title));
        const content = element("div", "am-camera-details");
        container.appendChild(content);
        return { container, content };
    }
    const weights = details("가중치 설정");
    weights.container.id = "camera-settings-weights";
    const prompts = details("사용자 프롬프트");
    prompts.container.id = "camera-settings-prompts";
    root.append(weights.container, prompts.container);

    function numberSetting(parent, label, path, min, max, step) {
        const row = element("div", "am-camera-setting");
        const input = element("input");
        input.type = "range";
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        input.value = String(getPath(config, path));
        const number = element("input");
        number.type = "number";
        number.min = String(min);
        number.max = String(max);
        number.step = String(step);
        number.value = String(getPath(config, path));
        number.dataset.path = path;
        const apply = (value) => {
            const next = clamp(value, min, max);
            setPath(config, path, next);
            input.value = next;
            number.value = next;
            updateAll();
        };
        input.addEventListener("input", () => apply(input.value));
        number.addEventListener("input", () => apply(number.value));
        row.append(element("label", "", label), input, number);
        parent.appendChild(row);
    }
    function booleanSetting(parent, label, path) {
        const row = element("div", "am-camera-setting wide");
        const input = element("input");
        input.type = "checkbox";
        input.checked = Boolean(getPath(config, path));
        input.dataset.path = path;
        input.addEventListener("change", () => {
            setPath(config, path, input.checked);
            updateAll();
        });
        row.append(element("label", "", label), input, element("span", "am-camera-help", input.checked ? "사용" : "사용 안 함"));
        input.addEventListener("change", () => row.lastChild.textContent = input.checked ? "사용" : "사용 안 함");
        parent.appendChild(row);
    }
    function textSetting(parent, label, path, withToggle = true) {
        const row = element("div", "am-camera-setting wide");
        const enabledPath = path.replace(/\.(tag|value)$/, ".enabled");
        const checkbox = element("input");
        checkbox.type = "checkbox";
        checkbox.checked = withToggle ? getPath(config, enabledPath) !== false : true;
        checkbox.style.visibility = withToggle ? "visible" : "hidden";
        const input = element("input");
        input.type = "text";
        input.value = String(getPath(config, path) || "");
        input.dataset.path = path;
        if (withToggle) checkbox.addEventListener("change", () => {
            setPath(config, enabledPath, checkbox.checked);
            updateAll(false);
        });
        input.addEventListener("input", () => {
            setPath(config, path, input.value);
            updateAll(false);
        });
        row.append(element("label", "", label), checkbox, input);
        parent.appendChild(row);
    }
    function group(parent, title) { parent.appendChild(element("div", "am-camera-group-title", title)); }

    function rebuildSettings() {
        weights.content.replaceChildren();
        prompts.content.replaceChildren();
        weights.content.appendChild(element("div", "am-camera-help", "가중치는 보통 1.0~1.5 정도가 안전합니다. 그보다 크면 그림이 깨지기 쉬워요. NAI에 쓸 때는 생성 탭의 \"가중치 변환\"을 켜거나, 아래 \"가중치 제거\"를 켜세요."));
        weights.content.appendChild(button(`⚖️ 안전 가중치로 맞추기 (총 ${SAFE_WEIGHT} · 상한 ${SAFE_WEIGHT})`, makeSafe, "camera-safe-weights-btn"));
        booleanSetting(weights.content, "가중치 제거", "no_weight");
        numberSetting(weights.content, "각 태그 가중치 상한", "weight_max", 0.5, 10, 0.1);
        numberSetting(weights.content, "방위 총 가중치", "azimuth.weight", 0.1, 10, 0.1);
        booleanSetting(weights.content, "방위 사용", "azimuth.enabled");
        numberSetting(weights.content, "방위 데드존", "azimuth.deadzone_ratio", 0, 1, 0.01);
        numberSetting(weights.content, "높이 총 가중치", "elevation.weight", 0.1, 10, 0.1);
        booleanSetting(weights.content, "높이 사용", "elevation.enabled");
        numberSetting(weights.content, "거리 총 가중치", "distance.weight", 0.1, 10, 0.1);
        booleanSetting(weights.content, "거리 사용", "distance.enabled");
        booleanSetting(weights.content, "롤 사용", "tilt.enabled");
        numberSetting(weights.content, "롤 데드존", "tilt.deadzone", 0, 1, 0.01);

        group(prompts.content, "방위");
        textSetting(prompts.content, "정면", "azimuth.directions.front.tag");
        textSetting(prompts.content, "뒤", "azimuth.directions.back.tag");
        textSetting(prompts.content, "카메라 왼쪽", "azimuth.directions.left.tag");
        textSetting(prompts.content, "카메라 오른쪽", "azimuth.directions.right.tag");
        group(prompts.content, "높이");
        textSetting(prompts.content, "직부감", "elevation.categories.bird.tag");
        textSetting(prompts.content, "하이 앵글", "elevation.categories.high.tag");
        textSetting(prompts.content, "눈높이", "elevation.categories.eye.tag");
        textSetting(prompts.content, "로우 앵글", "elevation.categories.low.tag");
        textSetting(prompts.content, "직앙", "elevation.categories.worm.tag");
        group(prompts.content, "거리");
        textSetting(prompts.content, "극단적 클로즈업", "distance.categories.ecu.tag");
        textSetting(prompts.content, "클로즈업", "distance.categories.cu.tag");
        textSetting(prompts.content, "미디엄 샷", "distance.categories.medium.tag");
        textSetting(prompts.content, "풀 바디", "distance.categories.full.tag");
        textSetting(prompts.content, "와이드 샷", "distance.categories.wide.tag");
        group(prompts.content, "롤·렌즈·연출");
        textSetting(prompts.content, "더치 앵글", "tilt.dutch_tag", false);
        textSetting(prompts.content, "렌즈", "extras.lens.value");
        textSetting(prompts.content, "심도", "extras.dof.value");
        textSetting(prompts.content, "카메라 무빙", "extras.movement.value");
        textSetting(prompts.content, "구도", "extras.composition.value");
        textSetting(prompts.content, "스타일", "extras.style.value");
    }
    rebuildSettings();

    root.appendChild(promptOutput);
    root.appendChild(weightWarn);
    root.appendChild(presetPromptRow);

    /* ── 여기부터 AssetManager 전용: 프롬프트 사용 + 생성에 자동 적용 ── */
    /* ── 여기부터 AssetManager 전용: 긍정프롬프트 연동 · 구도 태그 인식/무효화/조각 만들기 · 생성에 자동 적용 ── */
    const linkBox = element("div", "am-camera-apply");
    linkBox.id = "camera-link-box";
    const syncLabel = element("label");
    syncLabel.style.cssText = "display:flex; gap:8px; align-items:center; cursor:pointer; font-weight:650;";
    const syncCheck = element("input");
    syncCheck.type = "checkbox";
    syncCheck.id = "camera-sync-basepos";
    syncCheck.checked = syncBasePos;
    syncLabel.append(syncCheck, element("span", "", "바꿀 때마다 공통 긍정프롬프트에 자동 반영 (이전 구도는 교체)"));
    const linkButtons = element("div", "am-camera-toolbar");
    linkButtons.append(
        button("✅ 지금 긍정프롬프트에 적용 (구도 교체)", () => {
            const result = applyCompositionToBasePos();
            if (!result.ok) return toast("공통 긍정프롬프트 칸을 찾지 못했습니다.");
            refreshRecognized();
            toast(result.changed ? "공통 긍정프롬프트의 구도를 새 구도로 바꿨습니다." : "이미 같은 구도입니다.");
        }, "camera-apply-base-pos-btn"),
        button("📋 프롬프트 복사", async () => {
            try { await navigator.clipboard.writeText(promptOutput.value); toast("구도 프롬프트를 복사했습니다."); }
            catch { toast("복사하지 못했습니다. 프롬프트 칸을 직접 선택해서 복사하세요."); }
        }, "camera-copy-prompt-btn"),
    );
    const recHead = element("div");
    recHead.style.cssText = "display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-weight:650; margin-top:4px;";
    recHead.append(element("span", "", "🔍 긍정프롬프트에서 인식된 구도 태그"), button("🔄 다시 인식", () => refreshRecognized(), "camera-recognize-btn"));
    const recChips = element("div");
    recChips.id = "camera-recognized";
    recChips.style.cssText = "display:flex; flex-wrap:wrap; gap:4px; min-height:26px;";
    const recHelp = element("div", "am-camera-help", "태그를 클릭하면 그 구도 태그를 생성에서 끄고(취소선) 다시 클릭하면 켭니다. 글자는 그대로 두고 생성할 때만 빠집니다. 조각 안에 든 같은 태그도 함께 걸립니다.");
    const makePieceBtn = button("🧩 조각으로 만들기 (긍정프롬프트에서 빼냄)", () => {
        const target = document.getElementById("base-pos");
        const list = recognizeCompositionTags(target ? target.value : "");
        if (!list.length) return toast("인식된 구도 태그가 없습니다.");
        if (typeof window.createCompositionPiece !== "function") return toast("프롬프트 라이브러리 기능을 찾지 못했습니다.");
        const name = (window.prompt("만들 조각 이름", `구도 ${list.slice(0, 2).map((item) => item.norm).join(" · ")}`) || "").trim();
        if (!name) return;
        if (!window.confirm(`긍정프롬프트의 구도 태그 ${list.length}개를 "📷 구도" 그룹의 조각 "${name}"(으)로 만들고, 긍정프롬프트에서는 뺄까요?`)) return;
        const result = window.createCompositionPiece(name, list.map((item) => item.raw).join(", "));
        if (!result || !result.ok) return toast((result && result.error) || "조각을 만들지 못했습니다.");
        const set = new Set(list.map((item) => item.norm));
        writeBasePos(stripPromptTags(target.value, (n) => set.has(n)));
        lastInserted = "";
        saveStoreNow();
        refreshRecognized();
        toast(`"${result.categoryName}" 그룹에 조각 "${name}"을(를) 만들었습니다.`);
    }, "camera-make-piece-btn");
    const invLabel = element("label");
    invLabel.style.cssText = "display:flex; gap:8px; align-items:center; cursor:pointer; font-weight:650; margin-top:4px;";
    const invCheck = element("input");
    invCheck.type = "checkbox";
    invCheck.id = "camera-invalidate-all";
    invCheck.checked = invalidateAll;
    invLabel.append(invCheck, element("span", "", "긍정프롬프트의 구도 태그 전부 무효화 (생성할 때 제외)"));
    const linkNote = element("div", "am-camera-help");
    linkNote.id = "camera-link-note";
    function refreshLinkNote() {
        const messages = [];
        if (invalidateAll && !autoApply && syncBasePos) messages.push("⚠️ 지금 설정에서는 자동 반영한 구도도 생성할 때 제외됩니다. 이 도구의 구도를 쓰려면 아래 \"생성에 자동 적용\"을 켜세요.");
        else if (invalidateAll) messages.push(autoApply ? "켜짐 — 긍정프롬프트·조각에 든 구도 태그는 모두 빠지고 이 도구의 구도만 붙습니다." : "켜짐 — 긍정프롬프트·조각에 든 구도 태그가 생성에서 모두 빠집니다.");
        else messages.push("꺼짐 — 위 태그 칩으로 하나씩 끌 수도 있고, 켜면 한꺼번에 끕니다.");
        if (autoApply && autoMode === "random" && syncBasePos) messages.push("⚠️ 프리셋 랜덤은 생성마다 새 구도를 붙이므로, 자동 반영해 둔 구도는 생성할 때 그 구도로 교체됩니다.");
        linkNote.textContent = messages.join(" ");
    }
    function refreshRecognized() {
        const target = document.getElementById("base-pos");
        const list = recognizeCompositionTags(target ? target.value : "");
        recChips.replaceChildren();
        if (!list.length) recChips.appendChild(element("span", "am-camera-help", target ? "인식된 구도 태그가 없습니다." : "공통 긍정프롬프트 칸을 찾지 못했습니다."));
        for (const { raw, norm } of list) {
            const off = invalidateAll || offTags.has(norm);
            const chip = element("span", "", raw);
            chip.className = "am-camera-chip";
            chip.dataset.norm = norm;
            chip.dataset.off = off ? "1" : "0";
            chip.style.cssText = `display:inline-block; padding:2px 8px; border-radius:5px; font-size:12px; cursor:pointer; user-select:none; ${off
                ? "background:#33333388; color:#888; text-decoration:line-through; border:1px dashed #555;"
                : "background:#1f3a44; color:#7fdcf0; border:1px solid #2f6a7a;"}`;
            chip.title = invalidateAll ? "\"전부 무효화\"가 켜져 있어 모두 꺼진 상태입니다" : off ? "꺼짐 — 클릭: 다시 켜기" : "클릭: 이 구도 태그를 생성에서 끄기";
            chip.addEventListener("click", () => {
                if (invalidateAll) return toast("\"전부 무효화\"를 먼저 끄면 태그별로 켜고 끌 수 있습니다.");
                if (offTags.has(norm)) offTags.delete(norm); else offTags.add(norm);
                saveStoreNow();
                refreshRecognized();
            });
            recChips.appendChild(chip);
        }
        makePieceBtn.disabled = !list.length;
    }
    syncCheck.addEventListener("change", () => { syncBasePos = syncCheck.checked; saveStoreNow(); refreshLinkNote(); });
    invCheck.addEventListener("change", () => { invalidateAll = invCheck.checked; saveStoreNow(); refreshRecognized(); refreshLinkNote(); });
    const baseTextarea = document.getElementById("base-pos");
    if (baseTextarea) baseTextarea.addEventListener("input", () => refreshRecognized());
    linkBox.append(syncLabel, linkButtons, recHead, recChips, recHelp, makePieceBtn, invLabel, linkNote);
    root.appendChild(linkBox);


    const applyBox = element("div", "am-camera-apply");
    applyBox.id = "camera-auto-apply-box";
    const applyLabel = element("label");
    applyLabel.style.cssText = "display:flex; gap:8px; align-items:center; cursor:pointer; font-weight:650;";
    const applyCheck = element("input");
    applyCheck.type = "checkbox";
    applyCheck.id = "camera-auto-apply";
    applyCheck.checked = autoApply;
    applyLabel.append(applyCheck, element("span", "", "생성할 때 이 구도를 긍정프롬프트 뒤에 자동으로 붙이기"));
    const modeRow = element("div");
    modeRow.style.cssText = "display:flex; gap:8px; align-items:center; flex-wrap:wrap;";
    const modeSelect = element("select");
    modeSelect.id = "camera-auto-mode";
    modeSelect.style.flex = "0 1 auto";
    [["current", "위에서 맞춘 구도 그대로"], ["random", "저장된 프리셋 중 매번 랜덤"]].forEach(([value, text]) => {
        const option = element("option", "", text); option.value = value; modeSelect.appendChild(option);
    });
    modeSelect.value = autoMode;
    modeSelect.disabled = !autoApply;
    modeRow.append(element("span", "am-camera-help", "구도 선택 방식:"), modeSelect);
    const applyHelp = element("div", "am-camera-help");
    function refreshApplyHelp() {
        applyHelp.textContent = autoApply
            ? (autoMode === "random"
                ? `켜짐 — 생성할 때마다 프리셋 ${config.camera_presets.length}개 중 하나를 무작위로 골라 (좌표 + 그 프리셋의 사용자 프롬프트) 붙입니다. 롤은 위 값 그대로.`
                : "켜짐 — 생성할 때마다 위에서 맞춘 구도(프롬프트 칸의 내용)를 그대로 붙입니다.")
            : "꺼짐 — 위 구도는 이 화면에서만 쓰이고 생성에는 영향이 없습니다. (NAI는 \"가중치 제거\"를 켜면 가중치 없는 태그로 나옵니다)";
    }
    applyCheck.addEventListener("change", () => {
        autoApply = applyCheck.checked;
        modeSelect.disabled = !autoApply;
        refreshApplyHelp();
        refreshLinkNote();
        saveStoreNow();
    });
    modeSelect.addEventListener("change", () => {
        autoMode = modeSelect.value === "random" ? "random" : "current";
        refreshApplyHelp();
        refreshLinkNote();
        saveStoreNow();
    });
    refreshApplyHelp();
    applyBox.append(applyLabel, modeRow, applyHelp);
    root.appendChild(applyBox);

    root.appendChild(element("div", "am-camera-help", "카메라 구도 알고리즘과 조작 방식은 ComfyUI-KR-Camera-Control(원본: ComfyUI_bsk_UI, © 2026 灰暗x, AGPL-3.0-or-later)에서 가져와 AssetManager용으로 수정한 것입니다."));
    host.appendChild(root);
    updateAll();
    uiReady = true;
    refreshRecognized();
    refreshLinkNote();
    return { updateAll, applySnapshot, applyPreset, refreshPresets, snapshot, refreshRecognized };
}

let uiApi = null;
function renderCameraTool() {
    const host = document.getElementById("camera-root");
    if (!host) return null;
    if (!host.dataset.ready) {
        uiApi = createCameraUI(host);
        host.dataset.ready = "1";
    }
    return uiApi;
}

window.renderCameraTool = renderCameraTool;
window.getCameraCompositionPrompt = getCameraCompositionPrompt;
window.openCameraPopup = openCameraPopup;
window.closeCameraPopup = closeCameraPopup;
window.toggleCameraPopup = toggleCameraPopup;
/* ══════ 🆕 기능 확장: 프리셋 전체 각도 일괄 생성 ══════
 * "프리셋 랜덤" 자동적용은 생성 1번마다 프리셋 중 하나를 "무작위로" 골라 쓰는 기능이고,
 * 이건 그거랑 달리 등록된 프리셋 "전부를 순서대로 한 번씩" 생성한다 — 캐릭터 시트처럼
 * 여러 각도를 한 번에 뽑고 싶을 때 쓰는 용도. generate.js의 executeGeneration()을 그대로
 * 재사용해서 프리셋 개수만큼 순차 호출(한 장 끝나야 다음 장 시작 — 동시에 여러 장 안 쏨). */
async function generateAllPresetAngles() {
    const presets = config.camera_presets;
    if (!presets || presets.length === 0) {
        alert("등록된 프리셋이 없습니다. 먼저 프리셋을 저장해주세요.");
        return;
    }
    if (typeof window.executeGeneration !== "function") {
        alert("생성 함수를 찾지 못했습니다(generate.js가 아직 로드되지 않았을 수 있습니다).");
        return;
    }
    if (!window.confirm(`등록된 프리셋 ${presets.length}개를 각각 1장씩, 총 ${presets.length}장을 순서대로 생성합니다.\n(한 장씩 차례로 생성되며 시간이 걸릴 수 있습니다) 계속할까요?`)) return;

    const basePosEl = document.getElementById("base-pos");
    const baseNegEl = document.getElementById("base-neg");
    const actionEl = document.getElementById("action-pos");
    if (!basePosEl) { alert("공통 긍정 프롬프트 칸을 찾지 못했습니다."); return; }

    const basePosRaw = basePosEl.value;
    const negText = baseNegEl ? baseNegEl.value : "";
    const actionText = actionEl?.value?.trim();
    const statusEl = document.getElementById("camera-recognized"); // 별도 상태 UI를 새로 안 만들고 기존 표시줄 재사용

    // 이 배치가 도는 동안엔 "프리셋 랜덤 자동적용"이 매번 또 임의로 하나를 더 끼워넣지 않도록 잠깐 꺼둔다
    // (각 반복에서 내가 원하는 그 프리셋의 구도를 직접 넣을 거라서, 자동적용까지 겹치면 충돌이 생김).
    const prevAutoApply = autoApply;
    autoApply = false;

    try {
        for (let i = 0; i < presets.length; i++) {
            if (window.isGenerationCancelled) break;
            const preset = presets[i];
            if (statusEl) statusEl.textContent = `⏳ [${i + 1}/${presets.length}] "${preset.name}" 생성 중...`;

            const comp = appendUserPrompt(
                computePrompt(preset.pos_x, preset.pos_y, preset.pos_z, state.roll, config),
                preset.user_prompt
            );
            const replaced = replaceCompositionInPrompt(basePosRaw, comp);
            const combined = actionText ? `${replaced}, ${actionText}` : replaced;
            // applyDisabledTokens가 내부적으로 applyCameraCompositionToPrompt도 거치는데, 위에서
            // autoApply를 꺼둬서 "랜덤 재주입"은 안 일어나고, invalidateAll/offTags로 사용자가 끈
            // 구도 태그만 (설정해뒀다면) 그대로 반영됨 — 이건 의도된 동작이라 그대로 둠.
            const finalPos = (typeof window.applyDisabledTokens === "function") ? window.applyDisabledTokens(combined) : combined;

            try {
                await window.executeGeneration(finalPos, negText, `MultiAngle_${preset.name}`);
            } catch (e) {
                console.error(`[Camera] "${preset.name}" 생성 실패:`, e);
            }
        }
        if (statusEl) statusEl.textContent = window.isGenerationCancelled
            ? "⏹ 일괄 생성이 중단되었습니다."
            : `✅ 프리셋 ${presets.length}개 일괄 생성 완료`;
    } finally {
        autoApply = prevAutoApply;
    }
}
window.generateAllPresetAngles = generateAllPresetAngles;

window.applyCameraCompositionToPrompt = applyCameraCompositionToPrompt;
window.invalidateCameraCompositionTags = invalidateCameraCompositionTags;
/** 조각 편집창 등에서 쓰는 인식기: 글자 안의 구도 태그 원문 목록(중복 제외) */
window.recognizeCameraCompositionTags = (text) => recognizeCompositionTags(text).map((item) => item.raw);
// 테스트/디버깅용 (알고리즘이 원본과 같은 결과를 내는지 비교하는 데 쓰임)
window.__amCamera = { computePrompt, computePlainPrompt, loadConfig, appendUserPrompt, computeCurrentPrompt, DEFAULT_CONFIG, state, getConfig: () => config, getSettings: () => ({ autoApply, autoMode, syncBasePos, invalidateAll, offTags: [...offTags], lastInserted }), normCompTag, recognizeCompositionTags, replaceCompositionInPrompt, stripPromptTags, applyCompositionToBasePos };
})();
