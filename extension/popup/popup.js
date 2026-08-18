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

  // 폴더 아이콘 — 마지막 클립 파일의 탐색기 위치 열기
  document.getElementById('folder-btn').addEventListener('click', async () => {
    const { lastClipDownloadId } = await chrome.storage.local.get('lastClipDownloadId');
    if (lastClipDownloadId != null) chrome.downloads.show(lastClipDownloadId);
    else chrome.downloads.showDefaultFolder();
  });

  function log(text, level = 'info') {
    const el = document.createElement('div');
    el.className = `log-line log-${level}`;
    el.textContent = text;
    logEl.appendChild(el);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ── Fluid Topics 감지 ──────────────────────────────────────
  const ftSection = document.getElementById('ft-section');
  const ftTitleEl = document.getElementById('ft-title');
  const ftFullEl  = document.getElementById('ft-full-doc');
  let ftInfo = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    ftInfo = await detectFluidTopics(tab.id);
  } catch { /* chrome:// 등 접근 불가 페이지 */ }
  if (ftInfo?.isFT) {
    ftSection.hidden = false;
    if (ftInfo.mapId) {
      ftTitleEl.textContent = `📚 Fluid Topics: ${ftInfo.title || '문서 감지됨'}` +
        (ftInfo.verified ? '' : ' (추정)');
    } else {
      ftTitleEl.textContent =
        '📚 Fluid Topics 사이트 — 문서를 인식하지 못했습니다. 페이지 새로고침(F5) 후 다시 열어주세요.';
      ftFullEl.checked = false;
      ftFullEl.disabled = true;
    }
  }

  // 백그라운드 FT 클립 진행 로그 수신
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'FT_PROGRESS') log(msg.text, msg.level || 'info');
  });

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

      // Fluid Topics: fetch the whole document via khub API in the background
      // (virtual-scroll readers only render visible topics — DOM clipping misses the rest)
      if (!ftSection.hidden && ftFullEl.checked && ftInfo?.mapId) {
        log('📚 Fluid Topics 전체 문서 클립 시작 (API)');
        log('  진행률·완료 여부는 아래 로그와 아이콘 배지로 표시됩니다');
        log('  (팝업을 닫아도 백그라운드에서 계속 진행됩니다)');
        const res = await chrome.runtime.sendMessage({
          type: 'FT_CLIP',
          tabId: tab.id,
          origin: ftInfo.origin,
          mapId: ftInfo.mapId,
          opts: { mode: options.mode, cleanOnly: options.cleanOnly },
        });
        // 완료/실패는 FT_PROGRESS 로그(💾 ✅ / ❌)로 보고된다. 여기서는 시작 접수만 확인.
        if (!res?.started) throw new Error(res?.error || 'Fluid Topics 클립을 시작하지 못했습니다');
        return;
      }

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
      const { html, url, title } = await extractWithFallback(tab.id, waitMs);
      log(`📄 ${title}`);

      // Parse in popup (full DOM access available here)
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      cleanDoc(doc, options.cleanOnly);

      // Collect image URLs
      const imgUrls = collectImageUrls(doc, url);
      log(`🖼️ 이미지 ${imgUrls.length}개 발견`);

      // runId: md filename (readable title); imgPrefix: image filenames (safe ASCII only)
      const { runId, imgPrefix } = makeRunId(html);

      // Build imageMap: original URL → data URI (base64 mode) or relative path (link mode)
      const imageMap = {};
      let imgIdx = 0;
      for (const imgUrl of imgUrls) {
        imgIdx++;
        log(`  ↓ ${shortUrl(imgUrl)}`);
        // data: URIs are already fetched inline — no round-trip needed
        const raw = imgUrl.startsWith('data:')
          ? imgUrl
          : await chrome.runtime.sendMessage({ type: 'FETCH_IMG', url: imgUrl });
        if (!raw) {
          imageMap[imgUrl] = imgUrl;
          log(`  ⚠️ 로컬 저장 실패 (원본 URL 유지): ${shortUrl(imgUrl)}`, 'warn');
          continue;
        }
        const srcMime = raw.match(/^data:image\/([^;]+);/)?.[1] || 'png';
        const { dataUrl, ext } = await convertImage(raw, srcMime);
        if (options.mode === 'base64') {
          imageMap[imgUrl] = dataUrl;
        } else {
          const name = `${imgPrefix}_img_${String(imgIdx).padStart(3, '0')}.${ext}`;
          await chrome.runtime.sendMessage({ type: 'DOWNLOAD', dataUrl, filename: `WebClips/assets/${name}` });
          imageMap[imgUrl] = `assets/${name}`;
          log(`    ✅ ${name}`);
        }
      }

      log('📝 Markdown 변환 중...');
      const md = buildMarkdown(doc, url, title, imageMap);

      const mdFilename = `WebClips/${runId}.md`;
      const mdDataUrl = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(md);
      const dlRes = await chrome.runtime.sendMessage({ type: 'DOWNLOAD', dataUrl: mdDataUrl, filename: mdFilename });
      chrome.storage.local.set({ lastClipDownloadId: dlRes?.id ?? null });
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

// Fluid Topics 판별: fluidtopics 스크립트 / ft-tenant-base-url 메타 태그 존재.
// mapId 후보는 리더 URL(/r/{mapId}/...)과 페이지가 호출한 khub API 기록
// (performance entries, 최신 우선)에서 수집한 뒤, 맵 조회 API의 readerUrl이
// 현재 경로의 접두사인 후보를 채택해 검증한다 (pretty URL 리더는 URL에
// mapId가 없어 기록만으로는 이전에 본 다른 문서를 오검출할 수 있음).
async function detectFluidTopics(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const ID = '([A-Za-z0-9~_-]{15,})';
      const isFT = !!(
        document.querySelector('script[src*="fluidtopics"]') ||
        document.querySelector('meta[name="ft-tenant-base-url"]')
      );
      const candidates = [];
      const urlId = (location.pathname.match(new RegExp(`/r/${ID}(?:[/?#]|$)`)) || [])[1];
      if (urlId) candidates.push(urlId);
      const seen = new Set(candidates);
      const perfIds = [];
      for (const e of performance.getEntriesByType('resource')) {
        const m = e.name.match(new RegExp(`/api/khub/maps/${ID}(?:[/?]|$)`));
        if (m && !seen.has(m[1])) { seen.add(m[1]); perfIds.push(m[1]); }
      }
      candidates.push(...perfIds.reverse()); // 최근 호출된 맵 먼저
      if (!candidates.length) return { isFT, mapId: null, origin: location.origin };

      const infos = [];
      for (const id of candidates.slice(0, 5)) {
        try {
          const r = await fetch(`/api/khub/maps/${id}`, {
            headers: { Accept: 'application/json' },
          });
          if (!r.ok) continue;
          const map = await r.json();
          infos.push({ id, title: map.title || '', readerUrl: map.readerUrl || '' });
        } catch { /* ignore */ }
      }
      const byPath = infos.find(i => i.readerUrl && (
        location.pathname === i.readerUrl ||
        location.pathname.startsWith(i.readerUrl + '/')
      ));
      const pick = byPath || infos[0] ||
        { id: candidates[0], title: '' };
      return {
        isFT: true, // khub API를 쓰는 페이지는 Fluid Topics
        mapId: pick.id,
        title: pick.title,
        verified: !!byPath,
        origin: location.origin,
      };
    },
  });
  return result || { isFT: false, mapId: null, origin: null };
}

function sendToTab(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

// Extracts from main frame first. If content is sparse, probes sub-frames and injects
// into only the richest one (handles iframe-based sites like Naver Blog).
// Known iframe-based sites: the real article lives in a sub-frame at a predictable URL.
const KNOWN_FRAME_PATTERNS = [
  /blog\.naver\.com\/PostView/,
  /cafe\.naver\.com\/(ca-fe|f-e)\/cafes\//,
  /cafe\.naver\.com\/ArticleRead/,
];

async function extractWithFallback(tabId, waitMs) {
  const main = await sendToTab(tabId, { type: 'EXTRACT_HTML', waitMs });
  const textLen = h => h.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().length;

  // Probe all frames to get URL + text length (lightweight, no content.js injection yet)
  const probe = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => ({ url: location.href, len: document.body?.innerText?.trim().length ?? 0 }),
  });

  // 1. Known sites: go directly to the matching sub-frame
  const knownFrame = probe
    .filter(r => r.frameId !== 0)
    .find(r => KNOWN_FRAME_PATTERNS.some(p => p.test(r.result?.url ?? '')));

  if (knownFrame) {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [knownFrame.frameId] },
      files: ['content/content.js'],
    });
    const sub = await new Promise(resolve => {
      chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_HTML', waitMs }, { frameId: knownFrame.frameId },
        res => { void chrome.runtime.lastError; resolve(res ?? null); }
      );
    });
    if (sub && textLen(sub.html) > 0) return sub;
  }

  // 2. Generic: main frame is rich enough
  if (textLen(main.html) >= 500) return main;

  // 3. Generic fallback: richest sub-frame by text length
  const best = probe
    .filter(r => r.frameId !== 0 && (r.result?.len ?? 0) > 500)
    .sort((a, b) => (b.result?.len ?? 0) - (a.result?.len ?? 0))[0];
  if (!best) return main;

  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [best.frameId] },
    files: ['content/content.js'],
  });
  const sub = await new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_HTML', waitMs }, { frameId: best.frameId },
      res => { void chrome.runtime.lastError; resolve(res ?? null); }
    );
  });
  return (sub && textLen(sub.html) > textLen(main.html)) ? sub : main;
}

function shortUrl(url) {
  if (url.startsWith('data:')) return `[inline ${url.match(/data:image\/([^;]+)/)?.[1] ?? 'image'}]`;
  try { return new URL(url).pathname.split('/').pop() || url; } catch { return url; }
}

function collectImageUrls(doc, baseUrl) {
  const urls = new Set();
  const resolve = (u) => {
    if (!u) return null;
    if (u.startsWith('data:image/')) return u; // inline base64 — include so it gets extracted to a file
    try { return new URL(u, baseUrl).href; } catch { return null; }
  };
  for (const img of doc.querySelectorAll('img')) {
    if (isDecorativeMathImg(img)) continue;
    const src = img.getAttribute('data-lazy-src') || img.getAttribute('data-lazy') || img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('src') || '';
    const r = resolve(src);
    if (r) urls.add(r);
  }
  return [...urls];
}

// KaTeX는 늘어나는 화살표(\xrightarrow 등)를 width="400em"짜리 data: SVG 조각으로
// 그린다. 화면에선 CSS로 잘려 보이지만 마크다운으로 옮기면 깨진 이미지가 되므로
// 다운로드·본문 삽입 모두에서 제외한다.
function isDecorativeMathImg(img) {
  return !!img.closest('.katex, .katex-html, .math-block, mjx-container');
}

// makeRunId: md파일명 "yyyy-mm-dd HHmmss 첫텍스트30자" + 이미지용 "yyyy-mm-dd_HHmmss"
function makeRunId(html) {
  const now = new Date();
  const p    = n => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${p(now.getMonth()+1)}-${p(now.getDate())}`;
  const time = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const ts   = `${date} ${time}`;
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
  const raw  = (stripped.match(/\S.{0,29}/) || [''])[0];
  const text = raw.replace(/[\\/:*?"<>|\n\r\t]/g, '').trim().slice(0, 30);
  const runId = text ? `${ts} ${text}` : ts;
  return { runId, imgPrefix: `${date}_${time}` };
}

// convertImage: keeps JPEG/PNG/GIF/SVG as-is; converts WebP/AVIF/etc. to PNG via Canvas
async function convertImage(dataUrl, mime) {
  if (mime === 'png')     return { dataUrl, ext: 'png' };
  if (mime === 'jpeg')    return { dataUrl, ext: 'jpg' };
  if (mime === 'gif')     return { dataUrl, ext: 'gif' };
  if (mime === 'svg+xml') return { dataUrl, ext: 'svg' };
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width  = img.naturalWidth  || 1;
      c.height = img.naturalHeight || 1;
      c.getContext('2d').drawImage(img, 0, 0);
      resolve({ dataUrl: c.toDataURL('image/png'), ext: 'png' });
    };
    img.onerror = () => resolve({ dataUrl, ext: 'png' });
    img.src = dataUrl;
  });
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

// Tries selectors in priority order; returns the first element with >200 chars of text.
// Unlike querySelector(a,b,c) which returns the first DOM-order match regardless of
// selector order, this respects our priority so site-specific selectors win over generic ones.
function pickMain(doc) {
  const PRIORITY = [
    // Naver Blog (Smart Editor 3/SE3)
    '.se-main-container',
    // Generic semantic
    'article', 'main', '[role="main"]',
    '.post-content', '.entry-content', '.article-body',
    '.markdown-body',
    // FluidTopics
    '.component-content', '.component-main', '.component-content-inner-wrapper',
    '.designed-reader-component', '.FT-page-body', '.ft-page-body',
    '[class*="FT-topic"]', '[class*="FT-content"]', '.FT-main-content',
    // GitBook
    '.page-inner', '.book-body',
    // Confluence
    '#main-content', '.wiki-content',
    // ReadTheDocs / MkDocs
    '.rst-content', '.md-content', '.wy-nav-content',
    // Docusaurus
    '.theme-doc-markdown', '.docMainContainer',
    // Generic fallbacks (checked last — too common, may match sidebars)
    '.post-body', '.content', '#content', '#main', '.container article',
  ];
  for (const sel of PRIORITY) {
    const el = doc.querySelector(sel);
    if (el && el.innerText.trim().length > 200) return el;
  }
  return doc.body;
}

function buildMarkdown(doc, url, title, imageMap) {
  const main = pickMain(doc);

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

  if (['script','style','noscript','template','select','option','textarea','form'].includes(tag))
    return '';

  // <button>은 UI 요소라 텍스트는 버리지만, 본문 이미지를 클릭 가능한 버튼으로
  // 감싸는 사이트(Gemini의 button.image-button 등)가 있어 그 안의 이미지는 살린다.
  // aria-hidden="true"인 이미지는 아이콘 등 장식용이므로 제외한다.
  if (tag === 'button') {
    return Array.from(node.querySelectorAll('img'))
      .filter(im => im.getAttribute('aria-hidden') !== 'true')
      .map(im => nodeToMd(im, base, imageMap))
      .join('');
  }

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
      if (isDecorativeMathImg(node)) return '';
      const raw = node.getAttribute('data-lazy-src') || node.getAttribute('data-lazy') || node.getAttribute('data-src') || node.getAttribute('data-original') || node.getAttribute('src') || '';
      if (!raw) return '';
      const resolved = resolveUrl(raw, base);
      const mapped   = imageMap?.[resolved] ?? resolved;
      const alt = node.getAttribute('alt') || '';
      if (!mapped) return '';
      const path = mapped.startsWith('http') || mapped.startsWith('data:')
        ? mapped : mapped.replace(/ /g, '%20');
      return `![${alt}](${path})`;
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

  // Remove lines with 15+ consecutive spaces (layout noise) - protect code fences
  { let _f = false;
    md = md.replace(/^.*$/gm, ln => {
      if (/^```/.test(ln)) _f = !_f;
      return (!_f && / {15,}/.test(ln)) ? '' : ln;
    }); }

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

  // Strip leading whitespace from image lines (prevents indented code block)
  md = md.replace(/^[ \t]+(\[?!\[)/gm, '$1');

  // Collapse excess blank lines and trim
  md = md.replace(/\n{3,}/g, '\n\n').trim();

  return md;
}

function tableToMd(table, base, imageMap) {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (!rows.length) return '';

  // Doc platforms (FluidTopics etc.) render code samples as single-column tables.
  // The code lines live as separate block elements (<p class="p_table_l_code">) inside
  // one <td>, with a copy-button row in the <thead>. Detect and render as a code block.
  const isSingleCol = rows.every(r => r.querySelectorAll('td, th').length <= 1);
  const isSourceCode = /sourcecode/i.test(table.className) ||
    !!table.querySelector('[class*="table_l_code"], [class*="sourcecode"]');
  if (isSingleCol || isSourceCode) {
    // Explicit <pre> takes priority
    const pre = table.querySelector('td pre');
    if (pre) {
      const lang = pre.querySelector('code')?.className.match(/language-(\w+)/)?.[1] || '';
      const code = (pre.querySelector('code') || pre).textContent.replace(/^\n|\n$/g, '');
      return `\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
    }
    // Block-aware text: <p>/<div>/<li>/<br> become line breaks; &nbsp; → space
    const cellToCode = (td) => {
      let text = '';
      (function walk(n) {
        if (n.nodeType === Node.TEXT_NODE) { if (n.textContent.trim()) text += n.textContent; return; }
        if (n.nodeType !== Node.ELEMENT_NODE) return;
        const t = n.tagName.toLowerCase();
        if (t === 'br') { if (!text.endsWith('\n')) text += '\n'; return; }
        Array.from(n.childNodes).forEach(walk);
        if (/^(p|div|li)$/.test(t) && !text.endsWith('\n')) text += '\n';
      })(td);
      return text.replace(/ /g, ' ').replace(/[ \t]+$/gm, '');
    };
    // Skip the copy-button cell (contains <img>); gather all code cells
    const code = rows
      .map(r => r.querySelector('td'))
      .filter(td => td && !td.querySelector('img'))
      .map(cellToCode)
      .join('')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+|\n+$/g, '');
    const looksLikeCode = isSourceCode ||
      /[{};]/.test(code) || /\/\//.test(code) || /\.\w+\s*\(/.test(code);
    const lineCount = (code.match(/\n/g) || []).length;
    if (code && looksLikeCode && (isSourceCode || lineCount >= 3)) {
      return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
    }
  }

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
