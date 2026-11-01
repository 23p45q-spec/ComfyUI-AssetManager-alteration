"""
api/library.py — 프롬프트 라이브러리 API
prompt_library.json 파일의 읽기/쓰기를 담당합니다.
프론트엔드의 작품 > 그룹 > 조각 3단 계층 데이터를 저장·반환합니다.
"""

import os
import json
from aiohttp import web


def setup_library_api(routes, web_dir):
    """프롬프트 라이브러리 관련 API 라우트를 등록한다."""

    data_dir = os.path.join(web_dir, "data")
    if not os.path.exists(data_dir):
        os.makedirs(data_dir)

    library_file = os.path.join(data_dir, "prompt_library.json")

    # 🆕 📝 메모장 "외부 .txt 동기화" 라우트 — 프론트(library.js의 memoSyncSaveToServer /
    # pollMemoSync)는 처음부터 이 세 라우트를 호출하도록 짜여 있었는데, 백엔드에 라우트 자체가
    # 없어서(404) 메모장 열기/타이핑/로컬 저장은 되지만 "연동"만 조용히 실패하고 있었음
    # (프론트가 라우트 없음/서버 오프라인을 구분 안 하고 그냥 조용히 무시하게 짜여 있어서 티가 안 났음).
    # 탭 하나당 실제 .txt 파일 하나로 저장 — library_file과 같은 data 폴더 밑 memos/ 하위.
    memos_dir = os.path.join(data_dir, "memos")
    if not os.path.exists(memos_dir):
        os.makedirs(memos_dir)

    def _memo_safe_id(tab_id):
        """탭 id가 파일명으로 그대로 쓰이므로, 경로 탈출(../ 등) 방지를 위해 영문/숫자/-/_ 만 허용.
        실제 탭 id는 프론트에서 'tab_<timestamp>_<랜덤4자>' 형식이라 이미 안전하지만, 혹시 모를
        입력에 대비한 방어 코드 — 정상 id는 이 필터를 거쳐도 그대로 유지됨."""
        safe = "".join(c for c in str(tab_id) if c.isalnum() or c in ("-", "_"))
        return safe or "default"

    def _memo_path(tab_id):
        return os.path.join(memos_dir, _memo_safe_id(tab_id) + ".txt")

    @routes.post("/assetmanager/api/memo")
    async def api_save_memo(request):
        """메모장 탭 하나의 현재 내용을 .txt로 저장(없으면 새로 생성). 저장 직후의 mtime을
        돌려줘서, 프론트가 '내가 방금 저장한 시점'을 기억했다가 그보다 새로운 외부 변경만
        반영하도록(polling 때 자기가 쓴 내용을 또 자기가 덮어쓰지 않도록) 돕는다."""
        try:
            data = await request.json()
            tab_id = data.get("tabId")
            content = data.get("content", "")
            if not tab_id:
                return web.json_response({"ok": False, "error": "tabId가 없습니다."}, status=400)
            path = _memo_path(tab_id)
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            return web.json_response({"ok": True, "mtime": os.path.getmtime(path)})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)

    @routes.get("/assetmanager/api/memo/all")
    async def api_get_all_memos(request):
        """모든 메모 탭의 현재 내용 + 수정시각을 한 번에 반환. 프론트가 몇 초마다 이걸 폴링해서
        (바깥의 실제 윈도우 메모장 등에서) 외부 변경이 있었는지 감지한다."""
        try:
            memos = {}
            for fname in os.listdir(memos_dir):
                if not fname.endswith(".txt"):
                    continue
                tab_id = fname[:-4]
                path = os.path.join(memos_dir, fname)
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        content = f.read()
                    memos[tab_id] = {"content": content, "mtime": os.path.getmtime(path)}
                except Exception:
                    continue  # 그 사이 파일이 지워졌거나 읽기 실패 — 그 탭 하나만 건너뜀
            return web.json_response({"ok": True, "memos": memos})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)

    @routes.post("/assetmanager/api/memo/delete")
    async def api_delete_memo(request):
        """메모장에서 탭을 삭제했을 때 대응하는 .txt 파일도 같이 삭제."""
        try:
            data = await request.json()
            tab_id = data.get("tabId")
            if tab_id:
                path = _memo_path(tab_id)
                if os.path.exists(path):
                    os.remove(path)
            return web.json_response({"ok": True})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)

    @routes.get("/assetmanager/api/library")
    async def api_get_library(request):
        """프롬프트 라이브러리 데이터를 반환. 파일이 없으면 빈 기본 구조를 반환."""
        if not os.path.exists(library_file):
            default_lib = {"categories": []}
            return web.json_response(default_lib)
        try:
            with open(library_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            return web.json_response(data)
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=500)

    @routes.post("/assetmanager/api/library")
    async def api_save_library(request):
        """프론트엔드에서 전달받은 라이브러리 데이터를 JSON 파일로 저장"""
        try:
            data = await request.json()
            with open(library_file, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=4, ensure_ascii=False)
            return web.json_response({"status": "success"})
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=500)
