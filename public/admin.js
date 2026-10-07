const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
let state = null;
const TOKEN_KEY = 'lumen.adminToken';

function token() { return localStorage.getItem(TOKEN_KEY) || ''; }
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}`, ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || '请求失败');
    err.data = data;
    throw err;
  }
  return data;
}
function msg(text, kind = 'info') {
  $('#message').innerHTML = `<div class="notice ${kind}">${esc(text)}</div>`;
  setTimeout(() => $('#message').innerHTML = '', 5000);
}
function statusPill(status) {
  const map = { waiting: '等待确认', confirmed: '已锁定', offered: '已给报价', expired: '已到期', customer_canceled: '客户取消', admin_canceled: '后台取消' };
  const cls = status === 'waiting' ? 'status-waiting' : status === 'confirmed' || status === 'offered' ? 'status-confirmed' : status === 'hold' ? 'status-hold' : 'status-canceled';
  return `<span class="status-pill ${cls}">${map[status] || status}</span>`;
}

async function loadState(prune = false) {
  if (prune) await api('/api/admin/maintenance/prune', { method: 'POST' });
  state = await api('/api/admin/state');
  renderAll();
}

function renderBookings() {
  const rows = [...state.bookings].sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  const holds = state.holds.filter((h) => h.status === 'active');
  const holdHtml = holds.length ? `<div class="card table-wrap" style="margin-bottom:18px"><h3 style="padding:16px">活动临时占位</h3><table><thead><tr><th>单号</th><th>开始</th><th>到期</th><th>资源</th></tr></thead><tbody>${
    holds.map((h) => `<tr><td>${h.number}</td><td>${h.occupiedStartUtc}</td><td>${h.expiresAt}</td><td>${h.resourceSelection.map(r => esc(r.resourceName)).join('<br/>')}</td></tr>`).join('')
  }</tbody></table></div>` : '';
  const cards = rows.map((b) => {
    const conflicts = b.rescheduleHistory?.at(-1)?.conflictExplanation || [];
    return `<article class="card form">
      ${statusPill(b.status)}
      <h3>${b.number}</h3>
      <p><strong>${esc(b.snapshot.packageName)}</strong> v${b.snapshot.version}<br/>${esc(b.customer.name)} / ${esc(b.customer.email)}</p>
      <p>正式：${b.startUtc}<br/>占用：${b.occupiedStartUtc}<br/>至：${b.occupiedEndUtc}</p>
      <p class="hint">报价 ${b.snapshot.price} ${b.snapshot.currency}；${b.snapshot.serviceScope.join('、')}</p>
      <p>${b.resourceSelection.map((r) => `${esc(r.role)}: ${esc(r.resourceName)}`).join('<br/>') || '尚未分配资源'}</p>
      ${b.forcedOverlap ? '<div class="notice error">存在人工强制覆盖，请查看记录。</div>' : ''}
      ${conflicts.length ? `<details><summary>冲突解释（${conflicts.length}）</summary><pre>${esc(JSON.stringify(conflicts, null, 2))}</pre></details>` : ''}
      ${(b.rescheduleHistory || []).map((h) => `<p class="hint">改期：${h.at}，${esc(h.reason)}${h.forced ? '（强制）' : ''}</p>`).join('')}
      <div class="button-row">
        ${b.status === 'waiting' ? `<button class="button small primary" onclick="window.admin.confirmBooking('${b.id}')">人工确认</button>` : ''}
        ${['waiting', 'confirmed'].includes(b.status) ? `<button class="button small danger" onclick="window.admin.cancelBooking('${b.id}')">取消</button>` : ''}
      </div>
    </article>`;
  }).join('');
  $('#bookingCards').innerHTML = holdHtml + (cards || '<p>暂无预约。</p>');
}

function renderSchedule() {
  $('#scheduleTz').value = state.schedule.timezone;
  const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  $('#weeklyRows').innerHTML = [1, 2, 3, 4, 5, 6, 0].map((day) => {
    const row = state.schedule.weekly.find((w) => w.day === day) || { start: '', end: '' };
    return `<div class="grid-two"><label>${dayNames[day]}<input data-day="${day}" data-field="start" type="time" value="${row.start || ''}"></label>
      <label>结束<input data-day="${day}" data-field="end" type="time" value="${row.end || ''}"></label></div>`;
  }).join('');
  $('#overrideList').innerHTML = `<table><thead><tr><th>日期</th><th>规则</th><th>原因</th><th></th></tr></thead><tbody>${
    state.schedule.dateOverrides.map((o) => `<tr><td>${o.date}</td><td>${o.closed ? '封闭' : o.ranges.map(r => `${r.start}-${r.end}`).join('，')}</td><td>${esc(o.reason)}</td><td><button class="button small danger" onclick="window.admin.deleteOverride('${o.date}')">删除</button></td></tr>`).join('')
  }</tbody></table>`;
  $('#resourcePick').innerHTML = state.resources.map((r) => `<label class="check"><input type="checkbox" value="${r.id}" /> ${esc(r.name)}</label>`).join('');
  $('#blockList').innerHTML = `<table><thead><tr><th>标题</th><th>占用区间</th><th>资源</th><th></th></tr></thead><tbody>${
    state.blocks.map((b) => `<tr><td>${esc(b.title)}<br/><span class="hint">${esc(b.reason)}</span></td><td>${new Date(b.interval.occupiedStartMs).toISOString()}<br/>${new Date(b.interval.occupiedEndMs).toISOString()}</td><td>${b.allResources ? '全部' : b.resourceIds.map(id => esc(state.resources.find(r => r.id === id)?.name || id)).join('，')}</td><td><button class="button small danger" onclick="window.admin.deleteBlock('${b.id}')">删除</button></td></tr>`).join('')
  }</tbody></table>`;
}

function renderPackages() {
  $('#packageEditor').innerHTML = state.packages.map((p) => `
    <form class="card form package-form" data-id="${p.id}">
      <h3>${esc(p.name)}</h3>
      <p class="hint">当前 v${p.currentVersion}。修改价格、时长、服务或资源会产生新版本；已预约订单继续引用旧 snapshot。</p>
      <div class="grid-two">
        <label>价格<input name="price" type="number" value="${p.price}" /></label>
        <label>名称<input name="name" value="${esc(p.name)}" /></label>
        <label>正式拍摄分钟<input name="durationMin" type="number" value="${p.durationMin}" /></label>
        <label>到达交通<input name="travelInMin" type="number" value="${p.travelInMin}" /></label>
        <label>布置<input name="prepMin" type="number" value="${p.prepMin}" /></label>
        <label>撤场<input name="breakdownMin" type="number" value="${p.breakdownMin}" /></label>
        <label>离开交通<input name="travelOutMin" type="number" value="${p.travelOutMin}" /></label>
        <label>上架<select name="active"><option value="true" ${p.active ? 'selected' : ''}>是</option><option value="false" ${!p.active ? 'selected' : ''}>否</option></select></label>
      </div>
      <label>服务范围（每行一项）<textarea name="serviceScope" rows="5">${esc(p.serviceScope.join('\n'))}</textarea></label>
      <label>修改原因<input name="reason" placeholder="2027 春季价目表更新" /></label>
      <h4>资源候选组</h4>
      ${p.resourceGroups.map((g, gi) => `<label>${esc(g.role)}
        <select name="group-${gi}" multiple size="4">${state.resources.map((r) => `<option value="${r.id}" ${g.anyOf.includes(r.id) ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>`).join('')}
      <button class="button primary">保存并按需生成新版本</button>
      <details><summary>历史版本</summary><pre>${esc(JSON.stringify(p.versions, null, 2))}</pre></details>
    </form>`).join('');
  $$('.package-form').forEach((form) => form.addEventListener('submit', savePackage));
}

async function savePackage(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const fd = new FormData(form);
  const resourceGroups = [];
  const original = state.packages.find((p) => p.id === form.dataset.id);
  original.resourceGroups.forEach((g, gi) => {
    const options = form.querySelectorAll(`[name="group-${gi}"] option`);
    const anyOf = [...form.querySelectorAll(`[name="group-${gi}"] option:checked`)].map((o) => o.value);
    resourceGroups.push({ role: g.role, anyOf });
  });
  try {
    await api(`/api/admin/packages/${form.dataset.id}`, {
      method: 'PUT',
      body: {
        name: fd.get('name'),
        price: Number(fd.get('price')),
        durationMin: Number(fd.get('durationMin')),
        travelInMin: Number(fd.get('travelInMin')),
        prepMin: Number(fd.get('prepMin')),
        breakdownMin: Number(fd.get('breakdownMin')),
        travelOutMin: Number(fd.get('travelOutMin')),
        active: fd.get('active') === 'true',
        serviceScope: String(fd.get('serviceScope')).split('\n').map((s) => s.trim()).filter(Boolean),
        resourceGroups,
        reason: fd.get('reason')
      }
    });
    msg('套餐已保存；已预约客户仍保留原报价和服务范围。', 'success');
    await loadState();
  } catch (err) { msg(err.message, 'error'); }
}

function renderResources() {
  $('#resourceList').innerHTML = `<table><thead><tr><th>资源</th><th>类型</th><th>状态</th><th></th></tr></thead><tbody>${
    state.resources.map((r) => `<tr><td>${esc(r.name)}<br/><span class="hint">${r.id}</span></td><td>${esc(r.kind)}</td><td>${r.active ? '启用' : '停用'}</td><td><button class="button small" onclick="window.admin.toggleResource('${r.id}', ${!r.active})">${r.active ? '停用' : '启用'}</button></td></tr>`).join('')
  }</tbody></table>`;
}

function renderContent() {
  $('#licensePanel').innerHTML = state.albums.map((album) => `<article class="card form">
    <h3>${esc(album.title)} <label class="check"><input type="checkbox" ${album.publicLicense ? 'checked' : ''} onchange="window.admin.albumLicense('${album.id}', this.checked)"/> 相册公开授权</label></h3>
    <p class="hint">清单 v${album.manifestVersion}，封面：${esc(album.coverPhotoId)}</p>
    ${state.photos.filter((p) => p.albumId === album.id).map((p) => `<div style="display:flex;justify-content:space-between;gap:10px;align-items:center">
      <div><strong>${esc(p.title)}</strong><br><span class="hint">媒体 v${p.mediaVersion} · ${esc(p.licenseTerms)}</span></div>
      <label class="check"><input type="checkbox" ${p.publicLicense ? 'checked' : ''} onchange="window.admin.photoLicense('${p.id}', this.checked)"/> 公开</label>
    </div>`).join('')}
  </article>`).join('');
}

function renderAudit() {
  $('#auditPanel').innerHTML = `<table><thead><tr><th>时间</th><th>动作</th><th>详情</th></tr></thead><tbody>${
    state.auditLog.map((a) => `<tr><td>${a.at}</td><td>${esc(a.action)}</td><td><details><summary>查看</summary><pre>${esc(JSON.stringify(a.details, null, 2))}</pre></details></td></tr>`).join('')
  }</tbody></table>`;
}

function renderAll() {
  if (!state) return;
  renderBookings();
  renderSchedule();
  renderPackages();
  renderResources();
  renderContent();
  renderAudit();
}

window.admin = {
  async confirmBooking(id) {
    try { await api('/api/admin/bookings/confirm', { method: 'POST', body: { bookingId: id, reason: '后台人工确认' } }); msg('已确认并锁定。', 'success'); await loadState(); }
    catch (err) {
      if (confirm(`${err.message}\n是否强制确认？\n${JSON.stringify(err.data?.details?.conflicts || [], null, 2)}`)) {
        await api('/api/admin/bookings/confirm', { method: 'POST', body: { bookingId: id, force: true, reason: '后台强制确认' } });
        await loadState();
      }
    }
  },
  async cancelBooking(id) {
    if (!confirm('确定取消？只有交通、布置和正式拍摄尚未实际开始的占用会释放资源。')) return;
    await api('/api/admin/bookings/cancel', { method: 'POST', body: { bookingId: id, reason: '后台取消', idempotencyKey: crypto.randomUUID() } });
    await loadState();
  },
  async toggleResource(id, active) {
    await api(`/api/admin/resources/${id}`, { method: 'PUT', body: { active } });
    await loadState();
  },
  async photoLicense(id, publicLicense) {
    await api(`/api/admin/photos/${id}/license`, { method: 'PUT', body: { publicLicense } });
    msg('照片授权已变更；封面和公开灯箱序列会使用新清单。', 'success');
    await loadState();
  },
  async albumLicense(id, publicLicense) {
    await api(`/api/admin/albums/${id}/license`, { method: 'PUT', body: { publicLicense } });
    await loadState();
  },
  async deleteOverride(date) {
    await api(`/api/admin/schedule/overrides/${date}`, { method: 'DELETE' });
    await loadState();
  },
  async deleteBlock(id) {
    await api(`/api/admin/blocks/${id}`, { method: 'DELETE' });
    await loadState();
  }
};

$('#loginBtn').addEventListener('click', () => {
  localStorage.setItem(TOKEN_KEY, $('#adminToken').value.trim());
  loadState().then(() => msg('已登录', 'success')).catch((err) => msg(err.message, 'error'));
});
$('#refreshBtn').addEventListener('click', () => loadState(true).then(() => msg('已刷新，过期占位已恢复，队列已重新评估。', 'success')).catch((err) => msg(err.message, 'error')));
$$('[data-tab]').forEach((btn) => btn.addEventListener('click', () => {
  $$('[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
  $$('.tab').forEach((t) => t.classList.add('hidden'));
  $(`#tab-${btn.dataset.tab}`).classList.remove('hidden');
  $('#pageTitle').textContent = btn.textContent;
}));
$('#saveScheduleBtn').addEventListener('click', async () => {
  const weekly = $$('#weeklyRows input').reduce((acc, input) => {
    const day = Number(input.dataset.day);
    let row = acc.find((x) => x.day === day);
    if (!row) { row = { day, start: '', end: '' }; acc.push(row); }
    row[input.dataset.field] = input.value;
    return acc;
  }, []).filter((r) => r.start && r.end);
  await api('/api/admin/schedule', { method: 'PUT', body: { timezone: $('#scheduleTz').value, weekly } });
  msg('营业规则已保存。注意：既有预约仍以 UTC 保存，不会因后台改时区而漂移。', 'success');
  await loadState();
});
$('#addOverrideBtn').addEventListener('click', async () => {
  await api('/api/admin/schedule/overrides', { method: 'PUT', body: {
    date: $('#ovDate').value, closed: $('#ovClosed').checked, reason: $('#ovReason').value,
    ranges: [{ start: $('#ovStart').value, end: $('#ovEnd').value }]
  } });
  await loadState();
});
$('#addBlockBtn').addEventListener('click', async () => {
  try {
    await api('/api/admin/blocks', { method: 'POST', body: {
      title: $('#blockTitle').value, reason: '后台人工占用', allResources: $('#blockAll').checked,
      resourceIds: $$('#resourcePick input:checked').map((i) => i.value),
      timezone: $('#blockTz').value, startLocal: $('#blockStart').value, endLocal: $('#blockEnd').value,
      beforeMin: Number($('#blockBefore').value), afterMin: Number($('#blockAfter').value)
    } });
    msg('后台占用已加入。', 'success'); await loadState();
  } catch (err) { msg(err.message, 'error'); }
});
$('#rescheduleBtn').addEventListener('click', async () => {
  try {
    const data = await api('/api/admin/bookings/reschedule', { method: 'POST', body: {
      bookingId: $('#rsId').value.trim(), startLocal: $('#rsStart').value, timezone: $('#rsTz').value,
      reason: $('#rsReason').value, force: $('#rsForce').checked
    } });
    msg('改期成功，记录已保存。', 'success');
    if (data.conflicts.length) console.warn('强制覆盖冲突', data.conflicts);
    await loadState();
  } catch (err) {
    msg(err.message, 'error');
    alert(JSON.stringify(err.data?.details?.conflicts || err.data, null, 2));
  }
});
$('#resourceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/admin/resources', { method: 'PUT', body: { name: $('#newResourceName').value, kind: $('#newResourceKind').value } });
  await loadState();
});

if (token()) {
  $('#adminToken').value = token();
  loadState().catch(() => {});
}
