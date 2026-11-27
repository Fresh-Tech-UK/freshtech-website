import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { metricsFixture, feedbackFixture, unavailableFeedback, FIXTURE_NOW, emptyMetric } from './fixtures/website-proof.mjs';
import { CALL_WORDING, RATE_BASIS, TICKET_DEFINITION_V2, TICKET_DEFINITION_V3, TICKET_WORDING, parseMetrics, proofMethod } from '../src/lib/website-proof.mjs';
import { BLOCKMARK_STUB, isBlockmarkBadge } from './lib/blockmark-stub.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if (!executablePath) throw new Error('Explicit browser executable required');
const project = resolve(import.meta.dirname, '..'), dist = resolve(project, process.env.PROOF_DIST || 'dist-production');
const evidence = resolve(project, '../../.artifacts/public-proof-browser');
await mkdir(evidence, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = resolve(dist, `.${path}`, extname(path) ? '' : 'index.html');
    if (!file.startsWith(dist + sep)) throw new Error('outside');
    const body = await readFile(file); res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath, chromiumSandbox: true, headless: true });
let assertions = 0; const failures = [], screenshots = [], layoutMeasurements = [];
const check = (value, label) => { assertions++; if (!value) failures.push(label); };
const settle = async page => { await page.waitForTimeout(120); };
const googleFixture = () => ({ schema_version: 1, status: 'available', rating: 4.6, review_count: 123, observed_at: '2026-09-22T11:00:00Z', expires_at: '2026-09-22T13:00:00Z' });
async function open({ route = '/', width = 390, height = 900, javaScriptEnabled = true, metrics = metricsFixture(), feedback = feedbackFixture(), google = googleFixture(), failure = null, slow = false, headers = {}, now = FIXTURE_NOW, blockFonts = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, javaScriptEnabled, reducedMotion: 'reduce' });
  const page = await context.newPage(), errors = [], requests = [];
  const state = { metrics, feedback, google, failure, slow, pending: [], calls: { metrics: 0, feedback: 0, google: 0 } };
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource|net::ERR_FAILED/.test(message.text())) errors.push(message.text()); });
  await page.clock.install({ time: now });
  await page.route('**/*', async interception => {
    const request = interception.request(), url = new URL(request.url()); requests.push({ url: request.url(), method: request.method(), headers: request.headers() });
    if (url.origin === origin && /^\/api\/(website-(metrics|feedback)|google-rating)$/.test(url.pathname)) {
      const feed = url.pathname.endsWith('metrics') ? 'metrics' : url.pathname.endsWith('feedback') ? 'feedback' : 'google'; state.calls[feed]++;
      if (state.slow) { state.pending.push({ interception, feed }); return; }
      if (state.failure === 'network') return interception.abort('failed');
      const body = state.failure === 'malformed' ? '{' : state.failure === 'oversized' ? ' '.repeat(8193) : JSON.stringify(state[feed]);
      return interception.fulfill({ status: typeof state.failure === 'number' ? state.failure : 200, contentType: 'application/json', headers: { 'Cache-Control': 'no-store', ...headers }, body });
    }
    if (url.origin === origin && blockFonts && url.pathname.startsWith('/fonts/')) return interception.abort('failed');
    if (url.origin === origin && request.method() === 'GET') return interception.continue();
    // The reviewed Cyber Essentials badge frame (CyberEssentialsBadge.astro); stubbed, never fetched.
    if (isBlockmarkBadge(url)) return interception.fulfill(BLOCKMARK_STUB);
    if (url.hostname === 'res.cloudinary.com') return interception.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="675" />' });
    errors.push(`Unexpected request: ${url.origin}${url.pathname}`); return interception.abort();
  });
  await page.goto(origin + route, { waitUntil: 'load' }); await settle(page);
  return { context, page, state, errors, requests };
}
try {
  // The panel leads with the call wait, then the call answer rate, the ticket time and the
  // ticket rate when the feed publishes one. v2 (first written reply) and v3 (first reply or
  // linked phone call) both render during the changeover, each in its own words. Today's
  // feed has no service_rate_basis: it means one business hour. The pair (basis, median)
  // brings a same-working-day rate or, with a null basis and rate, three figures.
  const withTicket = (definition_id = TICKET_DEFINITION_V2, extra = {}) => {
    const data = metricsFixture(); data.status = 'available';
    data.metrics.ticket_first_response = { ...data.metrics.call_wait, source: 'superops', value_seconds: 3957.1, service_rate_percent: 66.4, definition_id, ...extra };
    return data;
  };
  const ticketCases = [
    { name: 'v2-four', definition: TICKET_DEFINITION_V2, extra: {}, basis: 'one_business_hour' },
    { name: 'v3-four', definition: TICKET_DEFINITION_V3, extra: {}, basis: 'one_business_hour' },
    { name: 'v3-sameday', definition: TICKET_DEFINITION_V3, extra: { service_rate_basis: 'same_business_day', value_median_seconds: 1560 }, basis: 'same_business_day' },
    { name: 'v2-sameday', definition: TICKET_DEFINITION_V2, extra: { service_rate_basis: 'same_business_day', value_median_seconds: 1560 }, basis: 'same_business_day' },
    { name: 'v2-three', definition: TICKET_DEFINITION_V2, extra: { service_rate_basis: null, value_median_seconds: 1560, service_rate_percent: null }, basis: null },
    { name: 'v3-three', definition: TICKET_DEFINITION_V3, extra: { service_rate_basis: null, value_median_seconds: 1560, service_rate_percent: null }, basis: null },
  ];
  const figureLayout = locator => locator.evaluate(list => {
    const box = list.getBoundingClientRect(), items = [...list.children].map(el => ({ id: el.dataset.proofFigure, label: el.querySelector('dt').textContent,
      value: el.querySelector('dd').textContent, size: parseFloat(getComputedStyle(el.querySelector('dd .proof-num')).fontSize), rect: el.getBoundingClientRect() }));
    const rows = Object.values(items.reduce((acc, item) => { (acc[Math.round(item.rect.top)] ??= []).push(item.rect); return acc; }, {}));
    // No empty cell: every row reaches both edges of the grid.
    const filled = rows.every(row => Math.abs(Math.min(...row.map(r => r.left)) - box.left) < 2 && Math.abs(Math.max(...row.map(r => r.right)) - box.right) < 2);
    return { items: items.map(({ rect, ...item }) => item), filled, rows: rows.length };
  });
  for (const ticketCase of ticketCases) for (const route of ['/', '/pricing', '/why-trust-us', '/service-standards']) for (const width of [320, 390, 900, 1024, 1440]) {
    const { name, definition, extra, basis } = ticketCase, label = `${route} ${width} ${name}`;
    const { context, page, errors, state } = await open({ route, width, metrics: withTicket(definition, extra) });
    await page.locator('[data-proof-metrics]').first().waitFor({ state: 'visible' });
    const text = (await page.locator('[data-website-proof]').allInnerTexts()).join('\n');
    const layout = await figureLayout(page.locator('.proof-figures').first());
    // With a median the typical time (26 minutes) is the headline; without, today's average (66 minutes).
    const wording = TICKET_WORDING[definition], typical = 'value_median_seconds' in extra;
    const expected = [['call_time', CALL_WORDING.time, '25 seconds'], ['call_rate', CALL_WORDING.rate, '93.7%'],
      ['ticket_time', typical ? wording.typicalLabel : wording.averageLabel, typical ? '26 minutes' : '66 minutes'],
      ...(basis ? [['ticket_rate', RATE_BASIS[basis].label(wording), '66.4%']] : [])];
    check(JSON.stringify(layout.items.map(item => [item.id, item.label, item.value])) === JSON.stringify(expected), `${label}: figures, labels and values in order (${JSON.stringify(layout.items.map(item => item.label))})`);
    check(layout.items.slice(1).every(item => item.size < layout.items[0].size), `${label}: the call wait is the largest figure`);
    check(layout.filled, `${label}: ${expected.length} figures leave no empty cell (${layout.rows} rows)`);
    if (route === '/') check(await page.locator('[data-proof-metrics]').first().evaluate(el => el.getBoundingClientRect().height <= parseFloat(getComputedStyle(el).minBlockSize) + 0.5),
      `${label}: figures fit the reserved height (no layout shift)`);
    await page.locator('.proof-method summary').first().click();
    const method = await page.locator('.proof-method').first().innerText();
    check(proofMethod(parseMetrics(withTicket(definition, extra), FIXTURE_NOW), { closing: route === '/' }).every(part => method.includes(part)), `${label}: method text follows the definition and basis`);
    check(method.includes('Requests for something new, such as setting up a new starter or new equipment, are planned work and are not included.'), `${label}: says service requests are not in the email figures`);
    const metricsText = await page.locator('[data-proof-metrics]').first().innerText();
    check((metricsText.match(/every customer.s experience/g) ?? []).length === 1, `${label}: exactly one "every customer's experience" statement`);
    check(Object.entries(RATE_BASIS).every(([key, rate]) => key === basis || !method.includes(rate.method(wording))), `${label}: no other basis's method`);
    check(typical ? !/\baverage first|The average covers/i.test(method + text) : !/typical/i.test(method + text), `${label}: a median is never called an average`);
    check((await page.locator('.proof-period').first().innerText()).includes('25 August 2026 to 21 September 2026'), `${label}: reporting period kept`);
    check(!/resolution time|resolved in|eligible|by a person/i.test(text.replace(/not a guarantee, a resolution time/i, '')), `${label}: never called resolution time; no queue jargon in labels`);
    check(definition === TICKET_DEFINITION_V2 ? !/reply or (phone )?call|linked to the issue/.test(method + text) : !/written reply/.test(method + text), `${label}: no other definition's wording`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: no horizontal overflow`);
    if (route === '/' && (name === 'v2-four' || name === 'v3-four')) {
      // A changed definition on the next minute's refresh replaces the wording, never keeps the old text.
      const next = definition === TICKET_DEFINITION_V2 ? TICKET_DEFINITION_V3 : TICKET_DEFINITION_V2;
      state.metrics = withTicket(next); await page.clock.runFor(60000); await settle(page);
      const refreshed = await page.locator('[data-proof-metrics]').first().innerText();
      check(refreshed.includes(TICKET_WORDING[next].averageLabel) && !refreshed.includes(TICKET_WORDING[definition].averageLabel), `${label}: definition change on refresh swaps the wording`);
      state.metrics = withTicket(next, { service_rate_basis: null, value_median_seconds: 1800, service_rate_percent: null }); await page.clock.runFor(60000); await settle(page);
      check(await page.locator('.proof-figures').first().evaluate(el => el.dataset.count === '3' && !el.querySelector('[data-proof-figure="ticket_rate"]')), `${label}: rate withdrawn on refresh leaves three figures`);
    }
    check(errors.length === 0, `${label}: ticket render has no errors ${errors.join('; ')}`);
    if (route === '/pricing') { const file = resolve(evidence, `ticket-proof-pricing-${name}-${width}.png`); await page.locator('[data-proof-metrics]').first().screenshot({ path: file }); screenshots.push(file); }
    await context.close();
  }
  for (const route of ['/', '/pricing', '/why-trust-us', '/service-standards']) for (const width of [320, 1440]) {
    const { context, page, errors, requests } = await open({ route, width });
    await page.locator('[data-proof-feedback]').waitFor({ state: 'visible' });
    check(await page.locator('.proof-time').innerText() === '25 seconds', `${route} ${width}: upward rounding`);
    check((await page.locator('.proof-rate').innerText()).startsWith('93.7%'), `${route} ${width}: companion rate`);
    check((await page.locator('.proof-period').innerText()).includes('25 August 2026 to 21 September 2026'), `${route} ${width}: exclusive period`);
    check(await page.locator('[data-proof-feedback] blockquote').count() === 3, `${route} ${width}: static three cards`);
    check(await page.locator('[data-proof-feedback] img').count() === 0, `${route} ${width}: text only`);
    check((await page.locator('[data-proof-feedback]').innerText()).includes('<img src=x onerror=alert(1)>'), `${route} ${width}: faithful literal text`);
    check((await page.locator('[data-proof-feedback]').innerText()).includes('August 2026'), `${route} ${width}: actual feedback month`);
    check(!/5 stars|★|first human response/i.test((await page.locator('[data-website-proof]').allInnerTexts()).join('\n')), `${route} ${width}: no false rating or ticket definition`);
    check(await page.getByRole('region', { name: 'Selected customer feedback', exact: true }).count() === 1, `${route} ${width}: labelled region`);
    const contrast = await page.locator('main').evaluate(root => {
      const rgb = value => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const light = value => rgb(value).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
      return [...root.querySelectorAll('[data-website-proof] h2,[data-website-proof] h3,[data-website-proof] p,[data-website-proof] dt,[data-website-proof] dd,[data-website-proof] a,[data-website-proof] footer')].filter(el => el.getClientRects().length).every(el => {
        let surface = el;
        while (surface.parentElement && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
        const a = light(getComputedStyle(el).color), b = light(getComputedStyle(surface).backgroundColor);
        return (Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5;
      });
    });
    check(contrast, `${route} ${width}: proof text contrast at least 4.5:1`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${route} ${width}: no horizontal overflow`);
    await page.locator('.proof-next-step a').first().focus(); await page.keyboard.press('Tab');
    check(await page.evaluate(() => document.activeElement.getAttribute('href') === '/onboarding'), `${route} ${width}: keyboard next step`);
    check(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle !== 'none'), `${route} ${width}: visible focus`);
    check(requests.filter(r => /\/api\/website-/.test(r.url)).every(r => r.method === 'GET' && !r.headers.cookie && !r.headers.authorization), `${route} ${width}: anonymous fixed GETs`);
    check(errors.length === 0, `${route} ${width}: ${errors.join('; ')}`);
    const reject = page.getByRole('button', { name: 'Reject', exact: true });
    if (await reject.isVisible()) await reject.click();
    if (route === '/') {
      await page.locator('[data-website-proof]').first().scrollIntoViewIfNeeded();
      const name = `homepage-proof-${width}.png`; await page.screenshot({ path: resolve(evidence, name), fullPage: false }); screenshots.push(name);
      await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: Larger text no overflow`);
      check(await page.locator('[data-proof-feedback]').evaluate(el => el.scrollHeight <= el.clientHeight + 1), `${width}: Larger text not clipped`);
      if (width === 320) { await page.screenshot({ path: resolve(evidence, 'homepage-proof-larger-text.png'), fullPage: true }); screenshots.push('homepage-proof-larger-text.png'); }
    }
    await context.close();
  }
  const layoutCases = [320, 360, 390, 412, 768, 900, 1024, 1280, 1440].flatMap(width => [16, 630].map(waitSeconds => ({ width, waitSeconds })));
  layoutCases.push(...[320, 360, 390, 412, 768, 900, 1024, 1280, 1440].map(width => ({ width, waitSeconds: 630, blockFonts: true })));
  for (const { width, waitSeconds, blockFonts = false } of layoutCases) {
    const metrics = metricsFixture();
    metrics.metrics.call_wait.value_seconds = waitSeconds;
    metrics.metrics.call_wait.service_rate_percent = 100;
    let now = FIXTURE_NOW;
    if (blockFonts) {
      now = Date.parse('2026-10-27T12:00:00Z');
      Object.assign(metrics.metrics.call_wait, {
        observed_at: '2026-10-27T11:59:00Z', expires_at: '2026-10-27T12:29:00Z',
        period_start: '2026-09-28T23:00:00Z', period_end: '2026-10-27T00:00:00Z',
      });
    }
    const delayed = await open({ width, slow: true, metrics, now, blockFonts });
    const before = await delayed.page.locator('.home-hero .home-actions').boundingBox();
    const beforePhoto = await delayed.page.locator('.home-photo-panel').boundingBox();
    const beforeGuarantees = await delayed.page.locator('.home-guarantees').boundingBox();
    const beforeReviews = await delayed.page.locator('.home-reviews').boundingBox();
    for (const { interception, feed } of delayed.state.pending) await interception.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(delayed.state[feed]) });
    await delayed.page.locator('[data-proof-metrics]').waitFor({ state: 'visible' });
    const after = await delayed.page.locator('.home-hero .home-actions').boundingBox();
    const afterPhoto = await delayed.page.locator('.home-photo-panel').boundingBox();
    const afterGuarantees = await delayed.page.locator('.home-guarantees').boundingBox();
    const afterReviews = await delayed.page.locator('.home-reviews').boundingBox();
    layoutMeasurements.push({ width, waitSeconds, blockFonts, guaranteeShift: afterGuarantees.y - beforeGuarantees.y, reviewShift: afterReviews.y - beforeReviews.y, photoShift: afterPhoto.y - beforePhoto.y });
    if (blockFonts) {
      check(await delayed.page.evaluate(() => !document.fonts.check('16px "Home Archivo"')), `${width}: unavailable body font genuinely uses the fallback`);
      check((await delayed.page.locator('.proof-period').innerText()).includes('29 September 2026 to 26 October 2026'), `${width}: longer valid reporting period across the UK clock change`);
    }
    check(Math.abs(after.y - before.y) < 1 && Math.abs(after.height - before.height) < 1, `${width}: main contact action stays in place as proof loads`);
    check(Math.abs(afterPhoto.y - beforePhoto.y) < 1, `${width}: team photo stays in place as proof loads`);
    check(Math.abs(afterGuarantees.y - beforeGuarantees.y) < 1, `${width}/${waitSeconds}s: guarantees stay in place as proof loads (${afterGuarantees.y - beforeGuarantees.y}px)`);
    check(Math.abs(afterReviews.y - beforeReviews.y) < 1, `${width}/${waitSeconds}s: next section stays in place as proof loads (${afterReviews.y - beforeReviews.y}px)`);
    await delayed.context.close();
  }
  for (const failure of ['network', 429]) {
    const recovery = await open({ failure });
    recovery.state.failure = null;
    await recovery.page.clock.runFor(60_000); await settle(recovery.page);
    check(await recovery.page.locator('[data-proof-feedback] blockquote').count() === 3, `${failure}: first valid selection recovers after initial failure`);
    await recovery.context.close();
  }
  const serverExpiry = metricsFixture(); serverExpiry.metrics.call_wait.expires_at = '2026-09-22T12:00:03Z';
  for (const width of [320, 390, 1440]) {
    const run = await open({ width, height: 844 });
    const { page, state } = run;
    check(await page.locator('[data-google-rating-label]').innerText() === 'Rated 4.6/5 · 123 reviews', `${width}: verified Google aggregate`);
    check(await page.locator('[data-google-rating]').getAttribute('href') === 'https://search.google.com/local/reviews?placeid=ChIJ6a1VcjVqcEgR2_jkYe5Em5A', `${width}: attribution links to the correct public profile`);
    const geometry = await page.evaluate(() => Object.fromEntries(['.home-hero h1', '.home-hero .home-actions', '.proof-time', '.proof-rate', '.home-google-rating', '.home-hero', '.home-reviews'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return [s, { top: r.top, bottom: r.bottom, height: r.height }]; })));
    check(geometry['.proof-time'].bottom < 844 && geometry['.proof-rate'].bottom < 844, `${width}: both support values appear within a phone-height first screen`);
    check(geometry['.home-reviews'].top === geometry['.home-hero'].bottom, `${width}: client testimony immediately follows the hero`);
    const banner = await page.locator('[data-cookie-banner]').boundingBox();
    if (width === 390) { const fig = await page.locator('.proof-figures').boundingBox(); check(banner && fig.y + fig.height < banner.y, `390x844: first-visit cookie notice leaves both support values and qualifiers visible (${JSON.stringify([fig, banner])})`); }
    const summary = page.locator('.proof-method summary');
    await summary.focus(); await page.keyboard.press('Enter');
    check(await page.locator('.proof-method').getAttribute('open') !== null, `${width}: metric definition opens with keyboard`);
    check(await summary.evaluate(el => getComputedStyle(el).outlineStyle !== 'none'), `${width}: definition has visible keyboard focus`);
    state.google.review_count = 124;
    await page.clock.runFor(60000); await settle(page);
    check(state.calls.google === 1 && await page.locator('[data-google-rating-label]').innerText() === 'Rated 4.6/5 · 123 reviews', `${width}: fresh Google observation does not invoke the provider every minute`);
    check(await page.locator('.proof-method').getAttribute('open') !== null && await summary.evaluate(el => el === document.activeElement), `${width}: refresh preserves disclosure and focus`);
    state.google.expires_at = '2026-09-22T12:01:03Z';
    await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await settle(page);
    check(await page.locator('[data-google-rating-label]').innerText() === 'Rated 4.6/5 · 124 reviews', `${width}: returning to a page revalidates the Google count`);
    await page.clock.runFor(4000); await settle(page);
    check(await page.locator('[data-google-rating-label]').innerText() === 'Read our reviews', `${width}: Google expiry returns to a working review link`);
    await run.context.close();
  }
  const aged = await open({ metrics: serverExpiry, headers: { 'X-Proof-Source-Date': 'Tue, 22 Sep 2026 12:00:00 GMT', Date: 'Tue, 22 Sep 2026 12:00:04 GMT', Age: '4' } });
  check(await aged.page.locator('[data-proof-metrics]').isHidden(), 'source Date plus Age rejects expiry despite a slower visitor clock');
  await aged.context.close();
  serverExpiry.metrics.call_wait.expires_at = '2026-09-22T12:00:06Z';
  const regenerated = await open({ metrics: serverExpiry, headers: { 'X-Proof-Source-Date': 'Tue, 22 Sep 2026 12:00:00 GMT', Date: 'Tue, 22 Sep 2026 12:00:04 GMT', Age: '4' } });
  check(await regenerated.page.locator('[data-proof-metrics]').isVisible(), 'regenerated Apache Date does not double-count cached age');
  await regenerated.context.close();
  const withdrawal = await open();
  const { page, state } = withdrawal;
  await page.locator('[data-proof-feedback] blockquote').first().evaluate(el => { el.dataset.survivor = 'yes'; });
  state.feedback.items = [state.feedback.items[2], state.feedback.items[0], { first_name: 'NewTest', comment: 'Synthetic replacement must wait for a new visit.', rating: null, feedback_month: null }];
  await page.clock.runFor(60000); await settle(page);
  check(await page.locator('[data-proof-feedback] blockquote').count() === 2, 'withdrawn card removed within 60s');
  check(await page.locator('[data-proof-feedback] blockquote').first().getAttribute('data-survivor') === 'yes', 'existing nodes and order preserved');
  check(!(await page.locator('[data-proof-feedback]').innerText()).includes('NewTest'), 'replacement not inserted while reading');
  state.failure = 'network'; await page.clock.runFor(60000); await settle(page);
  check(await page.locator('[data-proof-feedback]').isHidden() && await page.locator('[data-proof-metrics]').isHidden(), 'revalidation error clears both feeds');
  await withdrawal.context.close();
  const expiring = metricsFixture(), expiringFeedback = feedbackFixture();
  expiring.metrics.call_wait.expires_at = '2026-09-22T12:00:03Z'; expiringFeedback.expires_at = '2026-09-22T12:00:03Z';
  const expiry = await open({ metrics: expiring, feedback: expiringFeedback });
  check(await expiry.page.locator('[data-proof-metrics]').isVisible(), 'short expiry initially visible');
  await expiry.page.clock.runFor(4000); await settle(expiry.page);
  check(await expiry.page.locator('[data-proof-metrics]').isHidden() && await expiry.page.locator('[data-proof-feedback]').isHidden(), 'open page clears at expiry before next polling');
  await expiry.context.close();
  const restore = await open();
  await restore.page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  check(await restore.page.locator('[data-proof-feedback]').isHidden(), 'hide on suspension');
  restore.state.slow = true;
  await restore.page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  check(await restore.page.locator('[data-proof-feedback]').isHidden(), 'restoration never reveals cached cards before validation');
  await restore.page.clock.runFor(3100); await settle(restore.page);
  check(await restore.page.locator('[data-proof-feedback]').isHidden(), 'slow restored response clears');
  await restore.context.close();
  for (const failure of [404, 429, 'malformed', 'oversized', 'network']) {
    const run = await open({ failure });
    check(await run.page.locator('[data-proof-metrics]').isHidden() && await run.page.locator('[data-proof-feedback]').isHidden(), `${failure}: empty proof`);
    check(await run.page.locator('.proof-next-step a').first().isVisible(), `${failure}: enquiry usable`); await run.context.close();
  }
  const empty = metricsFixture(); empty.status = 'unavailable'; empty.metrics.call_wait = emptyMetric('yeastar');
  for (const javaScriptEnabled of [true, false]) {
    const run = await open({ metrics: empty, feedback: unavailableFeedback(), javaScriptEnabled });
    check(await run.page.locator('[data-proof-metrics]').isHidden() && await run.page.locator('[data-proof-feedback]').isHidden(), `unavailable/no-JS ${javaScriptEnabled}: no cards or placeholders`);
    await run.page.locator('.proof-next-step a').first().click();
    check(new URL(run.page.url()).pathname === '/contact', `unavailable/no-JS ${javaScriptEnabled}: contact navigation`); await run.context.close();
  }
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await writeFile(resolve(evidence, 'report.json'), JSON.stringify({ assertions, failures, screenshots, layoutMeasurements, output: dist }, null, 2));
}
assert.deepEqual(failures, [], failures.join('\n'));
console.log(`${assertions} public-proof browser assertions passed; ${screenshots.length} screenshots`);
