/**
 * Keeps the notes view on the note of the focused file or Claude Code conversation, and on one page of
 * it. Runs the page actions (mark sent, fork, hand off, delete, ...) and follows handoff links.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { splitItems, withoutItems } from './branches';
import { HandoffRegistry, handoffId } from './handoffs';
import { FILE_NOTE_SUFFIX, folderNotesPath, isInside, noteDirOfRef, noteRef } from './notePaths';
import { NoteStore } from './noteStore';
import { NotesViewProvider, SaveRequest, ViewModel } from './notesView';
import { PageNote } from './pageNote';
import {
  canUndoSent,
  Direction,
  forkParent,
  mainTip,
  neighbor,
  PageTree,
  pageModel,
  planDelete,
  realDescendants,
  siblingForkParent
} from './pageTree';
import { formatLink, pageTitle, parseLink } from './pages';
import { appendBlock } from './snippets';
import { NoteTarget, TargetResolver } from './targets';

const REFRESH_DELAY_MS = 50;
const UNSETTLED_RETRY_MS = 3000;
const WATCH_DELAY_MS = 100;

const DIRECTIONS: readonly string[] = ['back', 'forward', 'up', 'down', 'tip'];

/** The note and page the view shows. Mutated in place (the target's title can change). */
interface Current {
  target: NoteTarget;
  note: PageNote;
  pageId: string;
}

export class NotesController implements vscode.Disposable {
  private current?: Current;
  private locked = false;
  private refreshSeq = 0;
  private refreshTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private watchTimer?: NodeJS.Timeout;
  private watcher?: vscode.FileSystemWatcher;
  /** Notes seen while the extension runs, by folder; they hold the pages that exist only in memory. */
  private readonly notes = new Map<string, PageNote>();
  /** Page last shown per note folder, shown again when the note comes back. */
  private readonly lastPage = new Map<string, string>();
  /** Child last visited per `<note folder>#<page id>`, where "forward" goes. */
  private readonly preferredChild = new Map<string, string>();
  /** `<note folder>#<page id>` of the sent page the user chose to edit anyway. */
  private unlockedPage?: string;
  /** Note folders the view was given, so saves are only accepted for those. */
  private readonly issuedKeys = new Set<string>();
  /** Serializes switching notes and pages and running actions, so they never interleave. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly resolver: TargetResolver,
    private readonly store: NoteStore,
    private readonly view: NotesViewProvider,
    private readonly handoffs: HandoffRegistry
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
      view.onDidRequestSave((request) => void this.onSave(request)),
      view.onDidRequestAction(({ key, pageId, name, arg }) => void this.action(name, arg, { key, pageId }))
    );
    void vscode.commands.executeCommand('setContext', 'sidebarFileNotes.locked', false);
    this.scheduleRefresh();
  }

  get currentTarget(): NoteTarget | undefined {
    return this.current?.target;
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
      await this.store.idleUnder(this.current.note.dir);
    }
  }

  /**
   * Appends a markdown block to the page shown if it is a draft, else to the current draft of the note.
   * Queued behind any switch in progress, so it lands in the note the view ends up showing.
   */
  append(block: string): Promise<{ target: NoteTarget; toDraft: boolean } | undefined> {
    return this.run(async () => {
      const cur = this.current;
      if (!cur) {
        return undefined;
      }
      const tree = cur.note.tree();
      const shown = cur.note.get(cur.pageId);
      const intoShown = shown?.meta.state === 'draft';
      const page = intoShown ? shown : mainTip(tree)?.page;
      if (!page) {
        return undefined;
      }
      // The webview appends to what it shows, unsaved typing included, and saves the result.
      if (!(intoShown && this.view.append(cur.note.dir, page.id, block))) {
        await cur.note.setBody(page.id, appendBlock(page.body, block));
        if (intoShown) {
          this.view.externalChange(cur.note.dir, page.id, page.body);
        }
        await this.pushModel();
      }
      return { target: cur.target, toDraft: !intoShown };
    });
  }

  /**
   * Adds a markdown block as a new fork next to the page shown (see `siblingForkParent`), without leaving
   * that page. Undefined when there is no note; `fork` undefined when nothing was sent yet to fork from.
   */
  appendToNewFork(block: string): Promise<{ target: NoteTarget; fork?: string } | undefined> {
    return this.run(async () => {
      const cur = this.current;
      if (!cur) {
        return undefined;
      }
      const parent = siblingForkParent(cur.note.tree(), cur.pageId);
      if (parent === undefined) {
        return { target: cur.target };
      }
      const fork = await cur.note.createWith({ parent, fork: true, state: 'draft' }, appendBlock('', block));
      await this.pushModel();
      return { target: cur.target, fork: fork.id };
    });
  }

  /**
   * Runs a page action on the page shown. `from` is the page the webview showed when it asked; the action
   * is dropped if the view moved on since.
   */
  action(name: string, arg?: string, from?: { key: string; pageId: string }): Promise<void> {
    return this.run(async () => {
      await this.flush();
      const cur = this.current;
      if (!cur) {
        void vscode.window.showInformationMessage('Open a file or a Claude Code conversation first.');
        return;
      }
      if (from && (from.key !== cur.note.dir || from.pageId !== cur.pageId)) {
        return;
      }
      try {
        await this.perform(cur, name, arg);
      } catch (err) {
        void vscode.window.showErrorMessage(`Notes: ${(err as Error).message}`);
      }
    });
  }

  /** The file of the page shown, created if the page exists only in memory. */
  pageFileForEditing(): Promise<string | undefined> {
    return this.run(async () => {
      await this.flush();
      const cur = this.current;
      return cur ? cur.note.materialize(cur.pageId) : undefined;
    });
  }

  /** Deletes every page of the current note, after asking. */
  deleteNote(): Promise<void> {
    return this.run(async () => {
      await this.flush();
      const cur = this.current;
      if (!cur) {
        return;
      }
      const count = cur.note.realPages().length;
      const answer = await vscode.window.showWarningMessage(
        `Delete all ${count === 1 ? 'the page' : `${count} pages`} of the note of "${cur.target.title}"?`,
        { modal: true, detail: `${cur.note.dir}\n\nThis cannot be undone.` },
        'Delete'
      );
      if (answer !== 'Delete') {
        return;
      }
      await this.store.removeDir(cur.note.dir);
      await this.handoffs.remove(cur.note.dir);
      this.notes.delete(cur.note.dir);
      this.lastPage.delete(cur.note.dir);
      await this.doSwitch(cur.target);
    });
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
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    this.clearRetry();
    this.watcher?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  // ---- following the active tab ---------------------------------------------------------------------

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
    if (!force && !target.migrateFrom && this.current && target.noteDir === this.current.note.dir) {
      this.current.target = target;
      this.view.updateTarget(target);
      this.scheduleRetry(target);
      return;
    }
    await this.switchTo(target);
  }

  private switchTo(target: NoteTarget | undefined, pageId?: string): Promise<void> {
    return this.run(() => this.doSwitch(target, pageId));
  }

  /** Shows a note (on `pageId`, else the page last shown, else its current draft). Runs inside the queue. */
  private async doSwitch(target: NoteTarget | undefined, pageId?: string): Promise<void> {
    // Save what was typed in the previous page before the view shows another one.
    await this.flush();
    if (target?.migrateFrom) {
      await this.migrate(target.migrateFrom, target.noteDir);
      if (target.tab) {
        this.resolver.pendingMerged(target.tab);
      }
    }
    this.unlockedPage = undefined;
    if (!target) {
      this.current = undefined;
      this.watch(undefined);
      this.view.show({ content: '', locked: this.locked });
      return;
    }
    const note = this.noteFor(target.noteDir);
    await note.load();
    const tree = note.tree();
    const id =
      [pageId, this.lastPage.get(note.dir)].find((p): p is string => !!p && tree.nodes.has(p)) ??
      mainTip(tree)!.page.id;
    this.current = { target, note, pageId: id };
    this.issuedKeys.add(note.dir);
    this.watch(note);
    await this.show();
    this.scheduleRetry(target);
  }

  // ---- pages ----------------------------------------------------------------------------------------

  private noteFor(dir: string): PageNote {
    let note = this.notes.get(dir);
    if (!note) {
      note = new PageNote(dir, this.store);
      this.notes.set(dir, note);
    }
    return note;
  }

  /** Shows the current page, replacing what the webview shows. */
  private async show(focus = false): Promise<void> {
    const cur = this.current;
    if (!cur) {
      return;
    }
    const page = cur.note.get(cur.pageId);
    const model = await this.buildModel(cur);
    if (!page || !model) {
      return;
    }
    this.view.show({ target: cur.target, pageId: cur.pageId, content: page.body, model, locked: this.locked });
    if (focus) {
      this.view.focusEditor();
    }
  }

  /** Updates the graph and page bar without touching the editor. */
  private async pushModel(): Promise<void> {
    const cur = this.current;
    if (!cur) {
      return;
    }
    const model = await this.buildModel(cur);
    if (model && this.current === cur) {
      this.view.updateModel(cur.note.dir, cur.pageId, model);
    }
  }

  private async goTo(cur: Current, pageId: string, focus = false): Promise<void> {
    if (`${cur.note.dir}#${pageId}` !== this.unlockedPage) {
      this.unlockedPage = undefined;
    }
    cur.pageId = pageId;
    await this.show(focus);
  }

  private async buildModel(cur: Current): Promise<ViewModel | undefined> {
    const { note, pageId, target } = cur;
    const tree = note.tree();
    const node = tree.nodes.get(pageId);
    if (!node) {
      return undefined;
    }
    this.lastPage.set(note.dir, pageId);
    if (node.parent) {
      this.preferredChild.set(`${note.dir}#${node.parent.page.id}`, pageId);
    }
    const base = pageModel(tree, pageId, {
      unlocked: this.unlockedPage === `${note.dir}#${pageId}`,
      preferredChild: this.preferredChild.get(`${note.dir}#${pageId}`)
    })!;
    const page = node.page;
    const links: ViewModel['links'] = {};
    if (page.meta.from) {
      links.from = { label: await this.linkLabel(page.meta.from) };
    }
    if (page.meta.handoffTo) {
      links.handoffTo = { label: await this.linkLabel(page.meta.handoffTo) };
    } else if (page.meta.state === 'handed-off') {
      links.waiting = true;
    }
    const handoffs: ViewModel['handoffs'] = [];
    if (target.kind !== 'file' && !note.hasFiles) {
      for (const h of this.handoffs.list()) {
        if (h.noteDir !== note.dir && (await this.handoffIsWaiting(h.noteDir, h.pageId))) {
          handoffs.push({ id: handoffId(h), title: h.title, from: h.from });
        }
      }
    }
    return { ...base, links, handoffs, sendLabel: target.kind === 'file' ? 'Freeze' : 'Mark sent' };
  }

  private async perform(cur: Current, name: string, arg?: string): Promise<void> {
    const { note } = cur;
    const tree = note.tree();
    const node = tree.nodes.get(cur.pageId);
    if (!node) {
      return;
    }
    const page = node.page;
    const tip = mainTip(tree)!;
    if (DIRECTIONS.includes(name)) {
      const preferred = this.preferredChild.get(`${note.dir}#${page.id}`);
      const id = neighbor(tree, page.id, name as Direction, preferred);
      if (id) {
        await this.goTo(cur, id);
      }
      return;
    }
    switch (name) {
      case 'goto':
        if (arg && tree.nodes.has(arg) && arg !== page.id) {
          await this.goTo(cur, arg);
        }
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(page.body);
        vscode.window.setStatusBarMessage('$(copy) Page copied', 2000);
        return;
      case 'markSent': {
        if (tip !== node || page.meta.state !== 'draft') {
          return info('Only the current draft (the end of the main line) can be marked sent.');
        }
        if (page.body.trim() === '') {
          return info('This page is empty. Write the prompt first.');
        }
        await note.update(page.id, { state: 'sent', sentAt: new Date().toISOString() });
        await this.goTo(cur, mainTip(note.tree())!.page.id, true);
        return;
      }
      case 'undoSent': {
        if (!canUndoSent(tree, page.id)) {
          return info('Only the latest sent page can go back to draft, while nothing was written after it.');
        }
        await note.remove([tip.page.id]);
        await note.update(page.id, { state: 'draft', sentAt: null });
        await this.goTo(cur, page.id, true);
        return;
      }
      case 'fork': {
        const parent = forkParent(tree, page.id);
        if (parent === undefined) {
          return info('Forks start from the latest sent page.');
        }
        const fork = note.create({ parent, fork: true, state: 'draft' });
        await this.goTo(cur, fork.id, true);
        return;
      }
      case 'split':
        return this.split(cur, tree);
      case 'handOff': {
        if (node.cont || !node.parent || page.meta.state !== 'draft') {
          return info('Only a fork draft can be handed off.');
        }
        if (page.body.trim() === '') {
          return info('This fork is empty. Write the handoff first.');
        }
        await note.update(page.id, { state: 'handed-off' });
        await vscode.env.clipboard.writeText(page.body);
        await this.handoffs.add({
          noteDir: note.dir,
          pageId: page.id,
          title: pageTitle(page) || 'Handoff',
          from: cur.target.title,
          created: new Date().toISOString()
        });
        await this.show();
        void vscode.window.showInformationMessage(
          'Handoff copied to the clipboard. Open a new Claude Code conversation: its note offers to start from it.'
        );
        return;
      }
      case 'cancelHandOff':
        await note.update(page.id, { state: 'draft' });
        await this.handoffs.remove(note.dir, page.id);
        await this.show();
        return;
      case 'drop':
        await note.update(page.id, { state: 'dropped' });
        await this.handoffs.remove(note.dir, page.id);
        await this.show();
        return;
      case 'reopen':
        await note.update(page.id, { state: 'draft' });
        await this.show();
        return;
      case 'copyToDraft': {
        if (tip.page.meta.state !== 'draft' || tip === node) {
          return;
        }
        await note.setBody(tip.page.id, appendBlock(tip.page.body, page.body));
        vscode.window.setStatusBarMessage('$(note) Copied to the current draft', 3000);
        await this.pushModel();
        return;
      }
      case 'editAnyway':
        this.unlockedPage = `${note.dir}#${page.id}`;
        await this.show(true);
        return;
      case 'delete':
        return this.deletePage(cur, tree);
      case 'land':
        return this.land(cur, arg);
      case 'openLink':
        return this.openLink(arg === 'from' ? page.meta.from : page.meta.handoffTo);
    }
  }

  /** Splits the current draft's top-level sections or list items into forks, one per item picked. */
  private async split(cur: Current, tree: PageTree): Promise<void> {
    const tip = mainTip(tree)!;
    const parent = forkParent(tree, tip.page.id);
    if (tip.page.id !== cur.pageId || parent === undefined) {
      return info('Split works on the current draft, once a page was sent.');
    }
    const body = tip.page.body;
    const items = splitItems(body);
    if (items.length === 0) {
      return info('Nothing to split: the draft has no top-level list items or headings.');
    }
    const picks = await vscode.window.showQuickPick(
      items.map((item) => ({
        label: item.title || '(untitled)',
        description: `${item.end - item.start} line${item.end - item.start === 1 ? '' : 's'}`,
        picked: true,
        item
      })),
      { canPickMany: true, title: 'Split into forks', placeHolder: 'Each item picked becomes a fork' }
    );
    if (!picks || picks.length === 0) {
      return;
    }
    // The draft may have changed while the pick was open.
    if (cur.note.get(tip.page.id)?.body !== body) {
      return info('The draft changed meanwhile. Split again.');
    }
    for (const { item } of picks) {
      await cur.note.createWith({ parent, fork: true, state: 'draft' }, item.body);
    }
    await cur.note.setBody(
      tip.page.id,
      withoutItems(
        body,
        picks.map((p) => p.item)
      )
    );
    await this.goTo(cur, tip.page.id, true);
    vscode.window.setStatusBarMessage(`$(git-branch) ${picks.length} fork${picks.length === 1 ? '' : 's'} made`, 3000);
  }

  private async deletePage(cur: Current, tree: PageTree): Promise<void> {
    const node = tree.nodes.get(cur.pageId)!;
    const page = node.page;
    if (page.virtual && !page.meta.fork) {
      return info('The current draft is empty; there is nothing to delete.');
    }
    const title = pageTitle(page) || 'this empty page';
    const descendants = realDescendants(node);
    const subtree = 'Delete with Its Subtree';
    const keep = 'Delete, Keep Its Children';
    const buttons = descendants > 0 ? [subtree, keep] : ['Delete'];
    const answer = await vscode.window.showWarningMessage(
      `Delete "${title}"?`,
      {
        modal: true,
        detail:
          descendants > 0
            ? `It has ${descendants} page${descendants === 1 ? '' : 's'} after it. Keeping them attaches them to its parent. This cannot be undone.`
            : 'This cannot be undone.'
      },
      ...buttons
    );
    if (!answer) {
      return;
    }
    const plan = planDelete(tree, page.id, answer === keep ? 'keepChildren' : 'subtree');
    for (const id of plan.remove) {
      await this.handoffs.remove(cur.note.dir, id);
    }
    await cur.note.apply(plan);
    // Deleting the current draft or a fork lands on the (new) current draft, anything else on its parent.
    const after = cur.note.tree();
    const parentId = node.parent?.page.id;
    const toParent = !page.meta.fork && mainTip(tree) !== node && parentId && after.nodes.has(parentId);
    await this.goTo(cur, toParent ? parentId : mainTip(after)!.page.id);
  }

  /** Starts this (empty) conversation note from a handoff: its first page is the handoff, marked sent. */
  private async land(cur: Current, id: string | undefined): Promise<void> {
    const handoff = this.handoffs.list().find((h) => handoffId(h) === id);
    if (!handoff || cur.note.hasFiles) {
      return;
    }
    const source = this.noteFor(handoff.noteDir);
    await source.load();
    const from = source.get(handoff.pageId);
    if (!from || from.meta.state !== 'handed-off' || from.meta.handoffTo) {
      await this.handoffs.remove(handoff.noteDir, handoff.pageId);
      await this.show();
      return info('That handoff is no longer waiting.');
    }
    const fromRef = this.refOf(handoff.noteDir);
    const hereRef = this.refOf(cur.note.dir);
    if (fromRef === undefined || hereRef === undefined) {
      return info('Cannot link notes outside the notes folders in use.');
    }
    const now = new Date().toISOString();
    const root = await cur.note.createWith(
      { state: 'sent', sentAt: now, from: formatLink(fromRef, handoff.pageId) },
      from.body
    );
    if (cur.target.kind === 'claude') {
      await source.update(handoff.pageId, { handoffTo: formatLink(hereRef, root.id) });
    }
    // A pending note gets linked back once it moves to its session (see `migrate`).
    await this.handoffs.remove(handoff.noteDir, handoff.pageId);
    await this.goTo(cur, mainTip(cur.note.tree())!.page.id, true);
  }

  /** Shows the note a link points to, locked so it stays while the focused tab has another note. */
  private async openLink(link: string | undefined): Promise<void> {
    const resolved = link ? await this.resolveLink(link) : undefined;
    const target = resolved && (await this.resolver.forNoteDir(resolved.dir));
    if (!resolved || !target) {
      return info('The linked note is not available.');
    }
    this.setLocked(true);
    await this.doSwitch(target, resolved.pageId);
  }

  // ---- saving and watching --------------------------------------------------------------------------

  private async onSave({ key, pageId, content }: SaveRequest): Promise<void> {
    if (!this.issuedKeys.has(key)) {
      return;
    }
    const note = this.notes.get(key);
    const page = note?.get(pageId);
    if (!note || !page || page.body === content) {
      return;
    }
    if (page.meta.state !== 'draft' && this.unlockedPage !== `${key}#${pageId}`) {
      return; // Read-only: sent, handed off or dropped.
    }
    const wasVirtual = page.virtual;
    const wasEmpty = page.body.trim() === '';
    try {
      await note.setBody(pageId, content);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Could not save the note page ${note.fileOf(pageId)}: ${(err as Error).message}`
      );
      return;
    }
    if (this.current?.note === note && (wasVirtual !== page.virtual || wasEmpty !== (content.trim() === ''))) {
      await this.pushModel();
    }
  }

  /** Reloads the note when its files are changed by something else, e.g. a page edited in an editor tab. */
  private watch(note: PageNote | undefined): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    if (!note) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(note.dir), '*.md')
    );
    const onEvent = (uri: vscode.Uri) => void this.onFileEvent(note, uri.fsPath);
    watcher.onDidChange(onEvent);
    watcher.onDidCreate(onEvent);
    watcher.onDidDelete(onEvent);
    this.watcher = watcher;
  }

  private async onFileEvent(note: PageNote, file: string): Promise<void> {
    const text = await this.store.read(file);
    if (this.store.isOwnWrite(file, text)) {
      return;
    }
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined;
      void this.run(() => this.reloadFromDisk(note));
    }, WATCH_DELAY_MS);
  }

  private async reloadFromDisk(note: PageNote): Promise<void> {
    const cur = this.current;
    if (!cur || cur.note !== note) {
      return;
    }
    const before = note.get(cur.pageId)?.body;
    await note.load();
    const tree = note.tree();
    if (!tree.nodes.has(cur.pageId)) {
      await this.goTo(cur, mainTip(tree)!.page.id);
      return;
    }
    const page = note.get(cur.pageId)!;
    if (page.body !== before) {
      this.view.externalChange(note.dir, page.id, page.body);
    }
    await this.pushModel();
  }

  // ---- moving notes ---------------------------------------------------------------------------------

  /** Moves the pages of a pending conversation note to its session note, and fixes handoff links. */
  private async migrate(fromDir: string, toDir: string): Promise<void> {
    const moved = await this.store.moveFiles(fromDir, toDir);
    const last = this.lastPage.get(fromDir);
    if (last && !this.lastPage.has(toDir)) {
      this.lastPage.set(toDir, last);
    }
    this.notes.delete(fromDir);
    await this.handoffs.moveNote(fromDir, toDir);
    const ref = this.refOf(toDir);
    if (moved.length === 0 || ref === undefined) {
      return;
    }
    const note = this.noteFor(toDir);
    await note.load();
    for (const name of moved) {
      const page = note.get(path.basename(name, '.md'));
      if (!page) {
        continue;
      }
      if (page.meta.from) {
        await this.updateLinked(page.meta.from, { handoffTo: formatLink(ref, page.id) });
      }
      if (page.meta.handoffTo) {
        await this.updateLinked(page.meta.handoffTo, { from: formatLink(ref, page.id) });
      }
    }
  }

  private async updateLinked(link: string, patch: { handoffTo?: string; from?: string }): Promise<void> {
    const resolved = await this.resolveLink(link);
    if (!resolved) {
      return;
    }
    const other = this.noteFor(resolved.dir);
    await other.load();
    await other.update(resolved.pageId, patch);
  }

  /** Notes follow their files (and folders) when they are renamed or moved in VS Code. */
  private async onRenamed(event: vscode.FileRenameEvent): Promise<void> {
    await this.run(async () => {
      await this.flush();
      let moved = false;
      for (const { oldUri, newUri } of event.files) {
        const from = this.resolver.forUri(oldUri);
        const to = this.resolver.forUri(newUri);
        if (!from || !to) {
          continue;
        }
        try {
          if (await this.store.rename(from.noteDir, to.noteDir)) {
            moved = true;
            this.forgetNotesUnder(from.noteDir);
          }
          const fromFolder = folderOf(from);
          const toFolder = folderOf(to);
          if (fromFolder && toFolder && (await this.store.rename(fromFolder, toFolder))) {
            moved = true;
            this.forgetNotesUnder(fromFolder);
          }
        } catch (err) {
          console.error('[sidebar-file-notes] failed to move notes of a renamed file', err);
        }
      }
      if (moved) {
        this.scheduleRefresh(true);
      }
    });
  }

  private forgetNotesUnder(dir: string): void {
    for (const key of [...this.notes.keys()]) {
      if (isInside(key, dir)) {
        this.notes.delete(key);
      }
    }
  }

  // ---- links ----------------------------------------------------------------------------------------

  private refOf(dir: string): string | undefined {
    const root = this.resolver.allRoots().find((r) => isInside(dir, r) && dir !== r);
    return root ? noteRef(root, dir) : undefined;
  }

  private async resolveLink(link: string): Promise<{ dir: string; pageId: string } | undefined> {
    const parsed = parseLink(link);
    if (!parsed) {
      return undefined;
    }
    for (const root of new Set(this.resolver.allRoots())) {
      const dir = noteDirOfRef(root, parsed.noteRef);
      if (await isDirectory(dir)) {
        return { dir, pageId: parsed.pageId };
      }
    }
    return undefined;
  }

  private async linkLabel(link: string): Promise<string> {
    const resolved = await this.resolveLink(link);
    const target = resolved && (await this.resolver.forNoteDir(resolved.dir));
    return target?.title ?? 'a note that is not available';
  }

  private async handoffIsWaiting(noteDir: string, pageId: string): Promise<boolean> {
    const note = this.noteFor(noteDir);
    await note.load();
    const page = note.get(pageId);
    return !!page && !page.virtual && page.meta.state === 'handed-off' && !page.meta.handoffTo;
  }

  // ---- plumbing -------------------------------------------------------------------------------------

  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
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
}

function info(message: string): void {
  void vscode.window.showInformationMessage(message);
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** The folder holding the notes of the files under the target's path, when it is a workspace file note. */
function folderOf(target: NoteTarget): string | undefined {
  const filesDir = path.join(target.root, 'files');
  if (!isInside(target.noteDir, filesDir) || !target.noteDir.endsWith(FILE_NOTE_SUFFIX)) {
    return undefined;
  }
  const rel = path.relative(filesDir, target.noteDir).slice(0, -FILE_NOTE_SUFFIX.length);
  return folderNotesPath(target.root, rel);
}
