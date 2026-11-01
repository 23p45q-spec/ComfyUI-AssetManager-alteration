# ComfyUI Asset Manager

ComfyUI 환경에서 에셋, 프롬프트, 모델, 파이프라인을 통합 관리하는 All-in-One 프론트엔드 UI 플러그인입니다.

---

## ⚠️ 설치 방법 및 주의사항

### 설치

1. ComfyUI의 `custom_nodes` 디렉토리로 이동합니다.
2. 본 저장소를 복제합니다.
   ```bash
   git clone https://github.com/kiritype/ComfyUI-AssetManager.git
   ```
3. ComfyUI 서버를 재시작합니다.
4. ComfyUI 메인 메뉴에 표시되는 **Asset Manager** 버튼을 클릭하여 실행합니다.

### 검열 모델 다운로드

검열(모자이크/화이트마스크) 기능을 사용하려면 YOLO11 기반 NSFW 검출 모델이 필요합니다.

> **다운로드 링크:**  
> [Anime NSFW Detection / ADetailer All-in-One (Civitai)](https://civitai.com/models/1313556/anime-nsfw-detectionadetailer-all-in-one)

위 링크에서 `ntd11_anime_nsfw_segm` 모델을 다운로드하여 ComfyUI의 모델 폴더`\Ultralytics\segm`에 배치해 주세요.

### Impact-Subpack 화이트리스트 등록

해당 모델은 ComfyUI-Impact-Pack의 기본 모델 목록에 포함되어 있지 않을 수 있습니다.  
아래 절차에 따라 화이트리스트에 수동 등록해 주세요.

1. `ComfyUI/user/default/ComfyUI-Impact-Subpack/` 디렉토리로 이동합니다.
2. `model-whitelist.txt` 파일을 엽니다.
3. 화이트리스트에 모델 파일명을 추가합니다.
   ```
   ntd11_anime_nsfw_segm_v5-variant1.pt
   ```
4. ComfyUI 서버를 재시작하면 모델이 검열 파이프라인에서 인식됩니다.

### 디테일러 모델(yolo) 다운로드
* [눈,손,얼굴 디테일러](https://huggingface.co/ashllay/YOLO_Models/tree/main)
* [입 디테일러](https://civitai.com/models/1306938/adetailer-2d-mouth-detection-yolosegmentation)

위 링크에서 다운로드하여 ComfyUI의 모델 폴더`\Ultralytics\`에 배치해 주세요.

### 필요 노드
* [ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes)
* [rgthree-comfy](https://github.com/rgthree/rgthree-comfy)
* [ComfyUI Impact Pack](https://github.com/ltdrdata/ComfyUI-Impact-Pack)
* [ComfyUI Impact Subpack](https://github.com/ltdrdata/ComfyUI-Impact-Subpack)
* [WAS Node Suite (Revised)](https://github.com/ltdrdata/was-node-suite-comfyui)
* [JPS Custom Nodes for ComfyUI](https://github.com/JPS-GER/ComfyUI_JPS-Nodes)

### 기타 참고사항

- Python 백엔드 변경 사항(갤러리 등)은 **ComfyUI 서버 재시작** 후 적용됩니다.
- 프롬프트 라이브러리 데이터는 `prompt_library.json`, UI 상태는 `app_state.json`에 자동 저장됩니다.

---

## 메뉴별 주요 기능

### 📚 프롬프트 라이브러리 (Prompt Library)

- **작품 > 그룹 > 조각 3단 계층 관리**: 프로젝트·캐릭터·장면을 '작품' 단위로 분류하고, 하위 그룹과 프롬프트 조각을 체계적으로 정리
- **아코디언 트리 네비게이션**: 작품을 클릭하여 펼치고, 그룹을 선택하면 해당 프롬프트 태그가 표시
- **Shift+클릭 다중 선택 & 일괄 큐 전송**: 여러 태그를 다중 선택 후, 직교곱(Cartesian Product)으로 모든 조합을 자동 생성하여 배치 큐에 일괄 전송
- **Requires 종속성 필터링**: `requires` 속성으로 부모 태그 선택 시에만 관련 자식 태그가 동적으로 표시
- **드래그앤드롭 정렬**: 작품/그룹/조각의 순서를 드래그로 자유롭게 변경
- **컨텍스트 메뉴**: 그룹 우클릭으로 복사/잘라내기/붙여넣기, 작품 간 그룹 이동/복제
- **실시간 검색**: 검색바로 프롬프트 태그를 즉시 필터링
- **내보내기/가져오기**: JSON 파일로 라이브러리 백업 및 복원

---

### 🎛️ 이미지 생성 (Generate)

- **단일/배치 모드**: 한 장 생성 또는 큐에 담은 여러 작업을 순차 실행
- **동적 파이프라인 제어**: UI 토글만으로 업스케일러, 디테일러, 검열 노드를 자동 연결/해제
  - **업스케일러**: 모델(4x-UltraSharp 등) 선택 및 배율 설정
  - **디테일러(ADetailer)**: 얼굴/눈/입/손 영역별 개별 ON/OFF
  - **검열(Censorship)**: 모자이크, 흰색 블러, 흰색 솔리드 3종 모드
- **라이브 프리뷰**: KSampler 연산 중 웹소켓으로 실시간 렌더링 과정 시청 (접기/펼치기 지원)
- **프로그레스 모니터링**: 현재 파이프라인 단계("업스케일링 중...", "디테일링 중..." 등)를 텍스트로 표시
- **자동 로그 기록**: 생성마다 사용된 모델·파라미터를 `web/log/` 폴더에 날짜별 저장

---

### 🖼️ 갤러리 (Gallery)

- **아코디언 폴더 트리**: output 폴더의 하위 구조를 탐색기처럼 접고 펼칠 수 있는 트리 뷰
- **하위 이미지 병합 조회**: 상위 폴더 선택 시 모든 하위 폴더의 이미지를 날짜순으로 통합 표시
- **다중 선택 & 일괄 삭제**: Shift/Ctrl 클릭으로 다중 선택 후, 우클릭 메뉴에서 일괄 삭제
- **메타데이터 분석**: 우클릭으로 이미지에 포함된 체크포인트, 로라, 시드, 프롬프트 등의 은닉 정보를 즉시 파싱
- **생성 탭으로 전송**: 분석된 메타데이터를 생성 탭 UI 폼에 자동 적용 (Send to Generate)

---

### 🛠️ 도구 (Tools)

#### 메타데이터 뷰어

- OS 탐색기에서 PNG/WebP 이미지를 드래그앤드롭하여 ComfyUI 메타데이터를 분석
- 체크포인트, 로라, 프롬프트 등을 읽기 전용으로 표시
- **"이 설정으로 생성"** 버튼으로 분석 결과를 생성 탭에 즉시 적용

#### 단독 이미지 검열기

- 기존 이미지를 드래그앤드롭하여 검열(모자이크/화이트마스크) 파이프라인만 단독 실행
- KSampler 없이 YOLO11 검출 + 마스크 합성만 수행하므로 빠른 처리 가능
- **비교 슬라이더**: 처리 전/후 이미지를 슬라이더로 비교
- **리터치 캔버스**: 브러시/지우개로 검열 결과를 직접 수정 후 서버에 저장
- **ZIP 일괄 다운로드**: 완료된 이미지들을 한 번에 압축 다운로드

#### 이미지 리사이저

- 이미지를 드래그앤드롭하여 리사이즈/포맷 변환
- **리사이즈 모드**: 비율(Scale) / 최장변(Longest) / 정확한 크기(Exact)
- **출력 포맷**: PNG / JPEG / WebP (품질 조절 슬라이더)
- Python Pillow 기반으로 ComfyUI 노드 없이 즉시 처리
- **ZIP 일괄 다운로드** 지원

---

### 💾 자동 상태 보존 (Auto-Save)

- UI 설정(체크포인트, 로라, 업스케일러, 디테일러, 검열, 라이브 뷰어 접힘 등)은 변경 즉시 자동 저장
- 브라우저를 닫았다 열어도 이전 상태가 완벽하게 복원
