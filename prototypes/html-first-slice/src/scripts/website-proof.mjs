import { FEEDS, formatMonth, itemKey, parseFeedback, parseMetrics, proofFigures, proofMethod, proofPeriods, readFeed, retainFeedback } from '../lib/website-proof.mjs';
import { googleRatingLabel, parseGoogleRating } from '../lib/google-rating.mjs';

// The projection is never stored in a cookie, localStorage or a service worker.
// Existing nodes survive revalidation: only withdrawals are removed while reading.
export function startWebsiteProof({ root = document, runtime = window, fetcher = fetch } = {}) {
  const containers = [...root.querySelectorAll('[data-website-proof]')];
  const googleLinks = [...root.querySelectorAll('[data-google-rating]')];
  if (!containers.length && !googleLinks.length) return;
  const feeds = { ...FEEDS, ...(googleLinks.length ? { google: '/api/google-rating' } : {}) };
  const startedAt = Date.now(), monotonicStart = runtime.performance.now();
  let serverTime = 0, serverTick = 0;
  const now = () => Math.max(Date.now(), startedAt + runtime.performance.now() - monotonicStart, serverTime + runtime.performance.now() - serverTick);
  let suspended = root.visibilityState === 'hidden', disposed = false, generation = 0;
  const states = Object.fromEntries(Object.keys(feeds).map(feed => [feed, { values: [], initialised: false, expiry: 0, timer: null, controller: null }]));
  const element = (tag, text, className) => {
    const node = root.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  // "25 seconds" renders as a large number and a smaller unit, so the headline
  // figure stays on one line at phone widths. The text content is unchanged.
  const setValue = (node, value) => {
    const [, number, unit] = /^(\S+) (.+)$/.exec(value) ?? [, value, ''];
    node.replaceChildren(element('span', number, 'proof-num'), ...(unit ? [' ', element('span', unit, 'proof-unit')] : []));
  };
  function paint(feed) {
    const state = states[feed];
    if (feed === 'google') {
      const valid = !suspended && state.expiry > now() && state.values.length;
      for (const link of googleLinks) link.querySelector('[data-google-rating-label]').textContent = valid ? googleRatingLabel(state.values[0]) : 'Read our reviews';
      return;
    }
    for (const container of containers) {
      const section = container.querySelector(`[data-proof-${feed}]`);
      if (!section) continue;
      const fallback = container.querySelector('[data-proof-fallback]');
      const cards = section.querySelector(feed === 'metrics' ? '[data-proof-metric-cards]' : '[data-proof-feedback-cards]');
      const values = state.values;
      if (suspended || state.expiry <= now() || !values.length) {
        if (fallback) fallback.hidden = false;
        section.hidden = true;
        cards.replaceChildren();
        continue;
      }
      if (fallback) fallback.hidden = true;
      if (feed === 'metrics') {
        // One layout for the homepage panel and the full sections: the call wait
        // leads, then the call answer rate, the ticket time and any ticket rate.
        const figures = proofFigures(values), periods = proofPeriods(values), method = proofMethod(values);
        const signature = JSON.stringify([figures.map(figure => [figure.id, figure.label]), method, periods.length]);
        // Keep the disclosure node, its open state and keyboard focus on refresh
        // while the same figures, labels and definitions are showing.
        if (cards.dataset.proofSignature === signature && cards.firstElementChild) {
          for (const figure of figures) setValue(cards.querySelector(`[data-proof-figure="${figure.id}"] dd`), figure.value);
          cards.querySelectorAll('.proof-period').forEach((line, i) => { line.textContent = periods[i]; });
          section.hidden = false;
          continue;
        }
        const card = element('article');
        const list = element('dl', undefined, 'proof-figures');
        list.dataset.count = String(figures.length);
        for (const figure of figures) {
          const item = element('div', undefined, figure.lead ? 'proof-figure proof-lead' : 'proof-figure');
          item.dataset.proofFigure = figure.id; item.dataset.proofMetric = figure.key;
          const value = element('dd', undefined, figure.kind === 'time' ? 'proof-time' : 'proof-rate');
          setValue(value, figure.value);
          item.append(element('dt', figure.label), value);
          list.append(item);
        }
        card.append(list, ...periods.map(line => element('p', line, 'proof-period')));
        if (cards.dataset.proofCompact === 'true') card.append(element('p', 'Past results, not a promise.', 'proof-note'));
        const details = element('details', undefined, 'proof-method');
        details.append(element('summary', 'How we measure these figures'), ...method.map(text => element('p', text)));
        card.append(details);
        cards.dataset.proofSignature = signature;
        cards.replaceChildren(card);
      } else {
        const retained = new Set(state.values.map(itemKey));
        for (const card of [...cards.children]) if (!retained.has(card.dataset.proofKey)) card.remove();
        // Populate on the first render (or after a cleared suspended view) only.
        if (!cards.children.length) for (const item of state.values) {
          const card = element('blockquote');
          card.dataset.proofKey = itemKey(item);
          const footer = element('footer');
          footer.append(element('strong', item.first_name));
          if (item.rating !== null) footer.append(element('span', ` · ${item.rating}`));
          if (item.feedback_month !== null) { const time = element('time', ` · ${formatMonth(item.feedback_month)}`); time.dateTime = item.feedback_month; footer.append(time); }
          card.append(element('p', item.comment), footer);
          cards.append(card);
        }
      }
      section.hidden = false;
    }
  }
  function clear(feed) {
    const state = states[feed];
    state.values = []; state.expiry = 0;
    runtime.clearTimeout(state.timer); state.timer = null;
    paint(feed);
  }
  function expire(feed) {
    const state = states[feed];
    runtime.clearTimeout(state.timer);
    if (state.expiry <= now()) return clear(feed);
    state.timer = runtime.setTimeout(() => expire(feed), Math.min(state.expiry - now(), 60_000));
  }
  async function refresh(feed, force = false) {
    const state = states[feed];
    if (suspended || disposed || state.controller) return;
    // Google's provider defines a bounded observation lifetime. Reuse it until
    // expiry, while always revalidating when a reader returns to the page.
    if (feed === 'google' && !force && state.values.length && state.expiry > now()) return;
    if (state.expiry <= now()) clear(feed);
    const controller = new AbortController(), currentGeneration = generation;
    state.controller = controller;
    const timeout = runtime.setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetcher(feeds[feed], { signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
      const data = await readFeed(response);
      if (disposed || suspended || currentGeneration !== generation || controller.signal.aborted) return;
      const date = Date.parse(response.headers.get('x-proof-source-date') ?? ''), age = response.headers.get('age') ?? '0';
      if (Number.isFinite(date) && /^\d+$/.test(age)) { serverTime = Math.max(now(), date + Number(age) * 1000); serverTick = runtime.performance.now(); }
      if (feed === 'google') {
        state.values = parseGoogleRating(data, now());
        state.expiry = state.values[0]?.expiry ?? 0;
      } else if (feed === 'metrics') {
        state.values = parseMetrics(data, now());
        // The earliest expiry clears both figures; the next minute's check restores the fresh one.
        state.expiry = state.values.length ? Math.min(...state.values.map(metric => metric.expiry)) : 0;
      } else {
        const valid = parseFeedback(data, now());
        state.values = state.initialised ? retainFeedback(state.values, valid) : (valid?.items ?? []);
        state.expiry = valid?.expiry ?? 0;
      }
      // A failed/empty first attempt has shown the reader nothing yet. Allow a
      // later first selection, then retain only those cards for this visit.
      if (state.values.length) state.initialised = true;
      paint(feed); expire(feed);
    } catch {
      if (currentGeneration === generation && !disposed) clear(feed);
    } finally {
      runtime.clearTimeout(timeout);
      if (state.controller === controller) state.controller = null;
    }
  }
  const refreshAll = (force = false) => { for (const feed of Object.keys(feeds)) void refresh(feed, force); };
  function hide() {
    suspended = true; generation++;
    for (const feed of Object.keys(feeds)) { states[feed].controller?.abort(); states[feed].controller = null; paint(feed); }
  }
  function restore() {
    // Never reveal a pre-suspension snapshot before a new valid response.
    hide(); suspended = false; refreshAll(true);
  }
  const visibility = () => root.visibilityState === 'hidden' ? hide() : restore();
  const pagehide = event => { hide(); if (!event.persisted) dispose(); };
  const pageshow = event => { if (event.persisted) restore(); };
  const interval = runtime.setInterval(refreshAll, 60_000);
  root.addEventListener('visibilitychange', visibility);
  runtime.addEventListener('pagehide', pagehide);
  runtime.addEventListener('pageshow', pageshow);
  function dispose() {
    disposed = true; runtime.clearInterval(interval);
    for (const feed of Object.keys(feeds)) { states[feed].controller?.abort(); clear(feed); }
    root.removeEventListener('visibilitychange', visibility);
    runtime.removeEventListener('pagehide', pagehide);
    runtime.removeEventListener('pageshow', pageshow);
  }
  refreshAll();
  return { dispose };
}
