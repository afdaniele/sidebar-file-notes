import { promises as fs } from 'fs';
import * as vscode from 'vscode';

import { conversationSelectionBlock, editorSelectionBlocks } from './capture';
import { ClaudeSessionIndex, defaultClaudeConfigDir } from './claudeSessions';
import { HandoffRegistry } from './handoffs';
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
  const controller = new NotesController(resolver, store, view, new HandoffRegistry(context.workspaceState));

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
      // Empty pages only exist in memory; this gives the page a file so it can be opened.
      const file = await controller.pageFileForEditing();
      if (!file) {
        return noNote();
      }
      await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
    }),
    vscode.commands.registerCommand('sidebarFileNotes.deleteNote', async () => {
      if (!controller.currentTarget) {
        return noNote();
      }
      await controller.deleteNote();
    }),
    ...PAGE_COMMANDS.map(([command, action]) =>
      vscode.commands.registerCommand(`sidebarFileNotes.${command}`, () => controller.action(action))
    ),
    vscode.commands.registerCommand('sidebarFileNotes.addSelection', async () => {
      const block = await captureSelection();
      if (!block) {
        return;
      }
      const result = await controller.append(block);
      if (!result) {
        return noNote();
      }
      const where = result.toDraft ? 'the current draft of the note' : 'the note';
      vscode.window.setStatusBarMessage(`$(note) Added to ${where} of ${result.target.title}`, 3000);
    }),
    vscode.commands.registerCommand('sidebarFileNotes.addSelectionToNewFork', async () => {
      const block = await captureSelection();
      if (!block) {
        return;
      }
      const result = await controller.appendToNewFork(block);
      if (!result) {
        return noNote();
      }
      if (!result.fork) {
        void vscode.window.showInformationMessage('Forks start from a sent page: mark a page sent first.');
        return;
      }
      vscode.window.setStatusBarMessage(
        `$(git-branch) Added to a new fork in the note of ${result.target.title}`,
        3000
      );
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

/** The selection of the focused Claude Code conversation or editor as markdown, or undefined (after telling). */
async function captureSelection(): Promise<string | undefined> {
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
    return undefined;
  }
  return blocks.join('\n\n');
}

/** Commands that run a page action on the page shown: [command name, action]. */
const PAGE_COMMANDS: [string, string][] = [
  ['previousTurn', 'back'],
  ['nextTurn', 'forward'],
  ['previousSibling', 'up'],
  ['nextSibling', 'down'],
  ['goToDraft', 'tip'],
  ['markSent', 'markSent'],
  ['undoSent', 'undoSent'],
  ['fork', 'fork'],
  ['splitIntoForks', 'split'],
  ['handOff', 'handOff'],
  ['copyPage', 'copy'],
  ['deletePage', 'delete']
];

function noNote() {
  void vscode.window.showInformationMessage('Open a file or a Claude Code conversation first.');
}
