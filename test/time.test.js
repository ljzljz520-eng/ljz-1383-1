import test from 'node:test';
import assert from 'node:assert/strict';
import { localDateTimeToUtc, utcToLocalDate, localDateToUtcRange, isValidTimeZone } from '../lib/time.js';

test('converts fixed-offset wall time to UTC', () => {
  const result = localDateTimeToUtc('2027-05-01T15:30', 'Asia/Shanghai');
  assert.equal(result.ok, true);
  assert.equal(new Date(result.utcMs).toISOString(), '2027-05-01T07:30:00.000Z');
});

test('rejects spring-forward nonexistent local time in New York', () => {
  const result = localDateTimeToUtc('2027-03-14T02:30', 'America/New_York');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'nonexistent_local_time');
});

test('distinguishes repeated fall-back hour', () => {
  const earlier = localDateTimeToUtc('2027-11-07T01:30', 'America/New_York', 'earlier');
  const later = localDateTimeToUtc('2027-11-07T01:30', 'America/New_York', 'later');
  assert.equal(earlier.ok, true);
  assert.equal(later.ok, true);
  assert.equal(earlier.ambiguous, true);
  assert.equal(later.utcMs - earlier.utcMs, 3600000);
  assert.equal(utcToLocalDate(earlier.utcMs, 'America/New_York'), '2027-11-07');
  assert.equal(utcToLocalDate(later.utcMs, 'America/New_York'), '2027-11-07');
});

test('validates IANA timezone and maps a local date across a DST night', () => {
  assert.equal(isValidTimeZone('Not/Zone'), false);
  const range = localDateToUtcRange('2027-11-07', 'America/New_York');
  assert.equal(range.ok, true);
  assert.equal(range.endMs - range.startMs, 25 * 3600000);
});
