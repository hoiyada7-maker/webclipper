// Service worker: CORS-free image fetching + file downloads.
// DOMParser is NOT available here — all HTML parsing happens in popup.js.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'FETCH_IMG') {
    fetchAsDataUrl(msg.url)
      .then(sendResponse)
      .catch(() => sendResponse(null));
    return true; // async
  }

  if (msg.type === 'DOWNLOAD') {
    chrome.downloads.download(
      { url: msg.dataUrl, filename: msg.filename, saveAs: false },
      (id) => sendResponse({ id: id ?? null })
    );
    return true;
  }
});

async function fetchAsDataUrl(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return blobToDataUrl(blob);
}

// FileReader is unavailable in service workers — use ArrayBuffer + btoa instead.
async function blobToDataUrl(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const CHUNK = 8192;
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`;
}
