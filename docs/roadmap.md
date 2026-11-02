# 未來想做的功能

規格（`docs/superpowers/specs/2026-10-31-webop-design.md` §2）把下面幾項列為 v1 不做。v1（M1–M6，0.6.2；0.7.0 已加入 console／網路／GIF）完成後，這些是之後想做的方向，還沒排優先順序，也還沒有設計。

| 項目 | 現況 | 備註 |
|---|---|---|
| Linux／Windows 支援 | 只支援、只測 macOS | 路徑與 socket 寫法已盡量可移植。要補的是：各平台的 Native Messaging host 註冊位置（Windows 走登錄檔）、socket 改用 Windows named pipe、單一執行檔的打包與簽署、doctor 的檢查目錄 |
| 上傳檔案 | 沒有 | 讓 agent 在檔案選擇欄位放入本機檔案。要決定 agent 能碰哪些本機路徑，以及是否需要使用者另外確認 |
| session 結束時自動關掉它開的分頁 | session 結束（agent 斷線、host 離線）時，分頁與分頁群組都保留（規格 §4.3、§9 的決定） | 可做成選項（例如 options 頁開關或 `webop mcp` 參數），預設維持保留。要決定：按「停止」不算 session 結束、不關分頁；使用者手動拖進群組或操作過的分頁要不要排除；只有 0.5.1 起「最後一個視窗關閉」的離線情況不需要處理（分頁已隨視窗關閉） |
