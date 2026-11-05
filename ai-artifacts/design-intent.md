---
description: States what the studio's UI is for and the look and behaviour rules a change to web/ must keep.
---

# Design intent

The studio exists so you can see what a workflow does and what a run did. Editing comes second. Follow these rules when you change `web/`. The binding decisions behind them are [ADR-0002](./docs/adr/ADR-0002-run-viewer-first.md) and [ADR-0003](./docs/adr/ADR-0003-pi-plain-files-and-explicit-save.md). The words come from the [domain language](./CONTEXT.md).

## Product shape

**Runs come first.** New UI work goes to runs, replay and playback before the editor. Runs is a top-level tab beside Workflows and Roles, filtered by workflow. Playback steps back and forward one state at a time. It does not stream tokens.

**The home screen answers "what needs me now" first.** The Now band at the top lists runs that need attention. Below it, each workflow has a dated ledger of its recent outcomes. Only after that does the home help you pick a workflow to open (`web/src/homepage.tsx`).

**Nothing reaches disk until you press Save.** Discard drops unsaved changes. A guard warns before you leave with unsaved changes. A save on a file that changed on disk gets a conflict and a Reload button, never a silent overwrite.

**The UI names the file it shows.** The path button shows where a workflow or role lives and copies the path on click. Users can open the same file in any editor.

**The text format stays first-class.** Agents edit workflows as text and through the `studio` CLI. A UI feature must not need data that has no home in Pi's files.

## Look

**Styles are the studio's own.** Derive tokens from product needs: signal colours, contrast and the 390 px layout. Do not copy values from another design system.

**Serif for titles only.** Page titles and home row titles use the system serif token `--serif`. Everything else uses the sans token. No font package ships for the serif.

**Colour carries meaning.** Colour marks a run's signal or a role swatch. It is never decoration. In the Now band, colour sits on the signal dot and its word only.

**Lists are hairline rows.** Rows have a bottom hairline and no per-row boxes. Metadata has no pills around it. Buttons still use `.pill`.

**Chips are plain ink on a tint.** Inside the editor field, chip text stays plain. Only the tint shows the chip's kind. The textarea shows the real text and owns the caret. A mirror layer behind it paints the tints, so the caret never drifts.

**Raise contrast when text reads faintly.** The editing view draws the whole machine at reading contrast. If a panel or label looks faint, raise its contrast.

## Behaviour

**Every screen works at 390 px wide.** The page never scrolls sideways. Wide content, such as the graph or a Markdown table, scrolls inside its own box.

**Use the custom `Select`.** Use `web/src/select.tsx`, not a native `<select>`, for role, initial state and kind pickers.

**Render Markdown.** Prompts and run text render as Markdown, tables included (`web/src/markdown.tsx`).

**Motion is short and quiet.** Run cards respond to hover with a short transition. All motion stops under `prefers-reduced-motion`.

**Words follow the user, not the format.** The UI says "State machine", "Transitions" and "DSL". The [UI names table](./CONTEXT.md#ui-names) maps each one to the format's word.
