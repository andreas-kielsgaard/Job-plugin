(() => {
  "use strict";

  const INPUT_USD_PER_MILLION = 0.042;

  function requestTokens(state, questions) {
    const payload = JSON.stringify({ state, model: "jev-latest", questions });
    return Math.ceil(new TextEncoder().encode(payload).length / 3);
  }

  function ranking({ cv, preferences, prompt, jobs, maxPostingsPerState }) {
    const evaluation = globalThis.JobnetJevEvaluation;
    const batches = evaluation.buildBatches({ cv, preferences, prompt, jobs, maxPostings: maxPostingsPerState });
    const tokens = batches.reduce((total, state) => total + requestTokens(state, evaluation.buildQuestions(state)), 0);
    return { requests: batches.length, tokens };
  }

  function selection(inspection) {
    const evaluation = globalThis.JobnetExternalEvaluation;
    const state = evaluation.buildState(inspection);
    if (!state.candidates.length) return { requests: 0, tokens: 0 };
    return { requests: 1, tokens: requestTokens(state, evaluation.buildQuestions(state)) };
  }

  function dollars(tokens) {
    return tokens / 1_000_000 * INPUT_USD_PER_MILLION;
  }

  globalThis.JobnetJevCost = { INPUT_USD_PER_MILLION, requestTokens, ranking, selection, dollars };
  if (typeof module !== "undefined" && module.exports) module.exports = globalThis.JobnetJevCost;
})();
