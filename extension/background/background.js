// Service worker: CORS-free image fetching, file downloads, and keyboard-shortcut clip.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'FETCH_IMG') {
    fetchAsDataUrl(msg.url)
      .then(sendResponse)
      .catch(() => sendResponse(null));
    return true;
  }

  if (msg.type === 'DOWNLOAD') {
    robustDownload(msg.dataUrl, msg.filename)
      .then(id => sendResponse({ id: id ?? null }))
      .catch(() => sendResponse({ id: null }));
    return true;
  }

  if (msg.type === 'FT_CLIP') {
    // 긴 작업(수백 토픽 fetch + 이미지 + 대용량 MD 변환) 동안 MV3 서비스워커의
    // 단일 응답 채널이 끊기면, 실제로 성공해도 팝업이 '실패'로 오인한다.
    // 시작만 즉시 응답하고 진행·완료·실패는 FT_PROGRESS로 보고한다
    // (팝업을 닫아도 백그라운드에서 계속 진행되는 기존 설계와도 일치).
    sendResponse({ ok: true, started: true });
    ftClip(msg).catch(err =>
      ftReport('❌ Fluid Topics 클립 실패: ' + (err?.message || String(err)), 'error'));
    return false;
  }
});

// Starts a download and resolves only once it actually completes (or is interrupted).
// chrome.downloads.download's callback fires when the download STARTS, so without
// this many rapid sequential downloads can silently fail ("interrupted").
function downloadAndWait(dataUrl, filename) {
  return new Promise((resolve) => {
    chrome.downloads.download(
      { url: dataUrl, filename, saveAs: false, conflictAction: 'overwrite' },
      (id) => {
        if (id === undefined) { resolve({ id: null, ok: false }); return; }
        const listener = (delta) => {
          if (delta.id !== id) return;
          const state = delta.state?.current;
          if (state === 'complete') {
            chrome.downloads.onChanged.removeListener(listener);
            resolve({ id, ok: true });
          } else if (state === 'interrupted') {
            chrome.downloads.onChanged.removeListener(listener);
            resolve({ id, ok: false });
          }
        };
        chrome.downloads.onChanged.addListener(listener);
      }
    );
  });
}

// Download with one retry on failure.
async function robustDownload(dataUrl, filename) {
  let r = await downloadAndWait(dataUrl, filename);
  if (!r.ok) r = await downloadAndWait(dataUrl, filename);
  return r.id;
}

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

    const opts = await chrome.storage.sync.get({
      mode: 'link', autoScroll: false, cleanOnly: true, spaMode: false,
    });

    if (opts.autoScroll) {
      await sendToTab(tab.id, { type: 'AUTO_SCROLL' });
    }

    const { html, url, title } = await extractWithFallback(tab.id, 0);

    // Pass 1: parse HTML and collect image URLs in tab context (has DOMParser)
    const [{ result: imgUrls }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractImgUrlsInTab,
      args: [html, url, opts.cleanOnly],
    });

    const { runId, imgPrefix } = makeRunId(html);
    const imageMap = {};
    let imgIdx = 0;
    for (const imgUrl of imgUrls) {
      imgIdx++;
      const raw = imgUrl.startsWith('data:')
        ? imgUrl
        : await fetchAsDataUrl(imgUrl).catch(() => null);
      if (!raw) { imageMap[imgUrl] = imgUrl; continue; }
      const srcMime = raw.match(/^data:image\/([^;]+);/)?.[1] || 'png';
      const { dataUrl, ext } = await convertImage(raw, srcMime, tab.id);
      if (opts.mode === 'base64') {
        imageMap[imgUrl] = dataUrl;
      } else {
        const name = `${imgPrefix}_img_${String(imgIdx).padStart(3, '0')}.${ext}`;
        await dlPromise(dataUrl, `WebClips/assets/${name}`);
        imageMap[imgUrl] = `assets/${name}`;
      }
    }

    // Pass 2: build markdown in tab context (has DOMParser + Node constants)
    const [{ result: md }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: buildMdInTab,
      args: [html, url, title, Object.entries(imageMap), opts.cleanOnly],
    });

    const mdDataUrl = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(md);
    const dlId = await dlPromise(mdDataUrl, `WebClips/${runId}.md`);
    chrome.storage.local.set({ lastClipDownloadId: dlId ?? null });

    setBadge('OK', '#15803d');
    setTimeout(() => setBadge('', ''), 3000);
  } catch (err) {
    console.error('[WebClipper]', err);
    setBadge('ERR', '#b91c1c');
    setTimeout(() => setBadge('', ''), 5000);
  }
});

// ── Fluid Topics: full-document clip via khub REST API ───────────────────────
// FT readers virtual-scroll: only visible topics are in the DOM, so DOM clipping
// misses most of the document. The same content is served by the public API:
//   GET /api/khub/maps/{mapId}          → document metadata (title)
//   GET /api/khub/maps/{mapId}/toc      → topic tree (contentId, title, children)
//   GET /api/khub/maps/{mapId}/topics/{contentId}/content → per-topic body HTML
// Runs entirely in the service worker so it survives the popup closing.

function ftReport(text, level = 'info') {
  chrome.runtime.sendMessage({ type: 'FT_PROGRESS', text, level },
    () => void chrome.runtime.lastError);
}

async function ftFetchJson(url) {
  const res = await fetch(url, {
    credentials: 'include', headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function ftFetchTopic(origin, mapId, contentId, retries = 3) {
  const url = `${origin}/api/khub/maps/${mapId}/topics/${contentId}/content`;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        credentials: 'include', signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (i === retries - 1) return `<p><em>[fetch failed: ${e.message}]</em></p>`;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function ftClip({ tabId, origin, mapId, opts }) {
  setBadge('...', '#2563eb');
  try {
    const esc = s => String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const docTitle = await ftFetchJson(`${origin}/api/khub/maps/${mapId}`)
      .then(m => m.title).catch(() => '') || 'FluidTopics Document';

    const toc = await ftFetchJson(`${origin}/api/khub/maps/${mapId}/toc`);
    const flat = [];
    (function walk(nodes, depth) {
      for (const n of nodes || []) {
        flat.push({ depth, contentId: n.contentId, title: n.title });
        walk(n.children, depth + 1);
      }
    })(toc, 1);
    if (!flat.length) throw new Error('TOC가 비어 있습니다');
    ftReport(`📑 ${docTitle} — 토픽 ${flat.length}개 수집 시작`);

    // Assemble one HTML doc: doc title as h1, topic titles as h(depth+1)
    const sections = [`<h1>${esc(docTitle)}</h1>`];
    let done = 0;
    for (const t of flat) {
      const body = t.contentId ? await ftFetchTopic(origin, mapId, t.contentId) : '';
      const h = Math.min(t.depth + 1, 6);
      sections.push(`<section><h${h}>${esc(t.title)}</h${h}>\n${body}</section>`);
      done++;
      if (done % 10 === 0 || done === flat.length)
        setBadge(`${Math.round((done / flat.length) * 100)}%`, '#2563eb');
      if (done % 50 === 0) ftReport(`⏳ 토픽 ${done}/${flat.length}`);
      await new Promise(r => setTimeout(r, 30));
    }

    // <article> wrapper so the standard pickMain PRIORITY list selects the whole doc
    const html = `<!DOCTYPE html><html><head><title>${esc(docTitle)}</title></head>` +
      `<body><article>${sections.join('\n')}</article></body></html>`;
    const baseUrl = `${origin}/`;

    // Reuse the standard pipeline (image collection + MD build run in the tab —
    // the service worker has no DOMParser)
    const [{ result: imgUrls }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractImgUrlsInTab,
      args: [html, baseUrl, opts.cleanOnly],
    });
    ftReport(`🖼️ 이미지 ${imgUrls.length}개 발견`);

    const { runId, imgPrefix } = makeRunId(html);
    const imageMap = {};
    let imgIdx = 0;
    for (const imgUrl of imgUrls) {
      imgIdx++;
      const raw = imgUrl.startsWith('data:')
        ? imgUrl
        : await fetchAsDataUrl(imgUrl).catch(() => null);
      if (!raw) { imageMap[imgUrl] = imgUrl; continue; }
      const srcMime = raw.match(/^data:image\/([^;]+);/)?.[1] || 'png';
      const { dataUrl, ext } = await convertImage(raw, srcMime, tabId);
      if (opts.mode === 'base64') {
        imageMap[imgUrl] = dataUrl;
      } else {
        const name = `${imgPrefix}_img_${String(imgIdx).padStart(3, '0')}.${ext}`;
        await dlPromise(dataUrl, `WebClips/assets/${name}`);
        imageMap[imgUrl] = `assets/${name}`;
      }
      if (imgIdx % 20 === 0) ftReport(`🖼️ 이미지 ${imgIdx}/${imgUrls.length}`);
    }

    const [{ result: md }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: buildMdInTab,
      args: [html, baseUrl, docTitle, Object.entries(imageMap), opts.cleanOnly],
    });

    const mdDataUrl = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(md);
    const dlId = await dlPromise(mdDataUrl, `WebClips/${runId}.md`);
    chrome.storage.local.set({ lastClipDownloadId: dlId ?? null });
    ftReport(`💾 WebClips/${runId}.md`, 'success');
    ftReport('✅ 완료!', 'success');

    setBadge('OK', '#15803d');
    setTimeout(() => setBadge('', ''), 3000);
  } catch (err) {
    console.error('[WebClipper][FT]', err);
    setBadge('ERR', '#b91c1c');
    setTimeout(() => setBadge('', ''), 5000);
    throw err;
  }
}

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

function dlPromise(dataUrl, filename) {
  return robustDownload(dataUrl, filename);
}

// ── Helpers (service-worker context) ─────────────────────────────────────────

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

// Converts SVG/WebP/AVIF/etc. → PNG; JPEG/PNG/GIF kept as-is.
// SVG까지 PNG로 바꾸는 이유: 마크다운 렌더러(markdown-it — VS Code 프리뷰·GitHub)가
// XSS 방어로 data:image/svg+xml을 차단해서, Base64 임베드하면 프리뷰에 안 보인다.
async function convertImage(dataUrl, mime, tabId) {
  if (mime === 'png')  return { dataUrl, ext: 'png' };
  if (mime === 'jpeg') return { dataUrl, ext: 'jpg' };
  if (mime === 'gif')  return { dataUrl, ext: 'gif' };
  if (mime === 'svg+xml') {
    // 서비스워커의 createImageBitmap은 SVG를 디코드하지 못한다(InvalidStateError).
    // Image+canvas가 있는 탭 문서 컨텍스트에 주입해 처리하고, 실패하면 원본을 쓴다.
    const png = tabId == null ? null : await chrome.scripting.executeScript({
      target: { tabId }, func: svgToPngInTab, args: [dataUrl],
    }).then(r => r?.[0]?.result ?? null).catch(() => null);
    return png ? { dataUrl: png, ext: 'png' } : { dataUrl, ext: 'svg' };
  }
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp  = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
    return { dataUrl: await blobToDataUrl(pngBlob), ext: 'png' };
  } catch {
    return { dataUrl, ext: 'png' };
  }
}

// 탭에 주입되어 실행된다 — SVG data URI를 PNG data URI로 래스터화한다.
// width/height 없이 viewBox만 있는 SVG는 Canvas가 기본값 150x150으로 그리므로
// viewBox의 크기를 명시해 원래 해상도를 유지한다.
function svgToPngInTab(dataUrl) {
  return new Promise(resolve => {
    let src = dataUrl;
    try {
      const cut  = dataUrl.indexOf(',');
      const isB64 = dataUrl.slice(0, cut).includes(';base64');
      let text = isB64 ? atob(dataUrl.slice(cut + 1))
                       : decodeURIComponent(dataUrl.slice(cut + 1));
      if (!/<svg[^>]*\swidth=/i.test(text)) {
        const vb = (text.match(/viewBox="([^"]+)"/i)?.[1] || '').trim().split(/[\s,]+/);
        if (vb.length === 4) {
          text = text.replace(/<svg/i, `<svg width="${vb[2]}" height="${vb[3]}"`);
          src = 'data:image/svg+xml;base64,' +
            btoa(isB64 ? text : unescape(encodeURIComponent(text)));
        }
      }
    } catch (_) {}
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width  = img.naturalWidth  || 1;
        c.height = img.naturalHeight || 1;
        c.getContext('2d').drawImage(img, 0, 0);
        resolve(c.toDataURL('image/png'));
      } catch (_) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

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

// ── Tab-context functions ─────────────────────────────────────────────────────
// Injected via chrome.scripting.executeScript — run in the page's isolated world
// where DOMParser and Node constants are available.

function extractImgUrlsInTab(html, baseUrl, cleanOnly) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript, template').forEach(e => e.remove());
  doc.querySelectorAll(
    '.material-icons, .material-icons-outlined, .material-icons-round, ' +
    '.material-icons-sharp, .material-icons-two-tone'
  ).forEach(e => e.remove());
  if (cleanOnly) {
    doc.querySelectorAll(
      'nav, footer, aside, [role="banner"], [role="navigation"], [role="complementary"], ' +
      '.sidebar, .ads, .advertisement, .cookie-banner, #cookie-notice, ' +
      '.component-loader, .loadingevent-container, .application-tools, ' +
      '.drawerlasagna, .notificationcenter, .banner-container, ' +
      '[class*="prev-next"], [class*="article-nav"], [class*="page-nav"], ' +
      '[class*="language-switch"], [class*="language-select"], ' +
      '[class*="lang-select"], [class*="breadcrumb"]'
    ).forEach(e => e.remove());
  }
  const urls = new Set();
  for (const img of doc.querySelectorAll('img')) {
    // KaTeX 화살표용 width="400em" data: SVG는 장식용이라 받지 않는다.
    if (img.closest('.katex, .katex-html, .math-block, mjx-container')) continue;
    const src = img.getAttribute('data-lazy-src') || img.getAttribute('data-lazy') || img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('src') || '';
    if (!src) continue;
    if (src.startsWith('data:image/')) { urls.add(src); continue; }
    try { urls.add(new URL(src, baseUrl).href); } catch {}
  }
  return [...urls];
}


function buildMdInTab(html, baseUrl, title, imageMapEntries, cleanOnly) {
  const imageMap = Object.fromEntries(imageMapEntries);

  function cleanDoc(doc, remove) {
    doc.querySelectorAll('script, style, noscript, template').forEach(e => e.remove());
    doc.querySelectorAll(
      '.material-icons, .material-icons-outlined, .material-icons-round, ' +
      '.material-icons-sharp, .material-icons-two-tone'
    ).forEach(e => e.remove());
    if (!remove) return;
    doc.querySelectorAll(
      'nav, footer, aside, [role="banner"], [role="navigation"], [role="complementary"], ' +
      '.sidebar, .ads, .advertisement, .cookie-banner, #cookie-notice, ' +
      '.component-loader, .loadingevent-container, .application-tools, ' +
      '.drawerlasagna, .notificationcenter, .banner-container, ' +
      '[class*="prev-next"], [class*="article-nav"], [class*="page-nav"], ' +
      '[class*="language-switch"], [class*="language-select"], ' +
      '[class*="lang-select"], [class*="breadcrumb"]'
    ).forEach(e => e.remove());
  }

  function resolveUrl(url, base) {
    if (!url || url.startsWith('data:')) return url || '';
    try { return new URL(url, base).href; } catch { return url; }
  }

  function nodeToMd(node, base, imap) {
    if (node.nodeType === Node.TEXT_NODE)
      return node.textContent.replace(/[\r\n]+/g, ' ').replace(/ {2,}/g, ' ');
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
        .map(im => nodeToMd(im, base, imap))
        .join('');
    }
    const kids = () => Array.from(node.childNodes).map(n => nodeToMd(n, base, imap)).join('');
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
          const cls = node.className || '', txt = node.textContent.trim();
          if (/material-icon|^mi$/i.test(cls)) return '';
          if (/^[a-z][a-z0-9_-]*$/.test(txt) || /^[-]$/.test(txt)) return '';
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
        // KaTeX 화살표용 width="400em" data: SVG는 장식용이라 본문에 넣지 않는다.
        if (node.closest('.katex, .katex-html, .math-block, mjx-container')) return '';
        const raw = node.getAttribute('data-lazy-src') || node.getAttribute('data-lazy') || node.getAttribute('data-src') || node.getAttribute('data-original') || node.getAttribute('src') || '';
        if (!raw) return '';
        const resolved = resolveUrl(raw, base);
        const mapped   = imap?.[resolved] ?? resolved;
        const alt = node.getAttribute('alt') || '';
        if (!mapped) return '';
        const path = mapped.startsWith('http') || mapped.startsWith('data:')
          ? mapped : mapped.replace(/ /g, '%20');
        return `![${alt}](${path})`;
      }
      case 'li': {
        let inlineParts = '';
        const nestedMds = [];
        for (const child of node.childNodes) {
          const ctag = child.tagName?.toLowerCase();
          if (ctag === 'ul' || ctag === 'ol') {
            const nm = nodeToMd(child, base, imap).trim();
            if (nm) nestedMds.push(nm);
          } else {
            inlineParts += nodeToMd(child, base, imap);
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
            const content = nodeToMd(li, base, imap).trim();
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
            const content = nodeToMd(li, base, imap).trim();
            if (!content) return '';
            const lines = content.split('\n');
            return lines.length === 1
              ? `${prefix}${lines[0]}`
              : `${prefix}${lines[0]}\n${lines.slice(1).map(l => (l ? `${indent}${l}` : '')).join('\n')}`;
          }).filter(Boolean);
        return items.length ? `\n\n${items.join('\n')}\n\n` : '';
      }
      case 'table': {
        const rows = Array.from(node.querySelectorAll('tr'));
        if (!rows.length) return '';
        // Doc platforms (FluidTopics etc.) render code samples as single-column tables.
        // Code lines live as separate block elements (<p class="p_table_l_code">) inside
        // one <td>, with a copy-button row in <thead>. Render as a fenced code block.
        const isSingleCol = rows.every(r => r.querySelectorAll('td, th').length <= 1);
        const isSourceCode = /sourcecode/i.test(node.className) ||
          !!node.querySelector('[class*="table_l_code"], [class*="sourcecode"]');
        if (isSingleCol || isSourceCode) {
          // Explicit <pre> takes priority
          const pre = node.querySelector('td pre');
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
        const cellText = td =>
          Array.from(td.childNodes).map(n => nodeToMd(n, base, imap)).join('').trim()
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

  function postProcessMd(md) {
    const cutMarkers = ['Load more results', 'Expand all\n'];
    for (const marker of cutMarkers) {
      const idx = md.indexOf(marker);
      if (idx !== -1) { md = md.slice(0, idx); break; }
    }
    // Remove lines that are purely whitespace / non-breaking space
    md = md.replace(/^[\s \ufeff]+$/gm, '');

    // Remove lines with 15+ consecutive spaces (layout noise) - protect code fences
    { let _f = false;
      md = md.replace(/^.*$/gm, ln => {
        if (/^```/.test(ln)) _f = !_f;
        return (!_f && / {15,}/.test(ln)) ? '' : ln;
      }); }

    // Remove ft: metadata key-value content
    md = md.replace(/\bft:[A-Za-z]+:?[^\n]*/g, '');

    // Remove Custom metadata panel content
    md = md.replace(/^[^\n]*\bedge:[A-Za-z0-9]+[^\n]*$/gm, '');
    md = md.replace(/^[^\n]*\biirds:[A-Za-z]+[^\n]*$/gm, '');

    // Remove metadata panel header/ID lines
    md = md.replace(/(?:Document|Content|Toc|Source) ID:[^\n]+/g, '');
    md = md.replace(/\bID: [A-Za-z0-9~_-]{5,}[^\n]*/g, '');
    md = md.replace(/\bLast publication:[^\n]+/g, '');
    md = md.replace(/\bSource(?:\s+ID)?:\s+MKDOCS[^\n]*/g, '');

    // Remove Built-in/Custom metadata section headings and empty headings
    md = md.replace(/^#{1,6}\s+(?:Built-in|Custom) metadata\s*$/gim, '');
    md = md.replace(/^#{1,6}\s*$/gm, '');

    // Remove FluidTopics per-topic toolbar text lines
    const TOOLBAR = [
      'Print this topic','Copy link to clipboard','Add to personal book',
      'Add to collection','Add this document to a collection','Download document',
      'Preview document','Send feedback for this topic','Give feedback for this topic','Go to document',
    ];
    for (const phrase of TOOLBAR)
      md = md.replace(new RegExp('^[^\\n]*' + phrase.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '[^\\n]*$','gm'), '');
    md = md.replace(/^[^\n]*(?:Add bookmark|Remove Bookmark)[^\n]*$/gm, '');

    // Remove language switcher and orphan Close lines
    md = md.replace(/^[^\n]*\bLanguage\b[^\n]*\b(?:Open|Close)\b[^\n]*$/gm, '');
    md = md.replace(/^\s*Close\s*$/gm, '');

    // Remove consecutive duplicate headings
    md = md.replace(/(^#{1,6} .+)(\n+\1)+/gm, '$1');

    // Strip leading whitespace from image lines (prevents indented code block)
    md = md.replace(/^[ \t]+(\[?!\[)/gm, '$1');

    // Collapse excess blank lines and trim
    md = md.replace(/\n{3,}/g, '\n\n').trim();

    return md;
  }

  const doc = new DOMParser().parseFromString(html, 'text/html');
  cleanDoc(doc, cleanOnly);

  const PRIORITY = [
    '.se-main-container',
    'article', 'main', '[role="main"]',
    '.post-content', '.entry-content', '.article-body',
    '.markdown-body',
    '.component-content', '.component-main', '.component-content-inner-wrapper',
    '.designed-reader-component', '.FT-page-body', '.ft-page-body',
    '[class*="FT-topic"]', '[class*="FT-content"]', '.FT-main-content',
    '.page-inner', '.book-body',
    '#main-content', '.wiki-content',
    '.rst-content', '.md-content', '.wy-nav-content',
    '.theme-doc-markdown', '.docMainContainer',
    '.post-body', '.content', '#content', '#main', '.container article',
  ];
  let main = doc.body;
  for (const sel of PRIORITY) {
    const el = doc.querySelector(sel);
    if (el && el.innerText.trim().length > 200) { main = el; break; }
  }

  return postProcessMd(nodeToMd(main, baseUrl, imageMap));
}
