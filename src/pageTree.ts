/**
 * The tree of a note's pages: the main line (each sent page continued by the next one), forks hanging
 * off it, navigation, deletion plans and what the webview shows. No vscode import.
 */
import { MetaPatch, Page, pageTitle, PageState } from './pages';

export interface TreeNode {
  page: Page;
  parent?: TreeNode;
  /** The continuation first (if any), then the forks, each group by creation. */
  children: TreeNode[];
  /** Whether this node continues its parent's lane instead of forking from it. */
  cont: boolean;
  depth: number;
}

export interface PageTree {
  nodes: Map<string, TreeNode>;
  /** The main root first, then other roots (pages whose parent is missing) by creation. */
  roots: TreeNode[];
  /** The main root and its chain of continuations. */
  mainLine: TreeNode[];
}

export function buildTree(pages: Page[]): PageTree {
  const nodes = new Map<string, TreeNode>();
  for (const page of pages) {
    nodes.set(page.id, { page, children: [], cont: false, depth: 0 });
  }
  const parentOf = new Map<TreeNode, TreeNode | undefined>();
  for (const node of nodes.values()) {
    const parentId = node.page.meta.parent;
    const parent = parentId !== undefined && parentId !== node.page.id ? nodes.get(parentId) : undefined;
    parentOf.set(node, parent);
  }
  // Break cycles (only possible through hand edits): a node on a cycle becomes a root.
  for (const node of nodes.values()) {
    const seen = new Set<TreeNode>([node]);
    for (let p = parentOf.get(node); p; p = parentOf.get(p)) {
      if (seen.has(p)) {
        parentOf.set(node, undefined);
        break;
      }
      seen.add(p);
    }
  }
  const roots: TreeNode[] = [];
  for (const node of [...nodes.values()].sort(byCreation)) {
    const parent = parentOf.get(node);
    if (parent) {
      node.parent = parent;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  for (const node of nodes.values()) {
    const continuation = node.children.find((c) => !c.page.meta.fork);
    if (continuation) {
      continuation.cont = true;
      node.children = [continuation, ...node.children.filter((c) => c !== continuation)];
    }
  }
  const mainIndex = Math.max(
    0,
    roots.findIndex((r) => !r.page.meta.fork)
  );
  if (roots.length > 0) {
    roots.unshift(...roots.splice(mainIndex, 1));
  }
  const setDepth = (node: TreeNode, depth: number) => {
    node.depth = depth;
    node.children.forEach((c) => setDepth(c, depth + 1));
  };
  roots.forEach((r) => setDepth(r, 0));

  const mainLine: TreeNode[] = [];
  for (let n: TreeNode | undefined = roots[0]; n; n = n.children.find((c) => c.cont)) {
    mainLine.push(n);
  }
  return { nodes, roots, mainLine };
}

/** The end of the main line: the current draft. */
export function mainTip(tree: PageTree): TreeNode | undefined {
  return tree.mainLine[tree.mainLine.length - 1];
}

export function isOnMainLine(tree: PageTree, id: string): boolean {
  return tree.mainLine.some((n) => n.page.id === id);
}

/** The latest page sent on the main line. */
export function latestSent(tree: PageTree): TreeNode | undefined {
  return [...tree.mainLine].reverse().find((n) => n.page.meta.state === 'sent');
}

/**
 * The page a fork made from `id` hangs off, or undefined when forking is not offered there.
 * For now forks only come off the latest sent page (from it, its continuation or its other forks).
 */
export function forkParent(tree: PageTree, id: string): string | undefined {
  const latest = latestSent(tree);
  const node = tree.nodes.get(id);
  if (!latest || !node) {
    return undefined;
  }
  return node === latest || node.parent === latest ? latest.page.id : undefined;
}

/**
 * Where a fork made "next to" page `id` without leaving it goes: a sibling of `id` when it can be forked
 * from, else a sibling of the current draft. Undefined while nothing was sent.
 */
export function siblingForkParent(tree: PageTree, id: string): string | undefined {
  const tip = mainTip(tree);
  return forkParent(tree, id) ?? (tip ? forkParent(tree, tip.page.id) : undefined);
}

export function siblingsOf(tree: PageTree, node: TreeNode): TreeNode[] {
  return node.parent ? node.parent.children : tree.roots;
}

export type Direction = 'back' | 'forward' | 'up' | 'down' | 'tip';

/** The page reached from `id` in a direction. `preferredChild` is the child last visited, for `forward`. */
export function neighbor(
  tree: PageTree,
  id: string,
  direction: Direction,
  preferredChild?: string
): string | undefined {
  const node = tree.nodes.get(id);
  if (direction === 'tip') {
    const tip = mainTip(tree);
    return tip && tip.page.id !== id ? tip.page.id : undefined;
  }
  if (!node) {
    return undefined;
  }
  switch (direction) {
    case 'back':
      return node.parent?.page.id;
    case 'forward': {
      const preferred = node.children.find((c) => c.page.id === preferredChild);
      return (preferred ?? node.children[0])?.page.id;
    }
    case 'up':
    case 'down': {
      const siblings = siblingsOf(tree, node);
      const index = siblings.indexOf(node) + (direction === 'up' ? -1 : 1);
      return siblings[index]?.page.id;
    }
  }
}

export interface DeletePlan {
  /** Pages to delete. */
  remove: string[];
  /** Header changes of the pages that stay (children moved to the deleted page's parent). */
  update: { id: string; patch: MetaPatch }[];
}

/**
 * Deleting a page either deletes its subtree, or keeps its children by attaching them to its parent.
 * The continuation then takes the deleted page's place, fork flag included, so the main line stays whole.
 */
export function planDelete(tree: PageTree, id: string, mode: 'subtree' | 'keepChildren'): DeletePlan {
  const node = tree.nodes.get(id);
  if (!node) {
    return { remove: [], update: [] };
  }
  if (mode === 'subtree') {
    const remove: string[] = [];
    const walk = (n: TreeNode) => {
      remove.push(n.page.id);
      n.children.forEach(walk);
    };
    walk(node);
    return { remove, update: [] };
  }
  const parent = node.page.meta.parent && node.parent ? node.parent.page.id : null;
  const update = node.children.map((child) => ({
    id: child.page.id,
    patch: child.cont ? { parent, fork: node.page.meta.fork ? true : null } : { parent }
  }));
  return { remove: [id], update };
}

/** Real (not in-memory) descendants: what a deletion would lose besides the page itself. */
export function realDescendants(node: TreeNode): number {
  return node.children.reduce((sum, c) => sum + (c.page.virtual ? 0 : 1) + realDescendants(c), 0);
}

// ---- what the webview shows ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  parent?: string;
  cont: boolean;
  state: PageState;
  virtual: boolean;
  title: string;
  label: string;
}

export type PageAction =
  | 'copy'
  | 'markSent'
  | 'undoSent'
  | 'fork'
  | 'split'
  | 'handOff'
  | 'cancelHandOff'
  | 'copyToDraft'
  | 'drop'
  | 'reopen'
  | 'editAnyway'
  | 'delete';

export interface PageInfo {
  id: string;
  state: PageState;
  virtual: boolean;
  editable: boolean;
  fork: boolean;
  mainLine: boolean;
  label: string;
  sentAt?: string;
  actions: PageAction[];
  nav: Record<Direction, boolean>;
}

export interface PageModel {
  /** Preorder, children in display order, so the webview can lay them out without sorting. */
  nodes: GraphNode[];
  page: PageInfo;
}

export function nodeLabel(tree: PageTree, node: TreeNode): string {
  const siblings = siblingsOf(tree, node);
  const position = siblings.length > 1 ? ` · ${siblings.indexOf(node) + 1}/${siblings.length}` : '';
  const kind = isOnMainLine(tree, node.page.id) ? '' : ' · fork';
  return `Turn ${node.depth + 1}${kind}${position}`;
}

/** The model of page `id`. `unlocked`: the user chose to edit this sent page anyway. */
export function pageModel(
  tree: PageTree,
  id: string,
  options: { unlocked?: boolean; preferredChild?: string } = {}
): PageModel | undefined {
  const node = tree.nodes.get(id);
  if (!node) {
    return undefined;
  }
  const nodes: GraphNode[] = [];
  const walk = (n: TreeNode) => {
    nodes.push({
      id: n.page.id,
      parent: n.parent?.page.id,
      cont: n.cont,
      state: n.page.meta.state,
      virtual: !!n.page.virtual,
      title: pageTitle(n.page) || (n.page.virtual ? 'Empty draft' : 'Empty page'),
      label: nodeLabel(tree, n)
    });
    n.children.forEach(walk);
  };
  tree.roots.forEach(walk);

  const { page } = node;
  const state = page.meta.state;
  const mainLine = isOnMainLine(tree, id);
  const tip = mainTip(tree);
  const isTip = tip === node;
  const fork = !mainLine;
  const editable = state === 'draft' || !!options.unlocked;
  const actions: PageAction[] = [];
  if (page.body.trim() !== '') {
    actions.push('copy');
  }
  if (isTip && state === 'draft') {
    actions.push('markSent');
  }
  if (forkParent(tree, id) !== undefined) {
    actions.push('fork');
    if (isTip && state === 'draft') {
      actions.push('split');
    }
  }
  if (canUndoSent(tree, id)) {
    actions.push('undoSent');
  }
  if (fork) {
    if (state === 'draft') {
      actions.push('handOff', 'drop');
    } else if (state === 'handed-off' && !page.meta.handoffTo) {
      actions.push('cancelHandOff');
    } else if (state === 'dropped') {
      actions.push('reopen');
    }
    if (page.body.trim() !== '' && tip && tip.page.meta.state === 'draft') {
      actions.push('copyToDraft');
    }
  }
  if ((state === 'sent' || state === 'handed-off') && !options.unlocked) {
    actions.push('editAnyway');
  }
  if (!(page.virtual && !page.meta.fork)) {
    actions.push('delete');
  }
  return {
    nodes,
    page: {
      id,
      state,
      virtual: !!page.virtual,
      editable,
      fork,
      mainLine,
      label: nodeLabel(tree, node),
      sentAt: page.meta.sentAt,
      actions,
      nav: {
        back: neighbor(tree, id, 'back') !== undefined,
        forward: neighbor(tree, id, 'forward', options.preferredChild) !== undefined,
        up: neighbor(tree, id, 'up') !== undefined,
        down: neighbor(tree, id, 'down') !== undefined,
        tip: neighbor(tree, id, 'tip') !== undefined
      }
    }
  };
}

/** The latest sent page can go back to draft while nothing was written after it. */
export function canUndoSent(tree: PageTree, id: string): boolean {
  const node = tree.nodes.get(id);
  const tip = mainTip(tree);
  return (
    !!node &&
    !!tip &&
    node.page.meta.state === 'sent' &&
    tip.parent === node &&
    node.children.length === 1 &&
    tip.page.body.trim() === ''
  );
}

function byCreation(a: TreeNode, b: TreeNode): number {
  const ca = a.page.meta.created ?? '';
  const cb = b.page.meta.created ?? '';
  if (ca !== cb) {
    return ca < cb ? -1 : 1;
  }
  return a.page.id < b.page.id ? -1 : a.page.id > b.page.id ? 1 : 0;
}
