# M6 手動驗收（第二個 agent 與打包）

在日常瀏覽器執行，結果填在每列最後一欄（通過／失敗＋備註，失敗請附錯誤原文）。

- 日期：
- 瀏覽器與版本：
- opencode 版本：
- grok 版本：

## 準備

1. `fnm use 26`
2. `pnpm install && pnpm -r build && pnpm build:sea`
3. 完整結束 opencode（含 `pkill -f "opencode serve"`）與 grok，再進行下面各項。

| # | 步驟 | 預期 | 結果 |
|---|---|---|---|
| 1 | `apps/webop/dist/webop --version`，再 `apps/webop/dist/webop install`；打開 `~/.webop/bin/webop-native-host` | 印出 `webop 0.6.0`；install 輸出含 opencode 設定與 `grok mcp add webop …` 指令；包裝腳本的 `exec` 只執行 `apps/webop/dist/webop`，不含任何 node 路徑 | |
| 2 | 把 `opencode.json` 的 webop `command` 換成 install 印出的新設定；在 `chrome://extensions` 重新載入擴充功能（卡片顯示 0.6.0）；執行 `apps/webop/dist/webop doctor` | 全部 `ok`、exit code 0；列出每個在線 profile 的名稱、session 數與 `extension 0.6.0` | |
| 3 | 在 `chrome://extensions` 停用 webop，再跑 `webop doctor`；之後重新啟用 | 停用時顯示 `warn no browser profile online`；重新啟用後再跑恢復全部 `ok` | |
| 4 | 執行 install 印出的 `grok mcp add …`；`grok mcp list` 確認；在 grok 下指令「開 http://localhost:8765/button.html，讀頁面，用 ref 點按鈕」（測試頁伺服器同 M5） | 跳出詢問視窗（記下上面顯示的 agent 名稱）；允許後完成開分頁 → read_page → ref 點擊；分頁群組標題為 `webop · <grok 的名稱>` | |
| 5 | opencode 與 grok **同時**各下一個要連續操作幾步的指令（例如各自開一個分頁並截圖、點擊數次） | 兩個分頁群組、顏色不同，各自只動自己的分頁；兩邊都沒有 `timeout` 或 `tab_not_in_session` | |
| 6 | 承上，在 grok 的分頁按頁內「停止」 | 只有 grok 回 `stopped_by_user`；opencode 的操作照常完成 | |
| 7 | 完整重開 grok 後，再操作第 4 項按過「本次允許」的網站 | 記錄是否重新詢問；若沒有，再試「結束 grok 的 leader 程序」後是否重新詢問，並把結論寫進 `docs/agents/grok.md` 的「待手動驗收確認」 | |

## 總結

