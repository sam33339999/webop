# 實作計畫：Hermes × 瀏覽器執行器

> 前一份 `ANALYSIS.md` 是行為契約；這份是怎麼一步步實作、Hermes 從哪裡接入。
> 這是**全新專案**：擴充、NM host、bridge 全部自行撰寫。`fcoeoabgfenejglbffodgkkbkcdhcgfn/`（Claude in Chrome 1.0.102）只是參考原始碼，不修改、不打包、不提交；文中「原擴充」皆指它。
> 前提：Hermes 是你自己在**同一台機器**上跑的 agent harness（負責 LLM 迴圈、提示詞、工具決策）。角色或部署位置不同要先講，架構得改（見第 6 節）。

---

## 1. 先回答：傳輸怎麼選？

**本機情境：Native Messaging（NM）當資料面，NM host 對外說 MCP。** WebSocket 留給跨機器／雲端 agent。NM 的運作方式與本機實例見第 7 節。

### 1.1 事實校正

| 說法 | 實際 |
|---|---|
| 「NM 有 1 MB 上限，截圖單張就爆」 | 1 MB 只限 **host → 瀏覽器**。截圖是 **瀏覽器 → host**，上限 4 GB。原擴充自身走 NM 時另設 32 MB 單訊息上限（`er=33554432`）。 |
| 「執行器不能開 port」 | 正確。擴充無法 listen，只能主動往外連（`WebSocket`）或 `connectNative`。 |
| 「MCP 不適合大圖」 | 不成立。MCP 有 `image` content，base64 傳輸無障礙；真正的限制是上面那條「擴充不能當 server」。 |
| 原擴充本機用什麼 | NM：`com.anthropic.claude_code_browser_extension`（Claude Code）、`com.anthropic.claude_browser_extension`（Desktop），訊息型別 `execute_tool` / `tool_response`。 |

### 1.2 候選比較

| 方案 | 可行 | 大圖 | 標準化 | 複雜度 | 判定 |
|---|---|---|---|---|---|
| A. 執行器直連 Hermes（自訂 WS） | 可 | 好 | 差（綁死） | 中：要開 port、token、改 CSP | 不建議 |
| B. **執行器 ⇄ NM host（stdio）⇄ MCP ⇄ Hermes** | 可 | 好（擴充→host 方向無 1 MB 限制） | 好 | **低**：不開 port、不改 `connect-src`、擴充可主動拉起 host | **採用（本機）** |
| C. 執行器 ⇄ WS daemon ⇄ MCP ⇄ Hermes | 可 | 好 | 好 | 中高：port、一次性 token、Origin 白名單、CSP | 跨機器／雲端才用 |
| D. CDP 直連（`--remote-debugging-port`） | 可 | 好 | 好 | 低 | 只做驗證；**Chrome 136+ 必須搭配非預設 `--user-data-dir`**，拿不到日常 profile 的登入態 |

> D 有現成實作（Playwright MCP、Chrome DevTools MCP），**不要自己寫 P0–P2 的 CDP 版**，直接接現成的驗證提示詞與迴圈，再把時間花在擴充本體。

### 1.3 B 的注意事項

- host → 擴充方向（`tool_call`）仍受 1 MB 限制：參數不得夾帶大檔。`upload_image` / `file_upload` 若要從 host 送檔案，需分塊或改由擴充端以 `downloads`/本機路徑取得。
- NM host 由 Chrome 以子行程啟動，生命週期跟著 port；host 需要是**常駐 MCP server 的薄殼**（stdio ⇄ Unix socket ⇄ MCP server），Hermes 連 MCP server，而不是直接被 Chrome 拉起。
- host manifest 安裝位置依 OS 而異（macOS：`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`），`allowed_origins` 寫死擴充 ID。

---

## 2. 架構與信任邊界

```
┌──────────────┐   MCP (stdio 或 Unix socket)   ┌──────────────────┐
│   Hermes     │◄─────────────────────────────►│  hermes-bridge    │
│ (LLM 迴圈)    │   tools/list, tools/call      │ (MCP server 常駐)  │
└──────────────┘                               └──────────────────┘
                                                   ▲  Unix socket（0600）
                                                   │
                                               ┌──────────────────┐
                                               │  NM host（薄殼）   │ ← Chrome 以 connectNative 拉起
                                               └──────────────────┘
                                                   ▲  NM stdio（長度前綴 JSON）
                                                   │  execute_tool / tool_response
                                               ┌──────────────────┐
                                               │   執行器（擴充）    │
                                               └──────────────────┘
```

**責任切分（硬性）**

| 層 | 擁有 | 不擁有 |
|---|---|---|
| Hermes | 提示詞、工具迴圈、重試、token/時間預算、把影像塞進模型 | 座標、CDP、分頁狀態 |
| hermes-bridge | session、tab 綁定、截圖快取、權限決策、MCP schema 映射、日誌 | 任何 LLM 決策 |
| NM host | stdio ⇄ socket 轉送、長度前綴編解碼 | 任何狀態 |
| 執行器 | CDP attach（`chrome.debugger`）、截圖、座標換算、輸入事件、AX 樹、覆蓋層 | 決策、持久化 |

**信任邊界**：NM 只允許 manifest `allowed_origins` 內的擴充 ID 呼叫；Unix socket 權限 `0600`、只給目前使用者；不開任何 TCP port。`debugger` 權限全程有可見提示條，這是可接受代價。

---

## 3. 逐步流程

每階段有驗收條件，沒過不進下一階段。時程為**個人粗估**，未經實測。

### P0 — 合約與核心（0.5–1 天）
1. 定三個介面：`ToolSpec`、`ToolCall`、`ToolResult`（之後只增不改）。
2. 建 `packages/core`：`coords`、`budget`，**零 UI、零 Chrome API 相依**。
3. 座標單元測試：dpr=1/2/3、scale=0.1/0.5/1、scroll≠0、邊界值。

**驗收**：`toViewport` 全綠，含 `(0,0)`、`(fw-1,fh-1)`、`(fw+2,fh+2)` 拋 OOB。

### P1 — 用現成 CDP MCP 驗證迴圈（0.5–1 天）
1. 以獨立 `--user-data-dir` 開 Chrome，接 Chrome DevTools MCP 或 Playwright MCP。
2. 先寫好 Hermes 系統提示（第 4 節）、跑通「截圖 → 點擊 → 再截圖」。
3. 記錄基準：每任務截圖數、token、成功率。之後自製執行器要跟這個比。

**驗收**：Hermes 在現成工具上完成「到 example.com 搜尋 X 並回報第一筆標題」。

### P2 — 執行器最小可用（2–3 天）
1. MV3 擴充：`chrome.debugger.attach`、`capture()`（探測 → 預算縮圖 → `Page.captureScreenshot` with `clip.scale`）。
2. `computer`：`screenshot` / `left_click` / `type` / `key` / `scroll`；OOB 檢查與 per-tab context 覆寫。
3. 動作後自動回截圖；`expected_origin` 重驗 + `security_check_failed`。
4. 以 `chrome.runtime.onMessage` 暫時自測（先不接 NM）。

**驗收**：擴充內 e2e「填表單 → 送出 → 驗證結果頁」通過；故意換網域被擋。

### P3 — NM 通道 + MCP（2 天）
1. NM host（Node 或 Go 單檔）：stdio 長度前綴 ⇄ Unix socket。
2. hermes-bridge：MCP server，`tools/list` 回第 4 節工具集；`tools/call` → 校驗 → `execute_tool` → 等 `tool_response` → MCP result（影像用 `image` content）。
3. 擴充端：`connectNative`、`onDisconnect` 重連（指數退避）、host 不存在時回明確錯誤。
4. 安裝腳本：寫 NM host manifest、檢查擴充 ID。

**驗收**：P1 的同一組任務改接自製執行器全過；截圖 > 1 MB 仍能傳回。

### P4 — 覆蓋層與 SW 存活（1–2 天）
1. 幻影游標、光暈邊框、停止鈕（Shadow DOM `all: initial`）。
2. 截圖前隱藏覆蓋層，後恢復。
3. SW 存活：NM port 開著時 Chrome 會維持 SW；另加 `alarms` 心跳，狀態一律落 `storage.session/local`。

**驗收**：截圖裡看不到自己的覆蓋層；閒置 10 分鐘後下一次 `tool_call` 正常。

### P5 — 權限與安全（1–2 天）
1. 三種模式：`ask` / `follow_a_plan` / `skip_all`。
2. 權限詢問附 `{screenshot, coordinate}` 預覽（側欄或 bridge 端 UI）。
3. 網域 allow/deny/once 清單；`javascript_tool` 獨立授權。
4. 最小化視窗的前景守衛；跨擴充 iframe 剝除。

**驗收**：`ask` 模式下每個新網域都跳預覽；拒絕後確實不動作。

### P6 — 品質與營運（持續，工作量最大的一塊）
1. AX 樹 content script（`all_frames`、ref 系統、敏感值遮蔽），預估 3–5 天。
2. `find` 兩段式定位（`small_fast` 候選排序），需要 bridge 端能呼叫第二個模型。
3. `batch`、GIF 錄製、console/network 讀取。
4. 指標：每任務截圖數、平均 token、OOB 率、`security_check_failed` 率、工具失敗率；與 P1 基準比較。

**驗收**：抽樣 30 個任務，成功率不低於 P1 基準。

---

## 4. Hermes 的接入點

Hermes 只做三件事：

1. `tools/list` 拿 schema → 併進工具表。
2. 每回合把 `tool_result` 的影像放進訊息（`image` content block 或等效）。
3. 決定下一步呼叫誰、參數多少。

Hermes **不做**：座標換算、CDP、重連、截圖快取、權限判斷、分頁生命週期。

### 系統提示骨架（別省）

```
你有一組瀏覽器工具。操作前先 screenshot 確認位置。
要點元素就點它的視覺中心，不要點邊緣。
座標一律使用截圖的全解析度像素。
點完沒反應就先重截圖，再調整座標。
動作失敗先讀 read_page 找 ref，用 scroll_to 對位後再點。
```

### 工具集（MCP 名稱 → 內部）

| MCP tool | 內部 |
|---|---|
| `browser_computer` | `computer`（action enum 原樣） |
| `browser_read_page` | `read_page` |
| `browser_find` | `find` |
| `browser_navigate` | `navigate` |
| `browser_tabs` | `tabs_context` / `create` / `close` |
| `browser_form_input` | `form_input` |
| `browser_js` | `javascript_tool` |
| `browser_batch` | `batch` |

`screenshot` 不獨立成 tool，走 `browser_computer{action:"screenshot"}`；影像一律經 bridge 快取（有 TTL），避免重複傳輸。

---

## 5. 風險與對策

| 風險 | 對策 |
|---|---|
| service worker 閒置被回收 | NM port 存活期間 SW 不被回收；`alarms` 心跳兜底；狀態落 `storage` |
| host → 擴充 1 MB 上限 | `tool_call` 只放參數；大檔分塊或由擴充端自取 |
| NM host 未安裝／路徑錯 | 擴充偵測 `connectNative` 失敗並給安裝指引；安裝腳本自檢 |
| `chrome://`、商店、PDF 無法 attach | 開頭偵測並回明確錯誤 |
| attach 逾時（DevTools 可能開著、renderer 當掉） | 設 attach timeout，錯誤訊息列出可能原因 |
| 自己的覆蓋層入鏡 | 截圖前必隱藏，驗收項強制檢查 |
| 模型亂給座標 | OOB 直接擋；`scale` 與座標框架永遠分離 |
| 頁面文字提示注入 | AX 內容視為資料；`javascript_tool` 需明示授權；動作前 domain 重驗 |
| 大頁 AX 爆 token | 深度/字元上限、`ref_id` 聚焦、`interactive` filter |
| 影像過大 | base64 上限、品質降級、`zoom` 另設 PNG 上限 |
| 本機其他程式冒用 | 不開 TCP port；Unix socket `0600`；NM `allowed_origins` 鎖擴充 ID |

---

## 6. 何時該偏離本計畫

- **只要單一乾淨 profile、不需要覆蓋層** → 停在 P1，用現成 CDP MCP，不寫執行器。
- **Hermes 跑在別台機器／雲端，或要讓多台瀏覽器被同一個 agent 挑選** → 改走方案 C：執行器**主動外連** WS relay（`wss://`、TLS、帳號認證），relay 依 `device_id` / `target_device_id` 路由。這正是原擴充保留 WS bridge 的理由。
- **Hermes 已支援更合適的通訊**（gRPC 等）→ 換掉 MCP 那一層，NM 資料面不動。
- **要無人值守長跑** → 先補完 P5，並在動作前後存檔截圖。

---

## 7. 附錄：Native Messaging（NM）是什麼

Chrome 官方提供的機制，讓**擴充與本機程式**透過 stdin/stdout 互傳 JSON。擴充身處沙盒、不能開 port、不能執行程式，NM 是唯一正式的「本機出口」。

### 7.1 運作方式（容易誤解的地方）

host manifest **不是掛載到擴充底下**，而是登記在**瀏覽器**的固定目錄，擴充本身不知道它存在：

1. 本機程式的安裝器把 `<name>.json` 寫進瀏覽器的 `NativeMessagingHosts/` 目錄。
2. 擴充呼叫 `chrome.runtime.connectNative("<name>")`。
3. Chrome 到該目錄找同名 JSON，確認呼叫者的擴充 ID 在 `allowed_origins` 內。
4. Chrome 以子行程啟動 `path` 指向的程式，接上 stdin/stdout。
5. 訊息格式：4 bytes 長度前綴（native byte order）+ UTF-8 JSON。
6. port 斷開（擴充 `disconnect()` 或 SW 結束）→ Chrome 關閉該程式的 stdin，程式應自行結束。

方向是**單向發起**：只有擴充能 `connectNative` 把 host 拉起來，host 不能主動找擴充。所以 host 必須是薄殼，真正常駐的 MCP server 另外跑（見第 2 節）。

### 7.2 參考實例：本機上的 Claude Code host

> 這是原擴充 + Claude Code 的設定，只作格式參考。本專案要用**自己的** host 名稱、程式路徑與擴充 ID，例如：
>
> | 欄位 | 參考實例 | 本專案 |
> |---|---|---|
> | `name` | `com.anthropic.claude_code_browser_extension` | `com.<你的網域>.hermes_bridge` |
> | `path` | `~/.claude/chrome/chrome-native-host` | `apps/nm-host` 安裝後的包裝腳本絕對路徑 |
> | `allowed_origins` | `chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/` | 自己擴充的 ID（用 `key` 固定） |
>
> 兩者互不干擾：不同 `name` 各自一份 JSON，可同時存在。

`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json`：

```json
{
  "name": "com.anthropic.claude_code_browser_extension",
  "description": "Claude Code Browser Extension Native Host",
  "path": "/Users/yaxin/.claude/chrome/chrome-native-host",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/"
  ]
}
```

`path` 指向的是一支 shell 包裝腳本，而不是 binary 本體：

```sh
#!/bin/sh
exec /Users/yaxin/.local/bin/claude --chrome-native-host
```

觀察到的做法，可直接沿用：

- **包裝腳本**：manifest 的 `path` 必須是絕對路徑、且 Chrome 不傳自訂參數；用腳本 `exec` 真正的 binary 加旗標，升級 binary 時 manifest 不用改。
- **多瀏覽器各寫一份**：同一個 JSON 也寫進了 Chromium、Edge、Brave、Arc 各自的目錄。每個 Chromium 系瀏覽器只讀自己的目錄。
- **擴充 ID 寫死**：`allowed_origins` 不支援萬用字元；開發版（unpacked）擴充 ID 不同，需另外列入或在 manifest 用 `key` 固定 ID。

### 7.3 macOS 目錄對照

| 瀏覽器 | 使用者層級目錄（`~/Library/Application Support/…`） |
|---|---|
| Chrome | `Google/Chrome/NativeMessagingHosts/` |
| Chromium | `Chromium/NativeMessagingHosts/` |
| Edge | `Microsoft Edge/NativeMessagingHosts/` |
| Brave | `BraveSoftware/Brave-Browser/NativeMessagingHosts/` |
| Arc | `Arc/User Data/NativeMessagingHosts/` |

系統層級（所有使用者）：`/Library/Google/Chrome/NativeMessagingHosts/`。

### 7.4 限制

| 項目 | 值 |
|---|---|
| host → 擴充 單則上限 | 1 MB |
| 擴充 → host 單則上限 | 4 GB |
| 連線範圍 | 僅本機 |
| 需要權限 | 擴充 manifest 的 `nativeMessaging` |
| 安裝 | 使用者端必須另外裝 host 與 manifest |

---

## 8. 交付物

```
packages/core/      coords, budget, actions 型別                 (零相依)
apps/extension/     sw, cdp, capture, tools, overlay, ax, nm client
apps/nm-host/       stdio ⇄ Unix socket 轉送 + 安裝腳本
apps/bridge/        MCP server, session, permissions, 截圖快取
apps/hermes/        提示詞、工具表、迴圈
tests/              座標矩陣、e2e（P2 起 CI 必跑）
```
