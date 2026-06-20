// ─── Main ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const clipBtn = document.getElementById('clip-btn');
  const logEl   = document.getElementById('log');
  const modeEl  = document.getElementById('mode');
  const scrollEl = document.getElementById('auto-scroll');
  const cleanEl  = document.getElementById('clean-content');
  const spaEl    = document.getElementById('spa-mode');

  // ── 설정 복원 ──────────────────────────────────────────────
  const saved = await chrome.storage.sync.get({ mode: 'link', autoScroll: false, cleanOnly: true, spaMode: false });
  modeEl.value        = saved.mode;
  scrollEl.checked    = saved.autoScroll;
  cleanEl.checked     = saved.cleanOnly;
  spaEl.checked       = saved.spaMode;

  // 변경 시 즉시 저장
  const saveSettings = () => chrome.storage.sync.set({
    mode:       modeEl.value,
    autoScroll: scrollEl.checked,
    cleanOnly:  cleanEl.checked,
    spaMode:    spaEl.checked,
  });
  modeEl.addEventListener('change', saveSettings);
  scrollEl.addEventListener('change', saveSettings);
  cleanEl.addEventListener('change', saveSettings);
  spaEl.addEventListener('change', saveSettings);

  // ── 단축키 표시 및 변경 링크 ───────────────────────────────
  const shortcutDisplay = document.getElementById('shortcut-display');
  const shortcutChange  = document.getElementById('shortcut-change');

  // 실제 등록된 단축키를 API로 읽어와 표시
  chrome.commands.getAll(cmds => {
    const cmd = cmds.find(c => c.name === 'start-clip');
    if (cmd?.shortcut) shortcutDisplay.textContent = cmd.shortcut;
  });

  shortcutChange.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  // 폴더 아이콘 — WebClips 가장 최근 파일 위치를 탐색기로 열기
  document.getElementById('folder-btn').addEventListener('click', () => {
    chrome.downloads.search(
      { filenameContains: 'WebClips', orderBy: ['-startTime'], limit: 1 },
      items => {
        if (items.length > 0) chrome.downloads.show(items[0].id);
        else chrome.downloads.showDefaultFolder();
      }
    );
  });

  function log(text, level = 'info') {
    const el = document.createElement('div');
    el.className = `log-line log-${level}`;
    el.textContent = text;
    logEl.appendChild(el);
    logEl.scrollTop = logEl.scrollHeight;
  }

  clipBtn.addEventListener('click', async () => {
    clipBtn.disabled = true;
    logEl.innerHTML = '';

    const options = {
      mode:        modeEl.value,           // 'base64' | 'link'
      autoScroll:  scrollEl.checked,
      cleanOnly:   cleanEl.checked,
      spaMode:     spaEl.checked,
    };

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      // Ensure content script is present (re-inject if page loaded before extension)
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files:  ['content/content.js'],
      });

      if (options.autoScroll) {
        log('🔄 자동 스크롤 중...');
        await sendToTab(tab.id, { type: 'AUTO_SCROLL' });
        log('✅ 스크롤 완료');
      }

      log('📋 HTML 추출 중...' + (options.spaMode ? ' (SPA 렌더링 대기 중...)' : ''));
      const waitMs = options.spaMode ? 2000 : 0;
      const { html, url, title } = await sendToTab(tab.id, { type: 'EXTRACT_HTML', waitMs });
      log(`📄 ${title}`);

      // Parse in popup (full DOM access available here)
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      cleanDoc(doc, options.cleanOnly);

      // Collect image URLs
      const imgUrls = collectImageUrls(doc, url);
      log(`🖼️ 이미지 ${imgUrls.length}개 발견`);

      // Build imageMap: original URL → replacement (data URI or relative path)
      // Images are resolved BEFORE building Markdown so the MD always has valid paths.
      const imageMap = {};
      if (options.mode === 'base64') {
        for (const imgUrl of imgUrls) {
          log(`  ↓ ${shortUrl(imgUrl)}`);
          const dataUrl = await chrome.runtime.sendMessage({ type: 'FETCH_IMG', url: imgUrl });
          imageMap[imgUrl] = dataUrl || imgUrl; // fallback to original URL if fetch fails
        }
      } else {
        // link mode: download each image first; fall back to original URL on failure
        const seen = new Map();
        let imgIdx = 0;
        for (const imgUrl of imgUrls) {
          imgIdx++;
          log(`  ↓ ${shortUrl(imgUrl)}`);
          const dataUrl = await chrome.runtime.sendMessage({ type: 'FETCH_IMG', url: imgUrl });
          if (dataUrl) {
            const mime = dataUrl.match(/^data:image\/([a-z0-9+]+);/)?.[1] || 'png';
            const ext  = mime === 'jpeg' ? 'jpg' : mime === 'svg+xml' ? 'svg' : mime;
            const name = uniqueName(imgUrl, seen, imgIdx, ext);
            await chrome.runtime.sendMessage({
              type: 'DOWNLOAD', dataUrl, filename: `WebClips/assets/${name}`,
            });
            imageMap[imgUrl] = `assets/${name}`;
            log(`    ✅ ${name}`);
          } else {
            imageMap[imgUrl] = imgUrl;
            log(`  ⚠️ 로컬 저장 실패 (원본 URL 유지): ${shortUrl(imgUrl)}`, 'warn');
          }
        }
      }

      log('📝 Markdown 변환 중...');
      const md = buildMarkdown(doc, url, title, imageMap);

      // Save .md file  —  yyyy-mm-dd HHmmss 첫텍스트.md (main.py _make_run_id 규칙)
      const runId = makeRunId(html);
      const mdFilename = `WebClips/${runId}.md`;
      const mdDataUrl = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(md);

      await chrome.runtime.sendMessage({ type: 'DOWNLOAD', dataUrl: mdDataUrl, filename: mdFilename });
      log(`💾 ${mdFilename}`);

      log('✅ 완료!', 'success');
    } catch (err) {
      log(`❌ ${err.message}`, 'error');
    } finally {
      clipBtn.disabled = false;
    }
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendToTab(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

function shortUrl(url) {
  try { return new URL(url).pathname.split('/').pop() || url; } catch { return url; }
}

function collectImageUrls(doc, baseUrl) {
  const urls = new Set();
  const resolve = (u) => {
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

// makeRunId: main.py _make_run_id 규칙 — "yyyy-mm-dd HHmmss 첫텍스트30자"
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

// uniqueName: main.py _safe_filename + _unique_path 규칙
//   · URL basename 사용, 위험 문자([\\/:*?"<>|]) → '_'
//   · basename 없거나 확장자 없으면 img_NNN.ext
//   · 충돌 시 stem(N).ext (Python과 동일)
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

  // Always strip icon-font elements — their text is invisible in browsers
  // (icon glyph replaces text via CSS) but shows up verbatim in Markdown.
  doc.querySelectorAll(
    '.material-icons, .material-icons-outlined, .material-icons-round, ' +
    '.material-icons-sharp, .material-icons-two-tone'
  ).forEach(el => el.remove());

  if (!removeNoise) return;
  // Note: 'header' intentionally excluded — doc platforms (FluidTopics etc.)
  // sometimes nest main content inside <header> elements.
  doc.querySelectorAll(
    'nav, footer, aside, ' +
    '[role="banner"], [role="navigation"], [role="complementary"], ' +
    '.sidebar, .ads, .advertisement, .cookie-banner, #cookie-notice, ' +
    '.component-loader, .loadingevent-container, .application-tools, ' +
    '.drawerlasagna, .notificationcenter, .banner-container, ' +
    // FluidTopics prev/next article navigation and language switcher UI
    '[class*="prev-next"], [class*="article-nav"], [class*="page-nav"], ' +
    '[class*="language-switch"], [class*="language-select"], ' +
    '[class*="lang-select"], [class*="breadcrumb"]'
  ).forEach(el => el.remove());
}

// ─── Markdown Builder ─────────────────────────────────────────────────────────

function buildMarkdown(doc, url, title, imageMap) {
  const main = doc.querySelector(
    // Generic
    'article, main, [role="main"], .post-content, .entry-content, ' +
    '.article-body, .markdown-body, .post-body, .content, ' +
    // FluidTopics (Siemens docs, Paligo, etc.) — classes from live DOM inspection
    '.component-content, .component-main, .component-content-inner-wrapper, ' +
    '.designed-reader-component, .FT-page-body, .ft-page-body, ' +
    '[class*="FT-topic"], [class*="FT-content"], .FT-main-content, ' +
    // GitBook
    '.page-inner, .book-body, ' +
    // Confluence
    '#main-content, .wiki-content, ' +
    // ReadTheDocs / MkDocs
    '.rst-content, .md-content, .wy-nav-content, ' +
    // Docusaurus
    '.theme-doc-markdown, .docMainContainer, ' +
    // Generic fallbacks
    '#content, #main, .container article'
  ) || doc.body;

  let md = nodeToMd(main, url, imageMap);
  md = postProcessMd(md);

  return md;
}

function resolveUrl(url, base) {
  if (!url || url.startsWith('data:')) return url || '';
  try { return new URL(url, base).href; } catch { return url; }
}

function nodeToMd(node, base, imageMap) {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent.replace(/[\r\n]+/g, ' ').replace(/ {2,}/g, ' ');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

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

    case 'p': return `\n\n${kids().trim()}\n\n`;
    case 'br': return '  \n';
    case 'hr': return '\n\n---\n\n';

    case 'strong': case 'b': { const t = kids(); return t.trim() ? `**${t}**` : t; }
    case 'em':     case 'i': {
      if (tag === 'i') {
        const cls = node.className || '';
        const text = node.textContent.trim();
        // Material Icons class
        if (/material-icon|^mi$/i.test(cls)) return '';
        // Icon-font text: single kebab/snake_case word (icon name) or private-use Unicode glyph
        if (/^[a-z][a-z0-9_-]*$/.test(text) || /^[-]$/.test(text)) return '';
      }
      const t = kids(); return t.trim() ? `*${t}*` : t;
    }
    case 'del': case 's': case 'strike': { const t = kids(); return t.trim() ? `~~${t}~~` : t; }
    case 'mark': { const t = kids(); return t.trim() ? `==${t}==` : t; }
    case 'sup': { const t = kids(); return t.trim() ? `^${t}^` : t; }
    case 'sub': { const t = kids(); return t.trim() ? `~${t}~` : t; }

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
      // Separate inline text from nested lists so we can indent them correctly.
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
      // Normalise: strip surrounding newlines from <p> wrapper, collapse excess blank lines
      const text = inlineParts.replace(/^\n+|\n+$/g, '').replace(/\n{3,}/g, '\n\n').trim();
      if (!nestedMds.length) return text;
      // Indent each nested list line by 2 spaces
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
          // Multi-line content: indent continuation lines so they stay in the list item
          const lines = content.split('\n');
          return lines.length === 1
            ? `- ${lines[0]}`
            : `- ${lines[0]}\n${lines.slice(1).map(l => (l ? `  ${l}` : '')).join('\n')}`;
        })
        .filter(Boolean);
      return items.length ? `\n\n${items.join('\n')}\n\n` : '';
    }
    case 'ol': {
      let n = parseInt(node.getAttribute('start') || '1', 10);
      const items = Array.from(node.children)
        .filter(c => c.tagName.toLowerCase() === 'li')
        .map(li => {
          const num = n++;
          const prefix = `${num}. `;
          const indent = ' '.repeat(prefix.length);
          const content = nodeToMd(li, base, imageMap).trim();
          if (!content) return '';
          const lines = content.split('\n');
          return lines.length === 1
            ? `${prefix}${lines[0]}`
            : `${prefix}${lines[0]}\n${lines.slice(1).map(l => (l ? `${indent}${l}` : '')).join('\n')}`;
        })
        .filter(Boolean);
      return items.length ? `\n\n${items.join('\n')}\n\n` : '';
    }

    case 'table': return tableToMd(node, base, imageMap);
    // thead/tbody/etc fall through to default (kids())

    case 'figure': {
      const cap = node.querySelector('figcaption');
      const capText = cap?.textContent.trim();
      if (cap) cap.remove();
      const content = kids().trim();
      cap && node.appendChild(cap); // restore for idempotency
      return `\n\n${content}${capText ? `\n*${capText}*` : ''}\n\n`;
    }

    default: return kids();
  }
}

// ─── Post-processor ───────────────────────────────────────────────────────────

function postProcessMd(md) {
  // Cut at search/browse results drawer — everything below is site navigation noise
  const cutMarkers = ['Load more results', 'Expand all\n'];
  for (const marker of cutMarkers) {
    const idx = md.indexOf(marker);
    if (idx !== -1) { md = md.slice(0, idx); break; }
  }

  // Remove lines that are purely whitespace / non-breaking space (spacer paragraphs, toolbar remnants)
  //   = non-breaking space, ﻿ = BOM — all invisible in rendered output
  md = md.replace(/^[\s ﻿]+$/gm, '');

  // Remove lines with 15+ consecutive spaces (layout navigation bars, jumbled sidebar text)
  md = md.replace(/^[^\n]* {15,}[^\n]*$/gm, '');

  // Remove ft: metadata key-value content (FluidTopics built-in metadata panel)
  md = md.replace(/\bft:[A-Za-z]+:?[^\n]*/g, '');

  // Remove Custom metadata panel content (edge:, iirds:, PublicationState:, etc.)
  md = md.replace(/^[^\n]*\bedge:[A-Za-z0-9]+[^\n]*$/gm, '');
  md = md.replace(/^[^\n]*\biirds:[A-Za-z]+[^\n]*$/gm, '');

  // Remove metadata panel header/ID lines
  md = md.replace(/(?:Document|Content|Toc|Source) ID:[^\n]+/g, '');
  // Bare "ID: <alphanum_id>" patterns (FluidTopics document/content IDs)
  md = md.replace(/\bID: [A-Za-z0-9~_-]{5,}[^\n]*/g, '');
  md = md.replace(/\bLast publication:[^\n]+/g, '');
  md = md.replace(/\bSource(?:\s+ID)?:\s+MKDOCS[^\n]*/g, '');

  // Remove "Built-in metadata" / "Custom metadata" section headings
  md = md.replace(/^#{1,6}\s+(?:Built-in|Custom) metadata\s*$/gim, '');

  // Remove empty headings (# with no text)
  md = md.replace(/^#{1,6}\s*$/gm, '');

  // Remove FluidTopics per-topic toolbar text lines
  const TOOLBAR_PHRASES = [
    'Print this topic',
    'Copy link to clipboard',
    'Add to personal book',
    'Add to collection',
    'Add this document to a collection',
    'Download document',
    'Preview document',
    'Send feedback for this topic',
    'Give feedback for this topic',
    'Go to document',
  ];
  for (const phrase of TOOLBAR_PHRASES) {
    const re = new RegExp(`^[^\\n]*${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*$`, 'gm');
    md = md.replace(re, '');
  }
  // "Add bookmark / Remove Bookmark" — contain dynamic title text, match prefix only
  md = md.replace(/^[^\n]*(?:Add bookmark|Remove Bookmark)[^\n]*$/gm, '');

  // Remove language switcher lines ("Language … Open/Close")
  md = md.replace(/^[^\n]*\bLanguage\b[^\n]*\b(?:Open|Close)\b[^\n]*$/gm, '');

  // Remove orphan "Close" lines (toolbar button remnant after other cleanup)
  md = md.replace(/^\s*Close\s*$/gm, '');

  // Remove consecutive duplicate headings (FluidTopics repeats each section title 2-3×)
  md = md.replace(/(^#{1,6} .+)(\n+\1)+/gm, '$1');

  // Collapse excess blank lines and trim
  md = md.replace(/\n{3,}/g, '\n\n').trim();

  return md;
}

function tableToMd(table, base, imageMap) {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (!rows.length) return '';

  const cellText = (td) =>
    Array.from(td.childNodes)
      .map(n => nodeToMd(n, base, imageMap))
      .join('')
      .trim()
      .replace(/\|/g, '\\|')
      .replace(/\n/g, ' ');

  const matrix = rows.map(tr => Array.from(tr.querySelectorAll('th, td')).map(cellText));
  if (!matrix.length || !matrix[0].length) return '';

  const cols = Math.max(...matrix.map(r => r.length));
  const pad  = (row) => { while (row.length < cols) row.push(''); return row; };
  const line = (cells) => `| ${cells.join(' | ')} |`;

  const header = pad(matrix[0]);
  const sep    = Array(cols).fill('---');
  const body   = matrix.slice(1).map(pad);

  return '\n\n' + [line(header), line(sep), ...body.map(line)].join('\n') + '\n\n';
}
