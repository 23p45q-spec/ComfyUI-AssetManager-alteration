# ComfyUI Asset Manager

> 🔧 본 저장소는 [kiritype/ComfyUI-AssetManager](https://github.com/kiritype/ComfyUI-AssetManager)를 **개조(fork)**하여 제작되었습니다. 원본 제작자의 라이선스(MIT)를 그대로 따릅니다.

ComfyUI 환경에서 에셋, 프롬프트, 모델, 생성 파이프라인을 하나의 웹앱으로 통합 관리하는 All-in-One 프론트엔드 확장입니다. 노드를 그래프에 연결하는 방식이 아니라, 설치 후 ComfyUI 상단에 생기는 버튼을 눌러 새 탭에서 전체 앱이 열립니다.

## ✨ 이 버전만의 특징

1. **👗 의상에셋매니저** — 의상 여러 벌을 콤마 하나로 한 번에 입력하고, 칩을 클릭해서 색상(10색+커스텀)·품질(14종) 팔레트로 즉석 조합한 뒤, 행동(포즈) 조각까지 "공통"과 "이 의상 전용"으로 나눠 붙여서 한 번에 조각 세트로 저장합니다. 편집하는 족족 자동 동기화되어 저장 버튼을 누를 필요가 없습니다.
2. **🍌 나노바나나/GPT/NAI ↔ 로컬 체크포인트 후처리 브릿지** — 외부 상업 API(나노바나나·GPT·NAI)로 뽑은 이미지도, 로컬 ComfyUI 체크포인트 기반 업스케일·디테일러·모자이크를 그대로 적용할 수 있습니다. "API로 뽑고 로컬로 다듬기"가 끊김 없이 이어집니다.
3. **📖 전체 기능에 내장된 Alt+클릭 도움말** — 버튼 하나, 드롭다운 하나까지 Alt를 누른 채 클릭하면 그 자리에서 바로 설명이 뜹니다. 복잡한 올인원 도구인데도 별도 설명서가 필요 없습니다.

---

## 📦 설치 방법

1. ComfyUI의 `custom_nodes` 디렉토리로 이동합니다.
   ```bash
   cd ComfyUI/custom_nodes
   git clone https://github.com/23p45q-spec/ComfyUI-AssetManager-alteration.git
   ```
2. 아래 [필요 커스텀노드](#-필요-커스텀노드)와 [필요 모델](#-필요-모델)을 설치합니다.
3. ComfyUI 서버를 재시작합니다.
4. ComfyUI 상단 메뉴에 표시되는 **Asset Manager 버튼**(폴더 아이콘)을 클릭하면 새 탭에서 앱이 열립니다.
   - Shift+클릭 시 별도 창으로 열립니다.
   - ⚠️ ComfyUI의 **신규(Vue 기반) UI**에서만 버튼이 표시됩니다.

---

## 🧩 필요 커스텀노드

ComfyUI Manager에서 이름으로 검색해 설치할 수 있습니다. 하나라도 빠지면 해당 기능(업스케일/디테일러/검열/메인 생성 중 그 부분)이 "노드를 찾을 수 없음" 에러로 중단됩니다.

| 노드 | 용도 |
|---|---|
| [ComfyUI Impact Pack](https://github.com/ltdrdata/ComfyUI-Impact-Pack) | 디테일러/검열의 FaceDetailerPipe, SAMLoader 등 |
| [ComfyUI Impact Subpack](https://github.com/ltdrdata/ComfyUI-Impact-Subpack) | ★필수, 별도 설치★ `UltralyticsDetectorProvider` (Impact Pack 본체에 없음) |
| [rgthree-comfy](https://github.com/rgthree/rgthree-comfy) | Power Lora Loader, SDXL Empty Latent Image |
| [JPS Custom Nodes](https://github.com/JPS-GER/ComfyUI_JPS-Nodes) | Text Prompt Combo, Sampler Scheduler Settings |
| [WAS Node Suite (Revised)](https://github.com/ltdrdata/was-node-suite-comfyui) | Text to Conditioning |

## 📥 필요 모델

| 모델 | 저장 위치 | 출처 |
|---|---|---|
| 얼굴/입 BBOX (`face_yolov8m.pt`), 손 BBOX (`hand_yolov8s.pt`) | `models/ultralytics/bbox/` | [Bingsu/adetailer](https://huggingface.co/Bingsu/adetailer) |
| 눈 디테일러 (`PitEyeDetailer-v2-seg.pt`) | `models/ultralytics/segm/` | CivitAI, 제작자 "Pitpe11" — "Eye Detailer/Segmentation - ADetailer v2" 검색 |
| 검열용 NSFW 탐지 모델 (`ntd11_anime_nsfw_segm_v5-variant1.pt`) | `models/ultralytics/segm/` | [Anime NSFW Detection/ADetailer All-in-One (Civitai)](https://civitai.com/models/1313556/anime-nsfw-detectionadetailer-all-in-one) |
| 업스케일 모델 (`4x-UltraSharp.pth`) | `models/upscale_models/` | [lokCX/4x-Ultrasharp](https://huggingface.co/lokCX/4x-Ultrasharp) (드롭다운에서 다른 모델로 대체 가능) |

> **Impact-Subpack 화이트리스트 등록이 필요할 수 있습니다**: 위 NSFW 탐지 모델이 Impact Subpack의 기본 모델 목록에 없을 경우, `ComfyUI/user/default/ComfyUI-Impact-Subpack/model-whitelist.txt`에 `ntd11_anime_nsfw_segm_v5-variant1.pt`를 한 줄 추가하고 서버를 재시작하세요.

브라우저에서 직접 돌아가는 신체부위 자동감지(ONNX Runtime Web + YOLOv8-face)는 `web/js/ort.min.js`, `web/js/ort-wasm-simd.wasm`, `web/models/yolov8-face/`에 이미 포함되어 있어 별도 설치가 필요 없습니다.

---

## 🗂️ 메뉴별 주요 기능

더 자세한 설명은 앱 안의 **📖 기능 도움말**과, 버튼·드롭다운을 **Alt+클릭**하면 바로 뜨는 개별 설명을 참고하세요.

### 📚 프롬프트 라이브러리
- 작품 > 그룹 > 조각 3단 계층 관리, 아코디언 트리 네비게이션
- Shift+클릭 다중 선택 → 직교곱(Cartesian Product)으로 모든 조합 자동 생성 후 배치 큐 전송
- `requires` 속성으로 부모 태그 선택 시에만 자식 태그 노출
- 드래그앤드롭 정렬, 우클릭 복사/잘라내기/붙여넣기, 실시간 검색, JSON 백업/복원
- **👗 의상에셋매니저**: 위 "이 버전만의 특징" 참고

### 🎛️ 이미지 생성 (Generate)
- 단일/배치 모드, 아키텍처 프리셋(SDXL/Anima)
- UI 토글만으로 업스케일러·디테일러(얼굴/눈/입/손)·검열(모자이크/화이트블러/화이트솔리드) 노드 자동 연결/해제
- 참조 이미지 기반 ControlNet / IP-Adapter / Img2Img / 인페인팅
- **나노바나나(Gemini) / GPT / NAI 외부 API 생성** + 로컬 체크포인트 후처리 브릿지
- **대화하며 이미지 뽑기(ChatGen)**: LLM과 대화하면서 프롬프트를 다듬어 바로 생성
- 라이브 프리뷰(웹소켓 실시간 렌더링), 프로그레스 모니터링

### 🖼️ 갤러리
- 아코디언 폴더 트리, 하위 폴더 이미지 날짜순 통합 조회
- 다중 선택 & 일괄 삭제, 드래그 사각형 다중 선택
- 메타데이터 분석(체크포인트/로라/시드/프롬프트) → 생성 탭으로 즉시 전송

### 🛠️ 도구
- 메타데이터 뷰어, 단독 이미지 검열기(비교 슬라이더, 리터치 캔버스), 이미지 리사이저(비율/최장변/정확한 크기)
- 번호 매겨진 파일 일괄 라벨링, 결측 번호 찾기

### 📝 메모장 & 💾 자동 상태 보존
- 메모장 탭 ↔ 외부 `.txt` 파일 양방향 동기화
- UI 설정 변경 즉시 자동 저장, 브라우저를 닫았다 열어도 상태 완벽 복원

---

## ⚠️ 알려진 제한사항

- **나노바나나/GPT/NAI 로컬 후처리 브릿지**, **갤러리 드래그 다중 선택**: 코드 리뷰는 마쳤으나 실사용 테스트가 제한적이었던 기능입니다. 문제 발견 시 이슈로 남겨주세요.
- Python 백엔드 변경 사항은 **ComfyUI 서버 재시작** 후 적용됩니다.
- 프롬프트 라이브러리 데이터는 `web/data/prompt_library.json`, UI 상태는 `web/data/app_state.json`, 메모장 내용은 `api/memos/`에 저장됩니다(전부 `.gitignore` 처리되어 있어 리포에는 포함되지 않습니다).
