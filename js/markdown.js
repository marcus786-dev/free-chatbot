// Markdown for assistant replies. Small and safe: all text is HTML-escaped first;
// only http(s) links are allowed. Code blocks get a language label and a Copy button.

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inlineMarkdown(text) {
  const codes = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  s = escapeHtml(s);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + escapeHtml(codes[i]) + '</code>');
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const isBlockStart = (l) => /^\s*(```|#{1,6}\s|>|(-{3,}|\*{3,}|_{3,})\s*$)/.test(l) || LIST_ITEM.test(l);
const tableCells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

function renderList(items) {
  let pos = 0;
  const build = (base) => {
    const tag = items[pos].ordered ? 'ol' : 'ul';
    const start = tag === 'ol' && items[pos].num !== 1 ? ` start="${items[pos].num}"` : '';
    let out = `<${tag}${start}>`;
    while (pos < items.length && items[pos].indent >= base) {
      const item = items[pos++];
      let li = inlineMarkdown(item.text);
      if (pos < items.length && items[pos].indent > item.indent) li += build(items[pos].indent);
      out += `<li>${li}</li>`;
    }
    return out + `</${tag}>`;
  };
  let html = '';
  while (pos < items.length) html += build(items[pos].indent);
  return html;
}

function renderCodeBlock(code, lang) {
  const label = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '<span class="code-lang"></span>';
  return `<div class="code-block"><div class="code-head">${label}` +
    `<button type="button" class="copy-code">${escapeHtml(t('copy'))}</button></div>` +
    `<pre><code>${escapeHtml(code)}</code></pre></div>`;
}

function renderMarkdown(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;

    if ((m = line.match(/^\s*```\s*([\w+#.-]*)/))) {
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++;
      html += renderCodeBlock(code.join('\n'), m[1]);
    } else if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) {
      const tag = 'h' + Math.min(m[1].length + 2, 6);
      html += `<${tag}>${inlineMarkdown(m[2])}</${tag}>`;
      i++;
    } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      html += '<hr>';
      i++;
    } else if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      html += '<blockquote>' + renderMarkdown(quote.join('\n')) + '</blockquote>';
    } else if (LIST_ITEM.test(line)) {
      const items = [];
      while (i < lines.length) {
        const im = lines[i].match(LIST_ITEM);
        if (im) {
          items.push({ indent: im[1].replace(/\t/g, '    ').length, ordered: /\d/.test(im[2]), num: parseInt(im[2], 10), text: im[3] });
          i++;
        } else if (!lines[i].trim()) {
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j < lines.length && LIST_ITEM.test(lines[j])) i = j; else break;
        } else if (/^\s+\S/.test(lines[i]) && !isBlockStart(lines[i])) {
          items[items.length - 1].text += ' ' + lines[i++].trim();
        } else break;
      }
      html += renderList(items);
    } else if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      const head = tableCells(line);
      i += 2;
      let rows = '';
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows += '<tr>' + tableCells(lines[i++]).map((c) => `<td>${inlineMarkdown(c)}</td>`).join('') + '</tr>';
      }
      html += '<table><thead><tr>' + head.map((c) => `<th>${inlineMarkdown(c)}</th>`).join('') + '</tr></thead><tbody>' + rows + '</tbody></table>';
    } else {
      const para = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++]);
      html += '<p>' + para.map((l) => inlineMarkdown(l.trim())).join('<br>') + '</p>';
    }
  }
  return html;
}

function renderInto(bubble, text) {
  bubble.classList.add('md');
  bubble.innerHTML = renderMarkdown(text);
}

// One click handler for every "Copy" button inside code blocks.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest?.('.copy-code');
  if (!btn) return;
  const code = btn.closest('.code-block')?.querySelector('pre code')?.textContent ?? '';
  if (await copyText(code)) {
    btn.textContent = t('copied');
    setTimeout(() => { btn.textContent = t('copy'); }, 1600);
  }
});
