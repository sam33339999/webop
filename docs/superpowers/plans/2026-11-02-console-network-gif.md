# Console／網路讀取與 GIF 錄影 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `browser_read_network_requests`、`browser_read_console_messages`、`browser_gif_creator` 三個 MCP 工具，版本升 0.7.0。

**Architecture:** 純邏輯（URL 遮蔽、記錄緩衝與查詢、GIF 格子規劃與說明文字）放 `packages/core`，用 `node --test` 單元測試。擴充的 service worker 透過 CDP 事件填緩衝（`Network` 在分頁進 session 時就開、`Runtime` 等第一次讀 console 才開），GIF 在 SW 內用 OffscreenCanvas 畫標記＋`gifenc` 編碼，位元組隨 `tool_result.file` 送到 native host，由 host 寫檔並把路徑補進回應。

**Tech Stack:** Node 26 + TypeScript（type stripping，`.ts` 直接 import）、MV3、`chrome.debugger`（CDP 1.3）、esbuild、Playwright（e2e，Chromium）、`gifenc@1.0.3`（新依賴，純 JS、MIT）。

**Spec:** `docs/superpowers/specs/2026-11-02-console-network-gif-design.md`（主規格：`docs/superpowers/specs/2026-10-31-webop-design.md`）

## Global Constraints

- 版本 **0.7.0**，同步 4 處：`apps/extension/manifest.json`、`apps/extension/package.json`、`apps/webop/package.json`、`packages/core/package.json`；`CHANGELOG.md` 加一節（繁體中文，格式比照 0.6.x）。
- 不複製 `fcoeoabgfenejglbffodgkkbkcdhcgfn/` 的程式碼。
- 網路紀錄只含：遮蔽後 URL、method、resource_type、status／failed 原因／pending、時間戳。**不記** headers、POST data、response body、timing。
- console 單則文字上限 16384 字元，截斷後綴 `…[truncated]`。
- 每分頁每類（console、網路）緩衝上限 1000 筆，滿了丟最舊並計數。
- 讀取工具 `limit` 預設 100，取最新 N 筆、依時間由舊到新排列。
- GIF：上限 50 格；每格 1500 ms、最後一格 3000 ms；寬度上限 1280 px；無限循環；說明列繁體中文；不顯示輸入內容；不加浮水印／進度條。
- GIF 預設存 `~/Downloads/webop/`，預設檔名 `webop-<client_name>-<YYYYMMDD-HHMMSS>.gif`，同名加 `-1`、`-2`…；由 native host 寫檔。
- `Runtime.enable` 只在該分頁第一次 `browser_read_console_messages` 時送出；其他路徑（`Runtime.evaluate` 等）不得順帶開它。
- 被 detach（停止鈕、偵錯條取消、SW 重啟）後不主動重掛；`browser_read_network_requests` 永不觸發 attach。
- 擴充程式碼註解、測試名稱、commit message 跟隨既有慣例（英文註解、`feat:`／`fix:`／`docs:` 前綴、結尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`）。
- 全部工作在分支 `feature/console-network-gif`。

## Review Focus

1. **SPA 換網域但不重載**（`history.pushState` 到同站其他路徑）：同 eTLD+1 不清緩衝；只有頂層 frame 的 Document 請求跨 eTLD+1 才清。→ Task 4 測「同站換頁保留」。
2. **SSO 式跨站重新導向**（A → B → A）：緩衝在每次跨站時清空，最後只剩回到 A 之後的紀錄；讀取以分頁**目前**網址驗權，B 的紀錄永遠讀不到。→ Task 4 測 redirect fixture。
3. **agent 在錄影中做 `zoom` 或對話框開著時截圖**（回傳文字區塊而非圖片）：不入格、不中斷錄影。→ Task 7 測 zoom 不增加格數。
4. **錄影後 session 關閉再匯出**：格子已丟棄，回 `no_frames`，而不是 internal。→ Task 7 測。
5. **使用者在 console 讀取開啟後按停止**：讀 console 不重掛，回應帶「暫停中」說明；之後一個 `computer screenshot` 重掛時 `Runtime.enable` 自動重開。→ Task 5 測。

---

## File Structure

| 檔案 | 責任 |
|---|---|
| `packages/core/src/redact.ts`（新） | URL 與文字中 URL 的憑證遮蔽 |
| `packages/core/src/logs.ts`（新） | console／網路條目型別、環狀緩衝、篩選、文字格式化 |
| `packages/core/src/gif.ts`（新） | 錄影步驟型別、格子規劃（標記畫在前一格）、說明文字 |
| `packages/core/src/protocol.ts` | 新 ToolName、ErrorCode、`ToolResult.file` |
| `packages/core/src/grants.ts` | 新工具的權限等級 |
| `packages/core/src/coords.ts` | `fromViewport`（ref 點擊點換回截圖座標） |
| `apps/extension/src/sw/cdp.ts` | attach 後掛鉤 `onAttached`、允許 `about:blank` attach |
| `apps/extension/src/sw/logs.ts`（新） | CDP 事件 → 緩衝；換站清空；空窗紀錄；console 啟用狀態 |
| `apps/extension/src/sw/gif.ts`（新） | 每 session 錄影狀態、收格、合成、編碼 |
| `apps/extension/src/sw/sessions.ts` | `createTab` 先開 `about:blank` 並 attach；session 結束時通知 logs／gif |
| `apps/extension/src/sw/tools.ts` | 三個工具 handler；錄影掛點；`tabs_create` 改為 attach 後才導航 |
| `apps/webop/src/tool-schemas.ts` | 三個 MCP 工具定義 |
| `apps/webop/src/gif-file.ts`（新） | 檔名清理、不重名路徑、寫檔 |
| `apps/webop/src/host.ts` | `tool_result.file` → 寫檔、補文字、移除 `file` |
| `tests/e2e/fixtures/logs.html`、`logs-redirect.html`（新） | e2e 測試頁 |
| `tests/e2e/fixtures/server.ts` | `/status/<code>` 路由 |
| `tests/e2e/logs.spec.ts`、`tests/e2e/gif.spec.ts`（新） | e2e |

---

### Task 1: URL 遮蔽（core）

**Files:**
- Create: `packages/core/src/redact.ts`
- Test: `packages/core/test/redact.test.ts`

**Interfaces:**
- Produces: `redactUrl(url: string): string`、`redactUrlsInText(text: string): string`、`export const REDACTED = "REDACTED"`

- [ ] **Step 1: Write the failing tests** — `packages/core/test/redact.test.ts`

```ts
test("redactUrl: credential-like query values", () => {
  assert.equal(redactUrl("https://a.com/x?token=abc&q=1"), "https://a.com/x?token=REDACTED&q=1");
  assert.equal(redactUrl("https://a.com/x?access_token=abc"), "https://a.com/x?access_token=REDACTED");
  assert.equal(redactUrl("https://a.com/x?apiKey=k"), "https://a.com/x?apiKey=REDACTED");
  assert.equal(redactUrl("https://a.com/cb?code=xyz&state=s"), "https://a.com/cb?code=REDACTED&state=s");
  assert.equal(redactUrl("https://a.com/x?X-Amz-Signature=s"), "https://a.com/x?X-Amz-Signature=REDACTED");
});
test("redactUrl: userinfo and fragment params", () => {
  assert.equal(redactUrl("https://u:p@a.com/"), "https://REDACTED@a.com/");
  assert.equal(redactUrl("https://a.com/#access_token=t&x=1"), "https://a.com/#access_token=REDACTED&x=1");
});
test("redactUrl: harmless names untouched, unparseable input unchanged", () => {
  assert.equal(redactUrl("https://a.com/s?q=keyword&page=2"), "https://a.com/s?q=keyword&page=2");
  assert.equal(redactUrl("https://a.com/s?keyword=x"), "https://a.com/s?keyword=x");
  assert.equal(redactUrl("not a url"), "not a url");
});
test("redactUrl: over-redaction accepted for *_code", () => {
  assert.equal(redactUrl("https://a.com/?country_code=TW"), "https://a.com/?country_code=REDACTED");
});
test("redactUrlsInText: every URL in free text, trailing punctuation kept", () => {
  assert.equal(
    redactUrlsInText("fail (https://a.com/x?token=t). see https://b.com/y?sig=s, ok"),
    "fail (https://a.com/x?token=REDACTED). see https://b.com/y?sig=REDACTED, ok",
  );
  assert.equal(redactUrlsInText("at f (https://a.com/app.js?key=k:12:5)"), "at f (https://a.com/app.js?key=REDACTED:12:5)");
});
```

> 最後一例：值 `k:12:5` 整段被換掉後，`:12:5` 也會消失。實作時若無法保留行號，把期望改成 `"at f (https://a.com/app.js?key=REDACTED)"`，並在 commit message 註明。重點是值不外洩。

- [ ] **Step 2: Run** `node --test packages/core/test/redact.test.ts` → FAIL（module not found）
- [ ] **Step 3: Implement** `packages/core/src/redact.ts`
  - 參數名斷詞：依 `_`、`-`、`.`、非英數字元與 camelCase 邊界切開並轉小寫；**任一詞**在 `SENSITIVE_PARTS` 中，或整個名稱（去掉分隔符）在 `SENSITIVE_WHOLE` 中，就遮蔽。
  - `SENSITIVE_PARTS = token, code, auth, key, secret, sig, signature, hash, hmac, otp, pass, password, passwd, pwd, session, sid, jwt, bearer, nonce, assertion, credential, credentials, ticket, totp, pin, cvv, cvc`；`SENSITIVE_WHOLE = apikey, accesstoken, idtoken, sessionid, authorization`。
  - 解析用 `new URL()`，失敗就原樣回傳；userinfo 有值時整段換成 `REDACTED@`。不要用 `URLSearchParams.toString()` 重組（它會改編碼）：直接對原始 query／fragment 字串以 `&` 切開，只替換 `=` 右邊的值。
  - 文字中的 URL：regex `/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi`，比對到的結尾若是 `.,;:!?` 或「沒有對應左括號的 `)`／`]`／`}`」，先剝掉再遮蔽，剝下的字元接回去。
- [ ] **Step 4: Run** 同 Step 2 → PASS
- [ ] **Step 5: Commit** `feat(core): URL credential redaction`

---

### Task 2: 記錄緩衝、篩選與格式化（core）

**Files:**
- Create: `packages/core/src/logs.ts`
- Test: `packages/core/test/logs.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `redactUrl`、`redactUrlsInText`（緩衝存「已遮蔽」內容；遮蔽在 `pushConsole`／`pushNetwork` 時做，不在讀取時做）
- Produces:
```ts
export const LOG_CAP = 1000;
export const TEXT_CAP = 16384;
export type ConsoleEntry = { type: string; text: string; url?: string; line?: number; column?: number; stack?: string; ts: number };
export type NetworkEntry = { requestId: string; url: string; method: string; resourceType: string; status?: number; failed?: string; ts: number };
export class RingLog<T> { constructor(cap?: number); push(e: T): void; all(): T[]; clear(): void; get dropped(): number; find(pred: (e: T) => boolean): T | undefined; }
export function makeConsoleEntry(raw: { type: string; text: string; url?: string; line?: number; column?: number; stack?: string; ts: number }): ConsoleEntry; // 截斷 + 遮蔽
export function makeNetworkEntry(raw: { requestId: string; url: string; method: string; resourceType: string; ts: number }): NetworkEntry; // 遮蔽
export type ConsoleQuery = { pattern?: RegExp; onlyErrors?: boolean; limit?: number };
export type NetworkQuery = { urlPattern?: string; resourceType?: string; onlyFailed?: boolean; limit?: number };
export function queryConsole(log: RingLog<ConsoleEntry>, q: ConsoleQuery): { matched: number; entries: ConsoleEntry[] };
export function queryNetwork(log: RingLog<NetworkEntry>, q: NetworkQuery): { matched: number; entries: NetworkEntry[] };
export function formatConsole(r: { matched: number; entries: ConsoleEntry[]; dropped: number; notes: string[] }): string;
export function formatNetwork(r: { matched: number; entries: NetworkEntry[]; dropped: number; notes: string[] }): string;
export function parsePattern(src: string): RegExp; // 大小寫不分；無效 regex 丟 Error
```

- [ ] **Step 1: Write the failing tests** — `packages/core/test/logs.test.ts`，至少：
  - `RingLog` 以 cap 3 推 5 筆 → `all()` 是最後 3 筆、`dropped === 2`；`clear()` 後 `all()` 空、`dropped === 0`。
  - `makeConsoleEntry` 文字 20000 字 → 長度 `TEXT_CAP + "…[truncated]".length`、結尾 `…[truncated]`；文字含 `https://a.com/?token=t` → 變成 `token=REDACTED`；`url`、`stack` 也被遮蔽。
  - `queryConsole`：`onlyErrors` 只留 `error` 與 `exception`；`pattern: parsePattern("boot")` 比對大小寫不分；`limit: 2` 從 5 筆符合中回最後 2 筆，依時間由舊到新；`matched === 5`。
  - `queryNetwork`：`onlyFailed` 留 `status >= 400` 或有 `failed`（`pending` 不算）；`resourceType: "fetch"` 精確比對（大小寫不分）；`urlPattern: "REDACTED"` 能比對遮蔽後的 URL。
  - `formatNetwork` 對 `{status:404}`、`{failed:"net::ERR_CONNECTION_REFUSED"}`、pending 各一筆，輸出分別包含 `404`、`failed net::ERR_CONNECTION_REFUSED`、`pending`；第一行包含 `3 matching, 3 shown`；`dropped: 7` 時第一行包含 `7 older entries were dropped`；`notes` 每則一行放在摘要之後。
  - `formatConsole` 的 exception 條目把 `stack` 以縮排多行輸出在該則之下。
  - `parsePattern("(")` 丟錯。
- [ ] **Step 2: Run** `node --test packages/core/test/logs.test.ts` → FAIL
- [ ] **Step 3: Implement** `packages/core/src/logs.ts`。輸出行格式：console `[<type>] <text> (<url>:<line>:<col>)`（沒有來源就省略括號）；網路 `<METHOD> <status|failed …|pending> <resourceType> <url>`。摘要行：`<matched> matching, <shown> shown` 加上可能的丟棄說明。
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat(core): log ring buffer, queries and formatting`

---

### Task 3: 協定、權限等級、座標反換算（core）

**Files:**
- Modify: `packages/core/src/protocol.ts`、`packages/core/src/grants.ts`、`packages/core/src/coords.ts`
- Test: `packages/core/test/grants.test.ts`、`packages/core/test/coords.test.ts`

**Interfaces:**
- Produces:
  - `ToolName` 加 `"read_console_messages" | "read_network_requests" | "gif_creator"`
  - `ErrorCode` 加 `"invalid_pattern" | "no_frames" | "export_failed"`
  - `ToolResult` 成功分支加選填 `file?: { name: string; data: string /* base64 */ }`（只在 ext → host 方向出現，host 會移除）
  - `levelFor("read_console_messages") === "read"`、`levelFor("read_network_requests") === "read"`、`levelFor("gif_creator") === null`
  - `fromViewport(x: number, y: number, ctx: ScreenshotContext): [number, number]`（`Math.round(x * screenshotWidth / viewportWidth)`，y 同理）

- [ ] **Step 1: Write failing tests**：`grants.test.ts` 加上述三個 `levelFor` 斷言；`coords.test.ts` 加 `fromViewport(640, 400, {viewportWidth:1280, viewportHeight:800, screenshotWidth:640, screenshotHeight:400})` 等於 `[320, 200]`，以及對 `toViewport` 的 round-trip（誤差 ≤ 1）。
- [ ] **Step 2: Run** `node --test packages/core/test/grants.test.ts packages/core/test/coords.test.ts` → FAIL
- [ ] **Step 3: Implement** 上述型別與函式。
- [ ] **Step 4: Run** 上述測試 → PASS；`pnpm typecheck` → 只允許出現「`apps/webop/src/tool-schemas.ts` 或 `tools.ts` 尚未處理新 ToolName」這類預期錯誤；若沒有錯誤更好。
- [ ] **Step 5: Commit** `feat(core): protocol, grants and coords for logs and gif`

---

### Task 4: 網路記錄（一接手就記）＋ `browser_read_network_requests`

**Files:**
- Modify: `apps/extension/src/sw/cdp.ts`、`apps/extension/src/sw/sessions.ts`、`apps/extension/src/sw/tools.ts`、`apps/extension/src/sw/index.ts`（dev hook 匯出）、`apps/webop/src/tool-schemas.ts`、`tests/e2e/fixtures/server.ts`
- Create: `apps/extension/src/sw/logs.ts`、`tests/e2e/fixtures/logs.html`、`tests/e2e/fixtures/logs-redirect.html`、`tests/e2e/logs.spec.ts`

**Interfaces:**
- Consumes: Task 2 全部；Task 3 的 ToolName／levelFor。
- Produces（cdp.ts）:
  - `onAttached(cb: (tabId: number) => Promise<void>): void`：每次 attach 成功（含 SW 重啟後認領的既有 attachment）之後依序 await 所有 cb。cb 內用 `rawCommand`，不能用 `send`（避免遞迴 attach）。
  - `rawCommand(tabId: number, method: string, params?: object): Promise<unknown>`：直接 `chrome.debugger.sendCommand`，dev build 時也寫入 `devSent`（格式 `${tabId} ${method}`）。
  - `isAttached(tabId: number): boolean`
  - `attach(tabId: number, opts?: { allowBlank?: boolean }): Promise<void>`：`allowBlank` 時 `doAttach` 額外接受 `about:blank`；其他非 http(s) 照舊拒絕。
- Produces（logs.ts）:
  - `networkLog(tabId: number): RingLog<NetworkEntry>`、`consoleLog(tabId: number): RingLog<ConsoleEntry>`
  - `takeNotes(tabId: number): string[]`：回傳並清掉該分頁自上次讀取以來的空窗說明；若目前未 attach，再加一句暫停中說明（英文，例如 `Note: recording is paused since <ISO time> (debugger detached); it resumes on the next browser action on this tab.`）。
  - `forgetTab(tabId: number): void`
  - （Task 5 用）`consoleEnabled(tabId: number): boolean`、`enableConsole(tabId: number): Promise<void>`
- Produces（tools）: `browser_read_network_requests`，參數 `tab_id`（必填）、`url_pattern`、`resource_type`、`only_failed`、`limit`、`clear`。

**記錄規則（logs.ts）**
- `onAttached` → `rawCommand(tabId, "Network.enable", { maxPostDataSize: 0 })`；失敗吞掉（記錄就是沒開）。
- `chrome.debugger.onEvent`：
  - `Network.requestWillBeSent`：`data:` 與 `blob:` URL 跳過。若 `type === "Document"` 且 `frameId` 是頂層 frame，且新 URL 的 `siteOf` 與該分頁上次記下的頂層站不同 → 先清空兩個緩衝，再記錄。有 `redirectResponse` 時，先把同 `requestId` 的前一筆 `status` 設為 `redirectResponse.status`，再推一筆新的。
  - 頂層 frame id：`onAttached` 時用 `Page.getFrameTree` 取 `frameTree.frame.id`；`Page.frameNavigated` 且無 `parentId` 時更新。
  - `Network.responseReceived` → 找同 `requestId` 最新一筆設 `status`；`Network.loadingFailed` → 設 `failed = errorText`。
- `onDetached` → 對有緩衝的分頁記下 detach 時間；下次 attach 時把 `[detach, attach]` 加到空窗清單。
- 分頁關閉（`chrome.tabs.onRemoved`）與 session 結束時釋放的分頁 → `forgetTab`。`sessions.ts` 的 `endSessions` 對每個分頁呼叫 `forgetTab`。

**`createTab` 改動（sessions.ts + tools.ts）**
- `createTab` 改成先 `chrome.tabs.create({ url: "about:blank", active: false })`、enroll，然後 `attach(tabId, { allowBlank: true })`（失敗吞掉，只是沒記錄），**不**導航。
- `tools.ts` 的 `tabs_create`：`afterLoad(tab_id, () => chrome.tabs.update(tab_id, { url }))`。之後的權限 recheck、關閉分頁等邏輯不變。
- 既有 e2e（`session.spec.ts`、`agents.spec.ts` 等用到 `tabs_create` 的）必須照樣通過。

- [ ] **Step 1: Fixtures**
  - `server.ts`：路徑符合 `/status/(\d{3})` 時回該狀態碼、body `status <code>`。
  - `logs.html`：載入時 `console.log("boot-log")`、`console.error("boot-error")`、`fetch("/status/200?token=abc&q=1")`、`fetch("/status/500")`、`fetch("/missing.json")`、`fetch("http://127.0.0.1:1/refused").catch(()=>{})`。有一個 `<button id="b">`，點擊時 `console.log("clicked-log")`，並以 `setTimeout(() => { throw new Error("late-boom") })` 丟出未捕捉例外。
  - `logs-redirect.html`：讀 `?to=` 並 `location.replace(to)`（比照既有 `redirect.html`）。
- [ ] **Step 2: Write failing e2e** — `tests/e2e/logs.spec.ts`（網路部分）
  - `t_net_first_load`：`tabs_create` 開 `${baseUrl}/logs.html`，等 200 ms，不做其他動作，讀 `read_network_requests` → 文字包含 `logs.html`（Document）、`status/200?token=REDACTED&q=1`、` 500 `、` 404 `、`failed net::ERR_CONNECTION_REFUSED`；**不**包含 `token=abc`。
  - `t_net_filters`：`only_failed: true` 不含 `status/200`；`url_pattern: "status/"` 只含兩筆 status；`resource_type: "document"` 只含 `logs.html`；`limit: 1` 摘要為 `N matching, 1 shown`。
  - `t_net_clear`：`clear: true` 讀一次後再讀 → `0 matching`。
  - `t_net_site_change_clears`：grants 加 `"127.0.0.1": ["act"]`，`navigate` 到 `${altUrl}/logs.html` → 讀到的 URL 全部是 `127.0.0.1`。
  - `t_net_same_site_keeps`：同站 `navigate` 到 `${baseUrl}/button.html` → 仍讀得到先前的 `logs.html`。
  - `t_net_redirect_away_and_back`：從 `logs.html` 導航到 `logs-redirect.html?to=<altUrl>/logs-redirect.html?to=<baseUrl>/logs.html`（兩站都授權）→ 結果沒有任何 `127.0.0.1` 的條目。
  - `t_net_unauthorized`：分頁在未授權的 `altUrl`（沿用 `read-tools.spec.ts` 的 redirect 手法）→ `permission_required`，沒有內容。
  - `t_net_no_attach_when_detached`：`__webop.simulateDetach(tab, "canceled_by_user")` 後讀網路 → 成功，第一行之後有 `recording is paused` 說明；`chrome.debugger.getTargets()` 顯示該分頁未被 attach。
  - `t_net_no_runtime_enable`：開頁並讀網路後，`__webop.devSent` 中沒有 `<tab> Runtime.enable`。
- [ ] **Step 3: Run** `pnpm --filter extension build:dev && node --test --test-concurrency=1 tests/e2e/logs.spec.ts` → FAIL
- [ ] **Step 4: Implement** cdp.ts 掛鉤、`sw/logs.ts`、`createTab`／`tabs_create` 改動，以及 tools.ts 的 `read_network_requests` handler：`assertOwned` → `requireReadable` → 查詢 → `recheck` → 回文字。**不**包在 `withTab` 裡、不呼叫 `send`。參數驗證失敗回 `invalid_args`。`dispatch` 的 readOnly 判斷加上兩個讀取工具。`tool-schemas.ts` 加定義，description 要寫：一接手分頁就開始記錄；只有 URL／method／status；URL 中的憑證顯示為 REDACTED；換到其他網站會清空；結尾附 `SAFETY`。
- [ ] **Step 5: Run** 上述 e2e → PASS；再跑完整 `pnpm test:e2e`，確認既有 spec 沒有退步。
- [ ] **Step 6: Commit** `feat: record network requests from tab takeover; browser_read_network_requests`

---

### Task 5: console 記錄（第一次讀才開）＋ `browser_read_console_messages`

**Files:**
- Modify: `apps/extension/src/sw/logs.ts`、`apps/extension/src/sw/tools.ts`、`apps/webop/src/tool-schemas.ts`
- Test: `tests/e2e/logs.spec.ts`（加 console 部分）

**Interfaces:**
- Consumes: Task 4 的 `consoleLog`、`takeNotes`、`onAttached`、`rawCommand`、`isAttached`；Task 2 的 `queryConsole`、`formatConsole`、`parsePattern`、`makeConsoleEntry`。
- Produces: `browser_read_console_messages`，參數 `tab_id`（必填）、`pattern`、`only_errors`、`limit`、`clear`。

**規則**
- `consoleEnabled` 用 `Set<number>` 存在記憶體（SW 重啟就清空，屬預期行為）。
- `enableConsole(tabId)`：`withTab` 內 `attach(tabId)` → `rawCommand(tabId, "Runtime.enable")` → 加入集合。
- `onAttached` 掛鉤：集合裡有該分頁時才重送 `Runtime.enable`。
- 事件：`Runtime.consoleAPICalled` 的文字是各個 arg 的 `value`（字串化）或 `unserializableValue` 或 `description` 以空白串接，來源取 `stackTrace.callFrames[0]`；`Runtime.exceptionThrown` 的 type 為 `exception`，文字取 `exception.description ?? text`，stack 每行 `at <fn|<anonymous>> (<url>:<line>:<col>)`。全部經 `makeConsoleEntry`。換站清空沿用 Task 4。
- handler：`assertOwned` → `requireReadable` → `pattern` 無效就回 `invalid_pattern` → 若 `!consoleEnabled(tab)`，執行 `enableConsole`，並在 notes 開頭加 `Console recording started now; messages logged before this call are only shown if the browser replayed them.` → 查詢 → `recheck` → 回文字。
- 若 `consoleEnabled` 但目前未 attach：**不** attach，照常回緩衝，並附上 `takeNotes` 的暫停說明。

- [ ] **Step 1: Write failing e2e**
  - `t_console_lazy`：開 `logs.html`，用 `__webop.devSent` 確認沒有 `Runtime.enable`。第一次 `read_console_messages` 後 `devSent` 有 `<tab> Runtime.enable`，回應包含 `Console recording started now`。印出 `console replay: ${text.includes("boot-log") ? "yes" : "no"}`，結果要寫進驗收紀錄（Task 9）。
  - `t_console_after_enable`：用座標點 `#b`（先截圖），等 300 ms，讀 → 包含 `[log] clicked-log`，並有一筆 `[exception]`，文字含 `late-boom`，下面跟著縮排的 stack 行。
  - `t_console_filters`：`only_errors: true` 不含 `clicked-log`；`pattern: "CLICKED"` 只有一筆；`pattern: "("` → `invalid_pattern`。
  - `t_console_redact`：頁面 `console.log("see https://a.com/?token=zzz")`（用 `browser_javascript` 不行，預設關閉；改在 fixture 的按鈕裡也印這一行）→ 讀到 `token=REDACTED`，不含 `zzz`。
  - `t_console_stop_then_resume`：已開 console 後 `__webop.stopSession("test")`，讀 console → 成功、有 `recording is paused` 說明、分頁未被 attach。接著 `computer screenshot` 之後，`devSent` 出現第二次 `<tab> Runtime.enable`。
- [ ] **Step 2: Run** `node --test --test-concurrency=1 tests/e2e/logs.spec.ts` → 新測試 FAIL
- [ ] **Step 3: Implement** 依上方規則；`tool-schemas.ts` description 要寫：第一次呼叫才開始記錄（之前的訊息可能看不到）、建議帶 `pattern`、結尾附 `SAFETY`。
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat: lazy console recording; browser_read_console_messages`

---

### Task 6: GIF 格子規劃與說明文字（core）

**Files:**
- Create: `packages/core/src/gif.ts`
- Test: `packages/core/test/gif.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `redactUrl`（說明中的 URL）
- Produces:
```ts
export const GIF_MAX_FRAMES = 50, GIF_FRAME_MS = 1500, GIF_LAST_FRAME_MS = 3000, GIF_MAX_WIDTH = 1280;
export type Point = [number, number]; // 動作「之前」那張截圖的座標系
export type GifStep =
  | { kind: "screenshot" }
  | { kind: "left_click" | "right_click" | "double_click" | "hover"; point?: Point; ref?: string }
  | { kind: "left_click_drag"; point?: Point; to?: Point }
  | { kind: "type"; chars: number }
  | { kind: "key"; keys: string }
  | { kind: "scroll"; point?: Point; direction: "up" | "down" | "left" | "right"; amount: number }
  | { kind: "scroll_to"; ref: string }
  | { kind: "form_input"; ref: string }
  | { kind: "navigate" | "tabs_create"; url: string };
export type FrameMeta = { tabId: number; site: string; step: GifStep };
export type PlannedFrame = { frame: number; caption: string; marker?: { point: Point; to?: Point }; durationMs: number };
export function stepCaption(step: GifStep): string | null; // screenshot → null
export function planFrames(frames: FrameMeta[]): PlannedFrame[];
```

**規則**
- `stepCaption`：`left_click` → `點擊 (x, y)`，或 `點擊 ref_12`；`right_click` → `右鍵點擊 …`；`double_click` → `雙擊 …`；`hover` → `滑鼠移到 …`；`left_click_drag` → `拖曳 (x, y) → (x, y)`；`type` → `輸入 N 個字元`；`key` → `按鍵 <keys>`；`scroll` → `捲動 ↓ 3`（↑↓←→）；`scroll_to` → `捲動到 ref_12`；`form_input` → `表單欄位 ref_12 設值`；`navigate` → `前往 <host+path>`；`tabs_create` → `開新分頁 <host+path>`。URL 先 `redactUrl`、去掉 scheme，超過 60 字元截斷加 `…`。座標四捨五入成整數。
- `planFrames`（共 n 格）：
  - 第 i 格的「下一步」= 第 i+1 格的 step。若第 i+1 格存在、`tabId` 相同，且 `stepCaption` 不為 null，第 i 格就顯示該步的說明與標記（有 `point` 才有 marker）。
  - 若第 i 格自己的步驟沒有被畫在第 i−1 格上（i = 0 或 tabId 不同），且 `stepCaption(自己)` 不為 null，而第 i 格又沒被上一條規則占用，就退回顯示自己的步驟。
  - 最後一格若仍沒有說明，就寫 `完成`。
  - 其他沒有說明的格子，caption 為空字串。
  - caption 前綴 `${i+1}/${n} · `，後綴 ` · ${site}`（空 caption 時只留前後綴）。
  - `durationMs`：最後一格 `GIF_LAST_FRAME_MS`，其他 `GIF_FRAME_MS`。

- [ ] **Step 1: Write failing tests**，至少：
  - `[screenshot, left_click(100,50), type(14)]`（同分頁）→ 第 0 格 caption 含 `點擊 (100, 50)`、marker `[100,50]`；第 1 格含 `輸入 14 個字元`、無 marker；第 2 格含 `完成`；durations `[1500,1500,3000]`；第 0 格以 `1/3 · ` 開頭、以 ` · localhost` 結尾。
  - 第 1 格換了分頁：`[A screenshot, B tabs_create(url), B left_click]` → 第 0 格不顯示 `開新分頁`；第 1 格自己顯示 `開新分頁`（退回規則）。這時第 1 格同時符合「顯示下一步 `點擊`」：**規則一優先**，所以第 1 格顯示 `點擊`、第 0 格顯示空說明。驗證這個優先順序，並把它寫進函式註解。
  - `navigate` 的 URL `https://a.com/p?token=t` → caption 含 `前往 a.com/p?token=REDACTED`。
  - `left_click_drag` 的 marker 同時有 `point` 與 `to`。
  - 單格 `[screenshot]` → caption `1/1 · 完成 · site`。
- [ ] **Step 2: Run** `node --test packages/core/test/gif.test.ts` → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat(core): GIF frame planning and captions`

---

### Task 7: GIF 錄影、合成與編碼（擴充）＋ `browser_gif_creator`

**Files:**
- Create: `apps/extension/src/sw/gif.ts`、`tests/e2e/gif.spec.ts`
- Modify: `apps/extension/src/sw/tools.ts`、`apps/extension/src/sw/sessions.ts`、`apps/extension/package.json`（加 `gifenc: 1.0.3`）、`apps/webop/src/tool-schemas.ts`、`tests/e2e/harness.ts`（`gifInfo` helper）

**Interfaces:**
- Consumes: Task 6 全部；Task 3 的 `fromViewport`、`ToolResult.file`；capture.ts 的 `screenshot(tabId, { store: false, budget })`、`getContext`。
- Produces（gif.ts）:
```ts
export function isRecording(session_id: string): boolean;
export function start(session_id: string): void;        // 清空舊格並開始錄
export function stop(session_id: string): number;        // 回傳格數
export function clear(session_id: string): void;
export function dropSession(session_id: string): void;   // session 結束時呼叫
export function record(session_id: string, tabId: number, url: string, block: ContentBlock, ctx: ScreenshotContext, step: GifStep): void; // 非 image block、已滿 50 格、未在錄 → 忽略（已滿時設 capped）
export function exportGif(session_id: string): Promise<{ bytes: Uint8Array; frames: number; capped: boolean }>; // 0 格丟 CdpError("no_frames")
```
- Produces（tools）: `browser_gif_creator`，參數 `action`（`start_recording` | `stop_recording` | `export` | `clear`，必填）、`filename`（選填）。

**錄影掛點（tools.ts）**
- `computer`：`perform` 改成回傳實際作用點 `{ point?: [number, number]; to?: [number, number] }`（viewport px，取自 `aim`／`guardedTarget` 的結果）。在送輸入**之前**先存下 `getContext(tabId)`，再用 `fromViewport` 換成截圖座標放進 `GifStep`。`type` 只存 `text.length`；`key` 存 `keys`。截圖成功回傳之前呼叫 `record`。`zoom` 不錄。
- `form_input`：成功截圖後 `record(..., { kind: "form_input", ref })`。
- `navigate`、`tabs_create`：成功、recheck 通過，且 `isRecording` 時，額外 `screenshot(tabId, { store: false, budget })` 並 `record`。這張截圖失敗就吞掉，不影響工具結果。
- session 結束：`sessions.ts` 的 `endSessions` 對每個結束的 id 呼叫 `dropSession`。

**合成與編碼（gif.ts）**
- 輸出寬度 = `min(第一格寬, GIF_MAX_WIDTH)`，高度依第一格比例；其他格等比縮放、置中、黑色補邊，marker 座標跟著同一比例換算。
- 每格：`createImageBitmap(new Blob([bytes], { type: "image/jpeg" }))` → `OffscreenCanvas` 畫底圖。marker 畫半徑 18 px、4 px 紅色（`#ef4444`）圓環加中心點；drag 畫起點到終點的線與箭頭。底部說明列高 36 px、黑色 70% 不透明、白字 16 px `sans-serif`，文字過長就截斷。
- 編碼：`gifenc` 的 `GIFEncoder`、`quantize(rgba, 256)`、`applyPalette`，每格 `writeFrame(index, w, h, { palette, delay: durationMs })`，第一格設 `repeat: 0`。
- `export` handler：`exportGif`，預設檔名 `webop-<clientNameOf 清理後>-<YYYYMMDD-HHMMSS>.gif`（本機時間），`filename` 有給就用它（host 端會再清理）。回 `{ content: [{ type: "text", text: "Exported <n> frames<capped note>." }], file: { name, data: base64 } }`。錄影中呼叫 `export` 先 `stop`。
- `start_recording` 回應要提醒 agent：開始後立刻做一次 `browser_computer screenshot` 當第一格。已在錄時回提示，不清掉格子。
- `stop_recording` 回格數；`capped` 時加一句：已達 50 格上限，之後的動作沒有錄進去。

- [ ] **Step 1: harness helper** `gifInfo(buf: Buffer): { width: number; height: number; frames: number; delays: number[] }`：檢查開頭 `GIF89a`；讀 logical screen 寬高（offset 6、8，LE）；略過全域色盤；逐區塊走訪：`0x21 0xF9` 讀 delay（單位 1/100 秒，換成 ms）、其他擴充略過子區塊、`0x2C` 計一格並略過 image data 子區塊、`0x3B` 結束。
- [ ] **Step 2: Write failing e2e** — `tests/e2e/gif.spec.ts`
  - `t_gif_flow`：`tabs_create` 開 `form.html`，然後依序 `gif_creator start_recording` → `computer screenshot` → `computer left_click` 點輸入框座標 → `computer type "secret-pw"` → `navigate` 到 `${baseUrl}/button.html` → `gif_creator export`。結果有 `file`，`file.name` 符合 `/^webop-.+-\d{8}-\d{6}\.gif$/`；`gifInfo` 回 `frames === 4`、`width <= 1280`、`delays` 等於 `[1500,1500,1500,3000]`。整個結果（含 base64 解碼後的 bytes 轉 latin1）不含 `secret-pw`。
  - `t_gif_zoom_not_recorded`：錄影中 `zoom` 之後 `stop_recording` 的格數沒有增加。
  - `t_gif_no_frames`：`start_recording` 後直接 `export` → `no_frames`。
  - `t_gif_session_closed`：錄 1 格後 `__webop.closeSession("test")`，用同一 session 再 `export` → 錯誤碼 `tab_not_in_session` 或 `no_frames`（兩者都表示格子已丟，不能是 `internal`）。
  - `t_gif_cap`：錄 52 次 `screenshot` → `stop_recording` 回 `50` 並含 `50` 格上限說明。
- [ ] **Step 3: Run** `pnpm install && pnpm --filter extension build:dev && node --test --test-concurrency=1 tests/e2e/gif.spec.ts` → FAIL
- [ ] **Step 4: Implement**；`tool-schemas.ts` description 說明四個 action、錄影範圍是整個 session、上限 50 格、export 會把 GIF 存成使用者電腦上的檔案並回傳路徑、輸入內容不會出現在 GIF。
- [ ] **Step 5: Run** gif.spec 與完整 `pnpm test:e2e` → PASS
- [ ] **Step 6: Commit** `feat: GIF recording with click markers and captions; browser_gif_creator`

---

### Task 8: host 寫 GIF 檔

**Files:**
- Create: `apps/webop/src/gif-file.ts`、`apps/webop/test/gif-file.test.ts`
- Modify: `apps/webop/src/host.ts`、`apps/webop/test/host.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `ToolResult.file`
- Produces:
  - `gifDir(): string`：`process.env.WEBOP_GIF_DIR ?? path.join(os.homedir(), "Downloads", "webop")`
  - `safeGifName(name: string): string`：取 basename；把 `/ \ :`、控制字元換成 `-`；去掉開頭的 `.`；截到 100 字元；不是 `.gif` 結尾就補上；結果為空時用 `webop.gif`。
  - `writeGif(dir: string, name: string, data: Buffer): string`：`mkdirSync(dir, { recursive: true })`，用 `fs.openSync(p, "wx")` 寫入，`EEXIST` 時依序試 `-1`、`-2`…，回傳絕對路徑。
  - `runHost` 的 io 加選填 `gifDir?: string`（測試用）。

- [ ] **Step 1: Write failing tests**
  - `gif-file.test.ts`：`safeGifName("../../etc/passwd")` → `passwd.gif`；`safeGifName("a:b")` → `a-b.gif`；`safeGifName(".x.gif")` → `x.gif`；`safeGifName("")` → `webop.gif`。在暫存目錄連續兩次 `writeGif(dir, "r.gif", …)` → 依序回 `r.gif`、`r-1.gif`，內容正確。
  - `host.test.ts`：extension 送 `{type:"tool_result", session_id, id, content:[{type:"text",text:"Exported 1 frames."}], file:{name:"t.gif", data: base64("GIF89a")}}` → mcp 端收到的 `result` **沒有** `file`；最後一個 text block 是 `Saved GIF to <abs path> (6 bytes)`；檔案在 `gifDir` 底下，內容是 `GIF89a`。寫檔失敗（`gifDir` 指向一個已存在的「檔案」）→ mcp 收到 `error.code === "export_failed"`，且有記 log。
- [ ] **Step 2: Run** `node --test apps/webop/test/gif-file.test.ts apps/webop/test/host.test.ts` → FAIL
- [ ] **Step 3: Implement**：在 host.ts 的 `tool_result` 分支，有 `file` 時先寫檔，把 `Saved GIF to …` 附到 `content`，再刪掉 `file` 轉送；`file.data` 不是字串或 base64 解碼後長度為 0 時，當成 `export_failed`。
- [ ] **Step 4: Run** → PASS；`pnpm test` 全綠
- [ ] **Step 5: Commit** `feat(webop): native host writes exported GIFs to ~/Downloads/webop`

---

### Task 9: 文件、版本、驗收

**Files:**
- Modify: 4 個版本檔、`CHANGELOG.md`、`README.md`、`README.zh-tw.md`、`docs/roadmap.md`、`docs/agents/README.md`
- Create: `docs/acceptance/0.7.0-manual-acceptance.md`

- [ ] **Step 1:** 版本改 `0.7.0`（4 處）；`apps/webop/test/version.test.ts` 若有寫死版本就同步改。
- [ ] **Step 2:** `CHANGELOG.md` 新增 `## 0.7.0 — <日期>`，列出三個工具、網路一接手就記錄、console 第一次讀才記錄（附原因）、GIF 存放位置、提早出現的偵錯提示條。
- [ ] **Step 3:** README 兩份：工具表加三個工具；「v1 不包含」移除「GIF 錄影、讀取 console 與網路請求」。`docs/roadmap.md` 刪掉這兩列。`docs/agents/README.md` 的系統提示範本加三行：除錯時用 `browser_read_network_requests`、`browser_read_console_messages`（記得帶 pattern）；要留紀錄時用 `browser_gif_creator`（開始後先截圖，結束後 export，並把路徑告訴使用者）。
- [ ] **Step 4:** 驗收紀錄 `docs/acceptance/0.7.0-manual-acceptance.md`，比照 `m6-manual-acceptance.md` 的格式，記下：`t_console_lazy` 印出的 console replay 結果；在真實 Chrome 用 opencode 或 grok 跑一次「找出按鈕沒反應的原因並錄 GIF」，確認 GIF 存到 `~/Downloads/webop/`、標記落在對的位置、看得懂每一步、說明列的中文字有正常顯示。人工步驟留給使用者勾選。
- [ ] **Step 5: Verify** `pnpm typecheck && pnpm test && pnpm test:e2e` 全綠；`node apps/webop/dist/webop.mjs --version` 印出 `0.7.0`。
- [ ] **Step 6: Commit** `docs: 0.7.0 console/network/GIF tools`
