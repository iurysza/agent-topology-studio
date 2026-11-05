---
name: refactor-verification
description: Proves a behaviour-preserving refactor keeps behaviour, with pins written and run on the OLD code, an old-vs-new output diff on identical inputs and an independent review. Use when planning, building, QA-ing or reviewing a refactor, migration or library adoption (for example Effect) that must not change observable behaviour.
---

# Refactor verification

A refactor is proven when the old and new code give the same observable output on the same inputs. Tests written from the new code prove nothing: on this branch they pinned a changed error precedence, and the builds stayed green.

## 1. Define the contract first

Before coding, write down:

- **Observable channels:** stdout, stderr, exit codes, HTTP status, body and headers (`content-type`, `cache-control`), files written, and output order where it does not depend on timing.
- **Accepted differences:** each one with a reason, for example "500 stack traces stop at Node `fs` frames". Anything not on this list is a regression.

## 2. Pin first, from the OLD code

Write parity tests before the refactor and run them on the base commit:

```sh
git worktree add --detach /tmp/pins-base <base>
ln -s "$PWD/node_modules" /tmp/pins-base/node_modules
cp -R web/dist /tmp/pins-base/web/dist        # gitignored build output
cp test/parity.test.js /tmp/pins-base/test/
(cd /tmp/pins-base && timeout 300 node --test test/parity.test.js)
git worktree remove --force /tmp/pins-base
```

A pin that passes on the new code but never ran on the old code is not evidence. Record the pass count from the old run.

Pin exact values: raw error messages, `instanceof`, `===` identity, rejection rather than a synchronous throw, and byte-exact `{ status, stdout, stderr }`. `test/effect-parity.test.js` is the model.

**Failure-combination rule:** when two operations can fail together (write and close, rename and cleanup), pin which error the caller sees. `try/finally` lets the `finally` error win. Effect keeps the first failure. Pin the old winner.

## 3. Build, then diff old against new

Run identical inputs through both trees:

```sh
.pi/skills/refactor-verification/scripts/old-vs-new.sh <base-ref> cases.tsv [--new <dir>]
```

`scripts/example-cases.tsv` shows the format: `name<TAB>command`, with `$ROOT` set to the tree under test and `$FIX` to a fresh fixture copy. The script prints OK or DIFF per case, exits 1 on any DIFF and always removes its worktree.

For HTTP and anything the script does not cover, follow the same rules by hand:

- Use a fresh fixture copy per side. Never share one.
- Pin mtimes (`touch -t 202001010000`), because they leak into `updatedAt` and sort order.
- Point each tool at its own fixtures directory.
- Give each server a free port. Never use 4821, 4822 or 4823.
- Normalise temp paths and timestamps, nothing else.
- Compare exit, stdout and stderr, or status, body, `content-type` and `cache-control`.

## 4. Independent review

A model that took no part in the build reviews the whole diff. Give it this attack: "Which tests were written from the new code? Which old behaviour do they fail to pin?"

## 5. Hygiene

- Close every server in `t.after` (`server.close` and `closeAllConnections`). One open server hangs `npm test` forever.
- `t.after` hooks run in registration order. Register a `chmod` restore before the `rm`, or drop the restore.
- Run every test command under `timeout`.
- Never `git stash`. The stash is shared across worktrees. Use patch files.
- Park orphan files from failed runs beside the plan, for example `<name>.test.js.txt`. Do not delete them.

## 6. Report

- Pins: count passed on the old code and on the new code.
- Diff: comparison counts per channel (CLI cases, HTTP requests, files).
- Every difference, verbatim, marked as accepted or regression.
- What you could not test, and why.
