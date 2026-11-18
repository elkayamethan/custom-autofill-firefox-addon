'use strict';
// Injected only into pages on hosts that have enabled rules and that the user
// allowed. Reads only this exact origin's rules, fills matching empty fields,
// and never submits a form or logs anything.
(async () => {
  const origin = location.origin;
  const rules = ((await browser.storage.local.get(origin))[origin] || []).filter(rule => rule.enabled);
  if (!rules.length) return;

  for (const rule of rules) {
    rule.done = new WeakSet(); // elements this rule has already dealt with
    rule.re = rule.path && new RegExp('^' + rule.path.split('*')
      .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  }

  // <input> types that hold no fillable text.
  const SKIP = /^(hidden|file|checkbox|radio|submit|reset|button|image|range|color)$/;

  const fill = (el, rule) => {
    const tag = el.localName;
    if (tag === 'input' ? SKIP.test(el.type) : tag !== 'textarea' && tag !== 'select') {
      rule.done.add(el);
      return;
    }
    let value = rule.value;
    if (tag === 'select') {
      const options = [...el.options];
      const option = options.find(o => o.value === value) || options.find(o => o.text.trim() === value);
      if (!option) return; // its options may still be loading: retry on the next scan
      value = option.value;
    }
    rule.done.add(el); // the first sighting decides, so a field the user clears stays cleared
    const old = el.value;
    if (old === value || (old !== '' && !rule.overwrite)) return;
    el.value = value; // content scripts reach the native setter, so framework value trackers see a change
    if (el.value === '') { // the field rejected the value (e.g. letters in type=number)
      el.value = old;
      return;
    }
    el.dispatchEvent(tag === 'select'
      ? new Event('input', { bubbles: true, composed: true })
      : new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  // Catch fields that appear later. Once a batch of changes adds an element,
  // stop watching and re-check the whole page 100 ms later: text-only changes
  // never trigger a scan, and busy pages cost almost nothing in between.
  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === 1) {
          observer.disconnect();
          setTimeout(scan, 100);
          return;
        }
      }
    }
  });

  const scan = () => {
    // Watch again before filling, so fields a page adds in response to these
    // fills are caught by the next scan.
    observer.observe(document, { childList: true, subtree: true });
    const path = location.pathname; // re-checked on every scan: SPAs change it without reloading
    for (const rule of rules) {
      if (rule.re && !rule.re.test(path)) continue;
      let elements;
      try {
        elements = document.querySelectorAll(rule.selector);
      } catch {
        continue;
      }
      for (const el of elements) if (!rule.done.has(el)) fill(el, rule);
    }
  };

  scan();
})();
