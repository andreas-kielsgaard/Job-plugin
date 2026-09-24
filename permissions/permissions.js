(() => {
  "use strict";

  const list = document.getElementById("origins");
  const status = document.getElementById("status");
  const grant = document.getElementById("grant");
  const close = document.getElementById("close");
  let origins = [];

  init();
  grant.addEventListener("click", requestAccess);
  close.addEventListener("click", () => window.close());

  async function init() {
    const data = await browser.storage.local.get("pendingExternalOrigins");
    origins = Array.isArray(data.pendingExternalOrigins) ? data.pendingExternalOrigins : [];
    list.replaceChildren(...(origins.length ? origins.map(originItem) : [originItem("No pending sites") ]));
    grant.disabled = !origins.length;
    if (!origins.length) status.textContent = "Return to Jobnet and select external descriptions to prepare a request.";
  }

  function originItem(origin) {
    const item = document.createElement("li");
    try { item.textContent = new URL(origin).hostname; }
    catch (_) { item.textContent = origin; }
    return item;
  }

  async function requestAccess() {
    grant.disabled = true;
    status.textContent = "Waiting for Firefox…";
    try {
      const granted = await browser.permissions.request({ origins });
      if (!granted) {
        status.textContent = "Access was not granted. You can try again or return to Jobnet without external descriptions.";
        grant.disabled = false;
        return;
      }
      await browser.storage.local.remove("pendingExternalOrigins");
      status.textContent = "Access granted. Return to Jobnet and start the filter again.";
      grant.hidden = true;
      close.focus();
    } catch (error) {
      status.textContent = `Could not request access: ${String(error.message || error).slice(0, 240)}`;
      grant.disabled = false;
    }
  }
})();
