/**
 * One note in memory: the pages of its folder plus pages that exist only in memory (empty drafts), and
 * every change to them. No vscode import.
 *
 * Rules kept here:
 * - an empty draft without children has no file (it is "virtual"), so looking at things never litters
 *   the disk, yet it keeps its id and place while the extension runs;
 * - the main line always ends with a draft: when its last page is not a draft, a virtual continuation
 *   is added (and an empty note gets a virtual root).
 */
import * as path from 'path';

import { NoteStore } from './noteStore';
import { buildTree, DeletePlan, mainTip, PageTree } from './pageTree';
import {
  applyPatch,
  isPageId,
  MetaPatch,
  newPageId,
  Page,
  PAGE_EXTENSION,
  PageMeta,
  parsePage,
  serializePage
} from './pages';

export class PageNote {
  private real = new Map<string, Page>();
  private readonly memory = new Map<string, Page>();
  private lastStamp?: string;

  constructor(
    readonly dir: string,
    private readonly store: NoteStore,
    private readonly newId: () => string = () => newPageId(),
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  fileOf(id: string): string {
    return path.join(this.dir, `${id}${PAGE_EXTENSION}`);
  }

  /** Reads the folder again. Pages that exist only in memory are kept unless a file took their id. */
  async load(): Promise<void> {
    const files = await this.store.list(this.dir);
    const real = new Map<string, Page>();
    for (const { name, text } of files) {
      const id = name.slice(0, -PAGE_EXTENSION.length);
      if (isPageId(id)) {
        real.set(id, parsePage(id, text));
      }
    }
    this.real = real;
    for (const id of [...this.memory.keys()]) {
      if (real.has(id)) {
        this.memory.delete(id);
      }
    }
  }

  get(id: string): Page | undefined {
    return this.real.get(id) ?? this.memory.get(id);
  }

  /** Whether the note has any page with a file. */
  get hasFiles(): boolean {
    return this.real.size > 0;
  }

  realPages(): Page[] {
    return [...this.real.values()];
  }

  /** The tree, after making sure the main line ends with a draft. */
  tree(): PageTree {
    this.pruneMemory();
    let tree = buildTree(this.pages());
    const tip = mainTip(tree);
    if (!tip || tip.page.meta.state !== 'draft') {
      this.addToMemory({ parent: tip?.page.id, state: 'draft' });
      tree = buildTree(this.pages());
    }
    return tree;
  }

  /** Adds an empty page in memory; it gets a file once it has content. */
  create(meta: Omit<PageMeta, 'created'>): Page {
    return this.addToMemory(meta);
  }

  /** Adds a page with content and writes it. */
  async createWith(meta: Omit<PageMeta, 'created'>, body: string): Promise<Page> {
    const page = this.addToMemory(meta);
    page.body = body;
    await this.persist(page);
    return page;
  }

  async setBody(id: string, body: string): Promise<void> {
    const page = this.get(id);
    if (!page) {
      return;
    }
    page.body = body;
    await this.persist(page);
  }

  async update(id: string, patch: MetaPatch): Promise<void> {
    const page = this.get(id);
    if (!page) {
      return;
    }
    page.meta = applyPatch(page.meta, patch);
    await this.persist(page);
  }

  async remove(ids: string[]): Promise<void> {
    const removals: Promise<void>[] = [];
    for (const id of ids) {
      if (this.memory.delete(id)) {
        continue;
      }
      if (this.real.delete(id)) {
        removals.push(this.store.remove(this.fileOf(id)));
      }
    }
    await Promise.all(removals);
  }

  async apply(plan: DeletePlan): Promise<void> {
    const removing = new Set(plan.remove);
    // Move the children first, so a crash in between leaves orphans rather than lost pages.
    for (const { id, patch } of plan.update) {
      if (!removing.has(id)) {
        await this.update(id, patch);
      }
    }
    await this.remove(plan.remove);
  }

  /** What the file of a page holds (or would hold). */
  serialized(id: string): string | undefined {
    const page = this.get(id);
    return page ? serializePage(page) : undefined;
  }

  /** Gives an in-memory page a file (to open it in an editor). Returns the file. */
  async materialize(id: string): Promise<string | undefined> {
    const page = this.get(id);
    if (!page) {
      return undefined;
    }
    if (page.virtual) {
      page.virtual = false;
      this.memory.delete(id);
      this.real.set(id, page);
    }
    await this.store.write(this.fileOf(id), serializePage(page));
    return this.fileOf(id);
  }

  private pages(): Page[] {
    return [...this.real.values(), ...this.memory.values()];
  }

  private addToMemory(meta: Omit<PageMeta, 'created'>): Page {
    let id = this.newId();
    while (this.get(id)) {
      id = this.newId();
    }
    const page: Page = { id, meta: { ...meta, created: this.timestamp() }, body: '', virtual: true };
    this.memory.set(id, page);
    return page;
  }

  /** `now()`, but strictly increasing, so pages made in one go keep their order. */
  private timestamp(): string {
    let stamp = this.now();
    if (this.lastStamp !== undefined && stamp <= this.lastStamp) {
      const bumped = new Date(Date.parse(this.lastStamp) + 1);
      stamp = Number.isNaN(bumped.getTime()) ? stamp : bumped.toISOString();
    }
    this.lastStamp = stamp;
    return stamp;
  }

  /**
   * Drops in-memory pages that lost their place: a draft whose parent is gone, a continuation of a page
   * that already has one on disk or is not sent anymore, a second empty root.
   */
  private pruneMemory(): void {
    for (const page of [...this.memory.values()]) {
      const parentId = page.meta.parent;
      const parent = parentId !== undefined ? this.get(parentId) : undefined;
      let keep: boolean;
      if (parentId !== undefined && !parent) {
        keep = false;
      } else if (page.meta.fork) {
        keep = true;
      } else if (!parent) {
        keep = ![...this.real.values()].some(
          (p) => !p.meta.fork && (p.meta.parent === undefined || !this.get(p.meta.parent))
        );
      } else {
        keep =
          parent.meta.state !== 'draft' &&
          !this.pages().some((p) => p !== page && p.meta.parent === parentId && !p.meta.fork && !p.virtual);
      }
      if (!keep) {
        this.memory.delete(page.id);
      }
    }
  }

  /** Writes a page, or deletes its file when it is an empty draft nothing depends on. */
  private async persist(page: Page): Promise<void> {
    const hasChildren = this.pages().some((p) => p.meta.parent === page.id);
    const disposable = page.body.trim() === '' && page.meta.state === 'draft' && !hasChildren && !page.meta.from;
    const file = this.fileOf(page.id);
    if (disposable) {
      if (!page.virtual) {
        page.virtual = true;
        this.real.delete(page.id);
        this.memory.set(page.id, page);
        await this.store.remove(file);
      }
      return;
    }
    if (page.virtual) {
      page.virtual = false;
      this.memory.delete(page.id);
      this.real.set(page.id, page);
    }
    await this.store.write(file, serializePage(page));
  }
}
