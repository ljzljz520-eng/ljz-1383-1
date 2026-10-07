import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-api-'));
process.env.DATA_FILE = path.join(tmp, 'db.json');
process.env.PORT = '0';
process.env.ADMIN_TOKEN = 'test-token';
process.env.HOLD_TTL_MS = '1000';
const { createApp } = await import('../lib/http.js');

const server = createApp();
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const base = `http://localhost:${port}`;

async function req(pathname, options = {}) {
  const res = await fetch(base + pathname, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, headers: res.headers, body };
}

test.after(async () => {
  server.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

const payload = (overrides = {}) => ({
  packageId: 'pkg-portrait',
  startLocal: '2027-05-04T10:00',
  timezone: 'Asia/Shanghai',
  customer: { name: 'API 客户', email: 'api@example.com' },
  idempotencyKey: 'api-key',
  ...overrides
});

test('public manifest, media and authenticated admin guard work', async () => {
  const albums = await req('/api/albums');
  assert.equal(albums.status, 200);
  assert.ok(albums.body[0].manifestDigest);
  const media = await req('/media/photo-1.svg?v=1');
  assert.equal(media.status, 200);
  assert.equal(media.headers.get('content-type').includes('svg'), true);
  assert.equal((await req('/api/admin/state')).status, 401);
  assert.equal((await req('/api/admin/state', { headers: { authorization: 'Bearer test-token' } })).status, 200);
});

test('HTTP repeated booking posts return one order and public timeline distinguishes states', async () => {
  const body = payload();
  const first = await req('/api/bookings', { method: 'POST', body });
  const duplicate = await req('/api/bookings', { method: 'POST', body });
  assert.equal(first.status, 200);
  assert.equal(first.body.booking.status, 'confirmed');
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.booking.id, first.body.booking.id);

  const waiting = await req('/api/bookings', { method: 'POST', body: payload({
    idempotencyKey: 'api-key-2', customer: { name: '第二个', email: 'two@example.com' }
  }) });
  assert.equal(waiting.body.booking.status, 'waiting');
  const timeline = await req('/api/timeline?date=2027-05-04&timezone=Asia/Shanghai');
  assert.deepEqual([...new Set(timeline.body.items.map((i) => i.type))].sort(), ['locked', 'waiting_confirmation']);
});

test('timezone switching converts the same New York wall time and rejects spring gap over HTTP', async () => {
  const ok = await req('/api/preflight', { method: 'POST', body: {
    packageId: 'pkg-portrait', startLocal: '2027-05-04T10:00', timezone: 'America/New_York'
  } });
  assert.equal(ok.body.startUtc, '2027-05-04T14:00:00.000Z');
  const gap = await req('/api/preflight', { method: 'POST', body: {
    packageId: 'pkg-portrait', startLocal: '2027-03-14T02:30', timezone: 'America/New_York'
  } });
  assert.equal(gap.status, 400);
  assert.equal(gap.body.error, 'nonexistent_local_time');
});

test('license revocation causes media 404 and changes cover/manifest', async () => {
  const revoke = await req('/api/admin/photos/photo-1/license', {
    method: 'PUT',
    headers: { authorization: 'Bearer test-token' },
    body: { publicLicense: false }
  });
  assert.equal(revoke.status, 200);
  assert.notEqual(revoke.body.album.coverPhotoId, 'photo-1');
  const media = await req('/media/photo-1.svg?v=1');
  assert.equal(media.status, 404);
  const album = await req('/api/albums/album-portrait');
  assert.equal(album.body.photos.some((p) => p.id === 'photo-1'), false);
});
