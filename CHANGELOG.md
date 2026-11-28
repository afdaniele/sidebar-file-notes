
# Release Notes

## Unreleased

- **Pages.** Each note is now a tree of pages, one per turn: **Mark sent** freezes the page and starts the next
  draft; **Fork** and **Split…** add sibling branches; forks can be handed off to a new Claude Code
  conversation, which links back to them. A graph at the top of the view shows the pages; buttons, the graph
  and new commands move between them. Sent pages are read-only unless you choose **Edit anyway**.
- **Add Selection to New Fork** (`Shift+Alt+N`, `Shift+Cmd+Alt+N` on macOS, also in the right-click menus):
  the selection becomes a new fork next to the page shown, and the view stays on that page.
- **Breaking: new storage layout.** A note is now a folder with one markdown file per page
  (`files/<path>.pages/`, `claude/<session-id>/`). Notes stored as single `.md` files by earlier versions are
  not read anymore (they stay on disk).

- **Add Selection to Note** (`Alt+N`, also in the right-click menu of Claude Code conversations and editors):
  appends the selected conversation text as a quote, or the selected file text as a code block with its
  `path:line` reference.

## 2.0.0 (Sidebar File Notes)

Forked from sidebar-markdown-notes and reworked around per-target notes.

- Each file has its own note; the view follows the active editor tab.
- Each Claude Code conversation tab has its own note, keyed by session id.
- Notes are stored as markdown files (setting `sidebarFileNotes.notesDirectory`, default `.notes`).
- Lock a note to stop following the active tab.
- Open the note file in an editor, delete a note, reveal the notes folder.
- Notes follow files and folders renamed inside VS Code.
- Checkboxes toggle by position, so duplicate task text works.
- Tab indents in the editor.
- Removed the multiple pages feature, the status bar item and the reset/export commands.
- Updated marked and DOMPurify; requires VS Code 1.75 or newer.

## Previous releases (sidebar-markdown-notes)

## 1.0.4

- Added the `sidebar-markdown-notes.leftMargin` setting
- Changed background color from `--vscode-editor-background` to `--vscode-sideBar-background`
- Added the extension to [Open VSX Registry](https://open-vsx.org/)

## 1.0.3

- Fixed a bug where switching from preview/edit mode would not display anything

## 1.0.2

- Fixed a bug when loading saved nodes when switching pages

## 1.0.1

- Fixed a readme typo

## 1.0.0

- Initial Release 🎉
