const $ = (s) => document.querySelector(s);

let currentCookies = [];
let currentUrl = "";
let sortBy = "name";

async function getActiveTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url || "";
}

function render(cookies, filter = "") {
  const list = $("#list");
  list.innerHTML = "";

  const q = filter.trim().toLowerCase();
  let filtered = !q ? cookies : cookies.filter(c => {
    return (c.name?.toLowerCase().includes(q)) ||
           (c.domain?.toLowerCase().includes(q)) ||
           (c.value?.toLowerCase().includes(q));
  });

  // sorting
  filtered = filtered.slice().sort((a, b) => {
    if (sortBy === "domain") {
      return (a.domain || "").localeCompare(b.domain || "") || (a.name || "").localeCompare(b.name || "");
    }
    if (sortBy === "expires") {
      const ax = a.expirationDate || 0, bx = b.expirationDate || 0;
      return ax - bx || (a.name || "").localeCompare(b.name || "");
    }
    return (a.name || "").localeCompare(b.name || "");
  });

  if (!filtered.length) {
    list.innerHTML = `<div class="item">No cookies found.</div>`;
    return;
  }

  for (const c of filtered) {
    const tags = [];
    if (c.httpOnly) tags.push("HttpOnly");
    if (c.secure) tags.push("Secure");
    if (c.sameSite) tags.push(`SameSite:${c.sameSite}`);
    if (c.session) tags.push("Session");
    const exp = c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : "—";
    const path = c.path || "/";
    const dom = c.domain || "";

    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div><span class="k">Name:</span> ${c.name}</div>
      <div><span class="k">Domain:</span> ${dom} <span class="k">Path:</span> ${path}</div>
      <div><span class="k">Value:</span> <code>${(c.value || "").toString().slice(0, 100)}</code></div>
      <div class="row">
        <span class="k">Expires:</span> ${exp}
        ${tags.map(t => `<span class="tag">${t}</span>`).join("")}
      </div>
    `;
    list.appendChild(el);
  }
}

async function refresh() {
  $("#meta").textContent = "Loading...";
  try {
    currentUrl = await getActiveTabUrl();
    if (!currentUrl) throw new Error("No active tab URL.");

    const res = await chrome.runtime.sendMessage({ type: "GET_COOKIES", url: currentUrl });
    if (!res?.ok) throw new Error(res?.error || "Failed to get cookies.");

    currentCookies = res.cookies || [];
    $("#meta").innerHTML = `<span class="ok">Found ${currentCookies.length} cookies for ${new URL(currentUrl).hostname}</span>`;
    render(currentCookies, $("#search").value);

    // Populate domain dropdown
    try {
      const dres = await chrome.runtime.sendMessage({ type: "GET_UNIQUE_DOMAINS" });
      if (dres?.ok) {
        const sel = $("#domainSelect");
        if (sel) {
          const val = sel.value;
          sel.innerHTML = `<option value="">-- Select domain --</option>` +
            (dres.domains || []).map(d=>`<option value="${d}">${d}</option>`).join('');
          if (val) sel.value = val;
        }
      }
    } catch (_) {}
  } catch (e) {
    $("#meta").innerHTML = `<span class="err">${String(e)}</span>`;
    render([], "");
  }
}

$("#refresh").addEventListener("click", refresh);

$("#copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(currentCookies, null, 2));
    $("#meta").textContent = "Copied JSON to clipboard.";
  } catch (e) {
    $("#meta").textContent = "Clipboard failed: " + String(e);
  }
});

$("#export").addEventListener("click", async () => {
  try {
    const host = currentUrl ? new URL(currentUrl).hostname : "site";
    const filename = `cookies-${host}.json`;
    const res = await chrome.runtime.sendMessage({
      type: "EXPORT_COOKIES",
      data: currentCookies,
      filename
    });
    if (!res?.ok) throw new Error(res?.error || "Download failed.");
    $("#meta").textContent = "Export started.";
  } catch (e) {
    $("#meta").textContent = "Export failed: " + String(e);
  }
});

// Export all cookies for base domain (including subdomains)
$("#exportDomain").addEventListener("click", async () => {
  try {
    if (!currentUrl) currentUrl = await getActiveTabUrl();
    const host = new URL(currentUrl).hostname.replace(/^www\./, "");
    $("#meta").textContent = `Collecting cookies for *.${host}...`;
    const res = await chrome.runtime.sendMessage({ type: "GET_DOMAIN_COOKIES", url: currentUrl });
    if (!res?.ok) throw new Error(res?.error || "Failed to get domain cookies.");
    const cookies = res.cookies || [];
    // Try to include page storage too for better session portability
    let storage = { localStorage: {}, sessionStorage: {}, origin: undefined };
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const ls = {}; const ss = {};
            for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); }
            for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); ss[k] = sessionStorage.getItem(k); }
            return { localStorage: ls, sessionStorage: ss, origin: location.origin };
          }
        });
        storage = result || storage;
      }
    } catch (_) {}

    const payload = { domain: host, cookies, storage };
    const filename = `cookies-domain-${host}.json`;
    const dl = await chrome.runtime.sendMessage({ type: "EXPORT_COOKIES", data: payload, filename });
    if (!dl?.ok) throw new Error(dl?.error || "Download failed.");
    $("#meta").textContent = `Exported ${cookies.length} cookies for *.${host} with storage`;
  } catch (e) {
    $("#meta").textContent = "Export domain failed: " + String(e);
  }
});

// Export page storage (localStorage + sessionStorage) and cookies
$("#exportStorage").addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab?.url) throw new Error("No active tab.");
    $("#meta").textContent = "Collecting storage and cookies...";
    // Read storage values from the page context
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        try {
          const ls = {}; const ss = {};
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i); ls[k] = localStorage.getItem(k);
          }
          for (let i = 0; i < sessionStorage.length; i++) {
            const k = sessionStorage.key(i); ss[k] = sessionStorage.getItem(k);
          }
          return { ok: true, localStorage: ls, sessionStorage: ss, origin: location.origin };
        } catch (e) { return { ok: false, error: String(e) }; }
      }
    });
    if (!result?.ok) throw new Error(result?.error || "Storage read failed.");

    const cookiesRes = await chrome.runtime.sendMessage({ type: "GET_COOKIES", url: tab.url });
    if (!cookiesRes?.ok) throw new Error(cookiesRes?.error || "Cookies read failed.");

    const payload = {
      url: tab.url,
      origin: result.origin,
      cookies: cookiesRes.cookies || [],
      localStorage: result.localStorage,
      sessionStorage: result.sessionStorage
    };
    const filename = `storage-${new URL(tab.url).hostname}.json`;
    const dl = await chrome.runtime.sendMessage({ type: "EXPORT_COOKIES", data: payload, filename });
    if (!dl?.ok) throw new Error(dl?.error || "Download failed.");
    $("#meta").textContent = "Exported storage and cookies.";
  } catch (e) {
    $("#meta").textContent = "Export storage failed: " + String(e);
  }
});

// Export Google bundle (mail.google.com, accounts.google.com, google.com)
$("#exportGoogle").addEventListener("click", async () => {
  try {
    $("#meta").textContent = "Collecting Google bundle...";
    const domains = ["mail.google.com", "accounts.google.com", "google.com"];
    const res = await chrome.runtime.sendMessage({ type: "GET_COOKIES_FOR_DOMAINS", domains });
    if (!res?.ok) throw new Error(res?.error || "Failed to get bundle.");
    const payload = { bundle: domains, cookies: res.cookies || [] };
    const dl = await chrome.runtime.sendMessage({ type: "EXPORT_COOKIES", data: payload, filename: "cookies-google-bundle.json" });
    if (!dl?.ok) throw new Error(dl?.error || "Download failed.");
    $("#meta").textContent = `Exported ${payload.cookies.length} Google cookies.`;
  } catch (e) {
    $("#meta").textContent = "Export Google failed: " + String(e);
  }
});

// Domain dropdown actions
$("#exportByDomain").addEventListener("click", async () => {
  try {
    const d = $("#domainSelect").value.trim();
    if (!d) return alert("Select a domain first");
    $("#meta").textContent = `Exporting cookies for ${d}...`;
    const res = await chrome.runtime.sendMessage({ type: "GET_EXACT_DOMAIN_COOKIES", domain: d });
    if (!res?.ok) throw new Error(res?.error || "Failed to get domain cookies.");
    const dl = await chrome.runtime.sendMessage({ type: "EXPORT_COOKIES", data: res.cookies || [], filename: `cookies-${d}.json` });
    if (!dl?.ok) throw new Error(dl?.error || "Download failed.");
    $("#meta").textContent = `Exported ${ (res.cookies||[]).length } cookies for ${d}.`;
  } catch (e) {
    $("#meta").textContent = "Export by domain failed: " + String(e);
  }
});

$("#deleteByDomain").addEventListener("click", async () => {
  try {
    const d = $("#domainSelect").value.trim();
    if (!d) return alert("Select a domain first");
    if (!confirm(`Delete cookies for ${d}?`)) return;
    $("#meta").textContent = `Deleting cookies for ${d}...`;
    const res = await chrome.runtime.sendMessage({ type: "DELETE_DOMAIN_COOKIES", domain: d });
    if (!res?.ok) throw new Error(res?.error || "Delete failed.");
    $("#meta").textContent = `Deleted: ${res.deleted}, Failed: ${res.failed} for ${d}.`;
    await refresh();
  } catch (e) {
    $("#meta").textContent = "Delete by domain failed: " + String(e);
  }
});

$("#search").addEventListener("input", (e) => render(currentCookies, e.target.value));

$("#sort").addEventListener("change", (e) => {
  sortBy = e.target.value;
  render(currentCookies, $("#search").value);
});

$("#deleteSite").addEventListener("click", async () => {
  try {
    if (!currentUrl) currentUrl = await getActiveTabUrl();
    const host = new URL(currentUrl).hostname;
    const ok = confirm(`Delete all cookies for ${host}?`);
    if (!ok) return;
    $("#meta").textContent = "Deleting site cookies...";
    const res = await chrome.runtime.sendMessage({ type: "DELETE_SITE_COOKIES", url: currentUrl });
    if (!res?.ok) throw new Error(res?.error || "Delete failed.");
    $("#meta").textContent = `Deleted: ${res.deleted}, Failed: ${res.failed}`;
    // Refresh site cookies list after deletion
    await refresh();
  } catch (e) {
    $("#meta").textContent = "Delete failed: " + String(e);
  }
});

$("#deleteAll").addEventListener("click", async () => {
  try {
    const ok = confirm("Delete ALL cookies across this Chrome profile? This cannot be undone.");
    if (!ok) return;
    $("#meta").textContent = "Deleting all cookies...";
    const res = await chrome.runtime.sendMessage({ type: "DELETE_ALL_COOKIES" });
    if (!res?.ok) throw new Error(res?.error || "Delete-all failed.");
    $("#meta").textContent = `Deleted: ${res.deleted}, Failed: ${res.failed}`;
    await refresh();
  } catch (e) {
    $("#meta").textContent = "Delete-all failed: " + String(e);
  }
});

// Export all cookies across all sites
$("#exportAll").addEventListener("click", async () => {
  try {
    $("#meta").textContent = "Exporting all cookies...";
    const res = await chrome.runtime.sendMessage({ type: "GET_ALL_COOKIES" });
    if (!res?.ok) throw new Error(res?.error || "Failed to collect all cookies.");
    const all = res.cookies || [];
    const json = JSON.stringify(all, null, 2);

    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const filename = `cookies-all-${Date.now()}.json`;
    const dl = await chrome.runtime.sendMessage({ type: "EXPORT_COOKIES", data: all, filename });
    if (!dl?.ok) throw new Error(dl?.error || "Download failed.");
    $("#meta").textContent = `Exported ${all.length} cookies.`;
    URL.revokeObjectURL(url);
  } catch (e) {
    $("#meta").textContent = "Export-all failed: " + String(e);
  }
});

// Import cookies from JSON file
$("#import").addEventListener("click", () => {
  $("#fileInput").value = "";
  $("#fileInput").click();
});

$("#fileInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    $("#meta").textContent = "Importing cookies...";
    const text = await file.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error("Invalid JSON file.");
    }
    const res = await chrome.runtime.sendMessage({ type: "IMPORT_COOKIES", data });
    if (!res?.ok) throw new Error(res?.error || "Import failed.");
    $("#meta").textContent = `Imported: ${res.imported}, Failed: ${res.failed}`;
    let msg = `Import finished. Imported: ${res.imported}, Failed: ${res.failed}`;
    if (res.errors && res.errors.length) {
      const sample = res.errors.slice(0, 3).map(e => `${e.name}@${e.domain}: ${e.error}`).join('\n');
      msg += `\nSample errors:\n${sample}`;
    }
    alert(msg);
    // Refresh current site cookies after import in case they apply
    refresh();
  } catch (err) {
    const m = String(err);
    $("#meta").textContent = "Import failed: " + m;
    alert("Import failed: " + m);
  }
});

// Trigger consent acceptor on current page
$("#accept").addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab.");
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["consent.js"]
    });
    $("#meta").textContent = "Attempted to accept cookie banner.";
  } catch (e) {
    $("#meta").textContent = "Accept failed: " + String(e);
  }
});

// Auto-load
refresh();
