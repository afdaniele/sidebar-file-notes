/**
 * Keeps the notes view on the note of the focused file or Claude Code conversation.
 */
import * as path from 'path';
import * as vscode from 'vscode';

import { folderNotesPath, isInside } from './notePaths';
import { NoteStore } from './noteStore';
import { NotesViewProvider, SaveRequest } from './notesView';
import { appendBlock } from './snippets';
import { NoteTarget, TargetResolver } from './targets';

const REFRESH_DELAY_MS = 50;
const UNSETTLED_RETRY_MS = 3000;

export class NotesController implements vscode.Disposable {
  private current?: NoteTarget;
  private locked = false;
  private refreshSeq = 0;
  private refreshTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private watcher?: vscode.FileSystemWatcher;
  /** Note files the view was given, so saves are only accepted for those. */
  private readonly issuedKeys = new Set<string>();
  /** Serializes switching notes, so two switches never interleave. */
  private switching: Promise<void> = Promise.resolve();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly resolver: TargetResolver,
    private readonly store: NoteStore,
    private readonly view: NotesViewProvider
  ) {
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs(() => this.scheduleRefresh()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('sidebarFileNotes.notesDirectory') ||
          e.affectsConfiguration('sidebarFileNotes.claudeCode')
        ) {
          this.scheduleRefresh(true);
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh(true)),
      vscode.workspace.onDidRenameFiles((e) => void this.onRenamed(e)),
      view.onDidRequestSave((request) => void this.onSave(request))
    );
    void vscode.commands.executeCommand('setContext', 'sidebarFileNotes.locked', false);
    this.scheduleRefresh();
  }

  get currentTarget(): NoteTarget | undefined {
    return this.current;
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
    void vscode.commands.executeCommand('setContext', 'sidebarFileNotes.locked', locked);
    this.view.setLocked(locked);
    if (!locked) {
      this.scheduleRefresh();
    }
  }

  /** Saves typing the view has not sent yet, and waits until the current note is written. */
  async flush(): Promise<void> {
    await this.view.flush();
    if (this.current) {
      await this.store.idle(this.current.notePath);
    }
  }

  /**
   * Appends a markdown block to the current note and returns that note, or undefined when there is none.
   * Queued behind any note switch in progress, so it lands in the note the view ends up showing.
   */
  append(block: string): Promise<NoteTarget | undefined> {
    const run = async () => {
      const target = this.current;
      if (!target) {
        return undefined;
      }
      // The webview appends to what it shows, unsaved typing included, and saves the result.
      if (!this.view.append(target.notePath, block)) {
        const content = appendBlock(await this.store.read(target.notePath), block);
        await this.store.write(target.notePath, content);
        this.view.externalChange(target.notePath, content);
      }
      return target;
    };
    const result = this.switching.then(run, run);
    this.switching = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async deleteCurrent(): Promise<void> {
    const target = this.current;
    if (!target) {
      return;
    }
    await this.flush();
    await this.store.write(target.notePath, '');
    this.view.show({ target, content: '', locked: this.locked });
  }

  scheduleRefresh(force = false): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh(force);
    }, REFRESH_DELAY_MS);
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.clearRetry();
    this.watcher?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  private async refresh(force: boolean): Promise<void> {
    if (this.locked) {
      return;
    }
    const seq = ++this.refreshSeq;
    let target: NoteTarget | undefined;
    try {
      target = await this.resolver.forTab(vscode.window.tabGroups.activeTabGroup.activeTab);
    } catch (err) {
      console.error('[sidebar-file-notes] failed to resolve the active tab', err);
      return;
    }
    if (seq !== this.refreshSeq || this.locked) {
      return; // A newer refresh superseded this one.
    }
    if (!target) {
      if (force && this.current) {
        // Settings changed and the focused tab has no note: the shown note may no longer be valid.
        await this.switchTo(undefined);
      }
      return;
    }
    if (!force && !target.migrateFrom && target.notePath === this.current?.notePath) {
      this.current = target;
      this.view.updateTarget(target);
      this.scheduleRetry(target);
      return;
    }
    await this.switchTo(target);
  }

  private switchTo(target: NoteTarget | undefined): Promise<void> {
    const run = async () => {
      // Save what was typed in the previous note before the view shows another one.
      await this.flush();
      if (target?.migrateFrom) {
        await this.store.merge(target.migrateFrom, target.notePath);
        if (target.tab) {
          this.resolver.pendingMerged(target.tab);
        }
      }
      const content = target ? await this.store.read(target.notePath) : '';
      this.current = target;
      if (target) {
        this.issuedKeys.add(target.notePath);
      }
      this.watch(target);
      this.view.show({ target, content, locked: this.locked });
      this.scheduleRetry(target);
    };
    this.switching = this.switching.then(run, run);
    return this.switching;
  }

  private async onSave({ key, content }: SaveRequest): Promise<void> {
    if (!this.issuedKeys.has(key)) {
      return;
    }
    try {
      await this.store.write(key, content);
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not save the note ${key}: ${(err as Error).message}`);
    }
  }

  /** Reloads the note when its file is changed by something else, e.g. edited in an editor tab. */
  private watch(target: NoteTarget | undefined): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    if (!target) {
      return;
    }
    const notePath = target.notePath;
    const pattern = new vscode.RelativePattern(vscode.Uri.file(path.dirname(notePath)), path.basename(notePath));
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const reload = async () => {
      const content = await this.store.read(notePath);
      if (this.current?.notePath === notePath && !this.store.isOwnWrite(notePath, content)) {
        this.view.externalChange(notePath, content);
      }
    };
    watcher.onDidChange(reload);
    watcher.onDidCreate(reload);
    watcher.onDidDelete(reload);
    this.watcher = watcher;
  }

  /** Conversations without a reliable session yet are resolved again until they have one. */
  private scheduleRetry(target: NoteTarget | undefined): void {
    this.clearRetry();
    if (target?.unsettled) {
      this.retryTimer = setTimeout(() => this.scheduleRefresh(), UNSETTLED_RETRY_MS);
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  /** Notes follow their files (and folders) when they are renamed or moved in VS Code. */
  private async onRenamed(event: vscode.FileRenameEvent): Promise<void> {
    await this.flush();
    let moved = false;
    for (const { oldUri, newUri } of event.files) {
      const from = this.resolver.forUri(oldUri);
      const to = this.resolver.forUri(newUri);
      if (!from || !to) {
        continue;
      }
      try {
        if (await this.store.rename(from.notePath, to.notePath)) {
          moved = true;
        }
        const fromFolder = folderOf(from);
        const toFolder = folderOf(to);
        if (fromFolder && toFolder && (await this.store.rename(fromFolder, toFolder))) {
          moved = true;
        }
      } catch (err) {
        console.error('[sidebar-file-notes] failed to move notes of a renamed file', err);
      }
    }
    if (moved) {
      this.scheduleRefresh(true);
    }
  }
}

/** The folder holding the notes of the files under the target's path, when it is a workspace file note. */
function folderOf(target: NoteTarget): string | undefined {
  const filesDir = path.join(target.root, 'files');
  if (!isInside(target.notePath, filesDir) || !target.notePath.endsWith('.md')) {
    return undefined;
  }
  const rel = path.relative(filesDir, target.notePath).slice(0, -'.md'.length);
  return folderNotesPath(target.root, rel);
}
