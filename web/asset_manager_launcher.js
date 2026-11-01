import { app } from "../../scripts/app.js";

const BUTTON_TOOLTIP = "Launch Asset Manager (Shift+Click opens in new window)";
const ASSET_MANAGER_PATH = "/assetmanager/app";
const NEW_WINDOW_FEATURES = "width=1200,height=800,resizable=yes,scrollbars=yes,status=yes";

const openAssetManager = (event) => {
    // origin 붙여서 absolute url 만들기 (선택사항, 직접 path 써도 무방)
    const url = `${window.location.origin}${ASSET_MANAGER_PATH}`;

    if (event.shiftKey) {
        window.open(url, "_blank", NEW_WINDOW_FEATURES);
        return;
    }

    window.open(url, "_blank");
};

const getAssetManagerIcon = () => {
    // 🌈 아이콘과 유사한 형태로 심플한 SVG 아이콘 (폴더/그림 모양 결합 느낌)
    // 원본 ComfyUI 테마에 어울리도록 monochrome SVG 사용 (여기서는 폴더 아이콘)
    return `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
            <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"></path>
            <!-- 갤러리 느낌을 주기 위해 내부에 이미지 아이콘 형상 추가 -->
            <circle cx="8" cy="11" r="1.5" fill="var(--bg-color, #1e1e1e)"></circle>
            <path d="M6 16l3-4 2 3 3-4 4 5H6z" fill="var(--bg-color, #1e1e1e)"></path>
        </svg>
    `;
};

app.registerExtension({
    name: "AssetManager.TopMenu",

    // ComfyUI (특히 신규 UI) 상단 액션바에 버튼 추가
    actionBarButtons: [
        {
            // icon 클래스 이름 (아이콘 라이브러리 지원 시) 또는 폴백용 심플 클래스
            icon: "icon-[mdi--folder-multiple-image] size-4",
            tooltip: BUTTON_TOOLTIP,
            onClick: openAssetManager
        }
    ],

    async setup() {
        // 커스텀 스타일 인젝션
        const injectStyles = () => {
            const styleId = 'am-top-menu-button-styles';
            if (document.getElementById(styleId)) return;

            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                button[aria-label="${BUTTON_TOOLTIP}"].am-top-menu-button {
                    transition: all 0.2s ease;
                    border: 1px solid transparent;
                }
                button[aria-label="${BUTTON_TOOLTIP}"].am-top-menu-button:hover {
                    background-color: var(--primary-hover-bg) !important;
                }
                button[aria-label="${BUTTON_TOOLTIP}"].am-top-menu-button svg {
                    fill: var(--fg-color, white);
                }
            `;
            document.head.appendChild(style);
        };
        injectStyles();

        // 렌더링된 버튼을 찾아 SVG 아이콘으로 대체
        const replaceButtonIcon = () => {
            const buttons = document.querySelectorAll(`button[aria-label="${BUTTON_TOOLTIP}"]`);
            buttons.forEach(button => {
                button.classList.add('am-top-menu-button');
                button.innerHTML = getAssetManagerIcon();
                button.style.borderRadius = '4px';
                button.style.padding = '6px';
                button.style.backgroundColor = 'var(--primary-bg)';

                const svg = button.querySelector('svg');
                if (svg) {
                    svg.style.width = '20px';
                    svg.style.height = '20px';
                }
            });

            // 아직 버튼이 렌더링되지 않았을 수 있으므로 재귀 대기
            if (buttons.length === 0) {
                requestAnimationFrame(replaceButtonIcon);
            }
        };
        requestAnimationFrame(replaceButtonIcon);
    },
});
