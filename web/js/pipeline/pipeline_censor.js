/**
 * pipeline_censor.js — 검열(모자이크/화이트마스크) 파이프라인 모듈
 * workflow.json에 정의된 [Censor] 노드들을 타이틀 기반으로 탐색하여
 * 동적으로 연결하거나 삭제합니다.
 *
 * 지원되는 검열 모드:
 *   - mosaic : 모자이크 다운스케일/업스케일 + 마스크 합성
 *   - white : 흰색 캔버스 + 가장자리 블러 마스크 합성
 *   - white_solid : 흰색 캔버스 + 블러 없이 원본 마스크 직접 합성
 */

/**
 * 검열 파이프라인을 워크플로우에 적용.
 * @param {Object} promptData - 워크플로우 JSON (딥카피본)
 * @param {Array} currentImageSource - 현재 파이프라인 끝단
 * @param {Function} findNodeIdByTitle - 노드 타이틀로 ID를 검색하는 함수
 * @param {Object|null} overrides - 단독 도구에서 사용할 때 DOM 대신 직접 전달하는 파라미터
 * @returns {Array} 새로운 파이프라인 끝단
 */
function applyCensorPipeline(promptData, currentImageSource, findNodeIdByTitle, overrides = null) {
    let isCensorOn, labels = [], censorMode, censorIntensity;

    if (overrides) {
        isCensorOn = overrides.isCensorOn;
        labels = overrides.labels || [];
        censorMode = overrides.censorMode || 'mosaic';
        censorIntensity = overrides.censorIntensity || 15;
    } else {
        isCensorOn = document.getElementById('toggle-mosaic') && document.getElementById('toggle-mosaic').checked;
        if (document.getElementById('censor-nipples')?.checked) labels.push('nipples');
        if (document.getElementById('censor-pussy')?.checked) labels.push('pussy');
        if (document.getElementById('censor-penis')?.checked) labels.push('penis');
        if (document.getElementById('censor-anus')?.checked) labels.push('anus');
        if (document.getElementById('censor-testicles')?.checked) labels.push('testicles');
        if (document.getElementById('censor-xray')?.checked) labels.push('x-ray');
        if (document.getElementById('censor-cross-section')?.checked) labels.push('cross-section');
        censorMode = document.getElementById('censor-mode')?.value || 'mosaic';
        censorIntensity = parseInt(document.getElementById('censor-intensity')?.value || '15', 10);
    }

    /* 검열에 사용되는 전체 노드 타이틀 목록 */
    const allCensorTitles = [
        "[Censor] NSFW Segm Detector", "[Censor] SEGS Extractor", "[Censor] Combined Mask",
        "[Censor] Mosaic Downscale", "[Censor] Mosaic Upscale", "[Censor] Mosaic Composite",
        "[Censor] White Canvas", "[Censor] White Edge Blur", "[Censor] White Mask Composite",
        "[Censor] Image Save"
    ];

    /* 검열 비활성화 또는 타겟 부위 미선택 시 관련 노드 전부 삭제 */
    if (!isCensorOn || labels.length === 0) {
        allCensorTitles.forEach(title => { const id = findNodeIdByTitle(promptData, title); if (id) delete promptData[id]; });
        return currentImageSource;
    }

    if (isNaN(censorIntensity) || censorIntensity < 1) censorIntensity = 15;
    const labelsStr = labels.join(',');

    /* 노드 ID 탐색 */
    const segsExtractorId = findNodeIdByTitle(promptData, "[Censor] SEGS Extractor");
    const combinedMaskId = findNodeIdByTitle(promptData, "[Censor] Combined Mask");
    const mosaicDownId = findNodeIdByTitle(promptData, "[Censor] Mosaic Downscale");
    const mosaicUpId = findNodeIdByTitle(promptData, "[Censor] Mosaic Upscale");
    const mosaicCompositeId = findNodeIdByTitle(promptData, "[Censor] Mosaic Composite");
    const whiteCanvasId = findNodeIdByTitle(promptData, "[Censor] White Canvas");
    const whiteBlurId = findNodeIdByTitle(promptData, "[Censor] White Edge Blur");
    const whiteCompositeId = findNodeIdByTitle(promptData, "[Censor] White Mask Composite");
    const censorSaveId = findNodeIdByTitle(promptData, "[Censor] Image Save");

    /* 공통: 입력 이미지와 라벨/확장(dilation) 설정 */
    if (segsExtractorId) {
        promptData[segsExtractorId].inputs.image = currentImageSource;
        promptData[segsExtractorId].inputs.labels = labelsStr;
        promptData[segsExtractorId].inputs.dilation = Math.round(censorIntensity * 2);
    }

    let finalImageSource = currentImageSource;

    if (censorMode === 'mosaic') {
        /* 모자이크 모드: White 관련 노드 삭제 */
        [whiteCanvasId, whiteBlurId, whiteCompositeId].forEach(id => { if (id) delete promptData[id]; });

        const mappedScale = Math.min((censorIntensity / 50) * 8.0, 8.0);
        const downFactor = Math.max(0.01, 1.0 / mappedScale);
        if (mosaicDownId) { promptData[mosaicDownId].inputs.image = currentImageSource; promptData[mosaicDownId].inputs.scale_by = downFactor; }
        if (mosaicUpId) { promptData[mosaicUpId].inputs.scale_by = mappedScale; }
        if (mosaicCompositeId) { promptData[mosaicCompositeId].inputs.destination = currentImageSource; finalImageSource = [mosaicCompositeId, 0]; }
        if (censorSaveId) { promptData[censorSaveId].inputs.images = finalImageSource; }

    } else if (censorMode === 'white') {
        /* 흰색 블러 마스크 모드: Mosaic 관련 노드 삭제 */
        [mosaicDownId, mosaicUpId, mosaicCompositeId].forEach(id => { if (id) delete promptData[id]; });

        if (whiteBlurId) { promptData[whiteBlurId].inputs.kernel_size = censorIntensity; promptData[whiteBlurId].inputs.sigma = censorIntensity / 2.0; }
        if (whiteCompositeId) { promptData[whiteCompositeId].inputs.destination = currentImageSource; finalImageSource = [whiteCompositeId, 0]; }
        if (censorSaveId) { promptData[censorSaveId].inputs.images = finalImageSource; }

    } else if (censorMode === 'white_solid') {
        /* 흰색 통짜 모드: Mosaic 및 Blur 노드 모두 삭제 */
        [mosaicDownId, mosaicUpId, mosaicCompositeId, whiteBlurId].forEach(id => { if (id) delete promptData[id]; });

        if (whiteCompositeId) {
            promptData[whiteCompositeId].inputs.destination = currentImageSource;
            if (combinedMaskId) { promptData[whiteCompositeId].inputs.mask = [combinedMaskId, 0]; }
            finalImageSource = [whiteCompositeId, 0];
        }
        if (censorSaveId) { promptData[censorSaveId].inputs.images = finalImageSource; }
    }

    return finalImageSource;
}

window.applyCensorPipeline = applyCensorPipeline;
