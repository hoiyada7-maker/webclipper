// Service worker: CORS-free image fetching, file downloads, and keyboard-shortcut clip.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'FETCH_IMG') {
    fetchAsDataUrl(msg.url)
      .then(sendResponse)
      .catch(() => sendResponse(null));
    return true;
  }

  if (msg.type === 'DOWNLOAD') {
    chrome.downloads.download(
      { url: msg.dataUrl, filename: msg.filename, saveAs: false },
      (id) => sendResponse({ id: id ?? null })
    );
    return true;
  }
});

// ── Keyboard shortcut: clip without opening popup ─────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'start-clip') return;

  setBadge('...', '#2563eb');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('활성 탭 없음');

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/content.js'],
    });

    const { html, url, title } = await sendToTab(tab.id, { type: 'EXTRACT_HTML', waitMs: 0 });

    const opts = await chrome.storage.sync.get({
      mode: 'link', autoScroll: false, cleanOnly: true, spaMode: false,
    });

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    cleanDoc(doc, opts.cleanOnly);

    const imgUrls = collectImageUrls(doc, url);
    const imageMap = {};

    if (opts.mode === 'base64') {
      for (const imgUrl of imgUrls) {
        const dataUrl = await fetchAsDataUrl(imgUrl).catch(() => null);
        imageMap[imgUrl] = dataUrl || imgUrl;
      }
    } else {
      const seen = new Map();
      let imgIdx = 0;
      for (const imgUrl of imgUrls) {
        imgIdx++;
        const dataUrl = await fetchAsDataUrl(imgUrl).catch(() => null);
        if (dataUrl) {
          const mime = dataUrl.match(/^data:image\/([a-z0-9+]+);/)?.[1] || 'png';
          const ext  = mime === 'jpeg' ? 'jpg' : mime === 'svg+xml' ? 'svg' : mime;
          const name = uniqueName(imgUrl, seen, imgIdx, ext);
          await dlPromise(dataUrl, `WebClips/assets/${name}`);
          imageMap[imgUrl] = `assets/${name}`;
        } else {
          imageMap[imgUrl] = imgUrl;
        }
      }
    }

    const md     = buildMarkdown(doc, url, title, imageMap);
    const runId  = makeRunId(html);
    const mdDataUrl = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(md);
    await dlPromise(mdDataUrl, `WebClips/${runId}.md`);

    setBadge('OK', '#15803d');
    setTimeout(() => setBadge('', ''), 3000);
  } catch (err) {
    console.error('[WebClipper]', err);
    setBadge('ERR', '#b91c1c');
    setTimeout(() => setBadge('', ''), 5000);
  }
});

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

function sendToTab(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, res => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

function dlPromise(dataUrl, filename) {
  return new Promise(resolve =>
    chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, resolve)
  );
}

// ── Image fetch helpers ───────────────────────────────────────────────────────

async function fetchAsDataUrl(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return blobToDataUrl(blob);
}

async function blobToDataUrl(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const CHUNK = 8192;
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += CHUNK)
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`;
}

// ── Clip pipeline (mirrors popup.js) ─────────────────────────────────────────
// Note: Node.TEXT_NODE=3, Node.ELEMENT_NODE=1 (Node global unavailable in SW)

function collectImageUrls(doc, baseUrl) {
  const urls = new Set();
  const resolve = u => {
    if (!u || u.startsWith('data:')) return null;
    try { return new URL(u, baseUrl).href; } catch { return null; }
  };
  for (const img of doc.querySelectorAll('img')) {
    const src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') || '';
    const r = resolve(src);
    if (r) urls.add(r);
  }
  return [...urls];
}

function makeRunId(html) {
  const now = new Date();
  const p   = n => String(n).padStart(2, '0');
  const ts  = `${now.getFullYear()}-${p(now.getMonth()+1)}-${p(now.getDate())} ` +
              `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
  const raw  = (stripped.match(/\S.{0,29}/) || [''])[0];
  const text = raw.replace(/[\\/:*?"<>|\n\r\t]/g, '').trim().slice(0, 30);
  return text ? `${ts} ${text}` : ts;
}

function uniqueName(url, seen, index, forcedExt) {
  const raw   = decodeURIComponent(url.split('/').pop().split('?')[0]).trim();
  const base  = raw.replace(/[\\/:*?"<>|]/g, '_');
  const hasExt = base.includes('.');

  let stem, ext;
  if (!base || !hasExt) {
    ext  = forcedExt ? `.${forcedExt}` : '.png';
    stem = `img_${String(index).padStart(3, '0')}`;
  } else if (forcedExt) {
    stem = base.replace(/\.[^.]+$/, '');
    ext  = `.${forcedExt}`;
  } else {
    stem = base.replace(/\.[^.]+$/, '');
    ext  = base.slice(base.lastIndexOf('.'));
  }

  stem = stem.slice(0, 60);
  let name = stem + ext, i = 1;
  while (seen.has(name)) name = `${stem}(${i++})${ext}`;
  seen.set(name, true);
  return name;
}

function cleanDoc(doc, removeNoise) {
  doc.querySelectorAll('script, style, noscript, template').forEach(el => el.remove());
  doc.querySelectorAll(
    '.material-icons, .material-icons-outlined, .material-icons-round, ' +
    '.material-icons-sharp, .material-icons-two-tone'
  ).forEach(el => el.remove());
  if (!removeNoise) return;
  doc.querySelectorAll(
    'nav, footer, aside, ' +
    '[role="banner"], [role="navigation"], [role="complementary"], ' +
    '.sidebar, .ads, .advertisement, .cookie-banner, #cookie-notice, ' +
    '.component-loader, .loadingevent-container, .application-tools, ' +
    '.drawerlasagna, .notificationcenter, .banner-container, ' +
    '[class*="prev-next"], [class*="article-nav"], [class*="page-nav"], ' +
    '[class*="language-switch"], [class*="language-select"], ' +
    '[class*="lang-select"], [class*="breadcrumb"]'
  ).forEach(el => el.remove());
}

function buildMarkdown(doc, url, title, imageMap) {
  const main = doc.querySelector(
    'article, main, [role="main"], .post-content, .entry-content, ' +
    '.article-body, .markdown-body, .post-body, .content, ' +
    '.component-content, .component-main, .component-content-inner-wrapper, ' +
    '.designed-reader-component, .FT-page-body, .ft-page-body, ' +
    '[class*="FT-topic"], [class*="FT-content"], .FT-main-content, ' +
    '.page-inner, .book-body, #main-content, .wiki-content, ' +
    '.rst-content, .md-content, .wy-nav-content, ' +
    '.theme-doc-markdown, .docMainContainer, ' +
    '#content, #main, .container article'
  ) || doc.body;
  let md = nodeToMd(main, url, imageMap);
  return postProcessMd(md);
}

function resolveUrl(url, base) {
  if (!url || url.startsWith('data:')) return url || '';
  try { return new URL(url, base).href; } catch { return url; }
}

function nodeToMd(node, base, imageMap) {
  if (node.nodeType === 3)  // TEXT_NODE
    return node.textContent.replace(/[\r\n]+/g, ' ').replace(/ {2,}/g, ' ');
  if (node.nodeType !== 1) return ''; // not ELEMENT_NODE

  const tag = node.tagName.toLowerCase();
  if (['script','style','noscript','template','select','option','textarea','button','form'].includes(tag))
    return '';

  const kids = () => Array.from(node.childNodes).map(n => nodeToMd(n, base, imageMap)).join('');

  switch (tag) {
    case 'h1': return `\n\n# ${kids().trim()}\n\n`;
    case 'h2': return `\n\n## ${kids().trim()}\n\n`;
    case 'h3': return `\n\n### ${kids().trim()}\n\n`;
    case 'h4': return `\n\n#### ${kids().trim()}\n\n`;
    case 'h5': return `\n\n##### ${kids().trim()}\n\n`;
    case 'h6': return `\n\n###### ${kids().trim()}\n\n`;
    case 'p':  return `\n\n${kids().trim()}\n\n`;
    case 'br': return '  \n';
    case 'hr': return '\n\n---\n\n';

    case 'strong': case 'b': { const t = kids(); return t.trim() ? `**${t}**` : t; }
    case 'em': case 'i': {
      if (tag === 'i') {
        const cls  = node.className || '';
        const text = node.textContent.trim();
        if (/material-icon|^mi$/i.test(cls)) return '';
        if (/^[a-z][a-z0-9_-]*$/.test(text) || /^[-]$/.test(text)) return '';
      }
      const t = kids(); return t.trim() ? `*${t}*` : t;
    }
    case 'del': case 's': case 'strike': { const t = kids(); return t.trim() ? `~~${t}~~` : t; }
    case 'mark': { const t = kids(); return t.trim() ? `==${t}==` : t; }
    case 'sup':  { const t = kids(); return t.trim() ? `^${t}^`  : t; }
    case 'sub':  { const t = kids(); return t.trim() ? `~${t}~`  : t; }

    case 'code': {
      if (node.parentElement?.tagName.toLowerCase() === 'pre') return node.textContent;
      return `\`${node.textContent.replace(/`/g, '\\`')}\``;
    }
    case 'pre': {
      const codeEl = node.querySelector('code');
      const cls  = codeEl?.className || '';
      const lang = (cls.match(/language-(\w+)/) || cls.match(/lang-(\w+)/) || [])[1] || '';
      const text = (codeEl || node).textContent.replace(/^\n|\n$/g, '');
      return `\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
    }
    case 'blockquote': {
      const t = kids().trim();
      return '\n\n' + t.split('\n').map(l => `> ${l}`).join('\n') + '\n\n';
    }
    case 'a': {
      const href = resolveUrl(node.getAttribute('href'), base);
      const t = kids().trim();
      if (!t) return '';
      if (!href || href === '#') return t;
      return `[${t}](${href})`;
    }
    case 'img': {
      const raw = node.getAttribute('src') || node.getAttribute('data-src') || node.getAttribute('data-original') || '';
      if (!raw) return '';
      const resolved = resolveUrl(raw, base);
      const mapped   = imageMap?.[resolved] ?? resolved;
      const alt = node.getAttribute('alt') || '';
      return mapped ? `![${alt}](${mapped})` : '';
    }
    case 'li': {
      let inlineParts = '';
      const nestedMds = [];
      for (const child of node.childNodes) {
        const ctag = child.tagName?.toLowerCase();
        if (ctag === 'ul' || ctag === 'ol') {
          const nm = nodeToMd(child, base, imageMap).trim();
          if (nm) nestedMds.push(nm);
        } else {
          inlineParts += nodeToMd(child, base, imageMap);
        }
      }
      const text = inlineParts.replace(/^\n+|\n+$/g, '').replace(/\n{3,}/g, '\n\n').trim();
      if (!nestedMds.length) return text;
      const indented = nestedMds
        .map(nm => nm.split('\n').map(l => (l ? `  ${l}` : '')).join('\n'))
        .join('\n');
      return text ? `${text}\n${indented}` : indented;
    }
    case 'ul': {
      const items = Array.from(node.children)
        .filter(c => c.tagName.toLowerCase() === 'li')
        .map(li => {
          const content = nodeToMd(li, base, imageMap).trim();
          if (!content) return '';
          const lines = content.split('\n');
          return lines.length === 1
            ? `- ${lines[0]}`
            : `- ${lines[0]}\n${lines.slice(1).map(l => (l ? `  ${l}` : '')).join('\n')}`;
        }).filter(Boolean);
      return items.length ? `\n\n${items.join('\n')}\n\n` : '';
    }
    case 'ol': {
      let n = parseInt(node.getAttribute('start') || '1', 10);
      const items = Array.from(node.children)
        .filter(c => c.tagName.toLowerCase() === 'li')
        .map(li => {
          const num    = n++;
          const prefix = `${num}. `;
          const indent = ' '.repeat(prefix.length);
          const content = nodeToMd(li, base, imageMap).trim();
          if (!content) return '';
          const lines = content.split('\n');
          return lines.length === 1
            ? `${prefix}${lines[0]}`
            : `${prefix}${lines[0]}\n${lines.slice(1).map(l => (l ? `${indent}${l}` : '')).join('\n')}`;
        }).filter(Boolean);
      return items.length ? `\n\n${items.join('\n')}\n\n` : '';
    }
    case 'table': return tableToMd(node, base, imageMap);
    case 'figure': {
      const cap = node.querySelector('figcaption');
      const capText = cap?.textContent.trim();
      if (cap) cap.remove();
      const content = kids().trim();
      return `\n\n${content}${capText ? `\n*${capText}*` : ''}\n\n`;
    }
    default: return kids();
  }
}

function tableToMd(table, base, imageMap) {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (!rows.length) return '';
  const cellText = td =>
    Array.from(td.childNodes)
      .map(n => nodeToMd(n, base, imageMap))
      .join('').trim()
      .replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const matrix = rows.map(tr => Array.from(tr.querySelectorAll('th, td')).map(cellText));
  if (!matrix.length || !matrix[0].length) return '';
  const cols = Math.max(...matrix.map(r => r.length));
  const pad  = row => { while (row.length < cols) row.push(''); return row; };
  const sep  = Array(cols).fill('---');
  const [head, ...body] = matrix;
  const toRow = row => `| ${pad(row).join(' | ')} |`;
  return `\n\n${toRow(head)}\n${toRow(sep)}\n${body.map(toRow).join('\n')}\n\n`;
}

function postProcessMd(md) {
  const cutMarkers = ['Load more results', 'Expand all\n'];
  for (const marker of cutMarkers) {
    const idx = md.indexOf(marker);
    if (idx !== -1) { md = md.slice(0, idx); break; }
  }
  md = md.replace(/^[\s ﻿]+$/gm, '');
  md = md.replace(/^[^\n]* {15,}[^\n]*$/gm, '');
  md = md.replace(/\bft:[A-Za-z]+:?[^\n]*/g, '');
  md = md.replace(/^[^\n]*\bedge:[A-Za-z0-9]+[^\n]*$/gm, '');
  md = md.replace(/^[^\n]*\biirds:[A-Za-z]+[^\n]*$/gm, '');
  md = md.replace(/(?:Document|Content|Toc|Source) ID:[^\n]+/g, '');
  md = md.replace(/\bID: [A-Za-z0-9~_-]{5,}[^\n]*/g, '');
  md = md.replace(/\bLast publication:[^\n]+/g, '');
  md = md.replace(/\bSource(?:\s+ID)?:\s+MKDOCS[^\n]*/g, '');
  md = md.replace(/^#{1,6}\s+(?:Built-in|Custom) metadata\s*$/gim, '');
  md = md.replace(/^#{1,6}\s*$/gm, '');
  const TOOLBAR = [
    'Print this topic','Copy link to clipboard','Add to personal book',
    'Add to collection','Add this document to a collection','Download document',
    'Preview document','Send feedback for this topic','Give feedback for this topic','Go to document',
  ];
  for (const phrase of TOOLBAR)
    md = md.replace(new RegExp(`^[^\\n]*${phrase.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}[^\\n]*$`,'gm'), '');
  md = md.replace(/^[^\n]*(?:Add bookmark|Remove Bookmark)[^\n]*$/gm, '');
  md = md.replace(/^[^\n]*\bLanguage\b[^\n]*\b(?:Open|Close)\b[^\n]*$/gm, '');
  md = md.replace(/^\s*Close\s*$/gm, '');
  md = md.replace(/(^#{1,6} .+)(\n+\1)+/gm, '$1');
  md = md.replace(/\n{3,}/g, '\n\n').trim();
  return md;
}
