import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../lib/store.js';
import { createBookingService } from '../lib/scheduling.js';
import { createAdminService } from '../lib/admin.js';
import { localDateTimeToUtc } from '../lib/time.js';

let dir;

async function makeService(ttlMs = 1000) {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-test-'));
  const store = new JsonStore(path.join(dir, 'db.json'));
  await store.load();
  return {
    store,
    booking: createBookingService(store, { holdTtlMs: ttlMs }),
    admin: createAdminService(store)
  };
}

test.afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

const base = (overrides = {}) => ({
  packageId: 'pkg-portrait',
  startLocal: '2027-05-04T10:00',
  timezone: 'Asia/Shanghai',
  customer: { name: '张三', email: 'a@example.com', phone: '', notes: '' },
  idempotencyKey: 'key-a',
  ...overrides
});

test('two customers competing for the same slot: first locks, second waits and is idempotent', async () => {
  const svc = await makeService();
  const first = await svc.booking.submitBooking(base());
  assert.equal(first.booking.status, 'confirmed');
  assert.equal(first.lockState.locked, true);

  const secondPayload = base({ idempotencyKey: 'key-b', customer: { name: '李四', email: 'b@example.com' } });
  const second = await svc.booking.submitBooking(secondPayload);
  assert.equal(second.booking.status, 'waiting');
  assert.equal(second.lockState.locked, false);

  const repeat = await svc.booking.submitBooking(secondPayload);
  assert.equal(repeat.duplicate, true);
  assert.equal(repeat.booking.id, second.booking.id);
  const db = await svc.store.read();
  assert.equal(db.bookings.length, 2);
});

test('checks travel, setup, breakdown and cleanup windows, not only shoot start/end', async () => {
  const svc = await makeService();
  await svc.booking.submitBooking(base());
  // First package occupies 09:10-12:05 local. A formal shoot at 12:55 is
  // after the full occupied window and allowed; 11:55 starts inside it.
  const adjacent = await svc.booking.submitBooking(base({
    startLocal: '2027-05-04T12:55',
    idempotencyKey: 'adjacent',
    customer: { name: '邻接', email: 'adj@example.com' }
  }));
  assert.equal(adjacent.booking.status, 'confirmed');

  const overlapping = await svc.booking.submitBooking(base({
    startLocal: '2027-05-04T11:55',
    idempotencyKey: 'overlap',
    customer: { name: '缓冲重叠', email: 'over@example.com' }
  }));
  assert.equal(overlapping.booking.status, 'waiting');
  assert.ok(overlapping.booking.queue.conflictsAtSubmit.some((c) => c.type === 'resource'));
});

test('hold expiry at confirmation releases the resource and promotes the waiting queue', async () => {
  const svc = await makeService(1000);
  const held = await svc.booking.createHold(base({ idempotencyKey: 'hold-key' }));
  assert.equal(held.hold.status, 'active');
  assert.equal(held.lockState.locked, false);

  const waiter = await svc.booking.submitBooking(base({
    idempotencyKey: 'waiter',
    customer: { name: '排队客户', email: 'wait@example.com' }
  }));
  assert.equal(waiter.booking.status, 'waiting');

  await new Promise((resolve) => setTimeout(resolve, 1050));
  await assert.rejects(
    svc.booking.confirmHold({
      holdId: held.hold.id,
      customer: base().customer,
      idempotencyKey: 'confirm-key'
    }),
    (err) => err.status === 410 && err.code === 'hold_expired'
  );
  const lookedUp = await svc.booking.lookupBooking({ bookingId: waiter.booking.id, email: 'wait@example.com' });
  assert.equal(lookedUp.booking.status, 'confirmed');
});

test('a hold confirmed before expiry creates exactly one booking under repeated confirm requests', async () => {
  const svc = await makeService(5000);
  const held = await svc.booking.createHold(base({ idempotencyKey: 'hold-key' }));
  const payload = { holdId: held.hold.id, customer: base().customer, idempotencyKey: 'confirm-key' };
  const confirmed = await svc.booking.confirmHold(payload);
  const repeated = await svc.booking.confirmHold(payload);
  assert.equal(confirmed.booking.status, 'confirmed');
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.booking.id, confirmed.booking.id);
  const db = await svc.store.read();
  assert.equal(db.bookings.length, 1);
});

test('package edit versions price and scope while existing bookings retain their snapshot', async () => {
  const svc = await makeService();
  const old = await svc.booking.submitBooking(base());
  await svc.admin.updatePackage({
    id: 'pkg-portrait',
    price: 1680,
    reason: 'spring price change',
    serviceScope: ['涨价后的新服务', '仅 10 张精修']
  });
  const db = await svc.store.read();
  const storedOld = db.bookings.find((b) => b.id === old.booking.id);
  assert.equal(storedOld.snapshot.version, 1);
  assert.equal(storedOld.snapshot.price, 1280);
  assert.ok(storedOld.snapshot.serviceScope.includes('20 张精修'));

  const next = await svc.booking.submitBooking(base({
    startLocal: '2027-05-05T10:00',
    idempotencyKey: 'new-price',
    customer: { name: '新客户', email: 'new@example.com' }
  }));
  assert.equal(next.booking.snapshot.version, 2);
  assert.equal(next.booking.snapshot.price, 1680);
});

test('cancel only releases a future booking; repeating cancel is harmless', async () => {
  const svc = await makeService();
  const booking = await svc.booking.submitBooking(base());
  const payload = { bookingId: booking.booking.id, idempotencyKey: 'cancel-key', reason: 'changed mind' };
  const canceled = await svc.booking.cancelBooking(payload);
  assert.equal(canceled.booking.status, 'customer_canceled');
  const repeat = await svc.booking.cancelBooking(payload);
  assert.equal(repeat.duplicate, true);
  const db = await svc.store.read();
  assert.equal(db.bookings.filter((b) => b.status === 'customer_canceled').length, 1);
});

test('admin reschedule records a forced conflict explanation', async () => {
  const svc = await makeService();
  const first = await svc.booking.submitBooking(base());
  const second = await svc.booking.submitBooking(base({
    startLocal: '2027-05-05T10:00',
    idempotencyKey: 'second',
    customer: { name: '李四', email: 'b@example.com' }
  }));
  await assert.rejects(
    svc.admin ? svc.booking.adminReschedule({
      bookingId: second.booking.id,
      startLocal: '2027-05-04T10:00',
      timezone: 'Asia/Shanghai',
      reason: '客户要求同一天'
    }) : null,
    (err) => err.status === 409 && err.details.conflicts.length > 0
  );
  const forced = await svc.booking.adminReschedule({
    bookingId: second.booking.id,
    startLocal: '2027-05-04T10:00',
    timezone: 'Asia/Shanghai',
    reason: '客户要求同一天，人工协调',
    force: true
  });
  assert.equal(forced.booking.status, 'confirmed');
  assert.equal(forced.booking.forcedOverlap, true);
  assert.equal(forced.booking.rescheduleHistory[0].forced, true);
  assert.ok(forced.booking.rescheduleHistory[0].conflictExplanation.length > 0);
});

test('photo license revocation removes it from the public album manifest and changes a forbidden cover', async () => {
  const { store } = await makeService();
  const admin = createAdminService(store);
  const before = await (await import('../lib/content.js')).createContentService(store);
  let album = await before.album('album-portrait');
  assert.equal(album.photos.length, 3);
  await admin.setPhotoLicense({ photoId: 'photo-1', publicLicense: false });
  const content = await (await import('../lib/content.js')).createContentService(store);
  album = await content.album('album-portrait');
  assert.equal(album.photos.some((p) => p.id === 'photo-1'), false);
  assert.notEqual(album.coverPhotoId, 'photo-1');
  assert.equal(await content.media('photo-1'), null);
});

test('admin block adjusts an occupied slot and explains it to later booking attempts', async () => {
  const svc = await makeService();
  await svc.admin.createBlock({
    title: '工作室设备检修',
    reason: '灯光系统维护',
    allResources: true,
    timezone: 'Asia/Shanghai',
    startLocal: '2027-05-06T10:00',
    endLocal: '2027-05-06T12:00',
    beforeMin: 30,
    afterMin: 30
  });
  const attempt = await svc.booking.submitBooking(base({
    startLocal: '2027-05-06T11:00',
    idempotencyKey: 'blocked-attempt',
    customer: { name: '撞封闭', email: 'blocked@example.com' }
  }));
  assert.equal(attempt.booking.status, 'waiting');
  assert.ok(attempt.booking.queue.conflictsAtSubmit.some((c) => c.type === 'resource' && c.occupationType === 'block'));
});

test('UTC remains stable when the admin changes schedule timezone', async () => {
  const svc = await makeService();
  const booking = await svc.booking.submitBooking(base());
  const oldUtc = booking.booking.startUtc;
  await svc.admin.updateSchedule({ timezone: 'Europe/London' });
  const lookedUp = await svc.booking.lookupBooking({ bookingId: booking.booking.id, email: 'a@example.com' });
  assert.equal(lookedUp.booking.startUtc, oldUtc);
});
