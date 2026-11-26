// Public projections only. A new definition needs a label/semantics review here
// and in server/api/website-proof.php before it can be displayed.
export const CALL_DEFINITION = 'yeastar.inbound_human_queue.28_complete_days.v1';
// v2 approved by Sam on 9 October 2026: first written reply only.
export const TICKET_DEFINITION_V2 = 'superops.first_tech_reply.client_incidents.business_hours.28_complete_days.v2';
// v3 decided by Sam on 26 November 2026: first written reply or linked phone call.
// Both are accepted during the changeover so the reporting system and the site can
// deploy in either order. Remove v2 once the nightly feed carries v3.
export const TICKET_DEFINITION_V3 = 'superops.first_contact_reply_or_linked_call.client_incidents.business_hours.28_complete_days.v3';
const HOURS = 'counted in business hours (Mon–Fri 09:00–17:30 UK, excluding bank holidays)';
const EXCLUDED = 'Automated notifications, billing and sales emails are excluded.';
// Each reviewed ticket definition carries its own public wording, so a figure is
// never described by another definition's text.
export const TICKET_WORDING = {
  [TICKET_DEFINITION_V2]: {
    label: 'Average first reply to a support email, in business hours',
    method: `First reply covers support issues our clients raised by email or our portal: the time to the first written reply from a technician, ${HOURS}. ${EXCLUDED}`,
  },
  [TICKET_DEFINITION_V3]: {
    label: 'Average first reply or call on a support email, in business hours',
    method: `First reply or call covers support issues our clients raised by email or our portal over the last 28 complete days: the time to our first reply or phone call to the client, ${HOURS}. A call counts once it is linked to the issue; automatic replies, missed calls and voicemails do not count. ${EXCLUDED}`,
  },
};
// The ticket rate's meaning travels in `service_rate_basis`. A feed without the
// pair is today's one-business-hour rate; a null basis (with a null rate) publishes none.
export const RATE_BASIS = {
  one_business_hour: {
    label: 'Support emails answered within one business hour',
    method: 'Unanswered issues count against the one-hour figure.',
  },
  same_business_day: {
    label: 'Support emails answered the same working day',
    method: 'Answered the same working day means an issue raised in business hours was answered by close of business (17:30 UK) that day, and one raised outside business hours by close of the next business day. Bank holidays are excluded.',
  },
};
export const CALL_WORDING = {
  time: 'Average wait before we answer a support call',
  rate: 'Support calls answered by our team',
  method: 'Average wait is measured from joining our support phone queue to one of our team answering, among answered calls only. The answer rate is answered calls out of every call to the support queue, including missed and abandoned calls. Answered means a member of our team picked up; calls that reached voicemail or our out-of-hours assistant are not counted as answered.',
};
export const METHOD_CLOSING = 'These figures are not a time to fix a problem or every customer’s experience.';
const DEFINITIONS = { call_wait: [CALL_DEFINITION], ticket_first_response: Object.keys(TICKET_WORDING) };
export const FEEDS = { metrics: '/api/website-metrics', feedback: '/api/website-feedback' };
export const MAX_BYTES = 8192;
const metricFields = ['status', 'source', 'value_seconds', 'service_rate_percent', 'definition_id', 'observed_at', 'expires_at', 'period_start', 'period_end'];
const itemFields = ['first_name', 'comment', 'rating', 'feedback_month'];
export function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function utc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19) ? parsed : NaN;
}
// The ticket metric may carry exactly one extra pair, service_rate_basis with
// value_median_seconds, and only together. Calls stay at exactly the nine keys.
// Any other key set fails the whole feed closed, as before.
const TICKET_PAIR = ['service_rate_basis', 'value_median_seconds'];
function metricShape(value, source, allowPair = false) {
  return (exactKeys(value, metricFields) || (allowPair && exactKeys(value, [...metricFields, ...TICKET_PAIR])))
    && value.source === source && ['available', 'stale', 'unavailable'].includes(value.status);
}
const validRate = rate => typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 && rate <= 100;
const londonParts = value => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
}).formatToParts(value).reduce((parts, part) => ({ ...parts, [part.type]: part.value }), {});
export function validCallPeriod(start, end) {
  const a = londonParts(start), b = londonParts(end);
  const midnight = p => p.hour === '00' && p.minute === '00' && p.second === '00';
  return midnight(a) && midnight(b) && start % 1000 === 0 && end % 1000 === 0
    && Date.UTC(+b.year, +b.month - 1, +b.day) - Date.UTC(+a.year, +a.month - 1, +a.day) === 28 * 86400000;
}
export function parseMetrics(data, now = Date.now()) {
  if (!exactKeys(data, ['schema_version', 'status', 'metrics']) || data.schema_version !== 2
    || !['available', 'partial', 'unavailable'].includes(data.status)
    || !exactKeys(data.metrics, ['ticket_first_response', 'call_wait'])
    || !metricShape(data.metrics.ticket_first_response, 'superops', true)
    || !metricShape(data.metrics.call_wait, 'yeastar')) return [];
  const count = Object.values(data.metrics).filter(metric => metric.status === 'available').length;
  if (data.status !== (count === 2 ? 'available' : count === 1 ? 'partial' : 'unavailable')) return [];
  // Calls first, then tickets. Each is shown only under its exact reviewed definition.
  return ['call_wait', 'ticket_first_response'].flatMap(key => {
    // value_median_seconds is validated but not shown yet; it never leaves this function.
    const { value_median_seconds: median, service_rate_basis: pairBasis, ...metric } = data.metrics[key];
    let basis = null;
    if (key === 'call_wait' || !Object.hasOwn(data.metrics[key], 'service_rate_basis')) {
      // Calls, and today's ticket shape (no pair): the rate is required. For tickets it means one business hour.
      if (!validRate(metric.service_rate_percent)) return [];
      if (key === 'ticket_first_response') basis = 'one_business_hour';
    } else {
      // With the pair: a same-working-day rate, or no rate at all. Nothing else.
      if (typeof median !== 'number' || !Number.isFinite(median) || median < 0) return [];
      if (pairBasis === 'same_business_day' && validRate(metric.service_rate_percent)) basis = pairBasis;
      else if (!(pairBasis === null && metric.service_rate_percent === null)) return [];
    }
    const rate = metric.service_rate_percent;
    if (metric.status !== 'available' || !DEFINITIONS[key].includes(metric.definition_id)
      || typeof metric.value_seconds !== 'number' || !Number.isFinite(metric.value_seconds) || metric.value_seconds < 0) return [];
    const start = utc(metric.period_start), end = utc(metric.period_end);
    const observed = utc(metric.observed_at), expires = utc(metric.expires_at);
    if (!(start < end && end <= observed && observed <= now && now < expires && expires - observed <= 180000000)
      || !validCallPeriod(start, end)) return [];
    return [{ ...metric, service_rate_percent: rate, rate_basis: basis, key, expiry: expires }];
  });
}
function text(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && [...value].length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
export function parseFeedback(data, now = Date.now()) {
  if (!exactKeys(data, ['schema_version', 'status', 'selected_on', 'expires_at', 'items']) || data.schema_version !== 1
    || !['available', 'stale', 'unavailable'].includes(data.status) || !Array.isArray(data.items)) return null;
  if (data.status !== 'available') return null;
  if (typeof data.selected_on !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.selected_on)) return null;
  const start = utc(`${data.selected_on}T00:00:00Z`), expiry = utc(data.expires_at);
  if (!(start <= now && now < expiry && expiry <= start + 259200000) || data.items.length < 1 || data.items.length > 3) return null;
  if (!data.items.every(item => exactKeys(item, itemFields) && text(item.first_name, 40) && text(item.comment, 400)
    && (item.rating === null || text(item.rating, 32))
    && (item.feedback_month === null || (typeof item.feedback_month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(item.feedback_month)
      && item.feedback_month <= data.selected_on.slice(0, 7))))) return null;
  if (new Set(data.items.map(itemKey)).size !== data.items.length) return null;
  return { items: data.items.map(item => ({ ...item })), expiry };
}
export const itemKey = item => JSON.stringify(itemFields.map(key => item[key]));
export function retainFeedback(previous, current) {
  const allowed = new Set((current?.items ?? []).map(itemKey));
  return previous.filter(item => allowed.has(itemKey(item)));
}
export function formatTime(seconds) {
  if (seconds < 60) { const n = Math.ceil(seconds); return `${n} ${n === 1 ? 'second' : 'seconds'}`; }
  const hours = seconds >= 3600;
  const n = Math.ceil(seconds / (hours ? 360 : 6)) / 10;
  return `${n.toLocaleString('en-GB', { maximumFractionDigits: 1 })} ${hours ? (n === 1 ? 'hour' : 'hours') : (n === 1 ? 'minute' : 'minutes')}`;
}
// Ticket timing in friendly units: whole minutes below two hours, then hours to one
// decimal; always rounded up, never flattered. It counts business hours only, so
// every ticket label says "in business hours".
export function formatTicketTime(seconds) {
  if (seconds >= 60 && seconds < 7200) { const n = Math.ceil(seconds / 60); return `${n} ${n === 1 ? 'minute' : 'minutes'}`; }
  return formatTime(seconds);
}
// The panel's figures in reading order: the call wait leads, then the call answer
// rate, the ticket time and, when the feed publishes one with a reviewed basis,
// the ticket rate. The panel shows these and nothing else.
export function proofFigures(values) {
  return values.flatMap(metric => metric.key === 'call_wait'
    ? [{ id: 'call_time', key: metric.key, label: CALL_WORDING.time, value: formatTime(metric.value_seconds), kind: 'time', lead: true },
      { id: 'call_rate', key: metric.key, label: CALL_WORDING.rate, value: formatRate(metric.service_rate_percent), kind: 'rate' }]
    : [{ id: 'ticket_time', key: metric.key, label: TICKET_WORDING[metric.definition_id].label, value: formatTicketTime(metric.value_seconds), kind: 'time' },
      ...(metric.rate_basis ? [{ id: 'ticket_rate', key: metric.key, label: RATE_BASIS[metric.rate_basis].label, value: formatRate(metric.service_rate_percent), kind: 'rate' }] : [])]);
}
// "How we measure these figures": only the paragraphs for what is on screen.
export function proofMethod(values) {
  return [...values.flatMap(metric => metric.key === 'call_wait' ? [CALL_WORDING.method]
    : [TICKET_WORDING[metric.definition_id].method, ...(metric.rate_basis ? [RATE_BASIS[metric.rate_basis].method] : [])]), METHOD_CLOSING];
}
// One line when both figures cover the same days, one per figure otherwise.
export function proofPeriods(values) {
  const lines = values.map(metric => formatPeriod(metric));
  if (new Set(lines).size <= 1) return [`Reporting period: ${lines[0]} (UK dates).`];
  return values.map((metric, i) => `${metric.key === 'call_wait' ? 'Calls' : 'Emails'}: ${lines[i]} (UK dates).`);
}
export const formatRate = rate => `${(Math.floor(rate * 10) / 10).toLocaleString('en-GB', { maximumFractionDigits: 1 })}%`;
export function formatPeriod(metric) {
  const format = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric' });
  return `${format.format(utc(metric.period_start))} to ${format.format(utc(metric.period_end) - 1)}`;
}
export const formatMonth = month => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${month}-01T00:00:00Z`));

export async function readFeed(response) {
  if (!response.ok || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
    || Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) throw new Error('Unavailable');
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) throw new Error('Unavailable');
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
