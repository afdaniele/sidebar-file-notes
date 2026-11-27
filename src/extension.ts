import { promises as fs } from 'fs';
import * as vscode from 'vscode';

import { conversationSelectionBlock, editorSelectionBlocks } from './capture';
import { ClaudeSessionIndex, defaultClaudeConfigDir } from './claudeSessions';
import { expandHome, isInside } from './notePaths';
import { NotesController } from './notesController';
import { NoteStore } from './noteStore';
import { NotesViewProvider } from './notesView';
import { isClaudeTab, TargetResolver } from './targets';

export function activate(context: vscode.ExtensionContext) {
  const sessions = new ClaudeSessionIndex(() => {
    const configured = vscode.workspace.getConfiguration('sidebarFileNotes').get<string>('claudeCode.configDir', '');
    return configured.trim() ? expandHome(configured.trim()) : defaultClaudeConfigDir();
  });
  const resolver = new TargetResolver(sessions, context.globalStorageUri.fsPath);
  const store = new NoteStore();
  const view = new NotesViewProvider(context.extensionUri);
  const controller = new NotesController(resolver, store, view);

  context.subscriptions.push(
    view,
    controller,
    vscode.window.registerWebviewViewProvider(NotesViewProvider.viewId, view, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('sidebarFileNotes.togglePreview', () => view.togglePreview()),
    vscode.commands.registerCommand('sidebarFileNotes.lock', () => controller.setLocked(true)),
    vscode.commands.registerCommand('sidebarFileNotes.unlock', () => controller.setLocked(false)),
    vscode.commands.registerCommand('sidebarFileNotes.openNoteFile', async () => {
      const target = controller.currentTarget;
      if (!target) {
        return noNote();
      }
      await controller.flush();
      const uri = vscode.Uri.file(target.notePath);
      try {
        await fs.stat(target.notePath);
      } catch {
        // Notes are only written once they have content; create the file so it can be opened.
        await vscode.workspace.fs.writeFile(uri, new Uint8Array());
      }
      await vscode.window.showTextDocument(uri, { preview: false });
    }),
    vscode.commands.registerCommand('sidebarFileNotes.deleteNote', async () => {
      const target = controller.currentTarget;
      if (!target) {
        return noNote();
      }
      const answer = await vscode.window.showWarningMessage(
        `Delete the note of "${target.title}"?`,
        { modal: true, detail: target.notePath },
        'Delete'
      );
      if (answer === 'Delete') {
        await controller.deleteCurrent();
      }
    }),
    vscode.commands.registerCommand('sidebarFileNotes.addSelection', async () => {
      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      let blocks: string[];
      if (activeTab && isClaudeTab(activeTab)) {
        const block = await conversationSelectionBlock();
        blocks = block ? [block] : [];
      } else if (vscode.window.activeTextEditor) {
        blocks = editorSelectionBlocks(vscode.window.activeTextEditor);
      } else {
        blocks = [];
      }
      if (blocks.length === 0) {
        void vscode.window.showInformationMessage('Select text in a Claude Code conversation or in an editor first.');
        return;
      }
      const target = await controller.append(blocks.join('\n\n'));
      if (!target) {
        return noNote();
      }
      vscode.window.setStatusBarMessage(`$(note) Added to the note of ${target.title}`, 3000);
    }),
    vscode.commands.registerCommand('sidebarFileNotes.revealNotesFolder', async () => {
      const root = controller.currentTarget?.root ?? resolver.allRoots()[0];
      await fs.mkdir(root, { recursive: true });
      const uri = vscode.Uri.file(root);
      const inWorkspace = (vscode.workspace.workspaceFolders ?? []).some((f) => isInside(root, f.uri.fsPath));
      await vscode.commands.executeCommand(inWorkspace ? 'revealInExplorer' : 'revealFileInOS', uri);
    })
  );
}

export function deactivate() {}

function noNote() {
  void vscode.window.showInformationMessage('Open a file or a Claude Code conversation first.');
}
