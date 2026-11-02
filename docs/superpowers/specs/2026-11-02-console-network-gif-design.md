# webop：讀取 console／網路請求與 GIF 錄影 設計文件

> 日期：2026-11-02
> 基於 `docs/superpowers/specs/2026-10-31-webop-design.md`（以下稱「主規格」）與 v1（0.6.2）。本文件只寫新增與改變的部分。
> `fcoeoabgfenejglbffodgkkbkcdhcgfn/` 是 Claude in Chrome 1.0.102 參考原始碼：可參考行為與常數，**不複製程式碼**。

---

## 1. 意圖

`docs/roadmap.md` 裡的兩項一起做：

- **讀取 console 與網路請求**：agent 在使用者瀏覽器裡操作網站時，能看到頁面的錯誤、log 與發出的請求，用來除錯（例如「按了送出沒反應」時，看是不是 API 回 500 或 JS 拋例外）。
- **GIF 錄影**：把 agent 的操作過程錄成 GIF，給**人**事後回看或貼給別人看（使用者決定）。不是給 agent 自己看，也不上傳到網頁。

## 2. 目標、非目標、反目標

**目標**
- G1：webop 一接手分頁就開始記錄**網路請求**（使用者決定），包含接手後第一次頁面載入的請求。
- G1b：**console 等 agent 第一次讀 console 時才開始記**（使用者決定，理由：`Runtime.enable` 是反機器人腳本常用的偵測訊號，不讓沒有要看 console 的任務也承擔被判成機器人的風險）。之後持續記到該分頁 detach 為止。
- G2：兩個讀取工具，可用條件篩選、限制筆數、讀後清空（使用者同意）。
- G3：網路請求只揭露最少資訊：URL（已遮蔽）、method、狀態（使用者決定，理由：資訊越少越安全，與 Claude in Chrome 同級）。
- G4：agent 自己決定 GIF 何時開始、何時結束（使用者決定）。
- G5：GIF 每一格標出**點擊位置**與**這一步在做什麼的文字說明**（使用者決定）。
- G6：GIF 匯出成本機檔案，工具回傳絕對路徑，agent 能直接告訴使用者檔案在哪。

**非目標**
- 記錄 request／response headers、request body（POST data）、response body、timing 細節。
- 讀取或修改 cookie、storage。
- GIF 拖放上傳到頁面元素（Claude in Chrome 有，這裡不做）。
- 連續錄影（影片或固定 fps）；GIF 只由「動作截圖」組成。
- 把 console／網路紀錄寫到硬碟、跨 session 保留。
- Service worker、shared worker、iframe 內獨立 target 的 console（只記分頁主 target 能收到的事件；同 process 的 iframe 事件若自然進來就收）。

**反目標（能動，但這樣就算失敗）**
- agent 透過這兩個工具讀到**未授權網域**頁面的 console 或請求。
- 回傳內容裡出現 `Authorization`、`Cookie`、`Set-Cookie` 值，或 URL 中明顯的憑證（token、key、code、sig…）未遮蔽。
- GIF 裡出現 webop 自己的覆蓋層（幻影游標、光暈、停止鈕）。GIF 上的點擊標記與說明文字是匯出時另外畫上去的，不算覆蓋層。
- GIF 的文字說明洩漏使用者輸入的內容（例如密碼）。
- 記錄機制讓既有工具變慢到可感覺，或讓 service worker 記憶體無上限成長。

## 3. 限制

- 沿用主規格 §3 所有限制（Node 26 + TS、MV3、macOS、Chrome ≥ 116、`chrome.debugger` 偵錯提示條）。
- 擴充已持有 `debugger` 權限，抓資料一律走 CDP（`Runtime`、`Network`，必要時 `Log`），不注入頁面去 patch `console`／`fetch`。（Claude 判斷，見 §9）
- NM 單則大小：擴充 → host ≤ 4 GB；host → 擴充 ≤ 1 MB。GIF 位元組由擴充送往 host 方向。
- `docs` 中屬於使用者的規則：每次改 webop 都要同步升 4 處版本號（`apps/extension/manifest.json`、`apps/extension/package.json`、`apps/webop/package.json`、`packages/core/package.json`）並寫 `CHANGELOG.md`。本功能預計升為 **0.7.0**。
- 不複製參考原始碼；可參考它的常數與行為。

## 4. 「一接手就記錄」：debugger attach 時機

**現況**：`apps/extension/src/sw/cdp.ts` 的 `attach()` 是延遲的，第一次需要 CDP（截圖、輸入）時才 attach，且只開 `Page.enable`；`doAttach` 拒絕非 http(s) 網址。

**改為**：
- 分頁一進入 session（`sessions.ts` 的 `createTab`、`adoptTab`）就 attach，並開 `Network.enable`（`Page.enable` 照舊）。**不開 `Runtime.enable`**。
- `Runtime.enable` 只在該分頁第一次呼叫 `browser_read_console_messages` 時開（需要時一併 attach）；開過之後，同一次 attach 期間持續記錄。重新 attach 時，只有「該分頁之前開過 console 記錄」才重開 `Runtime.enable`。其他既有程式路徑（例如 `browser_javascript` 若用到 `Runtime.evaluate`）維持現狀，不因此開 `Runtime.enable`。
- **必須涵蓋第一次載入**：`browser_tabs_create` 開的分頁，其第一個文件請求與後續子資源請求都要被記到。做法由實作者決定，例如：先以 `about:blank` 建立分頁 → attach + enable → 再導航到目標 URL（需放寬 `doAttach` 對 `about:blank` 的檢查，但其他非 http(s) 頁面仍拒絕）。
- **被 detach 之後**（使用者按停止鈕或提示條「取消」、SW 重啟遺失 attach）：尊重使用者撤回，**不主動重掛**任何分頁；維持現有行為，只在下一個**需要 CDP 的工具呼叫**針對那一個分頁 attach，attach 時同樣開 `Network`（以及上述條件下的 `Runtime`）。`browser_read_network_requests` 只讀記憶體緩衝，**不觸發 attach**；`browser_read_console_messages` 只在該分頁從未開過 console 記錄時才 attach＋開 `Runtime`，被使用者撤回（停止鈕／取消）後不靠它重掛。不新增「SW 啟動時主動重掛所有分頁」。（Claude 判斷）
- 空窗期記錄不到，屬已知限制；讀取工具回應時，若該分頁目前未 attach，或自上次讀取後出現過 detach，在結果開頭加一行說明（例如 `Note: recording is paused since … (debugger detached); it resumes on the next browser action on this tab`）。
- **console 回補（需實測）**：`Runtime.enable` 可能會把開啟之前已存在的 console 訊息補送上來。若實測成立就照收（第一次讀 console 就能看到載入時的訊息）；不成立也不另外處理，第一次讀取的回應開頭註明「console 從現在起開始記錄，之前的訊息看不到」。網路請求不可能回補，所以網路一接手就記。
- 黃色偵錯提示條因此會在開分頁時就出現，而不是第一次截圖時，這是可接受代價（主規格 §3 已接受提示條）。
- 擴充的 `takeFreshAttach`／viewport 穩定邏輯（`capture.ts`）要確認在「提前 attach」下仍正確，不能因此多等或少等。

## 5. 讀取 console 與網路請求

### 5.1 記錄內容

**console（每則）**
- `type`：`log`／`info`／`warn`／`error`／`debug`／`exception`（以及 CDP 給的其他 console API 類型照原名）。
- `text`：參數串接後的文字；單則上限 16 KB，超過截斷並標 `…[truncated]`。
- `source`：來源 URL（已遮蔽）、行號、欄號（有就附）。
- `exception` 另附 stack（每行 `at fn (url:line:col)`，URL 已遮蔽）。
- 時間戳。

**網路請求（每筆）**
- `url`（已遮蔽）、`method`、`resource_type`（document／xhr／fetch／script／image…，用於篩選；Claude 判斷）。
- 結果三選一：`status`（HTTP 狀態碼）、`failed: <net error 文字>`（例如 `net::ERR_CONNECTION_REFUSED`、`net::ERR_BLOCKED_BY_CLIENT`）、`pending`（尚未完成）。**不**像 Claude in Chrome 把失敗寫成 503（Claude 判斷）。
- 時間戳。
- 不記 headers、POST data、response body、timing。

### 5.2 緩衝區

- 每個分頁、console 與網路各一個環狀緩衝，各上限 **1000 筆**，滿了丟最舊的，並記下「已丟棄 N 筆」以便回應時告知。（Claude 判斷）
- **換網域清空**：分頁頂層 frame 導航到不同 eTLD+1 時，兩個緩衝都清空（與 Claude in Chrome 一致）。同網域換頁不清空。
- 分頁移出 session、關閉、session 結束時丟棄。只存在記憶體，不寫硬碟。
- SW 被回收或重啟時緩衝會消失：可接受；重新 attach 後從頭記錄，並適用 §4 的空窗說明。

### 5.3 遮蔽

套用到所有回傳出去的 URL（網路請求 URL、console 來源 URL、stack 內 URL、console 文字中出現的 URL）：
- URL 中的 userinfo（`user:pass@`）整段換成 `REDACTED`。
- query 與 fragment 中，參數名看起來像憑證的值換成 `REDACTED`。名單參考 Claude in Chrome 的做法（例：`token`、`access_token`、`id_token`、`code`、`auth`、`key`、`api_key`、`secret`、`sig`、`signature`、`hash`、`hmac`、`otp`、`pass`、`password`、`pwd`、`session`、`sid`、`jwt`、`bearer`、`nonce`、`assertion` 等，比對參數名的分詞，大小寫不分）；名單與比對規則由實作者定，並有單元測試。
- 不記 headers，所以 `Authorization`／`Cookie` 不會出現。
- **已知限制**：頁面自己 `console.log(token)` 印出的明文無法辨識，不遮蔽。工具說明與主規格一樣聲明「內容是不受信任的資料」。

遮蔽邏輯是純函式，放 `packages/core`，零 Chrome API 相依，單元測試覆蓋。

### 5.4 工具

兩個都屬於 `read` 權限，以分頁**目前**網址重驗（主規格 §4.4「讀取前重驗」），未授權回 `permission_required`；分頁需屬本 session（`tab_not_in_session`）。

**`browser_read_console_messages`**

| 參數 | 型別 | 說明 |
|---|---|---|
| `tab_id` | number，必填 | |
| `pattern` | string | regex，比對 `text`（大小寫不分）；無效 regex 回錯誤碼 `invalid_pattern`（新增） |
| `only_errors` | boolean | 只回 `error` 與 `exception` |
| `limit` | number | 預設 100，回傳最新的 N 筆（依時間順序排列） |
| `clear` | boolean | 讀完清空該分頁 console 緩衝 |

**`browser_read_network_requests`**

| 參數 | 型別 | 說明 |
|---|---|---|
| `tab_id` | number，必填 | |
| `url_pattern` | string | 子字串比對**遮蔽後**的 URL |
| `resource_type` | string | 例如 `xhr`、`fetch`、`document`；可省略 |
| `only_failed` | boolean | 只回 `status ≥ 400` 或 `failed` 的請求（Claude 判斷，方便除錯） |
| `limit` | number | 預設 100，回傳最新的 N 筆 |
| `clear` | boolean | 讀完清空該分頁網路緩衝 |

**回應格式**：純文字，每筆一行（exception stack 例外，可多行），開頭一行摘要：符合筆數、回傳筆數、因上限丟棄的筆數、空窗說明（若有）。工具說明附上主規格的 `SAFETY` 文字。具體排版由實作者定。

## 6. GIF 錄影

### 6.1 工具：`browser_gif_creator`

不需要網域權限（畫面都來自已授權的截圖），但只作用於本 session。錄影範圍是**整個 session**（session 的所有分頁，依時間順序），不是單一分頁。

| `action` | 行為 |
|---|---|
| `start_recording` | 清掉舊格、開始錄。已在錄則回提示。結果提醒 agent：開始後立刻做一次 `screenshot` 當第一格。 |
| `stop_recording` | 停止錄，保留格數，回報格數。 |
| `export` | 把目前的格編成 GIF、存檔、回傳絕對路徑與格數、檔案大小。可在錄影中呼叫（先停止再匯出）。匯出後保留格子，直到 `clear` 或下次 `start_recording`。 |
| `clear` | 丟掉所有格。 |

參數：`action`（必填）、`filename`（選填，只取 basename，去掉路徑與不安全字元，自動補 `.gif`）。

### 6.2 格子從哪來

- 錄影期間，**每個會產生截圖的工具呼叫**把該截圖存成一格：`browser_computer` 的所有動作（含 `screenshot`）、`browser_form_input`。不另外截圖，不多耗 CPU。
- `browser_navigate`、`browser_tabs_create` 在錄影期間**額外**截一張當一格（這兩個工具平常不回截圖）；這張不回傳給 agent。（Claude 判斷）
- `zoom` 的局部放大圖**不**當格（它不是頁面全貌）。
- 上限 **50 格**（與 Claude in Chrome 相同）；滿了之後不再加，`stop_recording`／`export` 回應時說明「已達 50 格上限，之後的動作未錄入」。
- 格子存原始截圖（已依預算縮放的 JPEG）＋ metadata：動作種類、點擊座標（截圖座標系）、說明文字、分頁網域、時間。
- 停止鈕、偵錯提示條取消：不影響錄影狀態，只是那段時間沒有動作就沒有格。
- session 結束時，未匯出的格子丟棄。（Claude 判斷）

### 6.3 每格畫面

**標記畫在「動作之前」的畫面上**（Claude 判斷）：格子是動作完成後的截圖，點擊常會換頁或開彈窗，若把圓圈畫在結果畫面上會標錯地方。因此第 N 個動作的點擊標記與說明，畫在**前一格**（動作發生前的畫面）上；GIF 播放順序就是「看到要點哪裡 → 下一格看到結果」。最後一格是最終畫面，說明列寫 `完成`。若動作前沒有同一分頁的上一格（例如錄影開始後第一個動作就是點擊、或切換了分頁），退回畫在該動作自己的結果格上。資料模型：每格 = 截圖 + 「接下來的動作」metadata（可為空）。

匯出時畫在截圖上（使用者要求：點擊位置＋每步文字說明）：
- **點擊位置**：有座標的動作（各種 click、hover、drag 起點與終點、以 `ref` 定位時換算出的實際點擊點）畫醒目的圓圈標記；drag 畫起點到終點的箭頭。
- **文字說明**：每格底部一條半透明說明列，內容例如：
  - `1/12 · 點擊 (412, 230) · example.com`
  - `3/12 · 輸入 14 個字元`
  - `4/12 · 按鍵 Enter`
  - `5/12 · 捲動 ↓ 3`
  - `6/12 · 前往 example.com/login`
  - `7/12 · 表單欄位 ref_12 設值`
- **輸入內容不顯示**：`type` 與 `form_input` 只寫字元數或欄位，不寫值（避免密碼進 GIF；與 `form_input` 不回顯值一致）。（Claude 判斷）
- 以 `ref` 點擊時，若 metadata 有該元素的可存取名稱，說明可寫 `點擊「送出」`；名稱一樣要截斷（≤ 40 字元）。
- 說明列語言：繁體中文。（Claude 判斷）
- 不加浮水印、不加進度條（說明列已有 `n/N`）。

### 6.4 編碼與輸出

- **時間**：每格顯示 1.5 秒，最後一格 3 秒，無限循環。（Claude 判斷）
- **尺寸**：以第一格寬度為準；不同尺寸的格子等比縮放並置中補邊。寬度上限 1280 px（超過等比縮小），控制檔案大小。
- **編碼位置**：在擴充內完成（OffscreenCanvas 畫標記與文字 + 純 JS GIF 編碼器，可放 SW 或 offscreen document，由實作者決定）。新增的編碼器依賴需為純 JS、可被 esbuild 打包、授權相容。
- **寫檔**：擴充把 GIF 位元組送往 host（新的 `ExtToHost` 訊息或併入 tool_result，由實作者決定），由 **`webop native-host`** 寫檔（Claude 判斷：它是 Chrome 的子程序，macOS 隱私權限歸屬 Chrome，而 Chrome 本來就能寫下載資料夾，不會因為 agent 從哪個終端機啟動而跳權限提示）。寫到：
  - 預設資料夾 `~/Downloads/webop/`（不存在就建立）。（Claude 判斷：使用者要分享，放下載資料夾最好找）
  - 檔名預設 `webop-<client_name>-<YYYYMMDD-HHMMSS>.gif`；`filename` 有給就用它；同名時加 `-1`、`-2`。
  - 回傳絕對路徑。
- 匯出失敗（無格、編碼錯、寫檔錯）回明確錯誤碼，例如 `no_frames`、`export_failed`。

## 7. 協定與檔案影響（給實作者的地圖）

- `packages/core/src/protocol.ts`：`ToolName` 新增三個工具；`ErrorCode` 新增 `invalid_pattern`、`no_frames`、`export_failed`（名稱可調）；若 GIF 走獨立訊息則新增對應型別。
- `packages/core`：URL 遮蔽純函式＋測試。
- `apps/webop/src/tool-schemas.ts`：三個工具定義與說明。
- `apps/extension/src/sw/cdp.ts`：attach 時開 `Runtime`／`Network`；事件分派到記錄模組；`doAttach` 放寬 `about:blank`。
- `apps/extension/src/sw/sessions.ts`：`createTab`／`adoptTab` 時提前 attach；移出／關閉時清緩衝。
- 新模組（名稱自訂）：console／網路緩衝與查詢；GIF 格子收集、畫面合成、編碼。
- `apps/extension/src/sw/tools.ts`：三個工具的 handler；權限表把兩個讀取工具歸 `read`。
- `apps/webop`：GIF 寫檔。
- 文件：`README.md`／`README.zh-tw.md` 的「v1 不包含」移除這兩項、補工具表；`docs/roadmap.md` 移除這兩列；`docs/agents/*.md` 的系統提示範本提到新工具；`CHANGELOG.md`。

## 8. 測試與驗收

- **單元**：URL 遮蔽（userinfo、各種憑證參數名、fragment、非憑證參數不誤遮、console 文字中的多個 URL、括號／標點結尾）；緩衝上限與丟棄計數；篩選（pattern、only_errors、only_failed、resource_type、limit 取最新）；GIF 檔名清理與防重名。
- **e2e**（主規格 §7 的 Playwright + Chrome for Testing 環境）：測試頁在載入時 `console.log`／`console.error`、拋未捕捉例外、發 `fetch` 到會回 200／404／500 的端點、發一個會失敗的請求、帶 `?token=abc` 的請求。
  - 用 `browser_tabs_create` 開該頁後**不做任何其他動作**，直接讀網路：要看到載入時的文件與 fetch 請求（驗證 G1）。
  - 開頁後、第一次讀 console 之前，確認分頁上**沒有**開 `Runtime.enable`（例如在 e2e 中監看 CDP 指令或計數）（驗證 G1b）；第一次讀 console 後，頁面再 `console.log` 的訊息讀得到；記錄載入時訊息是否被回補作為實測結果寫進驗收紀錄。
  - `token` 值必須是 `REDACTED`。
  - 導航到另一個 eTLD+1 後緩衝已清空。
  - 未授權網域讀取回 `permission_required`。
  - GIF：start → screenshot → 點擊 → 輸入 → navigate → stop → export；檢查檔案存在、是合法 GIF、格數正確、寬度 ≤ 1280。點擊標記與說明列以人工看一次驗收。
- **手動驗收**（真實 Chrome）：用 opencode 或 grok 實際跑一次「找出某頁按鈕沒反應的原因」並錄 GIF，使用者看 GIF 確認能看懂每一步。

## 9. 屬於 Claude 判斷、尚未經使用者確認的決定

- 抓資料走 CDP，不注入頁面 patch。
- 網路紀錄多記 `resource_type`；失敗請求記 net error 文字，不偽裝成 503。
- `browser_read_network_requests` 多一個 `only_failed` 參數。
- 每分頁每類緩衝上限 1000 筆；換 eTLD+1 清空；只存記憶體。
- 重新 attach 的空窗在回應中註明。
- 工具名：`browser_read_console_messages`、`browser_read_network_requests`、`browser_gif_creator`。
- 被 detach 後不主動重掛；讀取工具不觸發 attach；SW 重啟不主動重掛。
- GIF 標記畫在動作之前的那一格上。
- GIF 寫檔由 native-host 負責。
- GIF 範圍是整個 session（狀態掛在 session 層，工具不帶 `tab_id`）；上限 50 格；`navigate`／`tabs_create` 錄影時額外截一格；`zoom` 不入格。
- 說明列不顯示輸入內容；繁體中文；不加浮水印與進度條。
- 每格 1.5 秒、末格 3 秒、寬度上限 1280 px。
- GIF 存 `~/Downloads/webop/`；session 結束時未匯出的格子丟棄。
- 版本升為 0.7.0。

## 10. 交給實作者決定的事

- 第一次載入要被記到的具體做法（`about:blank` 先 attach 或其他）。
- GIF 編碼器選擇、在 SW 或 offscreen document 編碼。
- GIF 位元組走哪個訊息。
- 遮蔽參數名單的精確內容與比對規則。
- 讀取工具回應的文字排版。
- 標記與說明列的視覺樣式。
