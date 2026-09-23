(() => {
  "use strict";

  if (location.pathname !== "/find-job") return;

  const LABELS = { clear: "Clearly relevant", potential: "Potentially relevant", irrelevant: "Explicitly irrelevant" };
  const state = { phase: "idle", done: 0, total: 0, stop: false, operation: null, message: "Ready", metrics: null };
  let root;
  let logList;
  let statusText;
  let stopButton;
  let promptDialog;
  let keyDialog;
  let pageControls;
  let availableKeys = { hasApiKey: false, hasJevApiKey: false };

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "JAS_STATUS") return Promise.resolve(status());
    if (message?.type === "JAS_LOAD_ALL") return startLoad();
    if (message?.type === "JAS_OPEN_AI") return openPrompt();
    if (message?.type === "JAS_ACTIVITY") {
      ensureUi();
      setStatus(message.text);
      if (!message.transient) log(message.text);
      return undefined;
    }
    return undefined;
  });

  function cards() {
    return [...document.querySelectorAll("#main-content article")].map((article, index) => {
      const link = article.querySelector('a[id^="job-"][id$="-headline"]');
      const id = link?.id.match(/^job-([0-9a-f-]+)-headline$/)?.[1];
      if (!id) return null;
      return {
        id,
        article,
        index,
        title: link.querySelector("h4")?.textContent?.trim() || link.textContent.trim(),
        summary: article.innerText.replace(/\s+/g, " ").trim().slice(0, 3500),
        url: link.href,
        grade: null
      };
    }).filter(Boolean);
  }

  function searchKey() {
    const search = searchInput()?.value || "";
    return `${location.href}|${search}`;
  }

  function searchInput() {
    return document.querySelector('#main-content input[name="searchString"], #main-content input[role="combobox"], #main-content input');
  }

  function advertisedTotal() {
    const text = document.querySelector("#main-content")?.innerText || "";
    const match = text.match(/([\d.]+)\s+stillinger/i);
    return match ? Number(match[1].replaceAll(".", "")) : null;
  }

  function loadButton() {
    return [...document.querySelectorAll("#main-content button")]
      .find((button) => button.textContent.trim() === "Indlæs flere job");
  }

  function status() {
    return { ok: true, phase: state.phase, done: state.done, total: state.total, message: state.message,
      loaded: cards().length, advertised: advertisedTotal(), busy: Boolean(state.operation), metrics: state.metrics };
  }

  function ensureUi() {
    if (!root?.isConnected) {
      root = document.createElement("div");
      root.id = "jas-root";
      root.innerHTML = `
      <aside class="jas-panel" aria-label="Jobnet AI Sorter activity">
        <div class="jas-panel-head"><strong>Jobnet AI Sorter</strong><button class="jas-minimize" type="button" aria-label="Minimize activity">−</button></div>
        <p class="jas-status" role="status"></p>
        <ol class="jas-log" aria-label="Activity"></ol>
        <button class="jas-stop" type="button" hidden>Stop</button>
      </aside>
      <div class="jas-overlay" hidden>
        <section class="jas-dialog" role="dialog" aria-modal="true" aria-labelledby="jas-dialog-title">
          <div class="jas-dialog-head"><h2 id="jas-dialog-title">Filter loaded posts with AI</h2><button class="jas-close" type="button" aria-label="Close">×</button></div>
          <p>Your instruction and saved preferences guide relevance. Your CV helps score qualifications and becomes a relevance fallback when no other job preference is provided. Jev loads full descriptions and evaluates paired category and score questions together.</p>
          <label for="jas-prompt">What should the model prioritize for this search?</label>
          <textarea id="jas-prompt" rows="5" maxlength="6000" placeholder="For example: prioritize senior roles in Copenhagen with flexible work; avoid sales positions."></textarea>
          <label for="jas-provider">Provider for this run</label>
          <select id="jas-provider"><option value="claude">Claude</option><option value="jev">TypeSafe Jev</option></select>
          <div class="jas-claude-model"><label for="jas-model">Claude model type for this run</label>
          <select id="jas-model"><option value="haiku">Haiku</option><option value="sonnet">Sonnet</option><option value="opus">Opus</option></select></div>
          <div class="jas-jev-state-strategy" hidden>
            <label class="jas-check-option"><input id="jas-limit-state-posts" type="checkbox"> Limit the number of posts in each Jev state</label>
            <div class="jas-state-count" hidden><label for="jas-posts-per-state">Maximum posts per state</label><input id="jas-posts-per-state" type="number" min="1" max="50" step="1" value="10"></div>
            <p class="jas-field-hint">The 20k state limit still applies, so long descriptions can produce smaller states.</p>
          </div>
          <label class="jas-load-option"><input id="jas-load-first" type="checkbox"> Load all remaining posts while filtering</label>
          <p class="jas-dialog-note"></p>
          <div class="jas-dialog-actions"><button class="jas-cancel" type="button">Cancel</button><button class="jas-start" type="button">Start filtering</button></div>
        </section>
      </div>
      <div class="jas-key-overlay" hidden>
        <section class="jas-dialog jas-key-dialog" role="dialog" aria-modal="true" aria-labelledby="jas-key-title">
          <div class="jas-dialog-head"><h2 id="jas-key-title">API key required</h2><button class="jas-key-close" type="button" aria-label="Close">×</button></div>
          <p class="jas-key-message"></p>
          <div class="jas-dialog-actions"><button class="jas-key-cancel" type="button">Cancel</button><button class="jas-key-settings" type="button">Take me to settings</button></div>
        </section>
      </div>`;
      document.body.append(root);
      root.querySelector(".jas-panel-head strong").append(` · v${browser.runtime.getManifest().version}`);
      logList = root.querySelector(".jas-log");
      statusText = root.querySelector(".jas-status");
      stopButton = root.querySelector(".jas-stop");
      promptDialog = root.querySelector(".jas-overlay");
      keyDialog = root.querySelector(".jas-key-overlay");
      root.querySelector(".jas-minimize").addEventListener("click", () => root.querySelector(".jas-panel").classList.toggle("jas-collapsed"));
      root.querySelector(".jas-close").addEventListener("click", closePrompt);
      root.querySelector(".jas-cancel").addEventListener("click", closePrompt);
      promptDialog.addEventListener("click", (event) => { if (event.target === promptDialog) closePrompt(); });
      root.querySelector(".jas-start").addEventListener("click", startFilter);
      root.querySelector("#jas-provider").addEventListener("change", updateProvider);
      root.querySelector("#jas-limit-state-posts").addEventListener("change", updateStateStrategy);
      root.querySelector(".jas-key-close").addEventListener("click", closeKeyDialog);
      root.querySelector(".jas-key-cancel").addEventListener("click", closeKeyDialog);
      keyDialog.addEventListener("click", (event) => { if (event.target === keyDialog) closeKeyDialog(); });
      root.querySelector(".jas-key-settings").addEventListener("click", openKeySettings);
      stopButton.addEventListener("click", () => {
        state.stop = true;
        setStatus("Stopping after the current step…");
        browser.runtime.sendMessage({ type: "JAS_CANCEL" }).catch(() => {});
      });
      root.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (!keyDialog.hidden) closeKeyDialog();
        else if (!promptDialog.hidden) closePrompt();
      });
      setStatus(state.message);
    }
    ensurePageControls();
  }

  function ensurePageControls() {
    if (!pageControls) {
      pageControls = document.createElement("section");
      pageControls.id = "jas-page-controls";
      pageControls.setAttribute("aria-label", "Jobnet AI Sorter controls");
      pageControls.innerHTML = `
        <div class="jas-page-heading"><div><span>JOBNET AI SORTER</span><strong>Search assistant</strong></div><small>v${browser.runtime.getManifest().version}</small></div>
        <p class="jas-page-summary"></p>
        <div class="jas-page-actions"><button class="jas-page-load" type="button">Load all posts</button><button class="jas-page-filter" type="button">Filter loaded posts with AI</button><button class="jas-page-settings" type="button">Settings</button></div>`;
      pageControls.querySelector(".jas-page-load").addEventListener("click", startLoad);
      pageControls.querySelector(".jas-page-filter").addEventListener("click", openPrompt);
      pageControls.querySelector(".jas-page-settings").addEventListener("click", () => browser.runtime.openOptionsPage());
    }
    const main = document.querySelector("#main-content");
    const searchButton = [...document.querySelectorAll("#main-content button")].find((button) => button.textContent.trim() === "Søg");
    let searchRow = searchInput() || searchButton || main?.querySelector("h1")?.nextElementSibling;
    while (searchRow?.parentElement && searchRow.parentElement !== main) searchRow = searchRow.parentElement;
    if (searchRow && pageControls.previousElementSibling !== searchRow) searchRow.after(pageControls);
    updatePageControls();
  }

  function updatePageControls() {
    if (!pageControls?.isConnected) return;
    const loaded = cards().length;
    const total = advertisedTotal();
    pageControls.querySelector(".jas-page-summary").textContent = state.operation ? state.message : `${loaded} posts loaded${total ? ` of ${total.toLocaleString()}` : ""}.`;
    pageControls.querySelector(".jas-page-load").disabled = Boolean(state.operation) || !loaded || !loadButton();
    pageControls.querySelector(".jas-page-filter").disabled = Boolean(state.operation) || !loaded;
  }

  function setStatus(text) {
    state.message = text;
    if (statusText) statusText.textContent = text;
    updatePageControls();
  }

  function log(text) {
    ensureUi();
    const item = document.createElement("li");
    item.textContent = text;
    logList.append(item);
    while (logList.children.length > 80) logList.firstElementChild.remove();
    item.scrollIntoView({ block: "nearest" });
  }

  function logBatchResults(batch, number, total) {
    const counts = { clear: 0, potential: 0, irrelevant: 0 };
    for (const job of batch) counts[job.grade.category] += 1;
    const item = document.createElement("li");
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = `Batch ${number}${total ? ` of ${total}` : ""}: ${counts.clear} clear, ${counts.potential} potential, ${counts.irrelevant} irrelevant`;
    const list = document.createElement("ul");
    for (const job of [...batch].sort(JobnetRanking.compare)) {
      const entry = document.createElement("li");
      entry.textContent = `${LABELS[job.grade.category]} · ${job.grade.score}/100 · ${job.title}${job.grade.reason ? `: ${job.grade.reason}` : ""}`;
      list.append(entry);
    }
    details.append(summary, list);
    item.append(details);
    logList.append(item);
    while (logList.children.length > 80) logList.firstElementChild.remove();
    item.scrollIntoView({ block: "nearest" });
  }

  function setRunning(phase, total) {
    ensureUi();
    logList.replaceChildren();
    state.phase = phase;
    state.done = 0;
    state.total = total;
    state.stop = false;
    state.metrics = { requests: 0, elapsedMs: 0, inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, detailRequests: 0, cacheHits: 0 };
    stopButton.hidden = false;
    root.querySelector(".jas-panel").classList.remove("jas-collapsed");
    updatePageControls();
  }

  function finish(phase, text) {
    state.phase = phase;
    state.operation = null;
    stopButton.hidden = true;
    setStatus(text);
    log(text);
  }

  function startLoad() {
    if (state.operation) return Promise.resolve({ ok: false, error: "Another operation is running." });
    if (!cards().length) return Promise.resolve({ ok: false, error: "Wait for Jobnet to load the search results." });
    const total = advertisedTotal();
    setRunning("loading", total || 0);
    log(`Loading this search: ${cards().length}${total ? ` of ${total}` : ""} cards currently visible.`);
    state.operation = Promise.resolve().then(loadAllStandalone);
    return Promise.resolve({ ok: true });
  }

  async function loadAllStandalone() {
    const key = searchKey();
    try {
      const loaded = await loadAllCards(key);
      finish(state.stop ? "stopped" : "done", state.stop ? `Stopped with ${loaded} cards loaded.` : `All available cards loaded: ${loaded}.`);
    } catch (error) {
      finish("error", error.message);
    }
  }

  async function loadAllCards(key, { combined = false } = {}) {
    let failures = 0;
    while (!state.stop) {
      if (searchKey() !== key) throw new Error("The search changed while loading. Start again for the new search.");
      const button = loadButton();
      if (!button) {
        const loaded = cards().length;
        if (state.total && loaded < state.total) throw new Error(`Jobnet stopped offering more cards at ${loaded} of ${state.total} advertised results.`);
        return loaded;
      }
      if (button.getAttribute("aria-disabled") === "true") {
        await waitForReady(key);
        continue;
      }
      const before = cards().length;
      button.click();
      const grew = await waitForMore(before, key);
      if (state.stop) break;
      if (!grew) {
        failures += 1;
        log(`Jobnet did not add cards; retry ${failures} of 3.`);
        if (failures >= 3) throw new Error("Jobnet stopped adding cards. Reload or narrow the search and try again.");
        continue;
      }
      failures = 0;
      const loaded = cards().length;
      if (!combined) state.done = loaded;
      setStatus(combined
        ? `Reviewing loaded posts while Jobnet continues loading: ${loaded}${state.total ? ` of ${state.total}` : ""} available.`
        : `Loaded ${loaded}${state.total ? ` of ${state.total}` : ""} cards…`);
      log(state.message);
    }
    return cards().length;
  }

  function waitForMore(before, key) {
    return new Promise((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const button = loadButton();
        const count = cards().length;
        const changed = count > before && (button?.getAttribute("aria-disabled") !== "true" && Boolean(button)
          || Boolean(state.total && count >= state.total));
        if (changed || state.stop || searchKey() !== key || Date.now() - start > 20000) {
          clearInterval(timer);
          resolve(changed);
        }
      }, 250);
    });
  }

  function waitForReady(key) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const button = loadButton();
        const ready = Boolean(button && button.getAttribute("aria-disabled") !== "true")
          || Boolean(state.total && cards().length >= state.total);
        if (ready || state.stop || searchKey() !== key) { clearInterval(timer); resolve(); }
        else if (Date.now() - start > 20000) { clearInterval(timer); reject(new Error("Jobnet kept the load button disabled.")); }
      }, 250);
    });
  }

  async function openPrompt() {
    if (state.operation) return { ok: false, error: "Stop the current operation first." };
    ensureUi();
    const [settings, modelSettings] = await Promise.all([
      browser.runtime.sendMessage({ type: "JAS_HAS_KEY" }),
      browser.runtime.sendMessage({ type: "JAS_GET_MODEL_TYPE" })
    ]);
    availableKeys = settings;
    if (!availableKeys.hasApiKey && !availableKeys.hasJevApiKey) {
      openKeyDialog();
      return { ok: true };
    }
    if (availableKeys.hasJevApiKey && !availableKeys.hasApiKey) root.querySelector("#jas-provider").value = "jev";
    if (availableKeys.hasApiKey && !availableKeys.hasJevApiKey) root.querySelector("#jas-provider").value = "claude";
    root.querySelector("#jas-model").value = modelSettings.model;
    const loadOption = root.querySelector(".jas-load-option");
    loadOption.hidden = !loadButton();
    root.querySelector("#jas-load-first").checked = false;
    root.querySelector("#jas-limit-state-posts").checked = false;
    root.querySelector("#jas-posts-per-state").value = "10";
    updateProvider();
    promptDialog.hidden = false;
    root.querySelector("#jas-prompt").focus();
    return { ok: true };
  }

  function updateProvider() {
    const jev = root.querySelector("#jas-provider").value === "jev";
    root.querySelector(".jas-claude-model").hidden = jev;
    root.querySelector(".jas-jev-state-strategy").hidden = !jev;
    updateStateStrategy();
    const hasKey = jev ? availableKeys.hasJevApiKey : availableKeys.hasApiKey;
    root.querySelector(".jas-dialog-note").textContent = hasKey
      ? `${cards().length} loaded posts are ready to review.`
      : `${jev ? "TypeSafe Jev" : "Claude"} needs an API key. Starting will take you to settings.`;
    root.querySelector(".jas-start").disabled = !cards().length;
  }

  function updateStateStrategy() {
    const enabled = root.querySelector("#jas-provider").value === "jev" && root.querySelector("#jas-limit-state-posts").checked;
    root.querySelector(".jas-state-count").hidden = !enabled;
    root.querySelector("#jas-posts-per-state").disabled = !enabled;
  }

  function closePrompt() {
    promptDialog.hidden = true;
  }

  function openKeyDialog(provider = null) {
    ensureUi();
    const providerName = provider === "jev" ? "TypeSafe Jev" : "Claude";
    keyDialog.dataset.section = provider === "jev" ? "jev-settings" : "claude-settings";
    root.querySelector("#jas-key-title").textContent = provider ? `${providerName} API key required` : "Configure an AI provider";
    root.querySelector(".jas-key-message").textContent = provider
      ? `A ${providerName} API key is not configured. Add it in settings before filtering.`
      : "No Claude or TypeSafe Jev API key is configured. Add one in settings before filtering.";
    promptDialog.hidden = true;
    keyDialog.hidden = false;
    root.querySelector(".jas-key-settings").focus();
  }

  function closeKeyDialog() {
    keyDialog.hidden = true;
  }

  async function openKeySettings() {
    const response = await browser.runtime.sendMessage({ type: "JAS_OPEN_SETTINGS", section: keyDialog.dataset.section });
    if (response?.ok) closeKeyDialog();
  }

  function startFilter() {
    const prompt = root.querySelector("#jas-prompt").value.trim();
    const model = root.querySelector("#jas-model").value;
    const provider = root.querySelector("#jas-provider").value;
    const hasKey = provider === "jev" ? availableKeys.hasJevApiKey : availableKeys.hasApiKey;
    if (!hasKey) { openKeyDialog(provider); return; }
    if (!prompt) { root.querySelector(".jas-dialog-note").textContent = "Enter an instruction for this run."; return; }
    const limitStatePosts = provider === "jev" && root.querySelector("#jas-limit-state-posts").checked;
    const postsPerState = Math.trunc(Number(root.querySelector("#jas-posts-per-state").value));
    if (limitStatePosts && (postsPerState < 1 || postsPerState > 50)) {
      root.querySelector(".jas-dialog-note").textContent = "Choose 1–50 posts per Jev state.";
      return;
    }
    const loadRemaining = !root.querySelector(".jas-load-option").hidden && root.querySelector("#jas-load-first").checked;
    closePrompt();
    const jobs = cards();
    for (const job of jobs) {
      job.article.classList.remove("jas-clear", "jas-potential", "jas-irrelevant");
      job.article.querySelector(".jas-grade")?.remove();
    }
    setRunning("reviewing", loadRemaining ? advertisedTotal() || jobs.length : jobs.length);
    log(`Started ${provider === "jev" ? "TypeSafe Jev" : `Claude ${model}`} review of ${jobs.length} loaded posts${limitStatePosts ? ` with at most ${postsPerState} posts per state` : ""}${loadRemaining ? " while Jobnet continues loading" : ""}.`);
    state.operation = Promise.resolve().then(() => filterJobs(prompt, model, provider, loadRemaining, limitStatePosts ? postsPerState : null));
  }

  async function filterJobs(prompt, model, provider, loadRemaining, postsPerState) {
    const key = searchKey();
    const name = provider === "jev" ? "TypeSafe Jev" : `Claude ${model}`;
    const batchSize = provider === "jev" ? 50 : 10;
    const jobsById = new Map();
    const processed = new Set();
    let loadingDone = !loadRemaining;
    let loadingError = null;
    let batchNumber = 0;
    const loadPromise = loadRemaining
      ? loadAllCards(key, { combined: true }).catch((error) => { loadingError = error; }).finally(() => { loadingDone = true; })
      : Promise.resolve();
    try {
      while (!state.stop) {
        if (searchKey() !== key) throw new Error("The search changed during filtering. Start again for the new search.");
        for (const job of cards()) {
          const saved = jobsById.get(job.id);
          if (saved) Object.assign(saved, { article: job.article, index: job.index, title: job.title, summary: job.summary, url: job.url });
          else jobsById.set(job.id, job);
        }
        const available = [...jobsById.values()].filter((job) => !processed.has(job.id));
        if (!available.length) {
          if (loadingDone) break;
          await delay(250);
          continue;
        }
        const batch = available.slice(0, batchSize);
        batch.forEach((job) => processed.add(job.id));
        batchNumber += 1;
        setStatus(`Reviewing ${batch.length} posts with ${name}; ${state.done} completed${loadingDone ? "" : `, ${cards().length} loaded so far`}.`);
        log(state.message);
        const response = await browser.runtime.sendMessage({ type: "JAS_GRADE_BATCH", prompt, model, provider, postsPerState,
          jobs: batch.map((job) => ({ id: job.id, title: job.title, summary: job.summary, url: job.url })) });
        if (state.stop) break;
        if (!response?.ok) throw new Error(response?.error || `${name} did not return grades.`);
        if (response.metrics) {
          for (const key of Object.keys(state.metrics)) state.metrics[key] += Number(response.metrics[key] || 0);
        }
        const grades = new Map(response.grades.map((grade) => [grade.id, grade]));
        for (const job of batch) {
          if (!grades.has(job.id)) throw new Error(`${name} omitted a card from this batch.`);
          job.grade = JobnetRanking.normalizeGrade(grades.get(job.id));
          renderGrade(job);
          state.done += 1;
        }
        if (!loadRemaining) sortJobs([...jobsById.values()]);
        logBatchResults(batch, batchNumber, loadRemaining ? null : Math.ceil(jobsById.size / batchSize));
        setStatus(`Completed ${state.done} of ${jobsById.size} loaded posts${loadingDone ? "." : "; Jobnet is still loading."}`);
      }
      await loadPromise;
      if (loadingError) throw loadingError;
      const jobs = [...jobsById.values()];
      sortJobs(jobs);
      log(`${name} API: ${state.metrics.requests} requests, ${state.metrics.inputTokens + state.metrics.cacheCreationTokens + state.metrics.cacheReadTokens} input tokens, ${state.metrics.outputTokens} output tokens. Jobnet details: ${state.metrics.detailRequests} loaded, ${state.metrics.cacheHits} reused.`);
      finish(state.stop ? "stopped" : "done", `${state.stop ? "Stopped" : "Finished"}: ${state.done} of ${jobs.length} cards reviewed and sorted.`);
    } catch (error) {
      state.stop = true;
      await loadPromise;
      sortJobs([...jobsById.values()]);
      finish("error", `Paused after ${state.done} cards: ${error.message}`);
    }
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function renderGrade(job) {
    job.article.classList.add(`jas-${job.grade.category}`);
    const badge = document.createElement("div");
    badge.className = "jas-grade";
    const strong = document.createElement("strong");
    strong.textContent = `${LABELS[job.grade.category]} · ${job.grade.score}/100`;
    badge.append(strong);
    if (job.grade.hasContactPhone) {
      const phone = document.createElement("span");
      phone.className = "jas-contact-phone";
      phone.setAttribute("role", "img");
      phone.setAttribute("aria-label", "Contact phone number provided");
      phone.title = "This posting provides a phone number for contacting someone about the job";
      phone.textContent = "☎";
      badge.append(phone);
    }
    if (job.grade.reason) {
      const reason = document.createElement("span");
      reason.textContent = job.grade.reason;
      badge.append(reason);
    }
    job.article.querySelector(".card")?.prepend(badge);
  }

  function sortJobs(jobs) {
    const parent = jobs[0]?.article.parentElement;
    if (!parent || jobs.some((job) => job.article.parentElement !== parent)) return;
    for (const job of [...jobs].sort(JobnetRanking.compare)) parent.append(job.article);
  }

  ensureUi();
  const pageObserver = new MutationObserver((mutations) => {
    if (!pageControls?.isConnected) ensurePageControls();
    else if (mutations.some((mutation) => !pageControls.contains(mutation.target))) updatePageControls();
  });
  pageObserver.observe(document.body, { childList: true, subtree: true });
  ensurePageControls();
})();
