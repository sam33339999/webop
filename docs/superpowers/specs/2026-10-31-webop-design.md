# webop 設計文件

> 日期：2026-10-31
> 取代 `PLAN.md` 的架構部分；`ANALYSIS.md` 仍是執行器行為契約（座標、截圖、輸入、安全），本文件引用它，不重複。
> `fcoeoabgfenejglbffodgkkbkcdhcgfn/` 是 Claude in Chrome 1.0.102 參考原始碼：可參考行為與常數，**不複製程式碼**。

---

## 1. 意圖

Claude in Chrome 好用，是因為它在**使用者平常用的瀏覽器**裡操作：帶著登入狀態、cookie、既有擴充，畫面上看得到 agent 在做什麼，隨時能停。但它只服務 Claude 自家產品。

webop 要把同樣的體驗開放給任何會說 MCP 的 agent。第一批目標是 **opencode**（1.19.x）與 **grok CLI**（1.0.x），兩者都支援以 stdio 啟動本機 MCP server。

使用者最主要的用途：**讓 agent 吃使用者的瀏覽器登入資訊去訪問網站**，讀回內容；其次才是點擊、填表等操作。

## 2. 目標、非目標、反目標

**目標**
- G1：agent 能在使用者日常 Chrome profile 中導航、讀頁面內容、截圖、點擊、輸入。
- G2：任何支援 stdio MCP 的 agent 只需一行設定就能接上；新增 agent 不需改程式。
- G3：操作過程可見（幻影游標、光暈邊框），可隨時停止。
- G4：未經使用者授權的網域，agent 讀不到也動不了。
- G5：安裝只需「載入擴充 + 一個 `webop` 執行檔 + `webop install`」。

**非目標（v1 不做）**
- 另開乾淨／無頭瀏覽器跑自動化（那是 agent-browser、Playwright MCP 的領域）。
- 內建 agent 迴圈或任何 LLM 呼叫。因此 `find`（需第二次 LLM 呼叫）不做；agent 自己讀 `read_page` 決定。
- 跨機器／雲端 agent（WS relay）。
- GIF 錄製、`batch`、console/network 讀取、`file_upload`、`upload_image`。
- Rust。只有量測到效能瓶頸時，才把該段改寫。
- 散布給他人：不上架 Chrome Web Store、不做 Apple 簽章公證。只供使用者本人使用（unpacked 擴充 + 本機打包的 SEA，macOS 上以 ad-hoc `codesign --sign -` 簽署即可執行）。
- Chrome 以外的 Chromium 系瀏覽器（Edge、Brave、Arc）：架構不排斥，v1 只驗 Chrome。

**反目標（技術上能動，但這樣就算失敗）**
- agent 在未授權網域上讀到內容或做出動作，哪怕一次。
- 需要使用者開 `--remote-debugging-port` 或換 profile。
- 截圖裡出現 webop 自己的覆蓋層。
- 兩個 agent 同時連線時互搶分頁或互相干擾。
- 使用者看不出 agent 正在操作哪個分頁。

## 3. 限制

- **執行環境**：Node.js 26 + TypeScript（使用者決定）。擴充最終跑在 Chrome，Node 26 用於 `webop`、建置、測試。目前機器為 Node 24.10，需先以 fnm 安裝 26。
- **打包**：`webop` 以 Node SEA（Single Executable Application）打包成單一執行檔（使用者決定）。
- **Chrome 限制**：
  - 擴充不能 listen port；只能 `connectNative` 或往外連。
  - NM：host → 擴充單則 ≤ 1 MB；擴充 → host 單則 ≤ 4 GB。截圖走後者。
  - 使用 `chrome.debugger` 時 Chrome 頂端會出現偵錯提示條（可接受代價）。使用者按提示條上的「取消」會讓所有分頁的 debugger 一起 detach，視同停止：進行中的呼叫回 `detached_by_user`，下次呼叫重新 attach。
  - 最低 Chrome 版本：116（NM port 與 WebSocket 活動可維持 MV3 service worker 存活）。
  - `chrome://`、Chrome Web Store、PDF viewer 不可 attach。
- **平台**：v1 只支援 macOS（使用者環境）。路徑、socket 寫法保持可移植，但不測 Linux/Windows。

## 4. 架構

### 4.1 程序模型（`webop` 一支程式、兩種模式）

```
opencode / grok
   │  stdio MCP（agent 自己啟動）
   ▼
webop mcp ──────┐
webop mcp ──────┤  Unix socket  ~/.webop/run/<profile_id>.sock（0600）
                ▼
        webop native-host   ← Chrome 透過 connectNative 啟動（每個 profile 一個）
                │  NM stdio（4 bytes 長度前綴 + JSON）
                ▼
        擴充 service worker ── chrome.debugger / scripting / tabs
                │
                ▼
        使用者的分頁（content script：覆蓋層、AX 樹、頁面文字）
```

- **擴充**在 `runtime.onStartup`、`runtime.onInstalled` 與 SW 頂層執行時呼叫 `connectNative("<host 名稱>")`，Chrome 拉起 `webop native-host`；斷線時以指數退避重連。NM port 開著時 SW 不會被回收。
- **`webop native-host`**：唯一持有 NM 通道的程序；在 socket 上 listen，接受多個 `webop mcp` 連線，負責 session 註冊與訊息路由。
- **`webop mcp`**：每個 agent 一個，stdio MCP server。啟動時連 socket；連不上（Chrome 沒開或擴充沒載入）時，工具呼叫回明確錯誤，不 crash，並在之後的呼叫自動重試連線。
- 參考實例：Claude Code 的 `claude --chrome-native-host` 就是這個模式（見 `PLAN.md` 第 7 節）。

### 4.2 多 profile

使用者同時開多個 Chrome profile，且每個都裝了擴充。每個 profile 的擴充各自 `connectNative`，各自拉起一個 `webop native-host`。

- **profile 身分**：擴充首次安裝時產生隨機 `profile_id` 存於 `chrome.storage.local`；顯示名稱 `profile_label` 預設取 `chrome.identity.getProfileUserInfo()` 的 email（未登入則為 `profile-<前 6 碼>`），可在設定頁改名。
- **握手**：NM 連上後擴充先送 `hello {profile_id, profile_label, extension_version}`；native-host 收到後才在 `~/.webop/run/<profile_id>.sock` listen，並寫 `~/.webop/run/<profile_id>.json`（label、pid、啟動時間）。結束時刪除兩者；啟動時清掉 pid 已不存在的殘留檔。
- **agent 選 profile**：
  1. agent 設定可寫 `webop mcp --profile <label 或 id>`，固定綁定。
  2. 未指定時：只有一個 profile 在線就自動使用；多個在線時，工具呼叫回 `profile_required` 並列出在線 profile，agent 以 `browser_profile_select` 選定。
  3. 一個 session 一次只綁一個 profile；可重新 select 切換。
- 授權清單、分頁群組都屬於各自 profile，互不共用。

### 4.3 Session 與分頁

- 每個 `webop mcp` 連線 = 一個 session，帶 `client_name`（取自 MCP `initialize` 的 clientInfo，例如 `opencode`）。
- 每個 session 擁有一個 Chrome **分頁群組**（tab group），標題為 `webop · <client_name>`，顏色依 session 區分。
- session 只能操作自己群組內的分頁；`tabs_create` 開在自己群組。**v1 不接管使用者既有分頁**：新分頁與使用者共用同一 profile 的 cookie，已足以「帶登入狀態訪問網站」。
- 新分頁開在使用者目前視窗、**背景**（`active:false`），不搶焦點；以分頁群組標題與顏色標示。截圖背景分頁依 `ANALYSIS.md` 第 3 節的 focus emulation 處理。
- session 結束（MCP 斷線）：detach debugger、移除覆蓋層；分頁與群組保留，不自動關閉。

### 4.4 授權模型（G4，最高優先）

- **兩級權限、按網域（eTLD+1）**：
  - `read`：`navigate`、`get_page_text`、`read_page`、`screenshot`。
  - `act`：`click`、`type`、`key`、`scroll`、`drag`、`form_input`。`act` 隱含 `read`。
  - `javascript` 為第三級：設定頁全域開關（預設關閉）**且**該網域另外授權 `javascript`，兩者都成立才可執行；不被 `act` 隱含。
- **授權範圍**：「本次」（session 結束失效）或「永久」。永久清單存 `chrome.storage.local`，可在擴充設定頁檢視、撤銷。
- **拒絕清單**：使用者可設永不允許的網域（例：網銀），agent 請求時直接拒絕、不跳詢問。
- **詢問 UI**：由擴充開一個**擴充自己的 popup 視窗**（`chrome.windows.create({type:"popup"})`），顯示：哪個 agent、哪個網域、要 `read` 或 `act`、目前截圖與預定點擊位置（若有）。不在頁面內畫詢問框，避免頁面腳本偽造點擊。
- **逾時**：詢問 60 秒未回應視為拒絕。
- **動作前重驗**：每個 `act` 動作送出前，再比對一次分頁目前網域與授權；換網域即中止，回 `security_check_failed`（行為同 `ANALYSIS.md` 第 6 節）。
- **導航**：`navigate` 到未授權網域時先詢問 `read`，未通過不導航。
- **讀取前重驗**：每個 `read` 類工具執行前，以分頁**目前**網址重驗。已授權頁面因重新導向（含 SSO）或點擊連結跳到未授權網域時，不回傳內容，改回 `permission_required` 並觸發詢問。
- **跨網域 iframe**：`read_page`、`get_page_text` 只讀頂層 frame 與同網域 frame（content script 不開 `all_frames` 讀跨網域內容）。截圖無法遮罩 iframe，跨網域 iframe 的畫面會出現在截圖中，列為已知限制。
- **頁面內容是資料**：所有讀回的文字、AX 樹在 MCP 回應中標示為不受信任內容（工具說明與系統提示範本都要寫明）。

### 4.5 工具集（v1）

MCP 工具名稱以 `browser_` 為前綴。行為細節依 `ANALYSIS.md`。

| MCP 工具 | 權限 | 說明 |
|---|---|---|
| `browser_profiles_list` | — | 列出在線 profile（id、label） |
| `browser_profile_select` | — | 本 session 綁定指定 profile |
| `browser_tabs_list` | — | 列出本 session 群組內分頁（id、標題、網址） |
| `browser_tabs_create` | `read`（目標網域） | 在本 session 群組開新分頁 |
| `browser_tabs_close` | — | 關閉本 session 群組內分頁 |
| `browser_navigate` | `read` | 導航、前進、後退；等待 load |
| `browser_get_page_text` | `read` | 主要內容的純文字（去除導覽列等雜訊，上限字元數） |
| `browser_read_page` | `read` | AX 樹 + `ref_N`；支援 `interactive` 過濾、`ref_id` 聚焦、字元上限 |
| `browser_computer` | `read`（screenshot、zoom）／`act`（其餘） | action：`screenshot`、`zoom`、`left_click`、`right_click`、`double_click`、`type`、`key`、`scroll`、`scroll_to`（ref）、`left_click_drag`、`hover` |
| `browser_form_input` | `act` | 依 ref 設定 input/select/checkbox 值 |
| `browser_javascript` | `javascript` | 在頁面執行 JS（預設關閉） |

- **兩種定位方式都要支援**：`left_click`、`right_click`、`double_click`、`hover`、`left_click_drag`（起點與終點各自）接受 `coordinate` **或** `ref` 二擇一。`ref` 走 `ANALYSIS.md` 第 4 節：`scrollIntoView` → `getBoundingClientRect()` 中心 → 照樣送滑鼠事件；ref 失效回 `stale_ref`。
- 座標系、OOB 檢查、輸入事件時序：照 `ANALYSIS.md` 第 2、3、5 節。
- **截圖預算可調**：`ANALYSIS.md` 的 28 px/token、1568 上限是 Claude 的數值，作為預設；`webop mcp --image-max-px <n> --image-max-tokens <n> --px-per-token <n>` 可依 agent 背後的模型覆寫。座標框架不受影響（模型永遠給全解析度座標）。
- 動作類 action 完成後自動附一張新截圖。
- 錯誤一律帶 `error_code`（例：`not_connected`、`permission_denied`、`permission_required`、`detached_by_user`、`stopped_by_user`、`profile_required`、`stale_ref`、`security_check_failed`、`oob`、`attach_failed`、`protected_page`、`tab_not_in_session`）。

### 4.6 覆蓋層（G3）

- 幻影游標（跟隨每次滑鼠事件）、分頁光暈邊框（session 色）、右下角停止鈕。
- Shadow DOM 隔離；截圖前隱藏、截圖後恢復。
- **停止鈕**：中止該 session 正在進行與排隊中的工具呼叫（回 `stopped_by_user`），detach debugger。session 本身不斷線，agent 下一次呼叫可繼續，但會重新觸發本次授權詢問。
- 擴充 action 圖示的 badge 顯示目前活躍 session 數。

### 4.7 安裝與 ID

- 擴充 `manifest.json` 以 `key` 欄位固定擴充 ID。注意：若日後上架 Chrome Web Store，ID 由商店決定，只能把商店公鑰回填到開發版 `key`，不能反過來。
- `webop install`：寫入 NM host manifest 到 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/<host 名稱>.json`，`path` 指向包裝腳本 `~/.webop/bin/webop-native-host`（內容 `exec <webop 絕對路徑> native-host`），`allowed_origins` 為固定 ID。`webop uninstall` 反向移除。
- `webop doctor`：檢查 host manifest、socket、擴充連線狀態。
- 每個 agent 的接法說明與系統提示範本放 `docs/agents/opencode.md`、`docs/agents/grok.md`。

## 5. 專案結構

```
packages/core/        協定型別（ToolCall/ToolResult/錯誤碼）、coords、budget；零 Chrome/Node API 相依
apps/extension/       MV3：service worker、CDP 封裝、截圖、輸入、權限、覆蓋層、AX 樹、頁面文字
apps/webop/           CLI：native-host、mcp、install、uninstall、doctor；SEA 打包
docs/agents/          各 agent 接法與提示範本
tests/e2e/            真瀏覽器端到端
```

pnpm workspaces。原 `PLAN.md` 的 `apps/hermes/`、`apps/nm-host/`、`apps/bridge/` 不再存在。

## 6. 里程碑與驗收

順序依「日常瀏覽器安全」調整：授權在第一次真的接上 agent 之前就要擋住。

| 里程碑 | 內容 | 驗收 |
|---|---|---|
| M1 核心 | `packages/core`：協定、coords、budget | 座標矩陣單元測試全綠（dpr 1/2/3、scale、邊界、OOB） |
| M2 擴充最小可用 | attach、screenshot、click、type、key、scroll；`read_page`（AX 樹 + ref，含敏感值遮蔽）；**ref 與座標兩種點擊**；覆蓋層隱藏機制 | 以測試頁 e2e：分別用座標與 ref 點按鈕、填表；截圖不含覆蓋層 |
| M3 通道 | `webop native-host` + `webop mcp` + `install`；hello 握手與 per-profile socket；session 與分頁群組；**授權最小版**（只允許永久清單內網域，其他一律拒絕） | opencode 接上，在白名單網域完成「導航 → `read_page` → 以 ref 點擊」；非白名單網域被拒 |
| M4 授權完整版 | read/act 分級、popup 詢問、本次／永久、拒絕清單、設定頁、動作前重驗、停止鈕 | 新網域跳詢問；拒絕後無任何動作；換網域中止；停止鈕可中斷 |
| M5 讀取工具與多 profile | `get_page_text`、`form_input`、`zoom`；`--profile`、`browser_profiles_list/select`、`profile_required` | 在需登入的真實網站上讀回內容；兩個 profile 同時在線時 agent 能選定並只操作該 profile |
| M6 第二個 agent 與打包 | grok 接法文件、SEA 執行檔、`doctor`、兩個 agent 同時操作 | grok 與 opencode 同時各自操作自己的群組，互不干擾 |

## 7. 測試策略

- `packages/core`：Node 26 內建 test runner 或 Vitest（實作者決定）。
- 擴充與通道 e2e：Playwright 以 persistent context 載入未封裝擴充於**獨立測試 profile**。品牌版 Chrome 137 起移除 `--load-extension`，因此 e2e 使用 Chrome for Testing（或 Playwright 附帶 Chromium），正式 Chrome 僅做手動驗收；NM host manifest 寫入該 `--user-data-dir` 對應的 `NativeMessagingHosts/`；測試前用 `webop install --browser-dir <測試 profile 對應目錄>` 註冊 NM host；本機起靜態測試頁伺服器。
- 永遠不在使用者日常 profile 上跑自動化測試。

## 8. 交給實作者決定的事

- 擴充建置工具（Vite + 外掛或其他），只要輸出標準 MV3。
- MCP SDK 選擇（官方 `@modelcontextprotocol/sdk` 為預設）。
- socket 協定細節（建議：換行分隔 JSON，訊息含 `session_id`、`id`）。
- 測試框架、lint、格式化設定。
- `get_page_text` 的主內容擷取演算法。
- 分頁群組顏色分配方式。

## 9. 本文件中屬於 Claude 判斷、尚未經使用者確認的決定

- 授權詢問用擴充自己的 popup 視窗，而非側欄或頁面內對話框。
- read / act / javascript 三級權限；`javascript` 預設關閉。
- 詢問逾時 60 秒視為拒絕。
- 每個 session 一個分頁群組；操作既有分頁需先移入群組。
- session 結束不自動關閉分頁。
- 停止鈕不中斷 MCP 連線，只中止進行中的呼叫並撤銷「本次」授權。
- `javascript` 需全域開關加逐網域授權。
- 讀取前以目前網址重驗；跨網域 iframe 不讀文字，但會出現在截圖（已知限制）。
- v1 不接管使用者既有分頁；新分頁開在目前視窗背景。
- v1 不做 `find`、`batch`、GIF、console/network、檔案上傳。
- v1 只支援 macOS + Chrome。
- profile 身分用擴充自產 `profile_id`；label 預設取登入 email；未指定且多個在線時要求 agent 選擇。
- 截圖預算以 Claude 數值為預設、CLI 參數可覆寫。
