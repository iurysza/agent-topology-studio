# Topology studio

Design Pi subagent workflows as state machines. The studio compiles machine JSON to runnable JavaScript and reads it back with Acorn. No LLM translates your workflows.

## Screenshots

![Run replay in the dark theme: a workflow graph partway through a replay, with the walked path, numbered hops and branch badges](assets/readme/run-replay-dark.png)

![Workflow editor in the light theme: the state machine graph beside the state inspector](assets/readme/workflow-light.png)

Synthetic workflows and run journals.

## Requirements

- Node 22.12 or newer, and npm.
- To run workflows, you need Pi and its subagents extension. Install it with `pi install npm:@tintinweb/pi-subagents`. That package provides `SubagentWorkflow`.

The studio itself does not run workflows. It edits them.

## Try it from a clone

```sh
git clone <repo-url> topology-studio
cd topology-studio
./reset-playground.sh
npm start -- --project playground
```

To work on the code from a clone, you need Node 22.18 or newer, because the source runs as `.ts` under Node's type stripping. An installed package needs only Node 22.12.

The first run installs dependencies and builds the web app. Later runs skip the build unless the source changed. The server binds to `127.0.0.1` and opens a token-protected URL.

Flags:

- `--no-open` prints the URL without opening a browser.
- `--port <n>` chooses a port. `--port 0` lets the system pick one.
- `--rebuild` forces a web build.
- `--runs-from <dir>` reads Pi runs from another directory. See [the CLI reference](reference/cli.md).
- `--no-token` turns off the token check. Use it only on a private network. Writes from other websites are still refused. See [Tokenless mode](reference/cli.md#tokenless-mode-and---public-origin).
- `--public-origin <url>`, with `--no-token`, also allows writes from that exact origin, for example `https://studio.example.test` behind a gateway. It is not authentication.
- `--all` lists every project on this Mac that has workflows. It cannot be used with `--runs-from`. See [All projects](reference/cli.md#all-projects).

`playground/` is a local, untracked copy of `fixtures/playground`. `./reset-playground.sh` creates it, or restores it and discards your changes.

## Use it on your own project

Start the studio on your project in one of two ways:

- From a clone: `npm start -- --project /path/to/your/repo`
- From a package: `npx agent-topology-studio --project .`
- For every project with workflows on this Mac: `npx agent-topology-studio --all`. See [All projects](reference/cli.md#all-projects).

Or run `npx agent-topology-studio open --project .` to start it in the background, or reuse the one already running. `npx agent-topology-studio stop --project .` stops it.

Then:

1. Create a workflow: `npx agent-topology-studio new hello`.
2. Create a role for its agents: `npx agent-topology-studio role new coder --description "Writes code"`.
3. Check it: `npx agent-topology-studio check hello`.
4. Open the studio and edit the workflow.
5. In Pi, from the project root, ask the agent: "Run the `hello` workflow with SubagentWorkflow, args `{ ... }`."
6. The run journal appears under `.pi/workflows/`, and the Runs page shows it.

From a clone, write `node bin/studio.ts` instead of `npx agent-topology-studio`, and add `--project <dir>` to each command.

A project holds `.pi/workflows/*.js` and `.pi/agents/*.md`. The studio refuses its own repository root and `fixtures/`.

### Pi and Leader Key

In Pi, the package's extension (`dist/pi/extension.js`, built from `pi/extension.ts`) adds `/studio`, which works like `open` for the session's directory. Disable the old `pi-topology-studio` extension first, because it also registers `/studio`.

- `/studio` starts or reuses the studio for this project and opens it.
- `/studio open` opens a running studio. `/studio stop` stops it.
- `/studio pick` lists this project, your configured projects and running studios, then opens the one you choose.
- `/studio all` starts or reuses the all-projects view and opens it on this project. Leader Key: Ctrl+X, More, Studio, `a`.
- `/studio <path>` opens another project. A path must contain `/` or start with `~` or `.`, so write a directory named `stop` as `./stop`.

The studio keeps running after Pi quits. `TOPOLOGY_STUDIO_PORT` sets its port.

The Leader Key overlay has a Studio menu: press Ctrl+X, then `o` (More), then `s` (Studio). It offers Open this project (`o`), Pick project (`p`), Stop this project (`x`) and Open all-projects view (`a`). To add your own projects, set `topologyStudio.projects` in `~/.pi/agent/settings.json` (or `$PI_CODING_AGENT_DIR/settings.json`):

```json
{ "topologyStudio": { "projects": [{ "key": "g", "label": "my-app", "path": "~/code/my-app" }] } }
```

Each `key` is one lowercase letter other than `o`, `p`, `x` and `a`, and must be unique. The menu reads the file each time it opens, so edits apply without a reload.

## Edit a workflow

1. Open a workflow, or choose New workflow and enter a lowercase id.
2. Edit its title, inputs, states, roles, prompts, outputs, and events in the inspector.
3. Connect states with named events. Tasks and decisions ask agents to report an event; fanout states run their branches together.
4. Open Script to inspect the deterministic output. Valid edits autosave after 500 ms. Problems block saving; warnings do not.

Each saved `.pi/workflows/<id>.js` contains `meta`, a pure `const machine` literal, and a fixed runner. Loading extracts the literal without executing code. Hand-written scripts without a machine literal appear as not editable.

Prompts support `{{inputs.slug}}`, `{{results.qa.report}}`, `{{results.review.a.text}}`, `{{visit}}`, and `{{run.history}}`. Unknown placeholders produce warnings and render as empty strings. Each state's visit cap defaults to three. The runner returns a failure reason when the cap is reached.

Saving checks JavaScript and the last loaded file hash, then writes atomically. Reload if another editor changed the file. There is no lock against an external edit between the hash check and rename.

Run compiled scripts through Pi's `SubagentWorkflow`. See [the workflow API](reference/workflow-api.md).

## CLI

Agents can inspect and edit workflows with the [studio CLI](reference/cli.md), without starting the server. From a clone, the command is `node bin/studio.ts <command>`. From a package, it is `agent-topology-studio <command>`.

## Develop and check

Agents and contributors: read [AGENTS.md](AGENTS.md), then the [knowledge base](ai-artifacts/_index.md).

```sh
./reset-playground.sh   # once, creates the local playground/
npm run dev -- --project playground
npm test
npm run verify
npm run check-workflow -- playground/.pi/workflows/build.js
```

- `npm run dev` runs Vite on `http://127.0.0.1:4821/?token=devtoken` and the API on port 4822. It does not need a prior build. If either process fails, dev stops the other and exits with its code.
- `npm test` builds `dist/` with `tsc`, then runs the Node tests and then the web tests with Vitest. Use `npm test`, not bare `node --test`, which also discovers web tests that need Vitest. Web tests run in the node environment. A test file that needs a DOM opts in with `// @vitest-environment happy-dom` on its first line, as `web/src/projects.test.ts` does.
- `npm run verify` runs lint, the typecheck, both test suites, the runner copy check, a web build and the package contents check.
- Fake-host tests execute the fixture workflows, including their retry loops, without running agents. The fake host fails a test when an answer does not match its output schema.

Machine sources live in `fixtures/machines/`. Their compiled scripts live in `playground/` and `fixtures/playground/`. `npm run check:copies` reports any copy with a stale runner. `./reset-playground.sh` restores the sample project.

`npm run check:docs` checks the knowledge-base Markdown for broken relative links, leaked home paths, usernames, emails and tokens, and that every ADR is listed in its index. With no paths it checks `ai-artifacts`, `AGENTS.md`, `README.md` and `.pi/skills/feature-verification`, skipping any that do not exist. Pass paths to check other files. `node scripts/check-docs.js --page -` checks rendered page text from stdin. It is not part of `npm run verify`.

`npm run typecheck` exits 0. It checks the root, web and strict build projects, and any type error fails `npm run check` and `npm run verify`.

## Repository layout

| Directory | Contents | Ships in the package |
|---|---|---|
| `bin/` | Entry points: `studio.ts`, the CLI (`cli.ts`), the build stamp (`build-stamp.ts`), the instance registry (`instances.ts`), dev tools | Built as `dist/bin/studio.js`, `cli.js`, `build-stamp.js` and `instances.js` only |
| `server/` | Local HTTP server and project files | Yes |
| `shared/` | Validation, compilation, extraction and the runner. Imports no Node built-ins and no Effect: `oxlint.config.ts` and `test/effect-fence.test.js` enforce this | Yes |
| `pi/` | Pi extension: `/studio` and the Leader Key Studio menu | Yes |
| `web/` | The editor app. Only the built `web/dist` ships | `web/dist/` only |
| `reference/` | CLI and API reference docs | Yes |
| `fixtures/` | Machine sources, sample project and run journals for tests | No |
| `playground/` | Editable sample project, created by `./reset-playground.sh` and not tracked | No |
| `scripts/` | Fixture generator and repository checks | No |
| `test/` | Node tests | No |
| `tools/` | Contributor tooling | No |
| `.pi/` | Pi workflows and agents for developing this repository | No |
| `ai-artifacts/` | Knowledge base: domain language, architecture and decisions | No |

## Clean clone check

Run this to check a fresh clone and the package built from it:

```sh
work=$(mktemp -d) && cd "$work"
git clone <repo-url-or-local-path> topology-studio && cd topology-studio
node -v                     # v22.12 or newer
npm ci
npm run lint && npm test    # both suites, exit 0
./reset-playground.sh
npm start -- --project playground --no-open --port 0
# The first run builds web/dist. Open the printed URL, then press Ctrl-C.
npm pack                    # prepack builds web/dist and writes agent-topology-studio-0.1.0.tgz
mkdir ../consumer && cd ../consumer && npm init -y >/dev/null
npm i ../topology-studio/agent-topology-studio-0.1.0.tgz
ls node_modules/agent-topology-studio    # no node_modules or web/src inside
mkdir proj && npx agent-topology-studio new hello --project proj
npx agent-topology-studio check hello --project proj    # OK, with a warning about the unknown role coder
npx agent-topology-studio --project proj --no-open --port 0
# Open the printed URL, then press Ctrl-C.
ls node_modules/agent-topology-studio    # still no node_modules: nothing was installed or built
```

Install from a tarball or a registry. Installing from git (`npm i github:...`) is not supported. A git install has no `dist/` and no `web/dist`, because both are built only when packed.

## License

MIT. See [LICENSE](LICENSE). The package stays `private: true`, and publishing is off.

The stylesheet, theme initializer and the three UI components that overlapped with machine (FSL-1.1-MIT) have been rewritten ([ADR-0009](ai-artifacts/docs/adr/ADR-0009-releases-and-licence.md)). Earlier versions remain in the project's git history.

Bundled dependency and font notices ship in `web/dist/THIRD_PARTY_NOTICES.txt`.

The bundled IoskeleyMono font is licensed under the SIL Open Font License 1.1. Its licence ships in `web/dist/fonts/`.

Machine model and UI credit: [backnotprop/machine](https://github.com/backnotprop/machine) and the [Interfere](https://interfere.com) design system.
