// Naive cookie consent auto-acceptor. Tries common selectors/text patterns.
// Runs on every page at document_idle.
// Only interacts with visible elements that clearly indicate consent.

(function () {
  const SELECTORS = [
    // Common vendor buttons
    'button[aria-label*="accept" i]',
    'button[aria-label*="agree" i]',
    'button[aria-label*="consent" i]',
    'button[title*="accept" i]',
    'button[title*="agree" i]',
    'button[title*="consent" i]',
    'button:has-text("Accept")', // Not widely supported; fallback to text check below
    'button:has-text("I agree")',
    'button:has-text("Agree")',
    'button:has-text("Consent")',
    // Generic
    'button', 'a', '[role="button"]'
  ];

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function looksLikeConsent(el) {
    const t = (el.innerText || el.textContent || '').trim().toLowerCase();
    if (!t) return false;
    const ok = [
      'accept all', 'accept all cookies', 'i agree', 'agree', 'allow all', 'allow cookies', 'consent', 'got it'
    ];
    return ok.some(k => t.includes(k));
  }

  function clickOnce(el) {
    try {
      el.click();
      return true;
    } catch (_) {
      try {
        const evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
        el.dispatchEvent(evt);
        return true;
      } catch (_) { return false; }
    }
  }

  function tryAccept() {
    // Fast path: scan obvious candidates first
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'))
      .filter(visible)
      .filter(looksLikeConsent);
    for (const el of candidates) {
      if (clickOnce(el)) return true;
    }
    return false;
  }

  const attempt = () => {
    if (tryAccept()) return;
    // Observe brief time for dynamically injected banners
    const obs = new MutationObserver((muts, o) => {
      if (tryAccept()) { o.disconnect(); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 8000);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attempt, { once: true });
  } else {
    attempt();
  }
})();
