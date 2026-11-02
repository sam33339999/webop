# webop

English | [繁體中文](README.zh-tw.md)

**webop** (short for *web operation*) lets any MCP-capable coding agent (opencode, grok CLI, …) drive **the Chrome you already use**: with your logins and cookies, on the sites you allow, while you watch and can stop it at any moment.

It is a Manifest V3 browser extension plus a small `webop` command-line program. The agent talks to `webop` over stdio MCP; `webop` relays to the extension through Chrome's Native Messaging; the extension acts on the page through `chrome.debugger`.

```
agent ⇄ webop mcp (stdio MCP) ⇄ per-profile Unix socket ⇄ webop native-host (Native Messaging) ⇄ extension ⇄ your tabs
```

Current version: **0.7.0** (milestones M1–M6 done and manually accepted). macOS only for now.

## What the agent gets

Fourteen `browser_*` tools:

| Tool | Purpose | Permission level |
|---|---|---|
| `browser_tabs_list` | List the tabs in this agent's tab group | none (titles/URLs of unapproved sites are hidden) |
| `browser_tabs_create` | Open a tab in the group | `read` |
| `browser_tabs_close` | Close one of the group's tabs | none |
| `browser_navigate` | Go to a URL, or `back` / `forward` | `read` |
| `browser_read_page` | Accessibility tree with element refs | `read` |
| `browser_get_page_text` | Main content as plain text | `read` |
| `browser_computer` | Screenshot, `zoom`, click / type / key / scroll / drag / hover | screenshot and zoom `read`, the rest `act` |
| `browser_form_input` | Set a form field by ref (never echoes the value) | `act` |
| `browser_read_network_requests` | Read recorded requests (URL, method, resource type, and HTTP status, failure reason or pending, with a timestamp; no headers or bodies; credentials in URLs shown as `REDACTED`) | `read` |
| `browser_read_console_messages` | Read console messages with timestamps; recording starts on the first call; pass `pattern` (a regex, at most 200 characters) to filter | `read` |
| `browser_gif_creator` | `start_recording` / `stop_recording` / `export` / `clear`: record up to 50 frames with click markers and captions, saved to `~/Downloads/webop/` as `webop-<client>-<YYYYMMDD-HHMMSS>.gif` or the optional `filename` (`WEBOP_GIF_DIR` is a testing/advanced override that only applies when Chrome itself was started with it; Chrome launched from the Dock does not inherit shell variables) | none (this agent's session only) |
| `browser_javascript` | Run JavaScript in the page (off by default) | `javascript` |
| `browser_profiles_list` | List online Chrome profiles | — |
| `browser_profile_select` | Pick the profile this agent drives | — |

## Safety model

- **Per-site permission.** The first time an agent touches a site you get a popup: *Deny*, *Allow this session*, or *Always allow*. Levels are `read`, `act` (includes `read`), and `javascript` (separate, and also behind a global switch in the options page). A deny list blocks sites without asking.
- **Re-checked before acting.** If the tab moved to another site between permission and input, the input is not sent; if a read lands on an unapproved site, no content is returned.
- **Visible and stoppable.** Agent tabs live in a tab group titled `webop · <agent name>` with a glowing border and cursor. Stop with the button in the page, the toolbar icon (stops every agent), or the debugger bar's *Cancel*.
- **Isolated agents.** Each agent connection is its own session with its own tab group; agents cannot touch each other's tabs. *Allow this session* belongs to one agent only.
- Page content is data, never instructions; the tool descriptions tell agents so.

## Requirements

- macOS
- Node 26 and pnpm (`fnm install 26 && fnm use 26`; building the single executable needs Node 26)
- Chrome 116 or later (Brave works too)

## Install

```bash
fnm use 26
pnpm install
pnpm -r build
pnpm build:sea                         # builds the single executable apps/webop/dist/webop
apps/webop/dist/webop --version        # webop 0.7.0
```

Register the Native Messaging host **before** loading the extension:

```bash
apps/webop/dist/webop install
```

It prints the extension id, an opencode config snippet and a `grok mcp add` command, all with absolute paths filled in. Then open `chrome://extensions`, enable Developer mode, choose *Load unpacked* and select `apps/extension/dist`.

If you loaded the extension first, open its options page (or reload it) and it connects right away. Re-run `webop install` after moving the repo or rebuilding elsewhere.

Check everything with:

```bash
apps/webop/dist/webop doctor
```

It prints one `ok` / `warn` / `FAIL` line per check (host manifest, wrapper script, online profiles, extension version) with a hint for each problem, and exits 1 on any `FAIL`.

Uninstall: `apps/webop/dist/webop uninstall`.

## Connect an agent

- **opencode** — paste the snippet `webop install` printed into `opencode.json`. Details: [docs/agents/opencode.md](docs/agents/opencode.md).
- **grok CLI** — run the printed `grok mcp add webop … -- mcp`. Details: [docs/agents/grok.md](docs/agents/grok.md).
- Anything else that launches a stdio MCP server: run `apps/webop/dist/webop mcp`.

Useful `webop mcp` flags: `--profile <name or id>` pins a Chrome profile; `--image-max-px`, `--image-max-tokens`, `--px-per-token` size screenshots for your model.

A shared system-prompt template and notes on running several agents at once: [docs/agents/README.md](docs/agents/README.md).

## Multiple Chrome profiles

Every profile with the extension is reachable. With more than one online, an agent gets `profile_required` until it calls `browser_profile_select` (or was started with `--profile`). A profile goes offline when its last window closes and comes back when a window opens. Rename a profile in the extension's options page.

## Versions

The CLI and the extension always share one version number, and every change bumps it ([CHANGELOG.md](CHANGELOG.md)). Check it with `apps/webop/dist/webop --version`, the extension card in `chrome://extensions`, or `webop doctor`, which also flags a mismatch between the two.

## Development

```bash
pnpm test        # unit tests (node --test)
pnpm typecheck
pnpm test:e2e    # end-to-end with Playwright Chromium and throwaway profiles; builds dist-dev and the SEA
```

Automated tests never touch your own browser profile. Headless Chromium keeps rendering background tabs, so behaviour that depends on a real browser's background tabs is covered by the manual acceptance checklists.

| Path | Contents |
|---|---|
| `packages/core` | protocol types, coordinate mapping, screenshot budget, permission decisions |
| `apps/extension` | MV3 extension: service worker, CDP, capture, input, permissions, overlay, page scripts |
| `apps/webop` | CLI: `mcp`, `native-host`, `install`, `uninstall`, `doctor`, single-executable build |
| `tests/e2e` | browser end-to-end tests |
| `docs` | design spec, plans, agent guides, acceptance records, roadmap |

## Documentation

- Design spec: [docs/superpowers/specs/2026-10-31-webop-design.md](docs/superpowers/specs/2026-10-31-webop-design.md)
- Implementation plans: [M1–M3](docs/superpowers/plans/2026-10-31-webop-m1-m3.md), [M4](docs/superpowers/plans/2026-10-31-webop-m4.md), [M5](docs/superpowers/plans/2026-10-31-webop-m5.md), [M6](docs/superpowers/plans/2026-11-01-webop-m6.md)
- Agent guides: [docs/agents/](docs/agents/README.md)
- Manual acceptance records: [docs/acceptance/](docs/acceptance/) (M4–M5 results are in [docs/agents/opencode.md](docs/agents/opencode.md))
- 0.7.0 trade-offs and known costs (Traditional Chinese): [docs/0.7.0-tradeoffs.md](docs/0.7.0-tradeoffs.md)
- Roadmap: [docs/roadmap.md](docs/roadmap.md)

## Not in v1

Chrome Web Store / notarized distribution, Linux and Windows, file upload, and closing a session's tabs automatically when it ends. The last two and cross-platform support are on the [roadmap](docs/roadmap.md).
