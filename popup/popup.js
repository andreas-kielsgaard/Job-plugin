(() => {
  "use strict";
  const pageStatus = document.getElementById("pageStatus");
  document.getElementById("extensionVersion").textContent = `v${browser.runtime.getManifest().version}`;
  const loadButton = document.getElementById("load");
  const filterButton = document.getElementById("filter");
  const loaded = document.getElementById("loaded");
  const total = document.getElementById("total");
  let tabId = null;

  document.getElementById("settings").addEventListener("click", () => browser.runtime.openOptionsPage());
  loadButton.addEventListener("click", () => sendAction("JAS_LOAD_ALL"));
  filterButton.addEventListener("click", () => sendAction("JAS_OPEN_AI"));
  init();

  async function init() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https:\/\/jobnet\.dk\/find-job(?:[?#]|$)/.test(tab.url || "")) {
      pageStatus.textContent = "Open a Jobnet search page to use loading and filtering.";
      loadButton.disabled = filterButton.disabled = true;
      return;
    }
    tabId = tab.id;
    await refresh();
  }

  async function refresh() {
    try {
      const status = await browser.tabs.sendMessage(tabId, { type: "JAS_STATUS" });
      loaded.textContent = String(status.loaded);
      total.textContent = status.advertised ? `${status.advertised.toLocaleString()} results in this search` : "";
      pageStatus.textContent = status.busy ? status.message : status.loaded ? "Ready on this Jobnet search." : "Jobnet is loading results. Reopen the popup shortly.";
      loadButton.disabled = filterButton.disabled = status.busy || !status.loaded;
    } catch (error) {
      pageStatus.textContent = "Reload this Jobnet tab after loading the extension.";
      loadButton.disabled = filterButton.disabled = true;
    }
  }

  async function sendAction(type) {
    if (!tabId) return;
    try {
      const response = await browser.tabs.sendMessage(tabId, { type });
      if (!response?.ok) { pageStatus.textContent = response?.error || "Could not start."; return; }
      window.close();
    } catch (error) {
      pageStatus.textContent = "Reload the Jobnet tab and try again.";
    }
  }
})();
