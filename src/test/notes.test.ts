import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  claudeNoteDir,
  fileNoteDir,
  isInside,
  noteDirOfRef,
  noteRef,
  notesRootFor,
  pendingClaudeNoteDir
} from '../notePaths';
import { NoteStore } from '../noteStore';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { toggleTask } = require('../../media/tasks') as { toggleTask: (source: string, index: number) => string };

describe('notePaths', () => {
  it('keeps notes inside the workspace folder for a relative setting', () => {
    const root = notesRootFor('/work/app', '.notes');
    assert.strictEqual(root, path.join('/work/app', '.notes'));
    assert.strictEqual(fileNoteDir(root, 'src/index.ts'), path.join('/work/app/.notes/files/src/index.ts.pages'));
    assert.strictEqual(claudeNoteDir(root, 'abc-123'), path.join('/work/app/.notes/claude/abc-123'));
    assert.strictEqual(pendingClaudeNoteDir(root, '../x'), path.join('/work/app/.notes/claude/.pending/___x'));
  });

  it('names a note folder relative to its root, for links', () => {
    const root = path.join('/work/app', '.notes');
    const dir = fileNoteDir(root, path.join('src', 'a.ts'));
    assert.strictEqual(noteRef(root, dir), 'files/src/a.ts.pages');
    assert.strictEqual(noteDirOfRef(root, 'files/src/a.ts.pages'), dir);
  });

  it('uses one subfolder per workspace for an absolute or home-relative setting', () => {
    assert.strictEqual(notesRootFor('/work/app', '/notes'), path.join('/notes', '-work-app'));
    assert.strictEqual(notesRootFor('/work/app', '~/notes'), path.join(os.homedir(), 'notes', '-work-app'));
    assert.strictEqual(notesRootFor('/work/app', ''), path.join('/work/app', '.notes'));
  });

  it('tells whether a path is inside another', () => {
    assert.ok(isInside('/a/b/c', '/a/b'));
    assert.ok(isInside('/a/b', '/a/b'));
    assert.ok(!isInside('/a/bc', '/a/b'));
    assert.ok(!isInside('/a', '/a/b'));
  });
});

describe('NoteStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfn-store-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes notes in order, creating folders, and deletes empty ones', async () => {
    const store = new NoteStore();
    const file = path.join(dir, 'files', 'a', 'b.ts.md');
    void store.write(file, 'one');
    void store.write(file, 'two');
    await store.write(file, 'three');
    assert.strictEqual(await store.read(file), 'three');
    assert.ok(store.isOwnWrite(file, 'three'));
    await store.write(file, '  \n');
    await assert.rejects(fs.stat(file));
    assert.strictEqual(await store.read(file), '');
  });

  it('lists, moves and removes the page files of a note folder', async () => {
    const store = new NoteStore();
    const pending = path.join(dir, 'claude', '.pending', 'p');
    const session = path.join(dir, 'claude', 's');
    assert.deepStrictEqual(await store.list(pending), []);
    await store.write(path.join(pending, 'b.md'), 'B');
    await store.write(path.join(pending, 'a.md'), 'A');
    await fs.mkdir(path.join(pending, 'sub.md'));
    assert.deepStrictEqual(await store.list(pending), [
      { name: 'a.md', text: 'A' },
      { name: 'b.md', text: 'B' }
    ]);
    await fs.rmdir(path.join(pending, 'sub.md'));
    await store.write(path.join(session, 'b.md'), 'existing');
    assert.deepStrictEqual(await store.moveFiles(pending, session), ['a.md']);
    assert.strictEqual(await store.read(path.join(session, 'a.md')), 'A');
    assert.strictEqual(await store.read(path.join(session, 'b.md')), 'existing');
    await store.remove(path.join(session, 'a.md'));
    assert.ok(store.isOwnWrite(path.join(session, 'a.md'), ''));
    assert.deepStrictEqual(
      (await store.list(session)).map((f) => f.name),
      ['b.md']
    );
    await store.removeDir(session);
    await assert.rejects(fs.stat(session));
  });

  it('renames only when the destination is free', async () => {
    const store = new NoteStore();
    const a = path.join(dir, 'a.md');
    const b = path.join(dir, 'sub', 'b.md');
    await store.write(a, 'A');
    assert.strictEqual(await store.rename(a, b), true);
    assert.strictEqual(await store.read(b), 'A');
    await store.write(a, 'A2');
    assert.strictEqual(await store.rename(a, b), false);
    assert.strictEqual(await store.rename(path.join(dir, 'missing.md'), path.join(dir, 'x.md')), false);
  });
});

describe('toggleTask', () => {
  const doc = ['- [ ] first', '  - [x] nested', '```', '- [ ] in code', '```', '> 1. [ ] quoted', '- [ ] first'].join(
    '\n'
  );

  it('flips the n-th checkbox in document order, skipping code blocks', () => {
    assert.strictEqual(toggleTask(doc, 0).split('\n')[0], '- [x] first');
    assert.strictEqual(toggleTask(doc, 1).split('\n')[1], '  - [ ] nested');
    assert.strictEqual(toggleTask(doc, 2).split('\n')[5], '> 1. [x] quoted');
    // Duplicate text is told apart by position.
    const last = toggleTask(doc, 3).split('\n');
    assert.strictEqual(last[0], '- [ ] first');
    assert.strictEqual(last[6], '- [x] first');
  });

  it('leaves the document alone for an unknown index', () => {
    assert.strictEqual(toggleTask(doc, 9), doc);
    assert.strictEqual(toggleTask('-[ ] not a task', 0), '-[ ] not a task');
  });
});
