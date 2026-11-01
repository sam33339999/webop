# 在 grok CLI 使用 webop

grok CLI（1.0.x）以 stdio 啟動 webop 的 MCP server。工具、授權、停止、多 profile、錯誤碼與 opencode 完全相同，說明見 [opencode.md](opencode.md)；這份只寫 grok 特有的部分。

## 安裝

1. 依 [opencode.md 的安裝步驟](opencode.md#安裝步驟) build、執行 `webop install`、載入擴充功能。
2. `webop install` 最後會印出一行 grok 指令，直接執行即可，例如：

   ```bash
   grok mcp add webop /path/to/webop-extension/apps/webop/dist/webop -- mcp
   ```

   這會寫入 `~/.grok/config.toml`（使用者層級）。只想在某個專案使用時加 `--scope project`。
3. 確認：`grok mcp list` 列出 `webop`；`grok mcp doctor` 檢查連線。webop 這一端用 `webop doctor` 檢查。

## 參數

webop 的參數放在 `--` 之後，例如釘住 profile、縮小截圖：

```bash
grok mcp add webop /path/to/webop -- mcp --profile Work --image-max-px 1024
```

參數意義見 opencode.md 的「[多個 Chrome profile](opencode.md#多個-chrome-profile)」與「[截圖大小與 zoom](opencode.md#截圖大小與-zoom)」。重新執行 `grok mcp add webop …` 會覆蓋舊設定。

## 系統提示範本

與 opencode 共用，見 [README.md](README.md#系統提示範本)。

## 與 opencode 同時使用

可以。兩者各自是一個 session、各有一個分頁群組，互不干擾；細節見 [README.md](README.md#同時使用多個-agent)。

## grok 的 session 與名稱（2026-11-02 實測，grok 1.0.70）

- **名稱**：grok 握手時自報 `grok-shell-<MCP server 名稱>`。用 `grok mcp add webop …` 註冊時是 `grok-shell-webop`，所以詢問視窗顯示 `grok-shell-webop`，分頁群組標題是 `webop · grok-shell-webop`。
- **session 生命週期**：每個 grok 程序（含 `grok -p` 的每一次執行）都自己啟動一個 `webop mcp`，不經過常駐的 leader。所以 grok 結束時 webop 的 session 也跟著結束，「本次允許」隨之失效，下一次執行會重新詢問。這跟 opencode 不同，opencode 要停掉 `opencode serve` 才會結束 session。
