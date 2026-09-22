(() => {
  "use strict";

  const store = browser.storage.local;
  const controllers = new Map();
  const DEFAULT_MODEL = "haiku";
  const DETAIL_CACHE_KEY = "jobDetailCache";
  const DETAIL_CACHE_AGE = 24 * 60 * 60 * 1000;
  const DETAIL_CACHE_LIMIT = 200;
  let cacheWrites = Promise.resolve();

  browser.runtime.onMessage.addListener((message, sender) => {
    if (!message || typeof message !== "object") return undefined;
    if (message.type === "JAS_GET_SETTINGS") return getSettings();
    if (message.type === "JAS_HAS_KEY") return store.get(["apiKey", "jevApiKey"]).then((data) => ({ hasApiKey: Boolean(data.apiKey), hasJevApiKey: Boolean(data.jevApiKey) }));
    if (message.type === "JAS_GET_MODEL_TYPE") return store.get("model").then((data) => ({ model: JobnetModels.typeOf(data.model) }));
    if (message.type === "JAS_SAVE_SETTINGS") return saveSettings(message.settings);
    if (message.type === "JAS_DELETE_KEY") return deleteKey();
    if (message.type === "JAS_DELETE_JEV_KEY") return deleteJevKey();
    if (message.type === "JAS_GRADE_BATCH") return gradeBatch(message, sender);
    if (message.type === "JAS_CANCEL") return cancel(sender);
    return undefined;
  });

  async function getSettings() {
    const data = await store.get(["apiKey", "jevApiKey", "cv", "preferences", "model"]);
    return {
      hasApiKey: Boolean(data.apiKey),
      hasJevApiKey: Boolean(data.jevApiKey),
      cv: data.cv || "",
      preferences: data.preferences || "",
      model: JobnetModels.typeOf(data.model || DEFAULT_MODEL)
    };
  }

  async function saveSettings(raw) {
    const settings = raw && typeof raw === "object" ? raw : {};
    const changes = {
      cv: String(settings.cv || "").slice(0, 30000),
      preferences: String(settings.preferences || "").slice(0, 15000),
      model: JobnetModels.typeOf(settings.model || DEFAULT_MODEL)
    };
    const apiKey = String(settings.apiKey || "").trim();
    const jevApiKey = String(settings.jevApiKey || "").trim();
    if (apiKey) changes.apiKey = apiKey;
    if (jevApiKey) changes.jevApiKey = jevApiKey;
    await store.set(changes);
    return getSettings();
  }

  async function deleteKey() {
    await store.remove("apiKey");
    return getSettings();
  }

  async function deleteJevKey() {
    await store.remove("jevApiKey");
    return getSettings();
  }

  function validSearchSender(sender) {
    return sender.tab?.id && /^https:\/\/jobnet\.dk\/find-job(?:[?#]|$)/.test(sender.url || "");
  }

  async function gradeBatch(message, sender) {
    if (!validSearchSender(sender)) return { ok: false, error: "Open a Jobnet search page." };
    const tabId = sender.tab.id;
    if (controllers.has(tabId)) return { ok: false, error: "A filtering request is already running in this tab." };
    const provider = message.provider === "jev" ? "jev" : "claude";
    const data = await store.get(["apiKey", "jevApiKey", "cv", "preferences", "model"]);
    if (!data[provider === "jev" ? "jevApiKey" : "apiKey"]) return { ok: false, error: `Save a ${provider === "jev" ? "TypeSafe Jev" : "Claude"} API key in settings first.` };
    const jobs = Array.isArray(message.jobs) ? message.jobs : [];
    if (!jobs.length || jobs.length > 10) return { ok: false, error: "Review 1–10 Jobnet cards at a time." };
    const ids = jobs.map((job) => String(job?.id || ""));
    if (new Set(ids).size !== ids.length || ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) {
      return { ok: false, error: "Invalid or duplicate Jobnet card ID." };
    }
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
      const result = await (provider === "jev" ? JobnetJev : JobnetClaude).gradeBatch({
        apiKey: provider === "jev" ? data.jevApiKey : data.apiKey,
        model,
        cv: data.cv || "",
        preferences: data.preferences || "",
        prompt: String(message.prompt || "").slice(0, 6000),
        jobs: jobs.map((job) => ({
          id: String(job.id),
          title: String(job.title || "").slice(0, 300),
          summary: String(job.summary || "").slice(0, 3500),
          url: String(job.url || "").slice(0, 500)
        })),
        readDetails: async (id) => {
          const detail = await cachedJobDetails(id, controller.signal);
          metrics[detail.fromCache ? "cacheHits" : "detailRequests"] += 1;
          return detail;
        },
        onActivity,
        onMetrics: (sample) => {
          metrics.requests += 1;
          for (const key of ["elapsedMs", "inputTokens", "cacheCreationTokens", "cacheReadTokens", "outputTokens"]) metrics[key] += sample[key];
        },
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

  async function cachedJobDetails(id, signal) {
    if (signal.aborted) throw new DOMException("Stopped.", "AbortError");
    try {
      const cache = (await store.get(DETAIL_CACHE_KEY))[DETAIL_CACHE_KEY] || {};
      const item = cache[id];
      if (item && typeof item.text === "string" && Date.now() - item.at < DETAIL_CACHE_AGE) {
        return { text: item.text, fromCache: true };
      }
    } catch (_) { /* Cache read failure must not block a Jobnet detail request. */ }
    const text = await readJobDetails(id, signal);
    cacheWrites = cacheWrites.catch(() => {}).then(async () => {
      const cache = (await store.get(DETAIL_CACHE_KEY))[DETAIL_CACHE_KEY] || {};
      const now = Date.now();
      const entries = Object.entries(cache)
        .filter(([key, item]) => key !== id && typeof item?.text === "string" && now - item.at < DETAIL_CACHE_AGE)
        .sort((a, b) => a[1].at - b[1].at);
      entries.push([id, { text, at: now }]);
      await store.set({ [DETAIL_CACHE_KEY]: Object.fromEntries(entries.slice(-DETAIL_CACHE_LIMIT)) });
    });
    await cacheWrites.catch(() => {});
    return { text, fromCache: false };
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
