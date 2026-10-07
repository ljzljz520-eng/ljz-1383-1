const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  albums: [],
  packages: [],
  filteredAlbums: [],
  currentAlbum: null,
  currentIndex: 0,
  activeHold: null
};

const DRAFT_KEY = 'lumen.bookingDraft.v1';
const TOKEN_KEY = 'lumen.adminToken';

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || '请求失败');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function initTimezones() {
  const common = [
    'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/London',
    'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney'
  ];
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = [...new Set([detected, ...common])].filter(Boolean);
  $('#timezone').innerHTML = zones.map((z) => `<option ${z === detected ? 'selected' : ''}>${z}</option>`).join('');
}

async function loadContent() {
  const [albums, packages] = await Promise.all([api('/api/albums'), api('/api/packages')]);
  state.albums = albums;
  state.packages = packages;
  renderFilters();
  renderAlbums();
  renderPackageOptions();
}

function renderFilters() {
  const styles = [...new Set(state.albums.map((a) => a.style))];
  const labels = { all: '全部', portrait: '人像', brand: '品牌', wedding: '婚礼' };
  $('#styleFilters').innerHTML = ['all', ...styles].map((s) =>
    `<button class="filter-btn ${s === 'all' ? 'active' : ''}" data-style="${s}">${labels[s] || s}</button>`).join('');
  $$('.filter-btn').forEach((btn) => btn.addEventListener('click', () => {
    $$('.filter-btn').forEach((b) => b.classList.toggle('active', b === btn));
    renderAlbums(btn.dataset.style);
  }));
}

function renderAlbums(style = 'all') {
  const albums = style === 'all' ? state.albums : state.albums.filter((a) => a.style === style);
  $('#albumGrid').innerHTML = albums.map((album) => `
    <article class="album-card">
      <img class="album-cover" src="${album.cover.src}" alt="${esc(album.cover.title)}" data-album="${album.id}" loading="lazy" />
      <div class="album-body">
        <p class="eyebrow">${esc(album.style)}</p>
        <h3>${esc(album.title)}</h3>
        <p class="hint">${esc(album.description)}</p>
        <div class="photo-strip">
          ${album.photos.map((p, i) => `<img src="${p.src}" alt="${esc(p.title)}" data-album="${album.id}" data-index="${i}" loading="lazy" />`).join('')}
        </div>
      </div>
    </article>`).join('');
  $$('.album-cover, .photo-strip img').forEach((img) => img.addEventListener('click', () => {
    const album = state.albums.find((a) => a.id === img.dataset.album);
    openLightbox(album, Number(img.dataset.index || 0));
  }));
}

function openLightbox(album, index) {
  state.currentAlbum = album;
  state.currentIndex = index;
  $('#lightbox').classList.remove('hidden');
  renderLightboxPhoto();
}

function renderLightboxPhoto() {
  const photos = state.currentAlbum.photos;
  const photo = photos[state.currentIndex];
  // The sequence and src version come from one fetched album manifest, avoiding
  // a revoked or newly replaced image mixing into an old public sequence.
  $('#lbImage').src = photo.src;
  $('#lbImage').alt = photo.title;
  $('#lbCaption').textContent = `${state.currentAlbum.title} · ${photo.title} — ${photo.caption}`;
  $('#lbVersion').textContent = `清单 v${state.currentAlbum.manifestVersion} (${state.currentAlbum.manifestDigest.slice(0, 10)}) · 媒体 v${photo.mediaVersion} · ${photo.licenseTerms}`;
}

function closeLightbox() { $('#lightbox').classList.add('hidden'); }
function moveLightbox(delta) {
  const photos = state.currentAlbum.photos;
  state.currentIndex = (state.currentIndex + delta + photos.length) % photos.length;
  renderLightboxPhoto();
}

function renderPackageOptions() {
  const styles = [...new Set(state.packages.map((p) => p.style))];
  $('#packageStyle').innerHTML = styles.map((s) => `<option value="${s}">${s}</option>`).join('');
  updatePackageSelect();
  $('#packageStyle').addEventListener('change', () => { updatePackageSelect(); saveDraft(); });
  $('#packageId').addEventListener('change', () => { renderPackageDetails(); updatePreflight(); saveDraft(); });
}

function updatePackageSelect() {
  const style = $('#packageStyle').value;
  const list = state.packages.filter((p) => p.style === style);
  $('#packageId').innerHTML = list.map((p) => `<option value="${p.id}">${p.name} · ${p.price} ${p.currency}</option>`).join('');
  renderPackageDetails();
}

function selectedPackage() {
  return state.packages.find((p) => p.id === $('#packageId').value);
}

function renderPackageDetails() {
  const p = selectedPackage();
  if (!p) return;
  $('#packageDetails').innerHTML = `
    <strong>${esc(p.name)}</strong><span class="hint">（报价版本 v${p.currentVersion}）</span>
    <p>${esc(p.description)}</p>
    <p>正式拍摄 ${p.durationMin} 分钟；到达 ${p.travelInMin} 分钟 + 布置 ${p.prepMin} 分钟；撤场 ${p.breakdownMin} 分钟 + 离开 ${p.travelOutMin} 分钟。总档期窗口 <strong>${p.totalWindowMin}</strong> 分钟。</p>
    <ul>${p.serviceScope.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`;
}

function draft() {
  return {
    packageStyle: $('#packageStyle').value,
    packageId: $('#packageId').value,
    timezone: $('#timezone').value,
    startLocal: $('#startLocal').value,
    ambiguity: $('#ambiguity').checked,
    name: $('#name').value,
    email: $('#email').value,
    phone: $('#phone').value,
    notes: $('#notes').value,
    savedAt: new Date().toISOString()
  };
}

function applyDraft(d) {
  if (!d) return;
  if ([...$('#packageStyle').options].some((o) => o.value === d.packageStyle)) $('#packageStyle').value = d.packageStyle;
  updatePackageSelect();
  if ([...$('#packageId').options].some((o) => o.value === d.packageId)) $('#packageId').value = d.packageId;
  renderPackageDetails();
  $('#timezone').value = d.timezone;
  $('#startLocal').value = d.startLocal || '';
  $('#ambiguity').checked = Boolean(d.ambiguity);
  $('#name').value = d.name || '';
  $('#email').value = d.email || '';
  $('#phone').value = d.phone || '';
  $('#notes').value = d.notes || '';
  $('#draftBanner').className = 'notice info';
  $('#draftBanner').innerHTML = `已恢复本机未提交草稿（${new Date(d.savedAt).toLocaleString()}）。<strong>这不表示预约成功</strong>，请提交后以服务器返回的单号和状态为准。`;
}

function saveDraft() {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft()));
}

async function updatePreflight() {
  const p = selectedPackage();
  if (!p || !$('#startLocal').value || !$('#timezone').value) {
    $('#preflight').innerHTML = '<p class="hint">选择时间后显示 UTC 与完整占用窗口。</p>';
    return;
  }
  try {
    const data = await api('/api/preflight', {
      method: 'POST',
      body: JSON.stringify({ packageId: p.id, startLocal: $('#startLocal').value, timezone: $('#timezone').value, ambiguity: $('#ambiguity').checked ? 'later' : 'earlier' })
    });
    $('#preflight').innerHTML = `
      <div class="status-pill status-confirmed">完整窗口将参与冲突检查</div>
      <p>正式拍摄：${esc(data.startUtc)} → ${esc(data.actualEndUtc)}</p>
      <p>资源占用：<strong>${esc(data.occupiedStartUtc)} → ${esc(data.occupiedEndUtc)}</strong></p>
      <p class="hint">包含交通/布置提前量与撤场/交通收尾；相邻结束和开始不视为重叠。</p>`;
  } catch (err) {
    $('#preflight').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
  }
}

function resultHtml(data, type) {
  if (type === 'hold') {
    const h = data.hold;
    return `<div class="result-box">
      <span class="status-pill status-hold">临时占位 · 未成功预订</span>
      <p>占位号 <strong>${h.number}</strong>，到期：${h.expiresAt}</p>
      <p>请在到期前确认。网络重试请使用同一幂等键，不会产生两份占位。</p>
      <button class="button primary small" id="confirmHoldBtn">立即确认占位</button>
    </div>`;
  }
  const b = data.booking;
  const cls = b.status === 'waiting' ? 'status-waiting' : b.status === 'confirmed' ? 'status-confirmed' : 'status-canceled';
  return `<div class="result-box">
    <span class="status-pill ${cls}">${data.lockState.label}</span>
    <p>订单号 <strong>${b.number}</strong></p>
    <p>${esc(data.lockState.description)}</p>
    <p>锁定报价 v${b.snapshot.version}：${b.snapshot.price} ${b.snapshot.currency}</p>
    ${data.duplicate ? '<p class="notice success">重复请求：返回原订单，未创建第二份预约。</p>' : ''}
  </div>`;
}

function bookingPayload() {
  return {
    packageId: $('#packageId').value,
    startLocal: $('#startLocal').value,
    timezone: $('#timezone').value,
    ambiguity: $('#ambiguity').checked ? 'later' : 'earlier',
    customer: { name: $('#name').value, email: $('#email').value, phone: $('#phone').value, notes: $('#notes').value },
    idempotencyKey: $('#idempotencyKey').value
  };
}

async function submitBooking(event) {
  event.preventDefault();
  $('#bookingResult').innerHTML = '<p class="hint">正在提交到服务器…</p>';
  try {
    const data = await api('/api/bookings', { method: 'POST', body: JSON.stringify(bookingPayload()) });
    $('#bookingResult').innerHTML = resultHtml(data);
    localStorage.removeItem(DRAFT_KEY);
    $('#draftBanner').classList.add('hidden');
  } catch (err) {
    const detail = err.data?.details?.conflicts?.map((c) => `<li>${esc(c.reason || c.type)}</li>`).join('') || '';
    $('#bookingResult').innerHTML = `<div class="notice error">${esc(err.message)}${detail ? `<ul>${detail}</ul>` : ''}</div>`;
  }
}

async function createHold() {
  if (!$('#name').value || !$('#email').value) {
    $('#bookingResult').innerHTML = '<div class="notice error">占位确认需要客户姓名和邮箱。</div>';
    return;
  }
  try {
    const data = await api('/api/holds', { method: 'POST', body: JSON.stringify(bookingPayload()) });
    state.activeHold = data.hold;
    $('#bookingResult').innerHTML = resultHtml(data, 'hold');
    $('#confirmHoldBtn').addEventListener('click', confirmHold);
  } catch (err) {
    $('#bookingResult').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
  }
}

async function confirmHold() {
  if (!state.activeHold) return;
  try {
    const data = await api('/api/holds/confirm', {
      method: 'POST',
      body: JSON.stringify({ holdId: state.activeHold.id, customer: { name: $('#name').value, email: $('#email').value, phone: $('#phone').value, notes: $('#notes').value }, idempotencyKey: uuid() })
    });
    $('#bookingResult').innerHTML = resultHtml(data);
    state.activeHold = null;
  } catch (err) {
    $('#bookingResult').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
  }
}

async function lookupBooking(event) {
  event.preventDefault();
  $('#lookupResult').innerHTML = '<p class="hint">查询中…</p>';
  try {
    const data = await api('/api/bookings/lookup', {
      method: 'POST',
      body: JSON.stringify({ bookingId: $('#lookupId').value.trim(), email: $('#lookupEmail').value.trim() })
    });
    const b = data.booking;
    const cls = data.lockState.locked ? 'status-confirmed' : b.status === 'waiting' ? 'status-waiting' : 'status-canceled';
    $('#lookupResult').innerHTML = `
      <span class="status-pill ${cls}">${data.lockState.label}</span>
      <h3>${b.number}</h3>
      <p>${esc(data.lockState.description)}</p>
      <p>套餐：${esc(b.snapshot.packageName)}（报价版本 v${b.snapshot.version}）<br/>开始：${esc(b.startUtc)}<br/>完整占用：${esc(b.occupiedStartUtc)} → ${esc(b.occupiedEndUtc)}</p>
      <p class="hint">已预约客户保留当时的价格和服务范围，后台修改套餐不会影响此订单。</p>
      ${b.status !== 'confirmed' && b.status !== 'waiting' ? '' : '<button class="button danger small" id="cancelBtn">取消预约（占用尚未实际开始）</button>'}
      <div id="cancelOut"></div>`;
    $('#cancelBtn')?.addEventListener('click', cancelBooking);
  } catch (err) {
    $('#lookupResult').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
  }
}

async function cancelBooking() {
  try {
    const data = await api('/api/bookings/cancel', {
      method: 'POST',
      body: JSON.stringify({ bookingId: $('#lookupId').value.trim(), reason: '客户在网页取消', idempotencyKey: uuid() })
    });
    $('#cancelOut').innerHTML = `<div class="notice success">状态：${data.lockState.label}。已释放尚未开始的资源。${data.promotion?.promoted?.length ? `队列 ${data.promotion.promoted.length} 单已自动确认。` : ''}</div>`;
  } catch (err) {
    $('#cancelOut').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
  }
}

function defaultFutureOpenTime() {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  d.setHours(10, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function bindUi() {
  $('#lbClose').addEventListener('click', closeLightbox);
  $('#lbPrev').addEventListener('click', () => moveLightbox(-1));
  $('#lbNext').addEventListener('click', () => moveLightbox(1));
  $('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') closeLightbox(); });
  document.addEventListener('keydown', (e) => {
    if ($('#lightbox').classList.contains('hidden')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') moveLightbox(-1);
    if (e.key === 'ArrowRight') moveLightbox(1);
  });
  $('#bookingForm').addEventListener('submit', submitBooking);
  $('#holdBtn').addEventListener('click', createHold);
  $('#lookupForm').addEventListener('submit', lookupBooking);
  ['timezone', 'startLocal', 'ambiguity'].forEach((id) => $('#' + id).addEventListener('change', () => { updatePreflight(); saveDraft(); }));
  ['name', 'email', 'phone', 'notes'].forEach((id) => $('#' + id).addEventListener('input', saveDraft));
}

initTimezones();
$('#idempotencyKey').value = uuid();
$('#startLocal').value = defaultFutureOpenTime();
loadContent().then(() => {
  renderPackageDetails();
  const saved = localStorage.getItem(DRAFT_KEY);
  if (saved) {
    try { applyDraft(JSON.parse(saved)); } catch { localStorage.removeItem(DRAFT_KEY); }
  }
  updatePreflight();
}).catch((err) => {
  $('#albumGrid').innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
});
bindUi();
window.__lumen = { getToken: () => localStorage.getItem(TOKEN_KEY), setToken: (v) => localStorage.setItem(TOKEN_KEY, v) };
