function getBaseDomain(host) {
  try {
    host = host.replace(/^www\./, "");
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    const last3 = parts.slice(-3).join('.');
    const multiTLD = new Set([
      'co.uk','com.au','co.jp','co.in','com.br','com.sa','com.mx','com.tr','com.ar','com.hk','com.sg','com.my'
    ]);
    if (multiTLD.has(last3)) return last3;
    return parts.slice(-2).join('.');
  } catch (_) { return host; }
}

function cookieUrlFromCookie(c, schemeOverride) {
  const scheme = schemeOverride || (c.secure ? 'https' : 'http');
  const host = (c.domain?.replace(/^\./,'') || 'localhost');
  const path = c.path || '/';
  return `${scheme}://${host}${path}`;
}

function removeCookieAdvanced(c, cb) {
  // Try a few removal variants to maximize success across cookie types
  const variants = [];
  // 0) default scheme, with partitionKey
  variants.push({ scheme: undefined, withPartition: true });
  // 1) default scheme, without partitionKey
  variants.push({ scheme: undefined, withPartition: false });
  // 2) toggled scheme, with partitionKey
  variants.push({ scheme: c.secure ? 'http' : 'https', withPartition: true });
  // 3) toggled scheme, without partitionKey
  variants.push({ scheme: c.secure ? 'http' : 'https', withPartition: false });

  let i = 0; let lastErr = '';
  const tryNext = () => {
    if (i >= variants.length) return cb(false, lastErr);
    const v = variants[i++];
    const url = cookieUrlFromCookie(c, v.scheme);
    const details = { url, name: c.name, storeId: c.storeId };
    if (v.withPartition && c.partitionKey) details.partitionKey = c.partitionKey;
    chrome.cookies.remove(details, (res) => {
      if (chrome.runtime.lastError) {
        lastErr = chrome.runtime.lastError.message || '';
        return tryNext();
      }
      if (!res || !res.name) return tryNext();
      cb(true, '');
    });
  };
  tryNext();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const respond = (payload) => { try { sendResponse(payload); } catch (_) {} };

  if (msg.type === "GET_COOKIES") {
    try {
      const u = new URL(msg.url);
      chrome.cookies.getAll({ domain: u.hostname }, (cookies) => {
        if (chrome.runtime.lastError) {
          respond({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          respond({ ok: true, cookies });
        }
      });
    } catch (e) {
      respond({ ok: false, error: String(e) });
    }
    return true; // keep the message channel open
  }

  if (msg.type === "GET_ALL_COOKIES") {
    chrome.cookies.getAll({}, (cookies) => {
      if (chrome.runtime.lastError) {
        respond({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        respond({ ok: true, cookies });
      }
    });
    return true;
  }

  if (msg.type === "EXPORT_COOKIES") {
    try {
      const json = "data:application/json;charset=utf-8," +
        encodeURIComponent(JSON.stringify(msg.data, null, 2));
      chrome.downloads.download({
        url: json,
        filename: msg.filename || "cookies.json",
        saveAs: true
      }, (id) => {
        if (chrome.runtime.lastError) {
          respond({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          respond({ ok: true, id });
        }
      });
    } catch (e) {
      respond({ ok: false, error: String(e) });
    }
    return true;
  }

  if (msg.type === "GET_DOMAIN_COOKIES") {
    try {
      const u = new URL(msg.url);
      const base = getBaseDomain(u.hostname);
      chrome.cookies.getAll({ domain: base }, (cookies) => {
        if (chrome.runtime.lastError) {
          respond({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          respond({ ok: true, cookies });
        }
      });
    } catch (e) {
      respond({ ok: false, error: String(e) });
    }
    return true;
  }

  if (msg.type === "GET_EXACT_DOMAIN_COOKIES") {
    const domain = (msg.domain || '').replace(/^\./, '');
    if (!domain) { respond({ ok: false, error: 'Missing domain' }); return false; }
    chrome.cookies.getAll({ domain }, (cookies) => {
      if (chrome.runtime.lastError) respond({ ok: false, error: chrome.runtime.lastError.message });
      else respond({ ok: true, cookies });
    });
    return true;
  }

  if (msg.type === "GET_COOKIES_FOR_DOMAINS") {
    const domains = Array.isArray(msg.domains) ? msg.domains : [];
    if (!domains.length) { respond({ ok: false, error: 'No domains' }); return false; }
    let all = [];
    let pending = domains.length; let failed = 0;
    domains.forEach((d) => {
      const domain = (d || '').replace(/^\./, '');
      chrome.cookies.getAll({ domain }, (cookies) => {
        if (chrome.runtime.lastError) failed++;
        else all = all.concat(cookies || []);
        if (--pending === 0) respond({ ok: true, cookies: all, failed });
      });
    });
    return true;
  }

  if (msg.type === "GET_UNIQUE_DOMAINS") {
    chrome.cookies.getAll({}, (cookies) => {
      if (chrome.runtime.lastError) return respond({ ok: false, error: chrome.runtime.lastError.message });
      const set = new Set();
      (cookies || []).forEach(c => { if (c.domain) set.add(c.domain.replace(/^\./, '')); });
      const list = Array.from(set).sort((a,b)=>a.localeCompare(b));
      respond({ ok: true, domains: list });
    });
    return true;
  }

  if (msg.type === "DELETE_DOMAIN_COOKIES") {
    const domain = (msg.domain || '').replace(/^\./, '');
    if (!domain) { respond({ ok: false, error: 'Missing domain' }); return false; }
    chrome.cookies.getAll({ domain }, (cookies) => {
      if (chrome.runtime.lastError) return respond({ ok: false, error: chrome.runtime.lastError.message });
      let ok = 0, fail = 0;
      const done = () => respond({ ok: true, deleted: ok, failed: fail, domain });
      if (!cookies.length) return done();
      let pending = cookies.length;
      cookies.forEach((c) => {
        removeCookieAdvanced(c, (success) => {
          if (success) ok++; else fail++;
          if (--pending === 0) done();
        });
      });
    });
    return true;
  }

  if (msg.type === "IMPORT_COOKIES") {
    // msg.data is expected to be an array of cookie-like objects
    const items = Array.isArray(msg.data) ? msg.data : (msg.data?.cookies || []);
    const normalizeSameSite = (v) => {
      if (!v) return undefined;
      const s = String(v).toLowerCase();
      if (s === 'none' || s === 'no_restriction') return 'no_restriction';
      if (s === 'lax') return 'lax';
      if (s === 'strict') return 'strict';
      return undefined;
    };

    const toUrl = (c) => {
      try {
        const host = (c.domain || "").replace(/^\./, "");
        if (!host) return null;
        const scheme = c.secure ? "https" : "http";
        const path = c.path || "/";
        return `${scheme}://${host}${path}`;
      } catch (_) { return null; }
    };

    const setOne = (c) => new Promise((resolve) => {
      const url = c.url || toUrl(c);
      if (!url || !c.name) return resolve({ ok: false, error: "Missing url/domain or name" });
      let details = {
        url,
        name: c.name,
        value: c.value ?? "",
        path: c.path || "/",
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        sameSite: normalizeSameSite(c.sameSite),
        storeId: c.storeId,
      };
      if (typeof c.expirationDate === "number") {
        details.expirationDate = c.expirationDate; // seconds since epoch
      }
      // Preserve hostOnly: if hostOnly, DO NOT set domain (host-only cookie)
      if (!c.hostOnly && c.domain) details.domain = c.domain;
      // Preserve partitioned cookies when available
      if (c.partitionKey) details.partitionKey = c.partitionKey;

      const attempts = [];
      // Attempt 0: as-is
      attempts.push((base) => ({ ...base }));
      // Attempt 1: drop partitionKey and invalid sameSite
      attempts.push((base) => { const d = { ...base }; if (d.partitionKey) delete d.partitionKey; if (d.sameSite && !['no_restriction','lax','strict'].includes(d.sameSite)) delete d.sameSite; return d; });
      // Attempt 2: toggle domain vs hostOnly
      attempts.push((base) => { const d = { ...base }; if (d.domain) delete d.domain; else { try { d.domain = new URL(d.url).hostname; } catch(_){} } return d; });
      // Attempt 3: drop expiration to allow session cookie
      attempts.push((base) => { const d = { ...base }; if (d.expirationDate) delete d.expirationDate; return d; });
      // Attempt 4: normalize path to '/'
      attempts.push((base) => { const d = { ...base }; d.path = '/'; return d; });

      let idx = 0;
      const tryNext = () => {
        if (idx >= attempts.length) return resolve({ ok: false, error: lastError || 'All attempts failed' });
        const d = attempts[idx++](details);
        let lastError = '';
        chrome.cookies.set(d, (res) => {
          if (chrome.runtime.lastError) {
            lastError = chrome.runtime.lastError.message || '';
            return tryNext();
          }
          if (!res) return tryNext();
          resolve({ ok: true });
        });
      };
      tryNext();
    });

    (async () => {
      let ok = 0, fail = 0; const errors = [];
      for (const c of items) {
        // Avoid setting partitioned/unsupported fields silently
        const r = await setOne(c);
        if (r.ok) ok++; else { fail++; if (errors.length < 5) errors.push({ name: c.name, domain: c.domain, error: r.error }); }
      }
      respond({ ok: true, imported: ok, failed: fail, errors });
    })();
    return true;
  }

  if (msg.type === "DELETE_SITE_COOKIES") {
    try {
      const u = new URL(msg.url);
      const host = u.hostname;
      chrome.cookies.getAll({ domain: host }, (cookies) => {
        if (chrome.runtime.lastError) return respond({ ok: false, error: chrome.runtime.lastError.message });
        let ok = 0, fail = 0;
        const done = () => respond({ ok: true, deleted: ok, failed: fail });
        if (!cookies.length) return done();
        let pending = cookies.length;
        cookies.forEach((c) => {
          removeCookieAdvanced(c, (success) => {
            if (success) ok++; else fail++;
            if (--pending === 0) done();
          });
        });
      });
    } catch (e) {
      respond({ ok: false, error: String(e) });
    }
    return true;
  }

  if (msg.type === "DELETE_ALL_COOKIES") {
    try {
      // Try profile-wide removal via browsingData API
      chrome.browsingData.remove({}, { cookies: true }, () => {
        if (chrome.runtime.lastError) {
          // Fallback to manual removal if browsingData failed
          chrome.cookies.getAllCookieStores((stores) => {
            if (chrome.runtime.lastError) return respond({ ok: false, error: chrome.runtime.lastError.message });
            const storeIds = (stores || []).map(s => s.id);
            if (!storeIds.length) return respond({ ok: true, deleted: 0, failed: 0 });

            let allCookies = [];
            let spending = storeIds.length;
            storeIds.forEach((sid) => {
              chrome.cookies.getAll({ storeId: sid }, (cookies) => {
                if (!chrome.runtime.lastError && cookies) allCookies = allCookies.concat(cookies);
                if (--spending === 0) {
                  let ok = 0, fail = 0;
                  if (!allCookies.length) return respond({ ok: true, deleted: 0, failed: 0 });
                  let pending = allCookies.length;
                  allCookies.forEach((c) => {
                    removeCookieAdvanced(c, (success) => {
                      if (success) ok++; else fail++;
                      if (--pending === 0) respond({ ok: true, deleted: ok, failed: fail });
                    });
                  });
                }
              });
            });
          });
        } else {
          // browsingData doesn't return a count; report success with unknown counts
          respond({ ok: true, deleted: -1, failed: 0, note: 'Cleared via browsingData' });
        }
      });
    } catch (e) {
      respond({ ok: false, error: String(e) });
    }
    return true;
  }
});
