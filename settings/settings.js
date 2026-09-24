(() => {
  "use strict";
  const form = document.getElementById("settingsForm");
  const key = document.getElementById("apiKey");
  const jevKey = document.getElementById("jevApiKey");
  const cv = document.getElementById("cv");
  const preferences = document.getElementById("preferences");
  const model = document.getElementById("model");
  const detailLanes = document.getElementById("detailLanes");
  const pdfInput = document.getElementById("cvPdf");
  const pdfStatus = document.getElementById("pdfStatus");
  const keyStatus = document.getElementById("keyStatus");
  const jevKeyStatus = document.getElementById("jevKeyStatus");
  const notice = document.getElementById("notice");
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const panels = { model: document.getElementById("model-panel"), profile: document.getElementById("profile-panel") };
  let noticeTimer;

  load().finally(focusRequestedField);
  window.addEventListener("hashchange", focusRequestedField);
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => showTab(tab.dataset.tab));
    tab.addEventListener("keydown", (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const next = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      showTab(next.dataset.tab);
      next.focus();
    });
  });
  pdfInput.addEventListener("change", importPdf);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const settings = await browser.runtime.sendMessage({ type: "JAS_SAVE_SETTINGS", settings: {
        apiKey: key.value, jevApiKey: jevKey.value, cv: cv.value, preferences: preferences.value,
        model: model.value, detailLanes: detailLanes.value
      } });
      key.value = "";
      jevKey.value = "";
      renderKey(settings.hasApiKey);
      renderJevKey(settings.hasJevApiKey);
      showSaved();
    } catch (error) {
      clearTimeout(noticeTimer);
      notice.classList.remove("jas-saved");
      notice.textContent = `Could not save settings: ${error.message}`;
    }
  });

  async function importPdf() {
    const file = pdfInput.files?.[0];
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      pdfStatus.textContent = "Choose a PDF file.";
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      pdfStatus.textContent = "This PDF is over the 15 MB import limit.";
      return;
    }
    pdfInput.disabled = true;
    pdfStatus.textContent = `Reading ${file.name}…`;
    try {
      const pdfjs = await import(browser.runtime.getURL("vendor/pdfjs/pdf.min.mjs"));
      pdfjs.GlobalWorkerOptions.workerSrc = browser.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");
      const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
      const document = await task.promise;
      const pageCount = document.numPages;
      const pages = [];
      try {
        for (let index = 1; index <= document.numPages; index += 1) {
          pdfStatus.textContent = `Extracting page ${index} of ${document.numPages}…`;
          const page = await document.getPage(index);
          const content = await page.getTextContent();
          pages.push(content.items.map((item) => `${item.str || ""}${item.hasEOL ? "\n" : " "}`).join("").trim());
          page.cleanup();
        }
      } finally {
        await task.destroy();
      }
      const extracted = pages.filter(Boolean).join("\n\n").replace(/[ \t]+\n/g, "\n").trim();
      if (!extracted) throw new Error("No selectable text found. Scanned PDFs need OCR before import.");
      cv.value = extracted.slice(0, cv.maxLength);
      pdfStatus.textContent = extracted.length > cv.maxLength
        ? `Extracted ${pageCount} pages. Text was shortened to ${cv.maxLength.toLocaleString()} characters; review and save it.`
        : `Extracted ${pageCount} pages into CV text. Review and save it.`;
      notice.textContent = "CV import is ready to save.";
    } catch (error) {
      pdfStatus.textContent = `Could not import PDF: ${error.message}`;
    } finally {
      pdfInput.disabled = false;
      pdfInput.value = "";
    }
  }
  document.getElementById("deleteKey").addEventListener("click", async () => {
    const settings = await browser.runtime.sendMessage({ type: "JAS_DELETE_KEY" });
    key.value = "";
    renderKey(settings.hasApiKey);
    notice.textContent = "Saved key removed.";
  });
  document.getElementById("deleteJevKey").addEventListener("click", async () => {
    const settings = await browser.runtime.sendMessage({ type: "JAS_DELETE_JEV_KEY" });
    jevKey.value = "";
    renderJevKey(settings.hasJevApiKey);
    notice.textContent = "Saved TypeSafe key removed.";
  });

  async function load() {
    try {
      const settings = await browser.runtime.sendMessage({ type: "JAS_GET_SETTINGS" });
      cv.value = settings.cv;
      preferences.value = settings.preferences;
      model.value = settings.model;
      detailLanes.value = String(settings.detailLanes);
      renderKey(settings.hasApiKey);
      renderJevKey(settings.hasJevApiKey);
    } catch (error) {
      notice.textContent = `Could not load settings: ${error.message}`;
    }
  }

  function renderKey(saved) {
    keyStatus.textContent = saved ? "A key is saved locally. Leave this field blank to keep it." : "No API key saved.";
    document.getElementById("deleteKey").disabled = !saved;
  }
  function renderJevKey(saved) {
    jevKeyStatus.textContent = saved ? "" : "No TypeSafe API key saved.";
    document.getElementById("deleteJevKey").disabled = !saved;
  }

  function showSaved() {
    clearTimeout(noticeTimer);
    notice.classList.remove("jas-saved");
    void notice.offsetWidth;
    notice.textContent = "Settings saved.";
    notice.classList.add("jas-saved");
    noticeTimer = setTimeout(() => {
      notice.textContent = "";
      notice.classList.remove("jas-saved");
    }, 2200);
  }

  function showTab(name) {
    for (const tab of tabs) {
      const selected = tab.dataset.tab === name;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== name;
  }

  function focusRequestedField() {
    const target = location.hash === "#jev-settings"
      ? { section: document.getElementById("jev-settings"), field: jevKey }
      : location.hash === "#claude-settings"
        ? { section: document.getElementById("claude-settings"), field: key }
        : null;
    if (!target) {
      if (location.hash === "#profile") showTab("profile");
      return;
    }
    showTab("model");
    target.section.open = true;
    document.querySelectorAll(".settings-attention").forEach((element) => element.classList.remove("settings-attention"));
    target.section.scrollIntoView({ behavior: "smooth", block: "center" });
    target.field.focus({ preventScroll: true });
    void target.field.offsetWidth;
    target.field.classList.add("settings-attention");
    setTimeout(() => target.field.classList.remove("settings-attention"), 2600);
  }
})();
