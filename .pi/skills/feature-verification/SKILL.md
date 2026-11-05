---
name: feature-verification
description: Proves a new or changed feature works, with acceptance written first, tests that fail on the base commit and pass on the new code, the real UI driven and screenshotted, and a leak check on every captured page. Use when planning, building, QA-ing or reviewing a feature or a user-visible behaviour change. For a behaviour-preserving refactor, use refactor-verification instead.
---

# Feature verification

A feature is proven when a user can see it work and a test fails without it. A green suite proves nothing on its own: a test written from the new code can pass before the feature exists.

## 1. Define acceptance first

Before coding, list each user-visible behaviour the plan asks for. For each one, write how to observe it:

- **UI:** the screen, the steps and what the user sees, for example "Save with a stale hash shows Reload and Discard".
- **CLI:** the command, its exit code and the expected stdout or stderr.
- **HTTP:** the request, the status and the body or header that changes.

A behaviour with no way to observe it is not an acceptance item yet. Fix the plan first.

## 2. Tests must fail without the feature

This is the inverse of a refactor pin. Run each new test on the base commit, in a detached worktree as in [refactor-verification §2](../refactor-verification/SKILL.md). It must FAIL there and pass on the new code:

```sh
git worktree add --detach /tmp/feat-base <base>
ln -s "$PWD/node_modules" /tmp/feat-base/node_modules
ln -s "$PWD/web/node_modules" /tmp/feat-base/web/node_modules   # for web/src tests
cp -R web/dist /tmp/feat-base/web/dist                          # gitignored build output
cp test/<new>.test.js /tmp/feat-base/test/
(cd /tmp/feat-base && timeout 300 node --test test/<new>.test.js)   # must exit non-zero
git worktree remove --force /tmp/feat-base
```

Read the failure. It must fail on the assertion that names the behaviour, not on a missing import or a typo. A test that cannot load on the base commit, because the file it imports does not exist yet, has not shown that it tests the behaviour. Point it at an existing entry point, or record the load failure and the reason in the report.

Then run the same test on the new code and see it pass. Record both results.

A test is kept only if it fails when the behaviour it names is broken. Delete or rewrite a test that:

- only proves something exists (`typeof x === 'function'`, `Object.keys(m).length > 0`, `existsSync` on a file the test wrote)
- asserts a constant equals its own literal
- asserts a mock or fake returned what the test fed it
- repeats an assertion a stronger test already makes

## 3. Drive the real UI

Tests do not replace using the feature. Follow [testing.md](../../../ai-artifacts/testing.md) for the exact commands and ports.

- Start the studio from a fresh copy of `fixtures/playground`, never `playground/`. Add `--runs-from <dir>` with a runs source that contains the case under test. A fixture copy has no runs.
- Use a port from 4960 to 4969. Never use 4821 to 4823.
- Walk every UI acceptance item with agent-browser: `snapshot -i`, then click and fill by ref.
- Take screenshots at 1440 and 390 widths. When the UI changed, take each width in the light and the dark theme.
- Read every screenshot you take. Look for overlap, clipped text and sideways scroll at 390.
- Check that `agent-browser errors` and `agent-browser console` print nothing.

## 4. Leak check

Check every page you capture, at the moment you take its screenshot:

```sh
TEXT=$(agent-browser --session "$S" get text body) || exit 1
[ -n "$TEXT" ] || { echo 'blank page'; exit 1; }
printf '%s' "$TEXT" | npm run --silent check:docs -- --page -
```

It must print `ok page`. The block checks for text first, because the checker passes empty input. Keep the pointer off the path button, whose tooltip shows the full project path.

## 5. Gates

Run each under `timeout`:

- `npm test` passes.
- `npm run lint` exits 0 with 0 errors and no more warnings than the baseline.
- `npm run build:web` passes when `web/` changed.
- `npm run check:pack` prints `pack ok` when `package.json`, `bin/`, `server/`, `shared/`, `pi/` or `reference/` changed.
- `npm run check:docs` exits 0 when docs changed.

## 6. Hygiene

- Stop every server you start. Check by port that none is left: `ps -eo pid,command | grep -- '--port 4960' | grep -v grep` and `lsof -nP -iTCP:4960 -sTCP:LISTEN` print nothing.
- Close every server a test starts in `t.after`.
- Run every test and check under `timeout`.
- Never `git stash`. The stash is shared across worktrees. Use patch files.
- Remove every worktree you add. Check with `git worktree list`.
- Park orphan files from failed runs beside the plan, for example `<name>.test.js.txt`. Do not delete them.

## 7. Report

- Each acceptance item, with its evidence: the command and its output, or the browser steps and the screenshot path.
- The tests that failed on the base commit and passed on the new code, with the failing assertion from the base run.
- The leak-check output for each captured page.
- The gates and their results.
- What you could not test, and why. Report it as a failure, not a pass.
