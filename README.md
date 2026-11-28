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
- **Add a selection to the note**: select text in a Claude Code conversation (or in a file) and press
  `Alt+N` (`Cmd+Alt+N` on macOS), or right-click and pick **Add Selection to Note**. Conversation text is
  added as a quote; file text as a code block under its `path:line` reference. It goes to the page shown if
  that page is a draft, otherwise to the current draft.
- **Add a selection to a new fork**: `Shift+Alt+N` (`Shift+Cmd+Alt+N` on macOS), or **Add Selection to New
  Fork** in the right-click menu. The selection becomes a new fork next to the page shown (next to the current
  draft if the page shown cannot be forked from), and the view stays where it is: park a side topic while
  you keep reading.
- **Pages, one per turn**, shown as a graph at the top of the view (see below).

## Pages: a history of your prompts, with forks

Each note is a sequence of pages. The intended use: draft your next prompt in the current page while you
read Claude's reply, paste it into the conversation, then press **Mark sent** (**Freeze** for file notes).
The page becomes read-only and a new empty draft follows it, so the note keeps a linear history of what you
sent.

When the conversation raises side threads, press **Fork**: it adds a sibling of the current draft in a lane
of its own. **Split…** does it in one go: each top-level list item (or top-level section) of the draft that
you pick becomes a fork. A fork can be:

- **handed off**: copied to the clipboard to start a new conversation. Open a new Claude Code
  conversation tab and its note offers **Start this conversation from a handoff**; its first page is
  then the handoff, and the two pages link to each other (click the link to see the other note);
- **dropped**, **reopened**, copied **to the draft**, or deleted.

The graph shows the turns from left to right (the main line on top, forks in lanes below). Click a page to
open it. ◀ ▶ go to the previous and next turn, ▲ ▼ to the sibling pages, ⇥ to the current draft. With the
graph focused, the arrow keys do the same. Long runs of sent pages fold into a numbered bubble; click it to
expand. **Edit anyway** unlocks a sent page until you leave it; **Undo sent** turns the latest sent page back
into a draft while nothing was written after it. Deleting a page always asks first, and for a page with pages
after it, whether to delete them too or attach them to its parent.

## Where notes are stored

By default in a `.notes` folder in each workspace folder:

```
.notes/
  files/src/extension.ts.pages/    note of src/extension.ts
  external/-etc-hosts.pages/       note of a file outside the workspace
  claude/<session-id>/             note of a Claude Code conversation
  claude/.pending/<id>/            note of a conversation that has no title yet (see below)
```

Each note folder holds one markdown file per page, named by its creation time. A page file starts with a
short header that places it in the note:

```markdown
---
parent: 20261127-143200-a1b2c3
state: sent
created: 2026-11-27T14:32:00.000Z
sentAt: 2026-11-27T14:40:12.000Z
---
The prompt, as markdown.
```

Add `.notes/` to your `.gitignore` if the notes are personal, or set `sidebarFileNotes.notesDirectory` to
an absolute path such as `~/notes` to keep them out of the repository (one subfolder per workspace folder).

An empty draft has no file: clearing a draft deletes it.

## How Claude Code conversations are recognized

The Claude Code extension does not tell other extensions which session a conversation tab shows; the only
visible detail is the tab label, which is the conversation title. Sidebar File Notes matches that label
against the titles recorded in Claude Code's session transcripts
(`~/.claude/projects/<project>/<session-id>.jsonl`) and keys the note by session id, so the note stays with
the conversation when it is renamed or reopened later.

Things to know:

- It works for conversations opened in **editor tabs**. The Claude Code sidebar view and the CLI running in
  a terminal do not reveal the conversation, so they keep whatever note was shown before.
- A new conversation is titled "Claude Code" until its first reply. Pages written before then are kept in
  `claude/.pending/` and moved into the session's note once the title appears.
- If two open conversations have exactly the same title, the second one gets the next-newest matching
  session; renaming one of them tells them apart.
- **Add Selection to Note** in a conversation reads the selection through the clipboard (Claude Code does not
  expose it otherwise): it runs Copy in the conversation, takes the text, then puts your clipboard text back.
  Formatting of the copied text (code blocks, lists) comes through as plain lines, and a clipboard holding an
  image or rich text comes back as plain text only.
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
- **Add Selection to Note** (`Alt+N`, `Cmd+Alt+N` on macOS): append the selection of the focused Claude Code
  conversation or editor to the current note.
- **Add Selection to New Fork** (`Shift+Alt+N`, `Shift+Cmd+Alt+N` on macOS): put the selection in a new fork
  without leaving the page shown.
- **Open Note File in Editor**: opens the file of the page shown.
- **Delete All Pages of This Note…**
- **Reveal Notes Folder**
- Page commands (also as buttons in the view): **Mark Page Sent and Start the Next One**, **Undo Mark Sent**,
  **Fork from the Latest Sent Page**, **Split Draft into Forks…**, **Hand Off Fork to a New Conversation**,
  **Copy Page**, **Delete Page…**, **Go to Previous/Next Turn**, **Go to Previous/Next Sibling Page**,
  **Go to Current Draft**. They have no default keys; bind them in Keyboard Shortcuts.

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
