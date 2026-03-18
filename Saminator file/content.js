// content.js — Universal Subtitle Translator v2.0
// Key improvements over v1:
//  1. Fixed needsTranslation() — old 15% ASCII threshold was too aggressive,
//     skipping mixed Chinese+English subtitles (very common on BiliBili)
//  2. XHR/fetch interception — catches subtitle JSON files loaded dynamically
//     before they hit the DOM, giving us the source text ahead of time
//  3. Subtitle restoration — when user disables, original text is put back
//  4. BiliBili shadow DOM pierce — some BiliBili players use shadow roots;
//     we now walk them to find subtitle nodes
//  5. Smarter deduplication — prevents the same element being queued twice
//  6. targetLang now respected fully — cache is keyed by [text, lang] pair

(function () {
  if (window.__UST_INJECTED__) return;
  window.__UST_INJECTED__ = true;

  // ──────────────────────────────────────────────────────────────────────────
  // CONFIG
  // ──────────────────────────────────────────────────────────────────────────

  const POLL_INTERVAL_MS = 50; // faster DOM scan

  // Cache keyed as "lang:text" so switching language doesn't serve stale results
  const CACHE = new Map();

  let settings = {
    enabled: false,
    targetLang: "en",
    showOriginal: false,
  };

  // ──────────────────────────────────────────────────────────────────────────
  // SUBTITLE SELECTORS
  // Extended with more BiliBili selectors and common player frameworks
  // ──────────────────────────────────────────────────────────────────────────

  const SUBTITLE_SELECTORS = [
    // BiliBili (current player — bpx)
    ".bpx-player-subtitle-item-text",
    ".bpx-player-subtitle-item-text > span",
    ".bpx-player-subtitle-main",
    ".bpx-player-subtitle-main > span",
    ".bpx-player-subtitle-line",
    ".bpx-player-subtitle-content",
    ".bpx-player-subtitle-wrap span",

    // BiliBili (legacy player)
    ".bili-subtitle-x-subtitle-panel-text",
    ".bilibili-player-video-subtitle .subtitle-item-text",
    ".bilibili-player-video-subtitle-item-text",
    ".subtitle-item-text",

    // YouTube
    ".ytp-caption-segment",
    ".caption-visual-line",
    ".ytp-caption-window-container span",

    // Vimeo
    ".vp-captions span",
    ".vp-captions p",

    // Generic
    "[class*='subtitle-text']",
    "[class*='caption-text']",
    "[class*='SubtitleText']",
    "[class*='CaptionText']",
    ".subtitles span",
    ".captions span",
    ".player-subtitles span",
    ".video-subtitle",
    ".video-caption",
    "[data-subtitle]",

    // Video.js / Plyr / WebVTT rendered cues
    ".vjs-text-track-cue span",
    ".plyr__captions span",
    ".plyr__captions p",
    "div.cue",
    ".cue span",
  ];

  const SELECTOR_STRING = SUBTITLE_SELECTORS.join(",");

  // ──────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ──────────────────────────────────────────────────────────────────────────

  function normalize(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function cacheKey(text) {
    return `${settings.targetLang}:${text}`;
  }

  function cacheGet(text) {
    return CACHE.get(cacheKey(text));
  }

  function cacheSet(text, translation) {
    CACHE.set(cacheKey(text), translation);
  }

  function cacheHas(text) {
    return CACHE.has(cacheKey(text));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // NEEDS TRANSLATION — FIXED
  //
  // v1 used a 15% non-ASCII threshold which broke on mixed Chinese+English
  // text like "我喜欢 Marvel 漫画" — only ~40% non-ASCII, but clearly needs
  // translation. New logic: if ANY CJK/Arabic/Korean/Japanese character
  // is present, translate. We only skip pure ASCII (no foreign chars at all).
  // ──────────────────────────────────────────────────────────────────────────

  function hasCJK(text)      { return /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F]/.test(text); }
  function hasArabic(text)   { return /[\u0600-\u06FF]/.test(text); }
  function hasCyrillic(text) { return /[\u0400-\u04FF]/.test(text); }
  function hasKorean(text)   { return /[\uAC00-\uD7AF\u1100-\u11FF]/.test(text); }
  function hasJapanese(text) { return /[\u3040-\u309F\u30A0-\u30FF]/.test(text); }

  function needsTranslation(text) {
    if (!text || text.length < 2) return false;
    // If already targeting a non-Latin lang, translate everything non-trivial
    if (settings.targetLang !== "en" && settings.targetLang !== "fr" &&
        settings.targetLang !== "de" && settings.targetLang !== "es") {
      return text.length > 2;
    }
    // Otherwise: only translate if foreign script chars are present
    return hasCJK(text) || hasArabic(text) || hasCyrillic(text) ||
           hasKorean(text) || hasJapanese(text);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TRANSLATION QUEUE — batched, debounced
  // ──────────────────────────────────────────────────────────────────────────

  const pendingCallbacks = new Map(); // source → [callback]
  const translateQueue   = new Set();
  let translateTimer     = null;

  function requestTranslation(text, callback) {
    if (cacheHas(text)) {
      callback(cacheGet(text));
      return;
    }
    if (!pendingCallbacks.has(text)) pendingCallbacks.set(text, []);
    pendingCallbacks.get(text).push(callback);
    translateQueue.add(text);

    // Fire immediately — no debounce delay.
    // We use a 0ms setTimeout only to coalesce texts that arrive in the same
    // synchronous frame (e.g. two subtitle spans updated at once).
    if (!translateTimer) translateTimer = setTimeout(flushQueue, 0);
  }

  function flushQueue() {
    translateTimer = null;
    if (!translateQueue.size) return;

    const batch = Array.from(translateQueue);
    translateQueue.clear();

    chrome.runtime.sendMessage(
      { type: "UST_TRANSLATE", texts: batch, targetLang: settings.targetLang },
      (response) => {
        if (!response || !response.ok) return;
        response.translations.forEach((translated, i) => {
          const source = batch[i];
          if (translated && translated !== source) {
            cacheSet(source, translated);
            (pendingCallbacks.get(source) || []).forEach(cb => cb(translated));
            pendingCallbacks.delete(source);
          }
        });
      }
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ELEMENT STATE — tracks original + translated text per element
  // ──────────────────────────────────────────────────────────────────────────

  const elementState = new WeakMap();

  function getState(el) {
    if (!elementState.has(el)) elementState.set(el, { original: null, translated: null });
    return elementState.get(el);
  }

  function applyToElement(el) {
    if (!el || !el.isConnected) return;

    const raw = normalize(el.textContent || "");
    if (!raw || raw.length > 500) return;

    const state = getState(el);

    // If we're looking at already-translated text, recover the original
    const source = (state.translated && state.translated === raw && state.original)
      ? state.original
      : raw;

    if (!needsTranslation(source)) return;

    // Don't re-queue if translation is already pending or done
    if (state.original === source && state.translated !== source) return;

    state.original = source;

    if (cacheHas(source)) {
      renderTranslation(el, source, cacheGet(source));
      return;
    }

    requestTranslation(source, translated => {
      if (el.isConnected) renderTranslation(el, source, translated);
    });
  }

  function renderTranslation(el, source, translated) {
    if (!el.isConnected || !translated) return;
    const state = getState(el);

    const output = settings.showOriginal
      ? `${translated}\n${source}`
      : translated;

    if (settings.showOriginal) el.style.whiteSpace = "pre-line";

    state.original   = source;
    state.translated = output;
    el.textContent   = output;
  }

  // Restore all translated elements to their original text
  function restoreAll() {
    try {
      document.querySelectorAll(SELECTOR_STRING).forEach(el => {
        const state = elementState.get(el);
        if (state && state.original) {
          el.textContent = state.original;
          el.style.whiteSpace = "";
          state.translated = null;
        }
      });
    } catch (_) {}
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SHADOW DOM PIERCING — BiliBili uses shadow roots in some player versions
  // We walk the shadow tree recursively to find subtitle nodes
  // ──────────────────────────────────────────────────────────────────────────

  function queryShadowAll(root, selector, results = []) {
    try {
      root.querySelectorAll(selector).forEach(el => results.push(el));
      root.querySelectorAll("*").forEach(el => {
        if (el.shadowRoot) queryShadowAll(el.shadowRoot, selector, results);
      });
    } catch (_) {}
    return results;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // XHR / FETCH INTERCEPTION — catches subtitle JSON files loaded dynamically
  //
  // BiliBili loads subtitles as JSON blobs via fetch/XHR before injecting
  // them into the DOM. By intercepting these, we can pre-warm the cache
  // so subtitles appear in English the moment they're rendered.
  // ──────────────────────────────────────────────────────────────────────────

  function interceptSubtitleRequests() {
    // Intercept fetch
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (isSubtitleUrl(url)) {
        response.clone().json().then(data => preWarmFromJSON(data)).catch(() => {});
      }
      return response;
    };

    // Intercept XHR
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__ust_url__ = url;
      return origOpen.call(this, method, url, ...rest);
    };

    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("load", () => {
        if (isSubtitleUrl(this.__ust_url__ || "")) {
          try {
            const data = JSON.parse(this.responseText);
            preWarmFromJSON(data);
          } catch (_) {}
        }
      });
      return origSend.apply(this, args);
    };
  }

  function isSubtitleUrl(url) {
    return /subtitle|subtitles|caption|captions|\.srt|\.vtt|\.ass/i.test(url) ||
           /aisubtitle|subtitle_list|cc\.json|subtitle\.json/i.test(url);
  }

  // BiliBili subtitle JSON format:
  // { body: [ { content: "文字", from: 1.0, to: 2.0 }, ... ] }
  function preWarmFromJSON(data) {
    if (!settings.enabled) return;
    const lines = [];
    if (Array.isArray(data?.body)) {
      data.body.forEach(item => {
        if (typeof item.content === "string") lines.push(item.content);
      });
    }
    if (Array.isArray(data?.data?.body)) {
      data.data.body.forEach(item => {
        if (typeof item.content === "string") lines.push(item.content);
      });
    }
    if (lines.length > 0) {
      console.log(`[UST] Pre-warming cache with ${lines.length} subtitle lines`);
      lines.filter(l => needsTranslation(l)).forEach(line => {
        if (!cacheHas(line)) requestTranslation(line, () => {});
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // MAIN SCAN LOOP
  // ──────────────────────────────────────────────────────────────────────────

  let pollInterval = null;
  let observer     = null;

  function scanPage() {
    if (!settings.enabled) return;
    try {
      // Regular DOM scan
      document.querySelectorAll(SELECTOR_STRING).forEach(applyToElement);
      // Shadow DOM scan (BiliBili's newer player)
      queryShadowAll(document.body, SELECTOR_STRING).forEach(applyToElement);
    } catch (_) {}
  }

  function startTranslating() {
    stopTranslating();
    pollInterval = setInterval(scanPage, POLL_INTERVAL_MS);
    observer = new MutationObserver(() => {
      if (settings.enabled) scanPage();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    scanPage();
  }

  function stopTranslating() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    if (observer)     { observer.disconnect(); observer = null; }
    restoreAll();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SETTINGS SYNC
  // ──────────────────────────────────────────────────────────────────────────

  function loadSettings(callback) {
    chrome.storage.sync.get(["ust_enabled", "ust_lang", "ust_bilingual"], data => {
      settings.enabled      = !!data.ust_enabled;
      settings.targetLang   = data.ust_lang || "en";
      settings.showOriginal = !!data.ust_bilingual;
      if (callback) callback();
    });
  }

  chrome.storage.onChanged.addListener(changes => {
    const oldLang = settings.targetLang;

    if (changes.ust_enabled  !== undefined) settings.enabled      = changes.ust_enabled.newValue;
    if (changes.ust_lang     !== undefined) settings.targetLang   = changes.ust_lang.newValue;
    if (changes.ust_bilingual !== undefined) settings.showOriginal = changes.ust_bilingual.newValue;

    if (changes.ust_lang && changes.ust_lang.newValue !== oldLang) {
      CACHE.clear(); // language changed — all cached translations are wrong now
    }

    if (settings.enabled) {
      startTranslating();
    } else {
      stopTranslating();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // INIT
  // ──────────────────────────────────────────────────────────────────────────

  interceptSubtitleRequests();

  loadSettings(() => {
    if (settings.enabled) startTranslating();
  });
})();
