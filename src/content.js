(() => {
  "use strict";

  if (!/^\/find-job\/?$/.test(location.pathname) || globalThis.__jobnetAiSorterLoaded) return;
  globalThis.__jobnetAiSorterLoaded = true;

  const LABELS = { clear: "Clearly relevant", potential: "Potentially relevant", irrelevant: "Explicitly irrelevant" };
  const state = { phase: "idle", done: 0, total: 0, stop: false, stopLoading: false, loadingPosts: false, operation: null, message: "Ready", metrics: null };
  let root;
  let logList;
  let statusText;
  let stopButton;
  let promptDialog;
  let keyDialog;
  let costDialog;
  let costDecision = null;
  let activeEstimate = null;
  let draftTimer = null;
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
          <div class="jas-preferences-head"><label for="jas-run-preferences">Job preferences for this run</label><button class="jas-save-preferences" type="button">Save job preferences for future runs</button></div>
          <textarea id="jas-run-preferences" rows="5" maxlength="15000" placeholder="Roles, location, work style, non-negotiables, and anything else that matters"></textarea>
          <p class="jas-preferences-status" role="status"></p>
          <label class="jas-load-option"><input id="jas-load-first" type="checkbox"><span class="jas-load-label"></span></label>
          <p class="jas-load-hint"></p>
          <label for="jas-provider">Provider for this run — choose one</label>
          <select id="jas-provider"><option value="jev">TypeSafe Jev — recommended</option><option value="claude">Claude — alternative</option></select>
          <div class="jas-claude-model"><label for="jas-model">Claude model type for this run</label>
          <select id="jas-model"><option value="haiku">Haiku</option><option value="sonnet">Sonnet</option><option value="opus">Opus</option></select></div>
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
      </div>
      <div class="jas-cost-overlay" hidden>
        <section class="jas-dialog jas-cost-dialog" role="dialog" aria-modal="true" aria-labelledby="jas-cost-title">
          <div class="jas-dialog-head"><h2 id="jas-cost-title">Jev cost estimate</h2><button class="jas-cost-close" type="button" aria-label="Close">×</button></div>
          <p class="jas-cost-summary"></p>
          <div class="jas-cost-progress"><span class="jas-spinner" aria-hidden="true"></span><span class="jas-cost-progress-text">Preparing estimate…</span></div>
          <div class="jas-cost-state-strategy jas-cost-external-strategy">
            <label class="jas-check-option"><input id="jas-external-details" type="checkbox"> Use Jev to fetch details</label>
            <p class="jas-field-hint">Some posts have not provided their details to Jobnet. Using Jev, this plugin can find the details on non-Jobnet pages.</p>
          </div>
          <div class="jas-cost-state-strategy">
            <label class="jas-check-option"><input id="jas-limit-state-posts" type="checkbox"> Limit the number of posts in each Jev state</label>
            <p class="jas-field-hint">Smaller states can improve Jev's judgement by giving each post more focused context, but they require more requests and can cost more.</p>
            <div class="jas-state-count" hidden><label for="jas-posts-per-state">Maximum posts per state</label><input id="jas-posts-per-state" type="number" min="1" max="50" step="1" value="10"></div>
          </div>
          <p class="jas-cost-updating" role="status"></p>
          <div class="jas-cost-options"></div>
          <p class="jas-cost-note"></p>
          <div class="jas-dialog-actions"><button class="jas-cost-edit" type="button">Edit query</button><span class="jas-action-spacer"></span><button class="jas-cost-cancel" type="button">Cancel</button><button class="jas-cost-confirm" type="button">Apply AI filter</button></div>
        </section>
      </div>`;
      document.body.append(root);
      root.querySelector(".jas-panel-head strong").append(` · v${browser.runtime.getManifest().version}`);
      logList = root.querySelector(".jas-log");
      statusText = root.querySelector(".jas-status");
      stopButton = root.querySelector(".jas-stop");
      promptDialog = root.querySelector(".jas-overlay");
      keyDialog = root.querySelector(".jas-key-overlay");
      costDialog = root.querySelector(".jas-cost-overlay");
      root.querySelector(".jas-minimize").addEventListener("click", () => root.querySelector(".jas-panel").classList.toggle("jas-collapsed"));
      root.querySelector(".jas-close").addEventListener("click", closePrompt);
      root.querySelector(".jas-cancel").addEventListener("click", closePrompt);
      promptDialog.addEventListener("click", (event) => { if (event.target === promptDialog) closePrompt(); });
      root.querySelector(".jas-start").addEventListener("click", startFilter);
      root.querySelector(".jas-save-preferences").addEventListener("click", saveRunPreferences);
      root.querySelector("#jas-prompt").addEventListener("input", scheduleRunDraftSave);
      root.querySelector("#jas-run-preferences").addEventListener("input", scheduleRunDraftSave);
      root.querySelector("#jas-provider").addEventListener("change", updateProvider);
      root.querySelector("#jas-load-first").addEventListener("change", handleLoadChoice);
      root.querySelector(".jas-key-close").addEventListener("click", closeKeyDialog);
      root.querySelector(".jas-key-cancel").addEventListener("click", closeKeyDialog);
      keyDialog.addEventListener("click", (event) => { if (event.target === keyDialog) closeKeyDialog(); });
      root.querySelector(".jas-key-settings").addEventListener("click", openKeySettings);
      root.querySelector(".jas-cost-close").addEventListener("click", () => closeCostEstimate(false));
      root.querySelector(".jas-cost-cancel").addEventListener("click", () => closeCostEstimate(false));
      root.querySelector(".jas-cost-confirm").addEventListener("click", () => closeCostEstimate(true));
      root.querySelector(".jas-cost-edit").addEventListener("click", editQueryFromEstimate);
      costDialog.addEventListener("click", (event) => { if (event.target === costDialog) closeCostEstimate(false); });
      stopButton.addEventListener("click", () => {
        state.stop = true;
        state.stopLoading = true;
        setStatus("Stopping after the current step…");
        browser.runtime.sendMessage({ type: "JAS_CANCEL" }).catch(() => {});
        if (!costDialog.hidden) closeCostEstimate(false);
      });
      root.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (!keyDialog.hidden) closeKeyDialog();
        else if (!costDialog.hidden) closeCostEstimate(false);
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
      pageControls.querySelector(".jas-page-load").addEventListener("click", togglePageLoading);
      pageControls.querySelector(".jas-page-filter").addEventListener("click", openPrompt);
      pageControls.querySelector(".jas-page-settings").addEventListener("click", () => {
        browser.runtime.sendMessage({ type: "JAS_OPEN_SETTINGS" }).catch(() => {
          setStatus("Could not open settings. Reload the Jobnet page and try again.");
        });
      });
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
    const loadControl = pageControls.querySelector(".jas-page-load");
    loadControl.textContent = state.loadingPosts ? "Stop loading" : "Load all posts";
    loadControl.disabled = state.loadingPosts ? false : Boolean(state.operation) || !loaded || !loadButton();
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
    state.stopLoading = false;
    state.metrics = { requests: 0, elapsedMs: 0, inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, detailRequests: 0, cacheHits: 0 };
    stopButton.hidden = false;
    root.querySelector(".jas-panel").classList.remove("jas-collapsed");
    updatePageControls();
  }

  function finish(phase, text) {
    state.phase = phase;
    state.operation = null;
    state.loadingPosts = false;
    state.stopLoading = false;
    activeEstimate = null;
    stopButton.hidden = true;
    setStatus(text);
    log(text);
  }

  function togglePageLoading() {
    if (state.loadingPosts) {
      state.stopLoading = true;
      setStatus("Stopping post loading after the current page…");
      return Promise.resolve({ ok: true });
    }
    return startLoad();
  }

  function startLoad() {
    if (state.operation) return Promise.resolve({ ok: false, error: "Another operation is running." });
    if (!cards().length) return Promise.resolve({ ok: false, error: "Wait for Jobnet to load the search results." });
    const total = advertisedTotal();
    setRunning("loading", total || 0);
    state.loadingPosts = true;
    log(`Loading this search: ${cards().length}${total ? ` of ${total}` : ""} cards currently visible.`);
    state.operation = Promise.resolve().then(loadAllStandalone);
    return Promise.resolve({ ok: true });
  }

  async function loadAllStandalone() {
    const key = searchKey();
    try {
      const loaded = await loadAllCards(key);
      const stopped = state.stop || state.stopLoading;
      finish(stopped ? "stopped" : "done", stopped ? `Stopped with ${loaded} cards loaded.` : `All available cards loaded: ${loaded}.`);
    } catch (error) {
      finish("error", error.message);
    }
  }

  async function loadAllCards(key, { combined = false } = {}) {
    let failures = 0;
    state.loadingPosts = true;
    updatePageControls();
    try {
      while (!state.stop && !state.stopLoading) {
        if (searchKey() !== key) throw new Error("The search changed while loading. Start again for the new search.");
        const button = loadButton();
        if (!button) {
          const loaded = cards().length;
          if (state.total && loaded < state.total) throw new Error(`Jobnet stopped offering more cards at ${loaded} of ${state.total} advertised results.`);
          break;
        }
        if (button.getAttribute("aria-disabled") === "true") {
          await waitForReady(key);
          continue;
        }
        const before = cards().length;
        button.click();
        const grew = await waitForMore(before, key);
        if (state.stop || state.stopLoading) break;
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
          ? `Processing loaded posts while Jobnet continues loading: ${loaded}${state.total ? ` of ${state.total}` : ""} available.`
          : `Loaded ${loaded}${state.total ? ` of ${state.total}` : ""} cards…`);
        log(state.message);
      }
      return cards().length;
    } finally {
      state.loadingPosts = false;
      updatePageControls();
    }
  }

  function waitForMore(before, key) {
    return new Promise((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const button = loadButton();
        const count = cards().length;
        const changed = count > before && (button?.getAttribute("aria-disabled") !== "true" && Boolean(button)
          || Boolean(state.total && count >= state.total));
        if (changed || state.stop || state.stopLoading || searchKey() !== key || Date.now() - start > 20000) {
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
        if (ready || state.stop || state.stopLoading || searchKey() !== key) { clearInterval(timer); resolve(); }
        else if (Date.now() - start > 20000) { clearInterval(timer); reject(new Error("Jobnet kept the load button disabled.")); }
      }, 250);
    });
  }

  async function openPrompt() {
    if (state.operation) return { ok: false, error: "Stop the current operation first." };
    ensureUi();
    const settings = await browser.runtime.sendMessage({ type: "JAS_GET_SETTINGS" });
    availableKeys = settings;
    if (!availableKeys.hasApiKey && !availableKeys.hasJevApiKey) {
      openKeyDialog();
      return { ok: true };
    }
    if (availableKeys.hasJevApiKey && !availableKeys.hasApiKey) root.querySelector("#jas-provider").value = "jev";
    if (availableKeys.hasApiKey && !availableKeys.hasJevApiKey) root.querySelector("#jas-provider").value = "claude";
    root.querySelector("#jas-model").value = settings.model;
    root.querySelector("#jas-prompt").value = settings.runDraft?.prompt || "";
    root.querySelector("#jas-run-preferences").value = settings.runDraft ? settings.runDraft.preferences : settings.preferences || "";
    root.querySelector(".jas-preferences-status").textContent = "";
    const loaded = cards().length;
    const total = advertisedTotal() || loaded;
    const unloaded = Math.max(0, total - loaded);
    const loadOption = root.querySelector(".jas-load-option");
    loadOption.hidden = !unloaded || !loadButton();
    root.querySelector(".jas-load-label").textContent = `Load ${unloaded.toLocaleString()} unloaded posts before filtering`;
    const loadHint = root.querySelector(".jas-load-hint");
    loadHint.hidden = loadOption.hidden;
    loadHint.textContent = `Only ${loaded.toLocaleString()} posts have been loaded. This option will load the rest and include them in your query.`;
    root.querySelector("#jas-load-first").checked = false;
    root.querySelector("#jas-external-details").checked = false;
    updateProvider();
    promptDialog.hidden = false;
    root.querySelector("#jas-prompt").focus();
    return { ok: true };
  }

  function updateProvider() {
    const jev = root.querySelector("#jas-provider").value === "jev";
    root.querySelector(".jas-claude-model").hidden = jev;
    const hasKey = jev ? availableKeys.hasJevApiKey : availableKeys.hasApiKey;
    root.querySelector(".jas-dialog-note").textContent = hasKey
      ? `${cards().length} loaded posts are ready to review.`
      : `${jev ? "TypeSafe Jev" : "Claude"} needs an API key. Starting will take you to settings.`;
    root.querySelector("#jas-provider").disabled = Boolean(activeEstimate);
    root.querySelector(".jas-start").disabled = !cards().length;
    updateStartButton();
  }

  function updateStartButton() {
    if (!root) return;
    const jev = root.querySelector("#jas-provider").value === "jev";
    const loadRemaining = !root.querySelector(".jas-load-option").hidden && root.querySelector("#jas-load-first").checked;
    root.querySelector(".jas-start").textContent = jev
      ? (loadRemaining ? "Load posts and estimate costs" : "Estimate Costs")
      : (loadRemaining ? "Load posts and start filtering" : "Start filtering");
  }

  function handleLoadChoice() {
    updateStartButton();
    if (!activeEstimate) return;
    activeEstimate.configuration.loadRemaining = root.querySelector("#jas-load-first").checked;
    if (!activeEstimate.configuration.loadRemaining) {
      state.stopLoading = true;
      updateEstimateProgress(activeEstimate, "Stopping post loading after the current page…");
      return;
    }
    if (!state.loadingPosts && loadButton()) startEstimatePagination(activeEstimate);
  }

  function closePrompt() {
    saveRunDraft();
    promptDialog.hidden = true;
    if (activeEstimate && !activeEstimate.cancelled) costDialog.hidden = false;
  }

  function scheduleRunDraftSave() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveRunDraft, 250);
  }

  function saveRunDraft() {
    clearTimeout(draftTimer);
    return browser.runtime.sendMessage({
      type: "JAS_SAVE_RUN_DRAFT",
      draft: {
        prompt: root.querySelector("#jas-prompt").value,
        preferences: root.querySelector("#jas-run-preferences").value
      }
    }).catch(() => {});
  }

  function clearRunDraft() {
    clearTimeout(draftTimer);
    browser.runtime.sendMessage({ type: "JAS_CLEAR_RUN_DRAFT" }).catch(() => {});
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

  async function saveRunPreferences() {
    const button = root.querySelector(".jas-save-preferences");
    const status = root.querySelector(".jas-preferences-status");
    button.disabled = true;
    try {
      const response = await browser.runtime.sendMessage({ type: "JAS_SAVE_PREFERENCES", preferences: root.querySelector("#jas-run-preferences").value });
      if (!response?.ok) throw new Error(response?.error || "Could not save job preferences.");
      status.textContent = "Job preferences saved for future runs.";
      button.textContent = "Saved";
      setTimeout(() => {
        button.textContent = "Save job preferences for future runs";
        status.textContent = "";
      }, 2200);
    } catch (error) {
      status.textContent = `Could not save job preferences: ${error.message}`;
    } finally {
      button.disabled = false;
    }
  }

  async function startFilter() {
    const prompt = root.querySelector("#jas-prompt").value.trim();
    const preferences = root.querySelector("#jas-run-preferences").value;
    const model = root.querySelector("#jas-model").value;
    const provider = root.querySelector("#jas-provider").value;
    const hasKey = provider === "jev" ? availableKeys.hasJevApiKey : availableKeys.hasApiKey;
    if (!hasKey) { openKeyDialog(provider); return; }
    if (!prompt) { root.querySelector(".jas-dialog-note").textContent = "Enter an instruction for this run."; return; }
    const loadRemaining = !root.querySelector(".jas-load-option").hidden && root.querySelector("#jas-load-first").checked;
    const configuration = { prompt, preferences, model, provider, loadRemaining, postsPerState: null, externalDetails: false };
    if (activeEstimate) {
      Object.assign(activeEstimate.configuration, configuration, {
        postsPerState: selectedPostsPerState(),
        externalDetails: root.querySelector("#jas-external-details").checked
      });
      saveRunDraft();
      promptDialog.hidden = true;
      costDialog.hidden = false;
      queueEstimateRefresh(activeEstimate);
      return;
    }
    closePrompt();
    if (provider === "jev") {
      setRunning("estimating", loadRemaining ? advertisedTotal() || cards().length : cards().length);
      log(`Preparing a Jev cost estimate${loadRemaining ? " while Jobnet loads the remaining posts" : ""}. No Jev query will run before confirmation.`);
      state.operation = estimateThenFilter(configuration);
      return;
    }
    beginFiltering(configuration);
  }

  function beginFiltering(configuration) {
    const { prompt, preferences, model, provider, loadRemaining, postsPerState, externalDetails } = configuration;
    const jobs = cards();
    for (const job of jobs) {
      job.article.classList.remove("jas-clear", "jas-potential", "jas-irrelevant");
      job.article.querySelector(".jas-grade")?.remove();
    }
    clearRunDraft();
    setRunning("reviewing", loadRemaining ? advertisedTotal() || jobs.length : jobs.length);
    log(`Started ${provider === "jev" ? "TypeSafe Jev" : `Claude ${model}`} review of ${jobs.length} loaded posts${postsPerState ? ` with at most ${postsPerState} posts per state` : ""}${externalDetails ? " with external descriptions" : ""}${loadRemaining ? " while Jobnet continues loading" : ""}.`);
    state.operation = Promise.resolve().then(() => filterJobs(prompt, preferences, model, provider, loadRemaining, postsPerState, externalDetails));
  }

  async function estimateThenFilter(configuration) {
    const session = {
      configuration,
      key: searchKey(),
      cancelled: false,
      estimating: false,
      refreshRequested: false,
      refreshPromise: Promise.resolve(),
      loadingPromise: null,
      latestEstimate: null,
      latestJobs: [],
      resolveDecision: null
    };
    activeEstimate = session;
    const decisionPromise = openCostEstimate(session);
    try {
      queueEstimateRefresh(session);
      if (configuration.loadRemaining) startEstimatePagination(session);
      const decision = await decisionPromise;
      if (!decision.confirmed || state.stop) return finish("stopped", "AI filtering cancelled after the cost estimate.");
      await session.refreshPromise;
      if (session.estimating || state.loadingPosts) throw new Error("Wait for post loading and the estimate to finish.");
      configuration.postsPerState = decision.postsPerState;
      configuration.externalDetails = decision.externalDetails;
      configuration.loadRemaining = false;
      beginFiltering(configuration);
    } catch (error) {
      finish("error", `Cost estimate stopped: ${error.message}`);
    }
  }

  function startEstimatePagination(session) {
    if (session.cancelled || state.loadingPosts || !loadButton()) return;
    state.stopLoading = false;
    session.configuration.loadRemaining = true;
    session.loadingPromise = loadAllCards(session.key, { combined: true })
      .catch((error) => {
        if (!state.stop && !state.stopLoading) updateEstimateProgress(session, `Post loading stopped: ${error.message}`);
      })
      .finally(() => {
        state.loadingPosts = false;
        session.loadingPromise = null;
        if (!session.cancelled && !state.stop) queueEstimateRefresh(session);
      });
    updateEstimateProgress(session, `Loading remaining posts while estimating ${cards().length} loaded posts…`);
  }

  async function calculateJevEstimate(configuration, jobs) {
      const estimate = {
        direct: { requests: 0, tokens: 0, usd: 0 },
        enhanced: { requests: 0, tokens: 0, usd: 0, selectionRequests: 0, selectionTokens: 0 },
        detailRequests: 0,
        cacheHits: 0,
        pricing: null
      };
      for (let offset = 0; offset < jobs.length && !state.stop; offset += 50) {
        const batch = jobs.slice(offset, offset + 50);
        setStatus(`Loading descriptions for cost estimate: ${offset} of ${jobs.length} prepared.`);
        const response = await browser.runtime.sendMessage({
          type: "JAS_ESTIMATE_JEV_BATCH",
          prompt: configuration.prompt,
          preferences: configuration.preferences,
          postsPerState: configuration.postsPerState,
          externalDetails: configuration.externalDetails,
          jobs: batch.map((job) => ({ id: job.id, title: job.title, summary: job.summary, url: job.url }))
        });
        if (!response?.ok) throw new Error(response?.error || "Could not prepare the Jev estimate.");
        for (const strategy of ["direct", "enhanced"]) {
          for (const field of ["requests", "tokens", "usd"]) estimate[strategy][field] += Number(response[strategy][field] || 0);
        }
        estimate.enhanced.selectionRequests += Number(response.enhanced.selectionRequests || 0);
        estimate.enhanced.selectionTokens += Number(response.enhanced.selectionTokens || 0);
        estimate.detailRequests += Number(response.detailRequests || 0);
        estimate.cacheHits += Number(response.cacheHits || 0);
        estimate.pricing = response.pricing;
      }
      return estimate;
  }

  function openCostEstimate(session) {
    const money = (value) => `$${Number(value).toFixed(value < 0.01 ? 6 : 4)}`;
    const row = (title, data, note) => {
      const section = document.createElement("section");
      for (const [tag, text] of [
        ["strong", title],
        ["span", `${data.tokens.toLocaleString()} estimated input tokens`],
        ["span", `${data.requests.toLocaleString()} requests`],
        ["b", money(data.usd)],
        ["small", note]
      ]) {
        const element = document.createElement(tag);
        element.textContent = text;
        section.append(element);
      }
      return section;
    };
    const limit = root.querySelector("#jas-limit-state-posts");
    const external = root.querySelector("#jas-external-details");
    const externalStrategy = root.querySelector(".jas-cost-external-strategy");
    const count = root.querySelector("#jas-posts-per-state");
    const countRow = root.querySelector(".jas-state-count");
    const render = (estimate, jobs) => {
      root.querySelector(".jas-cost-summary").textContent = `${jobs.length} descriptions are loaded and cached. No Jev filtering request has run yet.`;
      root.querySelector(".jas-cost-options").replaceChildren(
        row("Direct full details", estimate.direct, "Sends the extracted detail blocks directly to filtering."),
        row("Enhanced detail selection", estimate.enhanced, `Includes ${estimate.enhanced.selectionRequests} selector requests, then filtering. Uses the selector’s maximum retained detail size, so actual cost can be lower.`)
      );
      root.querySelector(".jas-cost-note").textContent = `Estimated at $${estimate.pricing.inputUsdPerMillion} per million input tokens; TypeSafe output tokens are currently free. ${estimate.detailRequests} detail pages loaded now and ${estimate.cacheHits} reused from cache. Actual billed tokens can differ.`;
    };
    session.render = render;
    const recalculate = () => {
      countRow.hidden = !limit.checked;
      count.disabled = !limit.checked;
      session.configuration.postsPerState = selectedPostsPerState();
      session.configuration.externalDetails = external.checked;
      queueEstimateRefresh(session);
    };
    limit.checked = false;
    external.checked = false;
    externalStrategy.hidden = !cards().some((job) => isExternalJobUrl(job.url));
    count.value = "10";
    countRow.hidden = true;
    count.disabled = true;
    limit.onchange = recalculate;
    external.onchange = recalculate;
    count.onchange = recalculate;
    count.oninput = () => {
      clearTimeout(count._jasTimer);
      count._jasTimer = setTimeout(recalculate, 350);
    };
    root.querySelector(".jas-cost-summary").textContent = "Preparing descriptions and calculating both Jev strategies.";
    root.querySelector(".jas-cost-options").replaceChildren();
    root.querySelector(".jas-cost-note").textContent = "No Jev filtering request will run until you confirm.";
    root.querySelector(".jas-cost-confirm").disabled = true;
    updateEstimateProgress(session, session.configuration.loadRemaining ? "Loading posts and preparing the first estimate…" : "Preparing the cost estimate…");
    costDialog.hidden = false;
    root.querySelector(".jas-cost-edit").focus();
    return new Promise((resolve) => {
      session.resolveDecision = resolve;
      costDecision = resolve;
    });
  }

  function selectedPostsPerState() {
    const limit = root.querySelector("#jas-limit-state-posts");
    if (!limit.checked) return null;
    const value = Math.trunc(Number(root.querySelector("#jas-posts-per-state").value));
    return value >= 1 && value <= 50 ? value : NaN;
  }

  function queueEstimateRefresh(session) {
    if (!session || session.cancelled) return Promise.resolve();
    session.refreshRequested = true;
    if (session.estimating) return session.refreshPromise;
    session.refreshPromise = (async () => {
      while (session.refreshRequested && !session.cancelled && !state.stop) {
        session.refreshRequested = false;
        session.estimating = true;
        const configuration = { ...session.configuration };
        if (Number.isNaN(configuration.postsPerState)) {
          updateEstimateProgress(session, "Choose 1–50 posts per Jev state.", true);
          session.estimating = false;
          continue;
        }
        const jobs = cards();
        session.latestJobs = jobs;
        root.querySelector(".jas-cost-external-strategy").hidden = !jobs.some((job) => isExternalJobUrl(job.url));
        if (configuration.externalDetails) {
          const urls = jobs.map((job) => job.url).filter(isExternalJobUrl);
          updateEstimateProgress(session, `Checking access to ${new Set(urls.map((url) => new URL(url).origin)).size} external job sites…`);
          const access = await browser.runtime.sendMessage({ type: "JAS_REQUEST_EXTERNAL_ACCESS", urls }).catch((error) => ({ ok: false, error: error.message }));
          if (!access?.ok || !access.granted) {
            root.querySelector("#jas-external-details").checked = false;
            session.configuration.externalDetails = false;
            updateEstimateProgress(session, access?.opened
              ? "Firefox opened an extension page. Grant access there, return to Jobnet, then enable this option again."
              : access?.error || "External site access was not granted.", true);
            session.estimating = false;
            continue;
          }
        }
        try {
          updateEstimateProgress(session, configuration.externalDetails ? "Fetching external details and updating the estimate…" : `Preparing an estimate for ${jobs.length} loaded posts…`);
          const estimate = await calculateJevEstimate(configuration, jobs);
          if (session.cancelled || state.stop) break;
          session.latestEstimate = estimate;
          session.render(estimate, jobs);
          const parts = [configuration.postsPerState ? `at most ${configuration.postsPerState} posts per state` : "no per-state post limit"];
          if (configuration.externalDetails) parts.push("Jev retrieval for external details");
          updateEstimateProgress(session, `Estimate ready with ${parts.join(" and ")}.`, false, true);
        } catch (error) {
          if (!session.cancelled && !state.stop) updateEstimateProgress(session, `Could not update estimate: ${error.message}`, true);
        } finally {
          session.estimating = false;
        }
      }
      updateEstimateControls(session);
    })();
    return session.refreshPromise;
  }

  function updateEstimateProgress(session, text, error = false, complete = false) {
    if (!root || session !== activeEstimate) return;
    root.querySelector(".jas-cost-updating").textContent = error ? text : "";
    const progress = root.querySelector(".jas-cost-progress");
    progress.hidden = complete && !state.loadingPosts && !session.estimating;
    root.querySelector(".jas-cost-progress-text").textContent = text;
    progress.classList.toggle("jas-error", error);
    updateEstimateControls(session);
  }

  function updateEstimateControls(session) {
    if (!root || session !== activeEstimate) return;
    const validCount = !Number.isNaN(selectedPostsPerState());
    root.querySelector(".jas-cost-confirm").disabled = !session.latestEstimate || session.estimating || state.loadingPosts || !validCount;
    root.querySelector(".jas-cost-progress").hidden = Boolean(session.latestEstimate) && !session.estimating && !state.loadingPosts;
    updatePageControls();
  }

  function editQueryFromEstimate() {
    if (!activeEstimate) return;
    costDialog.hidden = true;
    const loaded = cards().length;
    const total = advertisedTotal() || loaded;
    const unloaded = Math.max(0, total - loaded);
    const loadOption = root.querySelector(".jas-load-option");
    loadOption.hidden = !unloaded || !loadButton();
    root.querySelector(".jas-load-label").textContent = `Load ${unloaded.toLocaleString()} unloaded posts before filtering`;
    root.querySelector(".jas-load-hint").hidden = loadOption.hidden;
    root.querySelector(".jas-load-hint").textContent = `Only ${loaded.toLocaleString()} posts have been loaded. This option will load the rest and include them in your query.`;
    root.querySelector("#jas-load-first").checked = activeEstimate.configuration.loadRemaining && !state.stopLoading;
    root.querySelector("#jas-provider").disabled = true;
    updateStartButton();
    promptDialog.hidden = false;
    root.querySelector("#jas-prompt").focus();
  }

  function closeCostEstimate(confirmed) {
    const session = activeEstimate;
    if (confirmed && root?.querySelector(".jas-cost-confirm")?.disabled) return;
    if (costDialog) costDialog.hidden = true;
    const resolve = costDecision;
    costDecision = null;
    if (session) session.cancelled = !confirmed;
    if (!confirmed) {
      state.stopLoading = true;
      browser.runtime.sendMessage({ type: "JAS_CANCEL" }).catch(() => {});
    }
    const postsPerState = confirmed ? selectedPostsPerState() : null;
    const externalDetails = confirmed && root?.querySelector("#jas-external-details")?.checked === true;
    resolve?.({ confirmed, postsPerState, externalDetails });
  }

  function isExternalJobUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname !== "jobnet.dk" && !url.hostname.endsWith(".jobnet.dk");
    } catch (_) { return false; }
  }

  async function filterJobs(prompt, preferences, model, provider, loadRemaining, postsPerState, externalDetails) {
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
        const response = await browser.runtime.sendMessage({ type: "JAS_GRADE_BATCH", prompt, preferences, model, provider, postsPerState, externalDetails,
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
