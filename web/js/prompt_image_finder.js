/**
 * prompt_image_finder.js — 🆕 기능: "이 조각으로 생성한 이미지 목록" 단축키
 *
 * 단축키(기본 Alt+F, library.js의 SHORTCUT_DEFS.findImagesByPrompt로 변경 가능)를 누르면,
 * 지금 편집 중인 조각(라이브러리 아이템)으로 생성한 이미지 내역을 바로 보여준다.
 *
 * 🔧 원래는 "태그 겹침 비율로 output 폴더를 훑어 비슷한 프롬프트 찾기"(추측 기반) 기능이었는데,
 * 실사용 중 다른 프롬프트인데도 찾아지는 오탐이 발견됨 → 대신 생성 성공 시점에 그 조각 자체에
 * 정확히 기록해두는 방식(library.js의 recordGeneratedImagesForRefs/openItemGeneratedImagesModal)
 * 으로 완전히 교체됨. 추측 검색은 이제 아예 없음 — 이 파일은 단축키를 그 정확한 내역 보기로
 * 연결해주는 역할만 한다.
 */

(function () {
    "use strict";

    document.addEventListener("keydown", (e) => {
        if (typeof matchesShortcutCombo !== "function" || !matchesShortcutCombo(e, "findImagesByPrompt")) return;
        e.preventDefault();

        const editModal = document.getElementById("work-edit-modal");
        const isEditingItem = editModal && editModal.style.display !== "none";
        const itemId = document.getElementById("edit-prompt-original-id")?.value || null;
        const catId = (typeof activeCategoryId !== "undefined") ? activeCategoryId : null;

        if (isEditingItem && itemId && catId && typeof window.openItemGeneratedImagesModal === "function") {
            window.openItemGeneratedImagesModal(catId, itemId);
        } else {
            alert("조각(프롬프트 라이브러리 아이템)을 편집하는 중에만 쓸 수 있습니다.\n라이브러리에서 조각의 ✏️ 편집 모달을 연 다음 다시 눌러주세요.");
        }
    });
})();
