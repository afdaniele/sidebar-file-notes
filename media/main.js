// Runs inside the notes webview. Bundled by webpack into dist/webview.js.
// The extension owns the notes: it sends `load` with the note of the focused tab, and this script sends
// `save` with the note's key whenever the text changes, so a late save never lands in another note.
import DOMPurify from 'dompurify';
import { marked } from 'marked';

import { toggleTask } from './tasks';

const SAVE_DELAY_MS = 300;

const vscode = acquireVsCodeApi();

const elements = {
  header: document.getElementById('header'),
  kind: document.getElementById('kind'),
  title: document.getElementById('title'),
  lock: document.getElementById('lock'),
  detail: document.getElementById('detail'),
  empty: document.getElementById('empty'),
  render: document.getElementById('render'),
  content: document.getElementById('content'),
  input: document.getElementById('text-input')
};

const KIND_LABELS = { file: 'File', claude: 'Claude', 'claude-pending': 'Claude' };

/** The note shown: `key` is its file path, undefined when there is no note. */
let note = { key: undefined, content: '' };
let mode = (vscode.getState() || {}).mode === 'render' ? 'render' : 'editor';
let saveTimer;

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    // Clickable checkboxes: the default renderer disables them.
    checkbox(checked) {
      return `<input ${checked ? 'checked="" ' : ''}type="checkbox"> `;
    },
    list(body, ordered, start) {
      const type = ordered ? 'ol' : 'ul';
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
      const todo = /type="checkbox"/.test(body) ? ' class="todoList"' : '';
      return `<${type}${startAttr}${todo}>\n${body}</${type}>\n`;
    }
  }
});

// ---- saving -------------------------------------------------------------------------------------------

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (note.key === undefined) {
    return;
  }
  if (mode === 'editor' && elements.input.value !== note.content) {
    note.content = elements.input.value;
  }
  vscode.postMessage({ type: 'save', key: note.key, content: note.content });
}

/** Sends typing that is waiting for the save delay. */
function flush() {
  if (saveTimer !== undefined) {
    saveNow();
  }
}

function isDirty() {
  return (
    saveTimer !== undefined || (mode === 'editor' && note.key !== undefined && elements.input.value !== note.content)
  );
}

// ---- rendering ----------------------------------------------------------------------------------------

function show(el, visible) {
  el.classList.toggle('hidden', !visible);
}

function renderHeader(meta) {
  show(elements.header, meta.key !== undefined);
  elements.kind.textContent = KIND_LABELS[meta.kind] || '';
  elements.kind.className = `kind-${meta.kind || 'none'}`;
  elements.title.textContent = meta.title || '';
  elements.title.title = meta.title || '';
  elements.detail.textContent = meta.detail || '';
  elements.detail.title = meta.detail || '';
}

function renderLock(locked) {
  show(elements.lock, !!locked);
}

function renderBody() {
  const hasNote = note.key !== undefined;
  show(elements.empty, !hasNote);
  show(elements.render, hasNote && mode === 'render');
  show(elements.content, hasNote && mode === 'editor');
  if (!hasNote) {
    return;
  }
  if (mode === 'editor') {
    if (elements.input.value !== note.content) {
      elements.input.value = note.content;
    }
    return;
  }
  if (note.content.trim() === '') {
    elements.render.innerHTML = '<p class="placeholder">No notes yet. Double-click to start writing.</p>';
    return;
  }
  elements.render.innerHTML = DOMPurify.sanitize(marked.parse(note.content));
  elements.render.querySelectorAll('input[type="checkbox"]').forEach((box, index) => {
    box.addEventListener('click', (event) => {
      event.preventDefault();
      note.content = toggleTask(note.content, index);
      saveNow();
      renderBody();
    });
  });
}

function setMode(next) {
  if (mode === 'editor') {
    note.content = elements.input.value;
  }
  mode = next;
  vscode.setState({ mode });
  renderBody();
  if (mode === 'editor' && note.key !== undefined) {
    elements.input.focus();
  }
}

// ---- messages from the extension ----------------------------------------------------------------------

window.addEventListener('message', (event) => {
  const message = event.data;
  switch (message.type) {
    case 'load': {
      flush();
      note = { key: message.key, content: message.content || '' };
      elements.input.placeholder = message.title ? `Notes on ${message.title}…` : '';
      renderHeader(message);
      renderLock(message.locked);
      elements.input.value = note.content;
      elements.input.setSelectionRange(0, 0);
      elements.input.scrollTop = 0;
      elements.render.scrollTop = 0;
      renderBody();
      break;
    }
    case 'meta': {
      if (message.key === note.key) {
        renderHeader(message);
        elements.input.placeholder = message.title ? `Notes on ${message.title}…` : '';
      }
      break;
    }
    case 'external': {
      if (message.key === note.key && !isDirty()) {
        note.content = message.content;
        renderBody();
      }
      break;
    }
    case 'locked':
      renderLock(message.locked);
      break;
    case 'flush':
      flush();
      vscode.postMessage({ type: 'flushed', id: message.id });
      break;
    case 'togglePreview':
      setMode(mode === 'editor' ? 'render' : 'editor');
      break;
  }
});

// ---- input --------------------------------------------------------------------------------------------

elements.input.addEventListener('input', scheduleSave);
elements.input.addEventListener('blur', flush);
window.addEventListener('blur', flush);
window.addEventListener('pagehide', flush);

elements.input.addEventListener('keydown', (event) => {
  if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    // Indent instead of moving focus; execCommand keeps the edit on the undo stack.
    event.preventDefault();
    document.execCommand('insertText', false, '  ');
  }
});

elements.render.addEventListener('dblclick', (event) => {
  if (event.target instanceof Element && event.target.closest('a, input')) {
    return;
  }
  setMode('editor');
});

renderBody();
vscode.postMessage({ type: 'ready' });
