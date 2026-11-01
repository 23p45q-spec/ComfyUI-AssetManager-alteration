/**
 * pipeline_img2img.js — 이미지 투 이미지(Img2Img) 파이프라인
 *
 * 동작 방식:
 *   1. uploadImg2ImgImage() : 파일을 ComfyUI /upload/image API로 즉시 업로드 (index.html 핸들러에서 호출)
 *   2. applyImg2ImgPipeline(): executeGeneration() 내부에서 호출
 *        - LoadImage 노드 동적 삽입 → VAEEncode → KSampler.latent_image 교체
 *        - KSampler.denoise 를 UI 슬라이더 값으로 교체
 *        - [Main] Latent Image 노드 제거 (orphan 방지)
 */

(function () {

    /* ── 업로드된 파일명 캐시 ── */
    window._img2imgUploadedName = null;

    /**
     * 파일을 ComfyUI에 업로드하고 서버 저장 파일명을 반환한다.
     * index.html의 handleImg2ImgImageSelect / _applyImg2ImgFile 에서 호출.
     */
    window.uploadImg2ImgImage = async function (file) {
        const formData = new FormData();
        formData.append('image', file);
        formData.append('overwrite', 'true');

        const resp = await fetch('/upload/image', { method: 'POST', body: formData });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const result = await resp.json();

        /* ComfyUI 응답: { name, subfolder, type } */
        const savedName = result.name || file.name;
        window._img2imgUploadedName = savedName;
        return savedName;
    };

    /**
     * executeGeneration() 에서 호출되는 워크플로우 패치 함수.
     * toggle-img2img 가 꺼져 있으면 즉시 반환한다.
     * @param {Object|null} overrides - 라이브러리 조각 전용 설정을 쓸 때 DOM 대신 직접 전달
     *        { enabled, imageName(이미 업로드된 서버 파일명), denoise }
     */
    window.applyImg2ImgPipeline = async function (promptData, findNodeIdByTitle, overrides = null) {
        let enabled, uploadedName, denoiseVal;

        if (overrides) {
            enabled = !!overrides.enabled;
            uploadedName = overrides.imageName || null;
            denoiseVal = (overrides.denoise !== undefined && overrides.denoise !== null) ? parseFloat(overrides.denoise) : 0.65;
            if (!enabled) return;
            if (!uploadedName) {
                console.warn('[Img2Img] 조각 전용 설정에 이미지가 없어 파이프라인을 건너뜁니다.');
                return;
            }
        } else {
            const toggle = document.getElementById('toggle-img2img');
            if (!toggle || !toggle.checked) return;

            /* 업로드된 이미지가 없으면 그 자리에서 업로드 재시도 */
            uploadedName = window._img2imgUploadedName;
            if (!uploadedName) {
                const fileInput = document.getElementById('img2img-image-input');
                if (fileInput && fileInput.files && fileInput.files[0]) {
                    try {
                        uploadedName = await window.uploadImg2ImgImage(fileInput.files[0]);
                    } catch (e) {
                        console.error('[Img2Img] 업로드 재시도 실패:', e);
                    }
                }
            }

            if (!uploadedName) {
                const statusEl = document.getElementById('img2img-upload-status');
                if (statusEl) statusEl.textContent = '⚠️ 이미지를 먼저 선택해주세요';
                console.warn('[Img2Img] 이미지가 없어 파이프라인을 건너뜁니다.');
                return;
            }

            denoiseVal = parseFloat(document.getElementById('img2img-denoise')?.value || '0.65');
        }

        const ksamplerId = findNodeIdByTitle(promptData, "[Main] KSampler");

        if (!ksamplerId) {
            console.warn('[Img2Img] [Main] KSampler 노드를 찾을 수 없습니다.');
            return;
        }

        /* ── 동적 노드 추가 ── */
        const loadImageId = 'img2img_load_001';
        const vaeEncodeId = 'img2img_vae_encode_001';

        /* VAE 소스: 커스텀 VAE가 있으면 그것을, 없으면 체크포인트 내장(출력 슬롯 2) 사용 */
        let vaeSource;
        if (promptData['vae_custom_001']) {
            vaeSource = ['vae_custom_001', 0];
        } else {
            const ckptId = findNodeIdByTitle(promptData, "[Main] ckpt loader");
            vaeSource = [ckptId, 2];
        }

        promptData[loadImageId] = {
            inputs: { image: uploadedName, upload: 'image' },
            class_type: 'LoadImage',
            _meta: { title: '[Img2Img] Load Image' }
        };

        promptData[vaeEncodeId] = {
            inputs: {
                pixels: [loadImageId, 0],
                vae: vaeSource
            },
            class_type: 'VAEEncode',
            _meta: { title: '[Img2Img] VAE Encode' }
        };

        /* ── KSampler 패치 ── */
        promptData[ksamplerId].inputs.latent_image = [vaeEncodeId, 0];
        promptData[ksamplerId].inputs.denoise = denoiseVal;

        /* ── [Main] Latent Image 노드 제거 (이제 연결되지 않으므로 orphan 방지) ── */
        const latentNodeId = findNodeIdByTitle(promptData, "[Main] Latent Image");
        if (latentNodeId) delete promptData[latentNodeId];

        console.log(`[Img2Img] 적용 완료 — 이미지: ${uploadedName}, denoise: ${denoiseVal}`);
    };

})();
