# Browser-Use 執行器規格

> 一份可直接照做的行為契約：視覺定位、座標系、工具集、安全模型。
> 本文描述「應該長什麼樣」，不描述任何特定產品的內部結構。

---

## 0. 一句話

不做 DOM 點擊。把瀏覽器當成**外部螢幕 + 滑鼠**：
截圖 → 依 token 預算縮圖 → 交給模型 → 模型回**全解析度畫面座標** → 除以縮放比換成 CSS viewport 座標 → 送出真實輸入事件。

無障礙樹只是「幫模型挑座標」的輔助層，最終一律落到座標點擊。
`ref` 不是用來 click 的：先 `scrollIntoView`、再 `getBoundingClientRect()` 取中心點，然後照樣走滑鼠事件。

---

## 1. 模組

| 模組 | 角色 |
|---|---|
| Bridge | WebSocket client、訊息派送、心跳、重連 |
| Tool / CDP | 工具 schema、座標換算、CDP 封裝、截圖管線 |
| Panel | UI、權限提示、批次進度、LLM 客戶端 |
| AX | 無障礙樹序列化（獨立、零相依） |
| Overlay | 幻影游標、光暈邊框、停止鈕 |
| Offscreen | 音效與續命 |

### 模型迴圈在哪？

**不在瀏覽器端。** 瀏覽器端只是「工具執行器」：agent loop 跑在外面，經 WebSocket 派 `tool_call` 進來，執行後回 `tool_result`。
所以執行器要保持薄，推論邏輯一律外置。

另有一條獨立路徑：使用者自帶 API key 直連 LLM（`storage` 內存 key、`baseURL` 可設定），供離線/自架用。

---

## 2. 座標系（最容易錯的地方）

畫面座標與 CSS 座標分離，靠一份 per-tab context 換算：

```js
setContext(tabId, {
  viewportWidth, viewportHeight,        // CSS px
  screenshotWidth,  screenshotHeight,   // 影像像素
})

function toViewport(x, y, ctx) {
  return [
    Math.round(x * ctx.viewportWidth  / ctx.screenshotWidth),
    Math.round(y * ctx.viewportHeight / ctx.screenshotHeight),
  ]
}
```

- **模型永遠給「影像像素」座標**，不是縮圖自己的像素。scale 只改回傳影像大小，不改座標框架。
- 越界檢查：`x<0 || y<0 || x>=screenshotWidth+2 || y>=screenshotHeight+2` → `oobError`，訊息要明講「座標是全解析度框架的像素，不是縮圖像素」。
- 每次截圖覆寫 context；舊座標在換頁/視窗變動後失準，錯誤訊息要引導重截圖。
- 縮放比 `min(1, targetWidth / devicePixelWidth)` 直接餵 `clip.scale`，由瀏覽器重取樣。

> 座標換算必須是**唯一出口**，並覆蓋 dpr=1/2/3、scale=0.1/0.5/1、scroll 非 0、邊界值。

---

## 3. 截圖管線

1. 必要時 attach debugger、開 `Emulation.setFocusEmulationEnabled(true)`（背景分頁也能假聚焦）。
2. 隱藏覆蓋層、等 50 ms。
3. 頁內探測 `innerWidth/Height`、`devicePixelRatio`、`scrollX/Y`、`visibilityState`、DOM 節點數、iframe 數、JS heap。
4. 分頁隱藏時先拍 1×1、quality 1 的 JPEG 熱身，逼瀏覽器出圖。
5. 預算裁切：

```js
const T = dpr || 1;
const S = Math.round(width * T);
const E = Math.round(height * T);
const [M] = budget(S, E, { pxPerToken: 28, maxTargetPx: 1568, maxTargetTokens: 1568 });
const z = Math.max(1, Math.round(M * scale));
const A = Math.min(1, z / S);          // → clip.scale
```

`budget()` 二分搜尋降尺寸，直到 `ceil(w/28) * ceil(h/28) <= 1568` 且長邊 ≤ 1568。**28 px ≈ 1 token**。

6. `Page.captureScreenshot({format:"jpeg", quality:75, captureBeyondViewport:false, fromSurface:true, clip:{x:scrollX, y:scrollY, width, height, scale:A}})`。
7. 若不用 `clip.scale`，改走頁內 canvas：解碼 → 依 `MAX_BASE64_CHARS = 1398100` 降品質（0.75 起、每次 −0.05、下限 0.1）→ 仍超標才再降解析度。
8. 用 PNG/JPEG/WEBP 標頭解析器驗證回傳尺寸，不符就重編碼。
9. 回傳 `{base64, width, height, format, viewportWidth, viewportHeight, frameWidth, frameHeight}`，呼叫端轉成 `{type:"image", source:{type:"base64", media_type, data}}`。

### `zoom`（局部放大）

`region:[x0,y0,x1,y1]`（同樣影像像素、同樣 OOB 檢查）→ 以裝置像素裁切 → 用同一組預算把裁切區放大回上限 → **PNG 無損** → `clip.scale`。座標框架不變。

> PNG 沒有品質降級餘裕，只靠尺寸預算，必須另設 base64 上限保護。

---

## 4. 元素 ref 系統

- 全域 `refMap: {ref_N → WeakRef(el)}`、`reverseMap: WeakMap<el, ref_N>`、單調遞增計數器。
- 輸出格式：`<縮排><role> "<可存取名>" [ref_N] href="…" type="…" placeholder="…"`。
- role 推導：`role` 屬性 → 標籤名 → 預設 `generic`；`input[type]` 細分 button/checkbox/radio/textbox。
- 可見性：`display/visibility/opacity/offsetWidth` + 與 viewport 交集。
- 上限：深度 15、節點 10000、輸出 50000 字元（`max_chars`），超過在換行處截斷並附註。
- 敏感值遮蔽：`type=password|hidden`、`autocomplete` 含 `current-password|new-password|one-time-code|cc-*` → `"[value redacted]"`。
- `<select>` 展開 option，標 `(selected)` / `value="…"`。
- 失效 ref 自動清除（`deref()` 為 null 或 `!document.contains`）。

### `find`（自然語言定位）

1. 先產**完整** AX 樹（無 filter）。
2. **二次 LLM 呼叫**：`maxTokens: 800`、`modelClass:"small_fast"`，要求固定格式：
   `FOUND: n / SHOWING: n / ref_X | role | name | type | reason`。
3. 只保留樹中真實存在的 ref，上限 20；超過附 `MORE:` 提示縮小查詢。

> 這是「便宜模型排序候選、主模型決策」的兩段式定位。大頁面純靠主模型看圖會退化，這一層要留。

---

## 5. 動作原語（全部走 `Input.*`）

```js
async function click(tab, x, y, {button="left", count=1, mods=0, intercept, preflight}) {
  hideIndicator(); await sleep(50);
  const moved = dispatchMouseEvent(tab, {type:"mouseMoved", x, y, button:"none", buttons:0});
  await Promise.race([moved, sleep(200)]); await sleep(100);   // 等 hover 效果
  if (intercept) await preflight();                            // 動作前安全檢查
  for (let i = 1; i <= count; i++) {
    dispatchMouseEvent(tab, {type:"mousePressed",  x, y, button, buttons: mask, clickCount: i, modifiers: mods});
    await sleep(12);
    dispatchMouseEvent(tab, {type:"mouseReleased", x, y, button, buttons: 0, clickCount: i, modifiers: mods});
    if (i < count) await sleep(100);
  }
}
```

- 每個滑鼠事件前先送 `{type:"UPDATE_PHANTOM_CURSOR", x, y}`，讓畫面游標跟上。
- 拖曳：5 段插值 `mouseMoved`（`buttons:1`），最後 `mouseReleased`。
- 滾輪：`type:"mouseWheel"` + `deltaX/deltaY`（1 tick = 100 px）；分頁最小化時改注入 `scrollBy`（找最近可捲動祖先，找不到才 `window.scrollBy`）。
- 鍵盤：`rawKeyDown`/`keyDown` + `keyUp`，`windowsVirtualKeyCode`、`code`、modifiers bitmask（alt 1 / ctrl 2 / meta 4 / shift 8）；單字元走 `Input.insertText`；Mac chord 另建對照表轉 `commands`。
- 頁面縮放快捷鍵（`cmd+=` 等）不支援，導向 `zoom`。
- 動作後自動附新截圖。

---

## 6. 安全模型

1. **網域權限**：`checkPermission(url, toolUseId)`；模式 `ask` / `follow_a_plan` / `skip_all`；維護 `allowedDomains` / `onceApprovedHosts` / `deniedDomains`。
2. **詢問時先給預覽**：回 `permission_required` 並附 `{screenshot, coordinate}`，讓人看到「要點哪裡」。
3. **動作前 domain 重驗**：比對 eTLD+1 與 `pendingUrl`，換網域即中止（`security_check_failed`）。
4. **`expected_origin`**：呼叫端可指定，`type` 前再驗一次。
5. **最小化視窗的前景守衛**：攔截 `_blank` 點擊、自行開分頁並保持同一 group。
6. **跨擴充 iframe 剝除**：截圖前移除來源網域不符的 iframe 並重試 attach。
7. **保護頁不可 attach**（`chrome://` 等），直接報錯。
8. AX 樹遮蔽密碼/OTP/信用卡。

### 必要權限

`sidePanel` `storage` `activeTab` `scripting` `debugger` `tabGroups` `tabs` `alarms` `notifications` `webNavigation` `declarativeNetRequestWithHostAccess` `offscreen` `nativeMessaging` `unlimitedStorage` `downloads` `identity`，以及 `<all_urls>` host permission。

`connect-src` 需含本機 daemon：`http://127.0.0.1:8765 ws://127.0.0.1:8765`。

---

## 7. Bridge 協定

WebSocket JSON。URL：`${base}/session/${token}`，`base = ws://127.0.0.1:8765`（自架）。

| 方向 | type | 欄位 |
|---|---|---|
| ← | `tool_call` | `tool`, `tool_use_id`, `args`, `client_type`, `permission_mode`, `allowed_domains`, `handle_permission_prompts`, `session_scope`, `supports_tool_result_notices`, `supports_tool_result_error_code`, `target_device_id` |
| → | `tool_result` | `tool_use_id`, `content` \| `error`, `error_code` |
| → | `permission_request` | `request_id`, `tool_use_id`, `tool_type`, `url`, `action_data` |
| ← | `permission_response` | `request_id`, `allowed`, `connection_id` |
| → ← | `ping` / `pong` | — |
| ← | `peer_connected` / `peer_disconnected` | `mcp_peer_count` |
| ← | `pairing_request` | `request_id`, `client_type` |
| ← → | `external_message` / `external_config` | 執行器之間轉發 |

重連：指數退避 `min(2000 * 1.5^(n-1), max)` × 隨機 0.8–1.2；連續兩次 close code 1008 要清 access token。

`tool_call` 進入後依序檢查：`target_device_id`、tab 存在、session 未過期、工具在白名單內。

工具白名單：`javascript_tool` `read_page` `find` `form_input` `computer` `batch` `navigate` `resize_window` `gif_creator` `upload_image` `get_page_text` `tabs_context` `tabs_create` `tabs_close` `read_console_messages` `read_network_requests` `file_upload`。

---

## 8. 已知限制

- 只能 attach `http(s)`；`chrome://`、商店、PDF viewer 受限。
- DevTools 開在同分頁會導致 attach 失敗。
- 截圖為 viewport-only，長頁需滾動。
- 跨網域 iframe 需 `all_frames` 注入，主畫面座標對 iframe 內元素要額外換算。
- `ref`/`scroll_to` 只為取得座標，之後仍是滑鼠事件，被覆蓋的元素照樣點不到（沒有命中測試後改點）。
- `javascript_tool` 是唯一逃生口，也是最大攻擊面。

---

## 9. 常數速查

| 常數 | 值 |
|---|---|
| `pxPerToken` / `maxTargetPx` / `maxTargetTokens` | 28 / 1568 / 1568 |
| `MAX_BASE64_CHARS` | 1 398 100 |
| JPEG 品質起始 / 步進 / 下限 | 0.75 / 0.05 / 0.1 |
| 游標 transition | `180ms cubic-bezier(0.2,0,0,1)` |
| 覆蓋層 z-index | 2147483646（游標）／2147483647（停止鈕） |
| AX 樹深度 / 節點 / 字元上限 | 15 / 10000 / 50000 |
| click 內部延遲 | hover 100 ms、press→release 12 ms、連點間隔 100 ms |
| 滾輪 1 tick | 100 px |
