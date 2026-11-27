import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ClaudeSessionIndex, matchScore, projectDirName, sessionScore } from '../claudeSessions';

describe('projectDirName', () => {
  it('encodes a working directory like Claude Code does', () => {
    assert.strictEqual(
      projectDirName('/home/me/workspace/code/me/example.com'),
      '-home-me-workspace-code-me-example-com'
    );
  });
});

describe('matchScore', () => {
  it('matches equal titles', () => {
    assert.strictEqual(matchScore('Fix the login bug', 'Fix the login bug'), 3);
    assert.strictEqual(matchScore(' Fix  the login\nbug ', 'Fix the login bug'), 3);
  });

  it('matches a title truncated for the tab', () => {
    // Claude Code opens tabs with the first 24 characters and an ellipsis.
    assert.strictEqual(matchScore('Sidebar-markdown-notes p…', 'Sidebar-markdown-notes per-file notes'), 2);
    // A truncated last prompt matches the longer label.
    assert.strictEqual(matchScore('I have a website that I log into', 'I have a website…'), 2);
  });

  it('does not match different titles, empty ones or tiny prefixes', () => {
    assert.strictEqual(matchScore('Fix the login bug', 'Fix the logout bug'), 0);
    assert.strictEqual(matchScore('Fix', undefined), 0);
    assert.strictEqual(matchScore('F…', 'Fix the login bug'), 0);
  });
});

describe('sessionScore', () => {
  const base = { sessionId: 's', file: '/x/s.jsonl', mtimeMs: 0 };

  it('prefers the current title over older ones', () => {
    const renamed = { ...base, customTitle: 'My rename', aiTitle: 'Generated title' };
    assert.strictEqual(sessionScore('My rename', renamed), 30);
    assert.strictEqual(sessionScore('Generated title', renamed), 25);
    assert.strictEqual(sessionScore('Something else', renamed), 0);
  });
});

describe('ClaudeSessionIndex', () => {
  let configDir: string;
  const workspace = '/home/me/project';
  let projectDir: string;

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfn-claude-'));
    projectDir = path.join(configDir, 'projects', projectDirName(workspace));
    await fs.mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(configDir, { recursive: true, force: true });
  });

  const line = (record: object) => JSON.stringify(record) + '\n';
  const transcript = (dir: string, id: string) => path.join(dir, `${id}.jsonl`);

  it('finds a session by its generated title and follows renames appended later', async () => {
    const file = transcript(projectDir, 'aaaa-1111');
    await fs.writeFile(
      file,
      line({ type: 'user', message: { content: 'a "type":"custom-title" lookalike in a message' } }) +
        line({ type: 'ai-title', aiTitle: 'Debugging the parser', sessionId: 'aaaa-1111' })
    );
    const index = new ClaudeSessionIndex(() => configDir);
    const found = await index.find('Debugging the parser', { projectPaths: [workspace] });
    assert.strictEqual(found?.sessionId, 'aaaa-1111');
    assert.strictEqual(found?.customTitle, undefined);

    await fs.appendFile(file, line({ type: 'custom-title', customTitle: 'Parser notes', sessionId: 'aaaa-1111' }));
    const renamed = await index.get('aaaa-1111');
    assert.strictEqual(renamed?.customTitle, 'Parser notes');
    assert.strictEqual((await index.find('Parser notes', { projectPaths: [workspace] }))?.sessionId, 'aaaa-1111');
  });

  it('ignores a partial last line until it is complete', async () => {
    const file = transcript(projectDir, 'bbbb');
    const record = line({ type: 'ai-title', aiTitle: 'Half written', sessionId: 'bbbb' });
    await fs.writeFile(file, record.slice(0, 20));
    const index = new ClaudeSessionIndex(() => configDir);
    assert.strictEqual(await index.find('Half written', { projectPaths: [workspace] }), undefined);
    await fs.appendFile(file, record.slice(20));
    assert.strictEqual((await index.find('Half written', { projectPaths: [workspace] }))?.sessionId, 'bbbb');
  });

  it('skips very long lines without losing the records after them', async () => {
    const file = transcript(projectDir, 'cccc');
    await fs.writeFile(
      file,
      line({ type: 'user', text: 'x'.repeat(3 * 1024 * 1024) }) +
        line({ type: 'ai-title', aiTitle: 'After a big line' })
    );
    const index = new ClaudeSessionIndex(() => configDir);
    assert.strictEqual((await index.find('After a big line', { projectPaths: [workspace] }))?.sessionId, 'cccc');
  });

  it('prefers sessions not attached to another tab, then the most recent one', async () => {
    const older = transcript(projectDir, 'old');
    const newer = transcript(projectDir, 'new');
    await fs.writeFile(older, line({ type: 'ai-title', aiTitle: 'Same title' }));
    await fs.writeFile(newer, line({ type: 'ai-title', aiTitle: 'Same title' }));
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(older, past, past);
    const index = new ClaudeSessionIndex(() => configDir);
    assert.strictEqual((await index.find('Same title', { projectPaths: [workspace] }))?.sessionId, 'new');
    const exclude = new Set(['new']);
    assert.strictEqual((await index.find('Same title', { projectPaths: [workspace], exclude }))?.sessionId, 'old');
  });

  it('falls back to other projects and never matches the placeholder label', async () => {
    const otherDir = path.join(configDir, 'projects', projectDirName('/somewhere/else'));
    await fs.mkdir(otherDir, { recursive: true });
    await fs.writeFile(transcript(otherDir, 'dddd'), line({ type: 'ai-title', aiTitle: 'Elsewhere' }));
    await fs.writeFile(transcript(projectDir, 'eeee'), line({ type: 'ai-title', aiTitle: 'Claude Code' }));
    const index = new ClaudeSessionIndex(() => configDir);
    assert.strictEqual((await index.find('Elsewhere', { projectPaths: [workspace] }))?.sessionId, 'dddd');
    assert.strictEqual(await index.find('Claude Code', { projectPaths: [workspace] }), undefined);
  });
});
