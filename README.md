# Sidebar File Notes

Markdown notes in the sidebar that follow what you are looking at. Every file has its own note, and so
does every [Claude Code](https://code.claude.com) conversation: switch tabs and the notes switch with you.

A fork of [sidebar-markdown-notes](https://github.com/AssisrMatheus/sidebar-markdown-notes) by Matheus Assis Rios.

## Features

- **One note per file.** Focus a file (text editor, diff, notebook or custom editor) and the **Notes**
  view in the Explorer shows its note.
- **One note per Claude Code conversation.** Focus a Claude Code conversation tab and the view shows that
  conversation's note, so you can keep notes beside the chat.
- **Notes stay put** when you focus anything else (terminal, settings, the notes view itself).
- **Lock** a note (lock icon in the view title) to keep it on screen while you move around.
- Markdown preview with GitHub Flavored Markdown and clickable task-list checkboxes.
- Notes are plain `.md` files: open one in an editor (go-to-file icon), grep them, commit them or ignore them.
- Notes follow files and folders renamed or moved inside VS Code.

## Where notes are stored

By default in a `.notes` folder in each workspace folder:

```
.notes/
  files/src/extension.ts.md        note of src/extension.ts
  external/-etc-hosts.md           note of a file outside the workspace
  claude/<session-id>.md           note of a Claude Code conversation
  claude/.pending/<id>.md          note of a conversation that has no title yet (see below)
```

Add `.notes/` to your `.gitignore` if the notes are personal, or set `sidebarFileNotes.notesDirectory` to
an absolute path such as `~/notes` to keep them out of the repository (one subfolder per workspace folder).

An empty note has no file: clearing a note deletes it.

## How Claude Code conversations are recognized

The Claude Code extension does not tell other extensions which session a conversation tab shows; the only
visible detail is the tab label, which is the conversation title. Sidebar File Notes matches that label
against the titles recorded in Claude Code's session transcripts
(`~/.claude/projects/<project>/<session-id>.jsonl`) and keys the note by session id, so the note stays with
the conversation when it is renamed or reopened later.

Things to know:

- It works for conversations opened in **editor tabs**. The Claude Code sidebar view and the CLI running in
  a terminal do not reveal the conversation, so they keep whatever note was shown before.
- A new conversation is titled "Claude Code" until its first reply. Notes typed before then are kept in
  `claude/.pending/` and moved into the session's note once the title appears.
- If two open conversations have exactly the same title, the second one gets the next-newest matching
  session; renaming one of them tells them apart.
- This relies on undocumented details of Claude Code (the tab's webview type and the transcript format), so
  a Claude Code update could break it. File notes are unaffected.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `sidebarFileNotes.notesDirectory` | `.notes` | Relative to each workspace folder, or an absolute / `~` path for all workspaces. |
| `sidebarFileNotes.claudeCode.enabled` | `true` | Give each Claude Code conversation tab its own note. |
| `sidebarFileNotes.claudeCode.configDir` | (empty) | Claude Code config directory; empty means `$CLAUDE_CONFIG_DIR` or `~/.claude`. |
| `sidebarFileNotes.leftMargin` | `false` | Add a left margin to align the view with other sidebar content. |

## Commands

- **Toggle Preview**: switch between editing and the rendered markdown (double-click the preview to edit).
- **Lock to Current Note** / **Unlock**: stop or resume following the active tab.
- **Open Note File in Editor**
- **Delete Current Note**
- **Reveal Notes Folder**

## Development

```sh
npm install
npm test          # unit tests
npm run lint
npm run build     # or: npm run watch, then F5 to launch an Extension Development Host
npx vsce package  # builds sidebar-file-notes-<version>.vsix
```

---

Icons made by <a href="https://www.flaticon.com/authors/freepik" title="Freepik">Freepik</a> from <a href="https://www.flaticon.com/" title="Flaticon"> www.flaticon.com</a>
