const db = require('./db');

const ACTIVE_RESOURCE_STATUSES = ['held', 'confirmed'];
const PHASE_META = [
  ['travel_before', '前往现场', 'travel_before_minutes'],
  ['setup', '布置与测光', 'setup_minutes'],
  ['shoot', '正式拍摄', 'duration_minutes'],
  ['teardown', '撤场', 'teardown_minutes'],
  ['travel_after', '返程/转场', 'travel_after_minutes']
];

function nowIso() {
  return new Date().toISOString();
}

function parseIso(value) {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw Object.assign(new Error('时间必须是 ISO 8601，例如 2026-10-20T02:00:00Z'), { status: 400 });
  return new Date(ms);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function iso(date) {
  return date.toISOString();
}

function validTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function overlap(aStart, aEnd, bStart, bEnd) {
  return Date.parse(aStart) < Date.parse(bEnd) && Date.parse(bStart) < Date.parse(aEnd);
}

function minutesBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 60000);
}

function buildPhases(pkg, startDate) {
  const phases = [];
  let cursor = startDate;
  for (const [type, label, key] of PHASE_META) {
    const duration = Number(pkg[key === 'duration_minutes' ? 'duration_minutes' : key]);
    const end = addMinutes(cursor, duration);
    phases.push({ phase_type: type, phase_label: label, phase_start: iso(cursor), phase_end: iso(end) });
    cursor = end;
  }
  return phases;
}

function packageResourceIds(pkgId, supplied = []) {
  const requested = supplied.map(Number).filter(Number.isInteger);
  const required = db.prepare(`
    SELECT pr.resource_id, r.type, r.name, pr.role
    FROM package_resources pr JOIN resources r ON r.id = pr.resource_id
    WHERE pr.package_id=? AND r.is_active=1
    ORDER BY CASE r.type WHEN 'photographer' THEN 1 WHEN 'assistant' THEN 2 WHEN 'equipment' THEN 3 ELSE 4 END, r.id
  `).all(pkgId);
  if (requested.length) {
    const allowed = new Map(required.map(x => [x.resource_id, x]));
    const missing = requested.filter(id => !allowed.has(id));
    if (missing.length) throw Object.assign(new Error(`资源不属于该套餐或不可用: ${missing.join(',')}`), { status: 400 });
    return requested;
  }
  return required.filter(x => x.role === 'required').map(x => x.resource_id);
}

function resourceMap(resourceIds) {
  const ids = [...new Set(resourceIds)];
  const rows = db.prepare(`SELECT id,type,name FROM resources WHERE id IN (${ids.map(()=>'?').join(',')}) AND is_active=1`).all(...ids);
  return new Map(rows.map(r => [r.id, r]));
}

function explainConflicts(phasesByResource, excludeBookingId = null, options = {}) {
  if (!options.skipExpiry) expireHolds();
  const conflicts = [];
  const ids = [...phasesByResource.keys()];
  if (!ids.length) return conflicts;
  const placeholders = ids.map(() => '?').join(',');
  const activeRows = db.prepare(`
    SELECT br.booking_id, br.resource_id, br.phase_type, br.phase_label, br.phase_start, br.phase_end,
           b.public_ref, b.status, b.customer_name, r.name AS resource_name, r.type AS resource_type
    FROM booking_resources br
    JOIN bookings b ON b.id=br.booking_id
    JOIN resources r ON r.id=br.resource_id
    WHERE br.resource_id IN (${placeholders})
      AND b.status IN ('held','confirmed')
      AND (? IS NULL OR br.booking_id <> ?)
  `).all(...ids, excludeBookingId, excludeBookingId);

  for (const [resourceId, phases] of phasesByResource) {
    for (const phase of phases) {
      for (const row of activeRows) {
        if (row.resource_id !== resourceId) continue;
        if (overlap(phase.phase_start, phase.phase_end, row.phase_start, row.phase_end)) {
          conflicts.push({
            type: 'booking',
            resource: { id: row.resource_id, type: row.resource_type, name: row.resource_name },
            requested_phase: phase,
            existing: {
              booking_ref: row.public_ref,
              status: row.status,
              customer_name: row.customer_name,
              phase_type: row.phase_type,
              phase_label: row.phase_label,
              phase_start: row.phase_start,
              phase_end: row.phase_end
            },
            overlap_minutes: Math.min(minutesBetween(phase.phase_start, row.phase_end), minutesBetween(row.phase_start, phase.phase_end))
          });
        }
      }
    }
  }

  const blockRows = db.prepare(`
    SELECT bl.id, bl.resource_id, bl.start_at, bl.end_at, bl.reason, r.name AS resource_name, r.type AS resource_type
    FROM blocks bl JOIN resources r ON r.id=bl.resource_id
    WHERE bl.resource_id IN (${placeholders})
  `).all(...ids);
  for (const [resourceId, phases] of phasesByResource) {
    for (const phase of phases) {
      for (const block of blockRows) {
        if (block.resource_id !== resourceId) continue;
        if (overlap(phase.phase_start, phase.phase_end, block.start_at, block.end_at)) {
          conflicts.push({
            type: 'admin_block',
            resource: { id: block.resource_id, type: block.resource_type, name: block.resource_name },
            requested_phase: phase,
            existing: { block_id: block.id, reason: block.reason, phase_start: block.start_at, phase_end: block.end_at },
            overlap_minutes: Math.min(minutesBetween(phase.phase_start, block.end_at), minutesBetween(block.start_at, phase.phase_end))
          });
        }
      }
    }
  }
  return conflicts;
}

function makePhasesByResource(pkg, startIso, resourceIds) {
  const start = parseIso(startIso);
  const phases = buildPhases(pkg, start);
  const map = new Map();
  for (const id of [...new Set(resourceIds)]) map.set(id, phases);
  return map;
}

function allocateResources(bookingId, phasesByResource) {
  const insert = db.prepare(`INSERT INTO booking_resources(booking_id,resource_id,phase_type,phase_label,phase_start,phase_end)
    VALUES(?,?,?,?,?,?)`);
  for (const [resourceId, phases] of phasesByResource) {
    for (const p of phases) insert.run(bookingId, resourceId, p.phase_type, p.phase_label, p.phase_start, p.phase_end);
  }
}

function deallocateResources(bookingId) {
  db.prepare('DELETE FROM booking_resources WHERE booking_id=?').run(bookingId);
}

function expireHolds(actor = 'system') {
  const now = nowIso();
  const rows = db.prepare("SELECT id,public_ref FROM bookings WHERE status='held' AND hold_expires_at <= ?").all(now);
  const update = db.prepare("UPDATE bookings SET status='cancelled', cancelled_at=?, updated_at=? WHERE id=? AND status='held' AND hold_expires_at<=?");
  const log = db.prepare('INSERT INTO audit_logs(booking_id,action,detail,actor) VALUES(?,?,?,?)');
  const deleteResources = db.prepare('DELETE FROM booking_resources WHERE booking_id=?');
  const expireOne = db.transaction((row) => {
    deleteResources.run(row.id);
    update.run(now, now, row.id, now);
    log.run(row.id, 'hold_expired', '短租约占位到期未确认，资源自动恢复。', actor);
  });
  for (const row of rows) expireOne.immediate(row);
  return rows.length;
}

function nextQueuePosition() {
  const row = db.prepare('SELECT COALESCE(MAX(queue_position),0)+1 AS n FROM bookings WHERE status=?').get('queued');
  return row.n;
}

function snapshotPackage(pkg) {
  return {
    id: pkg.id,
    slug: pkg.slug,
    name: pkg.name,
    description: pkg.description,
    price_cents: pkg.current_price_cents,
    currency: pkg.currency,
    duration_minutes: pkg.duration_minutes,
    travel_before_minutes: pkg.travel_before_minutes,
    setup_minutes: pkg.setup_minutes,
    teardown_minutes: pkg.teardown_minutes,
    travel_after_minutes: pkg.travel_after_minutes,
    included_scope: JSON.parse(pkg.included_scope || '[]'),
    package_version: pkg.version,
    quoted_at: nowIso()
  };
}

function publicRef() {
  const bytes = require('crypto').randomBytes(4).toString('hex').toUpperCase();
  return `BK-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${bytes}`;
}

module.exports = {
  ACTIVE_RESOURCE_STATUSES,
  addMinutes,
  allocateResources,
  buildPhases,
  deallocateResources,
  expireHolds,
  explainConflicts,
  iso,
  makePhasesByResource,
  nextQueuePosition,
  nowIso,
  packageResourceIds,
  parseIso,
  publicRef,
  resourceMap,
  snapshotPackage,
  validTimeZone
};
