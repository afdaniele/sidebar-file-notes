/**
 * Identifies Claude Code conversations from their tab label.
 *
 * The Claude Code VS Code extension does not expose the session id of a conversation tab to other
 * extensions: the only thing visible is the tab label, which is the session title (truncated). The
 * session transcripts in `<configDir>/projects/<encoded cwd>/<sessionId>.jsonl` record those titles as
 * `custom-title` (user renames), `ai-title` (generated) and `last-prompt` entries, so the label can be
 * mapped back to a session id by matching it against the latest title of each transcript.
 *
 * This module has no dependency on the `vscode` API so it can be unit tested.
 */
import { promises as fs, Stats } from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Label of a Claude Code tab before its conversation has a title. */
export const CLAUDE_PLACEHOLDER_TITLE = 'Claude Code';

/** Title records are short; a longer line is a message or tool output and is skipped without buffering. */
const MAX_TITLE_LINE_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

export interface SessionInfo {
  sessionId: string;
  /** Absolute path of the transcript. */
  file: string;
  mtimeMs: number;
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
}

interface CacheEntry extends SessionInfo {
  size: number;
  /** Byte offset just past the last complete line already processed. */
  offset: number;
}

/** Claude Code's name for the transcript folder of a working directory. */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function defaultClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** The title Claude Code shows for a session, using the same precedence it does. */
export function displayTitle(session: SessionInfo): string | undefined {
  return session.customTitle ?? session.aiTitle ?? session.lastPrompt;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function stripEllipsis(text: string): string {
  return text.replace(/(…|\.\.\.)$/, '').trim();
}

/**
 * How well a tab label matches a title: 3 when equal, 2 when one is a truncation of the other, 0 otherwise.
 * Claude Code truncates tab titles (to 24 characters plus "…" when opening a tab, to 200 on rename).
 */
export function matchScore(label: string, title: string | undefined): number {
  if (!title) {
    return 0;
  }
  const l = normalize(label);
  const t = normalize(title);
  if (!l || !t) {
    return 0;
  }
  if (l === t) {
    return 3;
  }
  const ls = stripEllipsis(l);
  const ts = stripEllipsis(t);
  if (ls.length < 3 || ts.length < 3) {
    return 0;
  }
  if (ls === ts) {
    return 3;
  }
  if (ts.startsWith(ls) || ls.startsWith(ts)) {
    return 2;
  }
  return 0;
}

/**
 * How well a tab label identifies a session. The current title counts most; older kinds of title still
 * count a little, which covers the moment between a rename and the transcript recording it.
 */
export function sessionScore(label: string, session: SessionInfo): number {
  const primary = matchScore(label, displayTitle(session)) * 10;
  const secondary = Math.max(
    matchScore(label, session.customTitle),
    matchScore(label, session.aiTitle),
    matchScore(label, session.lastPrompt)
  );
  return Math.max(primary, secondary > 0 ? secondary * 10 - 5 : 0);
}

/** Whether a tab label is a real title, rather than the placeholder of a conversation that has none yet. */
export function isTitledLabel(label: string): boolean {
  const l = normalize(label);
  return l !== '' && l !== CLAUDE_PLACEHOLDER_TITLE;
}

export interface FindOptions {
  /** Working directories whose transcripts are searched first (usually the workspace folders). */
  projectPaths: string[];
  /** Sessions already attached to other tabs; used only when nothing else matches. */
  exclude?: ReadonlySet<string>;
  /** When nothing matches in `projectPaths`, other projects are searched, skipping transcripts older than this. */
  fallbackMaxAgeMs?: number;
}

export class ClaudeSessionIndex {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly getConfigDir: () => string = defaultClaudeConfigDir) {}

  get projectsDir(): string {
    return path.join(this.getConfigDir(), 'projects');
  }

  /** Finds the session a Claude Code tab label belongs to. */
  async find(label: string, options: FindOptions): Promise<SessionInfo | undefined> {
    if (!isTitledLabel(label)) {
      return undefined;
    }
    const projectsDir = this.projectsDir;
    const preferred = [...new Set(options.projectPaths.map((p) => path.join(projectsDir, projectDirName(p))))];
    const found = pickBest(label, await this.scanDirs(preferred), options.exclude);
    if (found) {
      return found;
    }
    const others = (await listSubdirs(projectsDir)).filter((dir) => !preferred.includes(dir));
    const maxAge = options.fallbackMaxAgeMs ?? 30 * 24 * 3600 * 1000;
    return pickBest(label, await this.scanDirs(others, Date.now() - maxAge), options.exclude);
  }

  /** The up-to-date info of a session seen before, or undefined if its transcript is gone. */
  async get(sessionId: string): Promise<SessionInfo | undefined> {
    for (const entry of this.cache.values()) {
      if (entry.sessionId === sessionId) {
        const stat = await statOrUndefined(entry.file);
        if (!stat) {
          this.cache.delete(entry.file);
          return undefined;
        }
        return toInfo(await this.update(entry.file, stat));
      }
    }
    return undefined;
  }

  /** Info of a session by id, also when it was never seen: its transcript is looked up by file name. */
  async lookup(sessionId: string, projectPaths: string[]): Promise<SessionInfo | undefined> {
    const known = await this.get(sessionId);
    if (known || !/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      return known;
    }
    const projectsDir = this.projectsDir;
    const preferred = projectPaths.map((p) => path.join(projectsDir, projectDirName(p)));
    const dirs = [...new Set([...preferred, ...(await listSubdirs(projectsDir))])];
    for (const dir of dirs) {
      const file = path.join(dir, `${sessionId}.jsonl`);
      const stat = await statOrUndefined(file);
      if (stat?.isFile()) {
        return toInfo(await this.update(file, stat));
      }
    }
    return undefined;
  }

  private async scanDirs(dirs: string[], minMtimeMs?: number): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = [];
    for (const dir of dirs) {
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) {
          continue;
        }
        const file = path.join(dir, name);
        const stat = await statOrUndefined(file);
        if (!stat || !stat.isFile()) {
          continue;
        }
        if (minMtimeMs !== undefined && stat.mtimeMs < minMtimeMs && !this.cache.has(file)) {
          continue;
        }
        try {
          sessions.push(toInfo(await this.update(file, stat)));
        } catch {
          // Unreadable transcript: skip it.
        }
      }
    }
    return sessions;
  }

  /** Brings the cached titles of a transcript up to date, reading only what was appended since last time. */
  private async update(file: string, stat: Stats): Promise<CacheEntry> {
    let entry = this.cache.get(file);
    if (entry && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs) {
      return entry;
    }
    if (!entry || stat.size < entry.offset) {
      entry = { sessionId: path.basename(file, '.jsonl'), file, mtimeMs: 0, size: 0, offset: 0 };
      this.cache.set(file, entry);
    }
    const target = entry;
    target.offset = await readLines(file, target.offset, stat.size, (line) => applyRecord(target, line));
    target.size = stat.size;
    target.mtimeMs = stat.mtimeMs;
    return target;
  }
}

function pickBest(
  label: string,
  sessions: SessionInfo[],
  exclude: ReadonlySet<string> | undefined
): SessionInfo | undefined {
  const ranked = sessions
    .map((session) => ({ session, score: sessionScore(label, session) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.session.mtimeMs - a.session.mtimeMs);
  const free = ranked.find((r) => !exclude?.has(r.session.sessionId));
  return (free ?? ranked[0])?.session;
}

function applyRecord(entry: CacheEntry, line: Buffer): void {
  // Cheap filter before parsing: only title records are of interest.
  if (!line.includes('-title"') && !line.includes('"last-prompt"')) {
    return;
  }
  let record: unknown;
  try {
    record = JSON.parse(line.toString('utf8'));
  } catch {
    return;
  }
  if (typeof record !== 'object' || record === null) {
    return;
  }
  const r = record as Record<string, unknown>;
  if (r.type === 'custom-title' && typeof r.customTitle === 'string') {
    entry.customTitle = r.customTitle;
  } else if (r.type === 'ai-title' && typeof r.aiTitle === 'string') {
    entry.aiTitle = r.aiTitle;
  } else if (r.type === 'last-prompt' && typeof r.lastPrompt === 'string') {
    entry.lastPrompt = r.lastPrompt;
  }
}

/**
 * Calls `onLine` for each complete line in `[start, end)` of a file and returns the offset just past the
 * last complete line. Lines longer than {@link MAX_TITLE_LINE_BYTES} are skipped.
 */
async function readLines(file: string, start: number, end: number, onLine: (line: Buffer) => void): Promise<number> {
  const handle = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(READ_CHUNK_BYTES);
    let pos = start;
    let lastComplete = start;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let skipping = false;
    while (pos < end) {
      const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, end - pos), pos);
      if (bytesRead === 0) {
        break;
      }
      let lineStart = 0;
      for (;;) {
        const nl = buf.indexOf(NEWLINE, lineStart);
        if (nl === -1 || nl >= bytesRead) {
          if (!skipping) {
            pendingBytes += bytesRead - lineStart;
            if (pendingBytes > MAX_TITLE_LINE_BYTES) {
              skipping = true;
              pending = [];
            } else {
              pending.push(Buffer.from(buf.subarray(lineStart, bytesRead)));
            }
          }
          break;
        }
        if (!skipping) {
          const part = buf.subarray(lineStart, nl);
          const line = pending.length > 0 ? Buffer.concat([...pending, part]) : part;
          if (line.length <= MAX_TITLE_LINE_BYTES) {
            onLine(line);
          }
        }
        pending = [];
        pendingBytes = 0;
        skipping = false;
        lineStart = nl + 1;
        lastComplete = pos + nl + 1;
      }
      pos += bytesRead;
    }
    return lastComplete;
  } finally {
    await handle.close();
  }
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

async function statOrUndefined(file: string): Promise<Stats | undefined> {
  try {
    return await fs.stat(file);
  } catch {
    return undefined;
  }
}

function toInfo(entry: CacheEntry): SessionInfo {
  const { sessionId, file, mtimeMs, customTitle, aiTitle, lastPrompt } = entry;
  return { sessionId, file, mtimeMs, customTitle, aiTitle, lastPrompt };
}
