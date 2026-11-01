# 在 opencode 使用 webop

webop 讓 agent 透過 MCP（stdio）操作你日常 Chrome 中「你已授權」的網站。提供十一個工具：

| 工具 | 用途 | 等級 |
|---|---|---|
| `browser_tabs_list` | 列出本 session 分頁群組中的分頁 | 無（未授權網站的網址與標題會隱藏） |
| `browser_tabs_create` | 在群組中開新分頁 | `read` |
| `browser_tabs_close` | 關閉群組中的分頁 | 無 |
| `browser_navigate` | 導航，或 `back`／`forward` | `read` |
| `browser_read_page` | 無障礙樹與元素 ref | `read` |
| `browser_get_page_text` | 頁面主內容的純文字（標題、網址、內文） | `read` |
| `browser_computer` | 截圖、`zoom` 放大，以及點擊／輸入／按鍵／捲動／拖曳／懸停 | 截圖與 `zoom` 為 `read`，其餘 `act` |
| `browser_form_input` | 以 ref 設定表單欄位的值 | `act` |
| `browser_javascript` | 在頁面執行 JavaScript（預設關閉） | `javascript` |
| `browser_profiles_list` | 列出在線的 Chrome profile | 不經過擴充功能 |
| `browser_profile_select` | 選定本 session 使用的 profile | 不經過擴充功能 |

## 前置需求

- fnm 與 Node 26（`engines: node >=26`）：`fnm install 26 && fnm use 26`
- pnpm
- Chrome 116 以上

## 安裝步驟

```bash
fnm use 26
pnpm install
pnpm -r build
```

**順序很重要：先註冊 host，再載入擴充功能。**

1. 註冊 Native Messaging host（這一步必須在載入擴充功能之前）：

   ```bash
   node apps/webop/dist/webop.mjs install
   ```

   指令會印出 extension id、manifest 與 wrapper 路徑，以及一段可直接貼上的 opencode 設定（已填入 node 與 `webop.mjs` 的絕對路徑）；把它貼進 `opencode.json` 即可，見下方「opencode 設定」。（測試用途可加 `--browser-dir <dir>` 指定寫入目錄。）
   搬移專案目錄、或在別處重新 build 之後，必須重新執行一次 `webop install`，host 才會指向新的位置。
2. 開啟 Chrome 的 `chrome://extensions`，啟用「開發人員模式」，點「載入未封裝項目」，選擇 `apps/extension/dist`。
   若你是先載入擴充功能、後執行 `webop install`：開啟擴充功能的 options 頁（或在 `chrome://extensions` 重新載入擴充功能），擴充功能就會立刻重新連線；否則可能要重啟 Chrome 才連得上。
3. 授權不必事先設定：agent 第一次碰到某個網站時，webop 會跳出詢問視窗（見下方「授權」）。

要移除 Native Messaging host：

```bash
node apps/webop/dist/webop.mjs uninstall
```

同樣可加 `--browser-dir <dir>`（需與 `install` 時一致）。指令會刪除 manifest 與 wrapper。

## 授權

授權以網站（eTLD+1）為單位，分三個等級：

- `read`：讀取頁面（`browser_read_page`、`browser_get_page_text`、截圖與 `zoom`、`browser_tabs_list` 顯示分頁網址與標題），以及導航與開分頁（`browser_navigate`、`browser_tabs_create`，含 back／forward）。只授權 `read` 的網站，agent 仍可導航到該網站或在其上開分頁。
- `act`：點擊、輸入、按鍵、捲動、拖曳、懸停（`browser_computer` 的 click／type／key／scroll／drag／hover），以及 `browser_form_input`。`act` 包含 `read`。
- `javascript`：獨立的等級，不包含在 `act` 內，只給 `browser_javascript` 用。需要 options 頁的全域開關開啟，**且**該網站另有 `javascript` 授權才會放行（見下方「JavaScript 工具」）。

共用網域後綴（private suffix，如 `github.io`、`vercel.app`、`blogspot.com`、`amazonaws.com`）是以「每個應用」為單位：授權 `alice.github.io` 不會放行 `evil.github.io`。

### 詢問視窗

agent 需要尚未擁有的等級時，Chrome 會跳出一個彈出視窗，顯示：

- 是哪個 agent（client 名稱）在問、哪個網站、哪個等級；
- 該分頁的截圖，以及預計點擊位置的標記（僅顯示給你看，不會傳給 agent）。

按鈕：

- **拒絕**：該次操作不會執行，回傳 `permission_denied`。
- **本次允許**：只在這個 session 內有效；session 結束或按下「停止」後，下一次操作會再詢問。
- **永久允許**：寫入永久授權，之後的 session 都不再詢問。

60 秒沒有回答視為拒絕；直接關閉視窗也視為拒絕。

> 注意：opencode 的 MCP 伺服器由背景的 `opencode serve --service` 常駐，只重開 TUI 不會結束 webop 的 session，所以「本次允許」不會失效。要讓 session 真正結束，需把 opencode 全部退出並停掉該服務（`pkill -f "opencode serve"`）後重啟。

導航、開分頁、輸入類操作（`browser_navigate`、`browser_tabs_create`、`browser_computer` 的點擊／輸入等）會等你回答，等待期間 MCP 呼叫的逾時會自動延長。

讀取類操作（`browser_read_page`、`browser_get_page_text`、截圖、`zoom`）不會等待：若分頁被導向一個尚未詢問過的網站，會立刻回傳 `permission_required`、不回傳任何頁面內容，並在背景跳出詢問視窗；你允許之後，請 agent 重試。

### options 頁

- **永久授權表**：列出每個網站的等級，每列有 Revoke（撤銷）按鈕。
- **拒絕清單**：一行一個網站，輸入完按「Save」才會生效。清單內的網站一律拒絕、**不會**跳出詢問。
- **Profile name**：這個 Chrome profile 給 agent 看的顯示名稱（見「多個 Chrome profile」）。
- **JavaScript 開關**：`javascript` 等級的全域開關（預設關閉）。

從 M3 升級時，原本的白名單項目會自動轉成永久的 `act` 授權。

## 多個 Chrome profile

同時有好幾個載入 webop 的 Chrome profile 在線時，agent 的呼叫會回 `profile_required` 並列出每個 profile 的顯示名稱與 id——**不會**自己挑一個。

- `browser_profiles_list` 列出在線的 profile（`profile_id`、`profile_label`、`selected`）。
- `browser_profile_select { profile }` 用 profile_id 或完全相同的顯示名稱（不分大小寫）選定一個；之後這個 session 只用它。切換會關掉舊連線（舊 session 結束，分頁留在原處）。
- 也可以從一開始就釘住：`webop mcp --profile <profile_id 或顯示名稱>`（在 `opencode.json` 的 `command` 陣列末尾加上 `"--profile", "<label>"`）。找不到符合的 profile 時呼叫回 `not_connected`；名稱同時符合多個時回 `profile_required`，請改用 profile_id。
- 選定的 profile 關掉之後，呼叫回 `not_connected` 並點名該 profile（用它最新的顯示名稱），**不會**自動改連另一個在線的 profile。
- 「關掉」指該 profile 的**一般視窗全部關閉**，瀏覽器本身不必結束（macOS 上 Chrome 關掉所有視窗後仍會在背景執行）。這時擴充功能會主動斷線，該 profile 的「本次允許」隨之收回，`browser_profiles_list` 也不再列出它；詢問視窗與 devtools 不算一般視窗。再開一個該 profile 的視窗就會自動上線，agent 的下一個呼叫即可使用，不必重啟 opencode。（0.5.1 起）
- profile 的顯示名稱預設是登入的 Google 帳號 email，沒登入時是 `profile-<id 前 6 碼>`；可在 options 頁的 `Profile name` 欄位改名，按 Save 後立即生效（`browser_profiles_list` 不必重啟就看得到）。清空再 Save 會回到預設名稱。
- 中途才打開第二個 profile 也一樣：尚未選定時，下一個呼叫就會回 `profile_required`，已在操作的 session 不會被默默換掉。

## 讀取與填表工具

- `browser_get_page_text { tab_id, max_chars? }`：回傳 `Title: …`、`URL: …`，空一行後是主內容的純文字。主內容依序取 `main`、`[role=main]`、文字最長的 `article`，都沒有就用 `body`；導覽列、頁首頁尾、側欄與隱藏元素會被去掉，表單欄位的值（包括密碼）一律不輸出。預設上限 50000 字元，超過會截斷並以 `…(truncated)` 結尾。只想讀內容時比 `browser_read_page` 精簡得多。
- `browser_form_input { tab_id, ref, value }`：用 `browser_read_page` 拿到的 ref 設定欄位，觸發 `input` 與 `change` 事件，**不會**送出表單。
  - 文字類 input 與 textarea：字串或數字。
  - select：option 的 value，或畫面上顯示的文字（完全相同）；不支援多選。
  - checkbox／radio：`true`／`false`。
  - 唯讀、停用、非表單元素或型別不符：回 `invalid_args`（訊息開頭「Not performed」）。
  - 回傳 `Set <種類> <ref>.` 加上截圖，**不會**回傳所填的值（密碼不會出現在 agent 的對話紀錄裡）。

## 截圖大小與 zoom

- `browser_computer` 的 `zoom`：`region: [x0, y0, x1, y1]`（上一張截圖的座標），回傳該區域的放大圖。之後的座標仍以上一張完整截圖為準。需要先截過圖；`x1 <= x0` 或 `y1 <= y0` 回 `invalid_args`，超出截圖範圍回 `oob`。
- 截圖大小可依模型調整，在 `opencode.json` 的 `command` 陣列末尾加上參數：
  - `--image-max-px <n>`：長邊上限，預設 1568。
  - `--image-max-tokens <n>`：以 `--px-per-token` 換算的影像 token 上限，預設 1568。
  - `--px-per-token <n>`：每個影像 token 對應的邊長像素，預設 28。
  - 都必須是正整數，否則 `webop mcp` 會在啟動時報錯並以 exit code 2 結束。
  - 預設值是依 Claude 的影像處理方式訂的；非 Claude 模型或想省 token 時，可把 `--image-max-px` 降到 1024 或更小。
  - 只影響該 agent 的 session，同一個瀏覽器裡的其他 agent 不受影響。

## JavaScript 工具

`browser_javascript { tab_id, code }` 用 `Runtime.evaluate` 在頁面執行程式碼，回傳 JSON 結果：Promise 會等它完成，執行上限 10 秒，結果上限 50000 字元。程式丟出例外時，結果是 `Error: …` 文字，不算工具錯誤。

- 預設關閉：沒到 options 頁打開「Allow JavaScript tool」之前，一律回 `permission_denied`，不會詢問。
- 打開之後，每個網站第一次使用仍會跳出詢問視窗，等級顯示 `javascript`；該網站已有 `act` 授權也一樣要再問。
- 風險：程式碼以該網站的身分執行，能讀寫頁面、cookie（非 HttpOnly）與 localStorage，也能代你送出請求。只在你信任 agent 與該網站時開啟，用完可以關掉開關，或在永久授權表 Revoke。

## 停止 agent

- **頁面內的「停止」按鈕**（agent 操作該分頁期間顯示在右下角）：中止該 session 正在執行與排隊中的呼叫（回傳 `stopped_by_user`），並收回「本次允許」的授權（下次操作會重新詢問）。session 仍保持連線，agent 可繼續下一個呼叫。
- **點工具列上的 webop 圖示**：停止**所有** session，頁面無法阻擋這個操作。圖示上的徽章數字是目前連線中的 session 數。
- **debugger 資訊列的「取消」**：Chrome 的資訊列是整個擴充功能共用的，按「取消」會中斷 webop 正在偵錯的**所有**分頁，因此每個有已連上分頁的 session 都會被停止（不只是該分頁的 session）。下一個呼叫會回傳一次 `detached_by_user`，之後自動重新連上；但若已有執行中的呼叫回報過這次取消，下一個呼叫就不會再重複回報。

已知限制：頁面腳本可以移除或遮住頁內按鈕（例如頂層 dialog、全螢幕、移除元素）。遇到這種情況請改用工具列圖示或 debugger 資訊列。

## 行為備註

- 附加 debugger 後的第一張截圖會等待 viewport 穩定（debugger 資訊列會改變頁面大小）。
- 座標點擊時，若 viewport 大小自上次截圖後改變，會被拒絕（訊息為「Not performed … viewport changed」，`invalid_args`）；請重新截圖再點。
- 截圖結果的第一個文字區塊為 `Screenshot WxH px`，後面才是圖片。
- `browser_form_input` 與 `browser_javascript` 和點擊一樣：先確認授權，再確認分頁還在原網站、頁面有回應，之後才動頁面；結果回傳前會再確認分頁仍在可讀的網站上。
- 頁面跳出 `alert()`／`confirm()` 或卡住時，呼叫會在幾秒內回傳 `timeout`。訊息含「Not performed」表示動作沒有發生；含「may have been partially or fully performed」或「The action WAS performed」表示輸入已經送出。
- 對話框開著期間，網頁腳本凍結：之後的呼叫會立刻回 `timeout`（「Not performed: a JavaScript dialog is open…」），不會把輸入排隊到對話框關閉後才落地，也不會乾等。此時的截圖改用 `chrome.tabs.captureVisibleTab`，座標框架沿用上一張截圖。
- `key` 支援標點符號（``/ . , ; ' [ ] \ - = ` ``）與 F1–F12。
- `type` 是一次 `Input.insertText` 瞬間送出（非逐字），且輸入當下「停止」按鈕會被暫時隱藏；因此單次 `type` 期間人類來不及按「停止」。要測「打字中停止」，需把長文字分成多段連續送出（停止按鈕在段間會閃現）。
- content script 只會注入到 agent 自己開啟的分頁。

## opencode 設定

直接貼上 `webop install` 印出的設定即可（路徑已填好）。若要手動撰寫，在 `opencode.json`（opencode 1.19 格式）加入，並把 `<node 絕對路徑>` 與 `<repo>` 換成實際的絕對路徑：

```json
{
  "mcp": {
    "webop": {
      "type": "local",
      "command": ["<node 絕對路徑>", "<repo>/apps/webop/dist/webop.mjs", "mcp"],
      "enabled": true
    }
  }
}
```

可在 `command` 陣列末尾加上 `"--profile", "<名稱或 id>"` 釘住 profile，或加上截圖大小參數（見「截圖大小與 zoom」），例如：

```json
"command": ["<node 絕對路徑>", "<repo>/apps/webop/dist/webop.mjs", "mcp", "--profile", "Work", "--image-max-px", "1024"]
```

## 系統提示範本

與 grok 共用，見 [README.md](README.md#系統提示範本)。

## 錯誤碼

| 錯誤碼 | 意義 |
|---|---|
| `not_connected` | 找不到執行中的 Chrome／擴充功能連線：Chrome 未開、擴充未載入、host 尚未註冊（見安裝順序），或與 host 的連線中斷／socket 無法使用（重新連線後再試）。已用 `browser_profile_select` 選定 profile 時，該 profile 離線也會得到此錯誤（訊息會點名它，不會改連別人的） |
| `profile_required` | 同時有多個 profile 在線而尚未選定：呼叫 `browser_profiles_list` 看清楚，再用 `browser_profile_select` 指定；選定後不再詢問 |
| `permission_denied` | 被拒絕：網站在拒絕清單、使用者在詢問視窗按了拒絕（或 60 秒未回答、關閉視窗），或 JavaScript 工具未在 options 頁開啟 |
| `permission_required` | 讀取類操作遇到尚未詢問過的網站（例如分頁被導向別處）：已在背景詢問使用者，不回傳內容；允許後重試 |
| `security_check_failed` | 送出輸入前的網站複查失敗（分頁在操作途中被導向另一個網站），輸入未送出 |
| `stopped_by_user` | 使用者按了停止（頁內按鈕或工具列圖示）；session 仍連線，「本次允許」已收回。若訊息含「may have been partially or fully performed」，表示輸入已部分送出；navigate／tabs_create 的「The navigation was started and may still complete…」「The tab was opened and …」同樣表示動作已發生。訊息開頭為「Not performed」才表示確定沒做 |
| `stale_ref` | ref 已失效（頁面重新載入或 DOM 改變），請重新 `browser_read_page` |
| `oob` | 座標（或 `zoom` 的區域）超出截圖範圍 |
| `invalid_args` | 參數不合法，包括 viewport 大小自上次截圖後改變（需重新截圖）、`zoom` 區域寬高為 0 或顛倒、`browser_form_input` 遇到唯讀／非表單元素或值的型別不符 |
| `timeout` | 操作逾時（對話框或卡住的腳本通常約 20 秒）。只有訊息含「Not performed」時才保證動作沒有執行；訊息含「may have been partially or fully performed」表示輸入已送出 |
| `detached_by_user` | 使用者按了 debugger 資訊列的「取消」。該分頁的下一個呼叫會回傳一次此錯誤（若已有執行中的呼叫回報過則不再重複），之後自動重新連上 |

## 已知限制

- 操作期間 Chrome 會顯示 debugger 資訊列（「webop 正在偵錯此瀏覽器」），無法隱藏；使用者按下其「取消」等同停止，會中斷所有被偵錯的分頁並停止各自的 session，且使下一個呼叫回傳 `detached_by_user`（已有執行中的呼叫回報過則不重複）。
- 跨來源 iframe 的內容在截圖中看得到，但 `browser_read_page` 讀不到其無障礙樹內容；對跨網站 iframe 內的點擊／輸入會被拒絕（`permission_denied`）。
- `browser_get_page_text` 的主內容判斷是簡單規則，不是 Readability；版面特殊的網站可能多抓或少抓，必要時改用 `browser_read_page`。
- `browser_form_input` 只處理原生表單元素；contenteditable 編輯器、自製下拉選單等請用 `browser_computer` 點擊與輸入。

## 驗收紀錄

由使用者在日常 Chrome 手動驗收後填寫。

### M5（讀取工具與多 profile）

- 日期：2026-11-01
- Chrome 版本：Brave 156.1.98.62（Chromium 156）
- opencode 版本：v2.2.5

先重新 build（`pnpm -r build`），確認 `node apps/webop/dist/webop.mjs --version` 印出目前版本（例如 `webop 0.5.1`）；在 `chrome://extensions` 重新載入擴充功能，確認卡片（或 options 頁的 Version）也是同一個版本（manifest 新增了 `identity` 權限，Chrome 可能要你確認），再完整重啟 opencode（含 `pkill -f "opencode serve"`）。

| # | 步驟 | 預期 | 結果（通過／失敗＋備註） |
|---|---|---|---|
| 1 | 在一個你已登入的網站（例如 GitHub 通知頁）請 agent 用 `browser_get_page_text` 讀內容 | 回傳 `Title:`／`URL:` 加主內容純文字，不含導覽列與頁尾 | 通過。受測環境沒有已登入的網站，改用公開頁面 `en.wikipedia.org/wiki/Web_browser`：回 `Title: Web browser - Wikipedia`／`URL: …`，主內容 19648 字元；`Main page`、`Random article`、`Donate`、`Contents`、`Privacy policy`、`About Wikipedia`、`Disclaimers`、`Create account`、`Log in` 等導覽列／側欄／頁尾字串都不在輸出裡。 |
| 2 | 請 agent 用 `browser_form_input` 在搜尋框填一段文字（不要送出） | 欄位出現文字、沒有送出；回傳 `Set … ref_N.` 加截圖，回傳文字不含所填內容 | 通過。Wikipedia 側欄搜尋框（`searchbox "Search Wikipedia" [ref_2]`）：回 `Set search input ref_2.` 加截圖，欄位顯示 `webop acceptance test`、網址仍是 `…/Web_browser`（未送出），回傳文字不含填入內容。 |
| 3 | 請 agent 先截圖，再用 `zoom` 放大頁面某一區並描述 | 回傳 `Zoom of [...] at WxH px` 與放大圖；之後用原截圖座標點擊仍點得準 | 通過。截圖 `Screenshot 1568x606 px`；`zoom` 區域 `[380,40,1000,240]` 回 `Zoom of [380,40,1000,240] at 1360x438 px`（約 2.2 倍），可清楚辨識標題、Article／Talk 分頁與目錄。之後用**原截圖座標** `(455,119)` 點左側目錄的「History」精準命中，頁面捲到 History 段、該目錄項變為選取。 |
| 4 | 開第二個載入 webop 的 Chrome profile，再請 agent 做任一操作 | 回 `profile_required`，列出兩個 profile；請 agent `browser_profile_select` 第二個後，新分頁只出現在第二個 profile | 通過。第二個 profile 上線後，`browser_tabs_create` 回 `profile_required: Multiple browser profiles are online: profile-600b0f (600b0f4f-…), profile-841e4d (841e4df4-…)`。`browser_profile_select { profile: "profile-841e4d" }` 後開 `https://example.org`，新分頁只出現在第二個 profile 的視窗，第一個 profile 沒有多出分頁。 |
| 5 | 承上，把選定的那個 profile 視窗全部關掉，再請 agent 操作 | 回 `not_connected` 並點名該 profile，不會改去操作另一個 | 通過（0.5.1 重測；0.5.0 時失敗，回 `internal: No current window`，詳見下方重測紀錄）。只關掉 `clean` 的所有視窗、Brave 與 `normal` 仍開著時，回 `not_connected: Profile "clean" is not online. Online: normal (600b0f4f-…)`；`browser_profiles_list` 只剩 `normal`；host 與 descriptor 都清除且未 respawn；沒有改去操作另一個 profile。重開 `clean` 視窗後下一個呼叫自動重連並正常運作。 |
| 6 | 請 agent 用 `browser_javascript` 讀 `document.title` | 預設回 `permission_denied`（JavaScript 未開啟），不跳詢問；在 options 打開開關後再試，跳出等級 `javascript` 的詢問，允許後回傳標題字串 | 通過。options 的全域開關關閉時回 `permission_denied: JavaScript execution is disabled in webop options (site "wikipedia.org").`，不跳詢問。打開開關後在 `iana.org`、`httpbin.org` 各跳一次等級 `javascript` 的詢問，允許後分別回傳 `"Example Domains"` 與 `""`。 |
| 7 | 在 options 頁的 `Profile name` 改名並 Save | `browser_profiles_list` 立即顯示新名稱 | 通過。把兩個 profile 分別改名為 `normal`、`clean` 並 Save 後，不必重啟，`browser_profiles_list` 立即回 `normal`／`clean`（原本是 `profile-600b0f`／`profile-841e4d`）。 |

**0.5.1 重測第 5 項**（重新 build、重新載入擴充功能、確認版本為 `0.5.1` 後，只關掉選定 profile 的所有視窗，不結束瀏覽器）：結果：**通過**。

- 關閉 `clean` 的所有視窗、Brave 與 `normal` 仍開著時：`browser_tabs_list` 與 `browser_tabs_create` 都回 `not_connected: Profile "clean" is not online. Online: normal (600b0f4f-…)`，且用的是最新的顯示名稱 `clean`（0.5.0 會顯示舊 label `profile-841e4d`）。
- `browser_profiles_list` 只剩 `normal`；`clean` 的 host 程序已退出、descriptor 與 socket 已刪除，數分鐘內沒有自動 respawn；全程沒有改去操作 `normal`。
- 重開 `clean` 的一個視窗後，不需重啟 opencode，下一個呼叫就自動重連（`selected: true`），`browser_tabs_create` 與 `browser_get_page_text` 均正常。

總結（0.5.1）：**7 項全數通過**。第 5 項的失敗已在 0.5.1 修正（`5ffd629`），行為改為「關掉 profile 的最後一個 normal 視窗即離線、重開視窗自動重連」；文件與 options 的顯示名稱也改為即時。

總結（0.5.0）：7 項中 6 項通過。第 5 項的「把 profile 視窗全部關掉」在 macOS 上不會讓該 profile 離線——service worker 只要還持有 native messaging 連線就不會被回收，host 也就不會退出（kill 掉 host 後 4 秒內自動重連）；要等到整個瀏覽器結束（或停用該 profile 的擴充功能）才會回 `not_connected`。其餘觀察：`webop mcp` 回報版本與 manifest 皆為 `0.5.0`；受測環境沒有已登入網站，第 1 項以公開頁面驗證；兩個 profile 的改名即時反映在 `browser_profiles_list`，但已綁定 session 的 `not_connected` 訊息仍顯示選定當時的舊 label（`profile-841e4d`）。

### 已修正（0.5.1）：關掉 profile 視窗後仍被視為在線（M5 #5）

**狀態**：已在 0.5.1 修正（依下方「修正方向」1–5 實作，含 `scheduleReconnect` 抑制與 `No current window` → `not_connected` 的防禦映射；附帶的舊 label 問題也一併修正）。**2026-11-01 已以 0.5.1 重跑 M5 第 5 項確認通過**（見上方重測紀錄）。以下保留原始紀錄。

**原狀態**：未修正（2026-11-01 驗收時發現）。優先度 P1——這是 M5「多 profile」主流程最常見的收尾動作，目前會讓工具回一個沒有文件、agent 無法處理的錯誤。

**一句話**：某個 profile 的所有視窗都關了，但瀏覽器（還有其他 profile）仍在跑時，webop 仍把該 profile 當成在線。對它呼叫工具會回 `internal: No current window`，而不是文件承諾的 `not_connected`。

#### 重現步驟

1. 兩個載入 webop 的 profile（例如 `normal`、`clean`）同時在線。
2. `browser_profile_select { profile: "clean" }` 選定 `clean`，確認工具可用（例如開一個分頁）。
3. 把 `clean` 這個 profile 的**所有視窗**關掉（分頁、options 頁、`chrome://extensions` 都不要留；另一個 profile 的視窗保持開著）。
4. 呼叫任一工具，例如 `browser_tabs_create { url: "https://example.org" }`。

#### 實際結果 vs 預期

| 觀察點 | 實際 | 預期 |
|---|---|---|
| `browser_profiles_list` | 仍列出 `clean`（`selected: true`） | 不再列出 `clean` |
| `browser_tabs_create` | `internal: No current window` | `not_connected: Profile "clean" is not online. Online: normal (…)` |
| 是否改去操作另一個 profile | 沒有（正確） | 沒有（正確） |
| 重開該 profile 視窗 | 工具恢復可用（host 沒死，不需重連） | 恢復可用 |

只有把整個瀏覽器結束（所有 profile）後，才會得到 `not_connected: Profile "profile-841e4d" is not online. Online: none.`。

#### 根因（附檔案位置）

1. `apps/extension/src/sw/native.ts:78` 的 `connect()` 呼叫 `chrome.runtime.connectNative()` 建立連線後，**從不主動斷線**。
2. MV3 的 service worker 只要還持有 native messaging port 就不會被回收。實測把該 profile 的 host 程序 kill 掉後，**4 秒內**就重連並產生新的 host——證明 SW 一直活著，只是沒有視窗。
3. `apps/webop/src/mcp.ts:46-58` 的 `liveProfiles()` 只用 descriptor 裡的 `pid` 判斷在線（descriptor 由 `apps/webop/src/host.ts:147-152` 在 `hello` 時寫入）。host 沒死 → 該 profile 永遠算在線。
4. host 只會在 stdin 關閉（也就是 port 斷線）時才退出，並清掉 descriptor 與 socket（`apps/webop/src/host.ts:217-247`）。所以「關視窗」這條路徑根本不會走到離線判定。
5. 最後那個難懂的錯誤：`apps/extension/src/sw/sessions.ts:253` 的 `chrome.tabs.create({ active: false })` 沒有指定 `windowId`，該 profile 沒有 normal window 時 Chrome 會丟 `No current window`；它不是 `CdpError`，於是被 `apps/extension/src/sw/tools.ts:796` 統一包成 `internal`，原始訊息原封不動外露。

#### 影響

- 使用者關掉用完的 profile 後，未選定的 session 照樣被要求 `profile_required`，選到那個幽靈 profile 就整個卡死。
- `internal` 不在「錯誤碼」表中，系統提示範本也沒教 agent 怎麼辦，agent 只能原樣回報，使用者無法自行修復。
- 「本次允許」這類 session 授權不會隨關視窗失效（session 綁在 host 連線上），與使用者「關掉 profile 就結束」的預期有落差。沒有視窗時沒有可操作的頁面，因此不涉及跨站資料外洩。

#### 修正方向：extension 端在最後一個視窗關閉時主動斷線

採「關掉 profile = 離線」的語意，靠現有的 host 退出路徑（stdin 關閉 → 刪 descriptor/socket）達成，不需要改 native messaging 協定：

1. 在 `native.ts` 維護「目前有沒有 normal window」的狀態，並註冊 `chrome.windows.onRemoved`。
2. 視窗關閉後用 `chrome.windows.getAll()` 檢查；**只計 `type === "normal"`**（`prompt.ts` 的詢問視窗是 `popup`，devtools 也不算），清單為空代表該 profile 已關閉 → 主動 `port.disconnect()`。
3. **必須**抑制 `onDisconnect` 裡的 `scheduleReconnect()`（`native.ts:83-91`），並設一個「等視窗再連」的旗標。否則 1 秒後就重開 host（現行行為已實測會這樣），修正等於無效。
4. `chrome.windows.onCreated` 與 SW 啟動（`index.ts:27` 的 `startNativeLink`）時，先檢查有沒有 normal window 才 `connect()`；`connect()` 開頭也要擋，避免 SW 被其他事件喚醒又在無視窗時建立 host。
5. 防禦性補強（可選）：把 Chrome 的 `No current window` 在 `tools.ts:796` 之前映射成 `not_connected`，訊息寫「該 profile 目前沒有視窗，請開啟一個視窗」，這樣即使狀態判斷有漏，agent 也能給出可行動的指示。

#### 不要做的事

- 不要在綁定的 profile 離線時自動改連另一個 profile（維持 M5 既有語意）。
- 不要把「沒有視窗」當成「瀏覽器已關閉」而動到永久授權；授權存在 `chrome.storage.local`，與視窗狀態無關。
- 分頁與 session tab 會隨視窗消失，`closeHostSessions()` 已在斷線時處理，不需另外加邏輯。

#### 驗收方式

- 新增 e2e／單元測試（建議名 `t_last_window_closed_goes_offline`）：關閉該 profile 最後一個 normal window → host 退出、descriptor 消失、`browser_profiles_list` 不再列出它、呼叫回 `not_connected: Profile "<label>" is not online. Online: <其他 profile>`。
- 回歸測試：
  - 只有詢問視窗（popup）存在時，不可誤判為離線。
  - 重開該 profile 的視窗後，下一個呼叫要能自動重連，不需重啟 opencode。
  - `t_bound_profile_gone`、`t_second_profile_mid_session` 仍須通過。
- 手動：重跑 M5 第 5 項，預期**不必關掉整個 Brave** 就能得到 `not_connected`。

#### 附帶（低優先）

選定 profile 之後才改的顯示名稱，不會更新到已綁定 session 的錯誤訊息：`not_connected` 仍顯示選定當時的舊 label（實測 `profile-841e4d`，而 options 已改成 `clean`）。`browser_profiles_list` 則是即時的。可在 `mcp.ts` 的 binding 每次呼叫時用最新 label 重建訊息。

### M4（授權與停止）

- 日期：2026-11-01
- Chrome 版本：Brave 156.1.98.62（Chromium 156）
- opencode 版本：v2.2.5

| # | 步驟 | 預期 | 結果（通過／失敗＋備註） |
|---|---|---|---|
| 1 | 在 opencode 下達操作一個全新網站的指令 | 跳出詢問視窗，顯示 agent、網站、等級與截圖（含點擊標記） | 通過。`browser_tabs_create` 開 localhost 時跳出 read 詢問（opencode／localhost／read）。 |
| 2 | 按「拒絕」 | 頁面上什麼都沒發生，agent 收到 `permission_denied` | 通過。回 `permission_denied: Not performed: the user declined (or did not answer) read access to site "localhost"; no tab was opened.`，分頁未開。 |
| 3 | 重新操作並按「本次允許」 | 操作成功；開新 session 後再次操作會重新詢問 | 通過。read 與 act 各跳一次，按「本次允許」後點擊成功、標題變 `count 1`；完整重開 opencode（含停掉 `opencode serve --service`，只重開 TUI 不夠）後再操作會重新詢問。 |
| 4 | 按「永久允許」 | options 頁的永久授權表出現該網站，按 Revoke 後再操作會重新詢問 | 通過。永久允許後 options 出現 `localhost`（act）；Revoke 後再操作重新跳 act 詢問。 |
| 5 | 把某網站加入拒絕清單後操作它 | 直接回傳 `permission_denied`，完全不跳詢問 | 通過。回 `permission_denied: Not performed: site "example.com" is on the deny list in webop options.`，不跳詢問。 |
| 6 | 點擊途中把分頁導向另一個網站 | 回傳 `security_check_failed`（或讀取類回傳 `permission_required`），未在新網站送出輸入 | 通過。點 github 頁尾「Status」連結，回 `permission_required: The action WAS performed, but the tab is now on githubstatus.com, which needs the user's approval; no content is returned.`，不回傳內容、背景跳 githubstatus 詢問；允許後 retry `read_page` 成功。 |
| 7 | agent 執行長動作時按頁內「停止」按鈕 | 動作中斷，回傳 `stopped_by_user`；下一個操作重新詢問「本次允許」的網站 | 通過。回 `stopped_by_user: The action may have been partially or fully performed: the user pressed stop.`。備註：`type` 是單次 `Input.insertText` 瞬間送出、且輸入當下停止按鈕被暫時隱藏（`withStopButtonHidden`），單次 type 人類來不及按；需分段連續送出（按鈕在段間閃現）才按得到。 |
| 8 | 按工具列圖示 | 所有 session 進行中的呼叫都被停止（回 `stopped_by_user`）；session 仍保持連線，徽章數字不變 | 通過。回 `stopped_by_user: The action may have been partially or fully performed: the user pressed stop.`；session 仍活（`tabs_list` 正常、分頁仍在）。 |
| 9 | 按 debugger 資訊列的「取消」 | 所有被偵錯分頁的 session 都被停止；下一個呼叫回傳一次 `detached_by_user`（已有執行中的呼叫回報過則不重複），再下一個呼叫自動重新連上 | 通過。第一次重試回 `detached_by_user: Not performed: the user stopped debugging this tab; retry to re-attach.`，第二次重試成功。 |
| 10 | 在頁面觸發真正的 `alert()`，再讓 agent 點擊 | 點擊在約 20 秒內回傳 `timeout`；之後再點一次會回「Not performed」，關閉 alert 後也不會補上那次點擊 | 通過。Alert 那下約 20 秒回 `timeout: The action may have been partially or fully performed: Input.dispatchMouseEvent did not complete within 20s; the page may be blocked...`；「+1」回 `timeout: Not performed: the page is not responding...`；手動關閉 alert 後標題仍 `alert test`（未變 `count 1`）。 |

總結：10 項全數通過。加測（行為備註）：連續兩張截圖尺寸一致（1568x580），首張截圖已穩定、座標框架正確；ref 點擊準確命中「+1」（`count 1`）。像素座標點擊因本 agent 不具備圖片視覺而未能獨立手動驗證，由 e2e `t_first_screenshot_after_attach_is_settled`／`t_viewport_changed_refuses_click` 覆蓋。附帶發現：單次 `type` 為一次 `Input.insertText` 瞬間送出且輸入中停止按鈕被隱藏，導致「打字中按停止」需分段送出才可重現（見 #7 備註）。
