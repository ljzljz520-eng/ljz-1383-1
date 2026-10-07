const $=(s,r=document)=>r.querySelector(s); const $$=(s,r=document)=>[...r.querySelectorAll(s)];
let token=localStorage.getItem('admin-token')||'';
let resources=[], bookings=[];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=c=>`¥${(c/100).toLocaleString('zh-CN')}`;
async function api(path,opts={}){
  const {headers={},...rest}=opts;
  const res=await fetch('/api'+path,{...rest,headers:{'Content-Type':'application/json','x-admin-token':token,...headers}});
  const data=await res.json().catch(()=>({})); if(!res.ok)throw Object.assign(new Error(data.error||'请求失败'),{data}); return data;
}
function toast(msg,bad=false){const d=document.createElement('div');d.className='toast';d.style.background=bad?'#84231e':'#17201c';d.textContent=msg;document.body.appendChild(d);setTimeout(()=>d.remove(),3200)}
function statusName(s){return {held:'等待确认/短占位',queued:'排队中/不锁定',confirmed:'已锁定',cancelled:'已取消'}[s]||s}
function statusCls(s){return {held:'held',queued:'queued',confirmed:'confirmed',cancelled:'cancelled'}[s]||''}
async function loadAll(){if(!token)return; $('#adminNav').hidden=false; await Promise.all([loadBookings(),loadBlocks(),loadPackages(),loadAlbums(),loadLogs()]);}
async function loadResources(){if(!resources.length)({resources}=await api('/resources')); return resources}

async function loadBookings(){
  await loadResources();
  ({bookings}=await api('/admin/bookings'));
  $('#bookingsList').innerHTML = bookings.map(b=>`
  <div class="card" style="margin:12px 0;padding:16px">
    <div class="status-banner status-${statusCls(b.status)}"><span class="pill ${statusCls(b.status)}">${statusName(b.status)}</span>${esc(b.public_ref)} · ${esc(b.customer_name)} · ${money(b.price_cents)}</div>
    <p>${b.package_snapshot.name}（快照 v${b.package_snapshot.package_version}）<br>${esc(b.start_at)} → ${esc(b.end_at)} · ${esc(b.timezone)}</p>
    <div class="table-wrap"><table><thead><tr><th>资源</th><th>占用阶段</th><th>开始 UTC</th><th>结束 UTC</th></tr></thead><tbody>
    ${b.resources.map(r=>`<tr><td>${r.type} ${esc(r.name)}</td><td>${esc(r.phase_label)}</td><td>${r.phase_start}</td><td>${r.phase_end}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="admin-form">
      ${b.status==='queued'?`<button onclick="confirmQueue('${b.public_ref}')" class="primary">确认排队并锁定</button>`:''}
      <label>改期开拍 UTC<input id="rs-${b.id}" placeholder="2026-10-21T02:00:00Z"></label>
      <label>时区<input id="tz-${b.id}" value="${esc(b.timezone)}"></label>
      <label>原因<input id="reason-${b.id}" placeholder="人工改期原因"></label>
      <button onclick="reschedule('${b.public_ref}',${b.id})" class="warning">人工改期预检</button>
      <button onclick="cancelBooking('${b.public_ref}')" class="danger">取消未开始占用</button>
    </div>
    <p class="small">${esc(b.status_explanation)} ${b.hold_expires_at?`占位截止：${b.hold_expires_at}`:''} ${b.queue_position?`队列 #${b.queue_position}`:''}</p>
  </div>`).join('') || '<p>当前无活动预约。</p>';
}
async function confirmQueue(ref){try{await api(`/admin/bookings/${ref}/confirm-queue`,{method:'POST',body:'{}'});toast('排队请求已锁定');loadAll()}catch(e){showAdminConflict(e)}}
async function reschedule(ref,id){
  const start=$(`#rs-${id}`).value, timezone=$(`#tz-${id}`).value, reason=$(`#reason-${id}`).value;
  if(!start||!reason)return toast('请填写新 UTC 开始时间和改期原因',true);
  try{await api(`/admin/bookings/${ref}/reschedule`,{method:'POST',body:JSON.stringify({start_at:start,timezone,reason})});toast('改期成功，已写审计记录');loadAll()}catch(e){showAdminConflict(e)}
}
async function cancelBooking(ref){try{await api(`/admin/bookings/${ref}/cancel`,{method:'POST',body:JSON.stringify({reason:'后台取消未开始占用'})});toast('已取消并释放');loadAll()}catch(e){toast(e.data.error||e.message,true)}}
function showAdminConflict(e){if(!e.data.conflicts){toast(e.data.error||e.message,true);return} alert('冲突解释：\n\n'+e.data.conflicts.map(c=>`${c.resource.name}\n请求：${c.requested_phase.phase_label} ${c.requested_phase.phase_start}~${c.requested_phase.phase_end}\n冲突：${c.type==='admin_block'?c.existing.reason:c.existing.booking_ref+' '+c.existing.phase_label} ${c.existing.phase_start}~${c.existing.phase_end}\n重叠${Math.round(c.overlap_minutes)}分钟`).join('\n\n'))}

async function loadBlocks(){
  await loadResources();
  $('#blockResource').innerHTML=resources.map(r=>`<option value="${r.id}">${r.type} · ${r.name}</option>`).join('');
  const {blocks}=await api('/admin/blocks');
  $('#blockList').innerHTML=`<div class="table-wrap"><table><thead><tr><th>资源</th><th>开始</th><th>结束</th><th>原因</th><th></th></tr></thead><tbody>
  ${blocks.map(x=>`<tr><td>${x.resource_type} ${esc(x.resource_name)}</td><td>${x.start_at}</td><td>${x.end_at}</td><td>${esc(x.reason)}</td><td><button class="danger" onclick="deleteBlock(${x.id})">删除</button></td></tr>`).join('')}
  </tbody></table></div>`;
}
$('#blockForm')?.addEventListener('submit',async e=>{e.preventDefault(); const payload={resource_id:$('#blockResource').value,start_at:new Date($('#blockStart').value).toISOString(),end_at:new Date($('#blockEnd').value).toISOString(),reason:$('#blockReason').value};
  try{await api('/admin/blocks',{method:'POST',body:JSON.stringify(payload)});$('#blockReason').value='';toast('停用规则已加入');loadAll()}
  catch(e){if(e.data.conflicts){if(confirm(e.data.error+'\n\n是否仍强制保存后台拦截？')){payload.force=true; await api('/admin/blocks',{method:'POST',body:JSON.stringify(payload)});loadAll()}}else toast(e.message,true)}});
async function deleteBlock(id){await api('/admin/blocks/'+id,{method:'DELETE'});loadBlocks()}

async function loadPackages(){
  const {packages:pub}=await fetch('/api/packages').then(r=>r.json());
  $('#packageList').innerHTML=pub.map(p=>`<div class="card" style="margin:12px 0;padding:16px">
    <h3>${esc(p.name)} <span class="small">当前 v${p.version}</span></h3>
    <div class="admin-form">
      <label>新价格（分）<input id="price-${p.id}" value="${p.price_cents}"></label>
      <label>拍摄分钟<input id="dur-${p.id}" value="${p.duration_minutes}"></label>
      <label>前往分钟<input id="tb-${p.id}" value="${p.travel_before_minutes}"></label>
      <label>布置分钟<input id="setup-${p.id}" value="${p.setup_minutes}"></label>
      <label>撤场分钟<input id="tear-${p.id}" value="${p.teardown_minutes}"></label>
      <label>返程分钟<input id="ta-${p.id}" value="${p.travel_after_minutes}"></label>
      <label>服务范围（每行一项）<textarea id="scope-${p.id}" rows="3">${esc(p.included_scope.join('\n'))}</textarea></label>
      <button onclick="savePackage(${p.id})" class="primary">保存新版本</button>
    </div><p class="small">旧订单不会被改写，仍显示其下单时的价格和范围。</p></div>`).join('');
}
async function savePackage(id){
  const body={current_price_cents:Number($('#price-'+id).value),duration_minutes:Number($('#dur-'+id).value),travel_before_minutes:Number($('#tb-'+id).value),setup_minutes:Number($('#setup-'+id).value),teardown_minutes:Number($('#tear-'+id).value),travel_after_minutes:Number($('#ta-'+id).value),included_scope:$('#scope-'+id).value.split('\n').map(x=>x.trim()).filter(Boolean)};
  await api('/admin/packages/'+id,{method:'PUT',body:JSON.stringify(body)}); toast('套餐新版本已保存；旧预约报价不变');loadAll();
}

async function loadAlbums(){
  const {albums}=await api('/admin/albums');
  $('#albumAdminList').innerHTML=albums.map(a=>`<div class="card" style="margin:12px 0;padding:16px">
    <h3>${esc(a.title)} <span class="small">公开 v${a.published_version} / 工作 v${a.working_version}</span></h3>
    <div class="photo-grid">${a.photos.map(p=>`<div class="photo-card ${p.working_public_license?'':'revoked'}">
      <img src="${p.url}" alt="${esc(p.title)}"><p title="${esc(p.title)}">${esc(p.title)}</p>
      <p class="small">公开v${p.published_version}：${p.published_public_license?'仍公开':'已不公开'}；工作区：${p.working_public_license?'授权':'待发布撤销'}</p>
      <button class="${p.working_public_license?'danger':'primary'}" onclick="setLicense(${p.id},${p.working_public_license?0:1})">${p.working_public_license?'撤销公开许可':'恢复授权'}</button>
      <button class="secondary" onclick="setCover(${a.id},${p.id})">设封面</button>
    </div>`).join('')}</div>
    <button class="primary" onclick="publishAlbum(${a.id})">发布统一公开版本</button>
  </div>`).join('');
}
async function setLicense(id,v){await api(`/admin/photos/${id}/license`,{method:'PUT',body:JSON.stringify({public_license:!!v})});toast('工作授权已更新，需发布才公开生效');loadAlbums()}
async function setCover(albumId,photoId){try{await api(`/admin/albums/${albumId}/cover`,{method:'POST',body:JSON.stringify({photo_id:photoId})});toast('封面已选为待发布');loadAlbums()}catch(e){toast(e.message,true)}}
async function publishAlbum(id){await api(`/admin/albums/${id}/publish`,{method:'POST',body:'{}'});toast('已发布：灯箱、封面、授权版本一致');loadAll()}

async function loadLogs(){
  const {logs}=await api('/admin/audit-logs');
  $('#logsBody').innerHTML=logs.map(x=>`<tr><td>${x.created_at}</td><td>${esc(x.public_ref||'')}</td><td>${esc(x.action)}</td><td class="log-detail">${esc(typeof x.detail==='string'?x.detail:JSON.stringify(x.detail,null,2))}</td><td>${esc(x.actor)}</td></tr>`).join('');
}

$$('#adminNav a').forEach(a=>a.onclick=()=>{$$('#adminNav a').forEach(x=>x.classList.remove('active'));a.classList.add('active');$$('.admin-section').forEach(s=>s.classList.remove('active'));$('#'+a.dataset.tab).classList.add('active')});
$('#tokenBtn').onclick=()=>{token=$('#tokenInput').value.trim();localStorage.setItem('admin-token',token);loadAll().then(()=>toast('已进入后台')).catch(e=>{token='';localStorage.removeItem('admin-token');toast(e.message,true)})};
if(token){$('#tokenInput').value=token;loadAll().catch(e=>toast(e.message,true))}
setInterval(()=>{if(token&&$('#bookings').classList.contains('active'))loadBookings().catch(()=>{})},5000);
