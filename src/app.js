const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const sched = require('./scheduling');

const router = express.Router();
const immediate = fn => db.transaction(fn).immediate();
const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 5 * 60 * 1000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-admin-token';

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, extra });
}

function requireAdmin(req, res, next) {
  if (req.get('x-admin-token') !== ADMIN_TOKEN) return next(httpError(401, '需要后台令牌'));
  next();
}

function bodyRequired(req, keys) {
  const missing = keys.filter(k => req.body[k] === undefined || req.body[k] === null || req.body[k] === '');
  if (missing.length) throw httpError(400, `缺少字段: ${missing.join(', ')}`);
}

function getPackageOr404(id) {
  const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(Number(id));
  if (!pkg) throw httpError(404, '套餐不存在');
  return pkg;
}

function getBookingByRef(ref) {
  const b = db.prepare('SELECT * FROM bookings WHERE public_ref=?').get(ref);
  if (!b) throw httpError(404, '预约不存在');
  return b;
}

function packagePublic(pkg) {
  return {
    id: pkg.id, slug: pkg.slug, name: pkg.name, description: pkg.description,
    duration_minutes: pkg.duration_minutes,
    travel_before_minutes: pkg.travel_before_minutes,
    setup_minutes: pkg.setup_minutes,
    teardown_minutes: pkg.teardown_minutes,
    travel_after_minutes: pkg.travel_after_minutes,
    included_scope: JSON.parse(pkg.included_scope || '[]'),
    price_cents: pkg.current_price_cents,
    currency: pkg.currency,
    version: pkg.version,
    is_active: !!pkg.is_active
  };
}

function loadPhasesByResource(bookingId) {
  const rows = db.prepare(`
    SELECT resource_id, phase_type, phase_label, phase_start, phase_end
    FROM booking_resources WHERE booking_id=? ORDER BY resource_id, phase_start
  `).all(bookingId);
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.resource_id)) map.set(row.resource_id, []);
    map.get(row.resource_id).push({
      phase_type: row.phase_type, phase_label: row.phase_label,
      phase_start: row.phase_start, phase_end: row.phase_end
    });
  }
  return map;
}

function mapToResourcePhases(bookingId) {
  const rows = db.prepare(`
    SELECT r.name AS resource_name, br.phase_type, br.phase_label, br.phase_start, br.phase_end
    FROM booking_resources br JOIN resources r ON r.id=br.resource_id
    WHERE br.booking_id=? ORDER BY r.id, br.phase_start
  `).all(bookingId);
  const out = {};
  for (const row of rows) {
    out[row.resource_name] ||= [];
    out[row.resource_name].push({
      phase_type: row.phase_type, phase_label: row.phase_label,
      phase_start: row.phase_start, phase_end: row.phase_end
    });
  }
  return out;
}

function bookingDetail(row) {
  if (!row) return null;
  const resources = db.prepare(`
    SELECT br.resource_id, r.type, r.name, br.phase_type, br.phase_label, br.phase_start, br.phase_end
    FROM booking_resources br JOIN resources r ON r.id=br.resource_id
    WHERE br.booking_id=? ORDER BY r.id, br.phase_start
  `).all(row.id);
  return {
    id: row.id,
    public_ref: row.public_ref,
    status: row.status,
    customer_name: row.customer_name,
    customer_contact: row.customer_contact,
    note: row.note,
    start_at: row.start_at,
    end_at: row.end_at,
    timezone: row.timezone,
    locked_at: row.locked_at,
    hold_expires_at: row.hold_expires_at,
    confirmed_at: row.confirmed_at,
    cancelled_at: row.cancelled_at,
    queue_position: row.queue_position,
    price_cents: row.price_cents,
    currency: row.currency,
    package_snapshot: JSON.parse(row.package_snapshot),
    resources,
    status_explanation: {
      draft: '仅为本地/草稿输入，尚未占用资源。',
      held: '短期占位：请求成功但仍会在截止时间过期，必须确认后才锁定。',
      queued: '等待确认：已进入排队，不锁定摄影师、助手或器材。',
      confirmed: '已锁定：资源和价格均已确认。',
      cancelled: '已取消：未开始的资源占用已释放。',
      completed: '已完成。'
    }[row.status]
  };
}

function currentPhasesForBooking(booking) {
  const snap = JSON.parse(booking.package_snapshot);
  const resourceIds = db.prepare('SELECT resource_id FROM booking_resources WHERE booking_id=?').all(booking.id).map(x => x.resource_id);
  return sched.makePhasesByResource(snap, booking.start_at, [...new Set(resourceIds)]);
}

function ensureFuture(phasesByResource) {
  const starts = [...phasesByResource.values()].flat().map(p => Date.parse(p.phase_start)).sort((a,b)=>a-b);
  if (starts[0] <= Date.now()) throw httpError(400, '只能为未来时间创建或调整预约');
}

function earliestPhaseStart(bookingId) {
  const row = db.prepare('SELECT MIN(phase_start) AS s FROM booking_resources WHERE booking_id=?').get(bookingId);
  return row && row.s ? row.s : null;
}

function log(bookingId, action, detail, actor = 'system') {
  db.prepare('INSERT INTO audit_logs(booking_id,action,detail,actor) VALUES(?,?,?,?)')
    .run(bookingId, action, typeof detail === 'string' ? detail : JSON.stringify(detail), actor);
}

// ---------- Public gallery ----------
router.get('/styles', (req, res) => {
  const styles = db.prepare(`
    SELECT s.*, COUNT(a.id) AS album_count
    FROM styles s LEFT JOIN albums a ON a.style_id=s.id AND a.is_public=1
    GROUP BY s.id ORDER BY s.sort_order, s.name
  `).all();
  res.json({ styles });
});

function publishedAlbumsQuery(where = '', params = []) {
  return db.prepare(`
    SELECT a.*, s.slug AS style_slug, s.name AS style_name,
           p.id AS photo_id, p.url AS photo_url, p.title AS photo_title, p.sort_order AS photo_sort_order,
           p.published_public_license AS public_license, p.published_version AS photo_version
    FROM albums a
    JOIN styles s ON s.id=a.style_id
    LEFT JOIN photos p ON p.album_id=a.id
      AND p.published_public_license=1
      AND p.published_version=a.published_version
    WHERE a.is_public=1 ${where}
    ORDER BY a.id, p.sort_order
  `).all(...params);
}

function hydratePublishedAlbums(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.id)) {
      map.set(row.id, {
        id: row.id, title: row.title, description: row.description,
        style: { slug: row.style_slug, name: row.style_name },
        version: row.published_version,
        photos: [],
        cover: null
      });
    }
    if (row.photo_id) {
      map.get(row.id).photos.push({
        id: row.photo_id, url: row.photo_url, title: row.photo_title,
        sort_order: row.photo_sort_order, version: row.photo_version
      });
    }
  }
  for (const album of map.values()) {
    const coverRow = db.prepare(`
      SELECT p.id,p.url,p.title,p.sort_order,p.published_version AS version
      FROM photos p JOIN albums a ON a.id=p.album_id
      WHERE a.id=? AND p.id=a.cover_photo_id AND p.published_public_license=1
        AND p.published_version=a.published_version
    `).get(album.id);
    album.cover = coverRow || album.photos[0] || null;
  }
  return [...map.values()];
}

router.get('/albums', (req, res) => {
  const rows = req.query.style ? publishedAlbumsQuery('AND s.slug=?', [req.query.style]) : publishedAlbumsQuery();
  res.json({ albums: hydratePublishedAlbums(rows) });
});

router.get('/albums/:id', (req, res) => {
  const rows = publishedAlbumsQuery('AND a.id=?', [Number(req.params.id)]);
  const albums = hydratePublishedAlbums(rows);
  if (!albums.length) throw httpError(404, '公开相册不存在或尚未发布授权照片');
  res.json({ album: albums[0] });
});

// ---------- Public catalog / availability ----------
router.get('/resources', (req, res) => {
  res.json({ resources: db.prepare('SELECT id,type,name,is_active FROM resources WHERE is_active=1 ORDER BY type,id').all() });
});

router.get('/packages', (req, res) => {
  const rows = db.prepare('SELECT * FROM packages WHERE is_active=1 ORDER BY id').all();
  const packageResources = db.prepare(`
    SELECT pr.package_id, r.id, r.type, r.name, pr.role
    FROM package_resources pr JOIN resources r ON r.id=pr.resource_id
    WHERE r.is_active=1 ORDER BY r.type, r.id
  `).all();
  const byPkg = new Map(rows.map(p => [p.id, []]));
  packageResources.forEach(x => byPkg.get(x.package_id)?.push({ id:x.id, type:x.type, name:x.name, role:x.role }));
  res.json({ packages: rows.map(p => ({ ...packagePublic(p), resources: byPkg.get(p.id) || [] })) });
});

router.get('/availability', (req, res) => {
  const pkg = getPackageOr404(req.query.package_id);
  if (!pkg.is_active) throw httpError(400, '套餐已下架');
  if (!req.query.start_at) throw httpError(400, '缺少 start_at');
  const tz = req.query.timezone || 'UTC';
  if (!sched.validTimeZone(tz)) throw httpError(400, '无效 IANA 时区，例如 Asia/Shanghai');
  const selected = req.query.resources ? String(req.query.resources).split(',').filter(Boolean) : [];
  const resourceIds = sched.packageResourceIds(pkg.id, selected);
  const startUtc = sched.iso(sched.parseIso(req.query.start_at));
  const phasesByResource = sched.makePhasesByResource(pkg, startUtc, resourceIds);
  const conflicts = sched.explainConflicts(phasesByResource);
  const resources = [...sched.resourceMap(resourceIds).values()];
  res.json({
    available: conflicts.length === 0,
    timezone: tz,
    shoot_start_at: startUtc,
    phases: phasesByResource.get(resourceIds[0]) || sched.buildPhases(pkg, sched.parseIso(startUtc)),
    resources,
    conflicts
  });
});

// ---------- Booking draft / hold / queue / confirm / cancel ----------
router.post('/bookings/preview', (req, res) => {
  const pkg = getPackageOr404(req.body.package_id);
  const tz = req.body.timezone || 'UTC';
  if (!sched.validTimeZone(tz)) throw httpError(400, '无效 IANA 时区');
  const resourceIds = sched.packageResourceIds(pkg.id, req.body.resource_ids || []);
  const startUtc = sched.iso(sched.parseIso(req.body.start_at));
  const phasesByResource = sched.makePhasesByResource(pkg, startUtc, resourceIds);
  const snapshot = sched.snapshotPackage(pkg);
  res.json({
    draft: {
      package: snapshot,
      start_at: startUtc,
      timezone: tz,
      customer_name: req.body.customer_name || '',
      customer_contact: req.body.customer_contact || '',
      resource_ids: resourceIds,
      resources: [...sched.resourceMap(resourceIds).values()],
      phases: phasesByResource.get(resourceIds[0]),
      end_at: phasesByResource.get(resourceIds[0]).at(-1).phase_end
    },
    note: '预览不创建预约，也不锁定档期。'
  });
});

router.post('/bookings', (req, res) => {
  bodyRequired(req, ['package_id','start_at','timezone','customer_name','customer_contact','mode']);
  const pkg = getPackageOr404(req.body.package_id);
  if (!pkg.is_active) throw httpError(400, '套餐已下架');
  if (!['hold','queue'].includes(req.body.mode)) throw httpError(400, 'mode 必须是 hold 或 queue');
  if (!sched.validTimeZone(req.body.timezone)) throw httpError(400, '无效 IANA 时区，例如 Asia/Shanghai');
  const startUtc = sched.iso(sched.parseIso(req.body.start_at));
  const resourceIds = sched.packageResourceIds(pkg.id, req.body.resource_ids || []);
  const phasesByResource = sched.makePhasesByResource(pkg, startUtc, resourceIds);
  ensureFuture(phasesByResource);
  const idem = req.body.idempotency_key ? String(req.body.idempotency_key).slice(0,120) : null;

  sched.expireHolds();
  const tx = db.transaction(() => {
    if (idem) {
      const old = db.prepare('SELECT * FROM bookings WHERE idempotency_key=?').get(idem);
      if (old) return { existing: bookingDetail(old), duplicated: true };
    }
    const snapshot = sched.snapshotPackage(pkg);
    const phases = phasesByResource.get(resourceIds[0]);
    const ref = sched.publicRef();
    const now = sched.nowIso();
    const status = req.body.mode === 'hold' ? 'held' : 'queued';
    const info = {
      ref, idem, pkgId: pkg.id, snapshot: JSON.stringify(snapshot),
      name: String(req.body.customer_name).slice(0,80),
      contact: String(req.body.customer_contact).slice(0,160),
      status, start: startUtc, end: phases.at(-1).phase_end,
      tz: req.body.timezone, price: snapshot.price_cents, currency: snapshot.currency,
      note: String(req.body.note || '').slice(0,500), now
    };

    let conflicts = [];
    if (status === 'held') conflicts = sched.explainConflicts(phasesByResource, null, { skipExpiry: true });
    if (status === 'held' && conflicts.length) {
      return { conflicts };
    }

    const result = db.prepare(`INSERT INTO bookings
      (public_ref,idempotency_key,package_id,package_snapshot,customer_name,customer_contact,status,start_at,end_at,timezone,
       locked_at,hold_expires_at,queue_position,price_cents,currency,note,created_at,updated_at)
      VALUES(@ref,@idem,@pkgId,@snapshot,@name,@contact,@status,@start,@end,@tz,
        CASE @status WHEN 'held' THEN @now END,
        CASE @status WHEN 'held' THEN @holdEnd END,
        CASE @status WHEN 'queued' THEN @queuePos END,
        @price,@currency,@note,@now,@now)`).run({
          ...info,
          holdEnd: new Date(Date.now() + HOLD_TTL_MS).toISOString(),
          queuePos: status === 'queued' ? sched.nextQueuePosition() : null
        });
    const id = result.lastInsertRowid;
    sched.allocateResources(id, phasesByResource);
    log(id, status === 'held' ? 'hold_created' : 'queued_created',
      status === 'held' ? `创建短租约占位，${HOLD_TTL_MS/1000}秒内确认。` : '高峰竞争：提交后进入等待确认队列，未锁定资源。',
      'customer');
    return { booking: bookingDetail(db.prepare('SELECT * FROM bookings WHERE id=?').get(id)) };
  });

  const out = immediate(tx);
  if (out.conflicts) return res.status(409).json({
    error: '所选摄影师、助手、器材或后台档期冲突',
    phases: phasesByResource.get(resourceIds[0]),
    conflicts: out.conflicts
  });
  if (out.existing) return res.status(200).json({ booking: out.existing, idempotent_replay: true, notice: '重复请求返回原预约，未创建第二份。' });
  res.status(201).json(out);
});

router.get('/bookings/:ref', (req, res) => res.json({ booking: bookingDetail(getBookingByRef(req.params.ref)) }));

router.post('/bookings/:ref/confirm', (req, res) => {
  const ref = req.params.ref;
  sched.expireHolds();
  const tx = db.transaction(() => {
    const b = getBookingByRef(ref);
    if (b.status === 'confirmed') return { booking: bookingDetail(b), idempotent_replay: true };
    if (b.status !== 'held') {
      if (b.status === 'cancelled') return { expired: true };
      return { invalid: { status: b.status, message: '只有未过期占位可以确认。排队请求须由后台确认。' } };
    }
    if (b.hold_expires_at <= sched.nowIso()) {
      sched.deallocateResources(b.id);
      db.prepare("UPDATE bookings SET status='cancelled',cancelled_at=?,updated_at=? WHERE id=?").run(sched.nowIso(), sched.nowIso(), b.id);
      log(b.id, 'hold_expired', '确认与过期竞争：过期先发生，占用已释放。', 'system');
      return { expired: true };
    }
    const phases = currentPhasesForBooking(b);
    const conflicts = sched.explainConflicts(phases, b.id, { skipExpiry: true });
    if (conflicts.length) return { conflicts };
    db.prepare("UPDATE bookings SET status='confirmed',confirmed_at=?,updated_at=? WHERE id=?").run(sched.nowIso(), sched.nowIso(), b.id);
    log(b.id, 'customer_confirmed', '客户在占位期限内确认，资源正式锁定；报价快照保留。', 'customer');
    return { booking: bookingDetail(db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id)) };
  });
  const out = immediate(tx);
  if (out.conflicts) return res.status(409).json({ error: '确认时发现冲突', conflicts: out.conflicts });
  if (out.expired) return res.status(410).json({ error: '占位刚好到期，资源已恢复，请重新排队或选择其他时间。' });
  if (out.invalid) return res.status(409).json({ error: out.invalid.message, status: out.invalid.status });
  res.json(out);
});

function cancelBooking(ref, actor, reason) {
  sched.expireHolds();
  const tx = db.transaction(() => {
    const b = getBookingByRef(ref);
    if (b.status === 'cancelled') return { booking: bookingDetail(b), idempotent_replay: true, notice: '预约此前已取消，未重复释放。' };
    if (!['held','queued','confirmed'].includes(b.status)) return { invalid: { status: b.status, message: '当前状态不能取消。' } };
    const firstStart = earliestPhaseStart(b.id);
    if (firstStart && Date.parse(firstStart) <= Date.now()) {
      return { started: true, first_phase_start: firstStart };
    }
    sched.deallocateResources(b.id);
    db.prepare("UPDATE bookings SET status='cancelled',cancelled_at=?,queue_position=NULL,updated_at=? WHERE id=?")
      .run(sched.nowIso(), sched.nowIso(), b.id);
    log(b.id, actor === 'admin' ? 'admin_cancelled' : 'customer_cancelled', reason || '取消尚未实际开始的预约并释放全部占用。', actor);
    return { booking: bookingDetail(db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id)) };
  });
  return immediate(tx);
}

router.post('/bookings/:ref/cancel', (req, res) => {
  const out = cancelBooking(req.params.ref, 'customer', req.body?.reason);
  if (out.started) return res.status(409).json({ error: '占用阶段已经实际开始，不能自助取消或释放，请联系后台人工改期。', ...out });
  if (out.invalid) return res.status(409).json({ error: out.invalid.message, status: out.invalid.status });
  res.json(out);
});

// ---------- Admin ----------
router.use('/admin', requireAdmin);

router.get('/admin/bookings', (req, res) => {
  const rows = db.prepare(`SELECT * FROM bookings WHERE status IN ('held','queued','confirmed')
    ORDER BY CASE status WHEN 'confirmed' THEN 1 WHEN 'held' THEN 2 ELSE 3 END, start_at`).all();
  res.json({ bookings: rows.map(bookingDetail) });
});

router.post('/admin/blocks', (req, res) => {
  bodyRequired(req, ['resource_id','start_at','end_at','reason']);
  const start = sched.parseIso(req.body.start_at);
  const end = sched.parseIso(req.body.end_at);
  if (end <= start) throw httpError(400, '结束时间必须晚于开始时间');
  const resource = db.prepare('SELECT * FROM resources WHERE id=? AND is_active=1').get(Number(req.body.resource_id));
  if (!resource) throw httpError(404, '资源不存在');
  const startUtc = sched.iso(start);
  const endUtc = sched.iso(end);
  const phases = new Map([[resource.id, [{ phase_type:'admin_block', phase_label:'后台停用/维护', phase_start:startUtc, phase_end:endUtc }]]]);
  const conflicts = sched.explainConflicts(phases);
  if (conflicts.length && !req.body.force) {
    return res.status(409).json({ error: '该停用区间与已占档期冲突；确认仍要保留此拦截规则可传 force=true。', conflicts });
  }
  const info = immediate(() => {
    return db.prepare('INSERT INTO blocks(resource_id,start_at,end_at,reason,created_by) VALUES(?,?,?,?,?)')
      .run(resource.id, startUtc, endUtc, String(req.body.reason).slice(0,200), 'admin');
  });
  immediate(() => log(null, 'block_created', { block_id: info.lastInsertRowid, resource: resource.name, conflicts }, 'admin'));
  res.status(201).json({ block: { id: info.lastInsertRowid, resource_id: resource.id, start_at:startUtc,end_at:endUtc,reason:req.body.reason }, conflicts });
});

router.get('/admin/blocks', (req,res) => {
  res.json({ blocks: db.prepare(`SELECT bl.*, r.name AS resource_name, r.type AS resource_type FROM blocks bl JOIN resources r ON r.id=bl.resource_id ORDER BY start_at DESC`).all() });
});

router.delete('/admin/blocks/:id', (req,res) => {
  const block = db.prepare('SELECT * FROM blocks WHERE id=?').get(req.params.id);
  if (!block) throw httpError(404,'停用记录不存在');
  db.prepare('DELETE FROM blocks WHERE id=?').run(block.id);
  log(null,'block_deleted',{block_id:block.id},'admin');
  res.json({ ok:true });
});

router.post('/admin/bookings/:ref/confirm-queue', (req,res) => {
  sched.expireHolds();
  const tx = db.transaction(() => {
    const b = getBookingByRef(req.params.ref);
    if (b.status === 'confirmed') return { booking: bookingDetail(b), idempotent_replay:true };
    if (b.status !== 'queued') return { invalid:{status:b.status,message:'只有排队中的预约可由后台确认。'} };
    const phases = currentPhasesForBooking(b);
    const conflicts = sched.explainConflicts(phases, b.id, { skipExpiry:true });
    if (conflicts.length) return { conflicts };
    db.prepare("UPDATE bookings SET status='confirmed',confirmed_at=?,queue_position=NULL,updated_at=? WHERE id=?")
      .run(sched.nowIso(),sched.nowIso(),b.id);
    log(b.id,'queue_confirmed','后台确认排队请求，原期望资源改为锁定。','admin');
    return { booking: bookingDetail(db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id)) };
  });
  const out = immediate(tx);
  if (out.conflicts) return res.status(409).json({error:'排队确认时仍有资源冲突',conflicts:out.conflicts});
  if (out.invalid) return res.status(409).json({error:out.invalid.message,status:out.invalid.status});
  res.json(out);
});

router.post('/admin/bookings/:ref/cancel', (req,res) => {
  const out = cancelBooking(req.params.ref, 'admin', req.body?.reason);
  if (out.started) return res.status(409).json({ error: '占用阶段已经实际开始；不能取消释放，只能登记人工改期/协商。', ...out });
  if (out.invalid) return res.status(409).json({ error: out.invalid.message, status: out.invalid.status });
  res.json(out);
});

router.post('/admin/bookings/:ref/reschedule', (req,res) => {
  bodyRequired(req,['start_at','reason']);
  if (!sched.validTimeZone(req.body.timezone || 'UTC')) throw httpError(400,'无效 IANA 时区');
  const startUtc = sched.iso(sched.parseIso(req.body.start_at));
  sched.expireHolds();
  const tx = db.transaction(() => {
    const b = getBookingByRef(req.params.ref);
    if (!['held','queued','confirmed'].includes(b.status)) return { invalid:{status:b.status,message:'当前状态不能改期。'} };
    const firstStart = earliestPhaseStart(b.id);
    if (b.status === 'confirmed' && firstStart && Date.parse(firstStart) <= Date.now()) {
      return { started:true, first_phase_start:firstStart };
    }
    const snapshot = JSON.parse(b.package_snapshot);
    const existingResourceIds = [...new Set(db.prepare('SELECT resource_id FROM booking_resources WHERE booking_id=?').all(b.id).map(x=>x.resource_id))];
    const resourceIds = req.body.resource_ids
      ? sched.packageResourceIds(snapshot.id, req.body.resource_ids)
      : existingResourceIds;
    const activeResourceIds = new Set([...sched.resourceMap(resourceIds).keys()]);
    const inactiveResources = resourceIds.filter(id => !activeResourceIds.has(id));
    if (inactiveResources.length) {
      return { invalid:{status:b.status,message:`资源已停用，不能按原档期改期: ${inactiveResources.join(',')}`} };
    }
    const phasesByResource = sched.makePhasesByResource(snapshot, startUtc, resourceIds);
    ensureFuture(phasesByResource);
    const conflicts = sched.explainConflicts(phasesByResource,b.id,{skipExpiry:true});
    if (conflicts.length) return { conflicts };
    const before = { start_at:b.start_at,end_at:b.end_at,timezone:b.timezone, resources: mapToResourcePhases(b.id) };
    sched.deallocateResources(b.id);
    sched.allocateResources(b.id,phasesByResource);
    const end = phasesByResource.get(resourceIds[0]).at(-1).phase_end;
    db.prepare('UPDATE bookings SET start_at=?,end_at=?,timezone=?,updated_at=? WHERE id=?')
      .run(startUtc,end,req.body.timezone || b.timezone,sched.nowIso(),b.id);
    const after = { start_at:startUtc,end_at:end,timezone:req.body.timezone || b.timezone };
    log(b.id,'manual_reschedule',{reason:req.body.reason,before,after,resource_ids:resourceIds},'admin');
    return { booking: bookingDetail(db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id)) };
  });
  const out = immediate(tx);
  if (out.started) return res.status(409).json({error:'已开始的锁定占用不能通过改期覆盖；请先线下处理并另建工单。',...out});
  if (out.conflicts) return res.status(409).json({error:'人工改期被冲突阻止，原档期保持不变',conflicts:out.conflicts});
  if (out.invalid) return res.status(409).json({error:out.invalid.message,status:out.invalid.status});
  res.json(out);
});

router.get('/admin/audit-logs', (req,res) => {
  const rows = db.prepare(`SELECT al.*, b.public_ref FROM audit_logs al LEFT JOIN bookings b ON b.id=al.booking_id
    ORDER BY al.id DESC LIMIT 200`).all();
  res.json({ logs: rows.map(x => ({...x, detail: safeJson(x.detail)})) });
});

router.put('/admin/packages/:id', (req,res) => {
  const pkg = getPackageOr404(req.params.id);
  const fields = ['name','description','is_active'];
  const numFields = ['current_price_cents','duration_minutes','travel_before_minutes','setup_minutes','teardown_minutes','travel_after_minutes'];
  const sets = [];
  const vals = [];
  for (const f of fields) if (req.body[f] !== undefined) { sets.push(`${f}=?`); vals.push(req.body[f]); }
  for (const f of numFields) if (req.body[f] !== undefined) {
    const n = Number(req.body[f]);
    if (!Number.isFinite(n) || n < 0) throw httpError(400,`${f} 必须是非负数字`);
    sets.push(`${f}=?`); vals.push(n);
  }
  if (req.body.included_scope !== undefined) {
    if (!Array.isArray(req.body.included_scope)) throw httpError(400,'included_scope 必须是数组');
    sets.push('included_scope=?'); vals.push(JSON.stringify(req.body.included_scope));
  }
  if (!sets.length) throw httpError(400,'没有要更新的字段');
  sets.push('version=version+1','updated_at=?'); vals.push(sched.nowIso(),pkg.id);
  db.prepare(`UPDATE packages SET ${sets.join(',')} WHERE id=?`).run(...vals);
  log(null,'package_updated',{package_id:pkg.id,old_version:pkg.version,body:req.body},'admin');
  res.json({ package: packagePublic(getPackageOr404(pkg.id)), notice:'新版本只影响此后新预约；已预约客户继续使用订单内价格与服务范围快照。' });
});

router.get('/admin/albums', (req,res) => {
  const albums = db.prepare(`SELECT a.*, s.name AS style_name FROM albums a JOIN styles s ON s.id=a.style_id ORDER BY a.id`).all();
  res.json({ albums: albums.map(a => ({...a, photos: db.prepare('SELECT * FROM photos WHERE album_id=? ORDER BY sort_order').all(a.id)})) });
});

router.put('/admin/photos/:id/license', (req,res) => {
  bodyRequired(req,['public_license']);
  const photo = db.prepare('SELECT * FROM photos WHERE id=?').get(req.params.id);
  if (!photo) throw httpError(404,'照片不存在');
  const licensed = !!req.body.public_license;
  const tx = db.transaction(() => {
    db.prepare('UPDATE photos SET working_public_license=?, license_updated_at=? WHERE id=?')
      .run(licensed ? 1 : 0, sched.nowIso(), photo.id);
    db.prepare('UPDATE albums SET working_version=working_version+1 WHERE id=?').run(photo.album_id);
    log(null,'photo_license_working_changed',{photo_id:photo.id,album_id:photo.album_id,public_license:licensed},'admin');
  });
  tx();
  res.json({ ok:true, notice: licensed ? '授权已加入待发布版本。' : '撤销仅进入待发布版本；点击发布后，灯箱序列与封面才会停止公开此版本。' });
});

router.post('/admin/albums/:id/cover', (req,res) => {
  bodyRequired(req,['photo_id']);
  const album = db.prepare('SELECT * FROM albums WHERE id=?').get(req.params.id);
  if (!album) throw httpError(404,'相册不存在');
  const photo = db.prepare('SELECT * FROM photos WHERE id=? AND album_id=?').get(req.body.photo_id, album.id);
  if (!photo) throw httpError(404,'照片不属于该相册');
  if (!photo.working_public_license) throw httpError(400,'不能把未获公开授权的照片设为封面');
  db.prepare('UPDATE albums SET cover_photo_id=?, working_version=working_version+1 WHERE id=?').run(photo.id,album.id);
  log(null,'cover_working_changed',{album_id:album.id,photo_id:photo.id},'admin');
  res.json({ ok:true });
});

router.post('/admin/albums/:id/publish', (req,res) => {
  const album = db.prepare('SELECT * FROM albums WHERE id=?').get(req.params.id);
  if (!album) throw httpError(404,'相册不存在');
  const tx = db.transaction(() => {
    const candidates = db.prepare('SELECT * FROM photos WHERE album_id=? AND working_public_license=1 ORDER BY sort_order').all(album.id);
    if (!candidates.length) throw httpError(400,'没有已授权照片，不能发布公开版本');
    let coverId = album.cover_photo_id;
    const cover = candidates.find(p => p.id === coverId);
    if (!cover) coverId = candidates[0].id;
    const nextVersion = album.working_version;
    db.prepare('UPDATE photos SET published_public_license=working_public_license, published_version=? WHERE album_id=?').run(nextVersion, album.id);
    db.prepare('UPDATE albums SET published_version=?, working_version=?, cover_photo_id=?, is_public=1 WHERE id=?')
      .run(nextVersion,nextVersion,coverId,album.id);
    log(null,'album_published',{album_id:album.id,version:nextVersion,cover_photo_id:coverId},'admin');
  });
  tx();
  const rows = publishedAlbumsQuery('AND a.id=?',[album.id]);
  res.json({ album: hydratePublishedAlbums(rows)[0], notice:'封面、灯箱序列和公开授权现在使用同一发布版本。' });
});

function safeJson(x) { try { return JSON.parse(x); } catch { return x; } }

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', router);
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get(['/admin','/admin.html'], (req,res) => res.sendFile(path.join(__dirname,'..','public','admin.html')));
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message || '服务器错误', ...(err.extra || {}) });
});

module.exports = app;
