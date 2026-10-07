import { randomUUID } from 'node:crypto';
import { iso, isValidTimeZone, localDateTimeToUtc } from './time.js';
import { BookingError, bookingViews } from './scheduling.js';

const publicState = (db) => ({
  resources: db.resources,
  packages: db.packages.map((p) => ({
    id: p.id, style: p.style, name: p.name, description: p.description, active: p.active,
    durationMin: p.durationMin, travelInMin: p.travelInMin, prepMin: p.prepMin,
    breakdownMin: p.breakdownMin, travelOutMin: p.travelOutMin, price: p.price,
    currency: p.currency, serviceScope: p.serviceScope, resourceGroups: p.resourceGroups,
    currentVersion: p.currentVersion, updatedAt: p.updatedAt
  })),
  schedule: db.schedule
});

export function createAdminService(store) {
  function audit(db, action, details) {
    db.auditLog.unshift({ id: `audit-${randomUUID()}`, at: iso(Date.now()), action, details });
    if (db.auditLog.length > 500) db.auditLog.length = 500;
  }

  function toInterval(db, body) {
    if (!isValidTimeZone(body.timezone)) throw new BookingError(400, 'invalid_timezone', '无效 IANA 时区。');
    const s = localDateTimeToUtc(body.startLocal, body.timezone, body.ambiguity || 'earlier');
    const e = localDateTimeToUtc(body.endLocal, body.timezone, body.ambiguity || 'earlier');
    if (!s.ok || !e.ok) throw new BookingError(400, 'invalid_interval', '档期起止时间无效。');
    if (e.utcMs <= s.utcMs) throw new BookingError(400, 'invalid_interval', '结束时间必须晚于开始时间。');
    return {
      actualStartMs: s.utcMs,
      actualEndMs: e.utcMs,
      occupiedStartMs: s.utcMs - Number(body.beforeMin || 0) * 60000,
      occupiedEndMs: e.utcMs + Number(body.afterMin || 0) * 60000
    };
  }

  return {
    async state() {
      const db = await store.read();
      return {
        ...publicState(db),
        albums: db.albums,
        photos: db.photos.map(({ svg, ...meta }) => ({ ...meta })),
        blocks: db.blocks,
        holds: db.holds.map(bookingViews.publicHold),
        bookings: db.bookings.map(bookingViews.adminBooking),
        auditLog: db.auditLog
      };
    },

    async updateSchedule(body) {
      return store.transaction((db) => {
        if (body.timezone !== undefined) {
          if (!isValidTimeZone(body.timezone)) throw new BookingError(400, 'invalid_timezone', '无效 IANA 时区。');
          db.schedule.timezone = body.timezone;
        }
        if (body.weekly !== undefined) {
          if (!Array.isArray(body.weekly)) throw new BookingError(400, 'invalid_weekly', 'weekly 必须为数组。');
          for (const row of body.weekly) {
            if (!Number.isInteger(row.day) || row.day < 0 || row.day > 6 ||
                !/^\d{2}:\d{2}$/.test(row.start) || !/^\d{2}:\d{2}$/.test(row.end) ||
                row.end <= row.start) {
              throw new BookingError(400, 'invalid_weekly', '每周开放时间格式无效。');
            }
          }
          db.schedule.weekly = body.weekly.map(({ day, start, end }) => ({ day, start, end }));
        }
        audit(db, 'schedule.updated', body);
        return db.schedule;
      });
    },

    async setDateOverride(body) {
      return store.transaction((db) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || '')) throw new BookingError(400, 'invalid_date', '日期格式应为 YYYY-MM-DD。');
        if (!body.closed && !Array.isArray(body.ranges)) throw new BookingError(400, 'invalid_override', '请设置 closed 或 ranges。');
        const ranges = Array.isArray(body.ranges) ? body.ranges : [];
        for (const r of ranges) {
          if (!/^\d{2}:\d{2}$/.test(r.start) || !/^\d{2}:\d{2}$/.test(r.end) || r.end <= r.start) {
            throw new BookingError(400, 'invalid_override_range', '特殊开放时段无效。');
          }
        }
        const override = {
          date: body.date,
          closed: Boolean(body.closed),
          ranges: ranges.map(({ start, end }) => ({ start, end })),
          reason: body.reason || '',
          updatedAt: iso(Date.now())
        };
        const idx = db.schedule.dateOverrides.findIndex((o) => o.date === body.date);
        if (idx >= 0) db.schedule.dateOverrides[idx] = override;
        else db.schedule.dateOverrides.push(override);
        audit(db, 'schedule.date_override_set', override);
        return override;
      });
    },

    async deleteDateOverride(date) {
      return store.transaction((db) => {
        const before = db.schedule.dateOverrides.length;
        db.schedule.dateOverrides = db.schedule.dateOverrides.filter((o) => o.date !== date);
        if (db.schedule.dateOverrides.length === before) throw new BookingError(404, 'override_not_found', '日期规则不存在。');
        audit(db, 'schedule.date_override_deleted', { date });
        return { ok: true };
      });
    },

    async upsertResource(body) {
      return store.transaction((db) => {
        let resource = body.id ? db.resources.find((r) => r.id === body.id) : null;
        if (!resource) {
          resource = { id: `resource-${randomUUID()}`, active: true };
          db.resources.push(resource);
        }
        if (body.name) resource.name = String(body.name);
        if (body.kind) resource.kind = String(body.kind);
        if (body.active !== undefined) resource.active = Boolean(body.active);
        audit(db, 'resource.upserted', { id: resource.id, resource });
        return resource;
      });
    },

    async updatePackage(body) {
      return store.transaction((db) => {
        const pkg = db.packages.find((p) => p.id === body.id);
        if (!pkg) throw new BookingError(404, 'package_not_found', '套餐不存在。');
        const numeric = ['durationMin', 'travelInMin', 'prepMin', 'breakdownMin', 'travelOutMin', 'price'];
        const nextVersionData = {
          price: body.price ?? pkg.price,
          currency: body.currency || pkg.currency,
          durationMin: body.durationMin ?? pkg.durationMin,
          travelInMin: body.travelInMin ?? pkg.travelInMin,
          prepMin: body.prepMin ?? pkg.prepMin,
          breakdownMin: body.breakdownMin ?? pkg.breakdownMin,
          travelOutMin: body.travelOutMin ?? pkg.travelOutMin,
          serviceScope: body.serviceScope || pkg.serviceScope,
          resourceGroups: body.resourceGroups || pkg.resourceGroups
        };
        for (const key of numeric) {
          if (typeof nextVersionData[key] !== 'number' || nextVersionData[key] < 0) {
            throw new BookingError(400, 'invalid_package', `${key} 必须是非负数字。`);
          }
        }
        if (!Array.isArray(nextVersionData.resourceGroups) || !nextVersionData.resourceGroups.length) {
          throw new BookingError(400, 'invalid_resource_groups', '至少需要一个资源组。');
        }
        const known = new Set(db.resources.map((r) => r.id));
        for (const group of nextVersionData.resourceGroups) {
          if (!group.role || !Array.isArray(group.anyOf) || !group.anyOf.length || !group.anyOf.every((id) => known.has(id))) {
            throw new BookingError(400, 'invalid_resource_groups', '资源组角色或候选资源无效。');
          }
        }
        const meaningfulChanged = JSON.stringify({
          ...nextVersionData,
          serviceScope: nextVersionData.serviceScope,
          resourceGroups: nextVersionData.resourceGroups
        }) !== JSON.stringify({
          price: pkg.price, currency: pkg.currency, durationMin: pkg.durationMin, travelInMin: pkg.travelInMin,
          prepMin: pkg.prepMin, breakdownMin: pkg.breakdownMin, travelOutMin: pkg.travelOutMin,
          serviceScope: pkg.serviceScope, resourceGroups: pkg.resourceGroups
        });
        if (body.name) pkg.name = body.name;
        if (body.description !== undefined) pkg.description = body.description;
        if (body.active !== undefined) pkg.active = Boolean(body.active);
        Object.assign(pkg, nextVersionData);
        if (meaningfulChanged) {
          pkg.currentVersion += 1;
          pkg.versions.push({ version: pkg.currentVersion, changedAt: iso(Date.now()), reason: body.reason || 'admin edit', ...nextVersionData });
        }
        pkg.updatedAt = iso(Date.now());
        audit(db, 'package.updated', {
          id: pkg.id, version: pkg.currentVersion, changed: meaningfulChanged, reason: body.reason || '',
          preservationRule: '既有预约保存 snapshot.version，不自动改价或改服务范围。'
        });
        return pkg;
      });
    },

    async createBlock(body) {
      return store.transaction((db) => {
        if (!body.title) throw new BookingError(400, 'title_required', '封闭档期需要标题。');
        const interval = toInterval(db, body);
        let resourceIds = [];
        let allResources = Boolean(body.allResources);
        if (!allResources) {
          resourceIds = body.resourceIds || [];
          const known = new Set(db.resources.map((r) => r.id));
          if (!resourceIds.length) throw new BookingError(400, 'resources_required', '请选择资源，或设置 allResources。');
          if (!resourceIds.every((id) => known.has(id))) throw new BookingError(400, 'invalid_resource', '包含不存在的资源。');
        }
        const block = {
          id: `block-${randomUUID()}`,
          title: body.title,
          reason: body.reason || '',
          allResources,
          resourceIds,
          interval,
          createdAt: iso(Date.now())
        };
        db.blocks.push(block);
        audit(db, 'block.created', block);
        return block;
      });
    },

    async deleteBlock(id) {
      return store.transaction((db) => {
        const idx = db.blocks.findIndex((b) => b.id === id);
        if (idx < 0) throw new BookingError(404, 'block_not_found', '封闭档期不存在。');
        const [block] = db.blocks.splice(idx, 1);
        audit(db, 'block.deleted', block);
        return { ok: true };
      });
    },

    async setPhotoLicense(body) {
      return store.transaction((db) => {
        const photo = db.photos.find((p) => p.id === body.photoId);
        if (!photo) throw new BookingError(404, 'photo_not_found', '照片不存在。');
        const previous = photo.publicLicense;
        photo.publicLicense = Boolean(body.publicLicense);
        if (body.licenseTerms !== undefined) photo.licenseTerms = body.licenseTerms;
        if (body.mediaContent !== undefined) {
          photo.svg = String(body.mediaContent);
          photo.mediaVersion += 1;
        }
        photo.updatedAt = iso(Date.now());

        const album = db.albums.find((a) => a.id === photo.albumId);
        let coverChanged = false;
        if (!photo.publicLicense && album?.coverPhotoId === photo.id) {
          const replacement = db.photos
            .filter((p) => p.albumId === album.id && p.id !== photo.id && p.publicLicense)
            .sort((a, b) => a.order - b.order)[0];
          if (replacement) {
            album.coverPhotoId = replacement.id;
            coverChanged = true;
          } else {
            album.publicLicense = false;
          }
        }
        album.manifestVersion += 1;
        album.updatedAt = iso(Date.now());
        audit(db, 'photo.license_changed', {
          photoId: photo.id, albumId: photo.albumId, previous, next: photo.publicLicense, coverChanged
        });
        return { photo: { ...photo, svg: undefined }, album, coverChanged };
      });
    },

    async setAlbumLicense(body) {
      return store.transaction((db) => {
        const album = db.albums.find((a) => a.id === body.albumId);
        if (!album) throw new BookingError(404, 'album_not_found', '相册不存在。');
        album.publicLicense = Boolean(body.publicLicense);
        album.manifestVersion += 1;
        album.updatedAt = iso(Date.now());
        audit(db, 'album.license_changed', { albumId: album.id, publicLicense: album.publicLicense });
        return album;
      });
    }
  };
}
