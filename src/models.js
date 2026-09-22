(() => {
  "use strict";

  const TYPES = ["haiku", "sonnet", "opus"];
  const MAX_AGE = 10 * 60 * 1000;
  let cached = null;

  function typeOf(value) {
    const raw = String(value || "").toLowerCase();
    if (TYPES.includes(raw)) return raw;
    return /^claude-(haiku|sonnet|opus)-/.exec(raw)?.[1] || "haiku";
  }

  async function resolve(type, apiKey, signal) {
    if (!TYPES.includes(type)) throw new Error("Choose a Claude model type in settings.");
    if (!cached || cached.key !== apiKey || Date.now() >= cached.expires) {
      const pending = listModels(apiKey, signal);
      cached = { key: apiKey, expires: Date.now() + MAX_AGE, pending };
      pending.catch(() => { if (cached?.pending === pending) cached = null; });
    }
    const models = await cached.pending;
    const model = models.find((item) => new RegExp(`^claude-${type}-[0-9]`).test(item.id));
    if (!model) throw new Error(`No available Claude ${type} model was returned by Anthropic.`);
    return model.id;
  }

  async function listModels(apiKey, signal) {
    const models = [];
    let cursor = "";
    do {
      const url = `https://api.anthropic.com/v1/models?limit=1000${cursor ? `&after_id=${encodeURIComponent(cursor)}` : ""}`;
      const response = await fetch(url, {
        headers: {
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
          "x-api-key": apiKey
        },
        signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Claude model lookup failed (${response.status}): ${String(data.error?.message || response.statusText).slice(0, 300)}`);
      if (!Array.isArray(data.data)) throw new Error("Claude model lookup returned an invalid response.");
      models.push(...data.data);
      if (!data.has_more) break;
      if (!data.last_id || data.last_id === cursor) throw new Error("Claude model lookup could not continue to the next page.");
      cursor = data.last_id;
    } while (models.length < 3000);
    return models;
  }

  globalThis.JobnetModels = { typeOf, resolve };
  if (typeof module !== "undefined" && module.exports) module.exports = { typeOf, resolve };
})();
