/**
 * Reads and writes note files. Writes to the same file are serialized so they land in order, and an
 * empty note deletes its file so that looking at a file never leaves an empty note behind.
 */
import { promises as fs } from 'fs';
import * as path from 'path';

export class NoteStore {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly lastWritten = new Map<string, string>();

  async read(file: string): Promise<string> {
    await this.idle(file);
    return readOrEmpty(file);
  }

  write(file: string, content: string): Promise<void> {
    return this.enqueue(file, async () => {
      this.lastWritten.set(file, content);
      if (content.trim() === '') {
        await removeIfExists(file);
      } else {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, content, 'utf8');
      }
    });
  }

  /** Whether `content` is what this store last wrote to `file`, i.e. a watcher event is our own echo. */
  isOwnWrite(file: string, content: string): boolean {
    const last = this.lastWritten.get(file);
    return last !== undefined && (last === content || (last.trim() === '' && content === ''));
  }

  /** Waits for the queued writes to `file` to finish. */
  async idle(file: string): Promise<void> {
    await this.queues.get(file);
  }

  /** Moves the note `from` into `to`, appending it when `to` already has content. */
  merge(from: string, to: string): Promise<void> {
    if (from === to) {
      return this.idle(from);
    }
    return this.enqueue(from, () =>
      this.enqueue(to, async () => {
        const moved = await readOrEmpty(from);
        if (moved.trim() !== '') {
          const existing = await readOrEmpty(to);
          const merged = existing.trim() === '' ? moved : `${existing.replace(/\s+$/, '')}\n\n${moved}`;
          await fs.mkdir(path.dirname(to), { recursive: true });
          await fs.writeFile(to, merged, 'utf8');
          this.lastWritten.set(to, merged);
        }
        await removeIfExists(from);
        this.lastWritten.set(from, '');
      })
    );
  }

  /** Renames a note file or folder, unless the source is missing or the destination already exists. */
  async rename(from: string, to: string): Promise<boolean> {
    await Promise.all([this.idle(from), this.idle(to)]);
    if (!(await exists(from)) || (await exists(to))) {
      return false;
    }
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
    return true;
  }

  private enqueue(file: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(file) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.catch(() => undefined);
    this.queues.set(file, settled);
    void settled.then(() => {
      if (this.queues.get(file) === settled) {
        this.queues.delete(file);
      }
    });
    return next;
  }
}

async function readOrEmpty(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw err;
  }
}

async function removeIfExists(file: string): Promise<void> {
  try {
    await fs.unlink(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
