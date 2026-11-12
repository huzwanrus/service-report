'use strict';
/* JN Service Report — app untuk field engineer
 * Rekod disimpan dalam phone (IndexedDB) dan disegerakkan ke Google Sheets.
 * Nombor report (JNA001, JNA002 ... JNB001) dikeluarkan oleh server supaya
 * tidak bertindih antara engineer.
 */
const APP_VERSION = '1.1.1';
const WORK_TYPES = ['Installation', 'PPM', 'Repair Service', 'Corrective'];
const COMPANY = {
  name: 'Biz Medic Sdn Bhd',
  addr: 'Suite 10-2, Level 10, Menara TCM, Jalan Tun Razak, 50400 Kuala Lumpur · +603-79711370 · Reg: 667759-A'
};
const STATUS = {
  draft: ['Draf', 'b-draft'],
  pending: ['Belum sync', 'b-pending'],
  synced: ['Tersimpan', 'b-synced']
};

/* ---------------- Helpers ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const fmtDate = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || ''); };
const fmtDT = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const blobToDataURL = b => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(b); });

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), ms);
}

/* ---------------- Storage (IndexedDB) ---------------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('jn-service-report', 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('reports', { keyPath: 'id' }); d.createObjectStore('meta'); };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode); const q = fn(t.objectStore(store)); let out;
      if (q) q.onsuccess = () => { out = q.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  all() { return this.tx('reports', 'readonly', s => s.getAll()); },
  get(id) { return this.tx('reports', 'readonly', s => s.get(id)); },
  put(r) { return this.tx('reports', 'readwrite', s => s.put(r)); },
  del(id) { return this.tx('reports', 'readwrite', s => s.delete(id)); },
  getMeta(k) { return this.tx('meta', 'readonly', s => s.get(k)); },
  setMeta(k, v) { return this.tx('meta', 'readwrite', s => s.put(v, k)); }
};

let S = { url: '', token: '', engineer: '' };   // tetapan
let LOGO = null;                                 // logo dataURL untuk PDF
const ui = { filter: 'all', q: '' };
let cur = null;                                  // report yang sedang diedit
let saveT = null;

/* ---------------- Server API ---------------- */
async function api(action, payload = {}) {
  if (!S.url) throw new Error('URL server belum ditetapkan');
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 45000);
  try {
    const res = await fetch(S.url, { method: 'POST', body: JSON.stringify({ action, token: S.token, ...payload }), signal: ctl.signal, redirect: 'follow' });
    let j; try { j = await res.json(); } catch (e) { throw new Error('Jawapan server tidak sah (semak URL web app)'); }
    if (!j.ok) throw new Error(j.error || 'Ralat server');
    return j;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Server tidak menjawab (timeout)');
    if (e instanceof TypeError) throw new Error('Tiada sambungan ke server');
    throw e;
  } finally { clearTimeout(t); }
}

let syncing = false;
async function sync({ quiet = false } = {}) {
  if (syncing) return;
  if (!S.url || !navigator.onLine) { updatePill(); return; }
  syncing = true; updatePill();
  let err = null, sent = 0, pulled = 0;
  try {
    const pending = (await DB.all()).filter(r => r.status === 'pending');
    for (const r of pending) {
      const { status, ...report } = r;
      const j = await api('submit', { report });
      const now = await DB.get(r.id);
      if (!now) continue;
      now.reportNo = j.reportNo; now.serverUpdatedAt = j.serverUpdatedAt;
      if (now.updatedAt === r.updatedAt) now.status = 'synced';  // jika diedit semasa sync, kekal pending
      await DB.put(now); sent++;
      if (cur && cur.id === now.id) { cur.reportNo = now.reportNo; cur.serverUpdatedAt = now.serverUpdatedAt; cur.status = now.status; }
    }
    const since = (await DB.getMeta('lastPull')) || '';
    const j = await api('list', { since });
    let max = since;
    for (const s of j.reports || []) {
      if (!s.id) continue;
      const l = await DB.get(s.id);
      if (!l || (l.status === 'synced' && (s.serverUpdatedAt || '') > (l.serverUpdatedAt || ''))) {
        s.workTypes = Array.isArray(s.workTypes) ? s.workTypes : [];
        s.parts = Array.isArray(s.parts) ? s.parts : [];
        await DB.put({ ...s, status: 'synced' }); pulled++;
      }
      if ((s.serverUpdatedAt || '') > max) max = s.serverUpdatedAt;
    }
    await DB.setMeta('lastPull', max);
    await DB.setMeta('lastSync', new Date().toISOString());
  } catch (e) { err = e; }
  syncing = false;
  await updatePill(err);
  if (err && !quiet) toast('Gagal sync: ' + err.message, 3500);
  else if (sent && !quiet) toast(sent === 1 ? 'Report dihantar ke server' : sent + ' report dihantar');
  const page = (location.hash || '#/').split('/')[1] || '';
  if (!err && (sent || pulled) && (page === '' || page === 'view')) route();
  return { sent, pulled, err };
}

async function updatePill(err) {
  const p = $('#pill');
  const n = (await DB.all()).filter(r => r.status === 'pending').length;
  p.className = 'pill';
  if (syncing) { p.textContent = 'Sync…'; return; }
  if (!navigator.onLine) { p.textContent = n ? `Offline · ${n} menunggu` : 'Offline'; p.classList.add('off'); return; }
  if (!S.url) { p.textContent = n ? `${n} menunggu` : 'Tiada server'; p.classList.add('warn'); return; }
  if (err) { p.textContent = 'Gagal sync'; p.classList.add('off'); return; }
  if (n) { p.textContent = `${n} belum sync`; p.classList.add('warn'); return; }
  p.textContent = 'Tersimpan ✓'; p.classList.add('ok');
}

/* ---------------- Router ---------------- */
async function route() {
  await flushSave();
  cur = null;
  const parts = (location.hash || '#/').split('/');
  const page = parts[1] || '', id = decodeURIComponent(parts[2] || '');
  window.scrollTo(0, 0);
  $('#backBtn').hidden = page === '';
  $('#brand').hidden = page !== '';
  $('#setBtn').hidden = page === 'settings';
  try {
    if (page === 'new') return newReport();
    if (page === 'edit') return renderEdit(id);
    if (page === 'view') return renderView(id);
    if (page === 'settings') return renderSettings();
    return renderList();
  } finally { updatePill(); }
}
function setTitle(t) { $('#title').textContent = t; document.title = t + ' · JN Service Report'; }

/* ---------------- List ---------------- */
function sortReports(a, b) {
  const rank = r => (r.status === 'draft' ? 0 : r.reportNo ? 2 : 1);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (rank(a) === 2) {
    // ikut tarikh servis (terbaru dahulu), kemudian nombor report
    const d = (b.reportDate || '').localeCompare(a.reportDate || '');
    return d || (b.reportNo || '').localeCompare(a.reportNo || '');
  }
  return (b.updatedAt || '').localeCompare(a.updatedAt || '');
}

async function renderList() {
  setTitle('Service Report');
  const all = (await DB.all()).sort(sortReports);
  const q = ui.q.trim().toLowerCase();
  const me = (S.engineer || '').trim().toLowerCase();
  const list = all.filter(r => {
    if (ui.filter === 'draft' && r.status !== 'draft') return false;
    if (ui.filter === 'pending' && r.status !== 'pending') return false;
    if (ui.filter === 'mine' && (r.engineer || '').trim().toLowerCase() !== me) return false;
    if (!q) return true;
    return [r.reportNo, r.client, r.location, r.location2, r.equipment, r.model, r.serial, r.engineer, r.po]
      .some(v => String(v || '').toLowerCase().includes(q));
  });
  const counts = { draft: all.filter(r => r.status === 'draft').length, pending: all.filter(r => r.status === 'pending').length };
  const chip = (k, label) => `<button data-f="${k}" class="${ui.filter === k ? 'on' : ''}">${label}</button>`;
  $('#app').innerHTML = `
    ${!S.url ? `<div class="banner">Server belum ditetapkan. Report boleh diisi dan disimpan dalam phone, tetapi nombor report hanya dikeluarkan selepas disambung ke server. <a href="#/settings">Buka Tetapan</a></div>` : ''}
    <div class="search"><input id="q" type="search" placeholder="Cari no. report, client, equipment, serial…" value="${esc(ui.q)}"></div>
    <div class="chips">
      ${chip('all', `Semua (${all.length})`)}
      ${S.engineer ? chip('mine', 'Saya') : ''}
      ${chip('draft', `Draf (${counts.draft})`)}
      ${chip('pending', `Belum sync (${counts.pending})`)}
    </div>
    <div id="cards">
      ${list.length ? list.map(card).join('') : `<div class="empty">${all.length ? 'Tiada report sepadan.' : 'Belum ada report.<br>Tekan <b>Report Baharu</b> untuk mula.'}</div>`}
    </div>
    <button class="fab" onclick="location.hash='#/new'"><span style="font-size:20px;line-height:1">+</span> Report Baharu</button>`;
  $('#q').addEventListener('input', e => {
    ui.q = e.target.value;
    const pos = e.target.selectionStart;
    renderList().then(() => { const i = $('#q'); i.focus(); try { i.setSelectionRange(pos, pos); } catch (x) {} });
  });
  $$('.chips button').forEach(b => b.onclick = () => { ui.filter = b.dataset.f; renderList(); });
}

function card(r) {
  const [label, cls] = STATUS[r.status] || STATUS.draft;
  const no = r.reportNo ? `<span class="no">${esc(r.reportNo)}</span>` : `<span class="no draft">${r.status === 'draft' ? 'DRAF' : 'Menunggu no.'}</span>`;
  const eq = [r.equipment, r.serial ? 'S/N ' + r.serial : ''].filter(Boolean).join(' · ');
  const mt = [fmtDate(r.reportDate), r.engineer, (r.workTypes || []).join(', ')].filter(Boolean).join(' · ');
  return `<a class="card" href="#/view/${encodeURIComponent(r.id)}">
    <div class="r1">${no}<span class="badge ${cls}">${label}</span></div>
    <div class="cl">${esc(r.client || '(Tiada client)')}</div>
    ${eq ? `<div class="eq">${esc(eq)}</div>` : ''}
    <div class="mt">${esc(mt)}</div></a>`;
}

/* ---------------- Create / Edit ---------------- */
function blankReport(extra = {}) {
  const now = new Date().toISOString();
  return {
    id: uuid(), reportNo: '', reportDate: today(), workTypes: [], client: '', location: '', location2: '',
    contact: '', po: '', equipment: '', model: '', serial: '', warranty: '', fault: '', action: '',
    parts: [], engineer: S.engineer || '', attDate: today(), customerName: '', customerSign: '', engineerSign: '',
    createdBy: S.engineer || '', createdAt: now, updatedAt: now, serverUpdatedAt: '', status: 'draft', ...extra
  };
}
async function newReport(extra) {
  const r = blankReport(extra); await DB.put(r);
  location.replace('#/edit/' + encodeURIComponent(r.id));
}

function queueSave() {
  if (!cur) return;
  cur.updatedAt = new Date().toISOString();
  if (cur.status === 'synced') cur.status = 'pending';
  clearTimeout(saveT);
  saveT = setTimeout(() => { saveT = null; DB.put(cur).then(() => updatePill()); }, 400);
}
async function flushSave() {
  if (saveT) { clearTimeout(saveT); saveT = null; if (cur) await DB.put(cur); }
}

async function datalists() {
  const all = await DB.all();
  const keys = { client: ['client'], location: ['location', 'location2'], contact: ['contact'], equipment: ['equipment'], model: ['model'], engineer: ['engineer'] };
  return Object.entries(keys).map(([name, fields]) => {
    const set = new Set();
    all.forEach(r => fields.forEach(f => { const v = String(r[f] || '').trim(); if (v) set.add(v); }));
    return `<datalist id="dl-${name}">${[...set].sort().slice(0, 300).map(v => `<option value="${esc(v)}">`).join('')}</datalist>`;
  }).join('');
}

const inp = (k, label, o = {}) => `<label class="f"><span>${label}</span><input data-k="${k}" type="${o.type || 'text'}" ${o.list ? `list="dl-${o.list}"` : ''} ${o.mode ? `inputmode="${o.mode}"` : ''} value="${esc(cur[k] || '')}" placeholder="${esc(o.ph || '')}" autocomplete="off" autocapitalize="characters"></label>`;
const ta = (k, label, rows, ph = '') => `<label class="f"><span>${label}</span><textarea data-k="${k}" rows="${rows}" placeholder="${esc(ph)}" autocapitalize="characters">${esc(cur[k] || '')}</textarea></label>`;

async function renderEdit(id) {
  const r = await DB.get(id);
  if (!r) { location.replace('#/'); return; }
  cur = r;
  if (!Array.isArray(cur.parts)) cur.parts = [];
  if (!cur.parts.length) cur.parts = [{ d: '', q: '' }];
  setTitle(r.reportNo ? 'Edit ' + r.reportNo : 'Report Baharu');
  const isDraft = r.status === 'draft';
  $('#app').innerHTML = `
    ${await datalists()}
    <div class="noBox">
      <div><small>Report No.</small><span class="no ${r.reportNo ? '' : 'draft'}">${esc(r.reportNo || 'Belum ada')}</span></div>
      <small style="text-align:right;max-width:55%">${r.reportNo ? 'Nombor tetap untuk report ini' : 'Nombor dikeluarkan oleh server selepas report dihantar'}</small>
    </div>
    <div class="sec">
      <h2>JENIS KERJA &amp; TARIKH</h2>
      <div class="wt" style="margin-bottom:12px">
        ${WORK_TYPES.map(t => `<label><input type="checkbox" data-wt="${esc(t)}" ${(r.workTypes || []).includes(t) ? 'checked' : ''}><span>${esc(t)}</span></label>`).join('')}
      </div>
      ${inp('reportDate', 'Tarikh servis', { type: 'date' })}
    </div>
    <div class="sec">
      <h2>CUSTOMER / SITE</h2>
      ${inp('client', 'Client', { list: 'client' })}
      ${inp('location', 'Location', { list: 'location' })}
      ${inp('location2', 'Location (baris 2)', { list: 'location', ph: 'Jabatan / alamat tambahan' })}
      <div class="grid2">${inp('contact', 'Contact', { list: 'contact' })}${inp('po', 'PO no.')}</div>
    </div>
    <div class="sec">
      <h2>EQUIPMENT</h2>
      ${inp('equipment', 'Equipment', { list: 'equipment' })}
      ${inp('model', 'Brand / Model', { list: 'model' })}
      <div class="grid2">${inp('serial', 'Serial no.')}${inp('warranty', 'Warranty', { ph: 'Active to …' })}</div>
    </div>
    <div class="sec">
      <h2>FAULT REPORTED</h2>
      ${ta('fault', 'Masalah yang dilaporkan', 3)}
    </div>
    <div class="sec">
      <h2>ACTION TAKEN / RESOLUTION</h2>
      ${ta('action', 'Tindakan yang diambil', 7, '- …')}
    </div>
    <div class="sec">
      <h2>PARTS USED</h2>
      <div id="parts"></div>
      <button class="add" id="addPart" type="button">+ Tambah alat ganti</button>
    </div>
    <div class="sec">
      <h2>ATTENDED BY</h2>
      <div class="grid2">${inp('engineer', 'Engineer', { list: 'engineer' })}${inp('attDate', 'Tarikh', { type: 'date' })}</div>
    </div>
    <div class="sec">
      <h2>TANDATANGAN</h2>
      <label class="f"><span>Customer acknowledgement</span></label>
      ${sigField('customerSign')}
      ${inp('customerName', 'Nama pelanggan', { list: 'contact' })}
      <label class="f" style="margin-top:14px"><span>Engineer signature</span></label>
      ${sigField('engineerSign')}
    </div>
    ${isDraft ? `<button class="btn d" id="delBtn" style="width:100%;margin-bottom:12px">Padam draf ini</button>` : ''}
    <div class="bar"><div>
      ${isDraft ? `<button class="btn" id="draftBtn">Simpan Draf</button><button class="btn p" id="sendBtn">Hantar &amp; Dapat No.</button>`
                : `<button class="btn p" id="sendBtn">Simpan &amp; Kemas Kini</button>`}
    </div></div>`;

  renderParts();
  $('#addPart').onclick = () => { cur.parts.push({ d: '', q: '' }); renderParts(); queueSave(); const t = $$('#parts textarea').pop(); t && t.focus(); };
  $$('.sig').forEach(el => el.onclick = () => openSig(el.dataset.sig));
  $$('[data-draw]').forEach(b => b.onclick = () => openSig(b.dataset.draw));
  $$('[data-sclr]').forEach(b => b.onclick = () => {
    if (!confirm('Buang tandatangan ini?')) return;
    cur[b.dataset.sclr] = ''; queueSave(); setSigBox(b.dataset.sclr);
  });
  $$('input[data-simg]').forEach(i => i.addEventListener('change', () => {
    const f = i.files && i.files[0]; i.value = '';
    if (f) openImgSig(i.dataset.simg, f);
  }));
  $$('#app input[type=text], #app textarea').forEach(el => el.addEventListener('blur', () => {
    const v = el.value.trim(); if (v !== el.value) { el.value = v; onFormInput({ target: el }); }
  }));
  if ($('#draftBtn')) $('#draftBtn').onclick = async () => { await flushSave(); toast('Draf disimpan dalam phone'); location.hash = '#/view/' + encodeURIComponent(cur.id); };
  $('#sendBtn').onclick = submitCurrent;
  if ($('#delBtn')) $('#delBtn').onclick = async () => {
    if (!confirm('Padam draf ini? Tindakan ini tidak boleh dibatalkan.')) return;
    clearTimeout(saveT); saveT = null; await DB.del(cur.id); cur = null; toast('Draf dipadam'); location.replace('#/');
  };
}

function onFormInput(e) {
  const el = e.target; if (!cur || !el) return;
  if (el.dataset.k) cur[el.dataset.k] = el.value;
  else if (el.dataset.wt !== undefined) cur.workTypes = $$('[data-wt]').filter(c => c.checked).map(c => c.dataset.wt);
  else if (el.dataset.pd !== undefined) cur.parts[+el.dataset.pd].d = el.value;
  else if (el.dataset.pq !== undefined) cur.parts[+el.dataset.pq].q = el.value;
  else return;
  if (el.tagName === 'TEXTAREA' && el.dataset.pd !== undefined) autoGrow(el);
  queueSave();
}
function autoGrow(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 2 + 'px'; }

function renderParts() {
  const box = $('#parts');
  box.innerHTML = cur.parts.map((p, i) => `
    <div class="part">
      <span class="pn">${i + 1}</span>
      <textarea rows="1" data-pd="${i}" placeholder="Description / Part no." autocapitalize="characters">${esc(p.d)}</textarea>
      <input data-pq="${i}" type="number" min="0" inputmode="numeric" placeholder="Qty" value="${esc(p.q)}">
      <button type="button" data-prm="${i}" aria-label="Buang">×</button>
    </div>`).join('');
  $$('textarea', box).forEach(autoGrow);
  $$('[data-prm]', box).forEach(b => b.onclick = () => {
    cur.parts.splice(+b.dataset.prm, 1); if (!cur.parts.length) cur.parts.push({ d: '', q: '' });
    renderParts(); queueSave();
  });
}

function validate(r) {
  const miss = [];
  if (!(r.workTypes || []).length) miss.push('Jenis kerja');
  if (!r.reportDate) miss.push('Tarikh servis');
  if (!String(r.client).trim()) miss.push('Client');
  if (!String(r.equipment).trim()) miss.push('Equipment');
  if (!String(r.engineer).trim()) miss.push('Engineer');
  return miss;
}

async function submitCurrent() {
  const miss = validate(cur);
  if (miss.length) { toast('Sila isi: ' + miss.join(', '), 3500); return; }
  cur.parts = cur.parts.filter(p => String(p.d).trim() || String(p.q).trim());
  cur.status = 'pending'; cur.updatedAt = new Date().toISOString();
  if (!cur.createdBy) cur.createdBy = S.engineer || cur.engineer;
  clearTimeout(saveT); saveT = null;
  await DB.put(cur);
  const id = cur.id;
  const btn = $('#sendBtn'); if (btn) { btn.disabled = true; btn.textContent = 'Menghantar…'; }
  if (!S.url) toast('Disimpan. Akan dihantar bila server ditetapkan.', 3500);
  else if (!navigator.onLine) toast('Offline. Report akan dihantar bila ada internet.', 3500);
  else await sync({ quiet: false });
  location.hash = '#/view/' + encodeURIComponent(id);
}

/* ---------------- View ---------------- */
async function renderView(id) {
  const r = await DB.get(id);
  if (!r) { location.replace('#/'); return; }
  cur = null;
  setTitle(r.reportNo || (r.status === 'draft' ? 'Draf' : 'Menunggu nombor'));
  const [label, cls] = STATUS[r.status] || STATUS.draft;
  const row = (k, v) => `<dt>${k}</dt><dd>${esc(v || '-')}</dd>`;
  const parts = (r.parts || []).filter(p => p.d || p.q);
  const canShare = isNative() || !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] }));
  $('#app').innerHTML = `
    <div class="noBox">
      <div><small>Report No.</small><span class="no ${r.reportNo ? '' : 'draft'}">${esc(r.reportNo || (r.status === 'draft' ? 'DRAF' : 'Menunggu'))}</span></div>
      <span class="badge ${cls}">${label}</span>
    </div>
    <div class="acts">
      ${canShare ? `<button class="btn p" id="shareBtn">Kongsi PDF</button>` : ''}
      ${isNative() ? '' : `<button class="btn ${canShare ? '' : 'p'}" id="dlBtn">Muat turun PDF</button>`}
      <button class="btn" id="editBtn">${r.status === 'draft' ? 'Sambung isi' : 'Edit'}</button>
      <button class="btn" id="dupBtn">Salin ke report baharu</button>
      ${r.status === 'pending' ? `<button class="btn" id="syncBtn" style="grid-column:1/-1">Hantar ke server sekarang</button>` : ''}
    </div>
    ${r.status === 'draft' ? `<div class="banner">Draf ini belum dihantar. Tekan <b>Sambung isi</b> kemudian <b>Hantar &amp; Dapat No.</b> untuk mendapat nombor report.</div>` : ''}
    <div class="sec"><h2>JENIS KERJA</h2><div>${esc((r.workTypes || []).join(', ') || '-')} · Tarikh servis ${esc(fmtDate(r.reportDate))}</div></div>
    <div class="sec"><h2>CUSTOMER / SITE</h2><dl class="kv">
      ${row('Client', r.client)}${row('Location', [r.location, r.location2].filter(Boolean).join('\n'))}${row('Contact', r.contact)}${row('PO no.', r.po)}
    </dl></div>
    <div class="sec"><h2>EQUIPMENT</h2><dl class="kv">
      ${row('Equipment', r.equipment)}${row('Brand / Model', r.model)}${row('Serial no.', r.serial)}${row('Warranty', r.warranty)}
    </dl></div>
    <div class="sec"><h2>FAULT REPORTED</h2><div class="txt">${esc(r.fault || '-')}</div></div>
    <div class="sec"><h2>ACTION TAKEN / RESOLUTION</h2><div class="txt">${esc(r.action || '-')}</div></div>
    <div class="sec"><h2>PARTS USED</h2>${parts.length ? `<dl class="kv">${parts.map((p, i) => `<dt>${i + 1}. Qty ${esc(p.q || '-')}</dt><dd>${esc(p.d)}</dd>`).join('')}</dl>` : '<div class="txt">-</div>'}</div>
    <div class="sec"><h2>ATTENDED BY</h2><dl class="kv">${row('Engineer', r.engineer)}${row('Tarikh', fmtDate(r.attDate))}</dl></div>
    <div class="sec"><h2>TANDATANGAN</h2><div class="sigv">
      <div>${r.customerSign ? `<img src="${r.customerSign}" alt="">` : '<div style="height:70px"></div>'}<b>${esc(r.customerName || '-')}</b>Customer acknowledgement</div>
      <div>${r.engineerSign ? `<img src="${r.engineerSign}" alt="">` : '<div style="height:70px"></div>'}<b>${esc(r.engineer || '-')}</b>Engineer signature</div>
    </div></div>
    <div class="meta">Dikemas kini ${esc(r.updatedAt ? fmtDT(new Date(r.updatedAt)) : '-')}${r.createdBy ? ' · Dibuat oleh ' + esc(r.createdBy) : ''}</div>`;
  if ($('#shareBtn')) $('#shareBtn').onclick = () => exportPDF(r, true);
  if ($('#dlBtn')) $('#dlBtn').onclick = () => exportPDF(r, false);
  $('#editBtn').onclick = () => { location.hash = '#/edit/' + encodeURIComponent(r.id); };
  $('#dupBtn').onclick = () => newReport({
    client: r.client, location: r.location, location2: r.location2, contact: r.contact, po: r.po,
    equipment: r.equipment, model: r.model, serial: r.serial, warranty: r.warranty
  });
  if ($('#syncBtn')) $('#syncBtn').onclick = () => sync();
}

/* ---------------- Signature pad ---------------- */
const sig = { key: null, ctx: null, drawing: false, dirty: false, last: null };
function openSig(key) {
  sig.key = key; sig.dirty = false;
  $('#sigTitle').textContent = key === 'customerSign' ? 'Tandatangan pelanggan' : 'Tandatangan engineer';
  $('#sigModal').classList.add('on');
  const c = $('#sigCanvas'), dpr = window.devicePixelRatio || 1;
  c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
  sig.ctx = c.getContext('2d');
  sig.ctx.fillStyle = '#fff'; sig.ctx.fillRect(0, 0, c.width, c.height);
  sig.ctx.lineWidth = 2.6 * dpr; sig.ctx.lineCap = 'round'; sig.ctx.lineJoin = 'round'; sig.ctx.strokeStyle = '#0f172a';
}
function sigPos(e) { const c = $('#sigCanvas'), b = c.getBoundingClientRect(); return [(e.clientX - b.left) * c.width / b.width, (e.clientY - b.top) * c.height / b.height]; }
function initSig() {
  const c = $('#sigCanvas');
  c.addEventListener('pointerdown', e => { e.preventDefault(); c.setPointerCapture(e.pointerId); sig.drawing = true; sig.last = sigPos(e); sig.ctx.beginPath(); sig.ctx.arc(sig.last[0], sig.last[1], sig.ctx.lineWidth / 2, 0, 7); sig.ctx.fillStyle = '#0f172a'; sig.ctx.fill(); sig.dirty = true; });
  c.addEventListener('pointermove', e => {
    if (!sig.drawing) return; e.preventDefault();
    const p = sigPos(e); sig.ctx.beginPath(); sig.ctx.moveTo(sig.last[0], sig.last[1]); sig.ctx.lineTo(p[0], p[1]); sig.ctx.stroke(); sig.last = p;
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => c.addEventListener(t, () => { sig.drawing = false; }));
  $('#sigClear').onclick = () => { sig.ctx.fillStyle = '#fff'; sig.ctx.fillRect(0, 0, c.width, c.height); sig.dirty = false; };
  $('#sigCancel').onclick = () => $('#sigModal').classList.remove('on');
  $('#sigSave').onclick = () => {
    let data = '';
    if (sig.dirty) {
      const out = document.createElement('canvas'); const w = 600, h = Math.round(600 * c.height / c.width);
      out.width = w; out.height = h; const x = out.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(c, 0, 0, w, h);
      data = encodeUnder(out);
    }
    if (cur) { cur[sig.key] = data; queueSave(); setSigBox(sig.key); }
    $('#sigModal').classList.remove('on');
  };
}

/* ---------------- Tandatangan dari gambar (kamera / galeri) ---------------- */
const SIG_PH = {
  customerSign: 'Ketik untuk lukis tandatangan pelanggan',
  engineerSign: 'Ketik untuk lukis tandatangan engineer'
};
function sigField(k) {
  const v = cur[k];
  return `<div class="sig" data-sig="${k}">${v ? `<img src="${v}" alt="">` : SIG_PH[k]}</div>
    <div class="sigbtns">
      <button type="button" class="sbtn" data-draw="${k}">${ICON.pen}Lukis</button>
      <label class="sbtn">${ICON.cam}Kamera<input type="file" accept="image/*" capture="environment" data-simg="${k}" hidden></label>
      <label class="sbtn">${ICON.img}Galeri<input type="file" accept="image/*" data-simg="${k}" hidden></label>
      <button type="button" class="sbtn d" data-sclr="${k}" ${v ? '' : 'hidden'}>Buang</button>
    </div>`;
}
const ICON = {
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  img: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>'
};
function setSigBox(k) {
  const box = $(`.sig[data-sig="${k}"]`); if (!box || !cur) return;
  box.innerHTML = cur[k] ? `<img src="${cur[k]}" alt="">` : SIG_PH[k];
  const b = $(`[data-sclr="${k}"]`); if (b) b.hidden = !cur[k];
}

// Encode JPEG di bawah had saiz sel Google Sheets (~50,000 aksara)
function encodeUnder(c, max = 45000) {
  let cv = c;
  for (let s = 0; s < 6; s++) {
    for (const q of [0.82, 0.68, 0.55, 0.42]) { const u = cv.toDataURL('image/jpeg', q); if (u.length <= max) return u; }
    const n = document.createElement('canvas'); n.width = Math.max(1, Math.round(cv.width * 0.75)); n.height = Math.max(1, Math.round(cv.height * 0.75));
    const x = n.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, n.width, n.height); x.drawImage(cv, 0, 0, n.width, n.height); cv = n;
  }
  return cv.toDataURL('image/jpeg', 0.4);
}

function fitCanvas(src, maxW, maxH) {
  const k = Math.min(1, maxW / src.width, maxH / src.height);
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(src.width * k)); c.height = Math.max(1, Math.round(src.height * k));
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

async function fileToCanvas(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();   // orientasi EXIF diikut oleh browser
    return fitCanvas(img, 1400, 1400);
  } finally { URL.revokeObjectURL(url); }
}

function rotateCanvas(src, quarter) {
  const q = ((quarter % 4) + 4) % 4; if (!q) return src;
  const c = document.createElement('canvas');
  c.width = q % 2 ? src.height : src.width; c.height = q % 2 ? src.width : src.height;
  const x = c.getContext('2d'); x.translate(c.width / 2, c.height / 2); x.rotate(q * Math.PI / 2); x.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

/* Jadikan latar kertas putih (tahan bayang), dakwat gelap, dan potong mengikut tandatangan. */
function cleanSignature(src) {
  const w = src.width, h = src.height;
  const d = src.getContext('2d').getImageData(0, 0, w, h).data;
  // Anggaran latar setempat: kecilkan, ambil nilai paling cerah di kejiranan, besarkan semula
  const bw = Math.max(2, Math.round(w / 24)), bh = Math.max(2, Math.round(h / 24));
  const sm = document.createElement('canvas'); sm.width = bw; sm.height = bh;
  const sx = sm.getContext('2d'); sx.imageSmoothingQuality = 'high'; sx.drawImage(src, 0, 0, bw, bh);
  const sd = sx.getImageData(0, 0, bw, bh); const L = new Float32Array(bw * bh);
  for (let i = 0; i < bw * bh; i++) L[i] = 0.299 * sd.data[i * 4] + 0.587 * sd.data[i * 4 + 1] + 0.114 * sd.data[i * 4 + 2];
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    let m = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < bh && xx >= 0 && xx < bw && L[yy * bw + xx] > m) m = L[yy * bw + xx];
    }
    const o = (y * bw + x) * 4; sd.data[o] = sd.data[o + 1] = sd.data[o + 2] = m; sd.data[o + 3] = 255;
  }
  sx.putImageData(sd, 0, 0);
  const bg = document.createElement('canvas'); bg.width = w; bg.height = h;
  const bx = bg.getContext('2d'); bx.imageSmoothingQuality = 'high'; bx.drawImage(sm, 0, 0, w, h);
  const B = bx.getImageData(0, 0, w, h).data;

  const out = new ImageData(w, h), od = out.data;
  const colN = new Uint32Array(w), rowN = new Uint32Array(h);
  const mx = Math.round(w * 0.03), my = Math.round(h * 0.03);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const r = lum / Math.max(B[i], 40);
    let t = r >= 0.86 ? 1 : r <= 0.45 ? 0 : (r - 0.45) / 0.41;
    t = t * t;                                   // dakwat lebih pekat
    const v = Math.round(255 * t);
    od[i] = od[i + 1] = od[i + 2] = v; od[i + 3] = 255;
  }
  // Buang kawasan gelap yang bersambung dengan tepi gambar (meja, tepi kertas, bayang tepi)
  const seen = new Uint8Array(w * h), q = new Int32Array(w * h); let qh = 0, qt = 0;
  const push = p => { if (!seen[p] && od[p * 4] < 200) { seen[p] = 1; q[qt++] = p; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (qh < qt) {
    const p = q[qh++], x = p % w;
    od[p * 4] = od[p * 4 + 1] = od[p * 4 + 2] = 255;
    if (x > 0) push(p - 1); if (x < w - 1) push(p + 1);
    if (p >= w) push(p - w); if (p < w * (h - 1)) push(p + w);
  }
  for (let y = my; y < h - my; y++) for (let x = mx; x < w - mx; x++) {
    if (od[(y * w + x) * 4] < 140) { colN[x]++; rowN[y]++; }
  }
  // Kotak sempadan tandatangan (abaikan bintik kecil)
  const cMin = Math.max(2, h * 0.004), rMin = Math.max(2, w * 0.004);
  let x0 = 0, x1 = w - 1, y0 = 0, y1 = h - 1, found = false;
  for (let x = 0; x < w; x++) if (colN[x] >= cMin) { x0 = x; found = true; break; }
  for (let x = w - 1; x >= 0; x--) if (colN[x] >= cMin) { x1 = x; break; }
  for (let y = 0; y < h; y++) if (rowN[y] >= rMin) { y0 = y; break; }
  for (let y = h - 1; y >= 0; y--) if (rowN[y] >= rMin) { y1 = y; break; }
  const full = document.createElement('canvas'); full.width = w; full.height = h; full.getContext('2d').putImageData(out, 0, 0);
  if (!found || x1 <= x0 || y1 <= y0) return full;
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.06) + 8;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const c = document.createElement('canvas'); c.width = x1 - x0 + 1; c.height = y1 - y0 + 1;
  c.getContext('2d').drawImage(full, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
  return c;
}

const imgSig = { key: null, src: null, rot: 0, out: null };
async function openImgSig(key, file) {
  try {
    toast('Memproses gambar…', 1500);
    imgSig.key = key; imgSig.rot = 0; imgSig.src = await fileToCanvas(file);
    $('#imgTitle').textContent = key === 'customerSign' ? 'Gambar tandatangan pelanggan' : 'Gambar tandatangan engineer';
    $('#imgClean').checked = true;
    $('#imgModal').classList.add('on');
    renderImgSig();
  } catch (e) { toast('Gambar tidak dapat dibuka: ' + e.message, 3500); }
}
function renderImgSig() {
  const src = rotateCanvas(imgSig.src, imgSig.rot);
  const res = $('#imgClean').checked ? cleanSignature(src) : src;
  imgSig.out = fitCanvas(res, 900, 380);
  $('#imgPrev').src = imgSig.out.toDataURL('image/jpeg', 0.85);
}
function initImgSig() {
  $('#imgRotate').onclick = () => { imgSig.rot++; renderImgSig(); };
  $('#imgClean').onchange = renderImgSig;
  $('#imgCancel').onclick = () => { $('#imgModal').classList.remove('on'); imgSig.src = imgSig.out = null; };
  $('#imgSave').onclick = () => {
    if (cur && imgSig.out) { cur[imgSig.key] = encodeUnder(imgSig.out); queueSave(); setSigBox(imgSig.key); }
    $('#imgModal').classList.remove('on'); imgSig.src = imgSig.out = null;
  };
}

/* ---------------- PDF ---------------- */
function clean(s) {
  return String(s ?? '').replace(/\r/g, '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/[•·]/g, '-').replace(/…/g, '...')
    .replace(/[^\x09\x0A\x20-\x7E\xA0-\xFF]/g, '?');
}

function makePDF(r) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const L = 14, R = 196, W = R - L, BOTTOM = 282;
  const BLUE = [29, 78, 216], INK = [15, 23, 42], MUT = [100, 116, 139], LINE = [203, 213, 225];
  let y = 12;
  const font = (style, size, color) => { doc.setFont('helvetica', style); doc.setFontSize(size); doc.setTextColor(...color); };
  const newPage = () => { doc.addPage(); y = 16; };
  const ensure = h => { if (y + h > BOTTOM) newPage(); };

  // Kepala surat
  if (LOGO) doc.addImage(LOGO, 'JPEG', L, y, 40, 40 * 202 / 598);
  font('bold', 13, INK); doc.text(COMPANY.name, 60, y + 5);
  font('normal', 8, MUT); doc.text(doc.splitTextToSize(clean(COMPANY.addr), R - 60), 60, y + 10);
  y = 29; doc.setDrawColor(...BLUE); doc.setLineWidth(0.8); doc.line(L, y, R, y);

  // Tajuk + nombor
  y += 11;
  font('bold', 20, INK); doc.text('Service Report', L, y);
  font('normal', 8, MUT); doc.text('Report No.', R, y - 6, { align: 'right' });
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...INK); doc.text(r.reportNo || 'DRAF', R, y, { align: 'right' });
  font('normal', 8, MUT); doc.text('Tarikh servis', R, y + 5, { align: 'right' });
  font('bold', 10, INK); doc.text(fmtDate(r.reportDate) || '-', R, y + 10, { align: 'right' });

  // Jenis kerja
  let x = L; const wy = y + 9;
  WORK_TYPES.forEach(t => {
    doc.setDrawColor(...INK); doc.setLineWidth(0.3); doc.rect(x, wy - 3.3, 3.8, 3.8);
    if ((r.workTypes || []).includes(t)) {
      doc.setLineWidth(0.7); doc.line(x + 0.8, wy - 1.5, x + 1.6, wy - 0.3); doc.line(x + 1.6, wy - 0.3, x + 3.1, wy - 2.7);
    }
    font('bold', 10, INK); doc.text(t, x + 5.5, wy); x += 5.5 + doc.getTextWidth(t) + 7;
  });
  y = wy + 9;

  const section = (title, x0, x1, yy) => {
    font('bold', 8.5, BLUE); doc.text(title, x0, yy);
    doc.setDrawColor(...LINE); doc.setLineWidth(0.3); doc.line(x0, yy + 1.8, x1, yy + 1.8);
    return yy + 7;
  };
  const kv = (label, val, x0, x1, yy) => {
    const lw = 27;
    font('normal', 9, MUT); doc.text(label, x0, yy);
    font('normal', 9.5, INK);
    const lines = doc.splitTextToSize(clean(val) || '-', x1 - x0 - lw);
    doc.text(lines, x0 + lw, yy);
    return yy + lines.length * 4.3 + 2.2;
  };

  // Customer / Equipment (dua lajur)
  ensure(45);
  let yl = section('CUSTOMER / SITE', L, 100, y), yr = section('EQUIPMENT', 110, R, y);
  const loc = [r.location, r.location2].filter(v => String(v || '').trim()).join('\n');
  [['Client', r.client], ['Location', loc], ['Contact', r.contact], ['PO no.', r.po]].forEach(([a, b]) => { yl = kv(a, b, L, 100, yl); });
  [['Equipment', r.equipment], ['Brand / Model', r.model], ['Serial no.', r.serial], ['Warranty', r.warranty]].forEach(([a, b]) => { yr = kv(a, b, 110, R, yr); });
  y = Math.max(yl, yr) + 3;

  // Kotak teks panjang (boleh sambung ke muka surat seterusnya)
  const boxText = (title, text, minH) => {
    ensure(22); y = section(title, L, R, y);
    font('normal', 9.5, INK);
    const lines = doc.splitTextToSize(clean(text) || ' ', W - 8), lh = 4.6;
    let i = 0;
    while (i < lines.length) {
      if (BOTTOM - y < 16) newPage();
      const fit = Math.max(1, Math.floor((BOTTOM - y - 6) / lh));
      const chunk = lines.slice(i, i + fit); i += chunk.length;
      let h = chunk.length * lh + 6;
      if (i >= lines.length && i === chunk.length) h = Math.max(h, minH);
      h = Math.min(h, BOTTOM - y);
      doc.setDrawColor(...LINE); doc.setLineWidth(0.3); doc.roundedRect(L, y, W, h, 2, 2);
      font('normal', 9.5, INK); doc.text(chunk, L + 4, y + 5.5);
      y += h + 4;
      if (i < lines.length) newPage();
    }
  };
  boxText('FAULT REPORTED', r.fault, 16);
  boxText('ACTION TAKEN / RESOLUTION', r.action, 28);

  // Parts used
  const partsHead = () => {
    font('bold', 8, MUT); doc.text('#', L + 2, y); doc.text('Description / Part no.', L + 12, y); doc.text('Qty', R - 2, y, { align: 'right' });
    doc.setDrawColor(...LINE); doc.line(L, y + 1.8, R, y + 1.8); y += 6.5;
  };
  ensure(22); y = section('PARTS USED', L, R, y); partsHead();
  const parts = (r.parts || []).filter(p => String(p.d || '').trim() || String(p.q || '').trim());
  (parts.length ? parts : [{ d: '-', q: '' }]).forEach((p, i) => {
    font('normal', 9.5, INK);
    const lines = doc.splitTextToSize(clean(p.d) || '-', W - 40), h = lines.length * 4.3 + 2.5;
    if (y + h > BOTTOM) { newPage(); partsHead(); }
    font('normal', 9.5, MUT); doc.text(parts.length ? String(i + 1) : '', L + 2, y);
    font('normal', 9.5, INK); doc.text(lines, L + 12, y); doc.text(clean(p.q), R - 2, y, { align: 'right' });
    doc.setDrawColor(...LINE); doc.line(L, y + h - 2.6, R, y + h - 2.6);
    y += h + 1;
  });
  y += 3;

  // Attended by
  ensure(18); y = section('ATTENDED BY', L, R, y);
  const ya = kv('Engineer', r.engineer, L, 100, y), yb = kv('Date', fmtDate(r.attDate), 110, R, y);
  y = Math.max(ya, yb) + 1;

  // Tandatangan: pelanggan kiri, engineer kanan
  ensure(33);
  const sigBlock = (img, name, label, x0, x1) => {
    const top = y, boxH = 19;
    if (img) {
      try {
        const pr = doc.getImageProperties(img); const maxW = x1 - x0, k = Math.min(maxW / pr.width, boxH / pr.height);
        doc.addImage(img, 'JPEG', x0, top + boxH - pr.height * k, pr.width * k, pr.height * k);
      } catch (e) { /* abaikan imej rosak */ }
    }
    doc.setDrawColor(...INK); doc.setLineWidth(0.5); doc.line(x0, top + boxH + 1, x1, top + boxH + 1);
    font('bold', 9.5, INK); doc.text(doc.splitTextToSize(clean(name) || ' ', x1 - x0)[0], x0, top + boxH + 6);
    font('normal', 8.5, MUT); doc.text(label, x0, top + boxH + 10.5);
  };
  sigBlock(r.customerSign, r.customerName, 'Customer acknowledgement & date', L, 96);
  sigBlock(r.engineerSign, r.engineer, 'Engineer signature & date', 114, R);
  y += 32;

  // Footer setiap muka surat
  const n = doc.getNumberOfPages(), gen = 'Generated ' + fmtDT(new Date());
  for (let p = 1; p <= n; p++) {
    doc.setPage(p);
    doc.setDrawColor(...LINE); doc.setLineWidth(0.3); doc.line(L, 285, R, 285);
    font('normal', 7.5, MUT);
    doc.text(COMPANY.name + ' - Medical Device Service Report' + (r.reportNo ? ' - ' + r.reportNo : ''), L, 289);
    doc.text(gen + (n > 1 ? `  -  ${p}/${n}` : ''), R, 289, { align: 'right' });
  }
  return doc;
}

async function deliverFile(name, blob, preferShare) {
  if (isNative()) {
    const { Filesystem, Share } = window.Capacitor.Plugins;
    const data = (await blobToDataURL(blob)).split(',')[1];
    const w = await Filesystem.writeFile({ path: name, data, directory: 'CACHE' });
    await Share.share({ title: name, url: w.uri, dialogTitle: 'Kongsi ' + name });
    return;
  }
  const file = new File([blob], name, { type: blob.type });
  if (preferShare && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
}

async function exportPDF(r, share) {
  try {
    const doc = makePDF(r);
    const name = (r.reportNo || 'DRAF-' + r.id.slice(0, 6)) + '.pdf';
    await deliverFile(name, doc.output('blob'), share);
  } catch (e) { console.error(e); toast('Gagal jana PDF: ' + e.message, 3500); }
}

/* ---------------- Settings ---------------- */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });

async function renderSettings() {
  cur = null;
  setTitle('Tetapan');
  const lastSync = await DB.getMeta('lastSync');
  const all = await DB.all();
  $('#app').innerHTML = `
    <div class="sec">
      <h2>ENGINEER</h2>
      <label class="f"><span>Nama engineer (diisi automatik dalam report baharu)</span><input id="sEng" value="${esc(S.engineer)}" autocapitalize="characters"></label>
    </div>
    <div class="sec">
      <h2>SERVER (GOOGLE SHEETS)</h2>
      <label class="f"><span>URL web app</span><input id="sUrl" value="${esc(S.url)}" placeholder="https://script.google.com/macros/s/…/exec" inputmode="url" autocapitalize="off"></label>
      <label class="f"><span>Token</span><input id="sTok" value="${esc(S.token)}" type="password" autocapitalize="off" autocomplete="off"></label>
      <div class="hint">URL dan token yang sama digunakan oleh semua engineer, supaya nombor report dikongsi.</div>
    </div>
    <div class="acts">
      <button class="btn p" id="sSave" style="grid-column:1/-1">Simpan tetapan</button>
      <button class="btn" id="sTest">Uji sambungan</button>
      <button class="btn" id="sFull">Muat semula semua rekod</button>
      <button class="btn" id="sCsv">Eksport CSV</button>
      ${installEvt ? `<button class="btn" id="sInstall">Pasang app</button>` : ''}
    </div>
    <div class="meta">
      ${all.length} report dalam phone · Sync terakhir: ${lastSync ? esc(fmtDT(new Date(lastSync))) : 'belum'}<br>
      Versi ${APP_VERSION}${isNative() ? ' (Android)' : ''}
    </div>`;
  const read = () => ({ engineer: $('#sEng').value.trim(), url: $('#sUrl').value.trim(), token: $('#sTok').value.trim() });
  $('#sSave').onclick = async () => {
    const n = read();
    if (n.url && !/^https:\/\//.test(n.url)) { toast('URL mesti bermula dengan https://'); return; }
    S = n; await DB.setMeta('settings', S); toast('Tetapan disimpan'); sync({ quiet: true });
  };
  $('#sTest').onclick = async () => {
    const old = S; S = { ...S, ...read() };
    try { await api('ping'); toast('Sambungan berjaya ✓'); } catch (e) { toast('Gagal: ' + e.message, 3500); }
    S = old;
  };
  $('#sFull').onclick = async () => {
    await DB.setMeta('lastPull', ''); const res = await sync();
    if (res && !res.err) toast('Rekod dikemas kini (' + res.pulled + ' dari server)');
  };
  $('#sCsv').onclick = exportCSV;
  if ($('#sInstall')) $('#sInstall').onclick = async () => { installEvt.prompt(); await installEvt.userChoice; installEvt = null; renderSettings(); };
}

async function exportCSV() {
  const cols = ['reportNo', 'reportDate', 'workTypes', 'client', 'location', 'location2', 'contact', 'po', 'equipment', 'model', 'serial', 'warranty', 'fault', 'action', 'parts', 'engineer', 'attDate', 'customerName', 'status'];
  const all = (await DB.all()).sort(sortReports);
  const cell = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = [cols.join(',')].concat(all.map(r => cols.map(c => {
    if (c === 'workTypes') return cell((r.workTypes || []).join('; '));
    if (c === 'parts') return cell((r.parts || []).filter(p => p.d).map(p => `${p.d} x${p.q || 1}`).join('; '));
    return cell(r[c]);
  }).join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' });
  await deliverFile('service-reports-' + today() + '.csv', blob, false);
}

/* ---------------- Start ---------------- */
async function start() {
  await DB.open();
  S = { ...S, ...((await DB.getMeta('settings')) || {}) };
  try { LOGO = await blobToDataURL(await (await fetch('logo.jpg')).blob()); } catch (e) { LOGO = null; }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  initSig();
  initImgSig();
  $('#app').addEventListener('input', onFormInput);
  $('#app').addEventListener('change', onFormInput);
  $('#backBtn').onclick = () => { history.length > 1 ? history.back() : (location.hash = '#/'); };
  $('#setBtn').onclick = () => { location.hash = '#/settings'; };
  $('#pill').onclick = () => { if (!S.url) location.hash = '#/settings'; else sync(); };
  window.addEventListener('hashchange', route);
  window.addEventListener('online', () => sync({ quiet: true }));
  window.addEventListener('offline', () => updatePill());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync({ quiet: true }); else flushSave(); });
  await route();
  sync({ quiet: true });
  setInterval(() => sync({ quiet: true }), 5 * 60 * 1000);
  if ('serviceWorker' in navigator && !isNative() && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
start().catch(e => { document.getElementById('app').textContent = 'Ralat memulakan app: ' + e.message; });
