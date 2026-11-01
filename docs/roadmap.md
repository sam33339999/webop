# 未來想做的功能

規格（`docs/superpowers/specs/2026-10-31-webop-design.md` §2）把下面幾項列為 v1 不做。v1（M1–M6，0.6.2）完成後，這些是之後想做的方向，還沒排優先順序，也還沒有設計。

| 項目 | 現況 | 備註 |
|---|---|---|
| Linux／Windows 支援 | 只支援、只測 macOS | 路徑與 socket 寫法已盡量可移植。要補的是：各平台的 Native Messaging host 註冊位置（Windows 走登錄檔）、socket 改用 Windows named pipe、單一執行檔的打包與簽署、doctor 的檢查目錄 |
| GIF 錄影 | 沒有 | 把 agent 的操作過程錄成 GIF，方便事後回看或分享 |
| 讀取 console 與網路請求 | 沒有 | 讓 agent 讀頁面的 console 訊息與網路請求，方便除錯。屬於讀取類功能，要沿用 `read` 授權與敏感資料遮蔽的原則 |
| 上傳檔案 | 沒有 | 讓 agent 在檔案選擇欄位放入本機檔案。要決定 agent 能碰哪些本機路徑，以及是否需要使用者另外確認 |
