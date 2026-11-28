/**
 * Where note files live. Pure path logic, no dependency on the `vscode` API.
 *
 * Each note is a folder holding one `.md` file per page. Layout under a notes root:
 *   files/<path relative to the workspace folder>.pages/   notes of workspace files
 *   external/<encoded absolute path>.pages/                notes of files outside every workspace folder
 *   claude/<sessionId>/                                    notes of Claude Code conversations
 *   claude/.pending/<id>/                                  notes of conversations not identified yet
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

/** Suffix of the note folder of a file, so it cannot be mistaken for the notes of a workspace folder. */
export const FILE_NOTE_SUFFIX = '.pages';

export function fileNoteDir(root: string, relativePath: string): string {
  return path.join(root, 'files', `${relativePath}${FILE_NOTE_SUFFIX}`);
}

/** Folder holding the notes of the files under a workspace subfolder (used when that folder is renamed). */
export function folderNotesPath(root: string, relativePath: string): string {
  return path.join(root, 'files', relativePath);
}

export function externalNoteDir(root: string, absolutePath: string): string {
  return path.join(root, 'external', `${projectDirName(absolutePath)}${FILE_NOTE_SUFFIX}`);
}

export function claudeNoteDir(root: string, sessionId: string): string {
  return path.join(root, 'claude', safeName(sessionId));
}

export function pendingClaudeNoteDir(root: string, id: string): string {
  return path.join(root, 'claude', '.pending', safeName(id));
}

/** A note folder relative to its notes root, with `/` separators: how links between notes name it. */
export function noteRef(root: string, noteDir: string): string {
  return path.relative(root, noteDir).split(path.sep).join('/');
}

export function noteDirOfRef(root: string, ref: string): string {
  return path.join(root, ...ref.split('/'));
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}
