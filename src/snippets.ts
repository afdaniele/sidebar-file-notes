/**
 * Formats captured text (a selection in a Claude Code conversation or in a file) as markdown to append to
 * a note. No vscode import, so it can be tested with plain mocha.
 */

/** Where a code selection comes from: a path for display and 1-based, inclusive line numbers. */
export interface CodeSource {
  path: string;
  startLine: number;
  endLine: number;
  language?: string;
}

/**
 * Text copied from the rendered conversation, as a markdown quote. Copying rendered HTML yields
 * non-breaking spaces, CRLF on some platforms and runs of blank lines between blocks; those are tidied.
 */
export function quoteBlock(text: string): string {
  const lines = normalizeNewlines(text)
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''));
  const kept: string[] = [];
  for (const line of lines) {
    if (line === '' && (kept.length === 0 || kept[kept.length - 1] === '')) {
      continue; // Leading blank lines and runs of them.
    }
    kept.push(line);
  }
  while (kept.length && kept[kept.length - 1] === '') {
    kept.pop();
  }
  return kept.map((line) => (line === '' ? '>' : `> ${line}`)).join('\n');
}

/** A selection in a file, as a fenced code block under a `path:line` reference. Keeps the text verbatim. */
export function codeBlock(text: string, source: CodeSource): string {
  const body = normalizeNewlines(text).replace(/\n+$/, '');
  const fence = fenceFor(body);
  const lines = source.endLine > source.startLine ? `${source.startLine}-${source.endLine}` : `${source.startLine}`;
  return `\`${source.path}:${lines}\`\n\n${fence}${source.language ?? ''}\n${body}\n${fence}`;
}

/** A backtick fence longer than any backtick run in the text, so the text cannot close it. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Appends a block to a note, separated from the existing content by one blank line. */
export function appendBlock(existing: string, block: string): string {
  const head = existing.replace(/\s+$/, '');
  return head === '' ? `${block}\n` : `${head}\n\n${block}\n`;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}
