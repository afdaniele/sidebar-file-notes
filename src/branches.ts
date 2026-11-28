/**
 * Splits a draft into branches: its top-level sections (the highest heading level used) or, without
 * headings, its top-level list items. Fenced code is never split. No vscode import.
 */

export interface SplitItem {
  /** First line, without markers, for display. */
  title: string;
  /** The text of the fork page made from this item. */
  body: string;
  /** Line range in the source, end exclusive. */
  start: number;
  end: number;
}

const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})[ \t]+\S/;
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?(.*)$/;

export function splitItems(text: string): SplitItem[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const inCode = codeLines(lines);
  const headings = lines
    .map((line, i) => (!inCode[i] ? HEADING.exec(line) : null))
    .map((m, i) => (m ? { level: m[1].length, line: i } : undefined))
    .filter((h): h is { level: number; line: number } => h !== undefined);
  if (headings.length > 0) {
    const level = Math.min(...headings.map((h) => h.level));
    const starts = headings.filter((h) => h.level === level).map((h) => h.line);
    return starts.map((start, k) => {
      const end = trimEnd(lines, start, k + 1 < starts.length ? starts[k + 1] : lines.length);
      const body = lines.slice(start, end).join('\n');
      return { title: lines[start].replace(/^#{1,6}[ \t]+/, '').trim(), body, start, end };
    });
  }
  const items: SplitItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = !inCode[i] ? LIST_ITEM.exec(lines[i]) : null;
    if (!m) {
      continue;
    }
    let end = i + 1;
    // Blank and indented lines continue the item; anything at column 0 (a fence too) ends it.
    while (end < lines.length && (lines[end].trim() === '' || /^[ \t]/.test(lines[end]))) {
      end++;
    }
    end = trimEnd(lines, i, end);
    const rest = dedent(lines.slice(i + 1, end));
    const body = [m[1], ...rest].join('\n').replace(/\s+$/, '');
    items.push({ title: m[1].trim(), body, start: i, end });
    i = end - 1;
  }
  return items;
}

/** The text without the given items, keeping single blank lines between what is left. */
export function withoutItems(text: string, items: SplitItem[]): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const drop = new Set<number>();
  for (const item of items) {
    for (let i = item.start; i < item.end; i++) {
      drop.add(i);
    }
  }
  const kept = lines.filter((_, i) => !drop.has(i)).join('\n');
  const tidy = kept
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s*\n/, '')
    .replace(/\s+$/, '');
  return tidy === '' ? '' : `${tidy}\n`;
}

function codeLines(lines: string[]): boolean[] {
  const result: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const m = FENCE.exec(line);
    if (fence === null) {
      if (m) {
        fence = m[1];
        result.push(true);
        continue;
      }
      result.push(false);
    } else {
      result.push(true);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) {
        fence = null;
      }
    }
  }
  return result;
}

function trimEnd(lines: string[], start: number, end: number): number {
  while (end > start + 1 && lines[end - 1].trim() === '') {
    end--;
  }
  return end;
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim() !== '').map((l) => /^[ \t]*/.exec(l)![0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(Math.min(min, /^[ \t]*/.exec(l)![0].length)));
}
