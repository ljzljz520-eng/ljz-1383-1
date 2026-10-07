const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const BASE = `http://127.0.0.1:${process.env.PORT || 3100}`;
const ADMIN = process.env.ADMIN_TOKEN || 'acceptance-token';
const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'acceptance.sqlite');
for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });

const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, NODE_ENV: 'test', DB_FILE: dbFile, PORT: String(new URL(BASE).port), ADMIN_TOKEN: ADMIN, HOLD_TTL_MS: process.env.HOLD_TTL_MS || '900', SWEEP_INTERVAL_MS: '300' },
  stdio: ['ignore','pipe','pipe']
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function req(url, opts={}) {
  const { headers={}, ...rest } = opts;
  const res = await fetch(BASE + url, { ...rest, headers: { 'content-type':'application/json', ...headers } });
  const body = await res.json().catch(()=>({}));
  return { status: res.status, body };
}
const post = (url, payload, headers) => req(url, { method:'POST', body: JSON.stringify(payload||{}), headers: headers || {} });
const put = (url, payload, headers) => req(url, { method:'PUT', body: JSON.stringify(payload||{}), headers: headers || {} });

async function waitForServer() {
  for (let i=0;i<40;i++) {
    try { const r = await req('/api/styles'); if (r.status===200) return; } catch {}
    await sleep(100);
  }
  throw new Error('server did not start');
}
async function expectStatus(r, status) { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; }
const adminHeaders = { 'x-admin-token': ADMIN };
const directDb = () => new Database(dbFile);

(async () => {
  await waitForServer();

  // 1. Public catalog and resource-aware package are available.
  const catalog = await expectStatus(await req('/api/packages'), 200);
  const pkg = catalog.packages[0];
  assert.equal(pkg.duration_minutes, 90);
  assert.ok(pkg.resources.some(r => r.type === 'photographer'));
  assert.ok(pkg.resources.some(r => r.type === 'equipment'));

  // 2. Queue request does NOT lock resources; a later short-hold can lock the same slot.
  const s1 = '2026-11-10T02:00:00.000Z';
  const queued = await post('/api/bookings', {
    package_id: pkg.id, start_at: s1, timezone: 'Asia/Shanghai', customer_name: '排队客户', customer_contact: 'queue@example.com', mode: 'queue', idempotency_key: 'queue-1'
  });
  const q = await expectStatus(queued, 201);
  assert.equal(q.booking.status, 'queued');
  assert.ok(q.booking.queue_position > 0);

  const held = await post('/api/bookings', {
    package_id: pkg.id, start_at: s1, timezone: 'UTC', customer_name: '占位客户', customer_contact: 'hold@example.com', mode: 'hold', idempotency_key: 'hold-1'
  });
  const h = await expectStatus(held, 201);
  assert.equal(h.booking.status, 'held');
  assert.ok(h.booking.hold_expires_at > new Date().toISOString());
  const confirmedH = await post(`/api/bookings/${h.booking.public_ref}/confirm`, {});
  const hc = await expectStatus(confirmedH, 200);
  assert.equal(hc.booking.status, 'confirmed');

  // Admin cannot confirm the queue while the hold is locked.
  const qBlocked = await post(`/api/admin/bookings/${q.booking.public_ref}/confirm-queue`, {}, adminHeaders);
  await expectStatus(qBlocked, 409);
  assert.ok(qBlocked.body.conflicts.some(c => c.existing.booking_ref === hc.booking.public_ref));

  // Release the locked future booking, then queue can be confirmed.
  await expectStatus(await post(`/api/bookings/${hc.booking.public_ref}/cancel`, { reason: '客户改变计划' }), 200);
  const qConfirmed = await post(`/api/admin/bookings/${q.booking.public_ref}/confirm-queue`, {}, adminHeaders);
  const qc = await expectStatus(qConfirmed, 200);
  assert.equal(qc.booking.status, 'confirmed');

  // 3. Idempotency: repeated original request returns the same booking, never creates a second one.
  const replay = await post('/api/bookings', {
    package_id: pkg.id, start_at: s1, timezone: 'Asia/Shanghai', customer_name: '排队客户', customer_contact: 'queue@example.com', mode: 'queue', idempotency_key: 'queue-1'
  });
  await expectStatus(replay, 200);
  assert.equal(replay.body.idempotent_replay, true);
  assert.equal(replay.body.booking.public_ref, qc.booking.public_ref);
  const duplicateParallel = await Promise.all([
    post('/api/bookings', { package_id: pkg.id, start_at:'2026-11-18T02:00:00Z', timezone:'UTC', customer_name:'DUP', customer_contact:'dup', mode:'queue', idempotency_key:'parallel-dup' }),
    post('/api/bookings', { package_id: pkg.id, start_at:'2026-11-18T02:00:00Z', timezone:'UTC', customer_name:'DUP', customer_contact:'dup', mode:'queue', idempotency_key:'parallel-dup' })
  ]);
  const dupCodes = duplicateParallel.map(r => r.status).sort();
  assert.deepEqual(dupCodes, [200,201]);
  assert.equal(duplicateParallel[0].body.booking.public_ref, duplicateParallel[1].body.booking.public_ref);

  // 4. Two simultaneous short-holds compete for exactly the same slot. Then a later non-overlapping
  //    shooting window is also checked against travel/setup/teardown windows.
  const s2 = '2026-11-11T02:00:00.000Z';
  const parallel = await Promise.all([
    post('/api/bookings', { package_id: pkg.id, start_at: s2, timezone:'UTC', customer_name:'A', customer_contact:'a', mode:'hold', idempotency_key:'race-a' }),
    post('/api/bookings', { package_id: pkg.id, start_at: s2, timezone:'UTC', customer_name:'A2', customer_contact:'a2', mode:'hold', idempotency_key:'race-a2' })
  ]);
  const statuses = parallel.map(r => r.status).sort();
  assert.deepEqual(statuses, [201,409]);
  const parallelWinner = parallel.find(r => r.status === 201).body.booking;
  await expectStatus(await post(`/api/bookings/${parallelWinner.public_ref}/confirm`, {}), 200);
  assert.ok(parallel.find(r => r.status === 409).body.conflicts.some(c => c.requested_phase.phase_type === 'shoot' && c.existing.phase_type === 'shoot'));
  const b = await post('/api/bookings', { package_id: pkg.id, start_at: '2026-11-11T03:30:00.000Z', timezone:'UTC', customer_name:'B', customer_contact:'b', mode:'hold', idempotency_key:'race-b' });
  await expectStatus(b, 409);
  assert.ok(b.body.conflicts.some(c => c.requested_phase.phase_type === 'travel_before' && c.existing.phase_type === 'shoot'));
  assert.ok(b.body.conflicts.some(c => c.requested_phase.phase_type === 'shoot' && c.existing.phase_type === 'teardown'));

  // 5. Package edits create a new current quote/scope but old bookings retain their snapshot.
  const oldPrice = qc.booking.price_cents;
  const oldScope = qc.booking.package_snapshot.included_scope;
  await expectStatus(await put(`/api/admin/packages/${pkg.id}`, {
    current_price_cents: oldPrice + 50000, included_scope: [...oldScope, '新增专属海报']
  }, adminHeaders), 200);
  const afterOld = await expectStatus(await req(`/api/bookings/${qc.booking.public_ref}`), 200);
  assert.equal(afterOld.booking.price_cents, oldPrice);
  assert.deepEqual(afterOld.booking.package_snapshot.included_scope, oldScope);
  const afterCatalog = await expectStatus(await req('/api/packages'), 200);
  assert.equal(afterCatalog.packages[0].price_cents, oldPrice + 50000);
  assert.ok(afterCatalog.packages[0].included_scope.includes('新增专属海报'));

  // 6. Manual reschedule is audited and keeps the immutable quote.
  const s3 = '2026-11-12T02:00:00.000Z';
  const moved = await post(`/api/admin/bookings/${qc.booking.public_ref}/reschedule`, { start_at: s3, timezone: 'Asia/Tokyo', reason: '摄影师与客户协商改到周末' }, adminHeaders);
  await expectStatus(moved, 200);
  assert.equal(moved.body.booking.start_at, s3);
  assert.equal(moved.body.booking.price_cents, oldPrice);
  const movedConflict = await post(`/api/admin/bookings/${qc.booking.public_ref}/reschedule`, { start_at: s2, timezone: 'UTC', reason: '尝试移到已占用时段' }, adminHeaders);
  await expectStatus(movedConflict, 409);
  assert.ok(movedConflict.body.conflicts.some(c => c.existing.booking_ref === parallelWinner.public_ref));
  const unchanged = await expectStatus(await req(`/api/bookings/${qc.booking.public_ref}`), 200);
  assert.equal(unchanged.booking.start_at, s3);
  const logs = await expectStatus(await req('/api/admin/audit-logs', { headers: adminHeaders }), 200);
  assert.ok(logs.logs.some(l => l.action === 'manual_reschedule' && l.detail.reason === '摄影师与客户协商改到周末'));

  // 7. Admin block against occupied slot returns an explanation; forced block blocks all future requests.
  const blockAttempt = await post('/api/admin/blocks', { resource_id: 1, start_at: '2026-11-12T02:10:00Z', end_at: '2026-11-12T05:00:00Z', reason: '设备维修演练' }, adminHeaders);
  await expectStatus(blockAttempt, 409);
  assert.ok(blockAttempt.body.conflicts.some(c => c.type === 'booking' && c.resource.name === '林摄影师'));
  await expectStatus(await post('/api/admin/blocks', { resource_id: 1, start_at: '2026-11-12T02:10:00Z', end_at: '2026-11-12T05:00:00Z', reason: '设备维修演练', force: true }, adminHeaders), 201);
  const blockedNew = await post('/api/bookings', { package_id: pkg.id, start_at: s3, timezone:'UTC', customer_name:'C', customer_contact:'c', mode:'hold', idempotency_key:'blocked-new' });
  await expectStatus(blockedNew, 409);
  assert.ok(blockedNew.body.conflicts.some(c => c.type === 'admin_block'));
  assert.ok(blockedNew.body.conflicts.some(c => c.type === 'booking'));

  // 8. A booking whose first physical occupancy has started cannot be cancelled/released.
  const started = await expectStatus(await post('/api/bookings', { package_id: pkg.id, start_at:'2026-11-20T02:00:00Z', timezone:'UTC', customer_name:'已开始', customer_contact:'started', mode:'hold', idempotency_key:'started' }), 201);
  await expectStatus(await post(`/api/bookings/${started.booking.public_ref}/confirm`, {}), 200);
  const db = directDb();
  db.prepare("UPDATE booking_resources SET phase_start='2000-01-01T00:00:00.000Z', phase_end='2000-01-01T00:30:00.000Z' WHERE booking_id=? AND phase_type='travel_before'").run(started.booking.id);
  db.close();
  const cancelStarted = await post(`/api/bookings/${started.booking.public_ref}/cancel`, { reason: 'try' });
  await expectStatus(cancelStarted, 409);
  assert.match(cancelStarted.body.error, /已经实际开始/);

  // 9. Expired short hold is automatically restored; a confirmation racing expiry loses.
  const expirySlot = '2026-11-22T02:00:00.000Z';
  const exp = await expectStatus(await post('/api/bookings', { package_id: pkg.id, start_at: expirySlot, timezone:'UTC', customer_name:'到期占位', customer_contact:'exp', mode:'hold', idempotency_key:'expire' }), 201);
  await sleep(1200);
  const lateConfirm = await post(`/api/bookings/${exp.booking.public_ref}/confirm`, {});
  await expectStatus(lateConfirm, 410);
  const recovered = await expectStatus(await post('/api/bookings', { package_id: pkg.id, start_at: expirySlot, timezone:'UTC', customer_name:'新客户', customer_contact:'new', mode:'hold', idempotency_key:'recovered' }), 201);
  assert.equal(recovered.booking.status, 'held');

  // 10. Timezone/offset input is normalized to UTC and the submitted zone is retained.
  const tzBooking = await expectStatus(await post('/api/bookings', { package_id: pkg.id, start_at:'2026-11-24T03:00:00+08:00', timezone:'Asia/Shanghai', customer_name:'时区客户', customer_contact:'tz', mode:'queue', idempotency_key:'tz' }), 201);
  assert.equal(tzBooking.booking.start_at, '2026-11-23T19:00:00.000Z');
  assert.equal(tzBooking.booking.timezone, 'Asia/Shanghai');

  // 11. Photo license revocation is unpublished until publish; afterwards lightbox, cover and version agree.
  const beforeCount = (await expectStatus(await req('/api/albums/2'), 200)).album.photos.length;
  const adminAlbums = await expectStatus(await req('/api/admin/albums', { headers: adminHeaders }), 200);
  const album2 = adminAlbums.albums.find(a => a.id === 2);
  const revokePhoto = album2.photos[0];
  await expectStatus(await put(`/api/admin/photos/${revokePhoto.id}/license`, { public_license: false }, adminHeaders), 200);
  const stillPublic = await expectStatus(await req('/api/albums/2'), 200);
  assert.equal(stillPublic.album.photos.length, beforeCount);
  const published = await expectStatus(await post('/api/admin/albums/2/publish', {}, adminHeaders), 200);
  assert.equal(published.album.photos.length, beforeCount - 1);
  assert.ok(!published.album.photos.some(p => p.id === revokePhoto.id));
  assert.notEqual(published.album.cover.id, revokePhoto.id);
  assert.ok(published.album.photos.every(p => p.version === published.album.version));

  // 12. Draft preview does not create a booking; the browser UI explicitly treats drafts as local-only.
  const adminBefore = await expectStatus(await req('/api/admin/bookings', { headers: adminHeaders }), 200);
  await expectStatus(await post('/api/bookings/preview', { package_id: pkg.id, start_at:'2026-11-25T02:00:00Z', timezone:'UTC' }), 200);
  const adminAfter = await expectStatus(await req('/api/admin/bookings', { headers: adminHeaders }), 200);
  assert.equal(adminBefore.bookings.length, adminAfter.bookings.length);
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(appJs, /不是成功预订/);
  assert.match(appJs, /localStorage/);

  // 13. Admin API is authenticated.
  await expectStatus(await req('/api/admin/bookings'), 401);

  console.log('\n全部验收测试通过：竞争占位、排队、过期恢复、时区、许可发布、套餐快照、取消限制、后台冲突与改期记录。');
  child.kill();
  process.exit(0);
})().catch(err => {
  console.error(err);
  child.kill();
  process.exit(1);
});
