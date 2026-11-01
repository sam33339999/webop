# webop

[English](README.md) | 繁體中文

webop 讓任何支援 MCP 的 coding agent（opencode、grok CLI…）操作**你平常在用的 Chrome**：帶著你的登入狀態和 cookie，只在你允許的網站上動作，過程看得到，隨時可以停。

它由一個 Manifest V3 擴充功能和一支小小的 `webop` 命令列程式組成。agent 透過 stdio MCP 跟 `webop` 溝通；`webop` 經由 Chrome 的 Native Messaging 轉給擴充功能；擴充功能再用 `chrome.debugger` 操作頁面。

```
agent ⇄ webop mcp（stdio MCP）⇄ 每個 profile 一個 Unix socket ⇄ webop native-host（Native Messaging）⇄ 擴充功能 ⇄ 你的分頁
```

目前版本：**0.6.2**（M1–M6 里程碑已完成並手動驗收）。目前只支援 macOS。

## agent 可以用的工具

共 11 個 `browser_*` 工具：

| 工具 | 用途 | 需要的授權 |
|---|---|---|
| `browser_tabs_list` | 列出這個 agent 分頁群組裡的分頁 | 不需要（未授權網站的標題與網址會隱藏） |
| `browser_tabs_create` | 在群組裡開新分頁 | `read` |
| `browser_tabs_close` | 關閉群組裡的分頁 | 不需要 |
| `browser_navigate` | 前往網址，或 `back`／`forward` | `read` |
| `browser_read_page` | 無障礙樹與元素 ref | `read` |
| `browser_get_page_text` | 頁面主內容的純文字 | `read` |
| `browser_computer` | 截圖、`zoom` 放大、點擊／輸入／按鍵／捲動／拖曳／懸停 | 截圖與 zoom 為 `read`，其餘 `act` |
| `browser_form_input` | 用 ref 設定表單欄位（不會回傳所填的值） | `act` |
| `browser_javascript` | 在頁面執行 JavaScript（預設關閉） | `javascript` |
| `browser_profiles_list` | 列出在線的 Chrome profile | — |
| `browser_profile_select` | 選定這個 agent 要操作的 profile | — |

## 安全機制

- **逐網站授權。** agent 第一次碰某個網站時會跳出詢問視窗：「拒絕」、「本次允許」或「永久允許」。等級分 `read`、`act`（包含 `read`）、`javascript`（獨立一級，另外還要在設定頁打開全域開關）。拒絕清單裡的網站一律拒絕、不詢問。
- **動作前再確認一次。** 授權後到真正送出輸入之間，如果分頁跑到別的網站，輸入不會送出；讀取時如果分頁落在未授權的網站，不會回傳任何內容。
- **看得到、停得了。** agent 的分頁放在標題為 `webop · <agent 名稱>` 的分頁群組裡，有發光邊框和游標。可以按頁面右下角的停止鈕、工具列圖示（停止所有 agent），或 debugger 提示列的「取消」。
- **agent 互相隔離。** 每個 agent 連線是一個獨立的 session，有自己的分頁群組，不能動別人的分頁。「本次允許」只屬於按下時的那一個 agent。
- 頁面內容是資料，不是指令；工具說明裡也這樣告訴 agent。

## 需求

- macOS
- Node 26 與 pnpm（`fnm install 26 && fnm use 26`；build 單一執行檔一定要 Node 26）
- Chrome 116 以上（Brave 也可以）

## 安裝

```bash
fnm use 26
pnpm install
pnpm -r build
pnpm build:sea                         # 產生單一執行檔 apps/webop/dist/webop
apps/webop/dist/webop --version        # webop 0.6.2
```

**先**註冊 Native Messaging host，**再**載入擴充功能：

```bash
apps/webop/dist/webop install
```

它會印出擴充功能 ID、一段 opencode 設定，以及一行 `grok mcp add` 指令，路徑都已經填好。接著打開 `chrome://extensions`，開啟「開發人員模式」，按「載入未封裝項目」，選 `apps/extension/dist`。

如果順序反了（先載入擴充功能），打開擴充功能的設定頁（或重新載入它）就會馬上連上。搬移專案目錄、或在別處重新 build 之後，要再執行一次 `webop install`。

用這個指令檢查整體狀態：

```bash
apps/webop/dist/webop doctor
```

它會逐項印出 `ok`／`warn`／`FAIL`（host 設定檔、包裝腳本、在線的 profile、擴充功能版本），每個問題都附修正建議；有任何 `FAIL` 時 exit code 為 1。

移除：`apps/webop/dist/webop uninstall`。

## 接上 agent

- **opencode**：把 `webop install` 印出的設定貼進 `opencode.json`。詳見 [docs/agents/opencode.md](docs/agents/opencode.md)。
- **grok CLI**：執行印出的 `grok mcp add webop … -- mcp`。詳見 [docs/agents/grok.md](docs/agents/grok.md)。
- 其他能啟動 stdio MCP server 的 agent：執行 `apps/webop/dist/webop mcp`。

常用的 `webop mcp` 參數：`--profile <名稱或 id>` 固定使用某個 Chrome profile；`--image-max-px`、`--image-max-tokens`、`--px-per-token` 依模型調整截圖大小。

共用的系統提示範本，以及同時使用多個 agent 的說明：[docs/agents/README.md](docs/agents/README.md)。

## 多個 Chrome profile

每個裝了擴充功能的 profile 都可以操作。同時有多個在線時，agent 會先收到 `profile_required`，要呼叫 `browser_profile_select`（或啟動時就帶 `--profile`）選定一個。profile 的最後一個視窗關掉時就會離線，開出視窗後自動回來。profile 的顯示名稱可以在擴充功能的設定頁修改。

## 版本

CLI 與擴充功能永遠共用同一個版本號，每次修改都會升版，內容記在 [CHANGELOG.md](CHANGELOG.md)。查版本的方式：`apps/webop/dist/webop --version`、`chrome://extensions` 上的擴充功能卡片，或 `webop doctor`（兩邊版本不一致時它也會提醒）。

## 開發

```bash
pnpm test        # 單元測試（node --test）
pnpm typecheck
pnpm test:e2e    # 端到端測試：Playwright Chromium + 用完即丟的 profile；會 build dist-dev 與單一執行檔
```

自動化測試永遠不會碰你自己的瀏覽器 profile。headless Chromium 會照常渲染背景分頁，所以必須在真實瀏覽器才會出現的背景分頁行為，由手動驗收清單負責。

| 路徑 | 內容 |
|---|---|
| `packages/core` | 協定型別、座標換算、截圖預算、授權判斷 |
| `apps/extension` | MV3 擴充功能：service worker、CDP、截圖、輸入、授權、覆蓋層、頁面腳本 |
| `apps/webop` | CLI：`mcp`、`native-host`、`install`、`uninstall`、`doctor`、單一執行檔打包 |
| `tests/e2e` | 瀏覽器端到端測試 |
| `docs` | 設計規格、實作計畫、agent 接法、驗收紀錄、roadmap |

## 文件

- 設計規格：[docs/superpowers/specs/2026-10-31-webop-design.md](docs/superpowers/specs/2026-10-31-webop-design.md)
- 實作計畫：[M1–M3](docs/superpowers/plans/2026-10-31-webop-m1-m3.md)、[M4](docs/superpowers/plans/2026-10-31-webop-m4.md)、[M5](docs/superpowers/plans/2026-10-31-webop-m5.md)、[M6](docs/superpowers/plans/2026-11-01-webop-m6.md)
- agent 接法：[docs/agents/](docs/agents/README.md)
- 手動驗收紀錄：[docs/acceptance/](docs/acceptance/)（M4–M5 的結果在 [docs/agents/opencode.md](docs/agents/opencode.md)）
- 未來想做的功能：[docs/roadmap.md](docs/roadmap.md)

## v1 不包含

上架 Chrome Web Store／公證簽章、Linux 與 Windows、GIF 錄影、讀取 console 與網路請求、上傳檔案，以及 session 結束時自動關閉分頁。除了上架之外，其餘都已列在 [roadmap](docs/roadmap.md)。
