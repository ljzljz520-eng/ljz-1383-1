// Timezone helpers. Dates are transmitted and stored as UTC ISO strings; the UI
// works in the visitor's IANA zone. All interval comparisons happen in UTC.

const pad2 = (n) => String(n).padStart(2, '0');

export function isValidTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function localParts(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(instant);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  let hour = get('hour');
  // Some environments render midnight as 24 instead of 00.
  if (hour === 24) hour = 0;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second')
  };
}

function partsToUtc(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function parseLocalInput(input) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(input || ''));
  if (!m) return null;
  const value = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: m[4] === undefined ? 0 : Number(m[4]),
    minute: m[5] === undefined ? 0 : Number(m[5]),
    second: m[6] === undefined ? 0 : Number(m[6])
  };
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second));
  if (date.getUTCFullYear() !== value.year || date.getUTCMonth() !== value.month - 1 ||
      date.getUTCDate() !== value.day || date.getUTCHours() !== value.hour ||
      date.getUTCMinutes() !== value.minute) {
    return null;
  }
  return value;
}

// Map a wall-clock time in an IANA zone to UTC. The optional ambiguity argument
// controls the repeated hour after "fall back"; spring-forward gaps are rejected.
export function localDateTimeToUtc(input, timeZone, ambiguity = 'earlier') {
  const wanted = parseLocalInput(input);
  if (!wanted) return { ok: false, reason: 'invalid_datetime' };
  if (!isValidTimeZone(timeZone)) return { ok: false, reason: 'invalid_timezone' };

  const wantedUtcShape = partsToUtc(wanted);
  const midnight = { ...wanted, hour: 0, minute: 0, second: 0 };

  // Local midnight exists in all current common photographer locations. Using
  // it as an anchor keeps this independent of the host process timezone.
  let midnightUtc = partsToUtc(midnight);
  for (let i = 0; i < 4; i++) {
    const actual = localParts(midnightUtc, timeZone);
    const actualShape = partsToUtc({ ...actual, second: 0 });
    const midnightShape = partsToUtc(midnight);
    const next = midnightUtc + (midnightShape - actualShape);
    if (next === midnightUtc) break;
    midnightUtc = next;
  }

  const candidate = midnightUtc + ((wanted.hour * 60 + wanted.minute) * 60 + wanted.second) * 1000;
  const atCandidate = localParts(candidate, timeZone);
  const later = candidate + 3600000;
  const atLater = localParts(later, timeZone);

  if (partsToUtc(atCandidate) === wantedUtcShape) {
    const ambiguous = partsToUtc(atLater) === wantedUtcShape;
    return { ok: true, utcMs: ambiguous && ambiguity === 'later' ? later : candidate, ambiguous };
  }
  if (partsToUtc(atLater) === wantedUtcShape) {
    return { ok: true, utcMs: later, ambiguous: true };
  }
  return { ok: false, reason: 'nonexistent_local_time' };
}

export function utcToLocalDateTime(utcMs, timeZone) {
  const p = localParts(new Date(utcMs), timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`;
}

export function utcToLocalDate(utcMs, timeZone) {
  const p = localParts(new Date(utcMs), timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function localDateToUtcRange(date, timeZone) {
  const start = localDateTimeToUtc(`${date}T00:00`, timeZone);
  if (!start.ok) return start;
  const d = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))));
  d.setUTCDate(d.getUTCDate() + 1);
  const next = d.toISOString().slice(0, 10);
  const end = localDateTimeToUtc(`${next}T00:00`, timeZone);
  if (!end.ok) return end;
  return { ok: true, startMs: start.utcMs, endMs: end.utcMs };
}

export function offsetMinutesAt(utcMs, timeZone) {
  const p = localParts(new Date(utcMs), timeZone);
  const localMs = partsToUtc(p);
  return Math.round((localMs - utcMs) / 60000);
}

export function iso(utcMs) {
  return new Date(utcMs).toISOString();
}
