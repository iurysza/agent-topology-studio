---
description: Lists the commands, ports and rules for testing topology studio, from unit tests to driving the UI by hand.
---

# Testing topology studio

Run every command from the repository root, under `timeout`. Use Node 22.18 or newer: tests run the `.ts` source under Node's type stripping. The rule behind every test is [ADR-0007](./docs/adr/ADR-0007-tests-prove-behaviour.md): a test must fail when the behaviour it names breaks.

## Gates

| Command | Passes when | Notes |
| --- | --- | --- |
| `timeout 600 npm test` | exit 0 | Runs `build:ts` (deletes and rebuilds `dist/`), then the Node tests, then the web tests with Vitest |
| `timeout 300 npm run lint` | exit 0, 0 errors | Do not add warnings. Each `warn` rule in `oxlint.config.ts` goes back to `error` when its findings are fixed |
| `timeout 300 npm run typecheck` | exit 0 | Checks the root `tsconfig.json`, `web/tsconfig.json` and the strict `tsconfig.build.json`. Fix a type error with types or narrowing, not `@ts-ignore` |
| `timeout 300 npm run build:web` | exit 0 | Run when `web/` changed. The Vite chunk-size warning is expected |
| `timeout 120 npm run check:copies` | prints `runner copies ok` | Run when `shared/runner.ts` or a workflow copy changed |
| `timeout 300 npm run check:pack` | prints `pack ok` | Run when `package.json`, `bin/`, `server/`, `shared/`, `pi/` or `reference/` changed |
| `timeout 120 npm run check:docs` | exit 0 | Run when docs changed. With no arguments it checks `ai-artifacts`, `AGENTS.md` and `README.md` |

`npm run verify` runs lint, the typecheck, both test suites, the copy check, the web build and the package check.

Use `npm test`, not bare `node --test`, which also picks up web tests that need Vitest. To run a subset of Node tests, quote the glob: `node --test 'test/pins/*.test.js'`.

## Ports

Each port range has one owner. A test that binds a port another process holds fails with `EADDRINUSE`.

| Ports | Owner |
| --- | --- |
| 4931 to 4949 | Node test suites. Each suite owns one fixed port |
| 48931 to 48934 | Instance tests |
| 4960 to 4969 | Hand testing |
| 4821 to 4823 | `npm run dev` and local studios. Do not use them for tests |

## Start a studio for hand testing

Use a fresh copy of `fixtures/playground` in a temp directory, not `playground/`:

```sh
FIX="$(mktemp -d)/playground"
cp -R fixtures/playground "$FIX"
LOG="$TMPDIR/studio-4960.log"
node bin/studio.ts --project "$FIX" --port 4960 --no-open > "$LOG" 2>&1 &
PID=$!
URL=
for i in $(seq 120); do
  URL=$(grep -o 'http://127.0.0.1:4960/[^ ]*' "$LOG")
  [ -n "$URL" ] && break
  kill -0 $PID 2>/dev/null || { cat "$LOG"; exit 1; }
  sleep 1
done
[ -n "$URL" ] || { echo 'studio did not start in 120 s'; cat "$LOG"; exit 1; }
```

The first start after a source change builds `web/dist`, so the loop waits up to 120 seconds. The URL carries a token. Treat it as a secret and keep it out of reports.

Two options change what the studio shows:

- `--runs-from <dir>` reads runs from another project's session journals. A fixture copy has no runs, so pick a source that contains the case you test.
- `--all` lists every project that has `.pi/workflows`. Add `--project <dir>` to preselect one.

Stop the studio when you finish: `kill $PID`. Then check that `lsof -nP -iTCP:4960 -sTCP:LISTEN` prints nothing.

## Check the UI

- Look at every changed screen at 1440 px and 390 px wide, in the light and the dark theme. The theme switch is the **System**, **Light** and **Dark** group in the header.
- Wait about a second after a theme change before a screenshot, or the colour fade is caught half done.
- The browser console must show no errors.
- Read every screenshot you take.

## Leak check

Before you share a screenshot, pipe the page's visible text through the page-mode leak check:

```sh
printf '%s' "$PAGE_TEXT" | npm run --silent check:docs -- --page -
```

It prints `ok page` when the text holds no home path, user name, `@` or `token=`. An empty page passes, so check that the text is not empty first. The check does not see attributes. The path button puts the full project path in its tooltip, so keep the pointer off it in shared screenshots.

## Golden pins

`test/pins/` compares current output with golden files in `test/pins/golden/`, once for the source tree and once for `dist/` when it exists. `test/pins/installed.test.js` builds an installed copy from the `npm pack` file list and pins its startup URL and four HTTP responses. A golden mismatch is a regression. `PINS_UPDATE=1` rewrites the goldens. Run it only on a base commit you trust, never on new code.

## Test hygiene

- Close every server a test starts in `t.after`.
- Use `node:http` with `agent: false` when several tests hit one port. A pooled keep-alive socket can reach a replaced server and fail with `ECONNRESET`.
- Make an HTTP helper's promise settle on every exit path: listen for `error` on the request and the response, `aborted` on the response, and `close` with `!res.complete`.
- Resolve anything that can throw before you open a file or take a lock. `launch` in `bin/instances.ts` calls `resolveEntry` before it opens the log.
- To test a module in another package layout, copy its `.js` file to a temp directory and import the copy. Node will not strip types under `node_modules`.
- When a refactor must keep an error message, keep the original call expression. V8 builds "... is not a function" messages from the source text.
- `vi.stubGlobal` replaces a value. It does not run getters, so stub the value the code reads.
- Do not import `react-dom/server` in `web/src`. `test/effect-fence.test.js` bans import paths with a `server` segment there.
- On macOS, put scratch worktrees under a real path, not `/tmp`. `server/main.ts` runs only when `argv[1]` equals its real path.
