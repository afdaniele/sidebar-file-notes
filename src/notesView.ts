import * as vscode from 'vscode';

import type { PageModel } from './pageTree';
import type { NoteTarget } from './targets';

export interface LinkInfo {
  /** Title of the note linked to. */
  label: string;
}

/** The page model plus what the controller adds: links to other notes and handoffs to start from. */
export interface ViewModel extends PageModel {
  links: { from?: LinkInfo; handoffTo?: LinkInfo; waiting?: boolean };
  /** Handoffs this (empty) conversation note can start from. */
  handoffs: { id: string; title: string; from: string }[];
  /** Label of the "mark sent" action: "Mark sent" for conversations, "Freeze" for files. */
  sendLabel: string;
}

/** What the webview shows: a page of a note, or nothing when no file or conversation was focused yet. */
export interface ViewState {
  target?: NoteTarget;
  pageId?: string;
  content: string;
  model?: ViewModel;
  locked: boolean;
}

export interface SaveRequest {
  /** Note folder and page the content belongs to, as sent with `load`. */
  key: string;
  pageId: string;
  content: string;
}

export interface ActionRequest {
  key: string;
  pageId: string;
  name: string;
  arg?: string;
}

const FLUSH_TIMEOUT_MS = 1000;

export class NotesViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewId = 'sidebarFileNotes.view';

  private view?: vscode.WebviewView;
  private ready = false;
  private state: ViewState = { content: '', locked: false };
  private nextFlushId = 0;
  private readonly flushWaiters = new Map<number, () => void>();
  private readonly saveEmitter = new vscode.EventEmitter<SaveRequest>();
  private readonly actionEmitter = new vscode.EventEmitter<ActionRequest>();
  private readonly disposables: vscode.Disposable[] = [this.saveEmitter, this.actionEmitter];

  /** Fired when the webview has new content for a page. */
  readonly onDidRequestSave = this.saveEmitter.event;
  /** Fired when a button, the graph or a key in the webview asks for something done to the shown page. */
  readonly onDidRequestAction = this.actionEmitter.event;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.ready = false;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    webviewView.webview.html = this.html(webviewView.webview);
    this.applyDescription();

    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((message) => this.onMessage(message)),
      webviewView.onDidDispose(() => {
        this.view = undefined;
        this.ready = false;
        this.releaseFlushWaiters();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sidebarFileNotes.leftMargin') && this.view) {
          this.ready = false;
          this.view.webview.html = this.html(this.view.webview);
        }
      })
    );
  }

  /** Shows a page, replacing whatever the webview shows. */
  show(state: ViewState): void {
    this.state = state;
    this.applyDescription();
    this.post({ type: 'load', ...this.payload() });
  }

  /** Updates the title and description of the note being shown, keeping the editor as it is. */
  updateTarget(target: NoteTarget): void {
    if (this.state.target?.noteDir !== target.noteDir) {
      return;
    }
    this.state = { ...this.state, target };
    this.applyDescription();
    const { key, kind, title, detail } = this.payload();
    this.post({ type: 'meta', key, kind, title, detail });
  }

  /** Updates the graph and page bar of the page being shown, keeping the editor as it is. */
  updateModel(key: string, pageId: string, model: ViewModel): void {
    if (!this.shows(key, pageId)) {
      return;
    }
    this.state = { ...this.state, model };
    this.post({ type: 'model', key, pageId, model });
  }

  /** The page changed on disk; the webview takes it unless it has unsaved typing. */
  externalChange(key: string, pageId: string, content: string): void {
    if (this.shows(key, pageId)) {
      this.state = { ...this.state, content };
    }
    this.post({ type: 'external', key, pageId, content });
  }

  /**
   * Asks the webview to append a block to the page it shows and save it. Returns false when the webview
   * is not ready or shows another page, in which case the caller writes the page itself.
   */
  append(key: string, pageId: string, block: string): boolean {
    if (!this.view || !this.ready || !this.shows(key, pageId)) {
      return false;
    }
    this.post({ type: 'append', key, pageId, block });
    return true;
  }

  /** Moves the keyboard focus to the editor (after creating or opening a page from a button). */
  focusEditor(): void {
    this.post({ type: 'focusEditor' });
  }

  private shows(key: string, pageId: string): boolean {
    return this.state.target?.noteDir === key && this.state.pageId === pageId;
  }

  setLocked(locked: boolean): void {
    this.state = { ...this.state, locked };
    this.post({ type: 'locked', locked });
  }

  togglePreview(): void {
    this.post({ type: 'togglePreview' });
  }

  /** Asks the webview to send any typing it has not saved yet, and waits until it did. */
  flush(): Promise<void> {
    if (!this.view || !this.ready) {
      return Promise.resolve();
    }
    const id = this.nextFlushId++;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, FLUSH_TIMEOUT_MS);
      const waiters = this.flushWaiters;
      function done() {
        clearTimeout(timer);
        waiters.delete(id);
        resolve();
      }
      waiters.set(id, done);
      this.post({ type: 'flush', id });
    });
  }

  dispose(): void {
    this.releaseFlushWaiters();
    this.disposables.forEach((d) => d.dispose());
  }

  private onMessage(message: { type?: string; [key: string]: unknown }): void {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.post({ type: 'load', ...this.payload() });
        break;
      case 'save':
        if (
          typeof message.key === 'string' &&
          typeof message.pageId === 'string' &&
          typeof message.content === 'string'
        ) {
          if (this.shows(message.key, message.pageId)) {
            this.state = { ...this.state, content: message.content };
          }
          this.saveEmitter.fire({ key: message.key, pageId: message.pageId, content: message.content });
        }
        break;
      case 'action':
        if (typeof message.key === 'string' && typeof message.pageId === 'string' && typeof message.name === 'string') {
          this.actionEmitter.fire({
            key: message.key,
            pageId: message.pageId,
            name: message.name,
            arg: typeof message.arg === 'string' ? message.arg : undefined
          });
        }
        break;
      case 'flushed':
        if (typeof message.id === 'number') {
          this.flushWaiters.get(message.id)?.();
        }
        break;
    }
  }

  private payload() {
    const { target, pageId, content, locked, model } = this.state;
    return {
      key: target?.noteDir,
      pageId,
      kind: target?.kind,
      title: target?.title,
      detail: target?.detail,
      content,
      locked,
      model
    };
  }

  private applyDescription(): void {
    if (this.view) {
      this.view.description = this.state.target?.title;
    }
  }

  private post(message: unknown): void {
    if (this.view && this.ready) {
      void this.view.webview.postMessage(message);
    }
  }

  private releaseFlushWaiters(): void {
    for (const done of [...this.flushWaiters.values()]) {
      done();
    }
  }

  private html(webview: vscode.Webview): string {
    const asset = (...segments: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...segments));
    const nonce = getNonce();
    const leftMargin = vscode.workspace.getConfiguration('sidebarFileNotes').get<boolean>('leftMargin', false);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${
    webview.cspSource
  } https: data:; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${asset('media', 'reset.css')}" rel="stylesheet">
  <link href="${asset('media', 'vscode.css')}" rel="stylesheet">
  <link href="${asset('media', 'markdown.css')}" rel="stylesheet">
  <link href="${asset('media', 'main.css')}" rel="stylesheet">
  <title>Notes</title>
</head>
<body class="${leftMargin ? 'left-margin' : ''}">
  <header id="header" class="hidden">
    <div id="title-row"><span id="kind"></span><span id="title"></span><span id="lock" class="hidden" title="Locked: this note stays while you switch tabs">locked</span></div>
    <div id="detail"></div>
  </header>
  <section id="pages" class="hidden">
    <div id="graph-wrap" tabindex="0" title="Pages of this note. Arrow keys move between them."><svg id="graph" xmlns="http://www.w3.org/2000/svg"></svg></div>
    <div id="page-bar">
      <button id="graph-toggle" class="icon" title="Show or hide the page graph">▾</button>
      <button class="icon" data-nav="back" title="Previous turn">◀</button>
      <button class="icon" data-nav="up" title="Previous sibling">▲</button>
      <button class="icon" data-nav="down" title="Next sibling">▼</button>
      <button class="icon" data-nav="forward" title="Next turn">▶</button>
      <span id="page-label"></span>
      <button class="icon" data-nav="tip" title="Go to the current draft">⇥</button>
    </div>
    <div id="page-links"></div>
    <div id="page-actions"></div>
    <div id="handoffs" class="hidden"></div>
  </section>
  <main id="main">
    <div id="empty">Open a file or a Claude Code conversation to take notes on it.</div>
    <div id="render" class="hidden"></div>
    <div id="content" class="hidden"><textarea id="text-input" spellcheck="true"></textarea></div>
  </main>
  <script nonce="${nonce}" src="${asset('dist', 'webview.js')}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
