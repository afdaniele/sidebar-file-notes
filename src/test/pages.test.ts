import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { splitItems, withoutItems } from '../branches';
import { HandoffRegistry, KeyValueStore } from '../handoffs';
import { NoteStore } from '../noteStore';
import { PageNote } from '../pageNote';
import {
  buildTree,
  canUndoSent,
  forkParent,
  mainTip,
  neighbor,
  pageModel,
  planDelete,
  siblingForkParent
} from '../pageTree';
import { Page, PageMeta, pageTitle, parseLink, parsePage, serializePage } from '../pages';

function page(id: string, meta: Partial<PageMeta> = {}, body = `body of ${id}`): Page {
  return { id, meta: { state: 'draft', ...meta }, body };
}

/** A main line a -> b -> c (c is the draft), with forks f1, f2 off b. */
function sample(): Page[] {
  return [
    page('a', { state: 'sent', created: '1' }),
    page('b', { state: 'sent', parent: 'a', created: '2' }),
    page('f2', { parent: 'b', fork: true, created: '5' }),
    page('c', { parent: 'b', created: '3' }),
    page('f1', { parent: 'b', fork: true, created: '4' })
  ];
}

describe('pages', () => {
  it('round-trips the header, keeping keys it does not know', () => {
    const text = [
      '---',
      'parent: 20261127-140100-aaaaaa',
      'fork: true',
      'state: handed-off',
      'created: 2026-11-27T14:32:00.000Z',
      'handoffTo: claude/s2#20261127-150000-bbbbbb',
      'transcript: s1/uuid-1',
      '---',
      '# Title',
      '',
      'Body'
    ].join('\n');
    const p = parsePage('x', text);
    assert.strictEqual(p.meta.parent, '20261127-140100-aaaaaa');
    assert.strictEqual(p.meta.fork, true);
    assert.strictEqual(p.meta.state, 'handed-off');
    assert.deepStrictEqual(p.meta.extra, [['transcript', 's1/uuid-1']]);
    assert.strictEqual(p.body, '# Title\n\nBody');
    assert.strictEqual(serializePage(p), text);
  });

  it('reads a file without a header as a draft root, and an unknown state as draft', () => {
    assert.deepStrictEqual(parsePage('x', 'just text\n'), { id: 'x', meta: { state: 'draft' }, body: 'just text\n' });
    assert.strictEqual(parsePage('x', '---\nstate: weird\n---\n').meta.state, 'draft');
    assert.strictEqual(parsePage('x', '---\n---\nbody').body, 'body');
  });

  it('titles a page by its first line without markdown markers', () => {
    assert.strictEqual(pageTitle(page('x', {}, '\n## **Refactor** auth\nmore')), 'Refactor auth');
    assert.strictEqual(pageTitle(page('x', {}, '- [ ] `task` one')), 'task one');
    assert.strictEqual(pageTitle(page('x', { title: 'Given' }, 'ignored')), 'Given');
    assert.strictEqual(pageTitle(page('x', {}, '  \n')), '');
  });

  it('parses links and rejects ones that leave the notes root', () => {
    assert.deepStrictEqual(parseLink('claude/s1#p-1'), { noteRef: 'claude/s1', pageId: 'p-1' });
    assert.strictEqual(parseLink('claude/../x#p'), undefined);
    assert.strictEqual(parseLink('#p'), undefined);
    assert.strictEqual(parseLink('claude/s1#'), undefined);
  });
});

describe('pageTree', () => {
  it('puts the continuation first and forks after it, by creation', () => {
    const tree = buildTree(sample());
    assert.deepStrictEqual(
      tree.mainLine.map((n) => n.page.id),
      ['a', 'b', 'c']
    );
    assert.deepStrictEqual(
      tree.nodes.get('b')!.children.map((n) => n.page.id),
      ['c', 'f1', 'f2']
    );
    assert.strictEqual(mainTip(tree)!.page.id, 'c');
    assert.strictEqual(tree.nodes.get('c')!.cont, true);
    assert.strictEqual(tree.nodes.get('f1')!.cont, false);
  });

  it('turns orphans and cycles into extra roots after the main root', () => {
    const tree = buildTree([
      page('orphan', { parent: 'gone', fork: true, created: '0' }),
      page('root', { created: '1' }),
      page('x', { parent: 'y', created: '2' }),
      page('y', { parent: 'x', created: '3' })
    ]);
    assert.strictEqual(tree.roots[0].page.id, 'root');
    assert.strictEqual(tree.roots.length, 3);
  });

  it('navigates back, forward (to the child visited last), and between siblings', () => {
    const tree = buildTree(sample());
    assert.strictEqual(neighbor(tree, 'c', 'back'), 'b');
    assert.strictEqual(neighbor(tree, 'b', 'forward'), 'c');
    assert.strictEqual(neighbor(tree, 'b', 'forward', 'f2'), 'f2');
    assert.strictEqual(neighbor(tree, 'c', 'down'), 'f1');
    assert.strictEqual(neighbor(tree, 'f1', 'up'), 'c');
    assert.strictEqual(neighbor(tree, 'c', 'up'), undefined);
    assert.strictEqual(neighbor(tree, 'a', 'tip'), 'c');
    assert.strictEqual(neighbor(tree, 'c', 'tip'), undefined);
  });

  it('forks only from the latest sent page', () => {
    const tree = buildTree(sample());
    assert.strictEqual(forkParent(tree, 'c'), 'b');
    assert.strictEqual(forkParent(tree, 'b'), 'b');
    assert.strictEqual(forkParent(tree, 'f1'), 'b');
    assert.strictEqual(forkParent(tree, 'a'), undefined);
    assert.strictEqual(forkParent(buildTree([page('only')]), 'only'), undefined);
  });

  it('places a fork made without leaving the page next to it, else next to the current draft', () => {
    const tree = buildTree(sample());
    assert.strictEqual(siblingForkParent(tree, 'c'), 'b');
    assert.strictEqual(siblingForkParent(tree, 'f1'), 'b');
    assert.strictEqual(siblingForkParent(tree, 'a'), 'b');
    assert.strictEqual(siblingForkParent(buildTree([page('only')]), 'only'), undefined);
  });

  it('deletes a subtree, or keeps the children and lets the continuation take the place', () => {
    const tree = buildTree(sample());
    assert.deepStrictEqual(planDelete(tree, 'b', 'subtree').remove, ['b', 'c', 'f1', 'f2']);
    const keep = planDelete(tree, 'b', 'keepChildren');
    assert.deepStrictEqual(keep.remove, ['b']);
    assert.deepStrictEqual(keep.update, [
      { id: 'c', patch: { parent: 'a', fork: null } },
      { id: 'f1', patch: { parent: 'a' } },
      { id: 'f2', patch: { parent: 'a' } }
    ]);
    const root = planDelete(tree, 'a', 'keepChildren');
    assert.deepStrictEqual(root.update, [{ id: 'b', patch: { parent: null, fork: null } }]);
  });

  it('offers the actions that fit the page', () => {
    const tree = buildTree(sample());
    const tip = pageModel(tree, 'c')!.page;
    assert.deepStrictEqual(tip.actions, ['copy', 'markSent', 'fork', 'split', 'delete']);
    assert.strictEqual(tip.label, 'Turn 3 · 1/3');
    assert.strictEqual(tip.editable, true);
    const fork = pageModel(tree, 'f1')!.page;
    assert.deepStrictEqual(fork.actions, ['copy', 'fork', 'handOff', 'drop', 'copyToDraft', 'delete']);
    assert.strictEqual(fork.label, 'Turn 3 · fork · 2/3');
    const sent = pageModel(tree, 'a')!.page;
    assert.strictEqual(sent.editable, false);
    assert.deepStrictEqual(sent.actions, ['copy', 'editAnyway', 'delete']);
    assert.strictEqual(pageModel(tree, 'a', { unlocked: true })!.page.editable, true);
    assert.deepStrictEqual(
      pageModel(tree, 'a')!.nodes.map((n) => n.id),
      ['a', 'b', 'c', 'f1', 'f2']
    );
  });

  it('lets the latest sent page go back to draft only while its continuation is empty and alone', () => {
    const pages = [page('a', { state: 'sent' }), page('b', { parent: 'a' }, '')];
    assert.ok(canUndoSent(buildTree(pages), 'a'));
    assert.ok(!canUndoSent(buildTree([pages[0], page('b', { parent: 'a' }, 'typed')]), 'a'));
    assert.ok(!canUndoSent(buildTree([...pages, page('f', { parent: 'a', fork: true })]), 'a'));
  });
});

describe('splitItems', () => {
  it('splits top-level list items, with their nested lines, skipping code', () => {
    const text = [
      'Next steps:',
      '',
      '- [ ] Refactor auth',
      '  - keep the API',
      '',
      '  details',
      '- Write docs',
      '```',
      '- not an item',
      '```',
      'Thanks'
    ].join('\n');
    const items = splitItems(text);
    assert.deepStrictEqual(
      items.map((i) => i.title),
      ['Refactor auth', 'Write docs']
    );
    assert.strictEqual(items[0].body, 'Refactor auth\n- keep the API\n\ndetails');
    assert.strictEqual(withoutItems(text, items), 'Next steps:\n\n```\n- not an item\n```\nThanks\n');
    assert.strictEqual(withoutItems(text, [items[1]]).includes('Refactor auth'), true);
  });

  it('prefers sections of the highest heading level', () => {
    const text = '# Plan\nintro\n## One\na\n### sub\n## Two\nb\n';
    const items = splitItems(text);
    assert.deepStrictEqual(
      items.map((i) => i.title),
      ['Plan']
    );
    const sections = splitItems('intro\n## One\na\n### sub\n\n## Two\nb\n');
    assert.deepStrictEqual(
      sections.map((i) => i.body),
      ['## One\na\n### sub', '## Two\nb']
    );
    assert.deepStrictEqual(splitItems('no items here'), []);
  });
});

describe('PageNote', () => {
  let dir: string;
  let ids: number;
  let store: NoteStore;

  const note = () =>
    new PageNote(
      dir,
      store,
      () => `p${++ids}`,
      () => '2026-11-27T00:00:00.000Z'
    );

  beforeEach(async () => {
    dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'sfn-pages-')), 'note');
    ids = 0;
    store = new NoteStore();
  });

  afterEach(async () => {
    await fs.rm(path.dirname(dir), { recursive: true, force: true });
  });

  it('starts with an empty draft in memory, written only once it has content', async () => {
    const n = note();
    await n.load();
    const root = mainTip(n.tree())!.page;
    assert.ok(root.virtual);
    assert.deepStrictEqual(await store.list(dir), []);
    await n.setBody(root.id, 'first prompt');
    assert.deepStrictEqual(
      (await store.list(dir)).map((f) => f.name),
      [`${root.id}.md`]
    );
    await n.setBody(root.id, '  ');
    assert.deepStrictEqual(await store.list(dir), []);
    assert.strictEqual(mainTip(n.tree())!.page.id, root.id);
  });

  it('continues the main line after a page is sent, and reloads the same tree from disk', async () => {
    const n = note();
    await n.load();
    const first = mainTip(n.tree())!.page.id;
    await n.setBody(first, 'prompt 1');
    await n.update(first, { state: 'sent', sentAt: 'now' });
    const next = mainTip(n.tree())!.page;
    assert.notStrictEqual(next.id, first);
    assert.strictEqual(next.meta.parent, first);
    assert.ok(next.virtual);
    const fork = await n.createWith({ parent: first, fork: true, state: 'draft' }, 'side quest');

    const again = note();
    await again.load();
    const tree = again.tree();
    assert.deepStrictEqual(
      tree.nodes.get(first)!.children.map((c) => [c.cont, !!c.page.virtual]),
      [
        [true, true],
        [false, false]
      ]
    );
    assert.strictEqual(tree.nodes.get(fork.id)!.page.body, 'side quest');
    assert.strictEqual(again.get(first)!.meta.sentAt, 'now');
  });

  it('keeps creation order for pages made in the same millisecond', async () => {
    const n = note();
    await n.load();
    const a = n.create({ state: 'draft', fork: true });
    const b = n.create({ state: 'draft', fork: true });
    assert.ok(a.meta.created! < b.meta.created!);
  });

  it('drops an in-memory continuation once its parent is a draft again', async () => {
    const n = note();
    await n.load();
    const first = mainTip(n.tree())!.page.id;
    await n.setBody(first, 'p');
    await n.update(first, { state: 'sent' });
    const cont = mainTip(n.tree())!.page.id;
    await n.update(first, { state: 'draft' });
    const tree = n.tree();
    assert.strictEqual(tree.nodes.has(cont), false);
    assert.strictEqual(mainTip(tree)!.page.id, first);
  });

  it('applies a delete plan', async () => {
    const n = note();
    await n.load();
    const a = mainTip(n.tree())!.page.id;
    await n.setBody(a, 'a');
    await n.update(a, { state: 'sent' });
    const b = mainTip(n.tree())!.page.id;
    await n.setBody(b, 'b');
    await n.update(b, { state: 'sent' });
    const c = mainTip(n.tree())!.page.id;
    await n.setBody(c, 'c');
    await n.apply(planDelete(n.tree(), b, 'keepChildren'));
    const again = note();
    await again.load();
    const tree = again.tree();
    assert.deepStrictEqual(
      tree.mainLine.map((x) => x.page.id),
      [a, c]
    );
  });
});

describe('HandoffRegistry', () => {
  it('adds, moves and removes pending handoffs', async () => {
    const data = new Map<string, unknown>();
    const storage: KeyValueStore = {
      get: <T>(key: string) => data.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        data.set(key, value);
      }
    };
    const registry = new HandoffRegistry(storage);
    const h = { noteDir: '/n/a', pageId: 'p', title: 't', from: 'A', created: 'now' };
    await registry.add(h);
    await registry.add(h);
    assert.strictEqual(registry.list().length, 1);
    await registry.moveNote('/n/a', '/n/b');
    assert.strictEqual(registry.list()[0].noteDir, '/n/b');
    await registry.remove('/n/b', 'other');
    assert.strictEqual(registry.list().length, 1);
    await registry.remove('/n/b');
    assert.deepStrictEqual(registry.list(), []);
  });
});

interface Cell {
  kind: 'node' | 'fold';
  col: number;
  row: number;
  ids?: string[];
  node?: { id: string };
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { layoutGraph } = require('../../media/graph') as {
  layoutGraph: (
    nodes: unknown[],
    options?: { current?: string; expanded?: Set<string> }
  ) => {
    cells: Cell[];
    edges: { from: number[]; to: number[]; fork: boolean }[];
    cellOf: Map<string, Cell>;
    rows: number;
  };
};

describe('layoutGraph', () => {
  const at = (layout: ReturnType<typeof layoutGraph>, id: string) => {
    const cell = layout.cellOf.get(id)!;
    return [cell.col, cell.row];
  };

  it('keeps the main line on row 0 and puts each fork in a lane below', () => {
    const layout = layoutGraph(pageModel(buildTree(sample()), 'c')!.nodes, { current: 'c' });
    assert.deepStrictEqual(at(layout, 'a'), [0, 0]);
    assert.deepStrictEqual(at(layout, 'c'), [2, 0]);
    assert.deepStrictEqual(at(layout, 'f1'), [2, 1]);
    assert.deepStrictEqual(at(layout, 'f2'), [2, 2]);
    assert.strictEqual(layout.edges.filter((e) => e.fork).length, 2);
  });

  it('reuses a row when the lanes do not overlap', () => {
    const pages = [
      page('a', { state: 'sent', created: '1' }),
      page('b', { state: 'sent', parent: 'a', created: '2' }),
      page('c', { parent: 'b', created: '3' }),
      page('fa', { parent: 'a', fork: true, created: '4' }),
      page('fb', { parent: 'b', fork: true, created: '5' })
    ];
    const layout = layoutGraph(pageModel(buildTree(pages), 'c')!.nodes);
    // fa sits under b's column and fb under c's: both fit on row 1.
    assert.deepStrictEqual(at(layout, 'fa'), [1, 1]);
    assert.deepStrictEqual(at(layout, 'fb'), [2, 1]);
    assert.strictEqual(layout.rows, 2);
  });

  it('folds long runs of sent pages away from the current page, unless expanded', () => {
    const pages: Page[] = [];
    for (let i = 0; i < 10; i++) {
      pages.push(
        page(`p${i}`, { state: i < 9 ? 'sent' : 'draft', parent: i ? `p${i - 1}` : undefined, created: `${i}` })
      );
    }
    const nodes = pageModel(buildTree(pages), 'p9')!.nodes;
    const layout = layoutGraph(nodes, { current: 'p9' });
    const fold = layout.cells.find((c) => c.kind === 'fold')!;
    // p0 (the root) and p8 (next to the current page) stay visible.
    assert.deepStrictEqual(fold.ids, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
    assert.deepStrictEqual(at(layout, 'p9'), [3, 0]);
    const open = layoutGraph(nodes, { current: 'p9', expanded: new Set(['p1']) });
    assert.ok(!open.cells.some((c) => c.kind === 'fold'));
    assert.deepStrictEqual(at(open, 'p9'), [9, 0]);
  });
});
