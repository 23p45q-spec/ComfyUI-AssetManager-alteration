"""
build_tags_ko.py
-----------------
autocomplete.csv (단부루 태그 + 한글 설명) 를 읽어서
프론트엔드(korean_autocomplete.js)가 바로 쓸 수 있는 작은 JSON으로 변환한다.

CSV 한 줄 예시:
    1girl,0,6421189,"[인물 → 인원수 및 관계] 여성 1명: 설명.../ 키워드: 여자, 한명, 솔로"

추출 결과 (entries 배열의 각 항목): [영어태그, 사용횟수, 한글명, [키워드...]]

사용법:
    python build_tags_ko.py autocomplete.csv tags_ko.json
"""
import csv
import json
import re
import sys

# [카테고리경로] 한글명: 설명... / 키워드: kw1, kw2, ...
PATTERN = re.compile(
    r'^\[(?P<cat>.*?)\]\s*(?P<ko>[^:]+):\s*(?P<desc>.*?)(?:\s*/\s*키워드:\s*(?P<kw>.*))?$',
    re.S,
)


def build(csv_path: str, json_path: str) -> None:
    entries = []
    skipped = 0

    with open(csv_path, encoding="utf-8") as f:
        reader = csv.reader(f)
        for row in reader:
            if len(row) < 4:
                skipped += 1
                continue
            tag, _cat_id, count_raw, desc = row[0], row[1], row[2], row[3]

            try:
                count = int(count_raw)
            except ValueError:
                count = 0

            m = PATTERN.match(desc)
            if m:
                ko = m.group("ko").strip()
                kw_raw = m.group("kw")
                kw = [k.strip() for k in kw_raw.split(",") if k.strip()] if kw_raw else []
            else:
                ko, kw = None, []

            entries.append([tag, count, ko, kw])

    # 사용횟수 내림차순 정렬 (같은 한글 표현이 여러 태그에 걸릴 때 우선순위로 사용)
    entries.sort(key=lambda e: -e[1])

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, separators=(",", ":"))

    print(f"총 {len(entries)}개 태그 처리 완료 (스킵 {skipped}개) → {json_path}")


if __name__ == "__main__":
    csv_path = sys.argv[1] if len(sys.argv) > 1 else "autocomplete.csv"
    json_path = sys.argv[2] if len(sys.argv) > 2 else "tags_ko.json"
    build(csv_path, json_path)
