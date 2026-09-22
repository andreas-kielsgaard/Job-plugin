(() => {
  "use strict";
  const form = document.getElementById("settingsForm");
  const key = document.getElementById("apiKey");
  const cv = document.getElementById("cv");
  const preferences = document.getElementById("preferences");
  const model = document.getElementById("model");
  const keyStatus = document.getElementById("keyStatus");
  const notice = document.getElementById("notice");

  load();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const settings = await browser.runtime.sendMessage({ type: "JAS_SAVE_SETTINGS", settings: {
        apiKey: key.value, cv: cv.value, preferences: preferences.value, model: model.value
      } });
      key.value = "";
      renderKey(settings.hasApiKey);
      notice.textContent = "Settings saved.";
    } catch (error) {
      notice.textContent = `Could not save settings: ${error.message}`;
    }
  });
  document.getElementById("deleteKey").addEventListener("click", async () => {
    const settings = await browser.runtime.sendMessage({ type: "JAS_DELETE_KEY" });
    key.value = "";
    renderKey(settings.hasApiKey);
    notice.textContent = "Saved key removed.";
  });

  async function load() {
    try {
      const settings = await browser.runtime.sendMessage({ type: "JAS_GET_SETTINGS" });
      cv.value = settings.cv;
      preferences.value = settings.preferences;
      model.value = settings.model;
      renderKey(settings.hasApiKey);
    } catch (error) {
      notice.textContent = `Could not load settings: ${error.message}`;
    }
  }

  function renderKey(saved) {
    keyStatus.textContent = saved ? "A key is saved locally. Leave this field blank to keep it." : "No API key saved.";
    document.getElementById("deleteKey").disabled = !saved;
  }
})();
