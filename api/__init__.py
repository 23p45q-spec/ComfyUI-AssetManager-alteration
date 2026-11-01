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
# ──────────────────────────────────────────────
# 이 코드로 이전에 넣으신 review_route.py 내용을 "교체"하세요.
# (review_list / review_image 라우트는 이제 필요 없음 — ComfyUI 기본 /view 엔드포인트를
#  그대로 재사용하도록 프론트엔드를 바꿨기 때문. review_accept만 새로 남음)
# ──────────────────────────────────────────────

import os
import shutil
from aiohttp import web
from server import PromptServer  # 이미 임포트되어 있다면 이 줄은 생략
import folder_paths              # ComfyUI 기본 제공 모듈 (출력 폴더 경로 계산용)


@PromptServer.instance.routes.post("/assetmanager/api/review_accept")
async def api_review_accept(request):
    """
    검수 도구에서 '좋음'을 눌렀을 때, ComfyUI가 생성한 결과 이미지를
    (filename, subfolder, type으로 식별) 지정한 번호로 목적지 폴더에 복사한다.
    filename/subfolder/type은 ComfyUI의 /view 엔드포인트와 동일한 파라미터 체계를 사용.
    """
    data = await request.json()
    filename = data.get("filename", "").strip()
    subfolder = data.get("subfolder", "").strip()
    file_type = data.get("type", "output").strip() or "output"
    dest_folder = data.get("destFolder", "").strip()
    number = data.get("number")

    if not filename:
        return web.json_response({"ok": False, "error": "filename이 비어있습니다."})
    if not dest_folder:
        return web.json_response({"ok": False, "error": "목적지 폴더가 비어있습니다."})
    if number is None:
        return web.json_response({"ok": False, "error": "번호가 비어있습니다."})

    # ComfyUI 기본 폴더 구조(output/input/temp)에 맞춰 실제 경로를 계산
    if file_type == "output":
        base_dir = folder_paths.get_output_directory()
    elif file_type == "input":
        base_dir = folder_paths.get_input_directory()
    elif file_type == "temp":
        base_dir = folder_paths.get_temp_directory()
    else:
        base_dir = folder_paths.get_output_directory()

    src_path = os.path.join(base_dir, subfolder, filename) if subfolder else os.path.join(base_dir, filename)
    src_path = os.path.normpath(src_path)

    if not os.path.isfile(src_path):
        return web.json_response({"ok": False, "error": f"원본 파일을 찾을 수 없습니다: {src_path}"})

    os.makedirs(dest_folder, exist_ok=True)
    ext = os.path.splitext(filename)[1]
    dest_path = os.path.join(dest_folder, f"{number}{ext}")

    try:
        shutil.copy2(src_path, dest_path)
    except Exception as e:
        return web.json_response({"ok": False, "error": f"복사 실패: {e}"})

    return web.json_response({"ok": True, "destPath": dest_path})
# ──────────────────────────────────────────────
# __init__.py에 이어서 추가하세요 (다른 /assetmanager/api/* 라우트들과 같은 방식)
# ──────────────────────────────────────────────

import os
import re
import shutil
import time
from aiohttp import web
from server import PromptServer  # 이미 임포트되어 있다면 이 줄은 생략


# ──────────────────────────────────────────────
# 기존 api_label_numbered_files 라우트를 이 코드로 "교체"하세요.
# 바뀐 점: duplicateFolder / duplicateTargets 파라미터를 받아서,
# 원본 저장(labeled_images) 외에 두 번째 위치에도 복제 저장합니다.
#
# duplicateTargets가 있으면(프론트에서 괄호 문법을 켰을 때) 라벨별로:
#   - baseOverride가 있으면 그 경로를, 없으면 duplicateFolder(기본값)를 기준 경로로
#   - 그 아래 subPath(예: "이름/이름감정") 하위 폴더를 재귀 생성 (이미 있으면 그대로 둠)
#   - fileName + 확장자로 저장
# duplicateTargets가 없고 duplicateFolder만 있으면(괄호 문법 안 씀), 원본과 같은 파일명으로
# duplicateFolder 바로 아래에 flat하게 하나 더 저장합니다.
# ──────────────────────────────────────────────

import os
import re
import shutil
import time
from aiohttp import web
from server import PromptServer  # 이미 임포트되어 있다면 이 줄은 생략


# ──────────────────────────────────────────────
# 기존 api_label_numbered_files 라우트를 이 코드로 "교체"하세요.
# 바뀐 점: duplicateFolder / duplicateTargets 파라미터를 받아서,
# 원본 저장(labeled_images) 외에 두 번째 위치에도 복제 저장합니다.
#
# duplicateTargets가 있으면(프론트에서 괄호 문법을 켰을 때) 라벨별로:
#   - baseOverride가 있으면 그 경로를, 없으면 duplicateFolder(기본값)를 기준 경로로
#   - 그 아래 subPath(예: "이름/이름감정") 하위 폴더를 재귀 생성 (이미 있으면 그대로 둠)
#   - fileName + 확장자로 저장
# duplicateTargets가 없고 duplicateFolder만 있으면(괄호 문법 안 씀), 원본과 같은 파일명으로
# duplicateFolder 바로 아래에 flat하게 하나 더 저장합니다.
# ──────────────────────────────────────────────

import os
import re
import shutil
import time
from aiohttp import web
from server import PromptServer  # 이미 임포트되어 있다면 이 줄은 생략


# ──────────────────────────────────────────────
# 기존 api_label_numbered_files 라우트를 이 코드로 "교체"하세요.
# 바뀐 점: duplicateFolder / duplicateTargets 파라미터를 받아서,
# 원본 저장(labeled_images) 외에 두 번째 위치에도 복제 저장합니다.
#
# duplicateTargets가 있으면(프론트에서 괄호 문법을 켰을 때) 라벨별로:
#   - baseOverride가 있으면 그 경로를, 없으면 duplicateFolder(기본값)를 기준 경로로
#   - 그 아래 subPath(예: "이름/이름감정") 하위 폴더를 재귀 생성 (이미 있으면 그대로 둠)
#   - fileName + 확장자로 저장
# duplicateTargets가 없고 duplicateFolder만 있으면(괄호 문법 안 씀), 원본과 같은 파일명으로
# duplicateFolder 바로 아래에 flat하게 하나 더 저장합니다.
# ──────────────────────────────────────────────

import os
import re
import shutil
import time
from aiohttp import web
from server import PromptServer  # 이미 임포트되어 있다면 이 줄은 생략


# ──────────────────────────────────────────────
# 기존 api_label_numbered_files 라우트를 이 코드로 "교체"하세요.
# 바뀐 점: duplicateFolder / duplicateTargets 파라미터를 받아서,
# 원본 저장(labeled_images) 외에 두 번째 위치에도 복제 저장합니다.
#
# duplicateTargets가 있으면(프론트에서 괄호 문법을 켰을 때) 라벨별로:
#   - baseOverride가 있으면 그 경로를, 없으면 duplicateFolder(기본값)를 기준 경로로
#   - 그 아래 subPath(예: "이름/이름감정") 하위 폴더를 재귀 생성 (이미 있으면 그대로 둠)
#   - fileName + 확장자로 저장
# duplicateTargets가 없고 duplicateFolder만 있으면(괄호 문법 안 씀), 원본과 같은 파일명으로
# duplicateFolder 바로 아래에 flat하게 하나 더 저장합니다.
# ──────────────────────────────────────────────

import os
import re
import shutil
import time
from aiohttp import web
from server import PromptServer  # 이미 임포트되어 있다면 이 줄은 생략


# ──────────────────────────────────────────────
# 기존 api_label_numbered_files 라우트를 이 코드로 "교체"하세요.
# 바뀐 점: duplicateFolder / duplicateTargets 파라미터를 받아서,
# 원본 저장(labeled_images) 외에 두 번째 위치에도 복제 저장합니다.
#
# duplicateTargets가 있으면(프론트에서 괄호 문법을 켰을 때) 라벨별로:
#   - baseOverride가 있으면 그 경로를, 없으면 duplicateFolder(기본값)를 기준 경로로
#   - 그 아래 subPath(예: "이름/이름감정") 하위 폴더를 재귀 생성 (이미 있으면 그대로 둠)
#   - fileName + 확장자로 저장
# duplicateTargets가 없고 duplicateFolder만 있으면(괄호 문법 안 씀), 원본과 같은 파일명으로
# duplicateFolder 바로 아래에 flat하게 하나 더 저장합니다.
# ──────────────────────────────────────────────

import os
import re
import shutil
import time
from aiohttp import web
from server import PromptServer  # 이미 임포트되어 있다면 이 줄은 생략


def _extract_leading_number(filename):
    """순수 파일명 맨 앞의 숫자를 추출 (없으면 맨 뒤로 보내기 위해 매우 큰 값 반환)"""
    match = re.match(r'^(\d+)', filename)
    return int(match.group(1)) if match else 999999


def _save_duplicate(src_path, ext, label_index, duplicate_folder, duplicate_targets, prefix=""):
    """복제 저장 1건 처리. 경로의 가장 안쪽(마지막) 폴더에만 파일을 저장한다
    (이름만 있는 중간 폴더에는 만들지 않음 — 예: 아하/아하감정 이면 아하감정 폴더에만 저장).
    이미 해당 위치에 같은 이름 파일이 있으면 덮어쓰지 않고 건너뛴다("없는 파일만 만들기").
    성공적으로 저장(또는 이미 존재해서 스킵)된 (경로, 새로만들었는지bool) 하나를 리스트에 담아 반환.
    저장할 곳이 없으면 빈 리스트."""
    target = None
    if duplicate_targets is not None and 0 <= label_index < len(duplicate_targets):
        target = duplicate_targets[label_index]

    if target is not None:
        base_folder = (target.get("baseOverride") or "").strip() or duplicate_folder
        if not base_folder:
            return []  # 이 줄도 경로가 없고 기본 폴더도 없으면 복제 불가 — 조용히 스킵
        sub_path = (target.get("subPath") or "").strip()
        file_name = (target.get("fileName") or "").strip()
        dest_dir = os.path.join(base_folder, *sub_path.split("/")) if sub_path else base_folder
        os.makedirs(dest_dir, exist_ok=True)
        # 🐛 버그 수정: 기존엔 여기서 접두어(prefix)가 안 붙어서, 일반(flat) 저장은
        # "{prefix}{label}{ext}"인데 구조화된 복제 저장은 "{label}{ext}"로 접두어 없이 저장되고 있었다.
        dup_filename = f"{prefix}{file_name}{ext}" if file_name else os.path.basename(src_path)
        dup_path = os.path.join(dest_dir, dup_filename)
    else:
        # 구조화 안 쓰는 경우: duplicateFolder 바로 아래에 원본과 같은 파일명으로 flat 저장
        # (src_path는 이미 접두어가 붙은 새 파일명이므로 basename을 그대로 써도 접두어가 유지됨)
        if not duplicate_folder:
            return []
        os.makedirs(duplicate_folder, exist_ok=True)
        dup_path = os.path.join(duplicate_folder, os.path.basename(src_path))

    if os.path.exists(dup_path):
        return [(dup_path, False)]  # 이미 있음 — "없는 파일만 만들기": 안 건드림
    shutil.copy2(src_path, dup_path)
    return [(dup_path, True)]


@PromptServer.instance.routes.post("/assetmanager/api/label_numbered_files")
async def api_label_numbered_files(request):
    """
    번호 매겨진 이미지 파일들을(1.png, 2.png, 3.png...) 순서대로
    사용자가 입력한 라벨(표정 이름 등)과 1:1 매칭해서 새 이름으로 복사한다.
    prefix는 선택사항 — 있으면 "{prefix}{label}{ext}", 없으면 "{label}{ext}"로 저장.
    convertWebp가 true면 원본 확장자와 무관하게 webp로 변환해서 저장한다 (Pillow 필요: pip install Pillow).
    duplicateFolder/duplicateTargets가 있으면 같은 결과물을 두 번째 위치에도 저장한다.
    """
    data = await request.json()
    folder = data.get("folder", "").strip()
    prefix = data.get("prefix", "").strip()  # 비어있으면 접두어 없이 저장
    labels = data.get("labels", [])
    convert_webp = bool(data.get("convertWebp", False))
    webp_quality = data.get("webpQuality", 85)
    duplicate_folder = (data.get("duplicateFolder") or "").strip()
    duplicate_targets = data.get("duplicateTargets")  # null 또는 라벨별 {baseOverride, subPath, fileName} 배열
    try:
        webp_quality = int(webp_quality)
    except (TypeError, ValueError):
        webp_quality = 85

    if not folder:
        return web.json_response({"ok": False, "error": "폴더 경로가 비어있습니다."})
    if not os.path.isdir(folder):
        return web.json_response({"ok": False, "error": f"'{folder}' 폴더를 찾을 수 없습니다."})
    if not labels:
        return web.json_response({"ok": False, "error": "라벨(표정 이름) 목록이 비어있습니다."})

    if convert_webp:
        try:
            from PIL import Image
        except ImportError:
            return web.json_response({"ok": False, "error": "webp 변환을 하려면 서버에 Pillow가 설치되어 있어야 합니다. (pip install Pillow)"})

    valid_extensions = ('.png', '.jpg', '.jpeg', '.webp', '.bmp')
    files = [f for f in os.listdir(folder) if f.lower().endswith(valid_extensions)]
    if not files:
        return web.json_response({"ok": False, "error": "폴더 안에 이미지 파일이 없습니다."})

    files.sort(key=_extract_leading_number)
    skipped = []

    # 파일명 배열에서의 "몇 번째냐"가 아니라, 파일명 맨 앞 실제 숫자를 기준으로 라벨을 매칭한다.
    # 예: 1,2,4,5.png 처럼 3번이 비어있어도, 4번 파일은 (번호가 밀린 3번째 라벨이 아니라)
    # 항상 labels[3] (=4번째 라벨)에 매칭된다. 번호가 없는 파일이나, 라벨 개수를 넘어서는
    # 번호의 파일은 스킵된다.
    numbered_files = []
    for f in files:
        m = re.match(r'^(\d+)', f)
        if m:
            numbered_files.append((int(m.group(1)), f))
        else:
            skipped.append(f)
    base_num = min((n for n, _ in numbered_files), default=1)

    # 🆕 라벨을 붙일 번호 범위(base_num ~ base_num+len(labels)-1) 안에서 실제로 파일이 없는
    # "빈 번호"를 미리 찾아둔다. 예: 1,2,4,5.png + 라벨 5개면 base_num=1이라 라벨 범위는 1~5인데
    # 3번 파일이 없으므로 missing_numbers=[3] → 응답에 담아 프론트에서 알림으로 띄운다.
    # (매칭 자체는 이미 num 기준이라 밀리지 않지만, "3번 라벨이 하나 통째로 안 붙었다"는 사실 자체는
    # 사용자가 놓치기 쉬우므로 명시적으로 알려준다.)
    existing_numbers = {n for n, _ in numbered_files}
    label_range_end = base_num + len(labels) - 1
    missing_numbers = sorted(
        n for n in range(base_num, label_range_end + 1) if n not in existing_numbers
    )

    output_folder = os.path.join(folder, "labeled_images")
    os.makedirs(output_folder, exist_ok=True)

    results = []
    duplicate_results = []
    base_time = time.time()
    label_counts = {}

    for order, (num, old_filename) in enumerate(numbered_files):
        label_index = num - base_num
        if label_index < 0 or label_index >= len(labels):
            skipped.append(old_filename)
            continue

        old_path = os.path.join(folder, old_filename)
        ext = '.webp' if convert_webp else os.path.splitext(old_filename)[1].lower()
        label = str(labels[label_index]).strip()

        # 같은 라벨 이름이 여러 번 나오면 파일명이 겹쳐서 서로 덮어써 버리므로,
        # 두 번째 이후 등장하는 중복 라벨에는 자동으로 번호를 붙여 구분한다.
        label_counts[label] = label_counts.get(label, 0) + 1
        display_label = label if label_counts[label] == 1 else f"{label}_{label_counts[label]}"

        new_filename = f"{prefix}{display_label}{ext}"
        new_path = os.path.join(output_folder, new_filename)

        try:
            if convert_webp:
                with Image.open(old_path) as img:
                    # 알파 채널 있는 포맷(PNG 등)은 RGBA로, 없으면 RGB로 저장
                    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
                        img = img.convert("RGBA")
                    else:
                        img = img.convert("RGB")
                    img.save(new_path, "WEBP", quality=webp_quality)
            else:
                shutil.copy2(old_path, new_path)
            # 윈도우 탐색기에서 순서대로 정렬되도록 수정시각을 순번대로 부여
            fake_time = base_time + (label_index * 10)
            os.utime(new_path, (fake_time, fake_time))
            results.append({"from": old_filename, "to": new_filename})

            # 🆕 복제 저장 (요청된 경우에만) — 방금 저장한 new_path를 원본 삼아, 경로의 각 단계 폴더에도 복사
            if duplicate_folder or duplicate_targets:
                try:
                    dup_entries = _save_duplicate(new_path, ext, label_index, duplicate_folder, duplicate_targets, prefix)
                    for dup_path, was_created in dup_entries:
                        if was_created:
                            # 새로 만든 파일만 정렬용 수정시각 부여 — 이미 있던 파일은 안 건드림
                            fake_time_dup = base_time + (label_index * 10)
                            os.utime(dup_path, (fake_time_dup, fake_time_dup))
                        duplicate_results.append({"from": old_filename, "to": dup_path, "created": was_created})
                except Exception as e:
                    # 복제 저장 실패는 전체 처리를 막지 않는다 (원본 저장은 이미 성공했으므로) — skipped에 기록만
                    skipped.append(f"{old_filename} (복제 저장 실패: {e})")
        except Exception as e:
            return web.json_response({"ok": False, "error": f"'{old_filename}' 처리 중 오류: {e}"})

    response = {
        "ok": True,
        "outputFolder": output_folder,
        "processed": len(results),
        "results": results,
        "skipped": skipped,  # 라벨 개수보다 파일이 많아서 제외되었거나, 복제 저장에 실패한 것들
        "missingNumbers": missing_numbers,  # 🆕 라벨 범위 안에서 파일 자체가 없던 번호들
    }
    if duplicate_results:
        # 개별 파일마다 저장 위치가 다를 수 있어(괄호 문법) 폴더 하나로 특정할 수 없는 경우,
        # 기준 폴더(duplicate_folder, 없으면 각 파일의 baseOverride 중 첫 번째)를 대표로 보여준다.
        response["duplicateOutputFolder"] = duplicate_folder or os.path.dirname(duplicate_results[0]["to"])
        response["duplicateResults"] = duplicate_results

    return web.json_response(response)

# ──────────────────────────────────────────────
# __init__.py의 api_label_numbered_files 라우트 바로 아래에 이어서 추가하세요.
#
# "🗑 처리된 원본 파일 정리" 버튼에서 호출하는 라우트입니다.
# label_numbered_files와 완전히 동일한 매칭 규칙(파일명 맨 앞 숫자 → labels 인덱스,
# base_num = 가장 작은 번호)을 그대로 재사용해서, "그때 실제로 라벨이 붙었던 원본 파일"만
# 정확히 골라 지웁니다.
#
# 안전장치:
#   - 오직 folder(요청받은 그 폴더) "바로 아래"에 있는 파일만 지웁니다.
#     라벨 붙인 결과물(folder/labeled_images)이나 복제본(duplicateFolder/duplicateTargets)은
#     전부 다른 경로라 애초에 이 함수가 훑는 목록에 들어오지 않습니다 — 절대 안 건드립니다.
#   - 프론트에서 넘겨준 skipped 목록(그때 라벨 개수보다 파일이 많아서 제외됐던 파일들)은
#     이번에도 그대로 제외합니다 — 애초에 라벨이 안 붙은 파일이니 "정리" 대상이 아님.
# ──────────────────────────────────────────────

import os
import re
from aiohttp import web
from server import PromptServer  # 이미 임포트되어 있다면 이 줄은 생략


@PromptServer.instance.routes.post("/assetmanager/api/delete_numbered_files")
async def api_delete_numbered_files(request):
    """
    '번호에 설명 붙이기'로 라벨을 붙인 뒤, 더 이상 필요 없는 번호 매겨진 원본 파일들을
    정리(삭제)한다. 결과물/복제본은 다른 경로에 있으므로 이 라우트가 건드리는 건
    오직 원본 소스 폴더(folder) 안의 파일뿐이다.
    """
    data = await request.json()
    folder = data.get("folder", "").strip()
    labels = data.get("labels", [])
    skipped = set(data.get("skipped", []) or [])

    if not folder:
        return web.json_response({"ok": False, "error": "폴더 경로가 비어있습니다."})
    if not os.path.isdir(folder):
        return web.json_response({"ok": False, "error": f"'{folder}' 폴더를 찾을 수 없습니다."})
    if not labels:
        return web.json_response({"ok": False, "error": "라벨 목록이 비어있습니다."})

    folder_abs = os.path.abspath(folder)
    valid_extensions = ('.png', '.jpg', '.jpeg', '.webp', '.bmp')
    files = [f for f in os.listdir(folder) if f.lower().endswith(valid_extensions)]

    numbered_files = []
    for f in files:
        m = re.match(r'^(\d+)', f)
        if m:
            numbered_files.append((int(m.group(1)), f))
    base_num = min((n for n, _ in numbered_files), default=1)

    deleted = []
    errors = []

    for num, filename in numbered_files:
        if filename in skipped:
            continue  # 처리 때 이미 제외됐던 파일 — 라벨이 안 붙었으니 정리 대상도 아님

        label_index = num - base_num
        if label_index < 0 or label_index >= len(labels):
            continue  # label_numbered_files에서도 매칭 범위를 벗어나 skip됐을 파일

        target_path = os.path.join(folder, filename)

        # ⚠ 이중 안전장치: folder "바로 아래"에 있는 파일이 맞는지 한 번 더 확인.
        # (복제본/결과물은 다른 폴더라 애초에 여기 목록에 안 잡히지만, 혹시 몰라 한 번 더 검증)
        if os.path.dirname(os.path.abspath(target_path)) != folder_abs:
            continue

        try:
            os.remove(target_path)
            deleted.append(filename)
        except Exception as e:
            errors.append(f"{filename}: {e}")

    response = {"ok": True, "deleted": len(deleted), "deletedFiles": deleted}
    if errors:
        response["errors"] = errors
    return web.json_response(response)

# ──────────────────────────────────────────────
# 📝 메모장 ↔ 외부 텍스트 파일 동기화용 라우트 (__init__.py 맨 끝에 추가)
#
# 프론트(library.js)의 메모장 탭 하나하나가 이 폴더 밑의 실제 .txt 파일 하나에 대응된다.
# 사용자가 이 폴더의 .txt 파일을 윈도우 메모장 등 외부 프로그램으로 직접 열어서 수정해도,
# 프론트가 몇 초 간격으로 폴링(GET .../memo/all)해서 바뀐 내용을 반영한다 (양방향 동기화).
#
# 저장 위치: 이 파일(__init__.py)이 있는 커스텀 노드 폴더 밑의 "memos" 폴더.
# 다른 경로를 쓰고 싶으면 MEMO_DIR 값만 바꾸면 됩니다.
# ──────────────────────────────────────────────

import os
import re
import glob
from aiohttp import web
from server import PromptServer  # 이미 임포트되어 있다면 이 줄은 생략

MEMO_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "memos")
os.makedirs(MEMO_DIR, exist_ok=True)


def _safe_memo_filename(tab_id):
    """tabId를 파일명으로 그대로 써도 안전하도록, 영숫자/밑줄/하이픈만 남기고 나머지는 제거한다."""
    safe = re.sub(r'[^a-zA-Z0-9_\-]', '', str(tab_id))[:80]
    return f"memo_{safe or 'untitled'}.txt"


@PromptServer.instance.routes.get("/assetmanager/api/memo/all")
async def api_memo_get_all(request):
    """등록된 모든 메모 탭 파일의 내용 + 수정시각(mtime)을 한 번에 돌려준다 (프론트의 폴링용)."""
    memos = {}
    for path in glob.glob(os.path.join(MEMO_DIR, "memo_*.txt")):
        m = re.match(r'^memo_(.+)\.txt$', os.path.basename(path))
        if not m:
            continue
        tab_id = m.group(1)
        try:
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            memos[tab_id] = {"content": content, "mtime": os.path.getmtime(path)}
        except Exception:
            continue  # 읽기 실패한 파일 하나 때문에 전체 응답이 죽지 않게 건너뜀
    return web.json_response(
        {"ok": True, "memos": memos},
        headers={"Cache-Control": "no-store, no-cache, must-revalidate"}
    )


@PromptServer.instance.routes.post("/assetmanager/api/memo")
async def api_memo_save(request):
    """메모 탭 하나의 내용을 실제 .txt 파일로 저장한다 (프론트에서 타이핑 멈춘 뒤 자동 호출)."""
    data = await request.json()
    tab_id = (data.get("tabId") or "").strip()
    content = data.get("content", "")

    if not tab_id:
        return web.json_response({"ok": False, "error": "tabId가 비어있습니다."}, status=400)

    path = os.path.join(MEMO_DIR, _safe_memo_filename(tab_id))
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        mtime = os.path.getmtime(path)
    except Exception as e:
        return web.json_response({"ok": False, "error": f"저장 실패: {e}"}, status=500)

    return web.json_response({"ok": True, "path": path, "mtime": mtime})


@PromptServer.instance.routes.post("/assetmanager/api/memo/delete")
async def api_memo_delete(request):
    """메모 탭을 삭제할 때, 대응하는 외부 .txt 파일도 함께 지운다."""
    data = await request.json()
    tab_id = (data.get("tabId") or "").strip()
    if not tab_id:
        return web.json_response({"ok": False, "error": "tabId가 비어있습니다."}, status=400)

    path = os.path.join(MEMO_DIR, _safe_memo_filename(tab_id))
    try:
        if os.path.isfile(path):
            os.remove(path)
    except Exception as e:
        return web.json_response({"ok": False, "error": f"삭제 실패: {e}"}, status=500)

    return web.json_response({"ok": True})

# ──────────────────────────────────────────────
# __init__.py에 이어서 추가하세요 (다른 /assetmanager/api/* 라우트들과 같은 방식)
#
# 🍌 나노바나나(Google Gemini 이미지 생성 모델, gemini-2.5-flash-image) 연동.
# 로컬 ComfyUI 체크포인트가 아니라 Google의 서버 API를 호출해서 이미지를 받아온 뒤,
# ComfyUI의 output 폴더(하위 "nanobanana" 서브폴더)에 저장한다 — 그래야 기존 검수(review)
# 파이프라인이 그대로 이 이미지도 검수 대상으로 인식할 수 있다(파일명/subfolder/type 체계 동일).
#
# 필요 패키지: 없음 (aiohttp는 ComfyUI 자체가 이미 씀). requests 같은 추가 설치 불필요.
# ──────────────────────────────────────────────

import os
import re
import base64
import aiohttp
from aiohttp import web
from server import PromptServer  # 이미 임포트되어 있다면 이 줄은 생략
import folder_paths              # ComfyUI 기본 제공 모듈 (출력 폴더 경로 계산용)

NANOBANANA_MODEL = "gemini-2.5-flash-image"
NANOBANANA_ENDPOINT = f"https://generativelanguage.googleapis.com/v1beta/models/{NANOBANANA_MODEL}:generateContent"


def _next_nanobanana_counter(folder_path, prefix):
    """해당 폴더 안에서 'prefix_00001_.png' 형태의 다음 사용 가능한 번호를 계산한다."""
    try:
        existing = os.listdir(folder_path)
    except FileNotFoundError:
        return 1
    pattern = re.compile(re.escape(prefix) + r"_(\d+)_")
    nums = [int(m.group(1)) for name in existing if (m := pattern.match(name))]
    return (max(nums) + 1) if nums else 1


@PromptServer.instance.routes.post("/assetmanager/api/nanobanana_generate")
async def api_nanobanana_generate(request):
    """
    나노바나나(Google Gemini 이미지 생성)로 이미지 1장을 생성해서 ComfyUI output 폴더에 저장.
    요청 body: { apiKey, prompt, filenamePrefix? }
    응답: 성공 시 { ok: true, filename, subfolder, type: "output" } — ComfyUI /view 파라미터 체계와 동일.
    """
    data = await request.json()
    api_key = (data.get("apiKey") or "").strip()
    prompt = (data.get("prompt") or "").strip()
    filename_prefix = (data.get("filenamePrefix") or "nanobanana").strip() or "nanobanana"
    # 파일명에 쓸 수 없는 문자(경로 구분자 등) 제거 — 조각 이름에 특수문자가 섞여 있을 수 있음
    filename_prefix = re.sub(r'[\\/:*?"<>|]', "_", filename_prefix)[:80]

    if not api_key:
        return web.json_response({"ok": False, "error": "나노바나나 API 키가 비어있습니다. 화면에서 API 키를 입력하세요."})
    if not prompt:
        return web.json_response({"ok": False, "error": "프롬프트가 비어있습니다."})

    payload = {"contents": [{"parts": [{"text": prompt}]}]}
    headers = {"Content-Type": "application/json", "x-goog-api-key": api_key}

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(NANOBANANA_ENDPOINT, json=payload, headers=headers, timeout=aiohttp.ClientTimeout(total=120)) as resp:
                resp_json = await resp.json()
                if resp.status != 200:
                    err_msg = resp_json.get("error", {}).get("message", f"HTTP {resp.status}")
                    return web.json_response({"ok": False, "error": f"나노바나나 API 오류: {err_msg}"})
    except Exception as e:
        return web.json_response({"ok": False, "error": f"나노바나나 API 통신 실패: {e}"})

    # 응답에서 이미지(inlineData/base64)를 찾는다. 텍스트 파트만 오고 이미지가 없는 경우
    # (예: 안전 필터에 걸림) 에러로 처리.
    image_b64 = None
    mime_type = "image/png"
    try:
        candidates = resp_json.get("candidates", [])
        for cand in candidates:
            parts = cand.get("content", {}).get("parts", [])
            for part in parts:
                inline = part.get("inlineData") or part.get("inline_data")
                if inline and inline.get("data"):
                    image_b64 = inline["data"]
                    mime_type = inline.get("mimeType") or inline.get("mime_type") or "image/png"
                    break
            if image_b64:
                break
    except Exception:
        pass

    if not image_b64:
        # 안전 필터에 걸렸거나 텍스트만 반환된 경우, 후보에 담긴 사유가 있으면 같이 보여줌
        finish_reason = ""
        try:
            finish_reason = resp_json.get("candidates", [{}])[0].get("finishReason", "")
        except Exception:
            pass
        return web.json_response({"ok": False, "error": f"이미지를 받지 못했습니다(안전 필터에 걸렸을 수 있음). finishReason={finish_reason or '없음'}"})

    ext = ".png" if "png" in mime_type else (".jpg" if "jpeg" in mime_type else ".webp")
    output_dir = folder_paths.get_output_directory()
    subfolder = "nanobanana"
    save_dir = os.path.join(output_dir, subfolder)
    os.makedirs(save_dir, exist_ok=True)

    counter = _next_nanobanana_counter(save_dir, filename_prefix)
    filename = f"{filename_prefix}_{counter:05d}_{ext}"
    save_path = os.path.join(save_dir, filename)

    try:
        with open(save_path, "wb") as f:
            f.write(base64.b64decode(image_b64))
    except Exception as e:
        return web.json_response({"ok": False, "error": f"이미지 저장 실패: {e}"})

    return web.json_response({"ok": True, "filename": filename, "subfolder": subfolder, "type": "output"})

# ──────────────────────────────────────────────
# 🤖 GPT(OpenAI 이미지 생성, gpt-image-1) 연동 — 위 나노바나나 블록과 완전히 동일한 구조.
# 로컬 ComfyUI 체크포인트가 아니라 OpenAI의 /v1/images/generations API를 호출해서 이미지를
# 받아온 뒤, ComfyUI output 폴더(하위 "gpt" 서브폴더)에 저장한다(기존 검수 파이프라인 그대로 인식).
# 인증은 OpenAI Platform에서 발급하는 API 키(sk-...)를 Bearer로 사용.
#
# 필요 패키지: 없음 (aiohttp는 ComfyUI 자체가 이미 씀).
# ──────────────────────────────────────────────

import os
import re
import base64
import aiohttp
from aiohttp import web
from server import PromptServer  # 이미 임포트되어 있다면 이 줄은 생략
import folder_paths              # ComfyUI 기본 제공 모듈 (출력 폴더 경로 계산용)

GPT_IMAGE_MODEL = "gpt-image-1"
GPT_IMAGE_ENDPOINT = "https://api.openai.com/v1/images/generations"


def _next_gpt_counter(folder_path, prefix):
    """해당 폴더 안에서 'prefix_00001_.png' 형태의 다음 사용 가능한 번호를 계산한다."""
    try:
        existing = os.listdir(folder_path)
    except FileNotFoundError:
        return 1
    pattern = re.compile(re.escape(prefix) + r"_(\d+)_")
    nums = [int(m.group(1)) for name in existing if (m := pattern.match(name))]
    return (max(nums) + 1) if nums else 1


@PromptServer.instance.routes.post("/assetmanager/api/gpt_generate")
async def api_gpt_generate(request):
    """
    GPT(OpenAI gpt-image-1)로 이미지 1장을 생성해서 ComfyUI output 폴더에 저장.
    요청 body: { apiKey, prompt, filenamePrefix? }
    응답: 성공 시 { ok: true, filename, subfolder, type: "output" } — ComfyUI /view 파라미터 체계와 동일.
    """
    data = await request.json()
    api_key = (data.get("apiKey") or "").strip()
    prompt = (data.get("prompt") or "").strip()
    filename_prefix = (data.get("filenamePrefix") or "gpt").strip() or "gpt"
    # 파일명에 쓸 수 없는 문자(경로 구분자 등) 제거 — 조각 이름에 특수문자가 섞여 있을 수 있음
    filename_prefix = re.sub(r'[\\/:*?"<>|]', "_", filename_prefix)[:80]

    if not api_key:
        return web.json_response({"ok": False, "error": "GPT API 키가 비어있습니다. 화면에서 API 키를 입력하세요."})
    if not prompt:
        return web.json_response({"ok": False, "error": "프롬프트가 비어있습니다."})

    payload = {"model": GPT_IMAGE_MODEL, "prompt": prompt, "n": 1, "size": "1024x1024"}
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(GPT_IMAGE_ENDPOINT, json=payload, headers=headers, timeout=aiohttp.ClientTimeout(total=120)) as resp:
                resp_json = await resp.json()
                if resp.status != 200:
                    err_msg = resp_json.get("error", {}).get("message", f"HTTP {resp.status}")
                    return web.json_response({"ok": False, "error": f"GPT API 오류: {err_msg}"})
    except Exception as e:
        return web.json_response({"ok": False, "error": f"GPT API 통신 실패: {e}"})

    # gpt-image-1은 기본적으로 b64_json으로 이미지를 돌려준다 (url 응답이 오는 구버전 모델 대비 둘 다 처리)
    image_b64 = None
    try:
        items = resp_json.get("data", [])
        if items:
            image_b64 = items[0].get("b64_json")
            if not image_b64 and items[0].get("url"):
                async with aiohttp.ClientSession() as session:
                    async with session.get(items[0]["url"], timeout=aiohttp.ClientTimeout(total=60)) as img_resp:
                        image_bytes = await img_resp.read()
                        image_b64 = base64.b64encode(image_bytes).decode("utf-8")
    except Exception:
        pass

    if not image_b64:
        return web.json_response({"ok": False, "error": "이미지를 받지 못했습니다(안전 필터에 걸렸거나 응답 형식이 예상과 다를 수 있음)."})

    output_dir = folder_paths.get_output_directory()
    subfolder = "gpt"
    save_dir = os.path.join(output_dir, subfolder)
    os.makedirs(save_dir, exist_ok=True)

    counter = _next_gpt_counter(save_dir, filename_prefix)
    filename = f"{filename_prefix}_{counter:05d}_.png"
    save_path = os.path.join(save_dir, filename)

    try:
        with open(save_path, "wb") as f:
            f.write(base64.b64decode(image_b64))
    except Exception as e:
        return web.json_response({"ok": False, "error": f"이미지 저장 실패: {e}"})

    return web.json_response({"ok": True, "filename": filename, "subfolder": subfolder, "type": "output"})

# ──────────────────────────────────────────────
# 💬 대화하며 이미지 뽑기 — 2단계: 대화를 "답변 + 제안 프롬프트" JSON으로 바꿔주는 백엔드 라우트.
# Gemini / GPT(OpenAI) / 커스텀(OpenAI 호환, 로컬 LLM 포함) 세 공급자를 한 라우트에서 처리한다.
# 직전에 생성된 이미지가 있으면(image 파라미터) 디스크에서 읽어 base64로 비전 입력에 같이 넣어서,
# "이 이미지에서 머리색만 바꿔줘" 같은 수정 요청을 반영할 수 있게 한다.
# ──────────────────────────────────────────────

import os
import re
import json
import base64
import aiohttp
from aiohttp import web
from server import PromptServer  # 이미 임포트되어 있다면 이 줄은 생략
import folder_paths              # ComfyUI 기본 제공 모듈 (출력/입력 폴더 경로 계산용)

CHATGEN_SYSTEM_PROMPT = (
    "당신은 이미지 생성 AI(Stable Diffusion 계열)를 위한 프롬프트 작성 도우미입니다. "
    "사용자와의 대화를 보고 원하는 그림을 Danbooru 스타일의 영어 태그로 구성된 프롬프트로 제안하세요. "
    "이전에 제안한 프롬프트가 있으면 그걸 기준으로 요청받은 부분만 수정하고 나머지는 그대로 유지하세요. "
    "이미지가 함께 전달되면 그 이미지를 보고 사용자의 수정 요청(색/포즈/배경 등)을 반영하세요. "
    "반드시 아래 JSON 하나만 출력하고 그 외의 텍스트, 설명, 코드블록 기호는 포함하지 마세요:\n"
    '{"reply": "사용자에게 보여줄 짧고 친근한 한국어 답변 1~2문장", '
    '"positive_prompt": "영어 태그들, 쉼표로 구분", '
    '"negative_prompt": "영어 태그들, 쉼표로 구분 (없으면 빈 문자열)"}'
)


def _chatgen_read_image_b64(image_ref):
    """{filename, subfolder, type} 참조로 ComfyUI output(또는 input) 폴더의 이미지를 읽어 base64로 돌려준다."""
    if not image_ref or not image_ref.get("filename"):
        return None
    try:
        kind = image_ref.get("type", "output")
        base_dir = folder_paths.get_input_directory() if kind == "input" else folder_paths.get_output_directory()
        base_dir = os.path.normpath(base_dir)
        path = os.path.normpath(os.path.join(base_dir, image_ref.get("subfolder") or "", image_ref["filename"]))
        if not path.startswith(base_dir):  # 폴더 밖으로 못 나가게(../ 등) 방어
            return None
        with open(path, "rb") as f:
            return base64.b64encode(f.read()).decode("utf-8")
    except Exception:
        return None


def _chatgen_parse_json_reply(text):
    """모델 응답에서 JSON 객체 하나를 최대한 관대하게 뽑아낸다(```json 코드펜스 등 방어)."""
    if not text:
        return None
    cleaned = re.sub(r"^```(?:json)?\s*", "", text.strip())
    cleaned = re.sub(r"```\s*$", "", cleaned)
    try:
        return json.loads(cleaned)
    except Exception:
        pass
    m = re.search(r"\{.*\}", cleaned, re.S)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            return None
    return None


@PromptServer.instance.routes.post("/assetmanager/api/chatgen_message")
async def api_chatgen_message(request):
    """
    대화 기록(+선택적으로 직전 생성 이미지)을 LLM에 보내서, 답변과 제안 프롬프트를 받아온다.
    요청 body: {
      provider: "gemini" | "gpt" | "custom",
      apiKey, endpoint?, model?,                 # endpoint/model은 provider==="custom"일 때만 사용
      messages: [{role: "user"|"assistant", text}, ...],
      image: {filename, subfolder, type} | null  # 직전에 생성된 이미지(수정 요청 시 비전 입력으로 사용)
    }
    응답: { ok: true, reply, positive_prompt, negative_prompt } | { ok: false, error }
    """
    data = await request.json()
    provider = (data.get("provider") or "gemini").strip()
    api_key = (data.get("apiKey") or "").strip()
    endpoint = (data.get("endpoint") or "").strip()
    model = (data.get("model") or "").strip()
    messages = data.get("messages") or []
    image_ref = data.get("image")

    if not messages:
        return web.json_response({"ok": False, "error": "대화 내용이 비어있습니다."})

    image_b64 = _chatgen_read_image_b64(image_ref)
    text_out = ""

    try:
        if provider == "gemini":
            if not api_key:
                return web.json_response({"ok": False, "error": "Gemini API 키가 비어있습니다."})
            gemini_model = model or "gemini-2.5-flash"
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{gemini_model}:generateContent"
            contents = []
            for i, m in enumerate(messages):
                role = "model" if m.get("role") == "assistant" else "user"
                parts = [{"text": m.get("text", "")}]
                if image_b64 and i == len(messages) - 1 and role == "user":
                    parts.append({"inline_data": {"mime_type": "image/png", "data": image_b64}})
                contents.append({"role": role, "parts": parts})
            payload = {"contents": contents, "systemInstruction": {"parts": [{"text": CHATGEN_SYSTEM_PROMPT}]}}
            headers = {"Content-Type": "application/json", "x-goog-api-key": api_key}

            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=payload, headers=headers, timeout=aiohttp.ClientTimeout(total=90)) as resp:
                    resp_json = await resp.json()
                    if resp.status != 200:
                        err_msg = resp_json.get("error", {}).get("message", f"HTTP {resp.status}")
                        return web.json_response({"ok": False, "error": f"Gemini API 오류: {err_msg}"})
            try:
                text_out = resp_json["candidates"][0]["content"]["parts"][0]["text"]
            except Exception:
                text_out = ""

        elif provider in ("gpt", "custom"):
            if provider == "gpt":
                if not api_key:
                    return web.json_response({"ok": False, "error": "GPT API 키가 비어있습니다."})
                url = "https://api.openai.com/v1/chat/completions"
                chat_model = model or "gpt-4o-mini"
            else:
                if not endpoint:
                    return web.json_response({"ok": False, "error": "커스텀 엔드포인트 URL이 비어있습니다."})
                url = endpoint
                chat_model = model or "llama3.2-vision"

            chat_messages = [{"role": "system", "content": CHATGEN_SYSTEM_PROMPT}]
            for i, m in enumerate(messages):
                role = "assistant" if m.get("role") == "assistant" else "user"
                if image_b64 and i == len(messages) - 1 and role == "user":
                    chat_messages.append({
                        "role": role,
                        "content": [
                            {"type": "text", "text": m.get("text", "")},
                            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_b64}"}},
                        ],
                    })
                else:
                    chat_messages.append({"role": role, "content": m.get("text", "")})

            payload = {"model": chat_model, "messages": chat_messages}
            headers = {"Content-Type": "application/json"}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"

            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=payload, headers=headers, timeout=aiohttp.ClientTimeout(total=90)) as resp:
                    resp_json = await resp.json()
                    if resp.status != 200:
                        err_obj = resp_json.get("error", f"HTTP {resp.status}")
                        err_msg = err_obj.get("message", str(err_obj)) if isinstance(err_obj, dict) else str(err_obj)
                        label = "GPT" if provider == "gpt" else "커스텀"
                        return web.json_response({"ok": False, "error": f"{label} API 오류: {err_msg}"})
            try:
                text_out = resp_json["choices"][0]["message"]["content"]
            except Exception:
                text_out = ""
        else:
            return web.json_response({"ok": False, "error": f"알 수 없는 공급자: {provider}"})
    except Exception as e:
        return web.json_response({"ok": False, "error": f"API 통신 실패: {e}"})

    parsed = _chatgen_parse_json_reply(text_out)
    if not parsed:
        # JSON 파싱에 실패해도 대화 자체는 이어갈 수 있게, 원문 텍스트를 reply로라도 보여준다.
        return web.json_response({"ok": True, "reply": text_out or "(응답을 이해하지 못했습니다)", "positive_prompt": "", "negative_prompt": ""})

    return web.json_response({
        "ok": True,
        "reply": parsed.get("reply", ""),
        "positive_prompt": parsed.get("positive_prompt", ""),
        "negative_prompt": parsed.get("negative_prompt", ""),
    })

# ──────────────────────────────────────────────
# 🎨 NovelAI(NAI) 이미지 생성 연동 — 위 나노바나나 블록 바로 아래에 이어서 추가하세요.
# NAI 서버(image.novelai.net)에 요청하면 이미지가 zip 파일로 돌아오므로, 그 안의 png를 꺼내서
# ComfyUI output 폴더의 "nai" 서브폴더에 저장한다(기존 검수 파이프라인이 그대로 인식).
# 인증은 NAI 계정 설정에서 발급하는 Persistent API Token(pst-...)을 Bearer로 사용.
# ──────────────────────────────────────────────

import io
import zipfile

NAI_ENDPOINT = "https://image.novelai.net/ai/generate-image"
NAI_ENCODE_VIBE_ENDPOINT = "https://image.novelai.net/ai/encode-vibe"


async def _encode_nai_vibe(token, image_b64, information_extracted, model):
    """🆕 V4+ 모델의 Vibe Transfer/Precise Reference는 원본 이미지를 그대로 못 넣고,
    반드시 /ai/encode-vibe로 먼저 "vibe 토큰"으로 인코딩한 결과를 넣어야 한다(장당 2 Anlas 소모).
    이 함수가 그 한 단계를 대신 해주고, 인코딩된 결과(base64)를 반환한다. 실패하면 예외를 던진다.

    🆕 500 에러 대응: encode-vibe가 JPEG/WEBP 등 PNG가 아닌 포맷을 받으면 서버 쪽에서 처리 실패로
    보이는 500을 내는 사례가 있어서, 보내기 전에 PIL로 PNG로 통일해서 보낸다(알파 채널은 제거 — RGB로 변환).
    """
    try:
        with Image.open(io.BytesIO(base64.b64decode(image_b64))) as im:
            buf = io.BytesIO()
            im.convert("RGB").save(buf, format="PNG")
            image_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        pass  # 변환 실패해도 원본 그대로 시도는 해봄(여기서 막히면 원인 파악이 더 어려워지므로)

    payload = {"image": image_b64, "information_extracted": information_extracted, "model": model}
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    async with aiohttp.ClientSession() as session:
        async with session.post(NAI_ENCODE_VIBE_ENDPOINT, json=payload, headers=headers,
                                timeout=aiohttp.ClientTimeout(total=60)) as resp:
            body = await resp.read()
            if resp.status != 200:
                detail = body[:200].decode("utf-8", errors="replace")
                raise RuntimeError(f"HTTP {resp.status} {detail}")
            return base64.b64encode(body).decode("ascii")


@PromptServer.instance.routes.post("/assetmanager/api/nai_generate")
async def api_nai_generate(request):
    """
    요청 body: { token, prompt, negativePrompt, model, width, height, steps, scale, sampler,
                 noiseSchedule, seed, qualityToggle, ucPreset, filenamePrefix }
    응답: 성공 시 { ok: true, filename, subfolder, type: "output", seed }
    """
    data = await request.json()
    token = (data.get("token") or "").strip()
    prompt = (data.get("prompt") or "").strip()
    negative = (data.get("negativePrompt") or "").strip()
    model = (data.get("model") or "nai-diffusion-4-5-full").strip()
    filename_prefix = re.sub(r'[\\/:*?"<>|]', "_", (data.get("filenamePrefix") or "nai").strip() or "nai")[:80]

    if not token:
        return web.json_response({"ok": False, "error": "NAI API 토큰이 비어있습니다. 화면에서 토큰(pst-...)을 입력하세요."})
    if not prompt:
        return web.json_response({"ok": False, "error": "프롬프트가 비어있습니다."})

    try:
        width = int(data.get("width") or 832)
        height = int(data.get("height") or 1216)
        steps = int(data.get("steps") or 28)
        scale = float(data.get("scale") or 5.0)
        seed = int(data.get("seed")) % 4294967296  # NAI 시드는 32비트 정수 범위
    except (TypeError, ValueError):
        return web.json_response({"ok": False, "error": "해상도/스텝/CFG/시드 값이 올바른 숫자가 아닙니다."})

    parameters = {
        "params_version": 3,
        "width": width,
        "height": height,
        "scale": scale,
        "sampler": data.get("sampler") or "k_euler_ancestral",
        "steps": steps,
        "seed": seed,
        "n_samples": 1,
        "ucPreset": int(data.get("ucPreset") or 0),
        "qualityToggle": bool(data.get("qualityToggle", True)),
        "sm": bool(data.get("sm", False)),
        "sm_dyn": bool(data.get("smDyn", False)),
        "dynamic_thresholding": False,
        "controlnet_strength": 1,
        "legacy": False,
        "add_original_image": True,
        "cfg_rescale": float(data.get("cfgRescale") or 0),
        "noise_schedule": data.get("noiseSchedule") or "karras",
        "legacy_v3_extend": False,
        "skip_cfg_above_sigma": None,
        "negative_prompt": negative,
    }
    # V4 이상 모델은 v4_prompt / v4_negative_prompt를 반드시 함께 보내야 한다(빠지면 서버가 500을 냄).
    # 🆕 캐릭터별 프롬프트+위치 (NAI V4/V4.5 Multi-Character Prompting). V3 모델은 이 기능 자체가 없어서 건너뜀.
    characters = data.get("characters") or []
    if "diffusion-3" not in model:
        use_coords = len(characters) > 0
        char_captions_pos = []
        char_captions_neg = []
        legacy_character_prompts = []
        for ch in characters:
            cx = float(ch.get("x", 0.5))
            cy = float(ch.get("y", 0.5))
            ch_pos = ch.get("positive") or ""
            ch_neg = ch.get("negative") or ""
            # 프론트엔드(generate.js)에서 이미 가중치 문법 변환을 마친 값이 그대로 넘어온다.
            char_captions_pos.append({"char_caption": ch_pos, "centers": [{"x": cx, "y": cy}]})
            char_captions_neg.append({"char_caption": ch_neg, "centers": [{"x": cx, "y": cy}]})
            # 구버전 NAI 클라이언트/모델 호환용 레거시 필드 (일부 응답 경로에서 여전히 참고됨)
            legacy_character_prompts.append({
                "prompt": ch_pos,
                "uc": ch_neg,
                "center": {"x": cx, "y": cy},
            })

        parameters["use_coords"] = use_coords
        parameters["characterPrompts"] = legacy_character_prompts
        parameters["v4_prompt"] = {
            "caption": {"base_caption": prompt, "char_captions": char_captions_pos},
            "use_coords": use_coords,
            "use_order": True,
        }
        parameters["v4_negative_prompt"] = {
            "caption": {"base_caption": negative, "char_captions": char_captions_neg},
        }

    # 🆕 Img2Img — 원본 이미지가 있으면 action을 img2img로 바꾸고 image/strength/noise를 parameters에 추가.
    # NAI는 img2img일 때 seed를 "매 스텝 노이즈 시드"로도 같이 쓰므로 extra_noise_seed도 같은 값으로 맞춰준다.
    # 🆕 인페인팅 — 거기에 마스크까지 있으면 action이 "infill"로 바뀌고, 모델도 "-inpainting" 전용 버전을 써야 함
    # (미검증: NAI가 실제로 이 모델명 규칙과 action 이름을 쓰는지는 공식 문서 기준으로 짠 것이라 실동작 확인 필요).
    action = "generate"
    img2img = data.get("img2img")
    if img2img and img2img.get("imageBase64"):
        action = "img2img"
        image_b64_in = img2img["imageBase64"]
        if "," in image_b64_in and image_b64_in.strip().lower().startswith("data:"):
            image_b64_in = image_b64_in.split(",", 1)[1]  # 혹시 data URI 접두어가 그대로 왔으면 제거
        parameters["image"] = image_b64_in
        try:
            parameters["strength"] = float(img2img.get("strength", 0.7))
        except (TypeError, ValueError):
            parameters["strength"] = 0.7
        try:
            parameters["noise"] = float(img2img.get("noise", 0))
        except (TypeError, ValueError):
            parameters["noise"] = 0.0
        parameters["extra_noise_seed"] = seed

        mask_b64_in = img2img.get("maskBase64")
        if mask_b64_in:
            if "," in mask_b64_in and mask_b64_in.strip().lower().startswith("data:"):
                mask_b64_in = mask_b64_in.split(",", 1)[1]

            # 🆕 마스크 경계를 가우시안 블러로 부드럽게 만들어서, 다시 그려진 영역과 원본 사이의
            # 딱딱한 이음매(seam)가 덜 티나게 한다. 블러 반경(px)은 프론트에서 받되, 0이면 블러 없이
            # 원본 흑백 그대로 사용(기존 동작 유지).
            try:
                blur_radius = float(img2img.get("maskBlur", 8))
            except (TypeError, ValueError):
                blur_radius = 8.0
            if blur_radius > 0:
                try:
                    with Image.open(io.BytesIO(base64.b64decode(mask_b64_in))).convert("L") as mask_im:
                        from PIL import ImageFilter
                        blurred = mask_im.filter(ImageFilter.GaussianBlur(radius=blur_radius))
                        buf = io.BytesIO()
                        blurred.save(buf, format="PNG")
                        mask_b64_in = base64.b64encode(buf.getvalue()).decode("ascii")
                except Exception:
                    pass  # 블러 실패해도 원본 마스크로 계속 진행(인페인팅 자체는 막지 않음)

            parameters["mask"] = mask_b64_in
            action = "infill"
            if not model.endswith("-inpainting"):
                model = model + "-inpainting"

    # 🆕 Vibe Transfer + Precise Reference 통합 처리.
    # Precise Reference 전용 필드("character_reference": [...])를 따로 만들어봤는데 에러 없이 조용히 무시되는
    # 것으로 보여서(실제로 반영이 안 됨), 확실하게 동작하는 것으로 검증된 Vibe Transfer 경로
    # (encode-vibe → reference_image_multiple/strength_multiple)에 Precise Reference 이미지도 같이 합쳐서
    # 보내는 방식으로 교체했다. "type"(캐릭터/스타일 구분) 정보까지는 못 살리지만, 최소한 참조 자체는
    # 실제로 반영되는 쪽을 택함 — 둘 다 V4 이상 모델에서 사용 가능.
    vibe_images = data.get("vibeTransfer") or []
    precise_refs = data.get("preciseReference") or []
    all_refs = [(v.get("imageBase64"), v.get("extracted", 1.0), v.get("strength", 0.6)) for v in vibe_images if v.get("imageBase64")]
    all_refs += [(p.get("imageBase64"), p.get("fidelity", 0.75), p.get("strength", 1.0)) for p in precise_refs if p.get("imageBase64")]

    # 🆕 V5는 Vibe Transfer/Precise Reference(reference_image_multiple 경유) 호출 시 500을 내는 것을 확인함.
    # 프론트에서 V5일 땐 UI 자체를 숨겨뒀지만, 혹시 모델만 바꾸고 이전에 추가해둔 참조 이미지가 그대로 남아있는
    # 경우를 대비해 서버에서도 한 번 더 막아서 이해하기 쉬운 에러 메시지를 준다.
    if all_refs and "nai-diffusion-5" in model:
        return web.json_response({"ok": False, "error": "V5 모델은 아직 Vibe Transfer/Precise Reference를 지원하지 않는 것으로 확인됐습니다(NAI 서버가 500 반환). 모델을 V4.5로 바꾸거나, 참조 이미지를 모두 제거하고 다시 시도하세요."})

    # 🆕 500 에러 대응(미검증 추정): NAI의 /ai/encode-vibe가 아직 V5 모델 문자열은 못 받아서 서버가
    # 죽는 것으로 보여서, V5로 생성할 때는 인코딩 단계만 V4.5 모델 이름으로 바꿔 보낸다(실제 생성은 V5 그대로).
    # 안 통하면 이 줄만 봐도 바로 원인 좁혀질 것.
    vibe_encode_model = "nai-diffusion-4-5-full" if "nai-diffusion-5" in model else model

    if all_refs:
        ref_images, ref_extracted, ref_strength = [], [], []
        for img_b64, extracted_raw, strength_raw in all_refs:
            if "," in img_b64 and img_b64.strip().lower().startswith("data:"):
                img_b64 = img_b64.split(",", 1)[1]
            try:
                extracted = float(extracted_raw)
            except (TypeError, ValueError):
                extracted = 1.0
            try:
                strength = float(strength_raw)
            except (TypeError, ValueError):
                strength = 0.6
            try:
                encoded = await _encode_nai_vibe(token, img_b64, extracted, vibe_encode_model)
            except Exception as e:
                return web.json_response({"ok": False, "error": f"Vibe/참조 이미지 인코딩 실패(/ai/encode-vibe): {e}"})
            ref_images.append(encoded)
            ref_extracted.append(extracted)
            ref_strength.append(strength)
        parameters["reference_image_multiple"] = ref_images
        parameters["reference_information_extracted_multiple"] = ref_extracted
        parameters["reference_strength_multiple"] = ref_strength

    # 🆕 투명 배경 (V5 전용, 미검증 — 실제 키 이름이 다를 수 있음)
    if data.get("transparentBg"):
        parameters["transparent"] = True

    payload = {"input": prompt, "model": model, "action": action, "parameters": parameters}
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(NAI_ENDPOINT, json=payload, headers=headers,
                                    timeout=aiohttp.ClientTimeout(total=180)) as resp:
                body = await resp.read()
                status = resp.status
    except Exception as e:
        return web.json_response({"ok": False, "error": f"NAI 서버 통신 실패: {e}"})

    if status != 200:
        detail = body[:300].decode("utf-8", errors="replace")
        hints = {
            401: "토큰이 올바르지 않거나 만료되었습니다(pst-로 시작하는 Persistent API Token인지 확인).",
            402: "Anlas가 부족하거나 구독이 필요합니다.",
            429: "동시에 너무 많은 생성 요청이 들어갔습니다. 잠시 후 다시 시도하세요.",
        }
        hint = hints.get(status, "")
        return web.json_response({"ok": False, "error": f"NAI API 오류(HTTP {status}) {hint} {detail}".strip()})

    # 정상 응답은 zip(안에 image_0.png). 혹시 png 원본이 그대로 오는 경우도 같이 처리.
    image_bytes = None
    try:
        if body[:4] == b"PK\x03\x04":
            with zipfile.ZipFile(io.BytesIO(body)) as zf:
                names = [n for n in zf.namelist() if n.lower().endswith((".png", ".webp", ".jpg", ".jpeg"))]
                if names:
                    image_bytes = zf.read(sorted(names)[0])
        elif body[:8] == b"\x89PNG\r\n\x1a\n":
            image_bytes = body
    except Exception as e:
        return web.json_response({"ok": False, "error": f"NAI 응답(zip) 해석 실패: {e}"})

    if not image_bytes:
        return web.json_response({"ok": False, "error": "NAI 응답에서 이미지를 찾지 못했습니다."})

    subfolder = "nai"
    save_dir = os.path.join(folder_paths.get_output_directory(), subfolder)
    os.makedirs(save_dir, exist_ok=True)
    counter = _next_nanobanana_counter(save_dir, filename_prefix)
    filename = f"{filename_prefix}_{counter:05d}_.png"
    try:
        with open(os.path.join(save_dir, filename), "wb") as f:
            f.write(image_bytes)
    except Exception as e:
        return web.json_response({"ok": False, "error": f"이미지 저장 실패: {e}"})

    return web.json_response({"ok": True, "filename": filename, "subfolder": subfolder, "type": "output", "seed": seed})

# ──────────────────────────────────────────────
# 🎬 NAI Director 도구(augment-image API) — 선화추출/스케치/채색/감정변경/배경제거/배경정리.
# 생성(generate-image)과 별개의 엔드포인트. "🛠️ 도구" 탭의 독립 기능이라 큐/대기열과 무관하게
# 이미지 한 장을 바로 변환해서 돌려준다.
# PIL(Pillow)로 업로드된 이미지의 width/height를 읽는다 — ComfyUI 자체가 Pillow에 의존하므로 별도 설치 불필요.
# ──────────────────────────────────────────────

from PIL import Image

NAI_AUGMENT_ENDPOINT = "https://image.novelai.net/ai/augment-image"
NAI_UPSCALE_ENDPOINT = "https://image.novelai.net/ai/upscale"


@PromptServer.instance.routes.post("/assetmanager/api/nai_director")
async def api_nai_director(request):
    """
    요청 body: { token, reqType, imageBase64, prompt?, defry? }
    reqType: lineart | sketch | colorize | emotion | bg-removal | declutter
    응답: 성공 시 { ok: true, filename, subfolder, type: "output" }
    """
    data = await request.json()
    token = (data.get("token") or "").strip()
    req_type = (data.get("reqType") or "").strip()
    image_b64 = data.get("imageBase64") or ""

    if not token:
        return web.json_response({"ok": False, "error": "NAI API 토큰이 비어있습니다."})
    if req_type not in ("lineart", "sketch", "colorize", "emotion", "bg-removal", "declutter", "upscale"):
        return web.json_response({"ok": False, "error": f"알 수 없는 도구 종류입니다: {req_type}"})
    if not image_b64:
        return web.json_response({"ok": False, "error": "원본 이미지가 비어있습니다."})

    if "," in image_b64 and image_b64.strip().lower().startswith("data:"):
        image_b64 = image_b64.split(",", 1)[1]

    try:
        raw = base64.b64decode(image_b64)
        with Image.open(io.BytesIO(raw)) as im:
            width, height = im.size
    except Exception as e:
        return web.json_response({"ok": False, "error": f"이미지를 읽지 못했습니다: {e}"})

    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    # 🆕 2배 업스케일은 augment-image가 아니라 별도의 /ai/upscale 엔드포인트를 쓴다(Anlas 무료).
    if req_type == "upscale":
        # 🆕 공식 문서 기준 업스케일은 4배가 기본(2배 요청 시 400 났던 원인으로 추정) — 프론트에서 scale 값을 받아 반영
        try:
            scale = int(data.get("scale", 4))
        except (TypeError, ValueError):
            scale = 4
        if scale not in (2, 4):
            scale = 4
        # 🆕 "model doesn't exist" 400 대응 — 업스케일도 내부적으로 모델 검증을 거치는 것으로 보여서
        # 현재 NAI 웹 클라이언트가 업스케일에 쓰는 것으로 알려진 모델명을 같이 보낸다(미검증, 계속 안 되면 다른 값 시도 필요).
        payload = {"image": image_b64, "width": width, "height": height, "scale": scale, "model": "nai-diffusion-5-curated"}
        endpoint = NAI_UPSCALE_ENDPOINT
    else:
        payload = {"req_type": req_type, "width": width, "height": height, "image": image_b64}
        # colorize/emotion만 prompt·defry를 받는다(나머지 도구는 해당 파라미터 자체가 없음 — 보내도 서버가 무시할 수 있지만 깔끔하게 생략)
        if req_type in ("colorize", "emotion"):
            payload["prompt"] = data.get("prompt") or ""
            try:
                payload["defry"] = int(data.get("defry", 0))
            except (TypeError, ValueError):
                payload["defry"] = 0
        endpoint = NAI_AUGMENT_ENDPOINT

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(endpoint, json=payload, headers=headers,
                                    timeout=aiohttp.ClientTimeout(total=120)) as resp:
                body = await resp.read()
                status = resp.status
    except Exception as e:
        return web.json_response({"ok": False, "error": f"NAI 서버 통신 실패: {e}"})

    if status != 200:
        detail = body[:300].decode("utf-8", errors="replace")
        hints = {
            401: "토큰이 올바르지 않거나 만료되었습니다.",
            402: "Anlas가 부족하거나 구독이 필요합니다.",
            429: "요청이 너무 몰렸습니다. 잠시 후 다시 시도하세요.",
        }
        hint = hints.get(status, "")
        return web.json_response({"ok": False, "error": f"NAI Director API 오류(HTTP {status}) {hint} {detail}".strip()})

    image_bytes = None
    try:
        if body[:4] == b"PK\x03\x04":
            with zipfile.ZipFile(io.BytesIO(body)) as zf:
                names = [n for n in zf.namelist() if n.lower().endswith((".png", ".webp", ".jpg", ".jpeg"))]
                if names:
                    image_bytes = zf.read(sorted(names)[0])
        elif body[:8] == b"\x89PNG\r\n\x1a\n":
            image_bytes = body
    except Exception as e:
        return web.json_response({"ok": False, "error": f"NAI 응답(zip) 해석 실패: {e}"})

    if not image_bytes:
        return web.json_response({"ok": False, "error": "NAI 응답에서 이미지를 찾지 못했습니다."})

    subfolder = "nai"
    save_dir = os.path.join(folder_paths.get_output_directory(), subfolder)
    os.makedirs(save_dir, exist_ok=True)
    counter = _next_nanobanana_counter(save_dir, f"nai_director_{req_type}")
    filename = f"nai_director_{req_type}_{counter:05d}_.png"
    try:
        with open(os.path.join(save_dir, filename), "wb") as f:
            f.write(image_bytes)
    except Exception as e:
        return web.json_response({"ok": False, "error": f"이미지 저장 실패: {e}"})

    return web.json_response({"ok": True, "filename": filename, "subfolder": subfolder, "type": "output"})


# ──────────────────────────────────────────────
# 🆕 파일 일괄 업스케일 (검수 완료 후 "⬆️ 승인된 파일 일괄 업스케일" 버튼에서 호출)
# 검수에서 "좋음"으로 저장된 파일(디스크 경로)을 한 장씩 NAI 업스케일(/ai/upscale)로 키워서
# "원본이 있는 폴더 안의 하위 폴더(기본 upscaled)"에 같은 파일명(.png)으로 저장한다. 원본은 건드리지 않는다.
# 한 번에 한 장씩 처리하는 라우트이고, 여러 장 반복/진행률/재시도는 프론트(library.js)가 담당한다.
# 업스케일 요청 방식(payload/응답 해석)은 위의 api_nai_director의 upscale 분기와 동일하게 맞췄다.
# ──────────────────────────────────────────────

BATCH_UPSCALE_EXTS = (".png", ".jpg", ".jpeg", ".webp")


@PromptServer.instance.routes.post("/assetmanager/api/nai_upscale_file")
async def api_nai_upscale_file(request):
    """
    요청 body: { token, path, scale?(2|4, 기본 4), outSubfolder?(기본 "upscaled"), skipExisting?(기본 true) }
    응답: { ok: true, outPath, skipped? } 또는 { ok: false, error, status? }
    """
    data = await request.json()
    token = (data.get("token") or "").strip()
    src_path = (data.get("path") or "").strip()
    if not token:
        return web.json_response({"ok": False, "error": "NAI API 토큰이 비어있습니다."})
    if not src_path:
        return web.json_response({"ok": False, "error": "파일 경로가 비어있습니다."})
    if not os.path.isfile(src_path):
        return web.json_response({"ok": False, "error": f"파일을 찾을 수 없습니다: {src_path}"})
    if not src_path.lower().endswith(BATCH_UPSCALE_EXTS):
        return web.json_response({"ok": False, "error": f"이미지 파일(png/jpg/webp)이 아닙니다: {os.path.basename(src_path)}"})

    try:
        scale = int(data.get("scale", 4))
    except (TypeError, ValueError):
        scale = 4
    if scale not in (2, 4):
        scale = 4

    # 저장 하위 폴더 이름은 경로 구분자를 못 쓰게 해서(폴더 밖으로 나가는 것 방지) 이름만 허용
    out_sub = os.path.basename((data.get("outSubfolder") or "upscaled").strip().replace("\\", "/")) or "upscaled"
    skip_existing = data.get("skipExisting", True) is not False

    out_dir = os.path.join(os.path.dirname(src_path), out_sub)
    out_name = os.path.splitext(os.path.basename(src_path))[0] + ".png"
    out_path = os.path.join(out_dir, out_name)
    if skip_existing and os.path.isfile(out_path):
        return web.json_response({"ok": True, "skipped": True, "outPath": out_path})

    try:
        with open(src_path, "rb") as f:
            raw = f.read()
        with Image.open(io.BytesIO(raw)) as im:
            width, height = im.size
    except Exception as e:
        return web.json_response({"ok": False, "error": f"이미지를 읽지 못했습니다: {e}"})

    image_b64 = base64.b64encode(raw).decode("ascii")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    payload = {"image": image_b64, "width": width, "height": height, "scale": scale, "model": "nai-diffusion-5-curated"}

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(NAI_UPSCALE_ENDPOINT, json=payload, headers=headers,
                                    timeout=aiohttp.ClientTimeout(total=180)) as resp:
                body = await resp.read()
                status = resp.status
    except Exception as e:
        return web.json_response({"ok": False, "error": f"NAI 서버 통신 실패: {e}"})

    if status != 200:
        detail = body[:300].decode("utf-8", errors="replace")
        hints = {
            401: "토큰이 올바르지 않거나 만료되었습니다.",
            402: "Anlas가 부족하거나 구독이 필요합니다.",
            429: "요청이 너무 몰렸습니다. 잠시 후 다시 시도하세요.",
        }
        return web.json_response({"ok": False, "status": status,
                                  "error": f"NAI 업스케일 오류(HTTP {status}) {hints.get(status, '')} {detail}".strip()})

    image_bytes = None
    try:
        if body[:4] == b"PK\x03\x04":
            with zipfile.ZipFile(io.BytesIO(body)) as zf:
                names = [n for n in zf.namelist() if n.lower().endswith((".png", ".webp", ".jpg", ".jpeg"))]
                if names:
                    image_bytes = zf.read(sorted(names)[0])
        elif body[:8] == b"\x89PNG\r\n\x1a\n":
            image_bytes = body
    except Exception as e:
        return web.json_response({"ok": False, "error": f"NAI 응답(zip) 해석 실패: {e}"})
    if not image_bytes:
        return web.json_response({"ok": False, "error": "NAI 응답에서 이미지를 찾지 못했습니다."})

    try:
        os.makedirs(out_dir, exist_ok=True)
        with open(out_path, "wb") as f:
            f.write(image_bytes)
    except Exception as e:
        return web.json_response({"ok": False, "error": f"업스케일 파일 저장 실패: {e}"})

    return web.json_response({"ok": True, "outPath": out_path})


# ──────────────────────────────────────────────
# 🆕 일반 업스케일 (검수 완료 후 "⬆️ 승인된 파일 일괄 업스케일" 창의 기본 방식)
# 디스크의 이미지 한 장을 Pillow의 Lanczos 보간으로 확대해서 "원본이 있는 폴더 안의 하위 폴더(기본 upscaled)"에
# 같은 파일명(.png)으로 저장한다. 원본은 건드리지 않는다. API/토큰이 필요 없고 빠르다. (AI 업스케일이 아니라 보간 확대)
# PNG 원본이면 프롬프트/워크플로우 같은 텍스트 메타데이터(prompt, workflow 등)를 그대로 복사해서 확대본에도 남긴다.
# 한 장씩 처리하는 라우트이고, 반복/진행률은 프론트(library.js)가 담당한다. 무거운 확대 연산은 스레드로 돌려서 서버가 안 멈추게 함.
# ──────────────────────────────────────────────

BATCH_UPSCALE_MAX_PIXELS = 100_000_000  # 확대 결과가 1억 화소를 넘으면 메모리 보호를 위해 거부


@PromptServer.instance.routes.post("/assetmanager/api/upscale_file")
async def api_upscale_file(request):
    """
    요청 body: { path, scale?(1.1~8, 기본 2), outSubfolder?(기본 "upscaled"), skipExisting?(기본 true) }
             또는 { filename, subfolder?, type?(output/input/temp, 기본 output), scale?, outSubfolder?, skipExisting? }
             🆕 나노바나나/GPT/NAI처럼 절대경로를 모르고 {filename,subfolder,type}만 아는 호출부(생성 직후
             자동 업스케일)를 위해 추가 — ComfyUI 표준 output/input/temp 폴더 구조로 경로를 직접 계산한다.
    응답: { ok: true, outPath, width, height, skipped? } 또는 { ok: false, error }
    """
    import asyncio

    data = await request.json()
    src_path = (data.get("path") or "").strip()
    if not src_path:
        filename = (data.get("filename") or "").strip()
        if filename:
            subfolder = (data.get("subfolder") or "").strip()
            file_type = (data.get("type") or "output").strip()
            if file_type == "input":
                base_dir = folder_paths.get_input_directory()
            elif file_type == "temp":
                base_dir = folder_paths.get_temp_directory()
            else:
                base_dir = folder_paths.get_output_directory()
            src_path = os.path.normpath(os.path.join(base_dir, subfolder, filename) if subfolder else os.path.join(base_dir, filename))
    if not src_path:
        return web.json_response({"ok": False, "error": "파일 경로가 비어있습니다."})
    if not os.path.isfile(src_path):
        return web.json_response({"ok": False, "error": f"파일을 찾을 수 없습니다: {src_path}"})
    if not src_path.lower().endswith(BATCH_UPSCALE_EXTS):
        return web.json_response({"ok": False, "error": f"이미지 파일(png/jpg/webp)이 아닙니다: {os.path.basename(src_path)}"})

    try:
        scale = float(data.get("scale", 2))
    except (TypeError, ValueError):
        scale = 2.0
    if not (1.1 <= scale <= 8.0):
        scale = 2.0

    out_sub = os.path.basename((data.get("outSubfolder") or "upscaled").strip().replace("\\", "/")) or "upscaled"
    skip_existing = data.get("skipExisting", True) is not False
    out_dir = os.path.join(os.path.dirname(src_path), out_sub)
    out_path = os.path.join(out_dir, os.path.splitext(os.path.basename(src_path))[0] + ".png")
    if skip_existing and os.path.isfile(out_path):
        return web.json_response({"ok": True, "skipped": True, "outPath": out_path})

    def work():
        from PIL.PngImagePlugin import PngInfo
        with Image.open(src_path) as im:
            im.load()
            width, height = im.size
            new_w, new_h = max(1, int(round(width * scale))), max(1, int(round(height * scale)))
            if new_w * new_h > BATCH_UPSCALE_MAX_PIXELS:
                raise ValueError(f"확대 결과가 너무 큽니다 ({new_w}x{new_h}). 배율을 낮춰주세요.")
            text = dict(getattr(im, "text", {}) or {}) if im.format == "PNG" else {}
            if im.mode == "P":
                im = im.convert("RGBA" if "transparency" in im.info else "RGB")
            elif im.mode not in ("RGB", "RGBA", "L", "LA"):
                im = im.convert("RGBA" if "A" in im.mode else "RGB")
            resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
            out = im.resize((new_w, new_h), resample)
            info = PngInfo()
            for key, value in text.items():
                info.add_text(str(key), str(value))
            os.makedirs(out_dir, exist_ok=True)
            out.save(out_path, "PNG", pnginfo=info)
        return new_w, new_h

    try:
        new_w, new_h = await asyncio.get_event_loop().run_in_executor(None, work)
    except ValueError as e:
        return web.json_response({"ok": False, "error": str(e)})
    except Exception as e:
        return web.json_response({"ok": False, "error": f"확대에 실패했습니다: {e}"})
    return web.json_response({"ok": True, "outPath": out_path, "width": new_w, "height": new_h})
# ──────────────────────────────────────────────
