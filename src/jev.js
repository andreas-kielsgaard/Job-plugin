(() => {
  "use strict";

  const API = "https://api.typesafe.ai/v1/systemone";
  const MODEL = "jev-latest";
  const evaluation = globalThis.JobnetJevEvaluation;

  function pause(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException("Stopped.", "AbortError"));
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
      function abort() { clearTimeout(timer); reject(new DOMException("Stopped.", "AbortError")); }
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async function request(apiKey, state, questions, signal, onMetrics) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) controller.abort();
      const timeout = setTimeout(abort, 90000);
      const started = Date.now();
      try {
        const response = await fetch(API, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ state, model: MODEL, questions }),
          signal: controller.signal
        });
        const data = await response.json().catch(() => ({}));
        if ((response.status === 429 || response.status === 529) && attempt < 2) {
          await pause(1000 * (2 ** attempt), signal);
          continue;
        }
        if (!response.ok) throw new Error(`TypeSafe API ${response.status}: ${String(data.error?.message || data.detail || response.statusText).slice(0, 300)}`);
        if (!data.answers || typeof data.answers !== "object") throw new Error("TypeSafe returned no answers.");
        onMetrics?.({ elapsedMs: Date.now() - started, inputTokens: Number(data.usage?.input_tokens || 0),
          outputTokens: Number(data.usage?.output_tokens || 0), cacheCreationTokens: 0, cacheReadTokens: 0 });
        return data.answers;
      } catch (error) {
        if (error.name === "AbortError" && !signal?.aborted) throw new Error("TypeSafe request timed out after 90 seconds.");
        throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      }
    }
    throw new Error("TypeSafe request failed after retries.");
  }

  function checkedChoice(answer) {
    const groups = Object.keys(evaluation.GROUPS);
    if (answer?.type !== "choice" || !groups.includes(answer.choice) || !Number.isFinite(answer.probabilities?.[answer.choice])) {
      throw new Error("TypeSafe returned an invalid or incomplete classification.");
    }
    return answer;
  }

  function checkedScore(answer) {
    if (answer?.type !== "score" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > evaluation.LEVELS.length - 1) {
      throw new Error("TypeSafe returned an invalid fit score.");
    }
    return Math.round(answer.score * 100 / (evaluation.LEVELS.length - 1));
  }

  function checkedNoul(answer) {
    if (answer?.type !== "noul" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
      throw new Error("TypeSafe returned an invalid contact-phone answer.");
    }
    return answer.noul >= 0.5;
  }

  async function extractExternalDetail({ apiKey, job, inspection, onActivity, onMetrics, signal }) {
    const external = globalThis.JobnetExternalEvaluation;
    const state = external.buildState(inspection);
    if (!state.candidates.length) return { ok: false, reason: "The external page exposed no substantial content blocks." };
    onActivity(`Jev: selecting job content from ${state.candidates.length} external page blocks for ${job.title}.`);
    const answers = await request(apiKey, state, external.buildQuestions(state), signal, onMetrics);
    return external.combine(inspection, answers);
  }

  async function gradeBatch({ apiKey, cv, preferences, prompt, jobs, detailLanes = 3, maxPostingsPerState = null, readDetails, onActivity, onMetrics, signal }) {
    const packer = evaluation.createPacker({ cv, preferences, prompt, maxPostings: maxPostingsPerState });
    const grades = new Map();
    const queryPromises = [];
    let queuedStates = 0;
    let next = 0;
    let completed = 0;
    let reused = 0;

    function enqueue(state) {
      const stateNumber = ++queuedStates;
      const query = (async () => {
        onActivity(`Jev: evaluating state ${stateNumber} with ${state.postings.length * 3} questions while details continue loading.`);
        const answers = await request(apiKey, state, evaluation.buildQuestions(state), signal, onMetrics);
        state.postings.forEach((job, index) => {
          const group = checkedChoice(answers[`category_${index}`]);
          const scoreAnswer = answers[`score_${index}`];
          grades.set(job.id, { id: job.id, ...globalThis.JobnetRanking.normalizeGrade({
            category: group.choice,
            score: checkedScore(scoreAnswer),
            reason: "",
            hasContactPhone: checkedNoul(answers[`contact_phone_${index}`])
          }) });
        });
      })();
      query.catch(() => {});
      queryPromises.push(query);
    }

    async function worker() {
      while (next < jobs.length && !signal?.aborted) {
        const index = next++;
        const job = jobs[index];
        let enriched;
        let throttle = false;
        try {
          const detail = await readDetails(job.id);
          enriched = { ...job, details: detail.text };
          if (detail.fromCache) reused += 1;
          else throttle = true;
        } catch (error) {
          if (signal?.aborted) throw error;
          enriched = { ...job, details: `Full description unavailable: ${error.message}` };
        }
        const ready = packer.add(enriched);
        if (ready) enqueue(ready);
        onActivity(`Loading Jobnet descriptions: ${++completed} of ${jobs.length}; ${queuedStates} Jev state ${queuedStates === 1 ? "batch" : "batches"} queued.`, true);
        if (throttle) await pause(150, signal);
      }
    }

    const lanes = Math.max(1, Math.min(6, Math.trunc(Number(detailLanes)) || 3));
    const activeLanes = Math.min(lanes, jobs.length);
    if (maxPostingsPerState) onActivity(`Jev: limiting each state to at most ${maxPostingsPerState} posts.`);
    onActivity(`Jev: loading details through ${activeLanes} parallel ${activeLanes === 1 ? "lane" : "lanes"}; evaluation starts as state batches fill.`);
    await Promise.all(Array.from({ length: activeLanes }, worker));
    if (signal?.aborted) throw new DOMException("Stopped.", "AbortError");
    const final = packer.flush();
    if (final) enqueue(final);
    onActivity(`Descriptions ready: ${reused} cached, ${jobs.length - reused} checked on Jobnet; waiting for ${queuedStates} Jev state ${queuedStates === 1 ? "batch" : "batches"}.`);
    await Promise.all(queryPromises);
    return jobs.map((job) => grades.get(job.id));
  }

  globalThis.JobnetJev = { gradeBatch, extractExternalDetail };
  if (typeof module !== "undefined" && module.exports) module.exports = { gradeBatch, extractExternalDetail };
})();
