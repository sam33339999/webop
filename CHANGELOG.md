# Changelog

每次更新都會改版本號；`webop`（CLI／host）與擴充功能永遠是同一個版本。確認目前版本的方式：

- CLI：`node apps/webop/dist/webop.mjs --version`
- 擴充功能：`chrome://extensions` 的卡片，或 options 頁最上方的 Version
- 執行中的 host：`~/.webop/log/host.log` 的 `listening on … (webop X, extension Y)`；兩個數字不同代表其中一邊沒有重新 build 或重新載入

版本規則：里程碑升 minor（M5 → 0.5.0）；里程碑內的修正與小功能升 patch（0.5.1、0.5.2…）。

## 0.5.1 — 2026-11-01

- 修正：某個 profile 的所有一般視窗關掉後（瀏覽器仍在執行），該 profile 仍被當成在線，呼叫回 `internal: No current window`。現在擴充功能會在最後一個一般視窗關閉時斷線、不再自動重連，等該 profile 開出視窗才重新上線；agent 得到的是 `not_connected`。詢問視窗不算一般視窗。
- 防禦：萬一仍遇到 `No current window`，回 `not_connected` 並請使用者開一個視窗，而不是 `internal`。
- 修正：選定 profile 後才改名，`not_connected` 訊息仍顯示舊名稱。
- 修正：擴充功能正在連線時改 profile 名稱，改名可能被丟掉。

## 0.5.0 — 2026-11-01（M5）

- 新工具：`browser_get_page_text`、`browser_form_input`、`browser_javascript`（預設關閉）。
- `browser_computer` 新增 `zoom`。
- 多 profile：`browser_profiles_list`、`browser_profile_select`、`webop mcp --profile`；options 頁可改 profile 顯示名稱。
- 截圖大小參數：`--image-max-px`、`--image-max-tokens`、`--px-per-token`。
- 頁面跳出 alert 等對話框時，呼叫會立刻回應，不再等到逾時。
- 版本號：`webop --version`、options 頁顯示版本、host log 記錄兩邊版本。
- 擴充功能新增 `identity` 權限（讀取登入 email 作為 profile 名稱）。

## 0.0.1（M1–M4）

- 初始版本：分頁、導航、`read_page`、`computer`；授權（read／act／javascript、詢問視窗、拒絕清單）與停止。
