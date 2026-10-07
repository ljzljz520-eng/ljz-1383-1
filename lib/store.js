import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_DATA_FILE = path.resolve('data/db.json');

const nowIso = () => new Date().toISOString();

function svgPhoto({ title, subtitle, bg, fg, accent, index }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800" role="img" aria-label="${title}">
  <defs><linearGradient id="g${index}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1200" y2="800">
    <stop stop-color="${bg}"/><stop offset="1" stop-color="${accent}"/>
  </linearGradient></defs>
  <rect width="1200" height="800" fill="url(#g${index})"/>
  <circle cx="${230 + index * 90}" cy="220" r="110" fill="${fg}" opacity=".28"/>
  <circle cx="${930 - index * 45}" cy="560" r="170" fill="${fg}" opacity=".16"/>
  <path d="M0 650 C240 560 390 760 640 650 C870 550 990 610 1200 520 L1200 800 L0 800 Z" fill="${fg}" opacity=".22"/>
  <text x="72" y="702" font-family="Georgia,serif" font-size="64" fill="${fg}">${title}</text>
  <text x="76" y="748" font-family="Arial,sans-serif" font-size="28" fill="${fg}" opacity=".82">${subtitle}</text>
</svg>`;
}

export function seedData() {
  const ts = nowIso();
  const resources = [
    { id: 'photographer-alice', name: '摄影师 Alice', kind: 'photographer', active: true },
    { id: 'photographer-noah', name: '摄影师 Noah', kind: 'photographer', active: true },
    { id: 'assistant-mia', name: '助手 Mia', kind: 'assistant', active: true },
    { id: 'assistant-leo', name: '助手 Leo', kind: 'assistant', active: true },
    { id: 'camera-sony-a7iv', name: 'Sony A7 IV 机身', kind: 'camera', active: true },
    { id: 'camera-canon-r5', name: 'Canon R5 机身', kind: 'camera', active: true },
    { id: 'lens-portrait-85', name: '85mm 人像镜头', kind: 'lens', active: true },
    { id: 'lens-wide-24', name: '24-70mm 通用镜头', kind: 'lens', active: true },
    { id: 'light-kit-pro', name: 'Profoto 双灯套装', kind: 'lighting', active: true },
    { id: 'light-kit-basic', name: '基础三灯套装', kind: 'lighting', active: true },
    { id: 'backdrop-neutral', name: '纯色背景套装', kind: 'backdrop', active: true }
  ];

  const packageBase = [
    {
      id: 'pkg-portrait',
      style: 'portrait',
      name: '自然光人像',
      description: '适合个人形象、情侣与家庭肖像，含选片与精修。',
      durationMin: 90,
      travelInMin: 30,
      prepMin: 20,
      breakdownMin: 15,
      travelOutMin: 20,
      price: 1280,
      currency: 'CNY',
      serviceScope: ['拍摄前风格沟通', '90 分钟拍摄', '20 张精修', '在线选片相册', '个人非商业使用授权'],
      resourceGroups: [
        { role: '主摄影师', anyOf: ['photographer-alice'] },
        { role: '相机', anyOf: ['camera-sony-a7iv', 'camera-canon-r5'] },
        { role: '镜头', anyOf: ['lens-portrait-85'] },
        { role: '背景', anyOf: ['backdrop-neutral'] }
      ]
    },
    {
      id: 'pkg-brand',
      style: 'brand',
      name: '品牌形象半天',
      description: '团队、创始人与产品视觉内容，适合官网和社媒。',
      durationMin: 180,
      travelInMin: 45,
      prepMin: 40,
      breakdownMin: 30,
      travelOutMin: 30,
      price: 3680,
      currency: 'CNY',
      serviceScope: ['脚本与分镜建议', '180 分钟拍摄', '45 张精修', '品牌内部传播授权', '基础灯光与背景'],
      resourceGroups: [
        { role: '主摄影师', anyOf: ['photographer-alice', 'photographer-noah'] },
        { role: '助手', anyOf: ['assistant-mia', 'assistant-leo'] },
        { role: '相机', anyOf: ['camera-sony-a7iv', 'camera-canon-r5'] },
        { role: '镜头', anyOf: ['lens-wide-24'] },
        { role: '灯光', anyOf: ['light-kit-pro', 'light-kit-basic'] }
      ]
    },
    {
      id: 'pkg-wedding',
      style: 'wedding',
      name: '婚礼全天纪实',
      description: '双机位覆盖准备、仪式与合影，交通和布置时间计入档期。',
      durationMin: 360,
      travelInMin: 60,
      prepMin: 60,
      breakdownMin: 45,
      travelOutMin: 45,
      price: 8800,
      currency: 'CNY',
      serviceScope: ['拍摄计划会', '6 小时纪实拍摄', '双机位素材', '80 张精修', '亲友在线画廊', '婚礼相册排版初稿'],
      resourceGroups: [
        { role: '主摄影师', anyOf: ['photographer-alice'] },
        { role: '第二摄影师/助手', anyOf: ['photographer-noah', 'assistant-mia'] },
        { role: '相机', anyOf: ['camera-sony-a7iv', 'camera-canon-r5'] },
        { role: '镜头', anyOf: ['lens-portrait-85', 'lens-wide-24'] },
        { role: '灯光', anyOf: ['light-kit-pro'] }
      ]
    }
  ];

  const packages = packageBase.map((p) => ({
    ...p,
    active: true,
    currentVersion: 1,
    createdAt: ts,
    updatedAt: ts,
    versions: [{
      version: 1,
      changedAt: ts,
      reason: 'initial',
      price: p.price,
      currency: p.currency,
      durationMin: p.durationMin,
      travelInMin: p.travelInMin,
      prepMin: p.prepMin,
      breakdownMin: p.breakdownMin,
      travelOutMin: p.travelOutMin,
      serviceScope: p.serviceScope,
      resourceGroups: p.resourceGroups
    }]
  }));

  const photoSpecs = [
    ['portrait', '窗光肖像', 'soft window-light portrait', '#182131', '#f7e7c9', '#8c6a4f', 1],
    ['portrait', '城市伴侣', 'quiet urban couple session', '#302b3f', '#f1d5e1', '#9a7c9f', 2],
    ['portrait', '家庭午后', 'family at golden hour', '#3b2f20', '#ffe7b5', '#b27d39', 3],
    ['brand', '创始人形象', 'founder editorial portrait', '#1c3032', '#d9f4ed', '#4d9187', 4],
    ['brand', '工作室团队', 'studio team narrative', '#222a3d', '#dce8ff', '#6f87b8', 5],
    ['brand', '产品细节', 'product detail and texture', '#332522', '#f2d6c8', '#a4604c', 6],
    ['wedding', '清晨准备', 'getting ready, soft morning', '#3a302b', '#f6dfc7', '#b38363', 7],
    ['wedding', '仪式之光', 'ceremony in natural light', '#25344a', '#e5edff', '#7390bd', 8],
    ['wedding', '夜色合影', 'night group portrait', '#171826', '#e8e4ff', '#665c9c', 9]
  ];

  const photos = photoSpecs.map(([albumStyle, title, subtitle, bg, fg, accent, index], i) => ({
    id: `photo-${index}`,
    albumId: `album-${albumStyle}`,
    order: i + 1,
    title,
    caption: subtitle,
    width: 1200,
    height: 800,
    licenseTerms: 'CC BY 4.0（公开展示可撤销）',
    publicLicense: true,
    mediaVersion: 1,
    createdAt: ts,
    updatedAt: ts,
    svg: svgPhoto({ title, subtitle, bg, fg, accent, index })
  }));

  const albums = ['portrait', 'brand', 'wedding'].map((style) => {
    const titles = {
      portrait: ['自然光人像', '柔和、真实、以人物情绪为主'],
      brand: ['品牌与商业', '为官网、社媒和品牌发布准备的统一视觉'],
      wedding: ['婚礼纪实', '从准备到仪式的完整时间线']
    };
    const albumPhotos = photos.filter((p) => p.albumId === `album-${style}`);
    return {
      id: `album-${style}`,
      style,
      title: titles[style][0],
      description: titles[style][1],
      coverPhotoId: albumPhotos[0].id,
      publicLicense: true,
      manifestVersion: 1,
      createdAt: ts,
      updatedAt: ts
    };
  });

  return {
    meta: { createdAt: ts, updatedAt: ts },
    counters: { seq: 1 },
    schedule: {
      timezone: 'Asia/Shanghai',
      weekly: [
        { day: 1, start: '09:00', end: '18:00' },
        { day: 2, start: '09:00', end: '18:00' },
        { day: 3, start: '09:00', end: '18:00' },
        { day: 4, start: '09:00', end: '18:00' },
        { day: 5, start: '09:00', end: '18:00' },
        { day: 6, start: '10:00', end: '17:00' }
      ],
      dateOverrides: []
    },
    resources,
    packages,
    albums,
    photos,
    blocks: [],
    holds: [],
    bookings: [],
    idempotency: [],
    auditLog: []
  };
}

export class JsonStore {
  constructor(file = process.env.DATA_FILE || DEFAULT_DATA_FILE) {
    this.file = path.resolve(file);
    this.data = null;
    this.queue = Promise.resolve();
  }

  async load() {
    if (this.data) return this.data;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.data = JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.data = seedData();
      await this.save();
    }
    return this.data;
  }

  async save() {
    this.data.meta.updatedAt = nowIso();
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2));
    await fs.rename(tmp, this.file);
  }

  // Every state-changing business operation goes through this FIFO lock. HTTP
  // requests may arrive simultaneously, but conflict checks and writes are serial.
  async transaction(fn) {
    const run = this.queue.then(async () => {
      await this.load();
      const result = await fn(this.data);
      await this.save();
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async read() {
    await this.load();
    return this.data;
  }
}

export const store = new JsonStore();
