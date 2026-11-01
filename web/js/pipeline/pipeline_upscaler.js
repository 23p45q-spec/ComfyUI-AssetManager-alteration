/**
 * pipeline_upscaler.js — 업스케일러 파이프라인 모듈
 * workflow.json에 정의된 [Upscaler] 노드들을 동적으로 연결하거나 삭제합니다.
 * 업스케일 모델(4x-UltraSharp 등)을 적용하고, 목표 배율에 맞춰
 * ImageScaleBy 노드의 scale_by 값을 자동 계산합니다.
 */

/**
 * 업스케일러 파이프라인을 워크플로우에 적용.
 * UI의 toggle-upscale 상태에 따라 노드를 연결하거나 삭제한다.
 * @param {Object} promptData - 워크플로우 JSON (딥카피본)
 * @param {Array} currentImageSource - 현재 파이프라인 끝단의 [노드ID, 출력인덱스]
 * @param {Function} findNodeIdByTitle - 노드 타이틀로 ID를 검색하는 함수
 * @returns {Array} 새로운 파이프라인 끝단의 [노드ID, 출력인덱스]
 */
function applyUpscalerPipeline(promptData, currentImageSource, findNodeIdByTitle) {
    const upscaleTargetId = findNodeIdByTitle(promptData, "[Upscaler] Image Upscale");
    const isUpscaleOn = document.getElementById('toggle-upscale')?.checked;

    const upscalePreviewId = findNodeIdByTitle(promptData, "[Upscaler] Image Preview");
    if (upscalePreviewId) delete promptData[upscalePreviewId];

    if (isUpscaleOn && upscaleTargetId) {
        /* 업스케일 모델의 출력 이미지를 파이프라인에 연결 */
        promptData[upscaleTargetId].inputs.image = currentImageSource;
        let upscaledImageSource = [upscaleTargetId, 0];

        const upscalerModelId = findNodeIdByTitle(promptData, "[Upscaler] Model Loader");
        const modelName = document.getElementById('upscale-model')?.value || "4x-UltraSharp.pth";
        if (upscalerModelId) {
            promptData[upscalerModelId].inputs.model_name = modelName;
        }

        /* 목표 배율에 맞춰 ImageScaleBy 비율을 자동 계산 */
        const ratioId = findNodeIdByTitle(promptData, "[Upscaler] Ratio");
        if (ratioId) {
            promptData[ratioId].inputs.image = upscaledImageSource;
            const targetScale = parseFloat(document.getElementById('upscale-scale').value || 1.5);
            const modelScale = modelName.includes('2x') ? 2 : (modelName.includes('8x') ? 8 : 4);
            const multiplier = targetScale / modelScale;
            promptData[ratioId].inputs.scale_by = multiplier;
            upscaledImageSource = [ratioId, 0];
        }

        const vaeEncodeId = findNodeIdByTitle(promptData, "[Upscaler] VAE Encode");
        if (vaeEncodeId) {
            promptData[vaeEncodeId].inputs.pixels = upscaledImageSource;
        }

        const upscalerVaeDecodeId = findNodeIdByTitle(promptData, "[Upscaler] VAE Decode");
        if (upscalerVaeDecodeId) {
            return [upscalerVaeDecodeId, 0];
        }
    } else {
        /* 업스케일러 비활성화: 관련 노드 전부 삭제 */
        if (upscaleTargetId) {
            const toDelete = ["[Upscaler] Model Loader", "[Upscaler] Image Upscale", "[Upscaler] Ratio",
                "[Upscaler] VAE Encode", "[Upscaler] KSampler", "[Upscaler] VAE Decode", "[Upscaler] Image Save"];
            toDelete.forEach(title => {
                const id = findNodeIdByTitle(promptData, title);
                if (id) delete promptData[id];
            });
        }
    }

    return currentImageSource;
}

window.applyUpscalerPipeline = applyUpscalerPipeline;
