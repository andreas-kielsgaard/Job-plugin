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

  async function loadDetails(jobs, readDetails, onActivity, signal) {
    const enriched = new Array(jobs.length);
    let next = 0;
    let completed = 0;
    let reused = 0;
    async function worker() {
      while (next < jobs.length && !signal?.aborted) {
        const index = next++;
        const job = jobs[index];
        try {
          const detail = await readDetails(job.id);
          enriched[index] = { ...job, details: detail.text };
          if (detail.fromCache) reused += 1;
          else await pause(150, signal);
        } catch (error) {
          if (signal?.aborted) throw error;
          enriched[index] = { ...job, details: `Full description unavailable: ${error.message}` };
        }
        onActivity(`Loading Jobnet descriptions: ${++completed} of ${jobs.length}.`, true);
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, worker));
    if (signal?.aborted) throw new DOMException("Stopped.", "AbortError");
    onActivity(`Descriptions ready: ${reused} cached, ${jobs.length - reused} checked on Jobnet.`);
    return enriched;
  }

  async function gradeBatch({ apiKey, cv, preferences, prompt, jobs, readDetails, onActivity, onMetrics, signal }) {
    onActivity(`Jev: loading details for ${jobs.length} postings before evaluation.`);
    const enriched = await loadDetails(jobs, readDetails, onActivity, signal);
    const states = evaluation.buildBatches({ cv, preferences, prompt, jobs: enriched });
    onActivity(`Jev: built ${states.length} state ${states.length === 1 ? "batch" : "batches"}, each within 20k estimated tokens.`);
    const grades = [];
    for (let batchIndex = 0; batchIndex < states.length; batchIndex += 1) {
      const state = states[batchIndex];
      onActivity(`Jev: evaluating state ${batchIndex + 1} of ${states.length} with ${state.postings.length * 2} paired questions.`);
      const answers = await request(apiKey, state, evaluation.buildQuestions(state), signal, onMetrics);
      state.postings.forEach((job, index) => {
        const group = checkedChoice(answers[`category_${index}`]);
        const scoreAnswer = answers[`score_${index}`];
        const probability = Math.round(100 * group.probabilities[group.choice]);
        const confidence = Number.isFinite(scoreAnswer?.confidence) ? `; score confidence ${Math.round(100 * scoreAnswer.confidence)}%` : "";
        grades.push({ id: job.id, ...globalThis.JobnetRanking.normalizeGrade({
          category: group.choice,
          score: checkedScore(scoreAnswer),
          reason: `Jev group probability ${probability}%${confidence}.`
        }) });
      });
    }
    return grades;
  }

  globalThis.JobnetJev = { gradeBatch };
  if (typeof module !== "undefined" && module.exports) module.exports = { gradeBatch };
})();
