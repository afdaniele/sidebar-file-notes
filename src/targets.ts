/**
 * Decides which note belongs to a tab: the note of a file for editor tabs, the note of a session for
 * Claude Code conversation tabs, nothing for any other tab (the current note then stays on screen).
 */
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  ClaudeSessionIndex,
  displayTitle,
  isTitledLabel,
  projectDirName,
  SessionInfo,
  sessionScore
} from './claudeSessions';
import {
  claudeNotePath,
  externalNotePath,
  fileNotePath,
  isInside,
  notesRootFor,
  pendingClaudeNotePath
} from './notePaths';

/** Claude Code conversation panels are webviews of this type (VS Code may prefix it). */
const CLAUDE_PANEL_VIEW_TYPE = 'claudeVSCodePanel';

/** A label equal to, or a truncation of, the session's current title. See `sessionScore`. */
const STRONG_MATCH = 20;

export type NoteKind = 'file' | 'claude' | 'claude-pending';

export interface NoteTarget {
  kind: NoteKind;
  /** Absolute path of the note file; also the note's identity. */
  notePath: string;
  /** Notes root the note belongs to. */
  root: string;
  /** Short name of what the note is about. */
  title: string;
  /** Longer description shown under the title. */
  detail: string;
  /** Claude Code tab the note was resolved from. */
  tab?: vscode.Tab;
  /** A pending note of the same conversation to merge into this one before showing it. */
  migrateFrom?: string;
  /** The conversation may not be identified correctly yet; resolve the tab again shortly. */
  unsettled?: boolean;
}

export class TargetResolver {
  private readonly tabSessions = new WeakMap<vscode.Tab, string>();
  private readonly tabPending = new WeakMap<vscode.Tab, string>();

  constructor(
    private readonly sessions: ClaudeSessionIndex,
    private readonly globalRoot: string
  ) {}

  async forTab(tab: vscode.Tab | undefined): Promise<NoteTarget | undefined> {
    if (!tab) {
      return undefined;
    }
    const uri = uriOfTab(tab);
    if (uri) {
      return this.forUri(uri);
    }
    if (isClaudeTab(tab) && config().get<boolean>('claudeCode.enabled', true)) {
      return this.forClaudeTab(tab);
    }
    return undefined;
  }

  forUri(uri: vscode.Uri): NoteTarget | undefined {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    const fsPath = uri.fsPath;
    if (this.allRoots().some((root) => isInside(fsPath, root))) {
      // A note file opened in an editor: keep showing the note it belongs to.
      return undefined;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) {
      const root = this.rootFor(folder);
      const rel = path.relative(folder.uri.fsPath, fsPath);
      const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
      return {
        kind: 'file',
        notePath: fileNotePath(root, rel),
        root,
        title: path.basename(fsPath),
        detail: multiRoot ? `${folder.name}/${rel.split(path.sep).join('/')}` : rel.split(path.sep).join('/')
      };
    }
    const root = this.defaultRoot();
    return {
      kind: 'file',
      notePath: externalNotePath(root, fsPath),
      root,
      title: path.basename(fsPath),
      detail: fsPath
    };
  }

  /** Forgets the pending note of a tab once it was merged into the session note. */
  pendingMerged(tab: vscode.Tab): void {
    this.tabPending.delete(tab);
  }

  /** Paths of every notes root in use, to recognize note files. */
  allRoots(): string[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return [...folders.map((f) => this.rootFor(f)), this.defaultRoot()];
  }

  private async forClaudeTab(tab: vscode.Tab): Promise<NoteTarget> {
    const label = tab.label;
    const known = this.tabSessions.get(tab);
    let session: SessionInfo | undefined;
    let unsettled = false;

    if (!isTitledLabel(label)) {
      // A conversation without a title yet, possibly a new one started in a tab that had another.
      this.tabSessions.delete(tab);
    } else {
      const info = known ? await this.sessions.get(known) : undefined;
      if (info && sessionScore(label, info) >= STRONG_MATCH) {
        session = info;
      } else {
        session = await this.findSession(label, tab);
        if (!session && info) {
          // Most likely a rename the transcript has not recorded yet: keep the note and check again soon.
          session = info;
          unsettled = true;
        }
      }
    }

    const pendingId = this.tabPending.get(tab);
    if (session) {
      this.tabSessions.set(tab, session.sessionId);
      const root = this.rootForTranscript(session.file);
      return {
        kind: 'claude',
        notePath: claudeNotePath(root, session.sessionId),
        root,
        title: displayTitle(session) || label,
        detail: `Claude Code conversation · ${session.sessionId.slice(0, 8)}`,
        tab,
        unsettled,
        migrateFrom: pendingId ? pendingClaudeNotePath(this.defaultRoot(), pendingId) : undefined
      };
    }

    const id = pendingId ?? randomUUID();
    this.tabPending.set(tab, id);
    const root = this.defaultRoot();
    return {
      kind: 'claude-pending',
      notePath: pendingClaudeNotePath(root, id),
      root,
      title: label,
      detail: 'New Claude Code conversation · the note moves to the session once it has a title',
      tab,
      unsettled: true
    };
  }

  private findSession(label: string, tab: vscode.Tab): Promise<SessionInfo | undefined> {
    const projectPaths = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    return this.sessions.find(label, { projectPaths, exclude: this.sessionsOfOtherTabs(tab) });
  }

  private sessionsOfOtherTabs(tab: vscode.Tab): Set<string> {
    const ids = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const t of group.tabs) {
        const id = t !== tab ? this.tabSessions.get(t) : undefined;
        if (id) {
          ids.add(id);
        }
      }
    }
    return ids;
  }

  /** Notes root of the workspace folder a transcript belongs to, or the default one. */
  private rootForTranscript(transcript: string): string {
    const dirName = path.basename(path.dirname(transcript));
    const folder = (vscode.workspace.workspaceFolders ?? []).find((f) => projectDirName(f.uri.fsPath) === dirName);
    return folder ? this.rootFor(folder) : this.defaultRoot();
  }

  private rootFor(folder: vscode.WorkspaceFolder): string {
    return notesRootFor(folder.uri.fsPath, config().get<string>('notesDirectory'));
  }

  private defaultRoot(): string {
    const first = vscode.workspace.workspaceFolders?.[0];
    return first ? this.rootFor(first) : path.join(this.globalRoot, 'no-workspace');
  }
}

export function isClaudeTab(tab: vscode.Tab): boolean {
  return tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes(CLAUDE_PANEL_VIEW_TYPE);
}

function uriOfTab(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
    return input.uri;
  }
  if (input instanceof vscode.TabInputNotebook) {
    return input.uri;
  }
  if (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) {
    return input.modified;
  }
  return undefined;
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('sidebarFileNotes');
}
