// Task list helpers shared by the webview and its tests.

// A GFM task list item: list marker (optionally inside block quotes), then "[ ]" or "[x]" and a space.
const TASK = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])(\](?=[ \t]|$))/;
const FENCE = /^(?:[ \t]*>)*[ \t]{0,3}(`{3,}|~{3,})/;

/**
 * Flips the `index`-th task checkbox of a markdown document (counting in document order, ignoring
 * fenced code blocks), which is the order the preview renders checkboxes in.
 * Returns the document unchanged when there is no such checkbox.
 */
function toggleTask(source, index) {
  const lines = source.split('\n');
  let fence = null;
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const fenceMatch = FENCE.exec(lines[i]);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) {
      continue;
    }
    const m = TASK.exec(lines[i]);
    if (!m) {
      continue;
    }
    if (count === index) {
      const flipped = m[2] === ' ' ? 'x' : ' ';
      lines[i] = m[1] + flipped + m[3] + lines[i].slice(m[0].length);
      return lines.join('\n');
    }
    count++;
  }
  return source;
}

module.exports = { toggleTask };
