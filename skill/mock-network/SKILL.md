---
name: mock-network
description: Mock API responses in the browser with the Mokku extension from the terminal. Use when the user asks to mock the network, intercept or fake HTTP calls, return a fixed response for an endpoint, simulate a backend error (500, 403, timeout), simulate latency, or manage Mokku projects and mocks.
---

# Mocking the network with Mokku

The `mokku` CLI controls the Mokku browser extension without touching the
extension UI. Output: **JSON on stdout**; warnings and errors on stderr;
non-zero exit code on failure.

Binary path: `~/projects/mokku-bridge/bin/mokku.mjs` (or `mokku` if installed
with `install.sh`).

## Commands

```bash
# Create a mock (creates the project if it does not exist)
mokku mock create --project my-app --method GET --url /api/products/ \
  --status 200 --response '{"results":[]}'

# Simulate a backend error with latency and a header
mokku mock create --project my-app --method POST --url /api/orders/ \
  --status 500 --response '{"detail":"boom"}' --delay 2000 \
  --header 'x-request-id: abc'

# Create a disabled mock
mokku mock create --project my-app --method GET --url /api/x/ --inactive

# List
mokku mock list
mokku mock list --project my-app

# Edit (by localId, present in the create/list JSON)
mokku mock update --id 12 --status 403
mokku mock update --id 12 --active false

# Delete
mokku mock delete --id 12

# Check whether a request would be mocked (same RPC as the extension's Tester)
mokku mock test --url https://localhost:3001/api/products/ --method GET

# Repair mocks written by older CLI versions (missing requestType)
mokku mock repair --project my-app

# Projects
mokku project list
mokku project create --name my-app
mokku project delete --name my-app        # deletes its mocks first

# Escape hatch: any service-worker RPC
mokku raw --type MOCK_COUNT_BY_STATUS --data '{"projectLocalId":1}'
mokku raw --type HEADER_GET_ALL --data '{}'
```

## URL matching — read before creating a mock

The extension resolves a mock in two passes: first the request URL **verbatim,
query string included**, then the request **pathname with the query stripped**.

| Goal | Save as |
|---|---|
| Any query string on that path (`?product_id=…`, SDK context params) | pathname: `/api/tasks/` |
| One exact request | full URL: `https://localhost:3001/api/tasks/?product_id=42` |
| Same path, one host only | full URL (pathname matching ignores the host) |

A mock is only reachable if it carries `requestType: 'REST'` and `dynamic:
false`: the matcher queries `mocks.where({url, dynamicKey: 0, method,
requestType: 'REST'})` and `requestType` is not indexed, so Dexie filters it in
memory. `mock create` sets these fields; mocks created by older versions (or by
`raw MOCK_CREATE`) are invisible until `mokku mock repair` runs.

**When a mock does not apply, run `mokku mock test` before theorising.** It
reports `matched` plus the candidates found in each pass, which separates a
matching problem from the interception toggle.

## Useful details
- `--response` is a string; wrap it in single quotes when it is JSON.
- `--status` defaults to 200, `--method` defaults to GET, and the mock is
  created active unless `--inactive`.
- RPC types available for `raw`: `ORGANIZATION_GET_ALL`, `PROJECTS_GET_ALL`,
  `PROJECT_GET`, `PROJECT_CREATE`, `PROJECT_DELETE`, `MOCK_CREATE`,
  `MOCK_CREATE_BULK`, `MOCK_GET`, `MOCK_GET_ALL`, `MOCK_UPDATE`,
  `MOCK_UPDATE_BULK`, `MOCK_DELETE`, `MOCK_DELETE_BULK`,
  `MOCK_COUNT_BY_STATUS`, `HEADER_GET_ALL`, `HEADER_GET`, `HEADER_CREATE`,
  `HEADER_UPDATE`.

## Gotchas (warn the user when they apply)

1. **Interception does not enable itself.** Creating a mock does not make the
   app use it: the user must enable Mokku in the target tab (Mokku panel
   toggle in DevTools or the extension popup). Always say so after creating
   mocks.
2. **Port 5173 must be free.** It is the only port the extension accepts. If
   Vite is using it, stop and ask the user to free it.
3. **The browser must be open** (Dia by default). The first command opens a
   bridge tab on `localhost:5173`; **it must stay open**: subsequent commands
   reuse it without opening new tabs. If it gets closed, the next command
   opens another one.
4. **`MOCK_GET_ALL` requires pagination**: without `{"page":0,"limit":1000}`
   it fails with `Failed to execute 'advance' on 'IDBCursor'`. The CLI already
   passes it and also filters by project client-side; remember this when
   calling it with `raw`.
5. **Deleting a project with the raw RPC leaves orphaned mocks.** Use
   `mokku project delete --name ...`, which deletes the mocks first.
6. **`raw MOCK_CREATE` writes unmatchable mocks.** It bypasses the field
   defaults; use `mokku mock create`, or run `mokku mock repair` afterwards.
7. **A dev server behind a proxy changes the URLs to mock.** Mock what the
   browser requests (the dev-server origin and its proxy prefix), never the
   upstream host. Read the proxy config to get the prefix right.

## Environment variables

- `MOKKU_BROWSER` — browser to open (default `Dia`).
- `MOKKU_TIMEOUT` — ms to wait for the response (default 15000).
