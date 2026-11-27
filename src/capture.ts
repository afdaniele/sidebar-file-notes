/**
 * Reads the text selected in the focused Claude Code conversation or text editor.
 *
 * Another extension's webview cannot be inspected, but VS Code forwards its Copy command
 * (`editor.action.clipboardCopyAction`) to the focused webview, which copies its own selection. So the
 * selection of a conversation is read through the clipboard: put a marker on it, run Copy, wait for the
 * clipboard to change, then put the user's clipboard text back.
 */
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

import { codeBlock, quoteBlock } from './snippets';

const COPY_TIMEOUT_MS = 750;
const POLL_MS = 25;

/** The text selected in the focused webview, or undefined when nothing was selected (or it was not focused). */
export async function copyWebviewSelection(): Promise<string | undefined> {
  const clipboard = vscode.env.clipboard;
  const saved = await clipboard.readText();
  const marker = `sidebar-file-notes:${randomUUID()}`;
  try {
    const copied = await copyWithMarker(marker);
    if (copied !== undefined) {
      return copied;
    }
    // Run from a context menu, the webview may not have its focus back yet. Its selection survives the
    // focus change, so focus it and copy again.
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    return await copyWithMarker(marker);
  } finally {
    // Only text survives this round trip; an image or rich-text clipboard comes back as its plain text.
    await clipboard.writeText(saved);
  }
}

async function copyWithMarker(marker: string): Promise<string | undefined> {
  await vscode.env.clipboard.writeText(marker);
  await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
  // The webview copies asynchronously (a message to its frame, then execCommand there).
  const deadline = Date.now() + COPY_TIMEOUT_MS;
  for (;;) {
    const text = await vscode.env.clipboard.readText();
    if (text !== marker) {
      return text.trim() === '' ? undefined : text;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** The non-empty selections of a text editor as code blocks with their `path:line` reference. */
export function editorSelectionBlocks(editor: vscode.TextEditor): string[] {
  const doc = editor.document;
  const path = doc.uri.scheme === 'file' ? vscode.workspace.asRelativePath(doc.uri) : doc.uri.toString(true);
  return [...editor.selections]
    .filter((selection) => !selection.isEmpty)
    .sort((a, b) => a.start.compareTo(b.start))
    .map((selection) => {
      // A selection ending at the start of a line does not include that line.
      const end =
        selection.end.character === 0 && selection.end.line > selection.start.line
          ? selection.end.line - 1
          : selection.end.line;
      return codeBlock(doc.getText(selection), {
        path,
        startLine: selection.start.line + 1,
        endLine: end + 1,
        language: doc.languageId === 'plaintext' ? undefined : doc.languageId
      });
    });
}

/** The selection of a Claude Code conversation as a markdown quote, or undefined when nothing is selected. */
export async function conversationSelectionBlock(): Promise<string | undefined> {
  const text = await copyWebviewSelection();
  if (text === undefined) {
    return undefined;
  }
  const block = quoteBlock(text);
  return block === '' ? undefined : block;
}
