# CLAUDE.md

Context for AI agents working on this repository. Read this before changing anything.

## What this is

**Sidebar File Notes** is a VS Code extension that shows a markdown notes view (named **Notes**, in the
Explorer) whose content follows the focused tab:

- each **file** has its own note;
- each **Claude Code conversation** opened as an editor tab has its own note;
- focusing anything else (terminal, settings, the notes view itself, an untitled file) keeps the current note.

The main use case is taking notes beside a Claude Code conversation in VS Code and having them switch
when you switch conversations.

It is a fork of [AssisrMatheus/sidebar-markdown-notes](https://github.com/AssisrMatheus/sidebar-markdown-notes)
(v1.2.0, last released 2023-05). The upstream extension kept one global list of "pages" in the webview's
`vscode.getState()`. Version 2.0.0 (this fork) is close to a rewrite: only the webview's markdown/CSS look and the
icon remain. License is GPL-3.0-or-later (inherited; keep it).

Repository: https://github.com/afdaniele/sidebar-file-notes. Publisher id in `package.json`: `afdaniele`.

## Status (as of 2026-11-27)

- Implemented, unit tested (22 mocha tests), lint clean, packaged as `sidebar-file-notes-2.0.0.vsix`, and
  installed locally by the owner.
- **Not yet exercised in a live VS Code window by an agent.** Tab following, the file watcher, the
  webview and Claude tab detection are typechecked but only the pure modules have tests. Expect bugs there
  first.
- The 2.0.0 rewrite may not be committed yet: check `git status` / `git log` before assuming.
- Not published to any marketplace. The upstream `publish.yml` (which auto-published on every push to
  `main`) was deliberately removed; `.github/workflows/ci.yml` only lints, tests, packages and uploads the
  `.vsix` as an artifact. Do not add publishing without the owner asking.

## Commands

```sh
npm install
npm test           # tsc -> out/, then mocha 'out/test/**/*.test.js' (pure modules only, no VS Code needed)
npm run lint       # eslint + prettier rules on src/
npm run typecheck
npm run build      # webpack: dist/extension.js (node) + dist/webview.js (web)
npm run watch      # then F5 ("Run Extension") opens an Extension Development Host
npx vsce package   # -> sidebar-file-notes-<version>.vsix
code --install-extension sidebar-file-notes-<version>.vsix
```

Format with `npx prettier --write src media/main.js media/tasks.js media/main.css` (config in `.prettierrc.js`:
single quotes, no trailing commas, width 120). Node 20 is what CI uses.

When installing the `.vsix`, the `code` CLI prints a Node `DEP0169 url.parse()` deprecation warning. It
comes from VS Code's CLI, not this extension (the bundle only requires `fs`, `os`, `path`, `crypto`, `vscode`).

## Layout

```
src/
  extension.ts        activate(): wires everything, registers the view and the commands
  notesController.ts  follows the active tab, switches notes, saves, watches the note file, handles renames
  targets.ts          TargetResolver: Tab -> NoteTarget (file note, Claude note, pending Claude note); vscode API
  claudeSessions.ts   ClaudeSessionIndex: tab label -> Claude Code session id, by reading transcripts (no vscode import)
  notePaths.ts        where note files live (no vscode import)
  noteStore.ts        serialized reads/writes/merges/renames of note files (no vscode import)
  notesView.ts        NotesViewProvider: the webview view, its HTML and the message protocol
  capture.ts          reads the selection of the focused Claude conversation (via the clipboard) or text editor
  snippets.ts         formats captured text as markdown (quote, fenced code block), appendBlock (no vscode import)
  test/*.test.ts      mocha unit tests for the pure modules and media/tasks.js
media/
  main.js             webview script (ES module, bundled by webpack into dist/webview.js)
  tasks.js            toggleTask(): flip the n-th markdown task checkbox (CommonJS so tests can require it)
  main.css, markdown.css, vscode.css, reset.css
```

`claudeSessions.ts`, `notePaths.ts`, `noteStore.ts` and `snippets.ts` must not import `vscode`, so they stay testable with
plain mocha. Put new logic that can be pure in modules like these, and add tests.

## Architecture and data flow

1. `NotesController` listens to `window.tabGroups.onDidChangeTabs` / `onDidChangeTabGroups` (and
   configuration, workspace-folder and rename events). Each event schedules a debounced (50 ms) `refresh()`.
2. `refresh()` asks `TargetResolver.forTab(activeTab)` for a `NoteTarget`:
   - `TabInputText`, `TabInputCustom`, `TabInputNotebook` -> their `uri`; `TabInputTextDiff`,
     `TabInputNotebookDiff` -> `modified`. Only `file:` URIs get notes. A URI inside any notes root (a
     note file opened in an editor) returns `undefined`.
   - `TabInputWebview` whose `viewType` *includes* `claudeVSCodePanel` -> Claude target (see below).
   - anything else -> `undefined`, meaning "keep the current note".
   A sequence number discards stale async results. When the view is locked, refresh does nothing.
3. If the note path differs from the current one (or the target carries `migrateFrom`), `switchTo()` runs,
   serialized through a promise chain:
   `view.flush()` (webview sends unsaved typing) -> merge the pending note if `migrateFrom` -> read the note
   file -> `view.show()` -> watch the note file -> schedule a retry if `target.unsettled`.
   If only the title changed (same note path), `view.updateTarget()` posts a `meta` message that updates
   the header without touching the textarea (keeps cursor and undo).
4. The webview posts `save {key, content}` (300 ms debounce, also on blur/pagehide); the controller
   writes through `NoteStore`, but only for keys it issued (`issuedKeys`).

### `NoteTarget`

```ts
{ kind: 'file' | 'claude' | 'claude-pending', notePath, root, title, detail, tab?, migrateFrom?, unsettled? }
```

`notePath` (absolute) is the note's identity and the `key` used in webview messages.

### Webview message protocol (`notesView.ts` <-> `media/main.js`)

Host -> webview: `load {key, kind, title, detail, content, locked}`, `meta {key, kind, title, detail}`,
`external {key, content}` (file changed on disk; applied only if the webview has no unsaved typing),
`append {key, block}` (captured text: appended to what the webview shows, unsaved typing included, then saved),
`locked {locked}`, `flush {id}`, `togglePreview`.

Webview -> host: `ready` (host replies with `load` of the current state), `save {key, content}`,
`flushed {id}`.

The webview remembers only the editor/preview mode (`vscode.setState({mode})`). It is registered with
`retainContextWhenHidden: true`. `flush()` waits at most 1 s for `flushed`.

### Invariants: do not break these

- **Every save carries its key.** A debounced save can arrive after the host switched notes; without
  the key it would overwrite the wrong note.
- **Flush before switching or merging.** `switchTo`, `deleteCurrent`, `onRenamed` and `openNoteFile` call
  `flush()` first.
- **An empty (whitespace-only) note has no file.** `NoteStore.write('')` deletes it, so focusing files
  never litters the disk. `openNoteFile` creates an empty file only so it can be opened.
- **Writes to one file are serialized** (`NoteStore.enqueue`). `isOwnWrite()` lets the watcher ignore echoes
  of our own writes.
- **Focusing a tab with no note keeps the current note.** Users click into the notes view constantly, and
  that must never blank it.

## Note storage

`notePaths.ts`. A notes root per workspace folder:

- setting `sidebarFileNotes.notesDirectory` relative (default `.notes`) -> `<folder>/<setting>`;
- absolute or `~/...` -> `<setting>/<encoded folder path>` (encoding = `projectDirName`, same as Claude Code's);
- no workspace open -> `<globalStorage>/no-workspace`.

Inside a root:

```
files/<path relative to the folder>.md   file notes
external/<encoded absolute path>.md      files outside all workspace folders (stored in the first folder's root)
claude/<sessionId>.md                    Claude conversation notes (root of the folder whose transcript dir matched)
claude/.pending/<uuid>.md                notes of a conversation not identified yet (always in the default root)
```

The default root is the first workspace folder's root. Renames inside VS Code (`onDidRenameFiles`) move
`files/<old>.md` and, for folders, the `files/<old>/` directory; the move is skipped if the destination exists.
Deleted files keep their notes (orphans are intentional).

## Claude Code integration: how it works and what it depends on

This is the fragile part. It relies on **undocumented internals of the Claude Code VS Code extension**,
checked against `anthropic.claude-code` **2.1.332** (Linux), with VS Code 1.146.0.

### What another extension can see

- Conversation editor tabs are webview panels created with
  `createWebviewPanel("claudeVSCodePanel", ...)`. In the Tab API this shows up as `TabInputWebview` whose
  `viewType` contains `claudeVSCodePanel` (VS Code may prefix it; Claude Code itself checks with
  `.includes`). `claudePlanPreview` panels are a different type and are ignored.
- The **session id is not exposed**. The only per-conversation information is `tab.label`, which is the
  conversation title:
  - placeholder `"Claude Code"` before the conversation has a title;
  - when a tab is created: the title truncated to 24 characters plus `…` if longer than 25 (`Ppe()` in their bundle);
  - on rename (`rename_tab` message): the title truncated to 200 code points, no ellipsis (`Ju()`/`hk()`).
- Claude Code's own title precedence for a session: `custom-title` > `ai-title` > `last-prompt` (then summary
  or first prompt).
- The Claude Code **sidebar** view (`claudeVSCodeSidebar*`) and the **CLI in a terminal** are not tabs that
  identify a conversation, so they are unsupported (they keep the current note).
- One panel can start a new conversation (the label goes back to the placeholder).

### Transcripts

`<configDir>/projects/<projectDirName(cwd)>/<sessionId>.jsonl`, where `configDir` is the setting
`sidebarFileNotes.claudeCode.configDir`, else `$CLAUDE_CONFIG_DIR`, else `~/.claude`, and
`projectDirName(p) = p.replace(/[^a-zA-Z0-9]/g, '-')`. (Claude Code truncates and hashes very long paths;
not handled, but the fallback search below covers it.) Relevant JSONL records, appended over time:

```json
{"type":"ai-title","aiTitle":"...","sessionId":"..."}
{"type":"custom-title","customTitle":"...","sessionId":"..."}      // written on user rename
{"type":"last-prompt","lastPrompt":"... (truncated with …)","leafUuid":"...","sessionId":"..."}
```

Subagent transcripts live in subfolders and are not scanned (only top-level `*.jsonl`).

### `ClaudeSessionIndex` (`claudeSessions.ts`)

- `find(label, {projectPaths, exclude})`: scans the transcript dirs of the workspace folders first; if
  nothing matches, every other project dir, skipping transcripts older than 30 days that are not cached.
- Reads incrementally: per file it caches `size`, `mtimeMs` and the byte `offset` after the last complete
  line, and only reads appended bytes. It splits on `\n` bytes (safe in UTF-8), skips lines over 64 KB
  without buffering them, and pre-filters with `Buffer.includes` before `JSON.parse`. A top-level `type`
  check makes look-alike strings inside messages harmless.
- Scoring: `matchScore` = 3 equal (whitespace-normalized), 2 if one is a truncation of the other (ignoring a
  trailing `…`/`...`, min 3 chars), 0 otherwise. `sessionScore` = 10x the match against the current display
  title, or 10x-5 against any older title kind. Best score wins, then newest mtime; sessions attached to other
  open tabs (`exclude`) are used only if nothing else matches.

### `TargetResolver.forClaudeTab` (`targets.ts`)

- `WeakMap<Tab, sessionId>` and `WeakMap<Tab, pendingId>`. This relies on VS Code reusing the same `Tab`
  object for a tab's lifetime and `label` being a live getter. Verified in VS Code 1.146's extension host
  (`_reconcileTabs` reuses tabs by id; `apiObject` is cached). Moving a tab to another group creates a new
  object.
- Placeholder label -> forget the tab's session, return a `claude-pending` target (new uuid per tab).
- Known session still matching strongly (score >= 20) -> keep it. Otherwise look the label up again; if
  nothing matches but the tab had a session, keep it and mark `unsettled` (likely a rename the
  transcript has not recorded yet).
- Resolving a tab that has a pending note sets `migrateFrom`; the controller merges it (appending to an
  existing note) and then calls `pendingMerged(tab)`. The mapping is cleared only after the merge, so a
  discarded refresh cannot lose it.
- `unsettled` targets (pending, or kept-after-mismatch) are re-resolved every 3 s while focused.

### Capturing a conversation selection (`capture.ts`)

Command `sidebarFileNotes.addSelection`. The conversation webview's DOM and selection are not reachable from
another extension, but VS Code (1.146 workbench, `webview.contribution`) overrides
`editor.action.clipboardCopyAction` to call `copy()` on the focused webview, also when run from a context
menu item. So: save the clipboard text, write a random marker, run Copy, poll the clipboard (750 ms) until it
differs from the marker, restore the saved text. If nothing changed, it runs
`workbench.action.focusActiveEditorGroup` (the webview keeps its selection) and tries once more. Unchanged
clipboard = nothing selected. Non-text clipboard contents are lost (restored as text only).

- Entry points: `webview/context` menu with `webviewId =~ /claudeVSCodePanel/` (Claude Code does not block
  the context menu nor set `preventDefaultContextMenuItems`), `editor/context`, and keybinding `alt+n`
  (`cmd+alt+n` on macOS) gated on `activeWebviewPanelId =~ /claudeVSCodePanel/ && !focusedView ...`.
  Both context keys hold the unprefixed view type (`providedViewType`).
- If the active tab is a Claude tab it captures from the webview, else from `activeTextEditor`
  (code block under `path:line`). `NotesController.append` runs in the `switching` chain; the view appends
  (`append` message) or, if the webview is not resolved, the controller writes the file.
- Not yet verified live: the focus timing of the context-menu path, and whether copy from Claude's
  rendered markdown gives sensible plain text.

### Re-verifying after a Claude Code update

If conversation notes stop working, check these in the installed extension
(`~/.vscode/extensions/anthropic.claude-code-*/extension.js`, minified):

```sh
E=$(ls -d ~/.vscode/extensions/anthropic.claude-code-* | sort -V | tail -1)/extension.js
grep -oE 'createWebviewPanel\("[a-zA-Z]+"' "$E" | sort -u        # panel viewType still claudeVSCodePanel?
grep -oE 'function Ppe\(e\)\{.{0,120}' "$E"                       # tab title truncation, placeholder
grep -oE '"custom-title":"customTitle","ai-title":"aiTitle"' "$E" # title record names
grep -h '"type":"ai-title"' ~/.claude/projects/*/*.jsonl | head -3  # transcript record shape
grep -c 'preventDefaultContextMenuItems\|data-vscode-context' "$(dirname "$E")/webview/index.js"  # 0: our context menu item still shows
```

Then a quick end-to-end check of matching against real transcripts:

```sh
npm test >/dev/null && node -e "
const {ClaudeSessionIndex}=require('./out/claudeSessions.js');
new ClaudeSessionIndex().find(process.argv[1],{projectPaths:[process.cwd()]}).then(s=>console.log(s))" "<a tab label>"
```

## Settings and commands

Settings (`sidebarFileNotes.*`): `notesDirectory` (`.notes`), `claudeCode.enabled` (`true`),
`claudeCode.configDir` (empty), `leftMargin` (`false`).

Commands: `togglePreview`, `lock` / `unlock` (context key `sidebarFileNotes.locked` swaps the title-bar icon),
`openNoteFile`, `deleteNote` (modal confirm), `revealNotesFolder`. All are in the view title bar (`navigation`
group) or its `…` menu (`more` group). `addSelection` is in the Claude conversation and editor context
menus and bound to `alt+n` / `cmd+alt+n`.

## Webview details

- Markdown: `marked` pinned to **12.0.2** on purpose. Its renderer overrides use the positional signature
  (`checkbox(checked)`, `list(body, ordered, start)`); marked 13+ passes token objects instead, so
  upgrading means rewriting the renderer. Output goes through DOMPurify 3.
- Checkboxes in the preview are clickable: the n-th rendered checkbox flips the n-th task marker in the
  source (`media/tasks.js`, skipping fenced code), so duplicate task text works. Upstream used string
  replacement, which broke on duplicates.
- Double-click the preview to edit; Tab inserts two spaces via `execCommand('insertText')` (keeps undo).
- CSP: scripts by nonce only; images allowed from the webview source, `https:` and `data:`.

## Testing

- `npm test` covers `claudeSessions.ts` (matching, incremental reads, partial and huge lines, exclusion,
  fallback, placeholder), `notePaths.ts`, `noteStore.ts` (ordering, deletion when empty, merge, rename) and
  `toggleTask`. Tests use temp dirs under `os.tmpdir()`.
- There is no integration test with a real VS Code. The upstream `vscode-test` scaffold was removed.
  Adding `@vscode/test-electron` tests for `TargetResolver`/`NotesController` would be valuable; they need a
  display (xvfb was not available on the owner's machine, and launching VS Code on the owner's desktop
  without asking is intrusive).
- Manual check: F5 or install the `.vsix`, open files and Claude Code conversation tabs, and check that the
  header (kind badge, title, detail) and content follow. Type in a brand-new conversation before Claude replies
  and check the note moves to `claude/<sessionId>.md` once the title appears.

## Known limitations and ideas

- Claude Code sidebar and terminal CLI conversations cannot be identified (see above). A possible route is a
  Claude Code hook (e.g. `SessionStart` / `UserPromptSubmit`) writing the session id somewhere the extension
  reads, but it still would not know which one is focused.
- Two open conversations with the same title: the second gets the next-newest matching session.
- Orphaned `claude/.pending/*.md` remain if a conversation tab is closed before it ever gets a title.
- Notes of files outside VS Code renames/deletes are not moved or cleaned up.
- No migration of notes from the upstream extension (different extension id, notes were in webview state).
- Ideas: let Claude Code read/write the conversation note (it is a plain file at a predictable path); a
  command to list/search all notes; per-line or per-symbol notes; showing note presence as a file
  decoration in the Explorer.

## History of this work

1. Feasibility study of the upstream extension and of how Claude Code exposes conversations (it does not
   expose session ids; transcripts record titles).
2. Rewrite in this fork: per-target notes stored as files, the tab-following controller, Claude session
   resolution, pending-note migration, lock, open, delete and reveal commands, rename following, modernized
   toolchain (TypeScript 5, webpack 5, eslint 8 + prettier 3, `@vscode/vsce` 3, `@types/vscode` ~1.75,
   engine `^1.75.0`), vendored `media/lib` replaced by npm `marked`/`dompurify` bundled with webpack.
   Removed upstream features: multiple pages, status bar item, reset/export commands, lodash.
3. `extensionKind` is `["workspace"]`, so in remote setups the extension runs where the files and the
   Claude Code transcripts are. `virtualWorkspaces` are not supported (it uses Node `fs`).
