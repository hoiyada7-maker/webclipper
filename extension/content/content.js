// Injected into the active tab. Handles DOM extraction and auto-scroll.
// Guard: skip listener registration if already injected via executeScript.
if (!window._clipperInjected) {
  window._clipperInjected = true;

  // FT 같은 SPA에서 mapId 감지에 쓰는 resource timing 기록이 기본 250개 버퍼를
  // 넘으면 이후 API 호출 기록이 유실되므로 버퍼를 크게 늘린다.
  try { performance.setResourceTimingBufferSize(50000); } catch (_) {}

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'AUTO_SCROLL') {
      autoScroll().then(() => sendResponse({ done: true }));
      return true; // async
    }

    if (msg.type === 'EXTRACT_HTML') {
      waitForContent(msg.waitMs ?? 0).then(() => {
        sendResponse({
          html: extractHtml(),
          url: location.href,
          title: document.title,
        });
      });
      return true; // async
    }
  });
}

// Waits until the page has meaningful content (SPA-safe).
// Handles FluidTopics (component-loader/loadingevent-container),
// generic SPAs, and loading-text patterns.
async function waitForContent(extraMs = 0) {
  const LOADING_TEXT = [/loading application/i, /please wait/i, /initializing\.\.\./i];
  const LOADING_SELECTORS = [
    '.component-loader',       // FluidTopics
    '.loadingevent-container', // FluidTopics
    '[class*="loading-overlay"]',
    '#app-loading',
    '#loading',
  ];
  const CONTENT_SELECTORS = [
    '.component-content',              // FluidTopics
    '.component-main',                 // FluidTopics
    '.component-content-inner-wrapper',// FluidTopics
    'article', 'main', '[role="main"]',
    '.markdown-body', '.post-content',
  ];
  const MIN_TEXT_LENGTH = 400;
  const POLL_INTERVAL   = 250;
  const TIMEOUT_MS      = 20000;

  const hasLoadingIndicator = () =>
    LOADING_SELECTORS.some(sel => {
      const el = document.querySelector(sel);
      return el && el.offsetParent !== null; // visible
    });

  const hasContentElement = () =>
    CONTENT_SELECTORS.some(sel => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const len = Math.max(
        el.innerText?.trim().length ?? 0,
        el.shadowRoot?.textContent?.trim().length ?? 0
      );
      return len > MIN_TEXT_LENGTH;
    });

  const isSpaShell = () => {
    const text = document.body?.innerText?.trim() ?? '';
    if (hasContentElement()) return false;
    if (text.length < MIN_TEXT_LENGTH) return true;
    return LOADING_TEXT.some(re => re.test(text));
  };

  if (isSpaShell() || hasLoadingIndicator()) {
    await new Promise((resolve) => {
      const start = Date.now();
      const id = setInterval(() => {
        const ready = (!isSpaShell() && !hasLoadingIndicator()) ||
                      Date.now() - start > TIMEOUT_MS;
        if (ready) { clearInterval(id); resolve(); }
      }, POLL_INTERVAL);
    });
  }

  // Extra settle time requested by popup (SPA 대기 checkbox → 2000 ms)
  if (extraMs > 0) await new Promise(r => setTimeout(r, extraMs));
}

// Shadow-DOM-aware querySelectorAll.
// document.querySelectorAll() does NOT pierce shadow roots, so content elements
// nested inside custom web components (e.g. FluidTopics) are invisible to it.
// This function recursively searches each shadow root.
function deepQueryAll(root, selector) {
  const results = [];
  function search(r) {
    try {
      for (const el of r.querySelectorAll(selector)) results.push(el);
      for (const el of r.querySelectorAll('*')) {
        if (el.shadowRoot) search(el.shadowRoot);
      }
    } catch (_) {}
  }
  search(root);
  return results;
}

// Extracts HTML from the page, shadow-DOM-aware.
function extractHtml() {
  const CONTENT_SELS = [
    '.component-content', '.component-main', '.component-content-inner-wrapper',
    'article', 'main', '[role="main"]',
    '.markdown-body', '.post-content', '.entry-content',
  ];

  // Measure text length including direct shadow DOM content
  function textLen(el) {
    const light = el.innerText?.trim().length ?? 0;
    const shadow = el.shadowRoot?.textContent?.trim().length ?? 0;
    return Math.max(light, shadow);
  }

  // Use deepQueryAll so we find elements inside shadow roots (e.g. FluidTopics)
  let best = null;
  let bestLen = 0;
  for (const sel of CONTENT_SELS) {
    for (const el of deepQueryAll(document, sel)) {
      const len = textLen(el);
      if (len > bestLen) { best = el; bestLen = len; }
    }
  }

  const wrap = (body) =>
    `<!DOCTYPE html><html><head><title>${document.title}</title></head><body>${body}</body></html>`;

  if (best && bestLen > 200) {
    return wrap(serializeDeep(best));
  }

  // Full page fallback — always use serializeDeep to capture any shadow DOM
  return wrap(serializeDeep(document.body));
}

// Recursively serializes an element including its shadow DOM content.
// Skips elements that are CSS-hidden (display:none / visibility:hidden) so
// FluidTopics metadata panels, hidden drawers, and overlays are excluded.
function serializeDeep(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const tag = node.tagName.toLowerCase();

  // getComputedStyle resolves shadow-scoped CSS in Chrome content scripts.
  try {
    const cs = window.getComputedStyle(node);
    if (cs.display === 'none' || cs.visibility === 'hidden') return '';
  } catch (_) {}

  const VOID = new Set(['area','base','br','col','embed','hr','img','input',
                        'link','meta','param','source','track','wbr']);
  const attrs = Array.from(node.attributes)
    .map(a => ` ${a.name}="${String(a.value).replace(/"/g, '&quot;')}"`)
    .join('');

  if (VOID.has(tag)) return `<${tag}${attrs}>`;

  const kids = Array.from(node.childNodes).map(serializeDeep).join('');
  const shadow = node.shadowRoot
    ? Array.from(node.shadowRoot.childNodes).map(serializeDeep).join('')
    : '';

  return `<${tag}${attrs}>${kids}${shadow}</${tag}>`;
}

async function autoScroll() {
  const getH = () => Math.max(
    document.body.scrollHeight,
    document.documentElement.scrollHeight
  );
  // Scroll to absolute bottom each tick; stop after 4 consecutive stable readings
  let stable = 0, lastH = -1;
  for (let i = 0; i < 200 && stable < 4; i++) {
    window.scrollTo(0, 999999999);
    // Also try scrolling any tall overflow container (SPA inner scroll areas)
    for (const sel of ['[class*="content"]', 'main', 'article']) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight + 100) el.scrollTop = el.scrollHeight;
    }
    await new Promise(r => setTimeout(r, 1500));
    const h = getH();
    if (h === lastH) stable++;
    else { stable = 0; lastH = h; }
  }
  // Settle: give lazy-loaded images time to fetch before we return to top
  await new Promise(r => setTimeout(r, 1500));
  window.scrollTo(0, 0);
  await new Promise(r => setTimeout(r, 500));
}
