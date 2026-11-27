import * as assert from 'assert';

import { appendBlock, codeBlock, fenceFor, quoteBlock } from '../snippets';

describe('snippets', () => {
  it('quotes copied conversation text, tidying blank lines, CRLF and non-breaking spaces', () => {
    const copied = '\r\n\r\nFirst line  \r\nsecond\u00a0line\r\n\r\n\r\n\r\nAfter a gap\r\n\r\n';
    assert.strictEqual(quoteBlock(copied), '> First line\n> second line\n>\n> After a gap');
    assert.strictEqual(quoteBlock(' \n\n '), '');
  });

  it('formats a code selection under its path and lines', () => {
    assert.strictEqual(
      codeBlock('const a = 1;\r\nconst b = 2;\n', {
        path: 'src/a.ts',
        startLine: 3,
        endLine: 4,
        language: 'typescript'
      }),
      '`src/a.ts:3-4`\n\n```typescript\nconst a = 1;\nconst b = 2;\n```'
    );
    assert.strictEqual(codeBlock('x', { path: 'a.txt', startLine: 7, endLine: 7 }), '`a.txt:7`\n\n```\nx\n```');
  });

  it('uses a fence longer than any backtick run in the text', () => {
    assert.strictEqual(fenceFor('no ticks'), '```');
    assert.strictEqual(fenceFor('a `b` c'), '```');
    assert.strictEqual(fenceFor('```js\nx\n```'), '````');
    assert.strictEqual(fenceFor('`````'), '``````');
  });

  it('appends a block after one blank line', () => {
    assert.strictEqual(appendBlock('', '> q'), '> q\n');
    assert.strictEqual(appendBlock('  \n', '> q'), '> q\n');
    assert.strictEqual(appendBlock('notes\n\n\n', '> q'), 'notes\n\n> q\n');
    assert.strictEqual(appendBlock('- [ ] task', '> q'), '- [ ] task\n\n> q\n');
  });
});
