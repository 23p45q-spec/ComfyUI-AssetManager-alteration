"""
api/models.py — 모델(체크포인트, 로라, 보조 모델) 목록 API
ComfyUI의 folder_paths를 통해 체크포인트/로라/업스케일러/디테일러 모델 목록을
조회하고, 각 모델의 프리뷰 이미지 파일 존재 여부도 함께 반환합니다.
"""

import os
from aiohttp import web
from server import PromptServer
import folder_paths


def setup_models_api(routes):
    """모델 관련 API 라우트를 등록한다."""

    def get_model_info(folder_name):
        """
        지정된 폴더(checkpoints/loras)의 모델 목록을 조회하고,
        각 모델 파일 옆에 프리뷰 이미지(.preview.jpeg 등)가 있는지 확인하여
        이미지 URL을 함께 반환한다.
        """
        models = folder_paths.get_filename_list(folder_name)
        result = []
        
        for model in models:
            full_path = folder_paths.get_full_path(folder_name, model)
            if not full_path: continue
            
            base, _ = os.path.splitext(full_path)
            
            # 스캔할 이미지 확장자 (우선순위 순서)
            possible_exts = [
                ".preview.jpeg", ".preview.jpg", ".preview.png",
                ".jpeg", ".jpg", ".png"
            ]
            
            img_ext = None
            for ext in possible_exts:
                if os.path.exists(base + ext):
                    img_ext = ext
                    break

            result.append({
                "name": model,
                "image_url": f"/assetmanager/api/file?folder={folder_name}&name={model}&ext={img_ext}" if img_ext else None,
                "json_url": None
            })
        return result

    @routes.get("/assetmanager/api/checkpoints")
    async def api_get_checkpoints(request):
        """체크포인트 모델 목록 반환"""
        return web.json_response({"checkpoints": get_model_info("checkpoints")})

    @routes.get("/assetmanager/api/loras")
    async def api_get_loras(request):
        """로라 모델 목록 반환"""
        return web.json_response({"loras": get_model_info("loras")})

    @routes.get("/assetmanager/api/models")
    async def api_get_aux_models(request):
        """업스케일러, 디테일러(BBOX/SEGM) 등 보조 모델 목록을 한 번에 반환"""
        aux_models = {
            "upscale": [],
            "bbox": [],
            "segm": []
        }
        
        try:
            if "upscale_models" in folder_paths.folder_names_and_paths:
                aux_models["upscale"] = folder_paths.get_filename_list("upscale_models")
                
            if "ultralytics" in folder_paths.folder_names_and_paths:
                aux_models["bbox"] = folder_paths.get_filename_list("ultralytics")
                
            if "sams" in folder_paths.folder_names_and_paths:
                aux_models["segm"] = folder_paths.get_filename_list("sams")
                
        except Exception as e:
            print(f"[ComfyUI-AssetManager] Error fetching aux models: {e}")
            
        return web.json_response(aux_models)

    @routes.get("/assetmanager/api/file")
    async def api_get_file(request):
        """모델 파일 옆의 프리뷰 이미지를 직접 반환하는 파일 서빙 엔드포인트"""
        folder = request.query.get("folder")
        name = request.query.get("name")
        ext = request.query.get("ext")
        
        if not folder or not name or not ext:
            return web.Response(status=400)
            
        full_path = folder_paths.get_full_path(folder, name)
        if not full_path:
            return web.Response(status=404)
            
        base, _ = os.path.splitext(full_path)
        target_file = base + ext
        
        if os.path.exists(target_file):
            return web.FileResponse(target_file)
        return web.Response(status=404)

    @routes.get("/assetmanager/api/model_info")
    async def api_get_model_info(request):
        """
        모델의 메타데이터 JSON 파일(.civitai.info 등)을 읽어 반환.
        StabilityMatrix가 자동 생성하는 사이드카 파일에서
        CivitAI 이미지, 태그, 설명 등의 정보를 파싱한다.
        """
        import json as json_module

        model_type = request.query.get("type", "")
        model_name = request.query.get("name", "")

        if not model_type or not model_name:
            return web.json_response({"status": "error", "message": "type과 name 파라미터가 필요합니다."}, status=400)

        folder_name = model_type
        full_path = folder_paths.get_full_path(folder_name, model_name)
        if not full_path:
            return web.json_response({"status": "error", "message": f"모델 파일을 찾을 수 없습니다: {model_name}"}, status=404)

        base, _ = os.path.splitext(full_path)

        # 메타데이터 사이드카 파일 탐색 (우선순위 순서)
        metadata_candidates = [
            base + ".civitai.info",
            base + ".metadata.json",
            base + ".json",
        ]

        info_data = None
        for candidate in metadata_candidates:
            if os.path.exists(candidate):
                try:
                    with open(candidate, "r", encoding="utf-8") as f:
                        info_data = json_module.load(f)
                    break
                except Exception as e:
                    print(f"[ComfyUI-AssetManager] 메타데이터 파싱 실패 ({candidate}): {e}")

        if not info_data:
            # 프리뷰 이미지라도 있으면 기본 정보만 반환
            preview_exts = [".preview.jpeg", ".preview.jpg", ".preview.png", ".jpeg", ".jpg", ".png"]
            preview_url = None
            for ext in preview_exts:
                if os.path.exists(base + ext):
                    preview_url = base + ext
                    break

            if preview_url:
                return web.json_response({
                    "status": "success",
                    "info": {
                        "name": model_name,
                        "preview_url": preview_url,
                    }
                })

            return web.json_response({"status": "error", "message": "메타데이터 파일을 찾을 수 없습니다."})

        # 프리뷰 이미지 경로도 함께 첨부
        preview_exts = [".preview.jpeg", ".preview.jpg", ".preview.png", ".jpeg", ".jpg", ".png"]
        for ext in preview_exts:
            if os.path.exists(base + ext):
                info_data["preview_url"] = base + ext
                break

        return web.json_response({"status": "success", "info": info_data})

    @routes.get("/assetmanager/api/view_image")
    async def api_view_image(request):
        """절대 경로로 지정된 이미지 파일을 직접 서빙 (모델 프리뷰용)"""
        img_path = request.query.get("path", "")
        if not img_path or not os.path.exists(img_path):
            return web.Response(status=404)
        return web.FileResponse(img_path)
