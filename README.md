# webop

與 agent 無關的瀏覽器執行器：一個 MV3 Chrome 擴充功能加上 `webop` CLI，透過 stdio MCP 對外提供六個 `browser_*` 工具，讓 opencode 等 agent 操作你日常 Chrome 中已授權的網站。

## 架構

agent ⇄ `webop mcp`（stdio MCP）⇄ per-profile Unix socket ⇄ `webop native-host`（Native Messaging）⇄ Chrome 擴充功能（Service Worker + chrome.debugger）

## 文件

- 設計規格：[docs/superpowers/specs/2026-10-31-webop-design.md](docs/superpowers/specs/2026-10-31-webop-design.md)
- 實作計畫：[docs/superpowers/plans/2026-10-31-webop-m1-m3.md](docs/superpowers/plans/2026-10-31-webop-m1-m3.md)
- opencode 接法：[docs/agents/opencode.md](docs/agents/opencode.md)

## 開發

需要 Node 26（`fnm use 26`）與 pnpm。

```bash
pnpm install
pnpm test        # 單元測試（node --test）
pnpm test:e2e    # e2e（Playwright Chromium，暫存 profile）
pnpm typecheck
```
