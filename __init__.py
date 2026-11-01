"""
__init__.py — ComfyUI-AssetManager 확장 노드 진입점
ComfyUI 서버에 API 라우트를 등록하고, 정적 파일 서빙 및
프론트엔드 앱 엔드포인트(/assetmanager/app)를 설정합니다.
각 API 모듈(models, system, gallery, library, generate, tools)의
라우트 등록 함수를 호출하여 백엔드 기능을 초기화합니다.
"""

import os
from aiohttp import web
from server import PromptServer

from .api.models import setup_models_api
from .api.system import setup_system_api
from .api.gallery import setup_gallery_api
from .api.library import setup_library_api
from .api.generate import setup_generate_api
from .api.tools import setup_tools_api

routes = PromptServer.instance.routes

WEB_DIR = os.path.join(os.path.dirname(__file__), "web")
DATA_DIR = os.path.join(WEB_DIR, "data")
if not os.path.exists(DATA_DIR):
    os.makedirs(DATA_DIR)

routes.static('/assetmanager/static', WEB_DIR)

@routes.get("/assetmanager/app")
async def serve_app(request):
    """프론트엔드 SPA의 index.html을 반환하는 메인 엔드포인트"""
    return web.FileResponse(os.path.join(WEB_DIR, "index.html"))

setup_models_api(routes)
setup_system_api(routes, WEB_DIR)
setup_gallery_api(routes)
setup_library_api(routes, WEB_DIR)
setup_generate_api(routes, DATA_DIR)
setup_tools_api(routes)

# ComfyUI 커스텀 노드 정의 (이 확장은 노드를 등록하지 않음)
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web"

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']