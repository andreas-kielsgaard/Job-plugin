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
    const search = document.querySelector('#main-content input[name="searchString"]')?.value || "";
    return `${location.href}|${search}`;
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
    if (root?.isConnected) return;
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
          <div class="jas-dialog-head"><h2 id="jas-dialog-title">Filter this search with AI</h2><button class="jas-close" type="button" aria-label="Close">×</button></div>
          <p>Your instruction and saved preferences guide relevance. Your CV helps score qualifications and becomes a relevance fallback when no other job preference is provided. Jev loads full descriptions and evaluates paired category and score questions together.</p>
          <label for="jas-prompt">What should the model prioritize for this search?</label>
          <textarea id="jas-prompt" rows="5" maxlength="6000" placeholder="For example: prioritize senior roles in Copenhagen with flexible work; avoid sales positions."></textarea>
          <label for="jas-provider">Provider for this run</label>
          <select id="jas-provider"><option value="claude">Claude</option><option value="jev">TypeSafe Jev</option></select>
          <div class="jas-claude-model"><label for="jas-model">Claude model type for this run</label>
          <select id="jas-model"><option value="haiku">Haiku</option><option value="sonnet">Sonnet</option><option value="opus">Opus</option></select></div>
          <p class="jas-dialog-note"></p>
          <div class="jas-dialog-actions"><button class="jas-cancel" type="button">Cancel</button><button class="jas-start" type="button">Start filtering</button></div>
        </section>
      </div>`;
    document.body.append(root);
    root.querySelector(".jas-panel-head strong").append(` · v${browser.runtime.getManifest().version}`);
    logList = root.querySelector(".jas-log");
    statusText = root.querySelector(".jas-status");
    stopButton = root.querySelector(".jas-stop");
    promptDialog = root.querySelector(".jas-overlay");
    root.querySelector(".jas-minimize").addEventListener("click", () => root.querySelector(".jas-panel").classList.toggle("jas-collapsed"));
    root.querySelector(".jas-close").addEventListener("click", closePrompt);
    root.querySelector(".jas-cancel").addEventListener("click", closePrompt);
    promptDialog.addEventListener("click", (event) => { if (event.target === promptDialog) closePrompt(); });
    root.querySelector(".jas-start").addEventListener("click", startFilter);
    root.querySelector("#jas-provider").addEventListener("change", updateProvider);
    stopButton.addEventListener("click", () => {
      state.stop = true;
      setStatus("Stopping after the current step…");
      browser.runtime.sendMessage({ type: "JAS_CANCEL" }).catch(() => {});
    });
    root.addEventListener("keydown", (event) => { if (event.key === "Escape" && !promptDialog.hidden) closePrompt(); });
    setStatus(state.message);
  }

  function setStatus(text) {
    state.message = text;
    if (statusText) statusText.textContent = text;
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
    summary.textContent = `Batch ${number} of ${total}: ${counts.clear} clear, ${counts.potential} potential, ${counts.irrelevant} irrelevant`;
    const list = document.createElement("ul");
    for (const job of [...batch].sort(JobnetRanking.compare)) {
      const entry = document.createElement("li");
      entry.textContent = `${LABELS[job.grade.category]} · ${job.grade.score}/100 · ${job.title}: ${job.grade.reason}`;
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
    state.operation = Promise.resolve().then(loadAll);
    return Promise.resolve({ ok: true });
  }

  async function loadAll() {
    const key = searchKey();
    let failures = 0;
    try {
      while (!state.stop) {
        if (searchKey() !== key) throw new Error("The search changed while loading. Start again for the new search.");
        const button = loadButton();
        if (!button) {
          const loaded = cards().length;
          if (state.total && loaded < state.total) throw new Error(`Jobnet stopped offering more cards at ${loaded} of ${state.total} advertised results.`);
          finish("done", `All available cards loaded: ${loaded}.`);
          return;
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
        state.done = cards().length;
        setStatus(`Loaded ${state.done}${state.total ? ` of ${state.total}` : ""} cards…`);
        log(state.message);
      }
      finish("stopped", `Stopped with ${cards().length} cards loaded.`);
    } catch (error) {
      finish("error", error.message);
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
    root.querySelector("#jas-model").value = modelSettings.model;
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
      ? `${cards().length} loaded cards. ${jev ? "Jev loads full descriptions, builds state batches up to 20k estimated tokens, and evaluates category and score together" : "Claude screens cards in batches, then reads promising Jobnet descriptions"}.`
      : `Save a ${jev ? "TypeSafe Jev" : "Claude"} API key in the full-page settings first.`;
    root.querySelector(".jas-start").disabled = !hasKey || !cards().length;
  }

  function closePrompt() {
    promptDialog.hidden = true;
  }

  function startFilter() {
    const prompt = root.querySelector("#jas-prompt").value.trim();
    const model = root.querySelector("#jas-model").value;
    const provider = root.querySelector("#jas-provider").value;
    if (!prompt) { root.querySelector(".jas-dialog-note").textContent = "Enter an instruction for this run."; return; }
    closePrompt();
    const jobs = cards();
    for (const job of jobs) {
      job.article.classList.remove("jas-clear", "jas-potential", "jas-irrelevant");
      job.article.querySelector(".jas-grade")?.remove();
    }
    setRunning("reviewing", jobs.length);
    log(`Started ${provider === "jev" ? "TypeSafe Jev" : `Claude ${model}`} review of ${jobs.length} loaded cards.`);
    state.operation = Promise.resolve().then(() => filterJobs(jobs, prompt, model, provider));
  }

  async function filterJobs(jobs, prompt, model, provider) {
    const key = searchKey();
    const name = provider === "jev" ? "TypeSafe Jev" : `Claude ${model}`;
    const batchSize = 10;
    try {
      for (let offset = 0; offset < jobs.length; offset += batchSize) {
        if (state.stop) break;
        const batch = jobs.slice(offset, offset + batchSize);
        if (searchKey() !== key || batch.some((job) => !job.article.isConnected)) throw new Error("The search changed during filtering. Start again for the new search.");
        setStatus(`Reviewing cards ${offset + 1}–${offset + batch.length} of ${jobs.length} with ${name}.`);
        log(state.message);
        const response = await browser.runtime.sendMessage({ type: "JAS_GRADE_BATCH", prompt, model, provider,
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
        sortJobs(jobs);
        logBatchResults(batch, Math.floor(offset / batchSize) + 1, Math.ceil(jobs.length / batchSize));
        setStatus(`Completed ${state.done} of ${jobs.length} cards in batches.`);
      }
      sortJobs(jobs);
      log(`${name} API: ${state.metrics.requests} requests, ${state.metrics.inputTokens + state.metrics.cacheCreationTokens + state.metrics.cacheReadTokens} input tokens, ${state.metrics.outputTokens} output tokens. Jobnet details: ${state.metrics.detailRequests} loaded, ${state.metrics.cacheHits} reused.`);
      finish(state.stop ? "stopped" : "done", `${state.stop ? "Stopped" : "Finished"}: ${state.done} of ${jobs.length} cards reviewed and sorted.`);
    } catch (error) {
      sortJobs(jobs);
      finish("error", `Paused after ${state.done} cards: ${error.message}`);
    }
  }

  function renderGrade(job) {
    job.article.classList.add(`jas-${job.grade.category}`);
    const badge = document.createElement("div");
    badge.className = "jas-grade";
    const strong = document.createElement("strong");
    strong.textContent = `${LABELS[job.grade.category]} · ${job.grade.score}/100`;
    const reason = document.createElement("span");
    reason.textContent = job.grade.reason;
    badge.append(strong, reason);
    job.article.querySelector(".card")?.prepend(badge);
  }

  function sortJobs(jobs) {
    const parent = jobs[0]?.article.parentElement;
    if (!parent || jobs.some((job) => job.article.parentElement !== parent)) return;
    for (const job of [...jobs].sort(JobnetRanking.compare)) parent.append(job.article);
  }
})();
