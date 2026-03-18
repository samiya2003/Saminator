// popup.js v2.0
// Added: health check query to background — shows a warning banner if
// translation API is failing on the current tab, so user isn't left guessing.

document.addEventListener("DOMContentLoaded", async () => {
  const enabledToggle = document.getElementById("enabledToggle");
  const langSelect    = document.getElementById("langSelect");
  const bilingualCb   = document.getElementById("bilingualCb");
  const statusPill    = document.getElementById("statusPill");
  const statusText    = document.getElementById("statusText");
  const healthBanner  = document.getElementById("healthBanner");

  // Load saved settings
  const data     = await chrome.storage.sync.get(["ust_enabled", "ust_lang", "ust_bilingual"]);
  const enabled  = !!data.ust_enabled;
  const lang     = data.ust_lang || "en";
  const bilingual = !!data.ust_bilingual;

  enabledToggle.checked = enabled;
  langSelect.value      = lang;
  bilingualCb.checked   = bilingual;

  updateStatus(enabled);

  // Check translation health on the active tab
  if (enabled) checkHealth();

  enabledToggle.addEventListener("change", async () => {
    const newEnabled = enabledToggle.checked;
    await chrome.storage.sync.set({ ust_enabled: newEnabled });
    updateStatus(newEnabled);
    if (newEnabled) checkHealth();
    else clearHealth();
  });

  langSelect.addEventListener("change", async () => {
    await chrome.storage.sync.set({ ust_lang: langSelect.value });
  });

  bilingualCb.addEventListener("change", async () => {
    await chrome.storage.sync.set({ ust_bilingual: bilingualCb.checked });
  });

  // ── Health check ────────────────────────────────────────────────────────
  // Queries the background service worker for the error state of the current
  // tab. If translation has been failing, shows a visible warning banner.

  async function checkHealth() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;

      chrome.runtime.sendMessage(
        { type: "UST_HEALTH", tabId: tab.id },
        (state) => {
          if (chrome.runtime.lastError) return; // extension reloading etc
          if (!state) return;
          if (state.failing) {
            showHealthError(state.reason || "Translation API is not responding.");
          } else {
            clearHealth();
          }
        }
      );
    } catch (_) {}
  }

  function showHealthError(message) {
    healthBanner.textContent = "⚠️ " + message;
    healthBanner.className   = "health-banner error";
  }

  function clearHealth() {
    healthBanner.textContent = "";
    healthBanner.className   = "health-banner";
  }

  // ── Status pill ─────────────────────────────────────────────────────────
  function updateStatus(on) {
    statusPill.className = on ? "status-pill on" : "status-pill off";
    statusText.textContent = on ? "Active" : "Inactive";
  }
});
