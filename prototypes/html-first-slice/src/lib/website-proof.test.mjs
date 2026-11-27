import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMetrics, parseFeedback, formatTime, formatTicketTime, formatRate, TICKET_DEFINITION_V2, TICKET_DEFINITION_V3, TICKET_WORDING, RATE_BASIS, CALL_WORDING, TICKET_SCOPE, TICKET_EXCLUDED, METHOD_PERIOD, METHOD_PRIORITY, proofFigures, proofMethod, proofPeriods, formatPeriod, formatMonth, retainFeedback, readFeed, utc } from './website-proof.mjs';
import { metricsFixture, feedbackFixture, FIXTURE_NOW, emptyMetric } from '../../scripts/fixtures/website-proof.mjs';
test('reviewed support queue mean and rate travel together, with exclusive UK dates', () => {
  const result = parseMetrics(metricsFixture(), FIXTURE_NOW);
  assert.equal(result.length, 1); assert.equal(formatTime(result[0].value_seconds), '25 seconds');
  assert.equal(formatRate(result[0].service_rate_percent), '93.7%');
  assert.equal(formatPeriod(result[0]), '25 August 2026 to 21 September 2026');
});
test('available ticket stays hidden until its definition is reviewed', () => {
  const data = metricsFixture(); data.status = 'available';
  data.metrics.ticket_first_response = { ...data.metrics.call_wait, source: 'superops', definition_id: 'unapproved.future.ticket' };
  assert.deepEqual(parseMetrics(data, FIXTURE_NOW).map(value => value.key), ['call_wait']);
});
test('approved ticket first reply travels with its rate, after calls, and alone', () => {
  const data = metricsFixture(); data.status = 'available';
  data.metrics.ticket_first_response = { ...data.metrics.call_wait, source: 'superops', definition_id: TICKET_DEFINITION_V2, value_seconds: 3357.1, service_rate_percent: 66.4 };
  const result = parseMetrics(data, FIXTURE_NOW);
  assert.deepEqual(result.map(value => value.key), ['call_wait', 'ticket_first_response']);
  assert.equal(formatTicketTime(result[1].value_seconds), '56 minutes'); assert.equal(formatRate(result[1].service_rate_percent), '66.4%');
  data.metrics.call_wait.definition_id = 'future.v2';
  assert.deepEqual(parseMetrics(data, FIXTURE_NOW).map(value => value.key), ['ticket_first_response']);
  for (const [input, expected] of [[30, '30 seconds'], [60, '1 minute'], [60.5, '2 minutes'], [5400, '90 minutes'], [3960, '66 minutes'], [3959.01, '66 minutes'], [7199, '120 minutes'], [7200, '2 hours'], [9000, '2.5 hours'], [9001, '2.6 hours']]) assert.equal(formatTicketTime(input), expected);
});
test('v2 and v3 ticket definitions both pass during the changeover; retired and unknown ids hide', () => {
  const data = metricsFixture(); data.status = 'available';
  data.metrics.ticket_first_response = { ...data.metrics.call_wait, source: 'superops', value_seconds: 3357.1, service_rate_percent: 66.4 };
  for (const id of [TICKET_DEFINITION_V2, TICKET_DEFINITION_V3]) {
    data.metrics.ticket_first_response.definition_id = id;
    const result = parseMetrics(data, FIXTURE_NOW);
    assert.deepEqual(result.map(value => value.key), ['call_wait', 'ticket_first_response']);
    assert.equal(result[1].definition_id, id); assert.ok(TICKET_WORDING[id]);
    assert.deepEqual(parseMetrics(data, Date.parse('2026-09-22T12:29:00Z')), [], 'expired figure hides under either definition');
  }
  for (const id of ['superops.first_tech_reply.email_portal.business_hours.28_complete_days.v1', `${TICKET_DEFINITION_V3}.draft`, TICKET_DEFINITION_V3.toUpperCase(), null]) {
    data.metrics.ticket_first_response.definition_id = id;
    assert.deepEqual(parseMetrics(data, FIXTURE_NOW).map(value => value.key), ['call_wait']);
  }
  data.metrics.ticket_first_response.definition_id = TICKET_DEFINITION_V3; data.metrics.ticket_first_response.status = 'stale'; data.status = 'partial';
  assert.deepEqual(parseMetrics(data, FIXTURE_NOW).map(value => value.key), ['call_wait'], 'stale v3 hides');
});
const withTicket = (definition_id = TICKET_DEFINITION_V2, extra = {}) => {
  const data = metricsFixture(); data.status = 'available';
  data.metrics.ticket_first_response = { ...data.metrics.call_wait, source: 'superops', value_seconds: 3957.1, service_rate_percent: 66.4, definition_id, ...extra };
  return data;
};
const shown = data => proofFigures(parseMetrics(data, FIXTURE_NOW)).map(figure => [figure.label, figure.value]);
// The live feed today: v2, nine keys, no median. Pinned in full so the changeover
// cannot alter what it shows: the same four figures, average wording, hour rate.
test("live v2 nine-key feed: figures and wording pinned", () => {
  const values = parseMetrics(withTicket(), FIXTURE_NOW);
  assert.deepEqual(proofFigures(values).map(({ id, label, value, kind, lead }) => [id, label, value, kind, lead ?? false]), [
    ['call_time', 'Average wait before we answer a support call', '25 seconds', 'time', true],
    ['call_rate', 'Support calls answered by our team', '93.7%', 'rate', false],
    ['ticket_time', 'Average first reply to a support email, in business hours', '66 minutes', 'time', false],
    ['ticket_rate', 'Support emails answered within one business hour', '66.4%', 'rate', false]]);
  assert.deepEqual(proofMethod(values), [
    'Average wait is measured from joining our support phone queue to one of our team answering, among answered calls only. The answer rate is answered calls out of every call to the support queue, including missed and abandoned calls. Answered means a member of our team picked up; calls that reached voicemail or our out-of-hours assistant are not counted as answered.',
    'Email figures cover support issues our clients raised by email or our web form, counted in business hours (Monday to Friday, 9am to 5:30pm UK time, excluding bank holidays). The time shown is from the issue arriving to the first written reply from a technician. The average covers issues that got a first reply.',
    'The email figures cover reported problems, where something is not working. Requests for something new, such as setting up a new starter or new equipment, are planned work and are not included. Our own internal tickets and automated system notices (for example, a website reporting its own plugin updates) are not counted, because nobody is waiting on a reply. Billing and sales emails are not counted either.',
    'Unanswered issues count against the one-hour figure.',
    'We work on requests in order of urgency and impact, not simply the order they arrive. Something stopping a whole team from working is picked up ahead of a routine request, so a routine request can wait a little longer.',
    'Each figure covers the last 28 complete days, shown as the reporting period above.',
    'These figures are not a time to fix a problem or every customer’s experience.']);
  assert.deepEqual(proofPeriods(values), ['Reporting period: 25 August 2026 to 21 September 2026 (UK dates).']);
  // Full sections carry their own closing line, so their method leaves this one out.
  assert.deepEqual(proofMethod(values, { closing: false }), proofMethod(values).slice(0, -1));
});
test('v3 nine-key feed keeps the average wording with its own definition', () => {
  const values = parseMetrics(withTicket(TICKET_DEFINITION_V3), FIXTURE_NOW);
  assert.deepEqual(shown(withTicket(TICKET_DEFINITION_V3)).slice(2), [['Average first reply or call on a support email, in business hours', '66 minutes'], ['Support emails answered within one business hour', '66.4%']]);
  // Service requests were never in the figure (Incident tickets only); both definitions say so.
  assert.equal(proofMethod(values)[2], TICKET_EXCLUDED); assert.match(TICKET_EXCLUDED, /^The email figures cover reported problems, where something is not working\. Requests for something new, such as setting up a new starter or new equipment, are planned work and are not included\. /);
  assert.match(proofMethod(values)[1], /The time shown is from the issue arriving to our first reply or phone call to the client\. A phone call with the client that is linked to the ticket counts as the first response; voicemails, unanswered calls and automatic replies do not\. The average covers issues that got a first reply or call\./);
});
test('with a median the typical time is the headline, never called an average', () => {
  for (const [definition, label, rateLabel, response] of [
    [TICKET_DEFINITION_V3, 'Typical first reply or call on a support email, in business hours', 'Support emails that got a first reply or call the same working day', 'first reply or call'],
    [TICKET_DEFINITION_V2, 'Typical first reply to a support email, in business hours', 'Support emails that got a first reply the same working day', 'first reply']]) {
    const data = withTicket(definition, { service_rate_basis: 'same_business_day', value_median_seconds: 1560, service_rate_percent: 88 });
    const values = parseMetrics(data, FIXTURE_NOW);
    assert.deepEqual(shown(data).slice(2), [[label, '26 minutes'], [rateLabel, '88%']]);
    const method = proofMethod(values).join('\n');
    assert.ok(method.includes(`Typical means the median: of the issues that got a ${response}, half got it within this time.`));
    assert.ok(method.includes(`An issue raised during business hours counts if it got a ${response} by 5:30pm that working day; one raised outside business hours counts if it got one by 5:30pm on the next working day. Unanswered issues count against this figure.`));
    assert.doesNotMatch(method + proofFigures(values).map(figure => figure.label).join('\n'), /average first|The average covers|one-hour figure/i);
  }
  const none = parseMetrics(withTicket(TICKET_DEFINITION_V3, { service_rate_basis: null, value_median_seconds: 1560, service_rate_percent: null }), FIXTURE_NOW);
  assert.deepEqual(proofFigures(none).map(figure => [figure.label, figure.value]).slice(2), [['Typical first reply or call on a support email, in business hours', '26 minutes']]);
});
const NONE = { service_rate_basis: null, value_median_seconds: 1800, service_rate_percent: null };
test('no rate (basis null, rate null, median present) shows three figures under v2 and v3', () => {
  for (const definition of [TICKET_DEFINITION_V2, TICKET_DEFINITION_V3]) {
    const values = parseMetrics(withTicket(definition, NONE), FIXTURE_NOW);
    assert.deepEqual(proofFigures(values).map(figure => figure.id), ['call_time', 'call_rate', 'ticket_time']);
    assert.ok(!Object.hasOwn(values[1], 'value_median_seconds') && !Object.hasOwn(values[1], 'service_rate_basis'));
    assert.ok(!proofMethod(values).some(text => Object.values(RATE_BASIS).some(basis => basis.method(TICKET_WORDING[definition]) === text)));
  }
});
test('invalid ticket values hide only the ticket figure; calls stay', () => {
  for (const extra of [
    { service_rate_percent: null }, // today's shape needs a rate
    { service_rate_basis: 'same_business_day', value_median_seconds: 1800, service_rate_percent: null }, // null rate with a basis
    { service_rate_basis: null, value_median_seconds: 1800 }, // null basis with a rate
    { service_rate_basis: 'one_business_hour', value_median_seconds: 1800 }, // expressed by absence only
    { service_rate_basis: 'within_a_week', value_median_seconds: 1800 }, { service_rate_basis: 1, value_median_seconds: 1800 },
    { service_rate_basis: 'same_business_day', value_median_seconds: null }, // basis without a median
    { service_rate_basis: 'same_business_day', value_median_seconds: '1800' }, { ...NONE, value_median_seconds: -1 },
    { service_rate_percent: 101 }, { service_rate_basis: 'same_business_day', value_median_seconds: 1800, service_rate_percent: 101 },
  ]) assert.deepEqual(parseMetrics(withTicket(TICKET_DEFINITION_V3, extra), FIXTURE_NOW).map(value => value.key), ['call_wait'], JSON.stringify(extra));
});
test('malformed key sets fail the feed closed, as before', () => {
  for (const mutate of [data => { data.metrics.ticket_first_response.service_rate_basis = 'same_business_day'; }, // one key of the pair
    data => { data.metrics.ticket_first_response.value_median_seconds = 1800; },
    data => { Object.assign(data.metrics.ticket_first_response, { service_rate_basis: null, value_median_seconds: 1800, surprise: true }); },
    data => { data.metrics.call_wait.value_median_seconds = 10; }, // the pair is ticket-only
    data => { Object.assign(data.metrics.call_wait, { service_rate_basis: null, value_median_seconds: 10 }); }]) {
    const data = withTicket(TICKET_DEFINITION_V3); mutate(data); assert.deepEqual(parseMetrics(data, FIXTURE_NOW), []);
  }
});
test('an unavailable or stale ticket may carry the pair as nulls', () => {
  for (const status of ['unavailable', 'stale']) {
    const data = metricsFixture(); data.metrics.ticket_first_response = { ...emptyMetric('superops'), status, service_rate_basis: null, value_median_seconds: null };
    assert.deepEqual(parseMetrics(data, FIXTURE_NOW).map(value => value.key), ['call_wait']);
  }
});
test('value_median_seconds becomes the typical time and is not passed on raw', () => {
  const values = parseMetrics(withTicket(TICKET_DEFINITION_V3, { service_rate_basis: 'same_business_day', value_median_seconds: 600 }), FIXTURE_NOW);
  assert.ok(!Object.hasOwn(values[1], 'value_median_seconds')); assert.equal(values[1].typical_seconds, 600);
  assert.deepEqual(proofFigures(values).map(figure => figure.value), ['25 seconds', '93.7%', '10 minutes', '66.4%']);
});
test('figures follow what is available: calls alone, tickets alone', () => {
  assert.deepEqual(proofFigures(parseMetrics(metricsFixture(), FIXTURE_NOW)).map(figure => figure.id), ['call_time', 'call_rate']);
  const data = withTicket(TICKET_DEFINITION_V3); data.metrics.call_wait.definition_id = 'future.v2';
  assert.deepEqual(proofFigures(parseMetrics(data, FIXTURE_NOW)).map(figure => figure.id), ['ticket_time', 'ticket_rate']);
});
test('one period line when both figures share their days, labelled lines otherwise', () => {
  assert.deepEqual(proofPeriods(parseMetrics(withTicket(), FIXTURE_NOW)), ['Reporting period: 25 August 2026 to 21 September 2026 (UK dates).']);
  const values = parseMetrics(withTicket(), FIXTURE_NOW); values[1] = { ...values[1], period_start: '2026-08-23T23:00:00Z' };
  assert.deepEqual(proofPeriods(values), ['Calls: 25 August 2026 to 21 September 2026 (UK dates).', 'Emails: 24 August 2026 to 21 September 2026 (UK dates).']);
});
test('wording: plain, truthful, no em dashes or resolution claims', () => {
  assert.equal(CALL_WORDING.time, 'Average wait before we answer a support call'); assert.equal(CALL_WORDING.rate, 'Support calls answered by our team');
  assert.match(CALL_WORDING.method, /Answered means a member of our team picked up; calls that reached voicemail or our out-of-hours assistant are not counted as answered\./);
  const texts = [CALL_WORDING.time, CALL_WORDING.rate, CALL_WORDING.method, TICKET_SCOPE, TICKET_EXCLUDED, METHOD_PERIOD, METHOD_PRIORITY,
    ...Object.values(TICKET_WORDING).flatMap(wording => [wording.averageLabel, wording.typicalLabel, wording.sameDayLabel, wording.counts,
      ...Object.values(RATE_BASIS).flatMap(basis => [basis.label(wording), basis.method(wording)])])];
  for (const text of texts) assert.doesNotMatch(text, /—|resolution|resolved|guarantee|eligible|by a person/i);
  for (const wording of Object.values(TICKET_WORDING)) { assert.doesNotMatch(wording.typicalLabel, /average/i); assert.match(wording.averageLabel, /^Average /); }
  assert.doesNotMatch(TICKET_WORDING[TICKET_DEFINITION_V3].counts, /written reply/);
});
for (const value of [null, -1, Infinity, '12', true]) test(`invalid timing ${String(value)} hides`, () => {
  const data = metricsFixture(); data.metrics.call_wait.value_seconds = value; assert.deepEqual(parseMetrics(data, FIXTURE_NOW), []);
});
for (const value of [null, -1, 100.01, Infinity, '99', true]) test(`invalid percentage ${String(value)} hides timing too`, () => {
  const data = metricsFixture(); data.metrics.call_wait.service_rate_percent = value; assert.deepEqual(parseMetrics(data, FIXTURE_NOW), []);
});
test('zero is genuine; positive fractions round up and rates never inflate', () => {
  for (const [input, expected] of [[0, '0 seconds'], [.001, '1 second'], [59.9, '60 seconds'], [60, '1 minute'], [60.01, '1.1 minutes'], [3601, '1.1 hours']]) assert.equal(formatTime(input), expected);
  assert.equal(formatRate(99.999), '99.9%'); assert.equal(formatRate(0), '0%'); assert.equal(formatRate(100), '100%');
  const data = metricsFixture(); data.metrics.call_wait.value_seconds = 0; data.metrics.call_wait.service_rate_percent = 0;
  assert.equal(parseMetrics(data, FIXTURE_NOW).length, 1);
});
test('unknown version/fields/definition and inconsistent status fail closed', () => {
  for (const mutate of [data => data.schema_version = 3, data => data.private = 'not public', data => data.status = 'available', data => data.metrics.call_wait.definition_id = 'future.v2', data => data.metrics.call_wait.count = 100]) {
    const data = metricsFixture(); mutate(data); assert.deepEqual(parseMetrics(data, FIXTURE_NOW), []);
  }
});
test('unavailable, stale, expired, future and invalid dates hide', () => {
  for (const mutate of [data => { data.status = 'unavailable'; data.metrics.call_wait = emptyMetric('yeastar'); },
    data => { data.status = 'unavailable'; data.metrics.call_wait.status = 'stale'; }, data => data.metrics.call_wait.expires_at = '2026-09-22T12:00:00Z',
    data => data.metrics.call_wait.observed_at = '2026-09-22T12:00:01Z', data => data.metrics.call_wait.expires_at = '2026-09-24T13:59:01Z',
    data => data.metrics.call_wait.period_start = '2026-02-30T00:00:00Z', data => data.metrics.call_wait.period_end = '2026-09-21T22:00:00Z']) {
    const data = metricsFixture(); mutate(data); assert.deepEqual(parseMetrics(data, FIXTURE_NOW), []);
  }
  assert.ok(Number.isNaN(utc('2026-02-30T00:00:00Z')));
});
test('28 London calendar days spanning daylight saving', () => {
  const data = metricsFixture(); Object.assign(data.metrics.call_wait, { period_start: '2026-03-08T00:00:00Z', period_end: '2026-04-04T23:00:00Z', observed_at: '2026-04-05T08:00:00Z', expires_at: '2026-04-05T08:30:00Z' });
  assert.equal(parseMetrics(data, Date.parse('2026-04-05T08:01:00Z')).length, 1);
});
test('feedback preserves original wording, month and optional rating', () => {
  const data = feedbackFixture(), parsed = parseFeedback(data, FIXTURE_NOW);
  assert.deepEqual(parsed.items, data.items); assert.equal(formatMonth(parsed.items[0].feedback_month), 'August 2026');
});
test('feedback rejects bad shape/private fields, invalid dates/version/expiry', () => {
  for (const mutate of [data => data.schema_version = 2, data => data.items[0].surname = 'Private', data => data.items[0].rating = 5,
    data => data.items[0].comment = '', data => data.items[0].feedback_month = '2026-13', data => data.items.push(data.items[0]),
    data => data.expires_at = '2026-09-22T12:00:00Z', data => data.expires_at = '2026-09-25T00:00:01Z', data => data.selected_on = '2026-09-23',
    data => data.status = 'stale', data => data.status = 'unavailable']) {
    const data = feedbackFixture(); mutate(data); assert.equal(parseFeedback(data, FIXTURE_NOW), null);
  }
});
test('withdrawals remove without replacing, changing or reordering cards', () => {
  const old = feedbackFixture().items;
  assert.deepEqual(retainFeedback(old, { items: [{ ...old[0], comment: 'Changed wording requires new visit' }, old[2], old[1]] }), [old[1], old[2]]);
  assert.deepEqual(retainFeedback(old, null), []);
});
test('reader rejects errors, HTML, malformed JSON and bodies over 8192 bytes', async () => {
  const json = value => new Response(value, { headers: { 'Content-Type': 'application/json' } });
  assert.deepEqual(await readFeed(json(JSON.stringify(metricsFixture()))), metricsFixture());
  for (const response of [new Response('{}', { status: 404 }), new Response('{}', { status: 429 }), new Response('<html>'), json('{'), json(' '.repeat(8193)), new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '8193' } })]) await assert.rejects(readFeed(response));
});
