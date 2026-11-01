/**
 * prompt_utils.js
 *
 * textarea 더블클릭 가중치 조절
 *   - 좌 더블클릭: 커서 위치 단어를 (word:1.1) 로 감싸거나 가중치 +0.1
 *   - 우 더블클릭(빠른 우클릭 2회): 가중치 -0.1
 *   - 가중치가 1.0 이 되면 괄호 제거
 *   - textarea 안에서 우클릭 컨텍스트 메뉴 완전 억제 (키보드 단축키는 정상 동작)
 */

(function () {
    "use strict";

    function getTokenAt(text, pos) {
        let start = pos;
        while (start > 0 && !/[,\n\r]/.test(text[start - 1])) start--;
        let end = pos;
        while (end < text.length && !/[,\n\r]/.test(text[end])) end++;

        const raw = text.slice(start, end).trim();
        if (!raw) return null;

        const leadSpaces = text.slice(start, end).length - text.slice(start, end).trimStart().length;
        const trailSpaces = text.slice(start, end).length - text.slice(start, end).trimEnd().length;
        return { start: start + leadSpaces, end: end - trailSpaces, word: raw };
    }

    function parseWeighted(word) {
        const m = word.match(/^\((.+):(\d+(?:\.\d+)?)\)$/);
        if (!m) return null;
        return { inner: m[1], weight: parseFloat(m[2]) };
    }

    function adjustWeight(word, delta) {
        const parsed = parseWeighted(word);
        const inner = parsed ? parsed.inner : word;
        const oldWeight = parsed ? parsed.weight : 1.0;
        const newWeight = Math.round((oldWeight + delta) * 10) / 10;

        if (newWeight <= 0) return inner;
        if (Math.abs(newWeight - 1.0) < 0.001) return inner;
        return `(${inner}:${newWeight.toFixed(1)})`;
    }

    function handleWeightAdjust(ta, delta) {
        const pos = Math.floor((ta.selectionStart + ta.selectionEnd) / 2);
        const token = getTokenAt(ta.value, pos);
        if (!token) return;

        const newWord = adjustWeight(token.word, delta);
        const after = ta.value.slice(token.end);
        const needsComma = after.trimStart()[0] !== ',';
        ta.value = ta.value.slice(0, token.start) + newWord + (needsComma ? ',' : '') + after;

        const newCursor = token.start + newWord.length;
        ta.setSelectionRange(newCursor, newCursor);
        ta.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function bindWeightEvents(ta) {
        if (ta.dataset.weightBound) return;
        ta.dataset.weightBound = "1";

        // 좌 더블클릭 → +0.1
        ta.addEventListener("dblclick", (e) => {
            e.preventDefault();
            handleWeightAdjust(ta, +0.1);
        });

        // 우클릭 컨텍스트 메뉴 완전 억제
        ta.addEventListener("contextmenu", (e) => {
            e.preventDefault();
        });

        // 우 더블클릭: 빠른 우클릭 2회 → -0.1
        let rightClickCount = 0;
        let rightClickTimer = null;

        ta.addEventListener("mousedown", (e) => {
            if (e.button !== 2) return;
            rightClickCount++;
            if (rightClickCount === 1) {
                rightClickTimer = setTimeout(() => { rightClickCount = 0; }, 400);
            } else if (rightClickCount >= 2) {
                clearTimeout(rightClickTimer);
                rightClickCount = 0;
                handleWeightAdjust(ta, -0.1);
            }
        });
    }

    function bindStaticTextareas() {
        ["base-pos", "base-neg", "edit-prompt-value"].forEach((id) => {
            const el = document.getElementById(id);
            if (el) bindWeightEvents(el);
        });
    }

    function observeDynamicTextareas() {
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                m.addedNodes.forEach((node) => {
                    if (!(node instanceof HTMLElement)) return;
                    node.querySelectorAll("textarea").forEach(bindWeightEvents);
                    if (node.tagName === "TEXTAREA") bindWeightEvents(node);
                });
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function init() {
        bindStaticTextareas();
        observeDynamicTextareas();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
