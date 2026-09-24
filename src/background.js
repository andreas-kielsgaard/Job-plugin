(() => {
  "use strict";

  const store = browser.storage.local;
  const controllers = new Map();
  const DEFAULT_MODEL = "haiku";
  const DEFAULT_DETAIL_LANES = 3;
  const DETAIL_CACHE_PREFIX = "jobDetail:v3:";
  const DETAIL_CACHE_AGE = 7 * 24 * 60 * 60 * 1000;
  const NEGATIVE_CACHE_AGE = 12 * 60 * 60 * 1000;
  const EXTRACTOR_VERSION = 1;
  const INSPECTION_CACHE_PREFIX = "jobInspection:v1:";
  const detailInflight = new Map();
  const inspectionInflight = new Map();
  const originQueues = new Map();

  browser.runtime.onMessage.addListener((message, sender) => {
    if (!message || typeof message !== "object") return undefined;
    if (message.type === "JAS_GET_SETTINGS") return getSettings();
    if (message.type === "JAS_HAS_KEY") return store.get(["apiKey", "jevApiKey"]).then((data) => ({ hasApiKey: Boolean(data.apiKey), hasJevApiKey: Boolean(data.jevApiKey) }));
    if (message.type === "JAS_GET_MODEL_TYPE") return store.get("model").then((data) => ({ model: JobnetModels.typeOf(data.model) }));
    if (message.type === "JAS_SAVE_SETTINGS") return saveSettings(message.settings);
    if (message.type === "JAS_SAVE_PREFERENCES") return savePreferences(message.preferences);
    if (message.type === "JAS_DELETE_KEY") return deleteKey();
    if (message.type === "JAS_DELETE_JEV_KEY") return deleteJevKey();
    if (message.type === "JAS_OPEN_SETTINGS") return openSettings(message.section);
    if (message.type === "JAS_ENSURE_PAGE") return ensureSearchContent(message.tabId);
    if (message.type === "JAS_REQUEST_EXTERNAL_ACCESS") return requestExternalAccess(message.urls, sender);
    if (message.type === "JAS_ESTIMATE_JEV_BATCH") return estimateJevBatch(message, sender);
    if (message.type === "JAS_GRADE_BATCH") return gradeBatch(message, sender);
    if (message.type === "JAS_CANCEL") return cancel(sender);
    return undefined;
  });

  hydrateOpenSearchTabs();

  async function hydrateOpenSearchTabs() {
    const tabs = await browser.tabs.query({ url: "https://jobnet.dk/find-job*" }).catch(() => []);
    await Promise.all(tabs.map((tab) => ensureSearchContent(tab.id).catch(() => false)));
  }

  async function ensureSearchContent(tabId) {
    if (!Number.isInteger(tabId)) return false;
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab || !/^https:\/\/jobnet\.dk\/find-job\/?(?:[?#]|$)/.test(tab.url || "")) return false;
    try {
      await browser.tabs.sendMessage(tabId, { type: "JAS_STATUS" });
      return true;
    } catch (_) {
      await browser.tabs.insertCSS(tabId, { file: "src/content.css" });
      await browser.tabs.executeScript(tabId, { file: "src/ranking.js", runAt: "document_idle" });
      await browser.tabs.executeScript(tabId, { file: "src/content.js", runAt: "document_idle" });
      return true;
    }
  }

  async function getSettings() {
    const data = await store.get(["apiKey", "jevApiKey", "cv", "preferences", "model", "detailLanes"]);
    return {
      hasApiKey: Boolean(data.apiKey),
      hasJevApiKey: Boolean(data.jevApiKey),
      cv: data.cv || "",
      preferences: data.preferences || "",
      model: JobnetModels.typeOf(data.model || DEFAULT_MODEL),
      detailLanes: validDetailLanes(data.detailLanes)
    };
  }

  async function saveSettings(raw) {
    const settings = raw && typeof raw === "object" ? raw : {};
    const changes = {
      cv: String(settings.cv || "").slice(0, 30000),
      preferences: String(settings.preferences || "").slice(0, 15000),
      model: JobnetModels.typeOf(settings.model || DEFAULT_MODEL),
      detailLanes: validDetailLanes(settings.detailLanes)
    };
    const apiKey = String(settings.apiKey || "").trim();
    const jevApiKey = String(settings.jevApiKey || "").trim();
    if (apiKey) changes.apiKey = apiKey;
    if (jevApiKey) changes.jevApiKey = jevApiKey;
    await store.set(changes);
    return getSettings();
  }

  async function savePreferences(value) {
    await store.set({ preferences: String(value || "").slice(0, 15000) });
    return { ok: true };
  }

  function runPreferences(message, data) {
    return Object.prototype.hasOwnProperty.call(message, "preferences")
      ? String(message.preferences || "").slice(0, 15000)
      : data.preferences || "";
  }

  async function deleteKey() {
    await store.remove("apiKey");
    return getSettings();
  }

  async function deleteJevKey() {
    await store.remove("jevApiKey");
    return getSettings();
  }

  async function openSettings(section) {
    const target = section === "jev-settings" || section === "claude-settings" ? `#${section}` : "";
    await browser.tabs.create({ url: browser.runtime.getURL(`settings/settings.html${target}`) });
    return { ok: true };
  }

  function validDetailLanes(value) {
    const lanes = Math.trunc(Number(value));
    return lanes >= 1 && lanes <= 6 ? lanes : DEFAULT_DETAIL_LANES;
  }

  function validSearchSender(sender) {
    return sender.tab?.id && /^https:\/\/jobnet\.dk\/find-job\/?(?:[?#]|$)/.test(sender.url || "");
  }

  async function requestExternalAccess(urls, sender) {
    if (!validSearchSender(sender)) return { ok: false, error: "Open a Jobnet search page." };
    const origins = [...new Set((Array.isArray(urls) ? urls : []).map(permissionOrigin).filter(Boolean))].slice(0, 50);
    if (!origins.length) return { ok: true, granted: true, origins: [] };
    try {
      const missing = [];
      for (const origin of origins) {
        if (!await browser.permissions.contains({ origins: [origin] })) missing.push(origin);
      }
      if (!missing.length) return { ok: true, granted: true, origins };
      await store.set({ pendingExternalOrigins: missing });
      await browser.tabs.create({ url: browser.runtime.getURL("permissions/permissions.html") });
      return { ok: true, granted: false, opened: true, origins: missing };
    } catch (error) {
      return { ok: false, error: `Could not prepare external site access: ${String(error.message || error).slice(0, 300)}` };
    }
  }

  function permissionOrigin(value) {
    try {
      const url = new URL(String(value || ""));
      if (url.protocol !== "https:" || url.hostname === "jobnet.dk" || url.hostname.endsWith(".jobnet.dk")) return null;
      return `${url.origin}/*`;
    } catch (_) { return null; }
  }

  async function estimateJevBatch(message, sender) {
    if (!validSearchSender(sender)) return { ok: false, error: "Open a Jobnet search page." };
    const tabId = sender.tab.id;
    if (controllers.has(tabId)) return { ok: false, error: "Another AI operation is already running in this tab." };
    const data = await store.get(["jevApiKey", "cv", "preferences", "detailLanes"]);
    if (!data.jevApiKey) return { ok: false, error: "Save a TypeSafe Jev API key in settings first." };
    const jobs = prepareJobs(message.jobs, 50);
    if (!jobs.ok) return jobs;
    const controller = new AbortController();
    controllers.set(tabId, controller);
    try {
      const onActivity = (text, transient = false) => browser.tabs.sendMessage(tabId, { type: "JAS_ACTIVITY", text, transient }).catch(() => {});
      const directJobs = [];
      const enhancedJobs = [];
      let selectionRequests = 0;
      let selectionTokens = 0;
      let next = 0;
      let completed = 0;
      let detailRequests = 0;
      let cacheHits = 0;
      const externalDetails = message.externalDetails === true;
      async function worker() {
        while (next < jobs.value.length && !controller.signal.aborted) {
          const index = next++;
          const job = jobs.value[index];
          let directText;
          let enhancedText;
          try {
            if (isExternal(job.url) && externalDetails) {
              const loaded = await cachedExternalInspection(job, controller.signal, onActivity);
              if (loaded.inspection) {
                const fullText = inspectionText(loaded.inspection, 50000);
                directText = fullText || externalFallback(job);
                enhancedText = inspectionText(loaded.inspection, 12000) || externalFallback(job);
                const selector = JobnetJevCost.selection(loaded.inspection);
                selectionRequests += selector.requests;
                selectionTokens += selector.tokens;
                if (loaded.fromCache) cacheHits += 1; else detailRequests += 1;
              } else {
                directText = enhancedText = externalFallback(job);
                if (loaded.fromCache) cacheHits += 1; else detailRequests += 1;
              }
            } else {
              const detail = await cachedJobDetails(job, {
                externalDetails: false,
                apiKey: data.jevApiKey,
                onActivity,
                onMetrics: () => {},
                signal: controller.signal
              });
              directText = enhancedText = detail.text;
              if (detail.fromCache) cacheHits += 1; else detailRequests += 1;
            }
          } catch (error) {
            if (controller.signal.aborted) throw error;
            directText = enhancedText = `${job.title}\n\n${job.summary}\n\nFull description unavailable; estimate based on the Jobnet card.`;
            detailRequests += 1;
            onActivity(`Description unavailable for ${job.title}; estimating from its Jobnet card.`);
          }
          directJobs[index] = { ...job, details: directText };
          enhancedJobs[index] = { ...job, details: enhancedText };
          onActivity(`Preparing Jev cost estimate: ${++completed} of ${jobs.value.length} descriptions ready.`, true);
        }
      }
      await Promise.all(Array.from({ length: Math.min(validDetailLanes(data.detailLanes), jobs.value.length) }, worker));
      if (controller.signal.aborted) throw new DOMException("Stopped.", "AbortError");
      const context = {
        cv: data.cv || "",
        preferences: runPreferences(message, data),
        prompt: String(message.prompt || "").slice(0, 6000),
        maxPostingsPerState: validPostsPerState(message.postsPerState)
      };
      const direct = JobnetJevCost.ranking({ ...context, jobs: directJobs });
      const enhancedRanking = JobnetJevCost.ranking({ ...context, jobs: enhancedJobs });
      const enhanced = { requests: selectionRequests + enhancedRanking.requests, tokens: selectionTokens + enhancedRanking.tokens };
      return {
        ok: true,
        direct: { ...direct, usd: JobnetJevCost.dollars(direct.tokens) },
        enhanced: { ...enhanced, usd: JobnetJevCost.dollars(enhanced.tokens), selectionRequests, selectionTokens },
        detailRequests,
        cacheHits,
        pricing: { inputUsdPerMillion: JobnetJevCost.INPUT_USD_PER_MILLION, outputTokensFree: true }
      };
    } catch (error) {
      return { ok: false, error: error.name === "AbortError" ? "Stopped." : String(error.message || error).slice(0, 600) };
    } finally {
      controllers.delete(tabId);
    }
  }

  function prepareJobs(rawJobs, maxJobs) {
    const jobs = Array.isArray(rawJobs) ? rawJobs : [];
    if (!jobs.length || jobs.length > maxJobs) return { ok: false, error: `Prepare 1–${maxJobs} Jobnet cards at a time.` };
    const value = jobs.map((job) => ({
      id: String(job?.id || ""),
      title: String(job?.title || "").slice(0, 300),
      summary: String(job?.summary || "").slice(0, 3500),
      url: String(job?.url || "").slice(0, 1000)
    }));
    const ids = value.map((job) => job.id);
    if (new Set(ids).size !== ids.length || ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) {
      return { ok: false, error: "Invalid or duplicate Jobnet card ID." };
    }
    return { ok: true, value };
  }

  async function gradeBatch(message, sender) {
    if (!validSearchSender(sender)) return { ok: false, error: "Open a Jobnet search page." };
    const tabId = sender.tab.id;
    if (controllers.has(tabId)) return { ok: false, error: "A filtering request is already running in this tab." };
    const provider = message.provider === "jev" ? "jev" : "claude";
    const data = await store.get(["apiKey", "jevApiKey", "cv", "preferences", "model", "detailLanes"]);
    if (!data[provider === "jev" ? "jevApiKey" : "apiKey"]) return { ok: false, error: `Save a ${provider === "jev" ? "TypeSafe Jev" : "Claude"} API key in settings first.` };
    const maxJobs = provider === "jev" ? 50 : 10;
    const jobs = prepareJobs(message.jobs, maxJobs);
    if (!jobs.ok) return { ok: false, error: jobs.error.replace("Prepare", "Review") };
    const controller = new AbortController();
    controllers.set(tabId, controller);
    try {
      const onActivity = (text, transient = false) => browser.tabs.sendMessage(tabId, { type: "JAS_ACTIVITY", text, transient }).catch(() => {});
      const metrics = { requests: 0, elapsedMs: 0, inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, detailRequests: 0, cacheHits: 0 };
      let model;
      if (provider === "claude") {
        onActivity("Finding the latest available Claude model for this type.");
        const modelType = ["haiku", "sonnet", "opus"].includes(message.model) ? message.model : JobnetModels.typeOf(data.model);
        model = await JobnetModels.resolve(modelType, data.apiKey, controller.signal);
      } else model = "jev-latest";
      onActivity(`Using ${model}.`);
      const preparedJobs = jobs.value;
      const jobsById = new Map(preparedJobs.map((job) => [job.id, job]));
      const externalDetails = provider === "jev" && message.externalDetails === true;
      const recordMetrics = (sample) => {
        metrics.requests += 1;
        for (const key of ["elapsedMs", "inputTokens", "cacheCreationTokens", "cacheReadTokens", "outputTokens"]) metrics[key] += sample[key];
      };
      const result = await (provider === "jev" ? JobnetJev : JobnetClaude).gradeBatch({
        apiKey: provider === "jev" ? data.jevApiKey : data.apiKey,
        model,
        cv: data.cv || "",
        preferences: runPreferences(message, data),
        prompt: String(message.prompt || "").slice(0, 6000),
        detailLanes: validDetailLanes(data.detailLanes),
        maxPostingsPerState: provider === "jev" ? validPostsPerState(message.postsPerState) : null,
        jobs: preparedJobs,
        readDetails: async (id) => {
          const detail = await cachedJobDetails(jobsById.get(id), {
            externalDetails,
            apiKey: data.jevApiKey,
            onActivity,
            onMetrics: recordMetrics,
            signal: controller.signal
          });
          metrics[detail.fromCache ? "cacheHits" : "detailRequests"] += 1;
          return detail;
        },
        onActivity,
        onMetrics: recordMetrics,
        signal: controller.signal
      });
      return { ok: true, grades: result, metrics };
    } catch (error) {
      return { ok: false, error: error.name === "AbortError" ? "Stopped." : String(error.message || error).slice(0, 600) };
    } finally {
      controllers.delete(tabId);
    }
  }

  function cancel(sender) {
    if (!validSearchSender(sender)) return { ok: false };
    controllers.get(sender.tab.id)?.abort();
    return { ok: true };
  }

  function validPostsPerState(value) {
    const count = Math.trunc(Number(value));
    return count >= 1 && count <= 50 ? count : null;
  }

  async function cachedJobDetails(job, options) {
    const { signal } = options;
    if (signal.aborted) throw new DOMException("Stopped.", "AbortError");
    if (!job?.id) throw new Error("Job details were requested without a valid card.");
    const cacheKey = `${DETAIL_CACHE_PREFIX}${job.id}`;
    try {
      const item = (await store.get(cacheKey))[cacheKey];
      const maxAge = item?.quality === "external-unavailable" ? NEGATIVE_CACHE_AGE : DETAIL_CACHE_AGE;
      const mayReuse = item?.quality !== "external-unavailable" || !options.externalDetails;
      if (mayReuse && item && item.url === job.url && item.extractorVersion === EXTRACTOR_VERSION && typeof item.text === "string" && Date.now() - item.at < maxAge) {
        return { text: item.text, fromCache: true };
      }
      if (item) await store.remove(cacheKey);
    } catch (_) { /* Cache read failure must not block a detail request. */ }
    if (detailInflight.has(cacheKey)) return detailInflight.get(cacheKey);
    const pending = (async () => {
      const result = isExternal(job.url)
        ? await readExternalJobDetails(job, options)
        : { text: await readJobDetails(job.id, signal), quality: "jobnet" };
      await store.set({ [cacheKey]: { ...result, url: job.url, extractorVersion: EXTRACTOR_VERSION, at: Date.now() } }).catch(() => {});
      return { text: result.text, fromCache: false };
    })();
    detailInflight.set(cacheKey, pending);
    try { return await pending; } finally { detailInflight.delete(cacheKey); }
  }

  function isExternal(value) {
    try {
      const hostname = new URL(value).hostname;
      return hostname !== "jobnet.dk" && !hostname.endsWith(".jobnet.dk");
    } catch (_) { return false; }
  }

  function externalFallback(job) {
    return `${job.title}\n\n${job.summary}\n\nFull external description unavailable; evaluate from the Jobnet search card.`;
  }

  function inspectionText(inspection, maxChars) {
    const seen = new Set();
    const lines = [];
    for (const candidate of inspection.candidates || []) {
      for (const line of String(candidate.text || "").split(/\n+/)) {
        const clean = line.replace(/\s+/g, " ").trim();
        const key = JobnetExternalExtractor.normalized(clean);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        lines.push(clean);
      }
    }
    return lines.join("\n").slice(0, maxChars);
  }

  async function cachedExternalInspection(job, signal, onActivity) {
    const cacheKey = `${INSPECTION_CACHE_PREFIX}${job.id}`;
    try {
      const item = (await store.get(cacheKey))[cacheKey];
      if (item && item.url === job.url && item.extractorVersion === EXTRACTOR_VERSION && item.inspection && Date.now() - item.at < DETAIL_CACHE_AGE) {
        return { inspection: item.inspection, fromCache: true };
      }
      if (item) await store.remove(cacheKey);
    } catch (_) { /* Inspection cache failures fall through to a fresh request. */ }
    if (inspectionInflight.has(cacheKey)) return inspectionInflight.get(cacheKey);
    const pending = (async () => {
      const permission = permissionOrigin(job.url);
      if (!permission || !(await browser.permissions.contains({ origins: [permission] }))) return { inspection: null, fromCache: true };
      const origin = new URL(job.url).origin;
      return withOriginQueue(origin, async () => {
        onActivity(`Loading external page for ${job.title}.`, true);
        const response = await fetch(job.url, { credentials: "omit", redirect: "follow", signal });
        const inspection = JobnetExternalExtractor.inspectHtml({
          html: await response.text(),
          url: response.url || job.url,
          status: response.status,
          expectedTitle: job.title,
          cardSummary: job.summary
        });
        await store.set({ [cacheKey]: { inspection, url: job.url, extractorVersion: EXTRACTOR_VERSION, at: Date.now() } }).catch(() => {});
        return { inspection, fromCache: false };
      });
    })();
    inspectionInflight.set(cacheKey, pending);
    try { return await pending; } finally { inspectionInflight.delete(cacheKey); }
  }

  async function readExternalJobDetails(job, { externalDetails, apiKey, onActivity, onMetrics, signal }) {
    const fallback = externalFallback(job);
    if (!externalDetails) return { text: fallback, quality: "external-unavailable" };
    try {
      if (signal.aborted) throw new DOMException("Stopped.", "AbortError");
      const { inspection } = await cachedExternalInspection(job, signal, onActivity);
      if (!inspection) return { text: fallback, quality: "external-unavailable" };
      const selected = await JobnetJev.extractExternalDetail({ apiKey, job, inspection, onActivity, onMetrics, signal });
      if (!selected.ok) {
        onActivity(`External details unavailable for ${job.title}: ${selected.reason}`);
        return { text: fallback, quality: "external-unavailable" };
      }
      return { text: `${job.title}\n\n${selected.text}`, quality: "external" };
    } catch (error) {
      if (signal.aborted) throw error;
      onActivity(`External details unavailable for ${job.title}: ${String(error.message || error).slice(0, 180)}`);
      return { text: fallback, quality: "external-unavailable" };
    }
  }

  async function withOriginQueue(origin, task) {
    const previous = originQueues.get(origin) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    originQueues.set(origin, current);
    try { return await current; } finally { if (originQueues.get(origin) === current) originQueues.delete(origin); }
  }

  async function readJobDetails(id, signal) {
    const response = await fetch(`https://jobnet.dk/find-job/${id}`, { credentials: "omit", signal });
    if (response.status === 404) return "Jobnet has no detail page for this externally hosted posting. Grade from the search card only.";
    if (!response.ok) throw new Error(`Jobnet detail request failed (${response.status}).`);
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const pageData = JSON.parse(doc.querySelector("#__NEXT_DATA__")?.textContent || "{}");
    const queries = pageData?.props?.pageProps?.dehydratedState?.queries || [];
    const posting = queries.find((query) => query?.state?.data?.id === id)?.state?.data;
    if (!posting?.body) return "Jobnet did not expose a full description. Grade from the search card only.";
    const bodyDoc = new DOMParser().parseFromString(posting.body, "text/html");
    const body = compressPosting(bodyDoc);
    const location = posting.job?.address;
    const detail = [
      posting.title,
      posting.employer?.name ? `Employer: ${posting.employer.name}` : "",
      location?.city ? `Location: ${location.postalCode || ""} ${location.city}` : "",
      posting.job?.isPartTime ? "Part-time" : "Full-time or unspecified",
      body
    ].filter(Boolean).join("\n\n").slice(0, 9000);
    if (detail.length < 100) return "Jobnet did not expose a full description. Grade from the search card only.";
    return detail;
  }

  function compressPosting(doc) {
    doc.querySelectorAll("script, style, svg, template, button, [hidden], [aria-hidden='true']")
      .forEach((element) => element.remove());
    doc.body.querySelectorAll("br, p, li, div, h1, h2, h3, h4, h5, h6")
      .forEach((element) => element.append("\n"));
    const seen = new Set();
    return (doc.body.textContent || "")
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => {
        if (!line || /^https?:\/\/\S+$/.test(line) || /^\S+@\S+\.\S+$/.test(line)) return false;
        const key = line.toLocaleLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .join("\n");
  }
})();
