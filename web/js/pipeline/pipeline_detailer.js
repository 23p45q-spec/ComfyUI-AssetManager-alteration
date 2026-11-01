/**
 * pipeline_detailer.js — 디테일러(A-Detailer) 파이프라인 모듈
 * 얼굴(Face), 눈(Eye), 입(Mouth), 손(Hand) 디테일러를
 * 워크플로우에 동적으로 연결하거나 삭제합니다.
 * 각 디테일러는 독립적으로 ON/OFF 가능하며, 활성화된 디테일러가
 * 체인 형태로 이전 파이프라인 출력에 순차 연결됩니다.
 */

/**
 * 디테일러 파이프라인을 워크플로우에 적용.
 * @param {Object} promptData - 워크플로우 JSON (딥카피본)
 * @param {Array} currentImageSource - 현재 파이프라인 끝단
 * @param {Function} findNodeIdByTitle - 노드 타이틀로 ID를 검색하는 함수
 * @returns {Array} 새로운 파이프라인 끝단
 */
function applyDetailerPipeline(promptData, currentImageSource, findNodeIdByTitle) {
    let currentPipe = currentImageSource;
    const isGlobalDetailerOn = document.getElementById('toggle-detailer')?.checked;

    /**
     * 개별 디테일러를 파이프에 연결하거나 관련 노드를 삭제하는 내부 유틸.
     * @param {string} prefix - 디테일러 이름 접두사 (Face, Eye, Mouth, Hand)
     * @param {string} domToggleId - 디테일러 ON/OFF 체크박스 DOM ID
     * @param {string} domModelId - 모델 선택 드롭다운 DOM ID
     * @param {string} defaultModel - 기본 모델 경로
     */
    const processDetailer = (prefix, domToggleId, domModelId, defaultModel) => {
        const detailerId = findNodeIdByTitle(promptData, `[Detailer] ${prefix} Detailer`);
        const isDetailerOn = isGlobalDetailerOn && document.getElementById(domToggleId)?.checked;

        const previewId = findNodeIdByTitle(promptData, `[Detailer] ${prefix} Detailer Image Preview`);
        if (previewId) delete promptData[previewId];

        if (isDetailerOn && detailerId) {
            promptData[detailerId].inputs.image = currentPipe;

            const modelNodeId = findNodeIdByTitle(promptData, `[Detailer] ${prefix} Detailer Model(BBOX)`);
            if (modelNodeId) {
                promptData[modelNodeId].inputs.model_name = document.getElementById(domModelId)?.value || defaultModel;
            }
            currentPipe = [detailerId, 0];
        } else if (detailerId) {
            const toDelete = [
                `[Detailer] ${prefix} Detailer`,
                `[Detailer] ${prefix} Detailer Model(BBOX)`,
                `[Detailer] ${prefix} Detailer Model(SAML)`,
                `[Detailer] ${prefix} Detailer ToDetailerPipe`,
                `[Detailer] ${prefix} Detailer Image Save`
            ];
            toDelete.forEach(title => {
                const id = findNodeIdByTitle(promptData, title);
                if (id) delete promptData[id];
            });
        }
    };

    processDetailer("Face", "detailer-face-toggle", "detailer-face-model", "bbox/face_yolov8m.pt");
    processDetailer("Eye", "detailer-eye-toggle", "detailer-eye-model", "segm/PitEyeDetailer-v2-seg.pt");
    processDetailer("Mouth", "detailer-mouth-toggle", "detailer-mouth-model", "bbox/face_yolov8m.pt");
    processDetailer("Hand", "detailer-hand-toggle", "detailer-hand-model", "bbox/hand_yolov8s.pt");

    /* 전체 디테일러 비활성화 시 공통 스케줄러 어댑터도 삭제 */
    if (!isGlobalDetailerOn) {
        const schedulerAdapterId = findNodeIdByTitle(promptData, "[Detailer] Scheduler Adapter");
        if (schedulerAdapterId) delete promptData[schedulerAdapterId];
    }

    return currentPipe;
}

window.applyDetailerPipeline = applyDetailerPipeline;
