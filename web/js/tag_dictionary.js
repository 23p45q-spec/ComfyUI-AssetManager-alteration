/**
 * tag_dictionary.js — 태그 사전 "!" 버튼 모듈 (v2)
 *
 * v1(텍스트박스 아래 칩 나열) 폐기 — 태그 수가 많을 때 너무 난잡해짐.
 *
 * v2 방식:
 *   korean_autocomplete.js가 띄우는 자동완성 후보 목록(.ko-ac-dropdown / .ko-ac-item)을
 *   MutationObserver로 감시하다가, 후보 목록이 뜰 때마다 각 항목(.ko-ac-item) 오른쪽에
 *   작은 "!" 버튼을 끼워넣는다.
 *
 *  - "!"를 누르기 전: 아무 반응 없음
 *  - "!"를 누르면: 그 항목의 영어 태그(.ko-ac-en)에 대한 한글 설명이 풍선으로 뜸
 *    (해당 항목을 "선택"하는 동작은 절대 발생하지 않음 — 항목 클릭과 분리되어 있음)
 *  - 풍선은 같은 "!" 다시 누르거나, 풍선 밖 클릭, Esc로 닫힘
 *
 * 데이터: korean_autocomplete.js와 동일한 tags_ko.json을 재사용
 *   형식: [["en태그", 사용횟수, "한글명"|null, ["키워드", ...]], ...]
 */

(function () {
    "use strict";

    const DATA_URL = "/assetmanager/static/js/tags_ko.json"; // 절대경로

    /** enIndex: Map<en태그, {ko, keywords, count}> */
    const enIndex = new Map();
    let dataReady = false;

    async function loadData() {
        try {
            const res = await fetch(DATA_URL, { cache: "no-cache" });
            if (!res.ok) throw new Error("HTTP " + res.status);
            const entries = await res.json();
            for (const [en, count, ko, kw, desc, category] of entries) {
                enIndex.set(en, {
                    ko: ko || null,
                    keywords: Array.isArray(kw) ? kw : [],
                    count: count || 0,
                    desc: desc || null,
                    category: category || null,
                });
            }
            dataReady = true;
            console.log(`[태그 사전] 로드 완료: ${enIndex.size}개 태그`);
        } catch (e) {
            console.error("[태그 사전] tags_ko.json 로드 실패:", e);
        }
    }

    /* ────────────────────────────────────────────
       스타일
       ──────────────────────────────────────────── */

    function ensureStyles() {
        if (document.getElementById("tag-dict-style")) return;
        const style = document.createElement("style");
        style.id = "tag-dict-style";
        style.textContent = `
            .ko-ac-item {
                position: relative;
                padding-right: 30px !important;
            }
            .tag-dict-bang {
                position: absolute;
                right: 6px;
                top: 50%;
                transform: translateY(-50%);
                width: 18px;
                height: 18px;
                min-width: 18px;
                border-radius: 50%;
                border: none;
                background: #555;
                color: #ddd;
                font-weight: 700;
                font-size: 11px;
                cursor: pointer;
                line-height: 18px;
                padding: 0;
                text-align: center;
                flex: none;
            }
            .tag-dict-bang:hover {
                background: #4CAF50;
                color: #111;
            }
            .tag-dict-bang.has-info {
                background: #3a6ea5;
                color: #fff;
            }
            .tag-dict-bang.has-info:hover {
                background: #4CAF50;
                color: #111;
            }
            .tag-dict-bubble {
                position: fixed;
                z-index: 100001;
                max-width: 280px;
                background: #1f1f1f;
                border: 1px solid #4CAF50;
                border-radius: 8px;
                box-shadow: 0 6px 18px rgba(0,0,0,0.55);
                padding: 10px 12px;
                font-size: 13px;
                color: #eee;
            }
            .tag-dict-bubble .tag-dict-en {
                font-weight: 700;
                color: #9ad29a;
                margin-bottom: 4px;
                word-break: break-all;
            }
            .tag-dict-bubble .tag-dict-ko {
                font-size: 14px;
                margin-bottom: 6px;
            }
            .tag-dict-bubble .tag-dict-kwrow {
                display: flex;
                flex-wrap: wrap;
                gap: 4px;
                margin-bottom: 6px;
            }
            .tag-dict-bubble .tag-dict-kw {
                background: #333;
                border-radius: 8px;
                padding: 1px 7px;
                font-size: 11px;
                color: #ccc;
            }
            .tag-dict-bubble .tag-dict-count {
                font-size: 11px;
                color: #999;
            }
            .tag-dict-bubble .tag-dict-empty {
                color: #999;
                font-size: 12px;
            }
            .tag-dict-bubble .tag-dict-category {
                font-size: 10px;
                color: #7aafea;
                background: #1a2a3a;
                border-radius: 4px;
                padding: 1px 6px;
                display: inline-block;
                margin-bottom: 6px;
            }
            .tag-dict-bubble .tag-dict-desc {
                font-size: 12px;
                color: #ccc;
                line-height: 1.6;
                margin-bottom: 6px;
                border-left: 2px solid #4CAF50;
                padding-left: 8px;
            }
        `;
        document.head.appendChild(style);
    }

    /* ────────────────────────────────────────────
       풍선(말풍선) — 클릭으로만 열림/닫힘
       ──────────────────────────────────────────── */

    let bubbleEl = null;
    let bubbleOwnerBtn = null;

    function closeBubble() {
        if (bubbleEl) {
            bubbleEl.remove();
            bubbleEl = null;
        }
        bubbleOwnerBtn = null;
    }

    function openBubble(btn, tagText) {
        ensureStyles();
        if (bubbleOwnerBtn === btn) {
            closeBubble();
            return;
        }
        closeBubble();
        bubbleOwnerBtn = btn;

        const info = enIndex.get(tagText);

        bubbleEl = document.createElement("div");
        bubbleEl.className = "tag-dict-bubble";

        const enRow = document.createElement("div");
        enRow.className = "tag-dict-en";
        enRow.textContent = tagText;
        bubbleEl.appendChild(enRow);

        if (info) {
            // 카테고리
            if (info.category) {
                const catRow = document.createElement("div");
                catRow.className = "tag-dict-category";
                catRow.textContent = info.category;
                bubbleEl.appendChild(catRow);
            }
            // 한글명
            if (info.ko) {
                const koRow = document.createElement("div");
                koRow.className = "tag-dict-ko";
                koRow.textContent = info.ko;
                bubbleEl.appendChild(koRow);
            }
            // 상세 설명문
            if (info.desc) {
                const descRow = document.createElement("div");
                descRow.className = "tag-dict-desc";
                descRow.textContent = info.desc;
                bubbleEl.appendChild(descRow);
            }
            // 키워드 칩
            if (info.keywords && info.keywords.length) {
                const kwRow = document.createElement("div");
                kwRow.className = "tag-dict-kwrow";
                info.keywords.forEach((k) => {
                    const kwEl = document.createElement("span");
                    kwEl.className = "tag-dict-kw";
                    kwEl.textContent = k;
                    kwRow.appendChild(kwEl);
                });
                bubbleEl.appendChild(kwRow);
            }
            // 사용횟수
            const countRow = document.createElement("div");
            countRow.className = "tag-dict-count";
            countRow.textContent = `사용횟수: ${info.count.toLocaleString()}`;
            bubbleEl.appendChild(countRow);
        } else {
            const emptyRow = document.createElement("div");
            emptyRow.className = "tag-dict-empty";
            emptyRow.textContent = dataReady
                ? "사전에 없는 태그입니다."
                : "사전 로딩 중...";
            bubbleEl.appendChild(emptyRow);
        }

        document.body.appendChild(bubbleEl);
        positionBubble(btn);
    }

    function positionBubble(btn) {
        if (!bubbleEl) return;
        const rect = btn.getBoundingClientRect();
        const bubbleRect = bubbleEl.getBoundingClientRect();
        let left = rect.right + 8; // 드롭다운 옆(오른쪽)에 띄움
        let top = rect.top;

        if (left + bubbleRect.width > window.innerWidth - 8) {
            left = rect.left - bubbleRect.width - 8; // 오른쪽 공간 없으면 왼쪽
            if (left < 8) left = Math.max(8, window.innerWidth - bubbleRect.width - 8);
        }
        if (top + bubbleRect.height > window.innerHeight - 8) {
            top = window.innerHeight - bubbleRect.height - 8;
        }
        bubbleEl.style.left = Math.max(8, left) + "px";
        bubbleEl.style.top = Math.max(8, top) + "px";
    }

    document.addEventListener("click", (e) => {
        if (!bubbleEl) return;
        if (bubbleEl.contains(e.target)) return;
        if (bubbleOwnerBtn && bubbleOwnerBtn.contains(e.target)) return;
        closeBubble();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeBubble();
    });
    window.addEventListener(
        "scroll",
        () => {
            if (bubbleEl && bubbleOwnerBtn) positionBubble(bubbleOwnerBtn);
        },
        true
    );
    window.addEventListener("resize", () => {
        if (bubbleEl && bubbleOwnerBtn) positionBubble(bubbleOwnerBtn);
    });

    /* ────────────────────────────────────────────
       드롭다운 항목에 "!" 버튼 주입
       ──────────────────────────────────────────── */

    function injectBangButtons(dropdownEl) {
        ensureStyles();
        const items = dropdownEl.querySelectorAll(".ko-ac-item");
        items.forEach((item) => {
            if (item.querySelector(".tag-dict-bang")) return; // 이미 주입됨
            const enSpan = item.querySelector(".ko-ac-en");
            if (!enSpan) return;
            const tagText = enSpan.textContent;

            const bangBtn = document.createElement("button");
            bangBtn.type = "button";
            bangBtn.className = "tag-dict-bang";
            bangBtn.textContent = "!";
            if (enIndex.has(tagText)) bangBtn.classList.add("has-info");

            // mousedown 단계에서 막아야 korean_autocomplete.js의 행(row) mousedown
            // 핸들러(자동완성 "선택" 적용)가 같이 실행되지 않음
            bangBtn.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
            bangBtn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                openBubble(bangBtn, tagText);
            });

            item.appendChild(bangBtn);
        });
    }

    // korean_autocomplete.js는 드롭다운을 document.body에 직접 append/remove 한다.
    // body의 자식 추가를 감시해서 .ko-ac-dropdown이 새로 생길 때마다 "!" 버튼을 주입.
    const bodyObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
            m.addedNodes.forEach((node) => {
                if (!(node instanceof HTMLElement)) return;
                if (node.classList && node.classList.contains("ko-ac-dropdown")) {
                    injectBangButtons(node);
                }
            });
        }
    });
    bodyObserver.observe(document.body, { childList: true });

    loadData();

    /** 🆕 모델 정보 모달의 태그 칩 등, 자동완성 드롭다운이 아닌 다른 곳에서도
     *  같은 "!" 버튼(풍선 설명)을 재사용할 수 있도록 최소한의 공개 API를 노출.
     *  내부 enIndex/openBubble 등은 그대로 클로저 안에 두고, 이 함수들만 밖에서 부를 수 있게 함.
     *  사용처: ui_manager.js의 showModelInfo() — 모델 정보 모달 ↔ 태그 사전 연결. */
    window.TagDictionary = {
        /** en태그(소문자, 공백 또는 언더스코어 둘 다 허용) 하나를 바로 조회. 없으면 null. */
        lookup(tagText) {
            if (!tagText) return null;
            const norm = tagText.trim().toLowerCase();
            return enIndex.get(norm) || enIndex.get(norm.replace(/ /g, "_")) || enIndex.get(norm.replace(/_/g, " ")) || null;
        },
        /** 버튼 엘리먼트 하나를 받아 그 자리에 풍선을 띄움(자동완성 "!" 버튼과 완전히 동일한 로직). */
        openBubbleFor(btn, tagText) {
            ensureStyles();
            openBubble(btn, tagText.trim().toLowerCase());
        },
        /** 사전 로딩이 끝났는지 여부(끝나기 전엔 "사전 로딩 중..."만 표시됨). */
        isReady() { return dataReady; },
        /** 지정 태그 옆에 자동완성과 똑같은 "!" 버튼(.tag-dict-bang)을 만들어서 반환.
         *  호출한 쪽에서 반환된 버튼을 원하는 위치에 appendChild 하면 됨. */
        createBangButton(tagText) {
            ensureStyles();
            const bangBtn = document.createElement("button");
            bangBtn.type = "button";
            bangBtn.className = "tag-dict-bang";
            bangBtn.textContent = "!";
            if (enIndex.has(tagText.trim().toLowerCase())) bangBtn.classList.add("has-info");
            // .tag-dict-bang 기본 CSS는 .ko-ac-item(position:relative) 안에서 absolute로 오른쪽에 붙게
            // 설계돼 있어서, 그런 부모가 없는 재사용 맥락(모델 정보 모달 등)에선 position을 풀어줘야 함.
            bangBtn.style.position = "static";
            bangBtn.style.transform = "none";
            bangBtn.style.display = "inline-block";
            bangBtn.style.verticalAlign = "middle";
            bangBtn.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
            bangBtn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                openBubble(bangBtn, tagText.trim().toLowerCase());
            });
            return bangBtn;
        }
    };
})();
