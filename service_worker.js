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

// دالة محسّنة لحذف الكوكيز مع دعم أفضل للـ partitioned cookies
function removeCookieAdvanced(c, cb) {
  const variants = [];
  // نجرب كل الاحتمالات الممكنة
  variants.push({ scheme: undefined, withPartition: true });
  variants.push({ scheme: undefined, withPartition: false });
  variants.push({ scheme: c.secure ? 'http' : 'https', withPartition: true });
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

async function getAllCookiesForDomain(domain) {
  return new Promise((resolve) => {
    const allCookies = [];
    const variations = [
      domain,                          // mail3.spectrum.net
      `.${domain}`,                    // .mail3.spectrum.net
      domain.replace(/^[^.]+\./, ''),  // spectrum.net
      `.${domain.replace(/^[^.]+\./, '')}` // .spectrum.net
    ];
    
    let pending = variations.length;
    variations.forEach(v => {
      chrome.cookies.getAll({ domain: v }, (cookies) => {
        if (!chrome.runtime.lastError && cookies) {
          // تجنب التكرار
          cookies.forEach(c => {
            const exists = allCookies.find(existing => 
              existing.name === c.name && 
              existing.domain === c.domain &&
              existing.path === c.path
            );
            if (!exists) allCookies.push(c);
          });
        }
        if (--pending === 0) resolve(allCookies);
      });
    });
  });
}

async function importCookieWithRetry(c) {
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

  const url = c.url || toUrl(c);
  if (!url || !c.name) return { ok: false, error: "Missing url/domain or name" };
  
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
    details.expirationDate = c.expirationDate;
  }
  
  if (!c.hostOnly && c.domain) details.domain = c.domain;
  if (c.partitionKey) details.partitionKey = c.partitionKey;

  // استراتيجيات متعددة للنجاح
  const strategies = [
    // Strategy 0: محاولة أصلية
    (base) => ({ ...base }),
    
    // Strategy 1: إصلاح SameSite للـ Secure cookies
    (base) => {
      const d = { ...base };
      if (d.secure && d.sameSite === 'no_restriction') {
        // SameSite=None يتطلب Secure=true
        return d;
      }
      if (d.secure && !d.sameSite) {
        d.sameSite = 'no_restriction';
      }
      return d;
    },
    
    // Strategy 2: حذف partitionKey
    (base) => {
      const d = { ...base };
      if (d.partitionKey) delete d.partitionKey;
      if (d.sameSite && !['no_restriction','lax','strict'].includes(d.sameSite)) {
        delete d.sameSite;
      }
      return d;
    },
    
    // Strategy 3: تبديل domain vs hostOnly
    (base) => {
      const d = { ...base };
      if (d.domain) {
        delete d.domain;
      } else {
        try { 
          const hostname = new URL(d.url).hostname;
          d.domain = hostname.startsWith('.') ? hostname : '.' + hostname;
        } catch(_){}
      }
      return d;
    },
    
    // Strategy 4: حذف expiration (session cookie)
    (base) => {
      const d = { ...base };
      if (d.expirationDate) delete d.expirationDate;
      return d;
    },
    
    // Strategy 5: تبسيط path
    (base) => {
      const d = { ...base };
      d.path = '/';
      return d;
    },
    
    // Strategy 6: تبديل secure flag
    (base) => {
      const d = { ...base };
      d.secure = !d.secure;
      d.url = d.url.replace(/^https?:/, d.secure ? 'https:' : 'http:');
      if (!d.secure && d.sameSite === 'no_restriction') {
        d.sameSite = 'lax';
      }
      return d;
    },
    
    // Strategy 7: إزالة كل الـ flags الاختيارية
    (base) => {
      const d = {
        url: base.url,
        name: base.name,
        value: base.value || '',
        path: '/'
      };
      return d;
    }
  ];

  for (let i = 0; i < strategies.length; i++) {
    const attempt = strategies[i](details);
    
    try {
      const result = await new Promise((resolve) => {
        chrome.cookies.set(attempt, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else if (!res) {
            resolve({ ok: false, error: 'No result returned' });
          } else {
            resolve({ ok: true, cookie: res });
          }
        });
      });
      
      if (result.ok) {
        console.log(`✅ Cookie set successfully: ${c.name} (strategy ${i})`);
        return result;
      } else {
        console.log(`❌ Strategy ${i} failed: ${result.error}`);
      }
    } catch (e) {
      console.log(`❌ Strategy ${i} exception:`, e);
    }
  }
  
  return { ok: false, error: 'All strategies failed' };
}

// ============================================
// Message Handlers
// ============================================
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const respond = (payload) => { try { sendResponse(payload); } catch (_) {} };

  // GET_COOKIES - محسّن للـ Spectrum
  if (msg.type === "GET_COOKIES") {
    (async () => {
      try {
        const u = new URL(msg.url);
        const host = u.hostname;
        
        // نجرب جلب الكوكيز بطرق متعددة
        const cookies = await getAllCookiesForDomain(host);
        
        console.log(`📊 Found ${cookies.length} cookies for ${host}`);
        respond({ ok: true, cookies });
      } catch (e) {
        respond({ ok: false, error: String(e) });
      }
    })();
    return true;
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
    (async () => {
      try {
        const u = new URL(msg.url);
        const host = u.hostname;
        const cookies = await getAllCookiesForDomain(host);
        respond({ ok: true, cookies });
      } catch (e) {
        respond({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "GET_EXACT_DOMAIN_COOKIES") {
    (async () => {
      try {
        const domain = (msg.domain || '').replace(/^\./, '');
        if (!domain) { 
          respond({ ok: false, error: 'Missing domain' }); 
          return;
        }
        const cookies = await getAllCookiesForDomain(domain);
        respond({ ok: true, cookies });
      } catch (e) {
        respond({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "GET_COOKIES_FOR_DOMAINS") {
    (async () => {
      try {
        const domains = Array.isArray(msg.domains) ? msg.domains : [];
        if (!domains.length) { 
          respond({ ok: false, error: 'No domains' }); 
          return;
        }
        
        let all = [];
        for (const d of domains) {
          const cookies = await getAllCookiesForDomain(d);
          all = all.concat(cookies);
        }
        
        // إزالة المكررات
        const unique = [];
        all.forEach(c => {
          const exists = unique.find(u => 
            u.name === c.name && 
            u.domain === c.domain && 
            u.path === c.path
          );
          if (!exists) unique.push(c);
        });
        
        respond({ ok: true, cookies: unique });
      } catch (e) {
        respond({ ok: false, error: String(e) });
      }
    })();
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
    (async () => {
      try {
        const domain = (msg.domain || '').replace(/^\./, '');
        if (!domain) {
          respond({ ok: false, error: 'Missing domain' });
          return;
        }
        
        const cookies = await getAllCookiesForDomain(domain);
        let ok = 0, fail = 0;
        
        for (const c of cookies) {
          const result = await new Promise((resolve) => {
            removeCookieAdvanced(c, (success) => resolve(success));
          });
          if (result) ok++; else fail++;
        }
        
        respond({ ok: true, deleted: ok, failed: fail, domain });
      } catch (e) {
        respond({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  // IMPORT_COOKIES - محسّن بشكل كبير
  if (msg.type === "IMPORT_COOKIES") {
    (async () => {
      try {
        const items = Array.isArray(msg.data) ? msg.data : (msg.data?.cookies || []);
        
        let ok = 0, fail = 0;
        const errors = [];
        
        for (const c of items) {
          const result = await importCookieWithRetry(c);
          if (result.ok) {
            ok++;
          } else {
            fail++;
            if (errors.length < 10) {
              errors.push({ 
                name: c.name, 
                domain: c.domain, 
                error: result.error 
              });
            }
          }
        }
        
        console.log(`✅ Import complete: ${ok} success, ${fail} failed`);
        respond({ ok: true, imported: ok, failed: fail, errors });
      } catch (e) {
        respond({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "DELETE_SITE_COOKIES") {
    (async () => {
      try {
        const u = new URL(msg.url);
        const cookies = await getAllCookiesForDomain(u.hostname);
        
        let ok = 0, fail = 0;
        for (const c of cookies) {
          const result = await new Promise((resolve) => {
            removeCookieAdvanced(c, (success) => resolve(success));
          });
          if (result) ok++; else fail++;
        }
        
        respond({ ok: true, deleted: ok, failed: fail });
      } catch (e) {
        respond({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "DELETE_ALL_COOKIES") {
    try {
      chrome.browsingData.remove({}, { cookies: true }, () => {
        if (chrome.runtime.lastError) {
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
          respond({ ok: true, deleted: -1, failed: 0, note: 'Cleared via browsingData' });
        }
      });
    } catch (e) {
      respond({ ok: false, error: String(e) });
    }
    return true;
  }
});
