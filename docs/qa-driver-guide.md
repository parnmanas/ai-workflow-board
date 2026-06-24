# Custom QA Driver Guide

AWB ships a **scenario-based QA feature** (ticket `3c655d20`): each board's feature can
have a **QA driver** — an MCP server that actually operates and observes that feature —
and the QA engine drives it the same way regardless of whether the feature is a web app,
a game client, or a plain REST API.

This guide defines the **driver contract** every driver must satisfy, the procedure for
authoring a new driver, and two reference drivers (browser + game-client) plus an
http-api extension example. It also gives the **scenario-step ↔ driver-action mapping**
the QA agent uses at runtime.

> A QA driver is **not** part of the AWB server. It is an external MCP the QA agent
> calls — exactly like the existing Unity `host` MCP. AWB only stores the scenario, runs
> the agent, and accumulates results (screenshots/videos as `Resource`s). The driver is
> where the feature-specific automation lives.

---

## 1. How the QA engine uses a driver

The data model and dispatch mirror Actions 1:1:

```
QaScenario (definition)  ──start_qa_run──▶  QaRun (one execution)  ──▶  results accumulate
  steps[] (visualized)                       step_results[] (pass/fail)     screenshots/video
  qa_driver + config                         room_id (agent runs here)      = existing Resource ids
  target_agent_id                            re-run = new QaRun (history)
```

1. A user/agent calls `start_qa_run(scenario_id)` (MCP) or `POST /api/qa/scenarios/:id/run`
   (REST). AWB creates a `QaRun` row + a `ChatRoom`, adds the scenario's `target_agent_id`
   as a participant, and posts a **rendered step prompt** (see `qa-prompt.ts`).
2. The QA agent reads the prompt — it lists the scenario steps and instructs the agent to
   drive the **`qa_driver`** MCP step by step.
3. For each step the agent: performs the action via the driver, captures evidence,
   uploads it with `save_resource`, then calls **`record_qa_step`** with the step `idx`,
   `status` (`passed`/`failed`/`skipped`), a `log` note, and `artifact_resource_ids`.
4. When done the agent calls **`complete_qa_run`** with the final `status` and a `summary`.
5. **Re-run** = call `start_qa_run` again → a fresh `QaRun`. History is preserved so the
   UI can compare pass-rate over time.

The driver never talks to AWB directly. The **agent** is the bridge: it calls driver tools
to act/observe, and AWB MCP tools (`save_resource`, `record_qa_step`, `complete_qa_run`)
to persist results.

---

## 2. The driver contract (minimum interface)

A driver is any MCP that exposes capabilities mappable to these four verbs. Tool **names**
may differ per driver — the agent maps them via the scenario steps' `mcp_tool` field and
this guide's mapping table. What matters is that the capabilities exist.

| Verb | Purpose | Returns |
| --- | --- | --- |
| `setup(config)` | Bring the target up: launch/navigate/connect using `qa_driver_config`. | ready handle / session id |
| `teardown()` | Tear the target down: close browser/process/connection. | — |
| `do(action, params)` | Perform one step action: click / fill / navigate / move / API call. | action result |
| `observe()` | Capture current state → **screenshot / video / dump**, returned as bytes the agent uploads as a `Resource`. | media (base64/path) |
| `assert(expect)` | Verify an expectation against current state. | `{ pass: boolean, evidence }` |

Notes:
- `observe()` output becomes a **`Resource`** (`save_resource`) whose id flows into
  `record_qa_step(artifact_resource_ids)`. Screenshots and **videos reuse the existing
  `/api/resources/:id/raw` Range-streaming path** (ff3e7337) — no new storage.
- `assert()` is optional if the agent can judge pass/fail from `observe()` output; prefer
  an explicit `assert` capability for deterministic checks.
- `setup`/`teardown` may be implicit (a stateless http-api driver needs neither).

---

## 3. Authoring a new driver

1. **Pick the transport.** Any MCP server works (Node stdio, HTTP, etc.). The agent must
   have the driver configured in its MCP client (same as the `host` Unity MCP today).
2. **Expose the four verbs.** Implement tools covering `do`/`observe` at minimum; add
   `setup`/`teardown`/`assert` as the target needs.
3. **Make `observe()` return uploadable bytes.** Return base64 (or a path the agent can
   read) for an image/video/text dump so the agent can `save_resource` it.
4. **Document your action vocabulary.** List the `action` strings your `do()` accepts and
   their `params`. Scenario authors put these in each step's `action` / `mcp_tool` /
   `params`.
5. **Register the driver name.** Choose a `qa_driver` string (e.g. `browser`,
   `game-client`, `http-api`) and document the `qa_driver_config` keys you read.
6. **Author a scenario.** `create_qa_scenario` with `qa_driver`, `qa_driver_config`, and
   `steps[]`. Each step `{ idx, action, expect, mcp_tool?, params? }` maps to a driver call.

---

## 4. Reference driver: Browser (Playwright)

For web-feature boards. Playwright (or an equivalent) exposed as an MCP.

- **`qa_driver`**: `browser`
- **`qa_driver_config`**: `{ "start_url": "https://app.example.com", "viewport": {"width":1280,"height":800}, "record_video": true }`

| Contract verb | Browser driver tool | Notes |
| --- | --- | --- |
| `setup` | `browser_launch` / `browser_navigate(start_url)` | open context, optionally start video recording |
| `do` (navigate) | `browser_navigate(url)` | |
| `do` (click) | `browser_click(selector)` | |
| `do` (fill) | `browser_fill(selector, text)` | |
| `observe` | `browser_screenshot()` → PNG; `browser_stop_video()` → MP4 | upload via `save_resource` |
| `assert` | `browser_text(selector)` / `browser_visible(selector)` | compare to step `expect` |
| `teardown` | `browser_close()` | finalize video file |

Example scenario step:

```json
{ "idx": 1, "action": "fill the login email", "mcp_tool": "browser_fill",
  "params": { "selector": "#email", "text": "qa@example.com" },
  "expect": "email field shows qa@example.com" }
```

### 4.1 Reference capture helper (headless Chrome / CDP)

`apps/server/scripts/qa-visual-capture.mjs` is a zero-dependency reference implementation
of the browser driver against AWB's own client UI. It talks the Chrome DevTools Protocol
using Node's built-in `WebSocket` (Node ≥ 21) and a system `google-chrome`; video encoding
shells out to `ffmpeg` (or `$QA_FFMPEG`). It maps onto the contract as:

| Verb | Implementation |
| --- | --- |
| `setup` | launch headless Chrome (`--remote-debugging-port=0`), attach to a page target |
| `do` (auth) | `POST /api/auth/login` → inject `auth_token` + `currentWorkspaceId` into `localStorage` |
| `do` (navigate) | **in-SPA** `history.pushState` + `popstate` (see note below) |
| `observe` | `Page.captureScreenshot` → PNG; `Page.startScreencast` frames → `ffmpeg` → MP4 |
| `teardown` | kill the browser process |

Two gotchas this helper encodes, learned from running it end-to-end (ticket 91cee9f7):

- **Navigate inside the SPA, not by full page load.** AWB uses BrowserRouter (history mode).
  A direct `Page.navigate` to a deep route (`/ws/:ws/boards/:board/qa`) can hit the server
  before the SPA fallback and return a JSON 404 — depending on the static-serving setup
  (observed under Express 5). Load `/` once (authenticated), then drive route changes with
  `history.pushState(...); dispatchEvent(new PopStateEvent('popstate'))` so React Router swaps
  views client-side with no reload. This works on any deployment.
- **Evidence must be a PER-STEP artifact to render.** The QA RunDetail viewer renders
  `step_results[].artifact_resource_ids` as galleries; the run-level `artifact_resource_ids`
  (what `attach_qa_artifact` writes) shows only as a count. So upload via `save_resource`
  then pass the id to `record_qa_step(artifact_resource_ids)` — including the video, or its
  inline-video tile never appears. Set `file_mimetype` exactly (`image/png` / `video/mp4`):
  `/api/resources/:id/raw` streams `Content-Type` from it (with `Accept-Ranges: bytes` so the
  inline `<video>` can seek), and the viewer's `MediaThumb` falls back `<img>`→`<video>`.

```
node apps/server/scripts/qa-visual-capture.mjs \
  --base-url https://awb.example:7700 --email qa@awb.local --password … \
  --workspace <ws> --board <board> --ticket <ticket> \
  --out /tmp/qa-shots --record-video --ffmpeg /path/to/ffmpeg
```

---

## 5. Reference driver: Game client (Unity `host` MCP)

For game-client boards, map the already-connected Unity **`host`** MCP onto the contract.

- **`qa_driver`**: `game-client`
- **`qa_driver_config`**: `{ "executable": "Game.exe", "window_title": "MyGame", "unity_log_dir": "~/AppData/.../Player.log" }`

| Contract verb | `host` MCP tool | Notes |
| --- | --- | --- |
| `setup` | `launch_process(executable)` | start the client; wait for window |
| `do` (click) | `mouse_click(x, y)` | screen-space click |
| `do` (input) | `send_keys(keys)` | keyboard input |
| `observe` (screen) | `screenshot()` / `window_screenshot(window_title)` → PNG | upload via `save_resource` |
| `assert` (logs) | `find_unity_logs(pattern)` | check Player.log for expected/forbidden lines |
| `teardown` | close the process / window | |

Example scenario step:

```json
{ "idx": 2, "action": "click the Start button", "mcp_tool": "mouse_click",
  "params": { "x": 640, "y": 400 },
  "expect": "main menu transitions to loading; Player.log shows 'SceneLoad: Game'" }
```

---

## 6. Extension example: http-api driver

For pure REST/MCP feature validation — no UI.

- **`qa_driver`**: `http-api`
- **`qa_driver_config`**: `{ "base_url": "https://api.example.com", "auth_header": "Bearer …" }`

| Contract verb | http-api driver tool | Notes |
| --- | --- | --- |
| `setup` | (none) | stateless |
| `do` (request) | `http_request(method, path, body)` | returns status + JSON |
| `observe` | dump last response JSON → text Resource | `save_resource` (mimetype text/json) |
| `assert` | compare status code / JSONPath to `expect` | |
| `teardown` | (none) | |

---

## 7. Scenario-step ↔ driver-action mapping (summary)

| Scenario step field | Meaning | Driver mapping |
| --- | --- | --- |
| `action` | Human description of the step | drives which `do()` action the agent picks |
| `mcp_tool` | Explicit driver tool to call (optional) | the exact driver MCP tool name |
| `params` | Args for the driver tool | passed to `do(action, params)` |
| `expect` | Expected outcome | fed to `assert(expect)` / judged from `observe()` |

After each step the agent records via `record_qa_step`:

| `record_qa_step` field | Source |
| --- | --- |
| `idx` | the step's `idx` |
| `status` | result of `assert()` / agent judgement (`passed`/`failed`/`skipped`) |
| `log` | short evidence note |
| `artifact_resource_ids` | `Resource` ids of `observe()` screenshots/videos/dumps |

And finalizes with `complete_qa_run(status, summary)`.

---

## 8. Auto-generating scenarios

"Make a scenario from the board's feature MCP" is an **agent task**, not a server feature:
point the QA agent at a target driver, have it `introspect` the driver's tools / explore
the UI, draft `steps[]`, and persist via `create_qa_scenario`. The same driver contract
makes this uniform across browser / game-client / http-api targets.
