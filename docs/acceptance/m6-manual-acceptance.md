# M6 手動驗收（第二個 agent 與打包）

在日常瀏覽器執行，結果填在每列最後一欄（通過／失敗＋備註，失敗請附錯誤原文）。

- 日期：2026-11-02
- 瀏覽器與版本：Brave（Chromium 156）
- opencode 版本：v2.2.5
- grok 版本：1.0.70

## 準備

1. `fnm use 26`（`node --version` 要是 v26；Node 24 無法 build 單一執行檔）
2. `pnpm install && pnpm -r build && pnpm build:sea`
3. 完整結束 opencode（含 `pkill -f "opencode serve"`）與 grok，再進行下面各項。

| # | 步驟 | 預期 | 結果 |
|---|---|---|---|
| 1 | `apps/webop/dist/webop --version`，再 `apps/webop/dist/webop install`；打開 `~/.webop/bin/webop-native-host` | 印出 `webop 0.6.2`；install 輸出含 opencode 設定與 `grok mcp add webop …` 指令；包裝腳本的 `exec` 只執行 `apps/webop/dist/webop`，不含任何 node 路徑 || 通過。`webop 0.6.1`；install 印出 opencode 設定與 `grok mcp add` 指令；`webop doctor` 顯示包裝腳本只執行 `apps/webop/dist/webop`。 |
| 2 | 把 `opencode.json` 的 webop `command` 換成 install 印出的新設定；在 `chrome://extensions` 重新載入擴充功能（卡片顯示 0.6.2）；執行 `apps/webop/dist/webop doctor` | 全部 `ok`、exit code 0；列出每個在線 profile 的名稱、session 數與 `extension 0.6.2` || 通過。重新載入後 doctor 全部 `ok`、exit code 0，兩個 profile 皆 `extension 0.6.1`（之後修正升為 0.6.2，同樣全部 `ok`）。 |
| 3 | 在 `chrome://extensions` 停用 webop，再跑 `webop doctor`；之後重新啟用 | 停用時顯示 `warn no browser profile online`；重新啟用後再跑恢復全部 `ok` || 通過（使用者執行）。兩個 profile 都停用時 doctor 顯示 `warn no browser profile online`；重新啟用後恢復全部 `ok`。 |
| 4 | 執行 install 印出的 `grok mcp add …`；`grok mcp list` 確認；在 grok 下指令「開 http://localhost:8766/button.html，讀頁面，用 ref 點按鈕」（測試頁：在 `tests/e2e/fixtures` 執行 `python3 -m http.server 8766 --bind 127.0.0.1`） | 跳出詢問視窗（記下上面顯示的 agent 名稱）；允許後完成開分頁 → read_page → ref 點擊；分頁群組標題為 `webop · <grok 的名稱>` || 通過。grok 經 `grok mcp add` 接上；開分頁 → read_page → ref 點擊成功（標題 `clicked:true`）。詢問視窗顯示 `grok-shell-webop`。首次執行時點擊在 3 秒逾時、沒有落地：背景分頁不產生畫面，見 0.6.2 修正。 |
| 5 | opencode 與 grok **同時**各下一個要連續操作幾步的指令（例如各自開一個分頁並截圖、點擊數次） | 兩個分頁群組、顏色不同，各自只動自己的分頁；兩邊都沒有 `timeout` 或 `tab_not_in_session` || 通過（0.6.2）。grok 與 opencode 同時跑，doctor 看到 `normal` 上 2 個 session；兩邊各點 3 次全部成功、標題皆 `clicked:true`；各自 `tabs_list` 只有自己的分頁。0.6.1 時兩邊點擊都逾時，修正後重測。 |
| 6 | 承上，在 grok 的分頁按頁內「停止」 | 只有 grok 回 `stopped_by_user`；opencode 的操作照常完成 || 通過。grok 點 5 次後收到 `stopped_by_user: Not performed: the user pressed stop.`，之後 session 仍可用（再點 6 次成功）；opencode 10 次全部成功、無錯誤。注意：opencode 的點擊在 5 秒內完成，可能早於按下停止；兩邊同時進行時互不影響由 e2e `t_two_agents_stop_one` 覆蓋。 |
| 7 | 完整重開 grok 後，再操作第 4 項按過「本次允許」的網站 | 記錄是否重新詢問；若沒有，再試「結束 grok 的 leader 程序」後是否重新詢問，並把結論寫進 `docs/agents/grok.md` 的「待手動驗收確認」 || 通過，結論已寫入 `grok.md`。每次 grok 執行都會自己啟動 `webop mcp`，所以第二次執行在 127.0.0.1 會再詢問一次（「本次允許」不跨執行）；不需要另外結束 leader。 |

## 總結

7 項全數通過。驗收中找到並修正一個 bug（0.6.2）：在真實瀏覽器裡，對背景分頁點擊會逾時且沒有落地。第 4–7 項由 Claude 透過終端以 `grok -p` 與 `opencode run --standalone` 執行，詢問視窗與停止鈕由使用者操作。

