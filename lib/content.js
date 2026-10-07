import { createHash } from 'node:crypto';
import { bookingViews } from './scheduling.js';

export function publicAlbums(db) {
  return db.albums.filter((a) => a.publicLicense).map((album) => {
    const photos = db.photos
      .filter((p) => p.albumId === album.id && p.publicLicense)
      .sort((a, b) => a.order - b.order);
    const publicPhotos = photos.map(photoMeta);
    const manifestDigest = createHash('sha256')
      .update(JSON.stringify({
        albumId: album.id,
        coverPhotoId: album.coverPhotoId,
        manifestVersion: album.manifestVersion,
        photos: publicPhotos.map((p) => ({ id: p.id, order: p.order, mediaVersion: p.mediaVersion, licenseTerms: p.licenseTerms }))
      }))
      .digest('hex');
    return {
      id: album.id,
      style: album.style,
      title: album.title,
      description: album.description,
      manifestVersion: album.manifestVersion,
      manifestDigest,
      coverPhotoId: album.coverPhotoId,
      cover: publicPhotos.find((p) => p.id === album.coverPhotoId) || publicPhotos[0],
      photos: publicPhotos
    };
  }).filter((album) => album.photos.length > 0);
}

function photoMeta(photo) {
  if (!photo) return null;
  return {
    id: photo.id,
    order: photo.order,
    title: photo.title,
    caption: photo.caption,
    width: photo.width,
    height: photo.height,
    licenseTerms: photo.licenseTerms,
    mediaVersion: photo.mediaVersion,
    src: `/media/${photo.id}.svg?v=${photo.mediaVersion}`
  };
}

export function publicPackage(db, pkg) {
  return {
    id: pkg.id,
    style: pkg.style,
    name: pkg.name,
    description: pkg.description,
    active: pkg.active,
    currentVersion: pkg.currentVersion,
    durationMin: pkg.durationMin,
    travelInMin: pkg.travelInMin,
    prepMin: pkg.prepMin,
    breakdownMin: pkg.breakdownMin,
    travelOutMin: pkg.travelOutMin,
    totalWindowMin: pkg.durationMin + pkg.travelInMin + pkg.prepMin + pkg.breakdownMin + pkg.travelOutMin,
    price: pkg.price,
    currency: pkg.currency,
    serviceScope: pkg.serviceScope,
    resourceGroups: pkg.resourceGroups
  };
}

export async function createContentService(store) {
  return {
    async albums(style) {
      const db = await store.read();
      const albums = publicAlbums(db);
      return style ? albums.filter((a) => a.style === style) : albums;
    },
    async album(id) {
      const db = await store.read();
      return publicAlbums(db).find((a) => a.id === id) || null;
    },
    async media(photoId, queryVersion) {
      const db = await store.read();
      const photo = db.photos.find((p) => p.id === photoId);
      if (!photo || !photo.publicLicense) return null;
      const album = db.albums.find((a) => a.id === photo.albumId);
      if (!album?.publicLicense) return null;
      if (queryVersion !== undefined && Number(queryVersion) !== photo.mediaVersion) {
        return { stale: true, currentVersion: photo.mediaVersion };
      }
      return { contentType: 'image/svg+xml; charset=utf-8', body: photo.svg, version: photo.mediaVersion, etag: `"${photo.id}-${photo.mediaVersion}"` };
    },
    async packages() {
      const db = await store.read();
      return db.packages.filter((p) => p.active).map((p) => publicPackage(db, p));
    }
  };
}

