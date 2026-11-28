/**
 * Reads and writes the files of notes (one folder per note, one file per page). Writes to the same file are
 * serialized so they land in order. `write` with empty content deletes the file.
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

  /** Deletes a file, after the writes queued for it. */
  remove(file: string): Promise<void> {
    return this.enqueue(file, async () => {
      this.lastWritten.set(file, '');
      await removeIfExists(file);
    });
  }

  /** The `.md` files directly inside `dir` (none when it does not exist), after their queued writes. */
  async list(dir: string): Promise<{ name: string; text: string }[]> {
    await this.idleUnder(dir);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') {
        return [];
      }
      throw err;
    }
    const files: { name: string; text: string }[] = [];
    for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
      try {
        files.push({ name, text: await fs.readFile(path.join(dir, name), 'utf8') });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && (err as NodeJS.ErrnoException).code !== 'EISDIR') {
          throw err;
        }
      }
    }
    return files;
  }

  /** Waits for the queued writes to every file inside `dir`. */
  async idleUnder(dir: string): Promise<void> {
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    await Promise.all([...this.queues.entries()].filter(([file]) => file.startsWith(prefix)).map(([, q]) => q));
  }

  /** Deletes a folder and everything in it. */
  async removeDir(dir: string): Promise<void> {
    await this.idleUnder(dir);
    await fs.rm(dir, { recursive: true, force: true });
  }

  /**
   * Moves the `.md` files of `from` into `to` (skipping names `to` already has) and removes `from` if
   * that leaves it empty. Returns the names moved.
   */
  async moveFiles(from: string, to: string): Promise<string[]> {
    if (from === to) {
      return [];
    }
    await Promise.all([this.idleUnder(from), this.idleUnder(to)]);
    const moved: string[] = [];
    let names: string[];
    try {
      names = await fs.readdir(from);
    } catch {
      return moved;
    }
    await fs.mkdir(to, { recursive: true });
    for (const name of names.filter((n) => n.endsWith('.md'))) {
      const target = path.join(to, name);
      if (await exists(target)) {
        continue;
      }
      await fs.rename(path.join(from, name), target);
      this.lastWritten.delete(path.join(from, name));
      moved.push(name);
    }
    try {
      await fs.rmdir(from);
    } catch {
      // Not empty: something was left behind on purpose.
    }
    return moved;
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
