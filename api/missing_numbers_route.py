# ──────────────────────────────────────────────
# 이 코드를 백엔드 파일(assetmanager 라우트들이 등록된 .py 파일)에 추가하세요.
# 예: /assetmanager/api/library, /assetmanager/api/workflow 등이 등록된 곳과
#     같은 파일에, 같은 방식으로 추가하면 됩니다.
#
# ComfyUI 커스텀 노드의 표준 라우팅 방식(PromptServer.instance.routes)을
# 쓰고 있다고 가정하고 작성했습니다. 실제 파일 구조가 다르면
# (예: Flask, FastAPI 등) 파일을 보내주시면 그에 맞게 다시 드릴게요.
# ──────────────────────────────────────────────

import os
import re
from aiohttp import web
from server import PromptServer  # 이미 다른 /assetmanager/api/* 라우트에서 쓰고 있을 임포트


def find_missing_file_numbers(folder_path):
    """폴더 안 파일 이름에서 숫자를 뽑아, 최소~최대 범위 중 빠진 번호를 찾아 반환한다."""
    try:
        file_list = os.listdir(folder_path)
    except FileNotFoundError:
        return {"ok": False, "error": f"'{folder_path}' 폴더를 찾을 수 없습니다."}
    except NotADirectoryError:
        return {"ok": False, "error": f"'{folder_path}' 는 폴더가 아닙니다."}
    except PermissionError:
        return {"ok": False, "error": f"'{folder_path}' 폴더에 접근 권한이 없습니다."}

    numbers = []
    for file_name in file_list:
        match = re.search(r'\d+', file_name)
        if match:
            numbers.append(int(match.group()))

    if not numbers:
        return {"ok": False, "error": "폴더 안에 숫자가 포함된 파일이 없습니다."}

    min_num = min(numbers)
    max_num = max(numbers)
    existing_set = set(numbers)
    full_set = set(range(min_num, max_num + 1))
    missing_numbers = sorted(full_set - existing_set)

    return {
        "ok": True,
        "folder": folder_path,
        "total_files": len(file_list),
        "min": min_num,
        "max": max_num,
        "existing": sorted(existing_set),
        "missing": missing_numbers,
    }


@PromptServer.instance.routes.get("/assetmanager/api/missing_numbers")
async def api_missing_numbers(request):
    folder = request.query.get("folder", "").strip()
    if not folder:
        return web.json_response({"ok": False, "error": "folder 파라미터가 필요합니다."}, status=400)

    result = find_missing_file_numbers(folder)
    return web.json_response(result)
