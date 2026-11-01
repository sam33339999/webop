# webop

與 agent 無關的瀏覽器執行器：一個 MV3 Chrome 擴充功能加上 `webop` CLI，透過 stdio MCP 對外提供十一個 `browser_*` 工具（分頁、導航、讀取、截圖與 zoom、輸入、填表、JavaScript、profile 選擇），讓 opencode 等 agent 操作你日常 Chrome 中已授權的網站。

## 架構

agent ⇄ `webop mcp`（stdio MCP）⇄ per-profile Unix socket ⇄ `webop native-host`（Native Messaging）⇄ Chrome 擴充功能（Service Worker + chrome.debugger）

## 文件

- 設計規格：[docs/superpowers/specs/2026-10-31-webop-design.md](docs/superpowers/specs/2026-10-31-webop-design.md)
- 實作計畫：[M1–M3](docs/superpowers/plans/2026-10-31-webop-m1-m3.md)、[M4](docs/superpowers/plans/2026-10-31-webop-m4.md)、[M5](docs/superpowers/plans/2026-10-31-webop-m5.md)
- opencode 接法：[docs/agents/opencode.md](docs/agents/opencode.md)

## 安裝順序

先執行 `node apps/webop/dist/webop.mjs install` 註冊 Native Messaging host（會印出可直接貼進 opencode 的設定，已含 node 與 `webop.mjs` 的絕對路徑），再在 `chrome://extensions` 載入 `apps/extension/dist`。若順序相反，開啟擴充功能的 options 頁（或重新載入擴充功能）即可立即連線。要移除 host：`node apps/webop/dist/webop.mjs uninstall [--browser-dir <dir>]`。

## 授權與停止

agent 第一次操作某個網站時會跳出詢問視窗（拒絕／本次允許／永久允許），授權分 `read`、`act`（含 `read`）、`javascript` 三級；options 頁可管理永久授權、拒絕清單、JavaScript 開關與 profile 顯示名稱。同時有多個 Chrome profile 在線時，用 `browser_profile_select` 或 `webop mcp --profile <名稱>` 選定；截圖大小可用 `--image-max-px` 等參數依模型調整。操作期間可按頁面右下角的「停止」按鈕、工具列圖示（停止所有 session）或 debugger 資訊列的「取消」隨時中止。細節、錯誤碼與驗收清單見 [docs/agents/opencode.md](docs/agents/opencode.md)。

## 開發

需要 Node 26（`fnm use 26`）與 pnpm。

```bash
pnpm install
pnpm test        # 單元測試（node --test）
pnpm test:e2e    # e2e（Playwright Chromium，暫存 profile；dev build 輸出到 apps/extension/dist-dev，不影響 dist）
pnpm typecheck
```
