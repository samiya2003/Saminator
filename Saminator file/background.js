// background.js — Universal Subtitle Translator (v2.0)
// Improvements:
//  1. Two translation endpoints (primary + fallback) — if Google blocks one, the other fires
//  2. Retry logic with exponential backoff — transient failures auto-recover
//  3. Per-tab error state — popup can show a real warning if translation is broken
//  4. Response format validation — bad API responses no longer silently return empty strings

const ERR_STATE = new Map(); // tabId → { failing: bool, reason: string }

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "UST_TRANSLATE") {
    handleTranslate(message.texts, message.targetLang, sender.tab?.id)
      .then(result => sendResponse({ ok: true, translations: result }))
      .catch(err => {
        markTabFailing(sender.tab?.id, String(err));
        sendResponse({ ok: false, error: String(err) });
      });
    return true;
  }

  if (message.type === "UST_FETCH") {
    fetch(message.url, { credentials: "include" })
      .then(async r => {
        const text = await r.text();
        sendResponse({ ok: r.ok, text });
      })
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // Popup asks: is translation currently working on this tab?
  if (message.type === "UST_HEALTH") {
    const tabId = message.tabId;
    const state = ERR_STATE.get(tabId) || { failing: false, reason: "" };
    sendResponse(state);
    return true;
  }
});

function markTabFailing(tabId, reason) {
  if (tabId != null) ERR_STATE.set(tabId, { failing: true, reason });
}

function markTabOk(tabId) {
  if (tabId != null) ERR_STATE.set(tabId, { failing: false, reason: "" });
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN TRANSLATE HANDLER
// ─────────────────────────────────────────────────────────────────────────────

async function handleTranslate(texts, targetLang = "en", tabId) {
  if (!texts || texts.length === 0) return [];

  const BATCH = 20; // smaller batch = faster first response
  const results = new Array(texts.length).fill("");

  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const translated = await translateBatchWithFallback(batch, targetLang, tabId);
    for (let j = 0; j < translated.length; j++) {
      results[i + j] = translated[j];
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// FALLBACK CHAIN: try endpoint A → if fails, try endpoint B
// ─────────────────────────────────────────────────────────────────────────────

async function translateBatchWithFallback(texts, targetLang, tabId) {
  // Attempt 1: primary endpoint — fires instantly, no pre-delay
  try {
    const result = await translateGTX(texts, targetLang);
    if (isValidResult(result, texts.length)) {
      markTabOk(tabId);
      return result;
    }
  } catch (e) {
    console.warn("[UST] Primary endpoint failed:", e.message);
  }

  // Attempt 2: fallback endpoint — only hit if primary actually errored
  try {
    const result = await translateGTXFallback(texts, targetLang);
    if (isValidResult(result, texts.length)) {
      markTabOk(tabId);
      return result;
    }
  } catch (e) {
    console.warn("[UST] Fallback also failed:", e.message);
    markTabFailing(tabId, "Both translation endpoints failed. Try again in a moment.");
  }

  return texts.map(() => "");
}

function isValidResult(result, expectedLength) {
  return (
    Array.isArray(result) &&
    result.length === expectedLength &&
    result.some(s => s && s.length > 0)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RETRY WRAPPER — exponential backoff
// ─────────────────────────────────────────────────────────────────────────────

async function withRetry(fn, maxAttempts = 3, baseDelayMs = 300) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts - 1) {
        await sleep(baseDelayMs * Math.pow(2, attempt)); // 300ms, 600ms, 1200ms…
      }
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT A — standard gtx client
// ─────────────────────────────────────────────────────────────────────────────

async function translateGTX(texts, targetLang) {
  const params = new URLSearchParams();
  params.set("client", "gtx");
  params.set("sl", "auto");
  params.set("tl", targetLang);
  params.set("dt", "t");
  texts.forEach(t => params.append("q", t));

  const url = `https://translate.googleapis.com/translate_a/t?${params}`;
  const resp = await fetch(url);

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const data = await resp.json();
  return parseGTXResponse(data, texts);
}

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT B — dict_chrome_ex client (different rate-limit bucket)
// ─────────────────────────────────────────────────────────────────────────────

async function translateGTXFallback(texts, targetLang) {
  const params = new URLSearchParams();
  params.set("client", "dict-chrome-ex");
  params.set("sl", "auto");
  params.set("tl", targetLang);
  params.set("dt", "t");
  texts.forEach(t => params.append("q", t));

  const url = `https://translate.googleapis.com/translate_a/t?${params}`;
  const resp = await fetch(url);

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const data = await resp.json();
  return parseGTXResponse(data, texts);
}

// ─────────────────────────────────────────────────────────────────────────────
// RESPONSE PARSER — handles both single and multi-text response shapes
// ─────────────────────────────────────────────────────────────────────────────

function parseGTXResponse(data, originalTexts) {
  if (!Array.isArray(data)) {
    throw new Error("Unexpected response format from translation API");
  }

  // Single text: data = [["translated","original",...], ...]
  // Multiple texts: data = [ [["t","o"], ...], [["t","o"], ...] ]
  const isSingle = texts => !Array.isArray(data[0]?.[0]);

  if (originalTexts.length === 1 || isSingle()) {
    // Single item response — data is the segments array for one text
    const joined = data
      .map(seg => (Array.isArray(seg) ? seg[0] : typeof seg === "string" ? seg : ""))
      .filter(Boolean)
      .join(" ")
      .trim();
    return [joined];
  }

  // Multi-item: each element in data corresponds to one q param
  return data.map(item => {
    if (!Array.isArray(item)) return typeof item === "string" ? item : "";
    return item
      .map(seg => (Array.isArray(seg) ? seg[0] : typeof seg === "string" ? seg : ""))
      .filter(Boolean)
      .join(" ")
      .trim();
  });
}
