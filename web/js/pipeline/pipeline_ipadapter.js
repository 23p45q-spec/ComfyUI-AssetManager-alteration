/**
 * pipeline_ipadapter.js — IP-Adapter 파이프라인 모듈
 */

async function uploadIPAdapterImage(file) {
    const form = new FormData();
    form.append('image', file);
    form.append('type', 'input');
    form.append('overwrite', 'true');
    try {
        const res = await fetch('/upload/image', { method: 'POST', body: form });
        if (!res.ok) throw new Error(`업로드 실패: ${res.status}`);
        const data = await res.json();
        return data.name;
    } catch (e) {
        console.error('[IPAdapter] 이미지 업로드 오류:', e);
        throw e;
    }
}

async function applyIPAdapterPipeline(promptData, findNodeIdByTitle) {
    const isOn = document.getElementById('toggle-ipadapter')?.checked;

    const ksamplerId = findNodeIdByTitle(promptData, "[Main] KSampler");
    if (!ksamplerId) {
        console.warn('[IPAdapter] [Main] KSampler 노드를 찾을 수 없습니다.');
        return;
    }

    // IPAdapter OFF — 혹시 베이스 워크플로우에 남아있는 ipadapter 참조 정리
    if (!isOn) {
        const loraId = findNodeIdByTitle(promptData, "[Main] Lora Loader");
        if (loraId && promptData[ksamplerId].inputs.model?.[0] === 'ipadapter_apply_001') {
            promptData[ksamplerId].inputs.model = [loraId, 0];
        }
        delete promptData['ipadapter_apply_001'];
        delete promptData['ipadapter_loader_001'];
        delete promptData['ipadapter_clipvision_001'];
        delete promptData['ipadapter_image_001'];
        delete promptData['ipadapter_insightface_001'];
        return;
    }

    const fileInput = document.getElementById('ipadapter-image-input');
    const uploadedName = window._ipadapterUploadedName;

    if (!uploadedName && (!fileInput || !fileInput.files || fileInput.files.length === 0)) {
        console.warn('[IPAdapter] 참조 이미지가 없어 IP-Adapter를 건너뜁니다.');
        return;
    }

    let imageName = uploadedName;
    if (!imageName) {
        imageName = await uploadIPAdapterImage(fileInput.files[0]);
        window._ipadapterUploadedName = imageName;
    }

    const modelName      = document.getElementById('ipadapter-model')?.value      || 'noobIPAMARK1_mark1.safetensors';
    const clipVisionName = document.getElementById('ipadapter-clip-vision')?.value || 'CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors';
    const useClipVision  = document.getElementById('toggle-ipadapter-clipvision')?.checked !== false;
    const weight         = parseFloat(document.getElementById('ipadapter-weight')?.value      || '0.6');
    const weightType     = document.getElementById('ipadapter-weight-type')?.value || 'linear';
    const startAt        = parseFloat(document.getElementById('ipadapter-start')?.value       || '0.0');
    const endAt          = parseFloat(document.getElementById('ipadapter-end')?.value         || '1.0');

    const isFaceID = /faceid/i.test(modelName);

    // 베이스 워크플로우에 ipadapter_apply_001이 하드코딩된 경우 LoRA Loader로 교정
    let currentModelSource = promptData[ksamplerId].inputs.model;
    if (currentModelSource?.[0] === 'ipadapter_apply_001') {
        const loraId = findNodeIdByTitle(promptData, "[Main] Lora Loader");
        if (loraId) currentModelSource = [loraId, 0];
    }

    // 1. IPAdapter 모델 로더
    promptData['ipadapter_loader_001'] = {
        inputs: { ipadapter_file: modelName },
        class_type: 'IPAdapterModelLoader',
        _meta: { title: '[IPAdapter] Model Loader' }
    };

    // 2. 참조 이미지
    promptData['ipadapter_image_001'] = {
        inputs: { image: imageName, upload: 'image' },
        class_type: 'LoadImage',
        _meta: { title: '[IPAdapter] Reference Image' }
    };

    if (isFaceID) {
        // ── FaceID 모드 ──
        // ComfyUI IPAdapterFaceID 필수 입력:
        //   weight, weight_faceidv2, weight_type, combine_embeds,
        //   embeds_scaling, start_at, end_at, model, ipadapter, image, insightface
        // 주의: IPAdapterPlus의 공통 apply_ipadapter 함수가 clip_vision이 없으면
        //       "Missing CLIPVision model." 예외를 던지므로 FaceID여도 CLIP Vision을 같이 연결해야 함.

        promptData['ipadapter_insightface_001'] = {
            inputs: { provider: 'CUDA' },
            class_type: 'IPAdapterInsightFaceLoader',
            _meta: { title: '[IPAdapter] InsightFace Loader' }
        };

        promptData['ipadapter_clipvision_001'] = {
            inputs: { clip_name: clipVisionName },
            class_type: 'CLIPVisionLoader',
            _meta: { title: '[IPAdapter] CLIP Vision Loader' }
        };

        promptData['ipadapter_apply_001'] = {
            inputs: {
                weight:          weight,
                weight_faceidv2: weight,
                weight_type:     weightType,
                combine_embeds:  'concat',
                embeds_scaling:  'V only',
                start_at:        startAt,
                end_at:          endAt,
                model:           currentModelSource,
                ipadapter:       ['ipadapter_loader_001', 0],
                image:           ['ipadapter_image_001', 0],
                insightface:     ['ipadapter_insightface_001', 0],
                clip_vision:     ['ipadapter_clipvision_001', 0]
            },
            class_type: 'IPAdapterFaceID',
            _meta: { title: '[IPAdapter] Apply (FaceID)' }
        };

        console.log(`[IPAdapter] FaceID 적용 완료 — 모델: ${modelName}, weight: ${weight}, ${startAt}~${endAt}, CLIP Vision: ${clipVisionName}`);

    } else {
        // ── 일반 모드 ──

        if (useClipVision) {
            promptData['ipadapter_clipvision_001'] = {
                inputs: { clip_name: clipVisionName },
                class_type: 'CLIPVisionLoader',
                _meta: { title: '[IPAdapter] CLIP Vision Loader' }
            };
        }

        promptData['ipadapter_apply_001'] = {
            inputs: {
                weight:         weight,
                weight_type:    weightType,
                combine_embeds: 'concat',
                start_at:       startAt,
                end_at:         endAt,
                embeds_scaling: 'V only',
                model:          currentModelSource,
                ipadapter:      ['ipadapter_loader_001', 0],
                image:          ['ipadapter_image_001', 0],
                ...(useClipVision ? { clip_vision: ['ipadapter_clipvision_001', 0] } : {})
            },
            class_type: 'IPAdapterAdvanced',
            _meta: { title: '[IPAdapter] Apply' }
        };

        console.log(`[IPAdapter] 적용 완료 — 모델: ${modelName}, weight: ${weight}, ${startAt}~${endAt}, CLIP Vision: ${useClipVision ? clipVisionName : '비활성화'}`);
    }

    // KSampler model → IPAdapter 출력으로 교체
    promptData[ksamplerId].inputs.model = ['ipadapter_apply_001', 0];

    window._lastPromptData = JSON.parse(JSON.stringify(promptData));
}

window.applyIPAdapterPipeline = applyIPAdapterPipeline;
window.uploadIPAdapterImage   = uploadIPAdapterImage;
