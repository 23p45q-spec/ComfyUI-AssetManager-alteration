"""
api/generate.py — 워크플로우 템플릿 API
프론트엔드 이미지 생성에 사용되는 워크플로우 JSON 파일을 제공합니다.
"""

import os
import json
from aiohttp import web


def setup_generate_api(routes, data_dir):
    """워크플로우 관련 API 라우트를 등록한다."""

    @routes.get("/assetmanager/api/workflow")
    async def api_get_workflow(request):
        """data/workflow.json 파일을 읽어 워크플로우 구조를 반환"""
        workflow_path = os.path.join(data_dir, "workflow.json")
        if os.path.exists(workflow_path):
            with open(workflow_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            return web.json_response({"status": "success", "workflow": data})
        else:
            return web.json_response({"status": "error", "message": "workflow.json not found in web/data/"}, status=404)
