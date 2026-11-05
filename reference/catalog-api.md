# Catalog API

`GET /api/catalog` returns `{ "tools": string[], "skills": string[] }` for role-editor autocomplete. It requires the normal `X-Studio-Token` header. Other methods return 405. The endpoint only reads files.

`tools` contains these Pi built-ins plus every tool name used by project roles in `.pi/agents/*.md`:

```text
read, bash, edit, write, grep, find, ls, codemode, web_search,
fetch_content, get_search_content, Agent, SubagentWorkflow, ask_user
```

`skills` contains directory names under `<project>/.pi/skills/` and `~/.pi/agent/skills/` that contain a `SKILL.md` file, plus every skill name used by project roles. Missing directories are ignored. Project skill paths use the same containment checks as other project files.

Both arrays are sorted and deduplicated. The reader checks roles and installed skills on each request, so edits appear without restarting the server.

`studio catalog [--project <dir>] [--json]` uses the same reader. JSON output has the same shape as the API response.
