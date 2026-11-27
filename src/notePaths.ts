/**
 * Where note files live. Pure path logic, no dependency on the `vscode` API.
 *
 * Layout under a notes root:
 *   files/<path relative to the workspace folder>.md   notes of workspace files
 *   external/<encoded absolute path>.md                notes of files outside every workspace folder
 *   claude/<sessionId>.md                              notes of Claude Code conversations
 *   claude/.pending/<id>.md                            notes of conversations not identified yet
 */
import * as os from 'os';
import * as path from 'path';

import { projectDirName } from './claudeSessions';

export const DEFAULT_NOTES_DIRECTORY = '.notes';

export function expandHome(p: string): string {
  if (p === '~') {
    return os.homedir();
  }
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * The notes root of a workspace folder. A relative setting is resolved inside the folder; an absolute one
 * gets one subfolder per workspace folder, named like Claude Code names its project folders.
 */
export function notesRootFor(folderPath: string, setting: string | undefined): string {
  const dir = expandHome((setting ?? '').trim() || DEFAULT_NOTES_DIRECTORY);
  return path.isAbsolute(dir) ? path.join(dir, projectDirName(folderPath)) : path.join(folderPath, dir);
}

export function fileNotePath(root: string, relativePath: string): string {
  return path.join(root, 'files', `${relativePath}.md`);
}

/** Folder holding the notes of the files under a workspace subfolder (used when that folder is renamed). */
export function folderNotesPath(root: string, relativePath: string): string {
  return path.join(root, 'files', relativePath);
}

export function externalNotePath(root: string, absolutePath: string): string {
  return path.join(root, 'external', `${projectDirName(absolutePath)}.md`);
}

export function claudeNotePath(root: string, sessionId: string): string {
  return path.join(root, 'claude', `${safeName(sessionId)}.md`);
}

export function pendingClaudeNotePath(root: string, id: string): string {
  return path.join(root, 'claude', '.pending', `${safeName(id)}.md`);
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}
