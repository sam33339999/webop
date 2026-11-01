# M3 手動驗收紀錄（2026-10-31）

- 驗收人：agent（opencode / DeepSeek V4.1 Flash）+ 使用者手動配合
- 環境：macOS、Chrome、extension 以 unpacked 載入、白名單含 `github.com`、`localhost`、`docs.github.com`
- 對照規格：`docs/superpowers/plans/2026-10-31-webop-m1-m3.md` 第 6 節驗收清單、`docs/superpowers/specs/2026-10-31-webop-design.md`

## 總表

| # | 項目 | 結果 | 備註 |
|---|---|---|---|
| 1 | 連線與讀頁 | ✅ PASS | 讀到帳號 `sam33339999`（已登入狀態），分頁在背景建立 |
| 2 | 截圖 | ✅ PASS | 左上角為 octocat 標誌、`Dashboard` 麵包屑、漢堡選單；游標 overlay 可見 |
| 3 | ref 點擊 | ✅ PASS | `ref_15`「All repositories」→ `/repos`，頁面正確 |
| 4 | 座標點擊與輸入 | ✅ PASS | 搜尋框輸入 `webop` + Enter → 1.4k 結果 |
| 5 | 捲動三次 | ⚠️ PARTIAL | 第 1、2 次內容有變；第 3 次已到頁底（頁面僅 10 筆結果，頁高不足） |
| 6 | 白名單外網站 | ✅ PASS | `permission_denied`，未建立分頁、原分頁未導航 |
| 7 | 導航被導向白名單外 | ✅ PASS | 見下方實測訊息 |
| 8 | 關閉分頁 | ✅ PASS | 清單變空 |
| 9 | 使用者手動中止 | ❌ FAIL → 🛠 已修（待複驗） | 兩輪都未回 `detached_by_user`；見下方，已補測試（e2e `debugger detach by user…`、`pending send fails with detached_by_user…`） |
| 10 | 真的 alert（N1） | ❌ FAIL → 🛠 已修（待複驗） | 見下方：對話框偵測、input 專屬逾時、`captureVisibleTab` |
| 11 | alert 開著時關分頁 | ✅ PASS | 約 5.7 s 關閉 |
| 12 | 多個 Chrome profile | ❌ FAIL → 🛠 已修（待複驗） | 已加 `browser_profiles_list`／`browser_profile_select`，每次呼叫重查在線數量；見下方 |

## 失敗與異常詳述

### 測 5 — 捲動第三次沒有變化

搜尋結果頁只有 10 筆，頁面高度接近視窗高度，前兩次捲動後即到底；第三次 `scroll down` 無位移。屬測試素材問題，非工具缺陷，但若驗收腳本要固定「三次都有變化」，需要更長的頁面。

### 測 7 — 意外的白名單命中

第一次用 footer 的「Docs」（`https://docs.github.com/`）點擊時**沒有**觸發 `permission_denied`，分頁正常載入 `https://docs.github.com/zh` 並回傳內容——原因是 `docs.github.com` 已在該 profile 的白名單內。改用 `https://www.githubstatus.com/` 後行為正確：

```
permission_denied: The action WAS performed, but the tab is now on a site that is not allowed (githubstatus.com); no content is returned. Access to site "githubstatus.com" is not allowed; add it in webop options to let the agent use it.
```

分頁清單同時回報 `{"url": "(site not allowed)"}`，符合「已執行、不回外部內容」。

### 測 9 — 未回 `detached_by_user`

流程：開 `https://github.com` → 截圖 → 使用者在 Chrome 偵錯資訊列按「取消」→ 再截圖。

兩輪結果相同：第二次截圖**成功**（回圖片、游標 overlay 出現），沒有 `deferred`/錯誤。等於重新 attach 對使用者是透明的，`detached_by_user` 幾乎沒有被回報的窗口。

相關程式碼：`apps/extension/src/sw/cdp.ts:55`、`:164` 只在 `onDetach` 產生懸置 `send` 時才拋 `detached_by_user`；若取消發生在兩個呼叫之間，下一發直接 attach 成功，使用者看不到任何訊號。

- 期望（規格 Task 3）：取消後第一次呼叫應回 `detached_by_user`，之後重試可重新接上。
- 需要決定：是否要在 `attach` 前檢查「上一輪曾被使用者 detach」並先回一次 `detached_by_user`，或調整規格成「重接透明、只有進行中的呼叫失敗」。

### 測 10 — N1 未修好（重點）

流程：開 `http://localhost:8765/alert.html` → 點「Alert」→ 立刻點「+1」。

實測：

| 步驟 | 結果 | 耗時 |
|---|---|---|
| 點 Alert | `timeout: Tool call timed out after 60000 ms` | 60 047 ms |
| 點 +1 | `timeout: Tool call timed out after 60000 ms` | 60 043 ms |

- 兩步都是 **60 s**，不是預期的 ~20 s。
- `+1` 的錯誤訊息只有 `timeout`，**沒有「Not performed」**，agent 無法判斷動作到底有沒有排進 Chrome。
- 使用者手動按掉 alert 後，分頁標題變成 **`count 1`** → `+1` 的點擊在 alert 關閉後才落地，證明是「卡住後延遲送達」而不是「乾淨失敗」。

影響：任何 modal / `alert()` / `beforeunload` 都會讓一次工具呼叫吃滿 60 s，且 agent 之後如果重試同一個按鈕，會造成重複點擊。

### 測 11 — 通過，但與測 10 對照很有意思

同樣是 `alert.html`，`click(Alert)` 與 `tabs_close` 併發送出：點擊 5 706 ms 就回成功、關閉 5 725 ms 完成。可見「關分頁」本身不會被 modal 卡住，慢的是等 `Input.dispatchMouseEvent` 的回應。

### 測 12 — 未回 `profile_required`

- 第二個同樣載入本擴充的 profile 上線後，`browser_tabs_list` 回 `[]`（而且回的是第一個 profile 的空清單），不是 `profile_required`。
- 兩份 descriptor 的 `pid` 都還活著（96407、99719），`~/.webop/run/` 下有兩組 `.json`/`.sock`，所以 `liveProfiles()` 若被呼叫會回 2。

根因在 `apps/webop/src/mcp.ts`：

```ts
// :147
async function getConn(): Promise<Conn | Outcome> {
  if (conn) return conn;          // ← 直接回快取，不再檢查 liveProfiles()
  connecting ??= establish().finally(() => { connecting = null; });
  return connecting;
}
```

`establish()`（:75-85）才會做 0 個 → `not_connected`、>1 個 → `profile_required` 的判斷。也就是說 `profile_required` 只在**冷啟動時**出現；連線中途多開 profile 完全偵測不到。

- 影響：使用者照直覺「再開一個 profile」不會被擋，agent 會繼續默默操作舊的那個，容易以為自己在操作新視窗。
- 附註：第二個 profile 目前只是關了視窗，host process 還在，所以「關掉其一後恢復」這段沒驗到；以現行實作，恢復與否也看不出差別（本來就沒報錯）。

## 建議修法（已在 2026-11-01 實作，見下一節）

1. **N1**：`Input.dispatch*` 加上獨立的短逾時（例如 20 s）並帶 `Not performed` 語意；逾時後不要重送，改回報「動作未確認」。另外可在 dispatch 前偵測 `Page.javascriptDialogOpening`，有 modal 就直接快速失敗。
2. **`profile_required`**：`getConn()` 在 `conn` 已存在時仍比對 `liveProfiles()` 數量，>1 就回 `profile_required`（可加短路快取，避免每發都 `readdir`）。
3. **`detached_by_user`**：在 `attach` 前檢查上一輪是否為使用者 `canceled_by_user`，若是則先回 `detached_by_user` 一次再重接；或把規格改成透明重接並同步更新驗收表。

## 2026-11-01 修正與驗證方式

實測後發現 60 s 不是單一原因，而是**截圖路徑上連續三個 `Runtime.evaluate`（隱藏覆蓋層、探測、還原）各等滿 20 s**；`Input.dispatch*` 本身反而很快回來，但它的回應要等對話框關閉才送出，而 `Page.javascriptDialogOpening` 事件也排在該回應之後，所以「靠事件即時判斷」在對話框剛開的那一瞬間幫不上忙。因此改法分三層：

1. **快速失敗**：`assertResponsive` 的探測在看到對話框後立刻回 `Not performed`；`send()` 對 `Runtime.evaluate` 等需要頁面腳本的指令，在對話框開著時直接拒絕（`Not performed: a JavaScript dialog is open…`），不再排隊。
2. **縮短輸入等待**：`Input.*` 改用自己的 `inputSendMs`（3 000 ms，其餘仍 20 000 ms）。觸發對話框的那一下在 3 秒內回「may have been partially or fully performed」，下一次呼叫則因第 1 點在數百毫秒內被拒。
3. **對話框期間的截圖**：`Page.captureScreenshot` 在對話框開著時同樣會卡（實測 plain／fromSurface／clip 三種參數都一樣），改用 `chrome.tabs.captureVisibleTab`，沿用上一張截圖的座標框架，並在結果文字註明對話框開著。

- 對應測試：`tests/e2e/blocked.spec.ts` `t_real_alert`（生產級 20 s 逾時下，點擊 < 6 s 回報已執行、下一次點擊 < 3 s 回「Not performed」、關閉對話框後標題仍為 `count 0`）。
- `profile_required`：`apps/webop/src/mcp.ts` 的 `getConn()` 每次呼叫都重查在線 profile（空清單不快取，非空 500 ms），多於一個就回 `profile_required` 並列出 `label (id)`；新增 `browser_profiles_list`、`browser_profile_select`；選定的 profile 消失時回 `not_connected` 並點名它。測試：`t_second_profile_mid_session`、`t_bound_profile_gone`、`t_profiles_list`、`t_select_then_call`。
- `detached_by_user`：M4 已實作 `takeDetachNotice()`（`attach` 前先回一次），端到端測試 `debugger detach by user -> detached_by_user, then reattach` 與 `pending send fails with detached_by_user when the user cancels the debugger` 皆綠；只需在真實 Chrome 上複驗。
- 複驗方式：重跑本表第 9、10、12 項即可（第 10 項預期點擊約 3 秒回「may have been partially or fully performed」、下一次點擊「Not performed」、關閉 alert 後不補點）。

## 其他觀察

- `browser_computer` 的 `key` 只吃 Playwright 風格鍵名：`"Enter"`、`"Meta+A"` 可用，`"/"`、`"slash"`、`"Slash"` 都會回 `invalid_args: Unsupported key`。
- GitHub 全域搜尋是 `<button>` 開對話框，點該按鈕的座標往往第一下沒反應，需要先 `read_page` 取 ref 再點；這會讓「座標點擊」類驗收變得不穩定。
- 分頁群組名稱 `webop · opencode` 無法從工具輸出讀到，本次未驗證。
