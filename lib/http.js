import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { store } from './store.js';
import { createBookingService, BookingError, bookingViews } from './scheduling.js';
import { createAdminService } from './admin.js';
import { createContentService, publicPackage } from './content.js';
import { iso, localDateToUtcRange, utcToLocalDate } from './time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const booking = createBookingService(store);
const admin = createAdminService(store);
const content = await createContentService(store);

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { ...jsonHeaders, ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw new BookingError(400, 'invalid_json', '请求体不是有效 JSON。'); }
}

function requireAdmin(req) {
  const expected = process.env.ADMIN_TOKEN || 'dev-admin-token';
  const header = req.headers.authorization || '';
  if (header !== `Bearer ${expected}`) {
    throw new BookingError(401, 'unauthorized', '需要管理员 Bearer Token。');
  }
}

async function publicTimeline(query) {
  const db = await store.read();
  const date = query.date || utcToLocalDate(Date.now(), query.timezone || db.schedule.timezone);
  const tz = query.timezone || db.schedule.timezone;
  const range = localDateToUtcRange(date, tz);
  if (!range.ok) throw new BookingError(400, range.reason, '日期或时区无效。');
  const items = [];
  for (const b of db.bookings) {
    const interval = bookingViews.makeWantedInterval(b.snapshot, Date.parse(b.startUtc));
    if (b.status === 'waiting' && interval.occupiedEndMs > range.startMs && interval.occupiedStartMs < range.endMs) {
      items.push({
        type: 'waiting_confirmation',
        startUtc: iso(interval.occupiedStartMs),
        endUtc: iso(interval.occupiedEndMs),
        actualStartUtc: b.startUtc,
        actualEndUtc: b.endUtc,
        packageStyle: b.snapshot.style,
        packageName: b.snapshot.packageName,
        locked: false
      });
    }
    if (['confirmed', 'offered'].includes(b.status) &&
        interval.occupiedEndMs > range.startMs && interval.occupiedStartMs < range.endMs) {
      items.push({
        type: b.status === 'offered' ? 'offer' : 'locked',
        startUtc: iso(interval.occupiedStartMs),
        endUtc: iso(interval.occupiedEndMs),
        actualStartUtc: b.startUtc,
        actualEndUtc: b.endUtc,
        packageStyle: b.snapshot.style,
        packageName: b.snapshot.packageName,
        locked: true
      });
    }
  }
  for (const h of db.holds) {
    const interval = bookingViews.makeWantedInterval(h.snapshot, Date.parse(h.startUtc));
    if (h.status === 'active' && Date.parse(h.expiresAt) > Date.now() && interval.occupiedEndMs > range.startMs &&
        interval.occupiedStartMs < range.endMs) {
      items.push({
        type: 'temporary_hold',
        startUtc: iso(interval.occupiedStartMs),
        endUtc: iso(interval.occupiedEndMs),
        actualStartUtc: h.startUtc,
        actualEndUtc: h.endUtc,
        expiresAt: h.expiresAt,
        packageStyle: h.snapshot.style
      });
    }
  }
  for (const block of db.blocks) {
    if (block.interval.occupiedEndMs > range.startMs && block.interval.occupiedStartMs < range.endMs) {
      items.push({
        type: 'blocked',
        startUtc: iso(block.interval.occupiedStartMs),
        endUtc: iso(block.interval.occupiedEndMs),
        title: block.allResources ? '全天/资源封闭' : block.title
      });
    }
  }
  return { date, timezone: tz, schedule: db.schedule, items: items.sort((a, b) => a.startUtc.localeCompare(b.startUtc)) };
}

async function preflight(body) {
  const db = await store.read();
  const { localDateTimeToUtc } = await import('./time.js');
  const pkg = db.packages.find((p) => p.id === body.packageId && p.active);
  if (!pkg) throw new BookingError(404, 'package_not_found', '套餐不存在。');
  const conv = localDateTimeToUtc(body.startLocal, body.timezone, body.ambiguity || 'earlier');
  if (!conv.ok) throw new BookingError(400, conv.reason, '时间无效。');
  const snap = {
    durationMin: pkg.durationMin,
    travelInMin: pkg.travelInMin,
    prepMin: pkg.prepMin,
    breakdownMin: pkg.breakdownMin,
    travelOutMin: pkg.travelOutMin,
    resourceGroups: pkg.resourceGroups
  };
  const before = (pkg.travelInMin + pkg.prepMin) * 60000;
  const after = (pkg.durationMin + pkg.breakdownMin + pkg.travelOutMin) * 60000;
  return {
    package: publicPackage(db, pkg),
    timezone: body.timezone,
    startUtc: iso(conv.utcMs),
    actualEndUtc: iso(conv.utcMs + pkg.durationMin * 60000),
    occupiedStartUtc: iso(conv.utcMs - before),
    occupiedEndUtc: iso(conv.utcMs + after),
    ambiguousLocalTime: conv.ambiguous
  };
}

const routes = [
  ['GET', /^\/api\/health$/, async () => ({ ok: true, now: new Date().toISOString() })],
  ['GET', /^\/api\/albums$/, async (req, res, url) => content.albums(url.searchParams.get('style') || undefined)],
  ['GET', /^\/api\/albums\/([^/]+)$/, async (req, res, url, m) => {
    const album = await content.album(m[1]);
    if (!album) throw new BookingError(404, 'album_not_found', '公开相册不存在或授权已撤销。');
    return album;
  }],
  ['GET', /^\/api\/packages$/, async () => content.packages()],
  ['GET', /^\/api\/timeline$/, async (req, res, url) => publicTimeline(Object.fromEntries(url.searchParams))],
  ['POST', /^\/api\/preflight$/, async (req) => preflight(await readJson(req))],
  ['POST', /^\/api\/bookings\/lookup$/, async (req) => booking.lookupBooking(await readJson(req))],
  ['POST', /^\/api\/holds\/lookup$/, async (req) => booking.lookupHold(await readJson(req))],
  ['POST', /^\/api\/bookings$/, async (req) => booking.submitBooking(await readJson(req))],
  ['POST', /^\/api\/holds$/, async (req) => booking.createHold(await readJson(req))],
  ['POST', /^\/api\/holds\/confirm$/, async (req) => booking.confirmHold(await readJson(req))],
  ['POST', /^\/api\/bookings\/cancel$/, async (req) => booking.cancelBooking(await readJson(req))],

  ['GET', /^\/api\/admin\/state$/, async (req) => { requireAdmin(req); return admin.state(); }],
  ['POST', /^\/api\/admin\/maintenance\/prune$/, async (req) => { requireAdmin(req); return booking.pruneAndPromote(Date.now(), 'admin-prune'); }],
  ['PUT', /^\/api\/admin\/schedule$/, async (req) => { requireAdmin(req); return admin.updateSchedule(await readJson(req)); }],
  ['PUT', /^\/api\/admin\/schedule\/overrides$/, async (req) => { requireAdmin(req); return admin.setDateOverride(await readJson(req)); }],
  ['DELETE', /^\/api\/admin\/schedule\/overrides\/([^/]+)$/, async (req, res, url, m) => { requireAdmin(req); return admin.deleteDateOverride(m[1]); }],
  ['PUT', /^\/api\/admin\/resources$/, async (req) => { requireAdmin(req); return admin.upsertResource(await readJson(req)); }],
  ['PUT', /^\/api\/admin\/resources\/([^/]+)$/, async (req, res, url, m) => {
    requireAdmin(req);
    return admin.upsertResource({ ...await readJson(req), id: m[1] });
  }],
  ['PUT', /^\/api\/admin\/packages\/([^/]+)$/, async (req, res, url, m) => {
    requireAdmin(req);
    return admin.updatePackage({ ...await readJson(req), id: m[1] });
  }],
  ['POST', /^\/api\/admin\/blocks$/, async (req) => { requireAdmin(req); return admin.createBlock(await readJson(req)); }],
  ['DELETE', /^\/api\/admin\/blocks\/([^/]+)$/, async (req, res, url, m) => { requireAdmin(req); return admin.deleteBlock(m[1]); }],
  ['POST', /^\/api\/admin\/bookings\/confirm$/, async (req) => { requireAdmin(req); return booking.adminConfirm(await readJson(req)); }],
  ['POST', /^\/api\/admin\/bookings\/reschedule$/, async (req) => { requireAdmin(req); return booking.adminReschedule(await readJson(req)); }],
  ['POST', /^\/api\/admin\/bookings\/cancel$/, async (req) => {
    requireAdmin(req);
    return booking.cancelBooking({ ...await readJson(req), byAdmin: true });
  }],
  ['PUT', /^\/api\/admin\/photos\/([^/]+)\/license$/, async (req, res, url, m) => {
    requireAdmin(req);
    return admin.setPhotoLicense({ ...await readJson(req), photoId: m[1] });
  }],
  ['PUT', /^\/api\/admin\/albums\/([^/]+)\/license$/, async (req, res, url, m) => {
    requireAdmin(req);
    return admin.setAlbumLicense({ ...await readJson(req), albumId: m[1] });
  }]
];

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  if (pathname.startsWith('/admin')) pathname = '/admin.html';
  const filePath = path.normalize(path.join(publicDir, pathname));
  if (!filePath.startsWith(publicDir)) return sendJson(res, 403, { error: 'forbidden' });
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { 'content-type': mime[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'not_found' });
  }
}

async function serveMedia(req, res, url, m) {
  const media = await content.media(m[1], url.searchParams.get('v'));
  if (!media) return sendJson(res, 404, { error: 'media_unavailable', reason: '照片不存在或公开授权已撤销。' });
  if (media.stale) {
    res.writeHead(302, { location: `/media/${m[1]}.svg?v=${media.currentVersion}` });
    return res.end();
  }
  res.writeHead(200, {
    'content-type': media.contentType,
    'cache-control': 'public, max-age=30',
    etag: media.etag
  });
  res.end(media.body);
}

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS' });
        return res.end();
      }
      const mediaMatch = /^\/media\/([^/.]+)\.svg$/.exec(url.pathname);
      if (mediaMatch) return serveMedia(req, res, url, mediaMatch);
      for (const [method, pattern, handler] of routes) {
        if (method !== req.method) continue;
        const match = pattern.exec(url.pathname);
        if (!match) continue;
        const result = await handler(req, res, url, match);
        if (result !== undefined) return sendJson(res, 200, result);
        return;
      }
      if (req.method === 'GET') return serveStatic(req, res, url);
      sendJson(res, 404, { error: 'not_found' });
    } catch (err) {
      if (err instanceof BookingError) {
        return sendJson(res, err.status, { error: err.code, message: err.message, details: err.details });
      }
      console.error(err);
      sendJson(res, 500, { error: 'internal_error', message: err.message });
    }
  });
}
