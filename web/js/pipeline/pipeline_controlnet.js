/**
 * pipeline_controlnet.js — 컨트롤넷 파이프라인 모듈
 * workflow.json에는 ControlNet 관련 노드가 없으므로, IP-Adapter/Anima 분기와 동일한
 * 방식으로 promptData에 노드를 "동적으로 신설"하여 KSampler의 positive/negative
 * conditioning을 ControlNetApplyAdvanced 출력으로 교체한다.
 *
 * 의존: window.uploadControlNetImage (ComfyUI /upload/image 멀티파트 업로드)
 *       window._controlnetUploadedName (index.html에서 파일 선택 시 세팅)
 *
 * UI 요소 (index.html에 추가 필요):
 *   #toggle-controlnet          (체크박스)
 *   #controlnet-image-input     (file input)
 *   #controlnet-preprocessor    (select: CannyEdgePreprocessor / DepthAnythingV2Preprocessor /
 *                                          OpenposePreprocessor / LineArtPreprocessor)
 *   #controlnet-model           (select: ControlNetLoader용 .safetensors 목록)
 *   #controlnet-strength        (range/number, 기본 1.0)
 *   #controlnet-start           (number, 기본 0.0)
 *   #controlnet-end             (number, 기본 1.0)
 */

/**
 * 업로드용 헬퍼. ComfyUI 표준 /upload/image 엔드포인트로 파일을 전송하고
 * 서버가 반환한 파일명을 그대로 LoadImage 노드의 image 입력값으로 사용한다.
 * @param {File} file
 * @returns {Promise<string>} 업로드된 이미지의 서버측 파일명
 */
async function uploadControlNetImage(file) {
    const formData = new FormData();
    formData.append("image", file);
    formData.append("type", "input");
    formData.append("overwrite", "true");

    const res = await fetch("/upload/image", { method: "POST", body: formData });
    if (!res.ok) throw new Error(`ControlNet 이미지 업로드 실패 (HTTP ${res.status})`);
    const data = await res.json();
    if (!data.name) throw new Error("ControlNet 이미지 업로드 응답에 name이 없습니다.");
    // 서브폴더 업로드 시 ComfyUI LoadImage는 "subfolder/filename" 형식을 기대함
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}
window.uploadControlNetImage = uploadControlNetImage;

/**
 * 컨트롤넷 파이프라인을 워크플로우에 적용.
 * KSampler의 positive/negative 입력을 ControlNetApplyAdvanced 출력으로 교체한다.
 * @param {Object} promptData - 워크플로우 JSON (딥카피본)
 * @param {Function} findNodeIdByTitle - 노드 타이틀로 ID를 검색하는 함수
 * @param {Object|null} overrides - 라이브러리 조각 전용 설정을 쓸 때 DOM 대신 직접 전달
 *        { enabled, imageName(이미 업로드된 서버 파일명), preprocessor, model, strength, start, end }
 * @returns {Promise<void>}
 */
async function applyControlNetPipeline(promptData, findNodeIdByTitle, overrides = null) {
    let isOn, imageName, preprocessorType, modelName, strength, startPercent, endPercent;

    if (overrides) {
        isOn = !!overrides.enabled;
        if (!isOn) return;
        imageName = overrides.imageName || null;
        if (!imageName) {
            console.warn("[ControlNet] 조각 전용 설정에 이미지가 없어 파이프라인을 건너뜁니다.");
            return;
        }
        preprocessorType = overrides.preprocessor || "CannyEdgePreprocessor";
        modelName = overrides.model;
        strength = (overrides.strength !== undefined && overrides.strength !== null) ? parseFloat(overrides.strength) : 1.0;
        startPercent = (overrides.start !== undefined && overrides.start !== null) ? parseFloat(overrides.start) : 0.0;
        endPercent = (overrides.end !== undefined && overrides.end !== null) ? parseFloat(overrides.end) : 1.0;
    } else {
        isOn = document.getElementById('toggle-controlnet')?.checked;
        if (!isOn) return; // 끄면 추가 노드 자체가 없으므로 정리할 것도 없음

        /* 이미지 확보: 이미 업로드돼 있으면 재사용, 아니면 지금 업로드 */
        imageName = window._controlnetUploadedName;
        const fileInput = document.getElementById('controlnet-image-input');
        if (!imageName && fileInput?.files?.[0]) {
            imageName = await uploadControlNetImage(fileInput.files[0]);
            window._controlnetUploadedName = imageName;
        }
        if (!imageName) {
            console.warn("[ControlNet] 업로드된 이미지가 없어 파이프라인을 건너뜁니다.");
            return;
        }

        preprocessorType = document.getElementById('controlnet-preprocessor')?.value || "CannyEdgePreprocessor";
        modelName = document.getElementById('controlnet-model')?.value;
        strength = parseFloat(document.getElementById('controlnet-strength')?.value || "1.0");
        startPercent = parseFloat(document.getElementById('controlnet-start')?.value || "0.0");
        endPercent = parseFloat(document.getElementById('controlnet-end')?.value || "1.0");
    }

    const ksamplerId = findNodeIdByTitle(promptData, "[Main] KSampler");
    const positiveT2CId = findNodeIdByTitle(promptData, "[Main] T2C(Positive)");
    const negativeT2CId = findNodeIdByTitle(promptData, "[Main] T2C(Negative)");
    if (!ksamplerId || !positiveT2CId || !negativeT2CId) {
        console.warn("[ControlNet] 필요한 노드를 찾지 못해 파이프라인을 건너뜁니다.");
        return;
    }

    /* ── 노드 신설: LoadImage → AIO_Preprocessor → ControlNetLoader → ControlNetApplyAdvanced ── */
    promptData["cn_loadimage_001"] = {
        inputs: { image: imageName, upload: "image" },
        class_type: "LoadImage",
        _meta: { title: "[ControlNet] Load Image" }
    };

    promptData["cn_preprocessor_001"] = {
        /* resolution은 보통 512~1024 사이에서 큰 영향 없음. 필요시 UI에 노출 가능 */
        inputs: {
            image: ["cn_loadimage_001", 0],
            preprocessor: preprocessorType,
            resolution: 512
        },
        class_type: "AIO_Preprocessor",
        _meta: { title: "[ControlNet] Preprocessor" }
    };

    promptData["cn_loader_001"] = {
        inputs: { control_net_name: modelName },
        class_type: "ControlNetLoader",
        _meta: { title: "[ControlNet] Model Loader" }
    };

    promptData["cn_apply_001"] = {
        inputs: {
            positive: [positiveT2CId, 0],
            negative: [negativeT2CId, 0],
            control_net: ["cn_loader_001", 0],
            image: ["cn_preprocessor_001", 0],
            strength: strength,
            start_percent: startPercent,
            end_percent: endPercent,
            vae: null
        },
        class_type: "ControlNetApplyAdvanced",
        _meta: { title: "[ControlNet] Apply Advanced" }
    };
    /* vae 입력이 필요 없는 ComfyUI 버전도 있으므로 null이면 제거 (옛 시그니처 호환) */
    if (promptData["cn_apply_001"].inputs.vae === null) {
        delete promptData["cn_apply_001"].inputs.vae;
    }

    /* KSampler가 ControlNet이 적용된 conditioning을 사용하도록 교체 */
    if (promptData[ksamplerId]?.inputs) {
        promptData[ksamplerId].inputs.positive = ["cn_apply_001", 0];
        promptData[ksamplerId].inputs.negative = ["cn_apply_001", 1];
    }
}

window.applyControlNetPipeline = applyControlNetPipeline;
