// Runs inside the notes webview. Bundled by webpack into dist/webview.js.
// The extension owns the notes: it sends `load` with a page of the note of the focused tab, and this
// script sends `save` with the note's key and the page id whenever the text changes, so a late save
// never lands in another page.
import DOMPurify from 'dompurify';
import { marked } from 'marked';

import { layoutGraph } from './graph';
import { toggleTask } from './tasks';

const SAVE_DELAY_MS = 300;
const COL = 27;
const ROW = 27;
const PAD = 14;
/** Radius of a page dot; the ring around the current page and the fold bubble scale with it. */
const DOT = 6.75;
const SVG_NS = 'http://www.w3.org/2000/svg';

const vscode = acquireVsCodeApi();

const elements = {
  header: document.getElementById('header'),
  kind: document.getElementById('kind'),
  title: document.getElementById('title'),
  lock: document.getElementById('lock'),
  detail: document.getElementById('detail'),
  pages: document.getElementById('pages'),
  graphWrap: document.getElementById('graph-wrap'),
  graph: document.getElementById('graph'),
  graphToggle: document.getElementById('graph-toggle'),
  pageLabel: document.getElementById('page-label'),
  pageLinks: document.getElementById('page-links'),
  pageActions: document.getElementById('page-actions'),
  handoffs: document.getElementById('handoffs'),
  empty: document.getElementById('empty'),
  render: document.getElementById('render'),
  content: document.getElementById('content'),
  input: document.getElementById('text-input')
};

const KIND_LABELS = { file: 'File', claude: 'Claude', 'claude-pending': 'Claude' };
const STATE_LABELS = { draft: 'draft', sent: 'sent', 'handed-off': 'handed off', dropped: 'dropped' };

/** Buttons of the page actions, in display order: [action, label, title, primary]. */
const ACTIONS = [
  ['markSent', null, 'Freeze this page and start the next one', true],
  ['copy', 'Copy', 'Copy this page to the clipboard'],
  ['fork', 'Fork', 'Start a sibling branch of the current turn'],
  ['split', 'Split…', 'Turn top-level list items or sections into forks'],
  ['handOff', 'Hand off', 'Copy this fork to start a new conversation with it'],
  ['cancelHandOff', 'Cancel hand-off', 'Make this fork a draft again'],
  ['copyToDraft', 'To draft', 'Append this fork to the current draft'],
  ['drop', 'Drop', 'Mark this fork as abandoned'],
  ['reopen', 'Reopen', 'Make this fork a draft again'],
  ['undoSent', 'Undo sent', 'Make this page a draft again'],
  ['editAnyway', 'Edit anyway', 'This page is frozen. Edit it anyway'],
  ['delete', 'Delete', 'Delete this page']
];

/** The page shown: `key` is the note folder, undefined when there is no note. */
let note = { key: undefined, pageId: undefined, content: '', editable: true };
let model;
const saved = vscode.getState() || {};
let mode = saved.mode === 'render' ? 'render' : 'editor';
let graphHidden = !!saved.graphHidden;
/** Folds of the graph the user opened, per note. */
const expandedFolds = new Map();
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

function persistState() {
  vscode.setState({ mode, graphHidden });
}

// ---- saving -------------------------------------------------------------------------------------------

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (note.key === undefined || !note.editable) {
    return;
  }
  if (mode === 'editor' && elements.input.value !== note.content) {
    note.content = elements.input.value;
  }
  vscode.postMessage({ type: 'save', key: note.key, pageId: note.pageId, content: note.content });
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

function act(name, arg) {
  if (note.key === undefined) {
    return;
  }
  flush();
  vscode.postMessage({ type: 'action', key: note.key, pageId: note.pageId, name, arg });
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
  elements.input.readOnly = !note.editable;
  elements.content.classList.toggle('read-only', !note.editable);
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
    elements.render.innerHTML = note.editable
      ? '<p class="placeholder">Empty page. Double-click to start writing.</p>'
      : '<p class="placeholder">Empty page.</p>';
    return;
  }
  elements.render.innerHTML = DOMPurify.sanitize(marked.parse(note.content));
  elements.render.querySelectorAll('input[type="checkbox"]').forEach((box, index) => {
    if (!note.editable) {
      box.disabled = true;
      return;
    }
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
  persistState();
  renderBody();
  if (mode === 'editor' && note.key !== undefined) {
    elements.input.focus();
  }
}

function renderPages() {
  show(elements.pages, note.key !== undefined && !!model);
  if (!model) {
    return;
  }
  const page = model.page;
  const multi = model.nodes.length > 1;
  show(elements.graphWrap, multi && !graphHidden);
  show(elements.graphToggle, multi);
  elements.graphToggle.textContent = graphHidden ? '▸' : '▾';
  for (const button of elements.pages.querySelectorAll('[data-nav]')) {
    button.disabled = !page.nav[button.dataset.nav];
  }
  const state = STATE_LABELS[page.state] || page.state;
  const readOnly = !page.editable ? ' · read-only' : '';
  const when = page.sentAt ? ` ${formatTime(page.sentAt)}` : '';
  elements.pageLabel.textContent = `${page.label} · ${state}${when}${readOnly}`;
  elements.pageLabel.title = elements.pageLabel.textContent;

  elements.pageActions.replaceChildren(
    ...ACTIONS.filter(([name]) => page.actions.includes(name)).map(([name, label, title, primary]) => {
      const button = document.createElement('button');
      button.textContent = label || model.sendLabel;
      button.title = title;
      button.className = primary ? 'action primary' : 'action';
      button.addEventListener('click', () => act(name));
      return button;
    })
  );

  const links = [];
  if (model.links.from) {
    links.push(linkButton(`← Handed off from ${model.links.from.label}`, 'from'));
  }
  if (model.links.handoffTo) {
    links.push(linkButton(`→ Continued in ${model.links.handoffTo.label}`, 'handoffTo'));
  } else if (model.links.waiting) {
    const span = document.createElement('span');
    span.className = 'waiting';
    span.textContent = 'Waiting for a new conversation to start from this handoff.';
    links.push(span);
  }
  elements.pageLinks.replaceChildren(...links);
  show(elements.pageLinks, links.length > 0);

  renderHandoffs();
  if (multi && !graphHidden) {
    renderGraph();
  }
}

function linkButton(text, which) {
  const button = document.createElement('button');
  button.className = 'link';
  button.textContent = text;
  button.title = 'Show that note (locks the view to it)';
  button.addEventListener('click', () => act('openLink', which));
  return button;
}

function renderHandoffs() {
  const list = model.handoffs || [];
  show(elements.handoffs, list.length > 0);
  if (list.length === 0) {
    elements.handoffs.replaceChildren();
    return;
  }
  const intro = document.createElement('div');
  intro.textContent = 'Start this conversation from a handoff:';
  elements.handoffs.replaceChildren(
    intro,
    ...list.map((h) => {
      const button = document.createElement('button');
      button.className = 'action';
      button.textContent = h.title;
      button.title = `From ${h.from}. Becomes the first page of this note, marked sent.`;
      button.addEventListener('click', () => act('land', h.id));
      return button;
    })
  );
}

function renderGraph() {
  const expanded = expandedFolds.get(note.key) || new Set();
  const layout = layoutGraph(model.nodes, { current: note.pageId, expanded });
  const svg = elements.graph;
  const width = PAD * 2 + Math.max(0, layout.cols - 1) * COL;
  const height = PAD * 2 + Math.max(0, layout.rows - 1) * ROW;
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const x = (col) => PAD + col * COL;
  const y = (row) => PAD + row * ROW;
  const parts = [];
  for (const edge of layout.edges) {
    const [c1, r1] = edge.from;
    const [c2, r2] = edge.to;
    const path = svgEl('path', { class: edge.fork ? 'edge fork' : 'edge' });
    if (r1 === r2) {
      path.setAttribute('d', `M${x(c1)} ${y(r1)}H${x(c2)}`);
    } else {
      const mid = (x(c1) + x(c2)) / 2;
      path.setAttribute('d', `M${x(c1)} ${y(r1)}C${mid} ${y(r1)} ${mid} ${y(r2)} ${x(c2)} ${y(r2)}`);
    }
    parts.push(path);
  }
  for (const cell of layout.cells) {
    if (cell.kind === 'fold') {
      const group = svgEl('g', { class: 'fold' });
      group.appendChild(svgEl('rect', { x: x(cell.col) - 10.5, y: y(cell.row) - 7.5, width: 21, height: 15, rx: 7.5 }));
      const text = svgEl('text', { x: x(cell.col), y: y(cell.row) + 4 });
      text.textContent = String(cell.ids.length);
      group.appendChild(text);
      group.appendChild(titleEl(`${cell.ids.length} sent pages. Click to show them.`));
      group.addEventListener('click', () => {
        const set = expandedFolds.get(note.key) || new Set();
        set.add(cell.key);
        expandedFolds.set(note.key, set);
        renderGraph();
      });
      parts.push(group);
      continue;
    }
    const n = cell.node;
    const classes = ['node', `state-${n.state}`];
    if (n.virtual) {
      classes.push('virtual');
    }
    if (n.id === note.pageId) {
      classes.push('current');
    }
    const group = svgEl('g', { class: classes.join(' ') });
    if (n.id === note.pageId) {
      group.appendChild(svgEl('circle', { class: 'ring', cx: x(cell.col), cy: y(cell.row), r: DOT + 4.5 }));
    }
    group.appendChild(svgEl('circle', { class: 'dot', cx: x(cell.col), cy: y(cell.row), r: DOT }));
    group.appendChild(titleEl(`${n.label} · ${STATE_LABELS[n.state] || n.state}\n${n.title}`));
    group.addEventListener('click', () => act('goto', n.id));
    parts.push(group);
  }
  svg.replaceChildren(...parts);
  const currentCell = layout.cellOf.get(note.pageId);
  if (currentCell) {
    scrollIntoView(x(currentCell.col), y(currentCell.row));
  }
}

function scrollIntoView(cx, cy) {
  const wrap = elements.graphWrap;
  if (cx < wrap.scrollLeft + COL || cx > wrap.scrollLeft + wrap.clientWidth - COL) {
    wrap.scrollLeft = Math.max(0, cx - wrap.clientWidth / 2);
  }
  if (cy < wrap.scrollTop + ROW / 2 || cy > wrap.scrollTop + wrap.clientHeight - ROW / 2) {
    wrap.scrollTop = Math.max(0, cy - wrap.clientHeight / 2);
  }
}

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, String(value));
  }
  return el;
}

function titleEl(text) {
  const el = svgEl('title', {});
  el.textContent = text;
  return el;
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function setPlaceholder(title) {
  if (!note.editable) {
    elements.input.placeholder = '';
  } else if (model && model.page.fork) {
    elements.input.placeholder = 'A side thread: what to hand off or come back to…';
  } else {
    elements.input.placeholder = title ? `Notes on ${title}…` : '';
  }
}

// ---- messages from the extension ----------------------------------------------------------------------

window.addEventListener('message', (event) => {
  const message = event.data;
  switch (message.type) {
    case 'load': {
      flush();
      model = message.model;
      note = {
        key: message.key,
        pageId: message.pageId,
        content: message.content || '',
        editable: model ? model.page.editable : true
      };
      renderHeader(message);
      renderLock(message.locked);
      setPlaceholder(message.title);
      elements.input.value = note.content;
      elements.input.setSelectionRange(0, 0);
      elements.input.scrollTop = 0;
      elements.render.scrollTop = 0;
      renderBody();
      renderPages();
      elements.title.dataset.title = message.title || '';
      break;
    }
    case 'meta': {
      if (message.key === note.key) {
        renderHeader(message);
        setPlaceholder(message.title);
        elements.title.dataset.title = message.title || '';
      }
      break;
    }
    case 'model': {
      if (message.key === note.key && message.pageId === note.pageId) {
        model = message.model;
        const editable = model.page.editable;
        if (editable !== note.editable) {
          note.editable = editable;
          renderBody();
        }
        setPlaceholder(elements.title.dataset.title);
        renderPages();
      }
      break;
    }
    case 'external': {
      if (message.key === note.key && message.pageId === note.pageId && !isDirty()) {
        note.content = message.content;
        renderBody();
      }
      break;
    }
    case 'append': {
      // Captured text: appended to what is shown, unsaved typing included, then saved right away.
      if (message.key !== note.key || message.pageId !== note.pageId || !note.editable) {
        break;
      }
      const current = mode === 'editor' ? elements.input.value : note.content;
      // Same as appendBlock() in src/snippets.ts.
      const head = current.replace(/\s+$/, '');
      note.content = head === '' ? `${message.block}\n` : `${head}\n\n${message.block}\n`;
      elements.input.value = note.content;
      saveNow();
      renderBody();
      elements.input.scrollTop = elements.input.scrollHeight;
      elements.render.scrollTop = elements.render.scrollHeight;
      break;
    }
    case 'focusEditor':
      if (note.key !== undefined && mode === 'editor') {
        elements.input.focus();
      }
      break;
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

elements.input.addEventListener('input', () => {
  if (note.editable) {
    scheduleSave();
  }
});
elements.input.addEventListener('blur', flush);
window.addEventListener('blur', flush);
window.addEventListener('pagehide', flush);

elements.input.addEventListener('keydown', (event) => {
  if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (!note.editable) {
      return;
    }
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

for (const button of elements.pages.querySelectorAll('[data-nav]')) {
  button.addEventListener('click', () => act(button.dataset.nav));
}

elements.graphToggle.addEventListener('click', () => {
  graphHidden = !graphHidden;
  persistState();
  renderPages();
});

const GRAPH_KEYS = { ArrowLeft: 'back', ArrowRight: 'forward', ArrowUp: 'up', ArrowDown: 'down', End: 'tip' };

elements.graphWrap.addEventListener('keydown', (event) => {
  const direction = GRAPH_KEYS[event.key];
  if (direction && model && model.page.nav[direction]) {
    event.preventDefault();
    act(direction);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    setMode('editor');
  }
});

renderBody();
vscode.postMessage({ type: 'ready' });
