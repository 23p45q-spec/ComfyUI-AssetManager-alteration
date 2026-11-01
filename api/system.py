"""
api/system.py — 시스템 공용 API (상태 저장/복원, 로그 기록)
앱 상태(app_state.json) 파일의 저장 및 불러오기와
날짜별 로그 파일 기록 기능을 제공합니다.
"""

import os
import json
import datetime
from aiohttp import web


def setup_system_api(routes, web_dir):
    """시스템 관련 API 라우트를 등록한다."""

    data_dir = os.path.join(web_dir, "data")
    if not os.path.exists(data_dir):
        os.makedirs(data_dir)

    state_file = os.path.join(data_dir, "app_state.json")

    @routes.post("/assetmanager/api/save_state")
    async def api_save_state(request):
        """프론트엔드 앱 상태를 JSON 파일로 저장"""
        try:
            data = await request.json()
            with open(state_file, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=4, ensure_ascii=False) 
            return web.json_response({"status": "success"})
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=500)

    @routes.get("/assetmanager/api/load_state")
    async def api_load_state(request):
        """저장된 앱 상태를 불러온다. 파일이 없으면 not_found 상태를 반환."""
        if not os.path.exists(state_file):
            return web.json_response({"status": "not_found"})
        try:
            with open(state_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            return web.json_response({"status": "success", "state": data})
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=500)

    log_dir = os.path.join(web_dir, "log")
    if not os.path.exists(log_dir):
        os.makedirs(log_dir)

    @routes.post("/assetmanager/api/log")
    async def api_save_log(request):
        """프론트엔드에서 보낸 메시지를 날짜별 로그 파일에 추가 기록"""
        try:
            data = await request.json()
            message = data.get("message", "")
            if not message:
                return web.json_response({"status": "error", "message": "No message provided"}, status=400)
                
            today_str = datetime.datetime.now().strftime("%Y-%m-%d")
            log_file = os.path.join(log_dir, f"{today_str}.log")
            
            with open(log_file, 'a', encoding='utf-8') as f:
                f.write(message + "\n")
                
            return web.json_response({"status": "success"})
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=500)
