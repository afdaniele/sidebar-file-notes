/**
 * A note is a folder of pages, one markdown file per page. Each page file starts with a small header
 * that places it in the note's tree:
 *
 *   ---
 *   parent: 20261127-143200-a1b2c3
 *   fork: true
 *   state: sent
 *   created: 2026-11-27T14:32:00.000Z
 *   sentAt: 2026-11-27T14:40:12.000Z
 *   ---
 *   <the page's markdown>
 *
 * The file name (without `.md`) is the page id. No vscode import, so it can be tested with plain mocha.
 */
import { randomBytes } from 'crypto';

/**
 * `draft` pages are editable. `sent` pages were sent to the conversation (main line only).
 * `handed-off` forks were sent to another conversation. `dropped` forks were abandoned.
 */
export type PageState = 'draft' | 'sent' | 'handed-off' | 'dropped';

const STATES: readonly PageState[] = ['draft', 'sent', 'handed-off', 'dropped'];

export interface PageMeta {
  /** Id of the parent page; absent for a root. */
  parent?: string;
  /** A fork: a sibling branch of its parent's continuation, drawn in its own lane. */
  fork?: boolean;
  state: PageState;
  /** ISO timestamp. Orders siblings. */
  created?: string;
  /** ISO timestamp of when the page was marked sent. */
  sentAt?: string;
  /** Overrides the title taken from the first line. */
  title?: string;
  /** Link to the page this one was handed off from: `<note ref>#<page id>`. */
  from?: string;
  /** Link to the page this one was handed off to: `<note ref>#<page id>`. */
  handoffTo?: string;
  /** Header keys this version does not know (for example a future `transcript`), kept as they are. */
  extra?: [string, string][];
}

export interface Page {
  id: string;
  meta: PageMeta;
  body: string;
  /** Exists only in memory: an empty draft has no file. */
  virtual?: boolean;
}

/** Header keys in the order they are written. */
const KNOWN_KEYS = ['parent', 'fork', 'state', 'created', 'sentAt', 'title', 'from', 'handoffTo'] as const;
type KnownKey = (typeof KNOWN_KEYS)[number];

export type MetaPatch = { [K in Exclude<keyof PageMeta, 'extra'>]?: PageMeta[K] | null };

export const PAGE_EXTENSION = '.md';

const HEADER = /^---\n((?:.*\n)*?)---(?:\n|$)/;
const HEADER_LINE = /^([A-Za-z][\w-]*):[ \t]?(.*)$/;
const PAGE_ID = /^[A-Za-z0-9_-]+$/;

/** A new page id: a UTC timestamp, so page files sort by creation, plus random hex. */
export function newPageId(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  const time = `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `${date}-${time}-${randomBytes(3).toString('hex')}`;
}

export function isPageId(id: string): boolean {
  return PAGE_ID.test(id);
}

/** Reads a page file. A file without a header is a draft root whose whole text is the body. */
export function parsePage(id: string, text: string): Page {
  const source = text.replace(/\r\n/g, '\n');
  const match = HEADER.exec(source);
  const meta: PageMeta = { state: 'draft' };
  if (!match) {
    return { id, meta, body: source };
  }
  for (const line of match[1].split('\n')) {
    const kv = HEADER_LINE.exec(line);
    if (!kv) {
      continue;
    }
    const [, key, raw] = kv;
    const value = raw.trim();
    switch (key as KnownKey) {
      case 'fork':
        meta.fork = value === 'true';
        break;
      case 'state':
        meta.state = (STATES as readonly string[]).includes(value) ? (value as PageState) : 'draft';
        break;
      case 'parent':
      case 'created':
      case 'sentAt':
      case 'title':
      case 'from':
      case 'handoffTo':
        if (value !== '') {
          meta[key as Exclude<KnownKey, 'fork' | 'state'>] = value;
        }
        break;
      default:
        (meta.extra ??= []).push([key, value]);
    }
  }
  return { id, meta, body: source.slice(match[0].length) };
}

export function serializePage(page: Page): string {
  const lines = ['---'];
  const { meta } = page;
  for (const key of KNOWN_KEYS) {
    const value = meta[key];
    if (key === 'fork') {
      if (value) {
        lines.push('fork: true');
      }
    } else if (value !== undefined && value !== '') {
      lines.push(`${key}: ${oneLine(String(value))}`);
    }
  }
  for (const [key, value] of meta.extra ?? []) {
    lines.push(`${key}: ${oneLine(value)}`);
  }
  lines.push('---');
  return `${lines.join('\n')}\n${page.body}`;
}

export function applyPatch(meta: PageMeta, patch: MetaPatch): PageMeta {
  const next: PageMeta = { ...meta };
  for (const [key, value] of Object.entries(patch) as [keyof MetaPatch, unknown][]) {
    if (value === null || value === undefined) {
      if (key !== 'state') {
        delete next[key];
      }
    } else {
      (next as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return next;
}

/** A short title: the header's title, else the first non-empty line without its markdown markers. */
export function pageTitle(page: Page, max = 80): string {
  if (page.meta.title) {
    return truncate(page.meta.title, max);
  }
  for (const raw of page.body.split('\n')) {
    const line = raw
      .replace(/^\s*(?:>\s*)*/, '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/^(?:[-*+]|\d{1,9}[.)])\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
      .replace(/[*_`~]+/g, '')
      .trim();
    if (line !== '' && !/^(?:-{3,}|`{3,}|~{3,})$/.test(raw.trim())) {
      return truncate(line, max);
    }
  }
  return '';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

/** A link to a page of another note: `<note folder relative to its notes root>#<page id>`. */
export function formatLink(noteRef: string, pageId: string): string {
  return `${noteRef}#${pageId}`;
}

export function parseLink(link: string): { noteRef: string; pageId: string } | undefined {
  const hash = link.lastIndexOf('#');
  if (hash <= 0 || hash === link.length - 1) {
    return undefined;
  }
  const noteRef = link.slice(0, hash);
  const pageId = link.slice(hash + 1);
  if (!isPageId(pageId) || noteRef.split('/').some((part) => part === '..' || part === '')) {
    return undefined;
  }
  return { noteRef, pageId };
}
