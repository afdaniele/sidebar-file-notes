/**
 * Handoffs waiting for a conversation: forks marked "handed off" whose new conversation has not taken
 * them yet. Kept in the workspace state (not in the notes folder). No vscode import.
 */

export interface PendingHandoff {
  /** Folder of the note the fork belongs to. */
  noteDir: string;
  pageId: string;
  /** Title of the fork page. */
  title: string;
  /** Title of the note it comes from. */
  from: string;
  created: string;
}

/** The part of `vscode.Memento` used here. */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

const KEY = 'sidebarFileNotes.pendingHandoffs';

export class HandoffRegistry {
  constructor(private readonly storage: KeyValueStore) {}

  list(): PendingHandoff[] {
    const value = this.storage.get<PendingHandoff[]>(KEY);
    return Array.isArray(value) ? value : [];
  }

  async add(handoff: PendingHandoff): Promise<void> {
    const others = this.list().filter((h) => !same(h, handoff));
    await this.storage.update(KEY, [...others, handoff]);
  }

  async remove(noteDir: string, pageId?: string): Promise<void> {
    const kept = this.list().filter((h) => h.noteDir !== noteDir || (pageId !== undefined && h.pageId !== pageId));
    if (kept.length !== this.list().length) {
      await this.storage.update(KEY, kept);
    }
  }

  /** The note moved (a pending conversation note got its session). */
  async moveNote(from: string, to: string): Promise<void> {
    const list = this.list();
    if (list.some((h) => h.noteDir === from)) {
      await this.storage.update(
        KEY,
        list.map((h) => (h.noteDir === from ? { ...h, noteDir: to } : h))
      );
    }
  }
}

export function handoffId(h: { noteDir: string; pageId: string }): string {
  return `${h.noteDir}#${h.pageId}`;
}

function same(a: PendingHandoff, b: PendingHandoff): boolean {
  return a.noteDir === b.noteDir && a.pageId === b.pageId;
}
