// Layout of the page graph, shared by the webview and its tests (CommonJS so tests can require it).
//
// Columns are turns (the root on the left). The main line stays on row 0; each fork starts a lane of its
// own below its parent, packed git-graph style: a lane takes the first row under its parent whose
// columns are free. Long runs of sent pages with no forks fold into one "…n…" cell.

/** Runs shorter than this are not folded. */
const FOLD_MIN = 4;

/**
 * @param nodes  [{id, parent, cont, state, virtual, title, label}] in preorder, children in display order.
 * @param options  {current: id of the page shown, expanded: Set of fold keys the user opened}.
 * @returns {{cells, edges, cols, rows, cellOf}} where a cell is {kind: 'node', node, col, row} or
 *   {kind: 'fold', key, ids, col, row}; edges are {from: [col, row], to: [col, row], fork}; `cellOf` maps
 *   every page id (folded ones too) to its cell.
 */
function layoutGraph(nodes, options = {}) {
  const current = options.current;
  const expanded = options.expanded || new Set();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map();
  const roots = [];
  for (const node of nodes) {
    if (node.parent !== undefined && byId.has(node.parent)) {
      if (!children.has(node.parent)) {
        children.set(node.parent, []);
      }
      children.get(node.parent).push(node);
    } else {
      roots.push(node);
    }
  }
  const kids = (node) => children.get(node.id) || [];
  const hasForks = (node) => kids(node).some((c) => !c.cont);

  // Lanes: a root or a fork, then its chain of continuations. Main lane first, then breadth first.
  const lanes = [];
  const queue = roots.map((start) => ({ start, parent: undefined }));
  while (queue.length > 0) {
    const { start, parent } = queue.shift();
    const chain = [start];
    for (let n = start; ;) {
      const next = kids(n).find((c) => c.cont);
      if (!next) {
        break;
      }
      chain.push(next);
      n = next;
    }
    lanes.push({ chain, parent });
    for (const n of chain) {
      for (const child of kids(n)) {
        if (!child.cont) {
          queue.push({ start: child, parent: n.id });
        }
      }
    }
  }

  const cells = [];
  const edges = [];
  const cellOf = new Map();
  const occupied = []; // per row: [{lo, hi}]
  let cols = 0;
  let rows = 0;

  const fits = (row, lo, hi) => !(occupied[row] || []).some((iv) => iv.lo <= hi && lo <= iv.hi);

  lanes.forEach((lane, laneIndex) => {
    const items = foldLane(lane.chain, { current, expanded, hasForks });
    const parentCell = lane.parent !== undefined ? cellOf.get(lane.parent) : undefined;
    const startCol = parentCell ? parentCell.col + 1 : 0;
    const endCol = startCol + items.length - 1;
    const lo = parentCell ? parentCell.col + 0.5 : startCol;
    let row = laneIndex === 0 ? 0 : parentCell ? parentCell.row + 1 : 1;
    while (!fits(row, lo, endCol)) {
      row++;
    }
    (occupied[row] = occupied[row] || []).push({ lo, hi: endCol });
    let previous = parentCell;
    items.forEach((item, i) => {
      const cell = item.fold
        ? { kind: 'fold', key: item.key, ids: item.ids, col: startCol + i, row }
        : { kind: 'node', node: item.node, col: startCol + i, row };
      cells.push(cell);
      for (const id of item.fold ? item.ids : [item.node.id]) {
        cellOf.set(id, cell);
      }
      if (previous) {
        edges.push({ from: [previous.col, previous.row], to: [cell.col, cell.row], fork: i === 0 });
      }
      previous = cell;
    });
    cols = Math.max(cols, endCol + 1);
    rows = Math.max(rows, row + 1);
  });

  return { cells, edges, cols, rows, cellOf };
}

/** The items of a lane: its nodes, with long runs of plain sent pages folded. */
function foldLane(chain, { current, expanded, hasForks }) {
  const near = new Set();
  chain.forEach((n, i) => {
    if (n.id === current) {
      near
        .add(i - 1)
        .add(i)
        .add(i + 1);
    }
  });
  const foldable = (n, i) =>
    i > 0 && i < chain.length - 2 && n.state === 'sent' && !n.virtual && !hasForks(n) && !near.has(i);
  const items = [];
  let run = [];
  const closeRun = () => {
    if (run.length >= FOLD_MIN && !expanded.has(run[0].id)) {
      items.push({ fold: true, key: run[0].id, ids: run.map((n) => n.id) });
    } else {
      run.forEach((node) => items.push({ node }));
    }
    run = [];
  };
  chain.forEach((n, i) => {
    if (foldable(n, i)) {
      run.push(n);
    } else {
      closeRun();
      items.push({ node: n });
    }
  });
  closeRun();
  return items;
}

module.exports = { layoutGraph, FOLD_MIN };
