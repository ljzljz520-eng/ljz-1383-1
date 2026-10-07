const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const api = async (path, opts={}) => {
  const {headers={}, ...rest}=opts;
  const res = await fetch('/api'+path, {
    ...rest,
    headers: {'Content-Type':'application/json', ...headers}
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw Object.assign(new Error(data.error||'请求失败'), {data, status:res.status});
  return data;
};
const money = c => `¥${(c/100).toLocaleString('zh-CN')}`;
const DRAFT_KEY = 'photo-booking-draft-v1';
const IDEM_KEY = 'photo-booking-idempotency-v1';
let albums=[], styles=[], packages=[], currentStyle='', currentAlbumPhotos=[], currentAlbum=null, lbIndex=0, currentRef=null, idempotencyKey=crypto.randomUUID();

async function init(initialTimezone){
  [styles,{albums:albums},{packages}] = await Promise.all([
    api('/styles'), api('/albums'), api('/packages')
  ]);
  $('#timezoneSelect').value = initialTimezone || 'UTC';
  $('#timezoneSelect').dataset.previousTz = initialTimezone || 'UTC';
  renderStyles(); renderAlbums(); renderPackages(); restoreDraft(); bindEvents();
}

function renderStyles(){
  $('#styleFilters').innerHTML = ['<button class="chip active" data-slug="">全部</button>',
    ...styles.map(s=>`<button class="chip" data-slug="${s.slug}">${s.name}</button>`)].join('');
  $$('#styleFilters .chip').forEach(b=>b.onclick=()=>{currentStyle=b.dataset.slug; $$('#styleFilters .chip').forEach(x=>x.classList.toggle('active',x===b)); renderAlbums();});
}
function renderAlbums(){
  const list = currentStyle ? albums.filter(a=>a.style.slug===currentStyle) : albums;
  $('#albumGrid').innerHTML = list.map(a=>`<article class="album-card">
    <img class="cover" src="${a.cover?.url||''}" alt="${a.cover?.title||a.title}" />
    <div class="album-body"><span class="style-tag">${a.style.name}</span><h3>${a.title}</h3>
    <p class="desc">${a.description}</p><button class="secondary open-album" data-id="${a.id}">查看授权灯箱序列</button></div>
  </article>`).join('');
  $$('#albumGrid .open-album').forEach(b=>b.onclick=()=>openLightbox(albums.find(a=>a.id===Number(b.dataset.id))));
}
function openLightbox(album){
  currentAlbum=album; currentAlbumPhotos=album.photos; lbIndex=0;
  $('#lightbox').classList.remove('hidden');
  updateLightbox(album);
}
function updateLightbox(album){
  const p=currentAlbumPhotos[lbIndex];
  $('#lbImage').src=p.url; $('#lbImage').alt=p.title; $('#lbCaption').textContent=p.title;
  $('#lbMeta').textContent=`${album.title} · 公开发布版本 v${album.version} · 第 ${lbIndex+1}/${currentAlbumPhotos.length} 张 · 只展示已授权照片`;
}
function closeLightbox(){$('#lightbox').classList.add('hidden')}

function renderPackages(){
  const sel=$('#packageSelect');
  sel.innerHTML=packages.map(p=>`<option value="${p.id}">${p.name} · ${money(p.price_cents)}</option>`).join('');
  renderPackageInfo();
}
function selectedPkg(){return packages.find(p=>p.id===Number($('#packageSelect').value))}
function renderPackageInfo(){
  const p=selectedPkg(); if(!p)return;
  $('#packageInfo').innerHTML = `<p>${p.description}</p>
  <p><strong>${money(p.price_cents)}</strong>，拍摄 ${p.duration_minutes} 分钟；总占用含往返 ${p.travel_before_minutes}+${p.travel_after_minutes} 分钟、布置 ${p.setup_minutes} 分钟、撤场 ${p.teardown_minutes} 分钟。</p>
  <ul>${p.included_scope.map(x=>`<li>${x}</li>`).join('')}</ul>`;
  $('#resourceChoices').innerHTML=p.resources.map(r=>`<label><input type="checkbox" name="resource" value="${r.id}" ${r.role==='required'?'checked':''} ${r.role==='required'?'required':''}>
    <span>${r.type==='photographer'?'摄影师':r.type==='assistant'?'助手':r.type==='equipment'?'器材':'场地'}：${r.name}${r.role==='required'?' <em>必需</em>':' 可选'}</span></label>`).join('');
}
function selectedResources(){return $$('input[name=resource]:checked').map(x=>Number(x.value))}
function draftData(){return {
  package_id:Number($('#packageSelect').value), resource_ids:selectedResources(),
  start_utc:$('#startAt').value ? localInputToUtc($('#startAt').value,$('#timezoneSelect').value) : '', start_local:$('#startAt').value, timezone:$('#timezoneSelect').value,
  customer_name:$('#customerName').value, customer_contact:$('#customerContact').value,note:$('#note').value, saved_at:new Date().toISOString()
}}
function saveDraft(show=true){
  localStorage.setItem(DRAFT_KEY,JSON.stringify(draftData()));
  if(show) toast('草稿仅保存在本机，可跨页恢复；这不表示已预订。');
}
function restoreDraft(){
  const raw=localStorage.getItem(DRAFT_KEY); if(!raw)return;
  try{ const d=JSON.parse(raw);
    $('#packageSelect').value=d.package_id; renderPackageInfo();
    $$('input[name=resource]').forEach(c=>c.checked=d.resource_ids.includes(Number(c.value)));
    $('#timezoneSelect').value=d.timezone || 'UTC';
    $('#timezoneSelect').dataset.previousTz=d.timezone || 'UTC';
    if(d.start_utc)$('#startAt').value=utcToLocalInput(d.start_utc,$('#timezoneSelect').value);
    else if(d.start_local)$('#startAt').value=d.start_local;
    $('#customerName').value=d.customer_name||''; $('#customerContact').value=d.customer_contact||''; $('#note').value=d.note||'';
    $('#draftNotice').classList.remove('hidden');
    $('#draftNotice').innerHTML=`已恢复 ${new Date(d.saved_at).toLocaleString()} 的本地草稿。它<strong>不是成功预订</strong>，请检查档期后提交。 <button type="button" class="secondary" onclick="clearDraftNotice()">忽略</button>`;
  }catch{}
}
function clearDraftNotice(){$('#draftNotice').classList.add('hidden')}
window.clearDraftNotice=clearDraftNotice;

// --- timezone conversion without a date library ---
function tzOffsetMinutes(date, tz){
  if(tz==='UTC') return 0;
  const dtf=new Intl.DateTimeFormat('en-US',{timeZone:tz,hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const parts=Object.fromEntries(dtf.formatToParts(date).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));
  const asUTC=Date.UTC(parts.year,parts.month-1,parts.day,parts.hour%24,parts.minute,parts.second);
  return Math.round((asUTC-date.getTime())/60000);
}
function localInputToUtc(value,tz){
  if(!value)return '';
  const [date,time='00:00']=value.split('T'); const [y,m,d]=date.split('-').map(Number);
  const [hh,mm]=time.split(':').map(Number);
  const guess=Date.UTC(y,m-1,d,hh,mm);
  const off=tzOffsetMinutes(new Date(guess),tz);
  return new Date(guess-off*60000).toISOString();
}
function utcToLocalInput(iso,tz){
  const d=new Date(iso); const off=tzOffsetMinutes(d,tz); const local=new Date(d.getTime()+off*60000);
  return local.toISOString().slice(0,16);
}
function fmtUtc(iso,tz){return new Intl.DateTimeFormat('zh-CN',{timeZone:tz,dateStyle:'short',timeStyle:'short'}).format(new Date(iso))}

async function checkAvailability(){
  saveDraft(false);
  const p=selectedPkg(), start=localInputToUtc($('#startAt').value,$('#timezoneSelect').value);
  const data=await api(`/availability?package_id=${p.id}&start_at=${encodeURIComponent(start)}&timezone=${encodeURIComponent($('#timezoneSelect').value)}&resources=${selectedResources().join(',')}`);
  renderAvailability(data,false);
}
function renderAvailability(data,created){
  const p=selectedPkg();
  const tz=$('#timezoneSelect').value;
  $('#phaseSummary').innerHTML=data.phases.map(x=>`<div class="phase-row"><span>${x.phase_label}</span><span>${fmtUtc(x.phase_start,tz)} – ${fmtUtc(x.phase_end,tz)}</span></div>`).join('');
  if(data.available){
    $('#resultPanel').innerHTML=created?'':`<div class="status-banner status-confirmed">该时段检查通过。注意：仅检查通过仍不锁定，请选择短租约占位或排队提交。</div>`;
  } else {
    $('#resultPanel').innerHTML='';
  }
  $('#conflictPanel').innerHTML=data.conflicts.length?data.conflicts.map(c=>`<div class="conflict">
    <strong>${c.type==='admin_block'?'后台停用/维护':'预约冲突'}</strong>：${c.resource.type}「${c.resource.name}」<br>
    你的 ${c.requested_phase.phase_label}（${fmtUtc(c.requested_phase.phase_start,tz)}–${fmtUtc(c.requested_phase.phase_end,tz)}）
    与 ${c.type==='admin_block'?c.existing.reason:`${c.existing.status==='held'?'临时占位':'已锁定'} ${c.existing.booking_ref}`} 的 ${c.existing.phase_label||'停用'} 重叠 ${Math.round(c.overlap_minutes)} 分钟。
  </div>`).join(''):'<p class="small">无冲突解释。</p>';
}

async function submit(mode){
  saveDraft(false);
  const p=selectedPkg(); const start=localInputToUtc($('#startAt').value,$('#timezoneSelect').value);
  const payload={...draftData(),start_at:start,mode,idempotency_key:idempotencyKey};
  delete payload.start_local; delete payload.start_utc; delete payload.saved_at;
  try{
    const data=await api('/bookings',{method:'POST',body:JSON.stringify(payload)});
    localStorage.removeItem(DRAFT_KEY);
    $('#draftNotice').classList.add('hidden');
    renderBooking(data.booking, data.idempotent_replay?data.notice:'');
  }catch(e){
    if(e.status===409 && e.data.conflicts){
      renderAvailability({phases:e.data.phases || [], conflicts:e.data.conflicts, available:false});
    }
    $('#resultPanel').innerHTML=`<div class="status-banner status-cancelled">${e.data.error}</div>`;
  }
}

function renderBooking(b,notice=''){
  currentRef=b.public_ref;
  const tz=$('#timezoneSelect').value;
  const labels={held:['等待确认 · 短租约占位','status-held'],queued:['排队中 · 等待后台确认','status-queued'],confirmed:['已锁定 · 预约成功','status-confirmed'],cancelled:['已取消 · 占用释放','status-cancelled']};
  const [label,cls]=labels[b.status]||[b.status,''];
  let actions='';
  if(b.status==='held')actions=`<p>占位截止：${fmtUtc(b.hold_expires_at,tz)}，到期自动释放。</p><button class="primary" id="confirmBtn">立即确认，锁定档期</button>`;
  if(b.status==='queued')actions=`<p>队列位置 #${b.queue_position}。此状态不锁定资源，请等待后台确认。</p>`;
  if(b.status==='confirmed')actions=`<p>确认时间：${fmtUtc(b.confirmed_at,tz)}</p>`;
  if(['held','queued','confirmed'].includes(b.status))actions+=` <button class="danger" id="cancelBtn">取消未开始预约</button>`;
  $('#resultPanel').innerHTML=`<div class="status-banner ${cls}">${label} ${notice}</div>
    <p><strong>${b.public_ref}</strong></p><p>${b.package_snapshot.name} · 客户报价 ${money(b.price_cents)}（套餐后续修改不影响此单）</p>
    <p>${fmtUtc(b.start_at,tz)} – ${fmtUtc(b.end_at,tz)}（${b.timezone} 提交）</p>
    ${b.resources.map(r=>`<div class="phase-row"><span>${r.name}</span><span>${r.phase_label} ${fmtUtc(r.phase_start,tz)}–${fmtUtc(r.phase_end,tz)}</span></div>`).join('')}
    ${actions}<p class="small">${b.status_explanation}</p>`;
  $('#conflictPanel').innerHTML='';
  $('#confirmBtn')?.addEventListener('click',confirmBooking);
  $('#cancelBtn')?.addEventListener('click',()=>cancelBooking(b.public_ref));
}
async function confirmBooking(){
  try{const {booking}=await api(`/bookings/${currentRef}/confirm`,{method:'POST',body:'{}'});renderBooking(booking)}
  catch(e){$('#resultPanel').insertAdjacentHTML('beforeend',`<div class="conflict"><strong>${e.data.error}</strong></div>`)}
}
async function cancelBooking(ref){
  const {booking,notice}=await api(`/bookings/${ref}/cancel`,{method:'POST',body:JSON.stringify({reason:'客户取消'})});
  renderBooking(booking,notice||'');
}
function toast(msg){
  const el=document.createElement('div');el.className='toast';el.textContent=msg;document.body.appendChild(el);
  setTimeout(()=>el.remove(),2600);
}

function bindEvents(){
  $('#packageSelect').onchange=()=>{renderPackageInfo();saveDraft(false)};
  $('#resourceChoices').onchange=()=>saveDraft(false);
  ['customerName','customerContact','note'].forEach(id=>$('#'+id).addEventListener('input',()=>saveDraft(false)));
  $('#timezoneSelect').onchange=()=>{
    const value=$('#startAt').value;
    if(value){
      const previousTz=$('#timezoneSelect').dataset.previousTz || 'UTC';
      const utc=localInputToUtc(value,previousTz);
      $('#startAt').value=utcToLocalInput(utc,$('#timezoneSelect').value);
    }
    $('#timezoneSelect').dataset.previousTz=$('#timezoneSelect').value;
    saveDraft(false);
  };
  $('#startAt').onchange=()=>saveDraft(false);
  $('#checkBtn').onclick=()=>checkAvailability().catch(e=>toast(e.message));
  $('#holdBtn').form?.addEventListener?.('submit',e=>e.preventDefault());
  $('#bookingForm').onsubmit=e=>{e.preventDefault();submit('hold')};
  $('#queueBtn').onclick=()=>submit('queue');
  $('#lbClose').onclick=closeLightbox; $('#lightbox').onclick=e=>{if(e.target.id==='lightbox')closeLightbox()};
  $('#lbPrev').onclick=()=>{lbIndex=(lbIndex-1+currentAlbumPhotos.length)%currentAlbumPhotos.length;updateLightbox(currentAlbum)};
  $('#lbNext').onclick=()=>{lbIndex=(lbIndex+1)%currentAlbumPhotos.length;updateLightbox(currentAlbum)};
  document.addEventListener('keydown',e=>{if($('#lightbox').classList.contains('hidden'))return;if(e.key==='Escape')closeLightbox();if(e.key==='ArrowLeft')$('#lbPrev').click();if(e.key==='ArrowRight')$('#lbNext').click()});
}
// Use the browser timezone before restoring a cross-page draft; restoration converts the saved UTC instant.
async function boot(){
  const browserTz=Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  await init(browserTz);
}
boot().catch(e=>{document.body.insertAdjacentHTML('beforeend',`<div class="toast">${e.message}</div>`)});
