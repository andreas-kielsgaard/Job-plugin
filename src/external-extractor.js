(() => {
  "use strict";

  const MAX_CANDIDATES = 12;
  const MAX_CANDIDATE_CHARS = 6500;
  const BLOCKS = "p,li,br,dt,dd,h1,h2,h3,h4,h5,h6,section,article,div";
  const REMOVE = "script,style,svg,template,noscript,nav,footer,header,dialog,form,button,input,select,textarea,[hidden],[aria-hidden='true']";

  function normalized(value) {
    return String(value || "").toLocaleLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }

  function words(value) {
    return new Set(normalized(value).split(/\s+/).filter((word) => word.length >= 3));
  }

  function overlap(text, expected) {
    const wanted = words(expected);
    if (!wanted.size) return 0;
    const actual = words(text);
    return [...wanted].filter((word) => actual.has(word)).length / wanted.size;
  }

  function cleanText(element) {
    if (!element) return "";
    const clone = element.cloneNode(true);
    clone.querySelectorAll?.(REMOVE).forEach((node) => node.remove());
    clone.querySelectorAll?.(BLOCKS).forEach((node) => node.append("\n"));
    const seen = new Set();
    return String(clone.textContent || "")
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => {
        const key = normalized(line);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .join("\n");
  }

  function jsonLdPostings(doc) {
    const found = [];
    function visit(value) {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) return value.forEach(visit);
      const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
      if (types.some((type) => String(type).toLocaleLowerCase() === "jobposting")) found.push(value);
      if (Array.isArray(value["@graph"])) value["@graph"].forEach(visit);
    }
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try { visit(JSON.parse(script.textContent || "null")); } catch (_) { /* Invalid site metadata is ignored. */ }
    }
    return found;
  }

  function jsonLdText(posting) {
    const description = String(posting.description || "");
    const body = parseHtml(description);
    return [
      posting.title,
      posting.hiringOrganization?.name ? `Employer: ${posting.hiringOrganization.name}` : "",
      cleanText(body.body),
      posting.employmentType ? `Employment type: ${[].concat(posting.employmentType).join(", ")}` : ""
    ].filter(Boolean).join("\n");
  }

  function parseHtml(value) {
    return new DOMParser().parseFromString(`<!doctype html><html><head></head><body>${String(value || "")}</body></html>`, "text/html");
  }

  function headingSection(heading) {
    const level = Number(heading.tagName.slice(1)) || 6;
    const parts = [heading.textContent || ""];
    let sibling = heading.nextElementSibling;
    while (sibling) {
      if (/^H[1-6]$/.test(sibling.tagName) && Number(sibling.tagName.slice(1)) <= level) break;
      parts.push(cleanText(sibling));
      sibling = sibling.nextElementSibling;
    }
    return parts.filter(Boolean).join("\n");
  }

  function inspectHtml({ html, url, status = 200, expectedTitle = "", expectedEmployer = "", cardSummary = "" }) {
    const doc = parseHtml(html);
    const pageTitle = String(doc.title || "").trim();
    const targetText = `${expectedTitle} ${expectedEmployer} ${cardSummary}`;
    const raw = [];
    let order = 0;
    function add(text, source, label, element = null) {
      text = String(text || "").replace(/\n{3,}/g, "\n\n").trim();
      if (text.length < 120) return;
      const linkCount = element?.querySelectorAll?.("a").length || 0;
      const paragraphCount = element?.querySelectorAll?.("p,li").length || 0;
      const headingCount = element?.querySelectorAll?.("h1,h2,h3,h4,h5,h6").length || 0;
      const contactSignal = /(?:mailto:|tel:|\b(?:phone|telephone|telefon|tlf|contact|kontakt|apply|ansøg)\b)/i.test(element?.innerHTML || text);
      const score = overlap(text.slice(0, 2500), expectedTitle) * 12
        + overlap(text.slice(0, 3500), expectedEmployer) * 5
        + Math.min(5, Math.log10(Math.max(100, text.length)) * 1.5)
        + Math.min(3, paragraphCount / 4)
        + Math.min(2, headingCount / 2)
        + (source === "jsonld" ? 12 : source === "article" ? 7 : source === "main" ? 5 : source === "heading" ? 3 : 1)
        + (contactSignal ? 2 : 0)
        - Math.max(0, linkCount - 12) / 5;
      raw.push({ order: order++, source, label: String(label || source).slice(0, 180), score, text: text.slice(0, MAX_CANDIDATE_CHARS) });
    }

    for (const posting of jsonLdPostings(doc)) add(jsonLdText(posting), "jsonld", "JobPosting structured data");

    const elements = new Set();
    doc.querySelectorAll("article,main,[role='main'],[itemtype*='JobPosting'],[id*='job' i],[class*='job' i],[id*='career' i],[class*='career' i]")
      .forEach((element) => elements.add(element));
    const h1 = doc.querySelector("h1");
    let ancestor = h1;
    for (let depth = 0; ancestor && depth < 6; depth += 1, ancestor = ancestor.parentElement) elements.add(ancestor);
    for (const element of elements) {
      if (element.closest("nav,footer,header,dialog") || element.matches("nav,footer,header,dialog")) continue;
      const source = element.matches("article") ? "article" : element.matches("main,[role='main']") ? "main" : "container";
      const identity = [element.tagName.toLocaleLowerCase(), element.id ? `#${element.id}` : "", element.className ? `.${String(element.className).trim().replace(/\s+/g, ".")}` : ""].join("");
      add(cleanText(element), source, identity, element);
      for (const child of element.children || []) {
        const childText = cleanText(child);
        if (childText.length >= 180 && childText.length <= MAX_CANDIDATE_CHARS) add(childText, "child", `${identity} > ${child.tagName.toLocaleLowerCase()}`, child);
      }
    }
    doc.querySelectorAll("h1,h2,h3,h4").forEach((heading) => add(headingSection(heading), "heading", cleanText(heading), heading.parentElement));

    const deduped = [];
    const seen = new Set();
    for (const candidate of raw.sort((a, b) => b.score - a.score || a.order - b.order)) {
      const key = normalized(candidate.text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push({ ...candidate, id: `block_${deduped.length}` });
      if (deduped.length >= MAX_CANDIDATES) break;
    }

    const bodyText = cleanText(doc.body);
    const signalText = `${url} ${pageTitle} ${bodyText.slice(0, 1800)}`;
    const statusSignals = [];
    if (Number(status) >= 400) statusSignals.push(`HTTP ${status}`);
    if (/\b(?:404|not found|job not found|page does not exist|siden eksisterer ikke|expired|udløbet|ikke længere)\b/i.test(signalText)) {
      statusSignals.push("Page text indicates missing or expired content");
    }
    return {
      url: String(url || ""),
      pageTitle,
      status: Number(status) || 0,
      statusSignals,
      target: { title: String(expectedTitle || ""), employer: String(expectedEmployer || ""), cardSummary: String(cardSummary || "").slice(0, 1200) },
      pagePreview: bodyText.slice(0, 2400),
      candidates: deduped
    };
  }

  const exported = { inspectHtml, cleanText, normalized, MAX_CANDIDATES, MAX_CANDIDATE_CHARS };
  globalThis.JobnetExternalExtractor = exported;
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
})();
