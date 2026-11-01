"""
api/gallery.py — 갤러리(출력 이미지 브라우저) API
ComfyUI output 폴더를 재귀 스캔하여 폴더별 이미지 목록을 반환하고,
이미지 메타데이터 파싱, 파일 삭제, OS 탐색기 열기 등의 기능을 제공합니다.
"""

import os
import json
import subprocess
import platform
import urllib.parse
from PIL import Image
from aiohttp import web
from server import PromptServer
import folder_paths


def setup_gallery_api(routes):
    """갤러리 관련 API 라우트를 등록한다."""

    @routes.get("/assetmanager/api/open_folder")
    async def api_open_folder(request):
        """이미지 파일이 위치한 폴더를 OS 파일 탐색기에서 연다"""
        filename = request.query.get("filename", "")
        subfolder = request.query.get("subfolder", "")
        
        output_dir = folder_paths.get_output_directory()
        target_path = os.path.join(output_dir, subfolder, filename) if subfolder else os.path.join(output_dir, filename)
        target_path = os.path.abspath(target_path)
        
        if not os.path.exists(target_path):
            target_path = os.path.dirname(target_path)

        try:
            if platform.system() == "Windows":
                subprocess.run(['explorer', '/select,', target_path])
            elif platform.system() == "Darwin":
                subprocess.run(['open', '-R', target_path])
            else:
                subprocess.run(['xdg-open', os.path.dirname(target_path)])
            return web.json_response({"status": "success"})
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=500)

    @routes.get("/assetmanager/api/image_metadata")
    async def api_image_metadata(request):
        """
        PNG 이미지 파일에서 ComfyUI 메타데이터(prompt, workflow)를 추출하여 반환.
        ComfyUI는 PNG의 tEXt 청크에 prompt와 workflow를 JSON 문자열로 저장한다.
        """
        filename = request.query.get("filename", "")
        subfolder = request.query.get("subfolder", "")
        
        output_dir = folder_paths.get_output_directory()
        file_path = os.path.join(output_dir, subfolder, filename) if subfolder else os.path.join(output_dir, filename)
            
        if not os.path.exists(file_path):
            return web.json_response({"status": "error", "message": "File not found"}, status=404)
            
        try:
            with Image.open(file_path) as img:
                metadata = img.info
                prompt_data = json.loads(metadata.get('prompt', '{}'))
                workflow_data = json.loads(metadata.get('workflow', '{}'))
                
                return web.json_response({
                    "status": "success",
                    "prompt": prompt_data,
                    "workflow": workflow_data,
                    "raw_info": {k: v for k, v in metadata.items() if k not in ['prompt', 'workflow']}
                })
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=500)

    @routes.get("/assetmanager/api/gallery")
    async def api_get_gallery(request):
        """
        output 폴더를 재귀적으로 스캔하여 폴더별 이미지 목록을 반환.
        각 이미지에는 파일명, 서브폴더, 프리뷰 URL, 생성 시간이 포함된다.
        결과는 폴더명 알파벳 순으로 정렬되며, 루트 폴더가 항상 맨 앞에 위치한다.
        """
        output_dir = folder_paths.get_output_directory()
        if not os.path.exists(output_dir):
            return web.json_response({"status": "error", "message": "Output directory not found"}, status=404)
            
        result = []
        
        try:
            folder_dict = {}
            
            for dirpath, dirnames, filenames in os.walk(output_dir):
                rel_dir = os.path.relpath(dirpath, output_dir)
                subfolder = "" if rel_dir == "." else rel_dir.replace("\\", "/")
                display_folder = "📝 분류되지 않음 (Root)" if not subfolder else subfolder
                
                images_in_this_folder = []
                
                for f in filenames:
                    if f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
                        full_path = os.path.join(dirpath, f)
                        if os.path.isfile(full_path):
                            ctime = os.path.getctime(full_path)
                            images_in_this_folder.append({
                                "filename": f,
                                "subfolder": subfolder,
                                "url": f"/view?filename={f}&type=output&subfolder={subfolder}",
                                "timestamp": ctime
                            })
                
                if images_in_this_folder:
                    images_in_this_folder.sort(key=lambda x: x["timestamp"], reverse=True)
                    folder_dict[display_folder] = images_in_this_folder
                    
            sorted_folders = sorted(folder_dict.keys())
            if "📝 분류되지 않음 (Root)" in sorted_folders:
                sorted_folders.remove("📝 분류되지 않음 (Root)")
                sorted_folders.insert(0, "📝 분류되지 않음 (Root)")
                
            for folder in sorted_folders:
                result.append({
                    "folder": folder,
                    "images": folder_dict[folder]
                })
                    
        except Exception as e:
            print(f"Error scanning output directory: {e}")
            
        return web.json_response({"status": "success", "gallery": result})

    @routes.post("/assetmanager/api/delete_images")
    async def api_delete_images(request):
        """
        지정된 이미지 파일들을 삭제한다.
        보안: output 디렉토리 외부의 파일은 삭제할 수 없도록 경로를 정규화한다.
        """
        try:
            data = await request.json()
            images_to_delete = data.get("images", [])
            
            if not images_to_delete:
                return web.json_response({"status": "error", "message": "No images provided for deletion"}, status=400)
                
            output_dir = folder_paths.get_output_directory()
            deleted_count = 0
            failed_count = 0
            
            for img in images_to_delete:
                filename = img.get("filename", "")
                subfolder = img.get("subfolder", "")
                
                target_path = os.path.join(output_dir, subfolder, filename) if subfolder else os.path.join(output_dir, filename)
                
                target_path = os.path.abspath(target_path)
                output_dir_abs = os.path.abspath(output_dir)
                
                if target_path.startswith(output_dir_abs) and os.path.exists(target_path) and os.path.isfile(target_path):
                    try:
                        os.remove(target_path)
                        deleted_count += 1
                    except Exception as e:
                        print(f"Failed to delete {target_path}: {e}")
                        failed_count += 1
                else:
                    failed_count += 1
                    
            return web.json_response({
                "status": "success", 
                "deleted": deleted_count,
                "failed": failed_count
            })
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=500)

    @routes.get("/assetmanager/api/view_image")
    async def api_view_image(request):
        """
        절대 경로로 지정된 이미지 파일을 직접 반환.
        보안: 이미지 확장자(.png, .jpg 등)만 허용한다.
        """
        img_path = request.query.get("path", "")
        if not img_path or not os.path.exists(img_path):
            return web.Response(status=404, text="Image not found")
            
        ext = os.path.splitext(img_path)[1].lower()
        if ext not in ['.png', '.jpg', '.jpeg', '.webp', '.gif']:
            return web.Response(status=403, text="Forbidden file type")
            
        return web.FileResponse(img_path)
