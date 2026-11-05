# Studio CLI

`agent-topology-studio <command>` from an installed package, or `node bin/studio.ts <command>` from a clone, reads and edits project files without starting a server or building the web app. Flag-only arguments start the server instead, for example `agent-topology-studio --project <dir>` or `node bin/studio.ts --project <dir>`. In the commands below, `studio` stands for either form.

For the web server, `--runs-from <dir>` selects the directory where Pi ran workflows, independently of `--project`. Relative paths resolve from the current directory. For example, `npm start -- --project playground --runs-from .` edits playground workflows and reads repository-root session runs. Project journals still come from `playground/.pi/workflows`. See the [Runs API](runs-api.md) for session paths and containment rules.

Every command accepts `--project <dir>`, which defaults to the current directory, and `--json`. Flags follow the command. Relative project and input-file paths resolve from the current directory.

## All projects

`agent-topology-studio --all` starts one server for every project on this Mac that has `.pi/workflows/*.js`. It finds projects from the `cwd` in Pi's session files under `~/.pi/agent/sessions` and from the optional `~/.config/topology-studio/projects.json`:

```json
{ "projects": ["~/dev/my-repo", "/Users/me/work/other"] }
```

A leading `~/` expands to your home folder. Only folders inside your home folder are listed. A bad file is not printed. Its warning appears in `warnings` of `GET /api/projects`, and the session projects are still listed. The list is cached for 5 seconds.

`--runs-from` cannot be used with `--all`. `--project <dir>` with `--all` preselects that project: the printed URL ends in `#/p/<id>/`. When the folder is not listed, for example because it has no workflows, is outside your home folder or is the studio's own repo, the URL has no hash and one line starting `--project <dir>:` on standard error gives the reason. The server keeps running.

The API changes in this mode:

- `GET /api/projects` returns `{ projects, warnings }`. Each project has `id`, `root`, `name`, `workflows`, `lastRunAt` and `source`.
- Every other route moves under `/api/p/<id>/`, for example `/api/p/<id>/workflows/build`. An unknown id gives 404 `Project not found`, a malformed id gives 400, and an unscoped route such as `/api/project` gives 404.
- The token covers every project.

In the web app, every page address starts with `#/p/<id>/`, for example `#/p/<id>/runs`. An address with no project, such as `#/` or `#/runs`, shows the list of projects and changes to `#/`. Opening a link to another project switches to it in place. If the current page has unsaved changes, the unsaved-changes dialog asks first.

The project list shows each project's name, its path with your home folder as `~` (the copy button copies the full path), its workflow count and its last run, or "no runs yet". A green dot marks a project that ran in the last 3 minutes. The search field filters by name and path, and name matches come first. It has focus when there are more than 5 projects. Keys:

- `/` focuses the search field. Esc clears it.
- Enter in the search field opens the top match.
- ArrowDown in the search field moves to the results. `j` and `k` move the selection, and Enter opens it.

Warnings from `GET /api/projects` show as one line under the heading. Hover it for the full list. With no projects, the page shows a sample `projects.json`.

With a project open, the bar reads `Topology studio / <name>`. The name opens a project switcher. Type to filter it by name or path. The first option, "All projects", goes back to the project list. On a phone, the name replaces `Topology studio`, and the switcher is the way back to the list.

Picking a project keeps the current tab and its filters, so `#/p/a/runs` goes to `#/p/b/runs`. On a single workflow, role or run, you land on that tab's list in the new project, because the item belongs to the old one. If the current page has unsaved changes, the unsaved-changes dialog asks first.

In all projects mode the browser tab title is `<name> · Topology studio`, or `Topology studio` on the project list. Single-project mode keeps the title `Topology studio`.

The web app calls `GET /api/projects` once at start to find the mode. Only a 200 answer means all projects mode. In single-project mode the call gives 404 and the app behaves as before, with unscoped addresses such as `#/runs`. A `#/p/<id>/` address opened on a single-project server drops the project part.

Running from a source checkout leaves that checkout out of the list, because it is the studio's own repo. Its sibling worktrees appear, and so does every project when you run through `npx`.

## Tokenless mode and `--public-origin`

`--no-token` turns off the token check. Use it only on a private network: anyone who can reach the server can edit workflows. It is not authentication.

Without a token, the server still refuses writes from other websites. A `POST`, `PUT`, `PATCH` or `DELETE` under `/api/` gets:

- 403 when `Sec-Fetch-Site` is present and is not `same-origin` or `none`
- 403 when `Origin` is present and is not an allowed origin. Allowed origins are `http://127.0.0.1:<port>`, `http://localhost:<port>` and the `--public-origin` value
- 415 when a `POST`, `PUT` or `PATCH` has no `application/json` content type. Case and parameters such as `; charset=utf-8` are fine

A request with no `Origin` and no cross-site `Sec-Fetch-Site`, such as `curl` or a script, is allowed. `X-Forwarded-*` and `Forwarded` headers are ignored. Reads stay open. With a token, the token check is the guard and these rules do not apply.

A gateway that rewrites the `Host` header to `localhost:<port>` sends the browser's own `Origin`, for example `https://studio.example.test`. Allow that exact origin:

```text
agent-topology-studio --project . --no-token --public-origin https://studio.example.test
```

The value must be `http://` or `https://`, a host and an optional port. A trailing `/` is dropped. Credentials, a path, a query, a fragment or `*` are rejected before any install or build. `--public-origin` requires `--no-token`. It adds one origin to the allowlist. It is not authentication, so keep the gateway private. `studio open` does not pass it on.

## Commands

```text
studio list
studio runs [--workflow <id>]
studio run <id>
studio show <id>
studio get <id>
studio put <id> [file|-]
studio new <id> [--name <title>]
studio rm <id>
studio refs <id> [<state>]
studio check [<id>]
studio set <id> <state> key=value ...
studio add-state <id> <state> [--after <from>] [--kind task] [--role coder] [--title <title>]
studio link <id> <from> <event> <to> [--description <text>]
studio unlink <id> <from> <event>
studio rename <id> <from> <to>
studio roles
studio role <name>
studio role new <name> [--description <text>] [--color <color>] [--model <model>] [--thinking <level>] [--tools <csv>] [--skills <csv>] [--body <file|->]
```

`<command> --help` prints usage.

- `list` reports workflow ids, names, state counts, and editability.
- `runs [--workflow <id>]` lists journal-backed runs. `run <id>` shows replay steps. Both accept `--json` and share the [Runs API](runs-api.md) readers.
- `show` outlines states, roles, branches, and events. `get` always prints machine JSON.
- `put` replaces an existing editable machine from a JSON file. An omitted file or `-` reads standard input.
- `new` writes the default `start` task and `done` final state. Existing files are never overwritten.
- `rm` removes a workflow, including a hand-written one.
- `refs` lists reference paths, kinds, and descriptions. A state id excludes its own results. `review.a` selects a fanout branch. Without a state, the list includes all results.
- `check` validates one workflow or all workflows. It also checks JavaScript, including hand-written scripts.
- `set` accepts `title`, `role`, `kind`, `prompt`, `gate`, `maxVisits`, and `outcome`. `maxVisits` is numeric; `maxVisits=` removes the explicit cap. Kind changes keep applicable fields and fill defaults.
- `studio set build build gate="npm test"` sets a task's post-agent shell check; `studio set build build gate=` clears it. A non-zero exit takes the task's `failed` event when present, otherwise it fails the run. Gates are valid only on tasks and fanout branches. Set branch gates through `get` and `put`. Placeholders in a gate are shell-quoted data, and a gate with a placeholder may not use quotes, `\`, `$`, `#`, `<<`, `[`, `]`, `(` or `)` ([workflow API](workflow-api.md)).
- `add-state --after` adds an incoming event and continues to the source's first former target. A fanout re-points its single event. Other sources keep their existing events and add `done`, `done_2`, or the next free name. A final state has no continuation. Without `--after`, the new state is detached and normally fails validation.
- `link` adds or replaces an event. For fanouts, it replaces the single event. `unlink` removes an event. `rename` changes a state id and updates incoming transitions and the initial state.
- `roles` reports names, colours, models, and descriptions. `role` shows metadata and body. Role names match `^[a-z][a-z0-9-]*$`.
- `role new` accepts `--description`, `--color`, `--model`, and free-text `--thinking`. `--tools` and `--skills` accept comma-separated names and trim surrounding whitespace.
- `role new --body <file>` reads the prompt body from a file; `--body -` reads standard input. Without `--body`, the body is empty. Creation uses the same metadata validation as role saves and refuses existing names.

## Open and stop a studio

```text
studio open [--project <dir>] [--all] [--port <n>] [--no-open] [--json]
studio stop [--project <dir> | --all] [--json]
```

- `open` starts a studio server for the project and opens it in the browser. If a studio is already running for that project, it reuses it, prints the same URL with `(already running)`, and opens the browser again. It never starts a second server for one project. Two quick `open` calls share one server.
- `--port` picks the port. The default, 0, lets the system choose a free one. `--no-open` skips the browser. `--json` prints the whole instance record, token included, plus `reused`.
- The server is detached and outlives the `open` command. It runs until `stop` or reboot.
- `stop` stops the project's studio. It exits 0 whether or not one was running. `stop --json` prints `{ project, stopped }`. `stop` rejects `--port` and `--no-open`.
- `open --all` starts or reuses one [all projects](#all-projects) studio, shared by every caller. `open --all --project <dir>` opens it on that project (`#/p/<id>/`). A fresh server also gets `--project`, so it lists that folder. If the folder is missing or not listed, `open` still starts or reuses the server, opens the project list and prints a `--project <dir>: <reason>` line on standard error. `stop --all` stops it and rejects `--project`. Its record is `all.json`, with `project` set to `"*"`.
- Both commands reject positional arguments and unknown flags with `Invalid arguments. Use <command> --help for usage.` A port outside 0 to 65535 fails with `Port must be 0 to 65535`. Errors exit 1.
- If the project has no `.pi/workflows`, `open` still starts the studio with an empty list and prints a hint.

The registry lives in `$XDG_STATE_HOME/topology-studio/`, or `~/.local/state/topology-studio/` when `XDG_STATE_HOME` is unset. Each project has a record (`<sha1 of realpath>.json`) and a server log (`.log`), both readable only by you, because they hold the token. A record counts only when its process is alive and its server answers for that project with that token. If its process is alive but the server does not answer within 2 seconds, `open` and `stop` fail with `… is busy …, try again` and keep the record. Any other record is deleted on the next read. A studio started directly with `studio --project <dir>` is not in the registry.

## Output and write safety

Human output is plain text. With `--json`, lists and references are arrays, `show` returns the machine, and workflow saves return `{ machine, hash, warnings }`. Role reads and creation return `{ role, body, hash }`. `check` returns `[{ id, problems, warnings }]`.

A failure exits 1, prints problems to standard error, and leaves files unchanged. With `--json`, standard error contains `{ problems, warnings }`. Successful writes and checks report warnings without failing.

Each machine save validates the complete result, compiles it, checks the generated JavaScript, and writes atomically with the loaded file hash. An external edit makes the write fail. Hash comparison and rename are not locked against external editors. Removal uses the same delete operation as the HTTP API.

Every intermediate save must be valid. Removing the only event or making a state unreachable fails. Several dependent changes can be applied together through `get` and `put`. Reload an open editor after CLI edits; a stale editor cannot overwrite them without reloading.

## Agent examples

These examples run from the studio repository against `playground`. Run `./reset-playground.sh` first to create it. A shell function abbreviates the command:

```sh
studio() { node bin/studio.ts "$@" --project playground; }
```

### Add a QA retry loop

The new task initially has a direct route to `done`. Removing that event makes QA mandatory. QA passes to `done` or retries `start`.

```sh
studio new checked-build --name 'Build with QA'
studio add-state checked-build qa --after start --kind decision --role qa --title QA
studio unlink checked-build start done
studio link checked-build qa pass done
studio unlink checked-build qa done
studio link checked-build qa retry start --description 'Return to the coder'
studio set checked-build qa 'prompt=Run checks. Choose pass or retry. History: {{run.history}}' maxVisits=3
studio check checked-build
```

### Rename an event

Adding the replacement before removing the old event keeps every intermediate machine valid. This changes `build`'s `built` event to `implemented`.

```sh
studio link build build implemented review --description 'Ready for review'
studio unlink build build built
studio check build
```

### Point a prompt at a new input

This pipe adds `inputs.target` and changes the build prompt in one validated save. It uses Node, with no extra JSON tools.

```sh
studio get build | node --input-type=module -e '
	let text = "";
	for await (const chunk of process.stdin) text += chunk;
	const m = JSON.parse(text);
	m.inputs.target = { type: "string", required: true, description: "Target project directory" };
	m.states.build.prompt = m.states.build.prompt.replaceAll("{{inputs.dir}}", "{{inputs.target}}");
	console.log(JSON.stringify(m));
' | studio put build -
studio refs build build
```
