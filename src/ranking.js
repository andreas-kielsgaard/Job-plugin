(() => {
  "use strict";

  const groupOrder = { clear: 0, potential: 1, irrelevant: 2 };

  function normalizeGrade(input) {
    if (!input || !Object.hasOwn(groupOrder, input.category)) {
      throw new Error("Claude returned an unknown relevance group.");
    }
    const score = Number(input.score);
    if (!Number.isInteger(score) || score < 0 || score > 100) {
      throw new Error("Claude returned an invalid fit score.");
    }
    const reason = String(input.reason || "").trim();
    const shortened = reason.length > 240
      ? `${reason.slice(0, 239).trimEnd().replace(/\s+\S*$/, "")}…`
      : reason;
    return {
      category: input.category,
      score,
      reason: shortened
    };
  }

  function compare(a, b) {
    const aGroup = a.grade ? groupOrder[a.grade.category] : 3;
    const bGroup = b.grade ? groupOrder[b.grade.category] : 3;
    return aGroup - bGroup || (b.grade?.score ?? -1) - (a.grade?.score ?? -1) || a.index - b.index;
  }

  const exported = { normalizeGrade, compare };
  globalThis.JobnetRanking = exported;
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
})();
