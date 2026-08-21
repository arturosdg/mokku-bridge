# mokku-bridge

CLI bridge to control the [Mokku](https://mokku.dev) browser extension (API
mocking) from the terminal and from Claude Code. Create projects and mocks
without opening the extension UI.

Zero npm dependencies. Node >= 18 only.

## Requirements

- macOS with the **Dia** browser (configurable via `MOKKU_BROWSER`).
- The **Mokku extension installed** in that browser.
- **Port 5173 free**: it is the only port where the extension injects its
  content script, so the bridge needs it.
- Node >= 18 on the PATH.

## Installation

```bash
git clone https://github.com/arturosdg/mokku-bridge.git ~/projects/mokku-bridge
cd ~/projects/mokku-bridge
./install.sh
```

`install.sh` is idempotent. It creates:

- a `mokku` symlink in `/usr/local/bin` (or in `~/.local/bin` if the former is
  not writable, warning about the PATH);
- a skill symlink in `~/.claude/skills/mock-network`.

## Usage

```bash
# Create a mock (creates the project if it does not exist)
mokku mock create --project my-app --method GET --url /api/products/ \
  --status 200 --response '{"results":[]}'

# Simulate a 500 with 2 s of latency
mokku mock create --project my-app --method POST --url /api/orders/ \
  --status 500 --response '{"detail":"boom"}' --delay 2000

# Check whether a request would be mocked, without touching the browser UI
mokku mock test --url https://localhost:3001/api/products/ --method GET

# Repair mocks written by older CLI versions (see "URL matching" below)
mokku mock repair --project my-app

# List, edit and delete
mokku mock list --project my-app
mokku mock update --id 12 --status 403
mokku mock update --id 12 --active false
mokku mock delete --id 12

# Projects
mokku project list
mokku project create --name my-app
mokku project delete --name my-app

# Any extension RPC
mokku raw --type MOCK_COUNT_BY_STATUS --data '{"projectLocalId":1}'
```

Output is JSON on stdout. Warnings go to stderr. Non-zero exit code on failure.

## URL matching

The extension resolves a static mock in two passes (`mockCheckHandler.CHECK_MOCK`):

1. the request url, exactly as requested (query string included);
2. the request **pathname**, with the query string stripped.

So save the bare pathname (`/api/tasks/`) for a mock that must serve any query
string, and the full url (`https://localhost:3001/api/tasks/?product_id=42`)
to pin one exact request. Host and protocol are only compared when the saved url
carries them.

Both passes query IndexedDB with:

```js
mocks.where({ url, dynamicKey: 0, method, requestType: 'REST' })
```

`requestType` is **not** part of the Dexie index (`[url+dynamicKey+method]`), so
Dexie filters it in memory: a mock stored without that field never matches, no
matter how exact its url is. The same applies to `dynamicKey`, derived from
`dynamic`. Every mock the CLI writes therefore carries `dynamic`, `requestType`,
`responseType`, `operationName` and `description`.

Use `mokku mock test` to confirm a matching from the terminal: it calls the same
`CHECK_MOCK` RPC the extension's own Tester uses and reports the candidates found
in each pass.

## How it works

The extension exposes no public API. It does inject a content script
(`app_script.js`) into pages on `http://localhost:5173/*` that proxies RPC
calls to its service worker. The bridge leverages that with a **persistent
tab**: the bridge page stays open polling for jobs, and each CLI invocation
hands it one. A new tab is only opened when no bridge tab is alive.

```
mokku (CLI, Node)
  |  1. starts an ephemeral HTTP server on localhost:5173 holding ONE job
  |  2. waits ~1.6 s for an already-open bridge tab to ask for the job;
  |     if none asks: open -a Dia http://localhost:5173/
  v
bridge page (persistent; POST /job loop every 700 ms)
  |  3. receives {jobId, command, params}
  |  4. window.postMessage({type, data, id, extensionName:'MOKKU', _mokku:{destination:'APP_SCRIPT'}})
  v
app_script.js (Mokku content script)
  |
  v
Mokku service worker  ->  mocks IndexedDB
  |
  v
bridge page  --- 5. POST /result {jobId, ...} --->  mokku (CLI)
  |    6. prints JSON and closes the server          |
  |  7. back to the POST /job loop (waiting for      |
  |     the next CLI invocation)                     |
```

Implementation details:

- **The bridge tab is reused**: keep it open and no later command opens new
  tabs. If you close it, the next command opens one.
- The job is dispatched exactly once: the first `POST /job` takes it and the
  rest get 204 (covers Dia's prerender, which can load the page twice).
- The content script takes ~500 ms to become ready: a freshly loaded page
  waits 1.2 s before its first job and retries every RPC on timeout.
- `mokku project delete` deletes the project's mocks first: the raw
  `PROJECT_DELETE` RPC would leave them orphaned.
- `MOCK_GET_ALL` requires `{page, limit}`; without them the extension fails
  with an `IDBCursor` error.
- Two concurrent `mokku` commands cannot coexist: the second server sees port
  5173 busy and aborts with a clear error.

## Why there is no browserless mode

Every possible channel into the extension requires a page loaded in the same
browser profile where the mocks live:

- The manifest declares `externally_connectable` only for
  `http://localhost:5173/*` and `https://mokku.app/*` — that mechanism lets
  *web pages* at those origins message the extension, not external processes.
- The manifest requests no `nativeMessaging` permission, so there is no
  OS-level channel either.
- A headless browser (Playwright, Puppeteer) runs its own profile with its own
  IndexedDB: mocks created there would not exist in the browser you actually
  use.
- Writing the extension's IndexedDB (LevelDB) on disk directly is locked while
  the browser runs and its format is undocumented.
- The Chrome DevTools Protocol could drive an invisible target inside the real
  browser, but it requires relaunching the browser with
  `--remote-debugging-port`, which defeats the "no browser fiddling" goal.

The persistent tab is therefore the minimal footprint: one tab, opened once,
reused forever.

## Important limitation

Creating or editing mocks **does not enable interception**. After creating a
mock you must enable Mokku manually in the app tab (Mokku panel toggle in
DevTools or the extension popup). The CLI reminds you on stderr. There is no RPC
to read or flip that toggle, so the CLI cannot check it for you — when a mock
does not apply, run `mokku mock test` first: it tells you whether the problem is
the matching or the toggle.

## Friction found in practice

| Symptom | Cause | Fix |
|---|---|---|
| A mock with the exact url is ignored, and the extension's Tester says "No mocks found" | Mocks created before this version lacked `requestType: 'REST'`, which the matcher requires | `mokku mock repair`; new mocks already carry it |
| A mock works for one query string but not another | The first pass compares the url verbatim | Save the bare pathname instead |
| Mocking a shared pathname breaks unrelated calls | Pathname matching ignores the host | Save the full url to scope the mock to one host |
| Feature-flag/analytics SDKs are not intercepted | They append context to the query string | Save the pathname instead of the full url |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `MOKKU_BROWSER` | `Dia` | Browser to open (`open -a`) |
| `MOKKU_TIMEOUT` | `15000` | Milliseconds to wait for the response |
