# Changelog

每次更新都會改版本號；`webop`（CLI／host）與擴充功能永遠是同一個版本。確認目前版本的方式：

- CLI：`node apps/webop/dist/webop.mjs --version`
- 擴充功能：`chrome://extensions` 的卡片，或 options 頁最上方的 Version
- 執行中的 host：`~/.webop/log/host.log` 的 `listening on … (webop X, extension Y)`；兩個數字不同代表其中一邊沒有重新 build 或重新載入

版本規則：里程碑升 minor（M5 → 0.5.0）；里程碑內的修正與小功能升 patch（0.5.1、0.5.2…）。

## 0.7.0 — 2026-11-02

- 新增 `browser_read_network_requests`：agent 接手分頁後就開始記錄網路請求，只回傳網址、方法、資源類型與狀態，不含標頭與內容；網址裡的帳號密碼顯示為 `REDACTED`；跨網站導覽時清空緩衝。需要 `read` 授權。
- 新增 `browser_read_console_messages`：第一次呼叫才開始記錄 console。原因是 `Runtime.enable` 會被反爬蟲腳本偵測到，平常不啟用。實測 Chrome 啟用時會重播先前的訊息（`console replay: yes`），所以第一次讀取就看得到頁面載入時的訊息。建議帶 `pattern` 過濾。需要 `read` 授權。
- 新增 `browser_gif_creator`（`start_recording`／`stop_recording`／`export`／`clear`）：最多 50 張畫面，畫上點擊標記與每一步的繁體中文說明；輸入的文字不會顯示。GIF 由 native host 存到 `~/Downloads/webop/`，可用環境變數 `WEBOP_GIF_DIR` 改位置。
- 變更：建立分頁改為先開 `about:blank`、附加 debugger，再導向網址，所以建立分頁時就會出現黃色的偵錯提示條（以前要到第一次操作才出現）。

## 0.6.2 — 2026-11-02

- 修正：在真實瀏覽器裡，對 agent 開在背景的分頁點擊（沒先截圖）會在 3 秒逾時、點擊沒有落地。背景分頁不產生畫面，`Input.dispatchMouseEvent` 等不到處理；現在送輸入前會先開焦點模擬，分頁隱藏時再強制畫一張畫面（與截圖相同的做法）。headless 測試環境會照常渲染背景分頁，所以之前的 e2e 抓不到。

## 0.6.1 — 2026-11-01

- `pnpm build:sea` 在 Node 26 以前的版本執行時，直接說明要先 `fnm use 26`，而不是丟出 `bad option: --build-sea`。

## 0.6.0 — 2026-11-01（M6）

- 單一執行檔：`pnpm build:sea` 產生 `apps/webop/dist/webop`（Node SEA，macOS ad-hoc 簽署）。從它執行 `webop install`，包裝腳本只執行它自己，不再綁定某個 node 路徑。
- `webop doctor`：檢查 host manifest、包裝腳本與它要執行的檔案、在線 profile、webop 與擴充版本是否一致；有 `FAIL` 時 exit code 為 1。
- host 新增 `ping`（doctor 用），查詢時不會開 session。
- grok CLI 接法：`docs/agents/grok.md`；`webop install` 會印出 `grok mcp add` 指令。共用的系統提示範本移到 `docs/agents/README.md`。
- 兩個 agent 同時操作的 e2e：各自的分頁群組、互不能動對方分頁、「本次允許」各自獨立、停止只影響自己。

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
