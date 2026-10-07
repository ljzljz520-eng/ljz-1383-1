import { randomUUID } from 'node:crypto';
import {
  iso,
  localDateTimeToUtc,
  utcToLocalDate,
  offsetMinutesAt,
  isValidTimeZone
} from './time.js';

export const ACTIVE_LOCK_STATUSES = new Set(['offered', 'confirmed']);
export const CANCELED_STATUSES = new Set(['customer_canceled', 'admin_canceled', 'expired']);

const DAY_MS = 86400000;
const pad = (n) => String(n).padStart(2, '0');

export class BookingError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function occupiedInterval(snapshot, startMs) {
  const before = (snapshot.travelInMin + snapshot.prepMin) * 60000;
  const shoot = snapshot.durationMin * 60000;
  const after = (snapshot.breakdownMin + snapshot.travelOutMin) * 60000;
  return {
    actualStartMs: startMs,
    actualEndMs: startMs + shoot,
    occupiedStartMs: startMs - before,
    occupiedEndMs: startMs + shoot + after
  };
}

export function createBookingService(store, options = {}) {
  const holdTtlMs = options.holdTtlMs ?? Number(process.env.HOLD_TTL_MS || 90000);

  function audit(db, action, details) {
    db.auditLog.unshift({
      id: `audit-${randomUUID()}`,
      at: iso(Date.now()),
      action,
      details
    });
    if (db.auditLog.length > 500) db.auditLog.length = 500;
  }

  function nextOrderNo(db, prefix) {
    const n = db.counters.seq++;
    return `${prefix}-${String(n).padStart(5, '0')}`;
  }

  function activeResources(db) {
    return new Map(db.resources.filter((r) => r.active).map((r) => [r.id, r]));
  }

  function getPackage(db, packageId) {
    const pkg = db.packages.find((p) => p.id === packageId && p.active);
    if (!pkg) throw new BookingError(404, 'package_not_found', '套餐不存在或已下架。');
    return pkg;
  }

  function packageVersion(pkg, versionNumber = pkg.currentVersion) {
    const v = pkg.versions.find((x) => x.version === versionNumber) || pkg.versions[pkg.versions.length - 1];
    return {
      packageId: pkg.id,
      packageName: pkg.name,
      style: pkg.style,
      description: pkg.description,
      version: v.version,
      price: v.price,
      currency: v.currency,
      durationMin: v.durationMin,
      travelInMin: v.travelInMin,
      prepMin: v.prepMin,
      breakdownMin: v.breakdownMin,
      travelOutMin: v.travelOutMin,
      serviceScope: [...v.serviceScope],
      resourceGroups: v.resourceGroups.map((g) => ({ role: g.role, anyOf: [...g.anyOf] }))
    };
  }

  function occupationFromBooking(booking) {
    const interval = occupiedInterval(booking.snapshot, Date.parse(booking.startUtc));
    return {
      kind: 'booking',
      id: booking.id,
      number: booking.number,
      status: booking.status,
      customer: booking.customer.name,
      packageName: booking.snapshot.packageName,
      resourceIds: booking.resourceSelection.map((r) => r.resourceId),
      forcedOverlap: Boolean(booking.forcedOverlap),
      ...interval
    };
  }

  function occupationFromHold(hold) {
    const interval = occupiedInterval(hold.snapshot, Date.parse(hold.startUtc));
    return {
      kind: 'hold',
      id: hold.id,
      number: hold.number,
      status: 'hold',
      customer: hold.customer?.name || '临时占位',
      packageName: hold.snapshot.packageName,
      resourceIds: hold.resourceSelection.map((r) => r.resourceId),
      holdExpiresAt: hold.expiresAt,
      ...interval
    };
  }

  function dbResourceIds(db) {
    return db.resources.map((r) => r.id);
  }

  function occupationFromBlock(db, block) {
    return {
      kind: 'block',
      id: block.id,
      number: block.id,
      status: 'blocked',
      customer: block.title,
      packageName: block.reason || '后台封闭档期',
      resourceIds: block.allResources ? dbResourceIds(db) : block.resourceIds,
      ...block.interval
    };
  }

  function activeOccupations(db, atMs = Date.now()) {
    const result = [];
    for (const b of db.bookings) {
      if (ACTIVE_LOCK_STATUSES.has(b.status)) result.push(occupationFromBooking(b));
    }
    for (const h of db.holds) {
      if (h.status === 'active' && Date.parse(h.expiresAt) > atMs) result.push(occupationFromHold(h));
    }
    for (const block of db.blocks) result.push(occupationFromBlock(db, block));
    return result;
  }

  function overlaps(a, b) {
    return a.occupiedStartMs < b.occupiedEndMs && b.occupiedStartMs < a.occupiedEndMs;
  }

  function groupsCompete(aSnapshot, bSnapshot) {
    const aGroups = aSnapshot.resourceGroups;
    const bGroups = bSnapshot.resourceGroups;
    for (const a of aGroups) {
      const aSet = new Set(a.anyOf);
      for (const b of bGroups) {
        if (b.anyOf.some((id) => aSet.has(id))) return true;
      }
    }
    return false;
  }

  function competingWaiters(db, snapshot, wanted, excludeId = null) {
    return waitingBookings(db).filter((b) =>
      b.id !== excludeId &&
      groupsCompete(b.snapshot, snapshot) &&
      overlaps(makeWantedInterval(b.snapshot, Date.parse(b.startUtc)), wanted));
  }

  // Earlier waiting requests act as soft virtual occupations for new submissions,
  // but they do not hold resources while they wait.
  function queueVirtualOccupations(db, snapshot, wanted, excludeId = null) {
    return competingWaiters(db, snapshot, wanted, excludeId).map((b) => ({
      kind: 'waiting_queue',
      id: b.id,
      number: b.number,
      status: 'waiting',
      customer: b.customer.name,
      packageName: b.snapshot.packageName,
      resourceIds: [...new Set(b.snapshot.resourceGroups.flatMap((g) => g.anyOf))],
      occupiedStartMs: makeWantedInterval(b.snapshot, Date.parse(b.startUtc)).occupiedStartMs,
      occupiedEndMs: makeWantedInterval(b.snapshot, Date.parse(b.startUtc)).occupiedEndMs,
      actualStartMs: Date.parse(b.startUtc),
      actualEndMs: Date.parse(b.endUtc)
    }));
  }

  function explainResourceConflict(db, wanted, selectedResourceIds, excludeBookingId = null) {
    const wantedIds = new Set(selectedResourceIds);
    const conflicts = [];
    for (const occ of activeOccupations(db)) {
      if (excludeBookingId && occ.id === excludeBookingId) continue;
      if (!overlaps(wanted, occ)) continue;
      const shared = [...wantedIds].filter((id) => occ.resourceIds.includes(id));
      const block = occ.kind === 'block' ? db.blocks.find((x) => x.id === occ.id) : null;
      if (block?.allResources || shared.length > 0) {
        conflicts.push({
          type: 'resource',
          resourceIds: block?.allResources ? [...wantedIds] : shared,
          resourceNames: (block?.allResources ? [...wantedIds] : shared).map((id) => db.resources.find((r) => r.id === id)?.name || id),
          occupationType: occ.kind,
          occupationId: occ.id,
          occupationNumber: occ.number,
          customer: occ.customer,
          packageName: occ.packageName,
          occupiedStartUtc: iso(occ.occupiedStartMs),
          occupiedEndUtc: iso(occ.occupiedEndMs),
          actualStartUtc: iso(occ.actualStartMs),
          actualEndUtc: iso(occ.actualEndMs),
          reason: block?.allResources
            ? '该时间段已被后台整体封闭。'
            : `共用资源在对方交通/布置或撤场/交通时间内已被占用。`
        });
      }
    }
    return conflicts;
  }

  function fallbackSelection(db, snapshot) {
    const resources = activeResources(db);
    return snapshot.resourceGroups.map((group) => {
      const resourceId = group.anyOf.find((id) => resources.has(id)) || group.anyOf[0];
      return { role: group.role, resourceId, resourceName: db.resources.find((r) => r.id === resourceId)?.name || resourceId };
    });
  }

  function chooseResources(db, snapshot, wanted, excludeBookingId = null, extraOccupations = []) {
    const resources = activeResources(db);
    const occupations = [
      ...activeOccupations(db).filter((o) => !excludeBookingId || o.id !== excludeBookingId),
      ...extraOccupations
    ];
    const unavailable = [];

    const selected = snapshot.resourceGroups.map((group) => {
      let firstBusy = null;
      for (const resourceId of group.anyOf) {
        const resource = resources.get(resourceId);
        if (!resource) continue;
        const busy = occupations.find((o) => overlaps(wanted, o) && o.resourceIds.includes(resourceId));
        if (!busy) return { role: group.role, resourceId, resourceName: resource.name };
        if (!firstBusy) {
          firstBusy = {
            type: 'resource',
            role: group.role,
            resourceId,
            resourceName: resource.name,
            occupiedBy: busy.number,
            occupationType: busy.kind,
            customer: busy.customer,
            packageName: busy.packageName,
            reason: busy.kind === 'block' ? '后台封闭档期与该请求重叠。' : busy.reason,
            occupiedStartUtc: iso(busy.occupiedStartMs),
            occupiedEndUtc: iso(busy.occupiedEndMs)
          };
        }
      }
      unavailable.push(firstBusy || {
        type: 'resource',
        role: group.role,
        reason: '该套餐所需资源均已停用。'
      });
      return null;
    });

    return selected.every(Boolean)
      ? { ok: true, selection: selected }
      : { ok: false, conflicts: unavailable };
  }

  function hhmmToMin(value) {
    const m = /^(\d{2}):(\d{2})$/.exec(value);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  function addLocalDate(date, days) {
    const d = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))));
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function localRangesForDate(db, date) {
    const override = db.schedule.dateOverrides.find((o) => o.date === date);
    if (override) {
      if (override.closed) return { open: [], reason: override.reason || '该日期不开放预约。', closed: true };
      if (override.ranges?.length) return { open: override.ranges, reason: override.reason };
    }
    const weekday = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))).getUTCDay();
    return { open: db.schedule.weekly.filter((w) => w.day === weekday), reason: undefined, closed: false };
  }

  function asUtcRange(date, range, timeZone) {
    const s = localDateTimeToUtc(`${date}T${range.start}`, timeZone, 'later');
    const e = localDateTimeToUtc(`${date}T${range.end}`, timeZone, 'later');
    if (!s.ok || !e.ok || e.utcMs <= s.utcMs) return null;
    return { startMs: s.utcMs, endMs: e.utcMs };
  }

  function explainAvailability(db, interval) {
    const tz = db.schedule.timezone;
    const dates = [];
    const firstDate = utcToLocalDate(interval.occupiedStartMs, tz);
    const lastDate = utcToLocalDate(Math.max(interval.occupiedStartMs, interval.occupiedEndMs - 1), tz);
    for (let date = firstDate; date <= lastDate; date = addLocalDate(date, 1)) dates.push(date);

    const conflicts = [];
    for (const date of dates) {
      const midnight = localDateTimeToUtc(`${date}T00:00`, tz, 'later');
      const nextMidnight = localDateTimeToUtc(`${addLocalDate(date, 1)}T00:00`, tz, 'later');
      if (!midnight.ok || !nextMidnight.ok) continue;
      const segmentStart = Math.max(interval.occupiedStartMs, midnight.utcMs);
      const segmentEnd = Math.min(interval.occupiedEndMs, nextMidnight.utcMs);
      if (segmentEnd <= segmentStart) continue;

      const info = localRangesForDate(db, date);
      const openUtc = info.open.flatMap((r) => {
        // Closing at 24:00 is represented as next local midnight.
        const endText = r.end === '24:00' ? '00:00' : r.end;
        const endDate = r.end === '24:00' ? addLocalDate(date, 1) : date;
        const s = localDateTimeToUtc(`${date}T${r.start}`, tz, 'later');
        const e = localDateTimeToUtc(`${endDate}T${endText}`, tz, 'later');
        return s.ok && e.ok && e.utcMs > s.utcMs ? [{ startMs: s.utcMs, endMs: e.utcMs }] : [];
      });
      // Merge adjacent/overlapping same-day or DST/date-boundary ranges so an
      // overnight interval is not rejected merely because it crosses midnight.
      const covered = openUtc.some((r) => r.startMs <= segmentStart && segmentEnd <= r.endMs);
      if (!covered) {
        conflicts.push({
          type: 'availability',
          date,
          scheduleTimezone: tz,
          closed: Boolean(info.closed),
          availableRanges: info.open,
          requiredLocalStartUtc: iso(segmentStart),
          requiredLocalEndUtc: iso(segmentEnd),
          reason: info.closed
            ? info.reason
            : '交通、布置、正式拍摄、撤场与交通的完整区间必须落在营业时段内。'
        });
      }
    }
    return conflicts;
  }

  function makeWantedInterval(snapshot, startMs) {
    const interval = occupiedInterval(snapshot, startMs);
    return {
      startMs: interval.actualStartMs,
      endMs: interval.actualEndMs,
      occupiedStartMs: interval.occupiedStartMs,
      occupiedEndMs: interval.occupiedEndMs
    };
  }

  function validateStart(body, db) {
    if (!isValidTimeZone(body.timezone)) {
      throw new BookingError(400, 'invalid_timezone', '请提供 IANA 时区，例如 Asia/Shanghai 或 Europe/London。');
    }
    const converted = localDateTimeToUtc(body.startLocal, body.timezone, body.ambiguity || 'earlier');
    if (!converted.ok) {
      throw new BookingError(400, converted.reason, converted.reason === 'nonexistent_local_time'
        ? '该本地时间因夏令时跳变不存在，请选择另一个时间。'
        : '开始日期时间格式无效。');
    }
    return { startMs: converted.utcMs, ambiguous: converted.ambiguous };
  }

  function customerFromBody(body, partial = false) {
    const customer = {
      name: String(body.customer?.name || '').trim(),
      email: String(body.customer?.email || '').trim(),
      phone: String(body.customer?.phone || '').trim(),
      notes: String(body.customer?.notes || body.notes || '').trim()
    };
    const missing = [];
    if (!partial || body.customer?.name !== undefined) {
      if (!customer.name) missing.push('customer.name');
    }
    if (!partial || body.customer?.email !== undefined) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) missing.push('customer.email');
    }
    if (missing.length) throw new BookingError(400, 'invalid_customer', '缺少有效的客户姓名或邮箱。', { missing });
    return customer;
  }

  function hashCore(obj) {
    const stable = JSON.stringify(obj, Object.keys(obj).sort());
    let h = 5381;
    for (const i of Buffer.from(stable)) h = ((h << 5) + h + i) >>> 0;
    return h.toString(16);
  }

  function idempotencyRecord(db, action, key, core, factory) {
    if (!key) throw new BookingError(400, 'idempotency_key_required', '请提供 idempotencyKey，重复提交将返回同一结果。');
    const existing = db.idempotency.find((r) => r.action === action && r.key === key);
    if (existing) {
      if (existing.requestHash !== hashCore(core)) {
        throw new BookingError(409, 'idempotency_key_reused', '相同幂等键被用于不同请求。');
      }
      return { existing: db[existing.collection].find((x) => x.id === existing.entityId), record: existing };
    }
    const entity = factory();
    db.idempotency.push({
      action,
      key,
      requestHash: hashCore(core),
      createdAt: iso(Date.now()),
      collection: entity._collection,
      entityId: entity.id
    });
    return { existing: entity, record: null };
  }

  function waitingBookings(db) {
    return db.bookings.filter((b) => b.status === 'waiting').sort((a, b) =>
      Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.sequence - b.sequence);
  }

  function canLockBooking(db, booking, opts = {}) {
    const snapshot = booking.snapshot;
    const startMs = Date.parse(booking.startUtc);
    const wanted = makeWantedInterval(snapshot, startMs);
    const chosen = chooseResources(db, snapshot, wanted, booking.id, opts.extraOccupations || []);
    const availability = explainAvailability(db, wanted);
    const conflicts = [
      ...(chosen.ok ? [] : chosen.conflicts),
      ...(opts.queueConflicts || []),
      ...availability
    ];
    return { wanted, chosen, conflicts };
  }

  function pruneAndPromote(db, atMs = Date.now(), reason = 'automatic-expiry') {
    const expired = [];
    for (const hold of db.holds) {
      if (hold.status === 'active' && Date.parse(hold.expiresAt) <= atMs) {
        hold.status = 'expired';
        hold.releasedAt = iso(atMs);
        expired.push(hold);
      }
    }
    if (expired.length) {
      audit(db, 'holds.expired', {
        reason,
        at: iso(atMs),
        holds: expired.map((h) => ({ id: h.id, number: h.number, expiresAt: h.expiresAt, startUtc: h.startUtc }))
      });
    }

    const promoted = [];
    // FIFO among requests that compete for the same resources. A later,
    // independent request can be confirmed, but it cannot jump ahead when one of
    // its candidate resources is reserved by an earlier waiting request.
    const waiting = waitingBookings(db);
    for (const booking of waiting) {
      const earlierStillWaiting = waiting.filter((other) =>
        other.sequence < booking.sequence && other.status === 'waiting');
      const virtual = [];
      const queueConflicts = [];
      for (const other of earlierStillWaiting) {
        if (groupsCompete(other.snapshot, booking.snapshot) &&
            overlaps(makeWantedInterval(other.snapshot, Date.parse(other.startUtc)),
                     makeWantedInterval(booking.snapshot, Date.parse(booking.startUtc)))) {
          queueConflicts.push({
            type: 'queue',
            aheadBookingId: other.id,
            aheadBookingNumber: other.number,
            reason: '更早的排队请求尚未获得资源，不能让相同资源请求越过它。'
          });
          virtual.push(...queueVirtualOccupations(db, booking.snapshot,
            makeWantedInterval(booking.snapshot, Date.parse(booking.startUtc)), booking.id)
            .filter((o) => o.id === other.id));
        }
      }
      const check = canLockBooking(db, booking, { extraOccupations: virtual, queueConflicts });
      if (!check.chosen.ok || check.conflicts.length) continue;
      booking.status = 'confirmed';
      booking.resourceSelection = check.chosen.selection;
      booking.lockedAt = iso(atMs);
      booking.confirmedAt = iso(atMs);
      booking.confirmation = {
        type: 'automatic_queue_promotion',
        reason: expired.length ? '前置临时占位到期，队列按提交顺序恢复。' : '资源释放后自动确认。',
        at: iso(atMs)
      };
      promoted.push({ id: booking.id, number: booking.number });
      audit(db, 'booking.auto_confirmed', {
        bookingId: booking.id,
        number: booking.number,
        resources: booking.resourceSelection,
        reason: booking.confirmation.reason
      });
    }
    return { expired, promoted };
  }

  function createBookingFromSnapshot(db, body, pkg, startMs, customer, status, selection, atMs, extra = {}) {
    const snapshot = packageVersion(pkg);
    const sequence = db.counters.seq;
    const booking = {
      _collection: 'bookings',
      id: `booking-${randomUUID()}`,
      number: nextOrderNo(db, 'BK'),
      sequence,
      status,
      customer,
      snapshot,
      timezone: body.timezone,
      startLocal: body.startLocal,
      startUtc: iso(startMs),
      endUtc: iso(startMs + snapshot.durationMin * 60000),
      resourceSelection: selection || [],
      createdAt: iso(atMs),
      updatedAt: iso(atMs),
      ...extra
    };
    db.bookings.push(booking);
    return booking;
  }

  return {
    holdTtlMs,

    async submitBooking(body) {
      return store.transaction((db) => {
        const atMs = Date.now();
        pruneAndPromote(db, atMs, 'before-booking-submit');
        const pkg = getPackage(db, body.packageId);
        const { startMs } = validateStart(body, db);
        const customer = customerFromBody(body);
        const snapshot = packageVersion(pkg);
        const wanted = makeWantedInterval(snapshot, startMs);
        if (wanted.occupiedStartMs <= atMs) {
          throw new BookingError(400, 'occupancy_already_started', '交通或布置占用已经开始，不能新建预约。');
        }
        const core = {
          action: 'booking.submit', packageId: pkg.id, startLocal: body.startLocal,
          timezone: body.timezone, email: customer.email, name: customer.name
        };
        const { existing, record } = idempotencyRecord(db, 'booking.submit', body.idempotencyKey, core, () => {
          const blockers = competingWaiters(db, snapshot, wanted);
          const virtual = queueVirtualOccupations(db, snapshot, wanted);
          const chosen = chooseResources(db, snapshot, wanted, null, virtual);
          const availability = explainAvailability(db, wanted);
          if (chosen.ok && availability.length === 0 && blockers.length === 0) {
            return createBookingFromSnapshot(db, body, pkg, startMs, customer, 'confirmed', chosen.selection, atMs, {
              lockedAt: iso(atMs),
              confirmedAt: iso(atMs),
              confirmation: { type: 'instant', at: iso(atMs) }
            });
          }

          const conflicts = [
            ...(chosen.ok ? [] : chosen.conflicts),
            ...availability,
            ...(blockers.length ? blockers.map((waiter) => ({
              type: 'queue',
              aheadBookingId: waiter.id,
              aheadBookingNumber: waiter.number,
              reason: '已有更早且竞争同类资源的排队请求；为避免高峰插队，新请求进入等待确认。'
            })) : [])
          ];
          return createBookingFromSnapshot(db, body, pkg, startMs, customer, 'waiting', [], atMs, {
            queue: { submittedAt: iso(atMs), conflictsAtSubmit: conflicts }
          });
        });

        return {
          booking: publicBooking(existing),
          duplicate: Boolean(record),
          lockState: lockState(existing)
        };
      });
    },

    async createHold(body) {
      return store.transaction((db) => {
        const atMs = Date.now();
        pruneAndPromote(db, atMs, 'before-hold');
        const pkg = getPackage(db, body.packageId);
        const { startMs, ambiguous } = validateStart(body, db);
        const snapshot = packageVersion(pkg);
        const wanted = makeWantedInterval(snapshot, startMs);
        if (wanted.occupiedStartMs <= atMs) {
          throw new BookingError(400, 'occupancy_already_started', '交通或布置占用已经开始，不能新建临时占位。');
        }
        const core = {
          action: 'hold.create', packageId: pkg.id, startLocal: body.startLocal,
          timezone: body.timezone, email: body.customer?.email || '', name: body.customer?.name || ''
        };
        const ttl = Math.max(1000, Math.min(holdTtlMs, Number(body.ttlMs) && body.admin ? Number(body.ttlMs) : holdTtlMs));

        const { existing, record } = idempotencyRecord(db, 'hold.create', body.idempotencyKey, core, () => {
          const waiters = competingWaiters(db, snapshot, wanted);
          const chosen = chooseResources(db, snapshot, wanted, null, queueVirtualOccupations(db, snapshot, wanted));
          const availability = explainAvailability(db, wanted);
          if (!chosen.ok || availability.length || waiters.length) {
            const conflicts = [
              ...(chosen.ok ? [] : chosen.conflicts),
              ...availability,
              ...waiters.map((waiter) => ({ type: 'queue', aheadBookingNumber: waiter.number, reason: '已有队列请求等待该档期，不能用临时占位插队。' }))
            ];
            throw new BookingError(409, 'slot_unavailable', '该档期无法临时占位。', { conflicts, ttlMs: ttl });
          }
          const hold = {
            _collection: 'holds',
            id: `hold-${randomUUID()}`,
            number: nextOrderNo(db, 'HD'),
            status: 'active',
            customer: body.customer ? customerFromBody(body, true) : null,
            snapshot,
            timezone: body.timezone,
            startLocal: body.startLocal,
            startUtc: iso(startMs),
            endUtc: iso(startMs + snapshot.durationMin * 60000),
            resourceSelection: chosen.selection,
            ambiguousLocalTime: ambiguous,
            createdAt: iso(atMs),
            expiresAt: iso(atMs + ttl)
          };
          db.holds.push(hold);
          audit(db, 'hold.created', { holdId: hold.id, number: hold.number, startUtc: hold.startUtc, expiresAt: hold.expiresAt, resources: hold.resourceSelection });
          return hold;
        });

        return {
          hold: publicHold(existing),
          duplicate: Boolean(record),
          lockState: { kind: 'temporary_hold', locked: false, expiresAt: existing.expiresAt }
        };
      });
    },

    async confirmHold(body) {
      return store.transaction((db) => {
        const atMs = Date.now();
        const hold = db.holds.find((h) => h.id === body.holdId || h.number === body.holdId);
        if (!hold) throw new BookingError(404, 'hold_not_found', '临时占位不存在。');

        const byKey = db.idempotency.find((r) => r.action === 'hold.confirm' && r.key === body.idempotencyKey);
        if (byKey) {
          const booking = db.bookings.find((b) => b.id === byKey.entityId);
          if (booking) return { booking: publicBooking(booking), duplicate: true, lockState: lockState(booking) };
        }

        if (hold.status === 'used') {
          const booking = db.bookings.find((b) => b.sourceHoldId === hold.id);
          if (booking) return { booking: publicBooking(booking), duplicate: true, lockState: lockState(booking) };
        }
        if (hold.status === 'expired' || Date.parse(hold.expiresAt) <= atMs) {
          const promotion = pruneAndPromote(db, Math.max(atMs, Date.parse(hold.expiresAt)), 'hold-expired-at-confirm');
          throw new BookingError(410, 'hold_expired', '临时占位已到期，资源已恢复并可能分配给队列。', {
            promoted: promotion.promoted
          });
        }
        if (hold.status !== 'active') throw new BookingError(409, 'hold_not_active', '临时占位已不可用。');

        const customer = customerFromBody(body);
        const startMs = Date.parse(hold.startUtc);
        const bookingBody = {
          packageId: hold.snapshot.packageId,
          startLocal: hold.startLocal,
          timezone: hold.timezone
        };
        const core = {
          action: 'hold.confirm', hold: hold.id, name: customer.name,
          email: customer.email, startUtc: hold.startUtc, snapshotVersion: hold.snapshot.version
        };
        // idempotencyRecord also creates the booking exactly once.
        const { existing } = idempotencyRecord(db, 'hold.confirm', body.idempotencyKey, core, () => {
          const booking = createBookingFromSnapshot(db, bookingBody,
            { ...hold.snapshot, id: hold.snapshot.packageId, currentVersion: hold.snapshot.version,
              versions: [{ version: hold.snapshot.version, price: hold.snapshot.price, currency: hold.snapshot.currency,
                durationMin: hold.snapshot.durationMin, travelInMin: hold.snapshot.travelInMin, prepMin: hold.snapshot.prepMin,
                breakdownMin: hold.snapshot.breakdownMin, travelOutMin: hold.snapshot.travelOutMin,
                serviceScope: hold.snapshot.serviceScope, resourceGroups: hold.snapshot.resourceGroups }] },
            startMs, customer, 'confirmed', hold.resourceSelection, atMs, {
              sourceHoldId: hold.id,
              lockedAt: iso(atMs),
              confirmedAt: iso(atMs),
              confirmation: { type: 'hold_confirm', at: iso(atMs), holdNumber: hold.number }
            });
          hold.status = 'used';
          hold.usedAt = iso(atMs);
          hold.bookingId = booking.id;
          audit(db, 'hold.confirmed', { holdId: hold.id, bookingId: booking.id, number: booking.number });
          return booking;
        });
        return { booking: publicBooking(existing), duplicate: false, lockState: lockState(existing) };
      });
    },

    async lookupBooking(body) {
      return store.transaction((db) => {
        const booking = db.bookings.find((b) => (b.id === body.bookingId || b.number === body.bookingId || b.number === body.number) &&
          b.customer.email.toLowerCase() === String(body.email || '').toLowerCase().trim());
        if (!booking) throw new BookingError(404, 'booking_not_found', '未找到匹配的预约，请核对单号和预约邮箱。');
        return { booking: publicBooking(booking), lockState: lockState(booking) };
      });
    },

    async lookupHold(body) {
      return store.transaction((db) => {
        const hold = db.holds.find((h) => (h.id === body.holdId || h.number === body.holdId || h.number === body.number) &&
          (!body.email || h.customer?.email?.toLowerCase() === String(body.email).toLowerCase().trim()));
        if (!hold) throw new BookingError(404, 'hold_not_found', '未找到临时占位。');
        return { hold: publicHold(hold), lockState: { kind: 'temporary_hold', locked: false, expiresAt: hold.expiresAt } };
      });
    },

    async cancelBooking(body) {
      return store.transaction((db) => {
        const atMs = Date.now();
        const booking = db.bookings.find((b) => b.id === body.bookingId || b.number === body.bookingId);
        if (!booking) throw new BookingError(404, 'booking_not_found', '预约不存在。');
        if (CANCELED_STATUSES.has(booking.status)) {
          return { booking: publicBooking(booking), duplicate: true, lockState: lockState(booking) };
        }
        const occupiedStartMs = occupiedInterval(booking.snapshot, Date.parse(booking.startUtc)).occupiedStartMs;
        if (occupiedStartMs <= atMs) {
          throw new BookingError(409, 'occupancy_already_started', '交通、布置或正式拍摄占用已经开始，不能取消并释放资源；请在后台登记异常处理。');
        }
        if (!body.idempotencyKey) throw new BookingError(400, 'idempotency_key_required', '取消请求需要 idempotencyKey。');
        const existing = db.idempotency.find((r) => r.action === 'booking.cancel' && r.key === body.idempotencyKey);
        if (existing) return { booking: publicBooking(booking), duplicate: true, lockState: lockState(booking) };

        const previous = booking.status;
        booking.status = body.byAdmin ? 'admin_canceled' : 'customer_canceled';
        booking.canceledAt = iso(atMs);
        booking.cancelReason = body.reason || (body.byAdmin ? '后台取消' : '客户取消');
        booking.resourceSelection = [];
        booking.updatedAt = iso(atMs);
        db.idempotency.push({
          action: 'booking.cancel', key: body.idempotencyKey, requestHash: hashCore({ id: booking.id }),
          createdAt: iso(atMs), collection: 'bookings', entityId: booking.id
        });
        audit(db, 'booking.canceled', {
          bookingId: booking.id, number: booking.number, previousStatus: previous, byAdmin: Boolean(body.byAdmin), reason: booking.cancelReason
        });
        const promotion = pruneAndPromote(db, atMs, 'after-booking-cancel');
        return { booking: publicBooking(booking), duplicate: false, promotion, lockState: lockState(booking) };
      });
    },

    async adminReschedule(body) {
      return store.transaction((db) => {
        const atMs = Date.now();
        pruneAndPromote(db, atMs, 'before-admin-reschedule');
        const booking = db.bookings.find((b) => b.id === body.bookingId || b.number === body.bookingId);
        if (!booking) throw new BookingError(404, 'booking_not_found', '预约不存在。');
        if (!ACTIVE_LOCK_STATUSES.has(booking.status) && booking.status !== 'waiting') {
          throw new BookingError(409, 'booking_not_active', '只有等待确认或已锁定预约可以改期。');
        }
        const originalOccupiedStartMs = occupiedInterval(booking.snapshot, Date.parse(booking.startUtc)).occupiedStartMs;
        if (originalOccupiedStartMs <= atMs) {
          throw new BookingError(409, 'occupancy_already_started', '原档期的交通、布置或正式拍摄已经开始，不能再改期或释放资源。');
        }
        if (!body.reason) throw new BookingError(400, 'reason_required', '人工改期必须填写原因并写入记录。');
        const { startMs, ambiguous } = validateStart(body, db);
        const wantedNew = makeWantedInterval(booking.snapshot, startMs);
        if (wantedNew.occupiedStartMs <= atMs) throw new BookingError(400, 'occupancy_already_started', '新档期的交通或布置时间必须仍在未来。');

        const wanted = wantedNew;
        const chosen = chooseResources(db, booking.snapshot, wanted, booking.id);
        const availability = explainAvailability(db, wanted);
        const conflicts = [...(chosen.ok ? [] : chosen.conflicts), ...availability];

        if (conflicts.length && !body.force) {
          audit(db, 'booking.reschedule_blocked', {
            bookingId: booking.id,
            number: booking.number,
            requestedStartUtc: iso(startMs),
            conflicts
          });
          throw new BookingError(409, 'reschedule_conflict', '改期存在冲突；后台可阅读原因后，明确强制覆盖。', { conflicts });
        }

        const previous = {
          startLocal: booking.startLocal,
          startUtc: booking.startUtc,
          timezone: booking.timezone,
          resourceSelection: booking.resourceSelection
        };
        booking.startLocal = body.startLocal;
        booking.timezone = body.timezone;
        booking.startUtc = iso(startMs);
        booking.endUtc = iso(startMs + booking.snapshot.durationMin * 60000);
        booking.ambiguousLocalTime = ambiguous;
        booking.resourceSelection = chosen.ok ? chosen.selection : booking.resourceSelection;
        booking.forcedOverlap = booking.forcedOverlap || (conflicts.length > 0);
        booking.updatedAt = iso(atMs);
        booking.rescheduleHistory = booking.rescheduleHistory || [];
        booking.rescheduleHistory.push({
          at: iso(atMs),
          actor: 'admin',
          reason: body.reason,
          forced: conflicts.length > 0,
          conflictExplanation: conflicts,
          from: previous,
          to: { startLocal: booking.startLocal, startUtc: booking.startUtc, timezone: booking.timezone, resourceSelection: booking.resourceSelection }
        });
        if (booking.status === 'waiting') {
          // A waiting request moved by staff remains waiting unless it can now lock.
          const check = canLockBooking(db, booking, { force: body.force });
          if ((check.chosen.ok && check.conflicts.length === 0) || body.force) {
            booking.status = 'confirmed';
            booking.resourceSelection = check.chosen.ok ? check.chosen.selection : fallbackSelection(db, booking.snapshot);
            booking.lockedAt = iso(atMs);
            booking.confirmedAt = iso(atMs);
            booking.confirmation = { type: 'admin_manual', reason: body.reason, at: iso(atMs) };
          }
        }
        audit(db, 'booking.rescheduled', {
          bookingId: booking.id,
          number: booking.number,
          reason: body.reason,
          forced: conflicts.length > 0,
          conflicts,
          previous,
          to: booking.rescheduleHistory.at(-1).to
        });
        return { booking: adminBooking(booking), conflicts: body.force ? conflicts : [], lockState: lockState(booking) };
      });
    },

    async adminConfirm(body) {
      return store.transaction((db) => {
        const atMs = Date.now();
        pruneAndPromote(db, atMs, 'before-admin-confirm');
        const booking = db.bookings.find((b) => b.id === body.bookingId || b.number === body.bookingId);
        if (!booking) throw new BookingError(404, 'booking_not_found', '预约不存在。');
        if (booking.status !== 'waiting') throw new BookingError(409, 'not_waiting', '该预约不在等待确认状态。');
        const check = canLockBooking(db, booking, { force: body.force });
        if (check.conflicts.length && !body.force) {
          throw new BookingError(409, 'cannot_confirm', '当前仍有冲突。', { conflicts: check.conflicts });
        }
        booking.status = 'confirmed';
        booking.resourceSelection = check.chosen.ok ? check.chosen.selection : fallbackSelection(db, booking.snapshot);
        booking.lockedAt = iso(atMs);
        booking.confirmedAt = iso(atMs);
        booking.forcedOverlap = booking.forcedOverlap || check.conflicts.length > 0;
        booking.confirmation = { type: 'admin_manual', reason: body.reason || '后台人工确认', at: iso(atMs), conflicts: check.conflicts };
        booking.updatedAt = iso(atMs);
        audit(db, 'booking.admin_confirmed', { bookingId: booking.id, number: booking.number, forced: check.conflicts.length > 0, conflicts: check.conflicts });
        return { booking: adminBooking(booking), conflicts: check.conflicts };
      });
    },

    pruneAndPromote(atMs = Date.now(), reason = 'manual-maintenance') {
      return store.transaction((db) => pruneAndPromote(db, atMs, reason));
    },

    snapshotForRead() {
      return store.read();
    }
  };
}

export function lockState(booking) {
  if (booking.status === 'waiting') {
    return {
      kind: 'waiting_confirmation',
      locked: false,
      label: '等待确认',
      description: '请求已提交但没有占用摄影师、助手或器材；释放或占位到期后按队列顺序确认。'
    };
  }
  if (booking.status === 'confirmed' || booking.status === 'offered') {
    return {
      kind: 'locked',
      locked: true,
      label: booking.status === 'offered' ? '已锁定待确认条款' : '已锁定',
      description: '完整档期（含交通、布置、拍摄、撤场与交通）及所选资源已占用。'
    };
  }
  if (CANCELED_STATUSES.has(booking.status)) {
    return { kind: 'canceled', locked: false, label: '已取消', description: '不再占用资源。' };
  }
  return { kind: booking.status, locked: false, label: booking.status };
}

function publicBooking(b) {
  return {
    id: b.id,
    number: b.number,
    status: b.status,
    customer: { name: b.customer.name, email: b.customer.email, phone: b.customer.phone },
    snapshot: b.snapshot,
    timezone: b.timezone,
    startLocal: b.startLocal,
    startUtc: b.startUtc,
    endUtc: b.endUtc,
    occupiedStartUtc: iso(occupiedInterval(b.snapshot, Date.parse(b.startUtc)).occupiedStartMs),
    occupiedEndUtc: iso(occupiedInterval(b.snapshot, Date.parse(b.startUtc)).occupiedEndMs),
    resourceSelection: b.resourceSelection,
    createdAt: b.createdAt,
    confirmedAt: b.confirmedAt,
    canceledAt: b.canceledAt,
    cancelReason: b.cancelReason,
    sourceHoldId: b.sourceHoldId,
    queue: b.queue,
    confirmation: b.confirmation
  };
}

function publicHold(h) {
  return {
    id: h.id,
    number: h.number,
    status: h.status,
    snapshot: h.snapshot,
    timezone: h.timezone,
    startLocal: h.startLocal,
    startUtc: h.startUtc,
    endUtc: h.endUtc,
    occupiedStartUtc: iso(occupiedInterval(h.snapshot, Date.parse(h.startUtc)).occupiedStartMs),
    occupiedEndUtc: iso(occupiedInterval(h.snapshot, Date.parse(h.startUtc)).occupiedEndMs),
    resourceSelection: h.resourceSelection,
    createdAt: h.createdAt,
    expiresAt: h.expiresAt,
    usedAt: h.usedAt,
    releasedAt: h.releasedAt,
    bookingId: h.bookingId
  };
}

function adminBooking(b) {
  return {
    ...publicBooking(b),
    customer: b.customer,
    forcedOverlap: b.forcedOverlap,
    rescheduleHistory: b.rescheduleHistory || [],
    updatedAt: b.updatedAt
  };
}

export const bookingViews = { publicBooking, publicHold, adminBooking, lockState, makeWantedInterval: (snapshot, ms) => ({
  occupiedStartMs: occupiedInterval(snapshot, ms).occupiedStartMs,
  occupiedEndMs: occupiedInterval(snapshot, ms).occupiedEndMs,
  actualStartMs: ms,
  actualEndMs: ms + snapshot.durationMin * 60000
}) };
