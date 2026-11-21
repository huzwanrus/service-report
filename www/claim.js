'use strict';
/* JN Service Report — modul Expense Claim
 * Borang mengikut "Expense Claim Reimbursement Form" asal (Excel).
 * - Expense code: senarai pilihan. Mileage: destination, km x kadar, activity.
 * - Gambar resit: disimpan dalam phone, dimuat naik ke folder Google Drive server.
 * - Output: PDF (borang + muka surat resit) dan Excel (template asal diisi).
 * - Setiap engineer hanya nampak claim sendiri (ikut Nama engineer dalam Tetapan).
 * Bergantung pada app.js (DB, api, S, esc, toast, deliverFile, ...) dan quote.js (money, qnum).
 */
const C_CODES = ['Tool', 'Meal', 'Mileage', 'Petrol', 'Toll', 'Parking', 'Car Maintenance', 'Hotel', 'Transport', 'Other'];
const C_MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const cui = { q: '', filter: 'all' };
let ccur = null, csaveT = null;

const cnorm = s => String(s || '').trim().toLowerCase();
const cMine = c => cnorm(c.owner) === cnorm(S.engineer);
const cRate = it => qnum(it.rate) || 0.8;
const cEx = it => it.code === 'Mileage' ? Math.round(qnum(it.km) * cRate(it) * 100) / 100 : qnum(it.exTax);
const cTax = it => it.code === 'Mileage' ? 0 : qnum(it.tax);
const cInc = it => Math.round((cEx(it) + cTax(it)) * 100) / 100;
const cTotal = c => (c.items || []).reduce((s, it) => s + cInc(it), 0);
const cHas = it => it.code && (cInc(it) > 0 || String(it.desc || it.dest || '').trim());
const cMonth = iso => { const m = /^\d{4}-(\d{2})/.exec(iso || ''); return m ? C_MON[+m[1] - 1] : ''; };
const cTitle = c => `${fmtDate(c.claimDate) || '-'}${c.period ? ' (' + c.period + ')' : ''}`;

/** Teks lajur Details/Description. Mileage: destination, km x kadar, activity. */
function cDetails(it) {
  if (it.code !== 'Mileage') return String(it.desc || '').trim();
  const km = qnum(it.km);
  return [String(it.dest || '').trim() ? 'Destination: ' + String(it.dest).trim() : '',
    km ? `${km} km x RM${cRate(it).toFixed(2)} = RM${money(cEx(it))}` : '',
    String(it.activity || '').trim()].filter(Boolean).join('\n');
}

async function claimCfg() {
  const c = (await DB.getMeta('claimCfg')) || {};
  return { rate: qnum(c.rate) || 0.8, fullName: c.fullName || '', dept: c.dept || 'SERVICE' };
}
async function setClaimCfg(patch) { const c = (await DB.getMeta('claimCfg')) || {}; await DB.setMeta('claimCfg', { ...c, ...patch }); }

/* ---------------- Gambar resit ---------------- */
async function compressImage(file, maxSide = 1600, q = 0.72) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    const k = Math.min(1, maxSide / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', q);
  } finally { URL.revokeObjectURL(url); }
}
/** Gambar resit untuk item: dari phone, atau muat turun dari server jika perlu. */
async function getReceipt(it) {
  if (!it.receiptId) return null;
  const f = await DB.fget(it.receiptId);
  if (f && f.data) return f.data;
  if (!it.receiptDrive || !S.url || !navigator.onLine) return null;
  try {
    const j = await api('getfile', { driveId: it.receiptDrive });
    const data = `data:${j.mime || 'image/jpeg'};base64,${j.data}`;
    await DB.fput({ id: it.receiptId, data, mime: j.mime || 'image/jpeg', driveId: it.receiptDrive });
    return data;
  } catch (e) { return null; }
}

/* ---------------- Sync ---------------- */
async function syncClaims() {
  const owner = String(S.engineer || '').trim();
  if (!owner) return { sent: 0, pulled: 0 };
  let sent = 0, pulled = 0;
  const pending = (await DB.call()).filter(c => c.status === 'pending' && cMine(c));
  for (const c of pending) {
    for (const it of c.items || []) {          // muat naik resit dahulu
      if (!it.receiptId || it.receiptDrive) continue;
      const f = await DB.fget(it.receiptId);
      if (!f || !f.data) continue;
      const j = await api('upload', { file: { name: `${c.id}_${it.receiptId}.jpg`, mime: f.mime || 'image/jpeg', data: f.data.split(',')[1] } });
      it.receiptDrive = j.driveId; f.driveId = j.driveId; await DB.fput(f);
    }
    const { status, ...claim } = c;
    claim.total = cTotal(c).toFixed(2);
    const j = await api('csubmit', { claim });
    const now = await DB.cget(c.id);
    if (!now) continue;
    const drive = {}; (c.items || []).forEach(it => { if (it.receiptDrive) drive[it.id] = it.receiptDrive; });
    (now.items || []).forEach(it => { if (!it.receiptDrive && drive[it.id] && it.receiptId) it.receiptDrive = drive[it.id]; });
    now.serverUpdatedAt = j.serverUpdatedAt;
    if (now.updatedAt === c.updatedAt) now.status = 'synced';
    await DB.cput(now); sent++;
    if (ccur && ccur.id === now.id) { ccur.serverUpdatedAt = now.serverUpdatedAt; ccur.status = now.status; ccur.items.forEach(it => { if (drive[it.id] && !it.receiptDrive) it.receiptDrive = drive[it.id]; }); }
  }
  const key = 'lastCPull:' + cnorm(owner);
  const since = (await DB.getMeta(key)) || '';
  const j = await api('clist', { since, owner });
  let max = since;
  for (const s of j.claims || []) {
    if (!s.id) continue;
    const l = await DB.cget(s.id);
    if (!l || (l.status === 'synced' && (s.serverUpdatedAt || '') > (l.serverUpdatedAt || ''))) {
      s.items = Array.isArray(s.items) ? s.items : [];
      await DB.cput({ ...s, status: 'synced' }); pulled++;
    }
    if ((s.serverUpdatedAt || '') > max) max = s.serverUpdatedAt;
  }
  await DB.setMeta(key, max);
  return { sent, pulled };
}

/* ---------------- Senarai ---------------- */
async function renderCList() {
  setTitle('Claim');
  const mine = S.engineer ? (await DB.call()).filter(cMine) : [];
  const dr = c => (c.status === 'draft' ? 0 : 1);
  mine.sort((a, b) => dr(a) - dr(b) || (b.claimDate || '').localeCompare(a.claimDate || '') || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const q = cui.q.trim().toLowerCase();
  const list = mine.filter(c => {
    if (cui.filter === 'draft' && c.status !== 'draft') return false;
    if (cui.filter === 'pending' && c.status !== 'pending') return false;
    if (!q) return true;
    return [c.period, fmtDate(c.claimDate), c.name, ...(c.items || []).map(i => [i.code, i.desc, i.dest, i.activity, i.resit].join(' '))]
      .some(v => String(v || '').toLowerCase().includes(q));
  });
  const chip = (k, label) => `<button data-cflt="${k}" class="${cui.filter === k ? 'on' : ''}">${label}</button>`;
  $('#app').innerHTML = `
    ${tabsHTML('c')}
    ${!S.engineer ? `<div class="banner">Isi <b>Nama engineer</b> dalam <a href="#/settings">Tetapan</a> dahulu. Claim disimpan dan dipaparkan mengikut nama itu.</div>` : ''}
    <div class="search"><input id="cq" type="search" placeholder="Cari tarikh, bulan, expense code, destination…" value="${esc(cui.q)}"></div>
    <div class="chips">
      ${chip('all', `Semua (${mine.length})`)}
      ${chip('draft', `Draf (${mine.filter(c => c.status === 'draft').length})`)}
      ${chip('pending', `Belum sync (${mine.filter(c => c.status === 'pending').length})`)}
    </div>
    <div id="cards">
      ${list.length ? list.map(ccard).join('') : `<div class="empty">${mine.length ? 'Tiada claim sepadan.' : 'Belum ada claim.<br>Tekan <b>Claim Baharu</b> untuk mula.'}</div>`}
    </div>
    ${S.engineer ? `<button class="fab" onclick="location.hash='#/cnew'"><span style="font-size:20px;line-height:1">+</span> Claim Baharu</button>` : ''}`;
  $('#cq').addEventListener('input', e => {
    cui.q = e.target.value; const pos = e.target.selectionStart;
    renderCList().then(() => { const i = $('#cq'); i.focus(); try { i.setSelectionRange(pos, pos); } catch (x) {} });
  });
  $$('[data-cflt]').forEach(b => b.onclick = () => { cui.filter = b.dataset.cflt; renderCList(); });
}

function ccard(c) {
  const [label, cls] = STATUS[c.status] || STATUS.draft;
  const items = (c.items || []).filter(cHas);
  const codes = [...new Set(items.map(i => i.code))].join(', ');
  return `<a class="card" href="#/cview/${encodeURIComponent(c.id)}">
    <div class="r1"><span class="no">${esc(cTitle(c))}</span><span class="badge ${cls}">${label}</span></div>
    <div class="cl">RM ${money(cTotal(c))}</div>
    <div class="mt">${esc([items.length + ' item', codes].filter(Boolean).join(' · '))}</div></a>`;
}

/* ---------------- Cipta / Edit ---------------- */
function blankItem(c, extra = {}) {
  return { id: uuid(), date: today(), resit: '', code: '', dept: (c && c.dept) || 'SERVICE', desc: '', exTax: '', tax: '', remark: '',
    dest: '', km: '', activity: '', rate: '', receiptId: '', receiptDrive: '', ...extra };
}
async function newClaim() {
  if (!S.engineer) { toast('Isi Nama engineer dalam Tetapan dahulu'); location.replace('#/settings'); return; }
  const cfg = await claimCfg(); const now = new Date().toISOString(), d = today();
  const c = { id: uuid(), owner: S.engineer, name: cfg.fullName || S.engineer.toUpperCase(), dept: cfg.dept, claimDate: d, period: cMonth(d),
    items: [], mileageRate: cfg.rate, createdBy: S.engineer, createdAt: now, updatedAt: now, serverUpdatedAt: '', status: 'draft' };
  c.items.push(blankItem(c, { resit: '1', rate: cfg.rate }));
  await DB.cput(c);
  location.replace('#/cedit/' + encodeURIComponent(c.id));
}
function cQueueSave() {
  if (!ccur) return;
  ccur.updatedAt = new Date().toISOString();
  if (ccur.status === 'synced') ccur.status = 'pending';
  clearTimeout(csaveT);
  csaveT = setTimeout(() => { csaveT = null; DB.cput(ccur).then(() => updatePill()); }, 400);
}
async function cFlushSave() { if (csaveT) { clearTimeout(csaveT); csaveT = null; if (ccur) await DB.cput(ccur); } }

async function renderCEdit(id) {
  const c = await DB.cget(id);
  if (!c || !cMine(c)) { location.replace('#/c'); return; }
  ccur = c;
  if (!Array.isArray(ccur.items) || !ccur.items.length) ccur.items = [blankItem(ccur, { resit: '1', rate: ccur.mileageRate })];
  ccur.items.forEach(it => { if (it.scan === 'reading') it.scan = 'offline'; });   // bacaan terputus sebelum ini
  setTitle(c.status === 'draft' ? 'Claim Baharu' : 'Edit Claim');
  const isDraft = c.status === 'draft';
  const f = (k, label, o = {}) => `<label class="f"><span>${label}</span><input data-ck="${k}" type="${o.type || 'text'}" value="${esc(ccur[k] || '')}" placeholder="${esc(o.ph || '')}" autocomplete="off" ${o.up ? 'autocapitalize="characters"' : ''}></label>`;
  $('#app').innerHTML = `
    <div class="sec">
      <h2>BUTIRAN BORANG</h2>
      ${f('name', 'Name', { up: true })}
      <div class="grid2">${f('dept', 'Dept', { up: true })}${f('claimDate', 'Date', { type: 'date' })}</div>
      ${f('period', 'Bulan / catatan pada tarikh', { ph: 'cth. OCT', up: true })}
    </div>
    <div class="sec">
      <h2>PERBELANJAAN</h2>
      <div class="scanbar">
        <div class="scant"><b>Scan resit</b><span>Perbelanjaan ditambah automatik daripada gambar resit. Boleh pilih banyak gambar sekaligus.</span></div>
        <div class="sigbtns" style="margin:0">
          <label class="sbtn pri">${ICON.cam || ''}Kamera<input type="file" accept="image/*" capture="environment" id="scanCam" hidden></label>
          <label class="sbtn">${ICON.img || ''}Galeri<input type="file" accept="image/*" multiple id="scanGal" hidden></label>
        </div>
      </div>
      <div id="citems"></div>
      <button class="add" id="cAdd" type="button">+ Tambah perbelanjaan</button>
      <div class="qsum">Total Amount: <b id="cGrand">RM ${money(cTotal(ccur))}</b></div>
    </div>
    ${isDraft ? `<button class="btn d" id="cDel" style="width:100%;margin-bottom:12px">Padam draf ini</button>` : ''}
    <div class="bar"><div>
      ${isDraft ? `<button class="btn" id="cDraftBtn">Simpan Draf</button><button class="btn p" id="cSendBtn">Hantar ke Server</button>`
                : `<button class="btn p" id="cSendBtn">Simpan &amp; Kemas Kini</button>`}
    </div></div>`;
  renderCItems();
  $$('[data-ck]').forEach(el => el.addEventListener('input', () => {
    const k = el.dataset.ck, old = ccur[k]; ccur[k] = el.value;
    if (k === 'claimDate' && (!ccur.period || ccur.period === cMonth(old))) { ccur.period = cMonth(el.value); $('[data-ck=period]').value = ccur.period; }
    cQueueSave();
  }));
  $('#cAdd').onclick = () => {
    const last = ccur.items[ccur.items.length - 1];
    const nextResit = String((Math.max(0, ...ccur.items.map(i => parseInt(i.resit, 10) || 0))) + 1);
    ccur.items.push(blankItem(ccur, { resit: nextResit, rate: ccur.mileageRate, date: last ? last.date : today() }));
    renderCItems(); cQueueSave();
    const cards = $$('.citem'); cards[cards.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  if ($('#cDraftBtn')) $('#cDraftBtn').onclick = async () => { await cFlushSave(); toast('Draf disimpan dalam phone'); location.hash = '#/cview/' + encodeURIComponent(ccur.id); };
  $('#cSendBtn').onclick = submitClaim;
  ['#scanCam', '#scanGal'].forEach(s => { $(s).onchange = e => { const fs = [...(e.target.files || [])]; e.target.value = ''; if (fs.length) scanFiles(fs); }; });
  if ($('#cDel')) $('#cDel').onclick = async () => {
    if (!confirm('Padam draf claim ini?')) return;
    clearTimeout(csaveT); csaveT = null;
    for (const it of ccur.items) if (it.receiptId) await DB.fdel(it.receiptId);
    await DB.cdel(ccur.id); ccur = null; toast('Draf dipadam'); location.replace('#/c');
  };
}

function renderCItems() {
  const box = $('#citems');
  box.innerHTML = ccur.items.map((it, i) => {
    const mil = it.code === 'Mileage';
    const v = k => esc(it[k] ?? '');
    return `<div class="citem qitem ${it.scan === 'check' ? 'aichk' : ''}" data-ci="${i}">
      <div class="hd"><span>Perbelanjaan ${i + 1}</span><button type="button" class="qdel" data-crm="${i}">Buang</button></div>
      ${scanBadge(it, i)}
      <div class="grid2">
        <label class="f"><span>Expense code</span><select data-cf="code">
          <option value="">- Pilih -</option>${C_CODES.map(o => `<option ${it.code === o ? 'selected' : ''}>${o}</option>`).join('')}
        </select></label>
        <label class="f"><span>Date</span><input type="date" data-cf="date" value="${v('date')}"></label>
      </div>
      ${mil ? `
        <label class="f"><span>Destination</span><input data-cf="dest" value="${v('dest')}" placeholder="cth. Hospital Selayang" autocapitalize="words"></label>
        <div class="grid2">
          <label class="f"><span>Total mileage (km)</span><input data-cf="km" inputmode="decimal" value="${v('km')}"></label>
          <label class="f"><span>Kadar (RM/km)</span><input data-cf="rate" inputmode="decimal" value="${esc(String(cRate(it).toFixed(2)))}"></label>
        </div>
        <div class="milcalc" data-cmil="${i}">${esc(mileText(it))}</div>
        <label class="f"><span>Activity description</span><textarea rows="2" data-cf="activity" placeholder="cth. PPM Compact Touch (JN021126C)">${v('activity')}</textarea></label>
        <button type="button" class="sbtn" data-cpick="${i}" style="margin:-2px 0 10px">${ICON.img || ''}Isi daripada service report</button>`
      : `
        <label class="f"><span>Details / Description</span><textarea rows="2" data-cf="desc">${v('desc')}</textarea></label>
        <div class="grid2">
          <label class="f"><span>Amount excl. tax (RM)</span><input data-cf="exTax" inputmode="decimal" value="${v('exTax')}"></label>
          <label class="f"><span>Tax (RM)</span><input data-cf="tax" inputmode="decimal" value="${v('tax')}" placeholder="0.00"></label>
        </div>`}
      <div class="grid2">
        <label class="f"><span>Resit No.</span><input data-cf="resit" value="${v('resit')}"></label>
        <label class="f"><span>Dept</span><input data-cf="dept" value="${v('dept')}" autocapitalize="characters"></label>
      </div>
      <label class="f"><span>Remark</span><input data-cf="remark" value="${v('remark')}"></label>
      <div class="rcpt" data-crc="${i}"></div>
      <div class="qline">Amount inc. tax: RM <b data-cinc="${i}">${money(cInc(it))}</b></div>
    </div>`;
  }).join('');
  $$('textarea', box).forEach(autoGrow);
  ccur.items.forEach((it, i) => renderReceiptBox(i));
  $$('[data-cf]', box).forEach(el => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
    const i = +el.closest('[data-ci]').dataset.ci, it = ccur.items[i], k = el.dataset.cf;
    it[k] = el.value;
    if (it.scan === 'ok' || it.scan === 'check') { it.scan = 'edited'; const card = el.closest('[data-ci]'); card.classList.remove('aichk'); const bd = $('.scanb', card); if (bd) bd.remove(); }
    if (k === 'code') {
      if (it.code === 'Mileage' && !qnum(it.rate)) it.rate = ccur.mileageRate || 0.8;
      cQueueSave(); renderCItems(); return;
    }
    if (el.tagName === 'TEXTAREA') autoGrow(el);
    const m = $(`[data-cmil="${i}"]`); if (m) m.textContent = mileText(it);
    $(`[data-cinc="${i}"]`).textContent = money(cInc(it));
    $('#cGrand').textContent = 'RM ' + money(cTotal(ccur));
    cQueueSave();
  }));
  $$('[data-crm]', box).forEach(b => b.onclick = async () => {
    const i = +b.dataset.crm, it = ccur.items[i];
    if ((cInc(it) > 0 || it.receiptId) && !confirm('Buang perbelanjaan ini?')) return;
    if (it.receiptId && !it.receiptDrive) await DB.fdel(it.receiptId);
    ccur.items.splice(i, 1);
    if (!ccur.items.length) ccur.items.push(blankItem(ccur, { resit: '1', rate: ccur.mileageRate }));
    renderCItems(); $('#cGrand').textContent = 'RM ' + money(cTotal(ccur)); cQueueSave();
  });
  $$('[data-cpick]', box).forEach(b => b.onclick = () => pickReport(+b.dataset.cpick));
  $$('[data-cscan]', box).forEach(b => b.onclick = async () => { await scanItem(ccur.items[+b.dataset.cscan]); renderCItems(); });
}
/* ---------------- Scan resit (Gemini melalui server) ---------------- */
function scanBadge(it, i) {
  const s = it.scan;
  if (!s || s === 'edited') return '';
  const dup = it.scanDup ? ` Mungkin pendua dengan perbelanjaan ${it.scanDup}.` : '';
  if (s === 'reading') return `<div class="scanb rd"><span class="spin"></span>Membaca resit…</div>`;
  if (s === 'ok') return `<div class="scanb ok">✓ Diisi daripada resit${it.scanFrom ? ' (' + esc(it.scanFrom) + ')' : ''}. Sila semak.${esc(dup)}</div>`;
  if (s === 'check') return `<div class="scanb ck">⚠ Diisi oleh AI tetapi resit kurang jelas. Semak tarikh dan amaun.${esc(dup)}</div>`;
  if (s === 'offline') return `<div class="scanb ck">Resit belum dibaca (tiada internet atau server). <button type="button" class="lnk" data-cscan="${i}">Baca sekarang</button></div>`;
  if (s === 'fail') return `<div class="scanb er">Resit tidak dapat dibaca: ${esc(it.scanErr || '')} <button type="button" class="lnk" data-cscan="${i}">Cuba lagi</button></div>`;
  return '';
}

/** Tambah satu perbelanjaan bagi setiap gambar resit, kemudian baca setiap resit. */
async function scanFiles(files) {
  const added = [];
  for (const file of files) {
    let data;
    try { data = await compressImage(file); } catch (e) { toast('Satu gambar tidak dapat dibuka', 3000); continue; }
    const rid = uuid();
    await DB.fput({ id: rid, data, mime: 'image/jpeg', claimId: ccur.id });
    const nextResit = String(Math.max(0, ...ccur.items.map(x => parseInt(x.resit, 10) || 0)) + 1);
    const it = blankItem(ccur, { resit: nextResit, rate: ccur.mileageRate, date: '', receiptId: rid, scan: 'reading' });
    // gantikan baris kosong pertama (claim baharu bermula dengan satu baris kosong)
    const blank = ccur.items.findIndex(x => !x.code && !x.receiptId && !(cInc(x) > 0) && !String(x.desc || x.dest || '').trim());
    if (blank >= 0) { it.resit = ccur.items[blank].resit || it.resit; ccur.items[blank] = it; } else ccur.items.push(it);
    added.push(it);
  }
  if (!added.length) return;
  cQueueSave(); renderCItems();
  const firstCard = $(`[data-ci="${ccur.items.indexOf(added[0])}"]`); if (firstCard) firstCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  let ok = 0;
  for (let k = 0; k < added.length; k++) {
    if (added.length > 1) toast(`Membaca resit ${k + 1}/${added.length}…`, 2500);
    if (await scanItem(added[k])) ok++;
    if (!ccur || !ccur.items.includes(added[k])) return;   // pengguna telah keluar dari borang
    renderCItems(); $('#cGrand').textContent = 'RM ' + money(cTotal(ccur));
  }
  toast(ok === added.length ? `${ok} resit dibaca. Sila semak setiap perbelanjaan.` : `${ok}/${added.length} resit dibaca. Semak yang bertanda.`, 3500);
}

/** Baca satu resit dan isi medan yang masih kosong. Pulangkan true jika berjaya. */
async function scanItem(it) {
  if (!it || !it.receiptId) return false;
  const f = await DB.fget(it.receiptId);
  const data = (f && f.data) || await getReceipt(it);
  if (!data) { it.scan = 'fail'; it.scanErr = 'gambar tiada'; cQueueSave(); return false; }
  if (!S.url || !navigator.onLine) { it.scan = 'offline'; cQueueSave(); return false; }
  const live = () => ccur && ccur.items.includes(it) && $('#citems');
  it.scan = 'reading'; if (live()) renderCItems();
  try {
    const j = await api('scanReceipt', { image: data.split(',')[1], mime: 'image/jpeg' });
    const r = j.receipt || {};
    const total = Math.round(qnum(r.total) * 100) / 100, tax = Math.round(qnum(r.tax) * 100) / 100;
    if (!it.code && r.category) it.code = r.category;
    if (!it.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) it.date = r.date;
    if (!String(it.desc || '').trim()) it.desc = [r.merchant, r.description, r.receiptNo ? 'No. ' + r.receiptNo : ''].map(s => String(s || '').trim()).filter(Boolean).join(' - ');
    if (!qnum(it.exTax) && total > 0) { it.exTax = (Math.round((total - Math.min(tax, total)) * 100) / 100).toFixed(2); it.tax = tax ? tax.toFixed(2) : ''; }
    if (!it.date) it.date = today();
    it.scanFrom = String(r.merchant || '').trim().slice(0, 40);
    it.scan = r.confidence === 'high' && total > 0 && /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? 'ok' : 'check';
    const n = ccur ? ccur.items.findIndex(x => x !== it && x.code === it.code && x.date === it.date && Math.abs(cInc(x) - cInc(it)) < 0.005 && cInc(it) > 0) : -1;
    it.scanDup = n >= 0 ? n + 1 : 0;
    cQueueSave();
    return true;
  } catch (e) {
    it.scan = 'fail'; it.scanErr = e.message; cQueueSave();
    return false;
  }
}

function mileText(it) {
  const km = qnum(it.km);
  return km ? `${km} km × RM${cRate(it).toFixed(2)} = RM${money(cEx(it))}` : 'Isi jumlah km untuk kira amaun mileage';
}

async function renderReceiptBox(i) {
  const box = $(`[data-crc="${i}"]`); if (!box) return;
  const it = ccur.items[i];
  const data = it.receiptId ? await getReceipt(it) : null;
  if (it.receiptId) {
    const canScan = data && it.code !== 'Mileage' && !it.scan && !(cInc(it) > 0);
    box.innerHTML = `<div class="rthumb">${data ? `<img src="${data}" alt="Resit">` : '<span class="hint">Gambar resit di server (akan dimuat turun bila online)</span>'}
      <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start">
        ${canScan ? `<button type="button" class="sbtn" data-cscan="${i}">Isi daripada resit</button>` : ''}
        <button type="button" class="qdel" data-rrm="${i}">Buang gambar</button></div></div>`;
    const sb = $(`[data-cscan="${i}"]`, box); if (sb) sb.onclick = async () => { await scanItem(it); renderCItems(); };
    $(`[data-rrm="${i}"]`, box).onclick = async () => {
      if (!confirm('Buang gambar resit ini?')) return;
      if (!it.receiptDrive) await DB.fdel(it.receiptId);
      it.receiptId = ''; it.receiptDrive = ''; cQueueSave(); renderReceiptBox(i);
    };
  } else {
    box.innerHTML = `<div class="sigbtns" style="margin:0 0 8px">
      <label class="sbtn">${ICON.cam || ''}Ambil gambar resit<input type="file" accept="image/*" capture="environment" data-rin="${i}" hidden></label>
      <label class="sbtn">${ICON.img || ''}Galeri<input type="file" accept="image/*" data-rin="${i}" hidden></label></div>`;
    $$('[data-rin]', box).forEach(inp => inp.onchange = async e => {
      const file = e.target.files && e.target.files[0]; e.target.value = ''; if (!file) return;
      try {
        const data = await compressImage(file);
        const rid = uuid();
        await DB.fput({ id: rid, data, mime: 'image/jpeg', claimId: ccur.id });
        it.receiptId = rid; it.receiptDrive = ''; cQueueSave(); renderReceiptBox(i);
      } catch (err) { toast('Gambar tidak dapat dibuka', 3000); }
    });
  }
}

/** Pilih service report untuk isi destination dan activity mileage. */
async function pickReport(i) {
  const me = cnorm(S.engineer);
  const reps = (await DB.all()).filter(r => r.status !== 'draft' && (!me || cnorm(r.engineer).includes(me) || cnorm(r.createdBy) === me))
    .sort((a, b) => (b.reportDate || '').localeCompare(a.reportDate || '')).slice(0, 60);
  const ov = document.createElement('div'); ov.className = 'modal on';
  ov.innerHTML = `<div class="mbox" style="max-height:85vh;display:flex;flex-direction:column">
    <h3>Pilih service report</h3><p>Destination dan activity akan diisi daripada report.</p>
    <div style="overflow:auto;flex:1">${reps.length ? reps.map(r => `<button type="button" class="card" data-rid="${esc(r.id)}" style="width:100%;text-align:left;cursor:pointer;font:inherit">
      <div class="r1"><span class="no">${esc(r.reportNo || 'Menunggu no.')}</span><span class="mt">${esc(fmtDate(r.reportDate))}</span></div>
      <div class="cl">${esc(r.client || '-')}</div><div class="mt">${esc([r.equipment, (r.workTypes || []).join(', ')].filter(Boolean).join(' · '))}</div></button>`).join('')
      : '<div class="empty">Tiada service report atas nama anda.</div>'}</div>
    <div class="mbtns"><button class="btn" data-x>Batal</button></div></div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-x]').onclick = () => ov.remove();
  ov.querySelectorAll('[data-rid]').forEach(b => b.onclick = () => {
    const r = reps.find(x => x.id === b.dataset.rid), it = ccur.items[i];
    it.date = r.reportDate || it.date;
    it.dest = [r.client, r.location].map(v => String(v || '').trim()).filter(Boolean).join(', ');
    it.activity = [(r.workTypes || []).join('/'), r.equipment, r.serial ? 'SN ' + r.serial : '', r.reportNo ? '(' + r.reportNo + ')' : ''].filter(Boolean).join(' ');
    ov.remove(); cQueueSave(); renderCItems();
  });
}

async function submitClaim() {
  if (ccur.items.some(it => it.scan === 'reading')) { toast('Tunggu sehingga semua resit selesai dibaca', 3000); return; }
  const miss = [];
  if (!String(ccur.name || '').trim()) miss.push('Name');
  if (!ccur.claimDate) miss.push('Date');
  const items = ccur.items.filter(it => it.code || cInc(it) > 0 || String(it.desc || it.dest || '').trim());
  if (!items.length) miss.push('Sekurang-kurangnya satu perbelanjaan');
  items.forEach((it, k) => {
    const n = ccur.items.indexOf(it) + 1;
    if (!it.code) miss.push(`Expense code (item ${n})`);
    else if (it.code === 'Mileage') { if (!String(it.dest || '').trim()) miss.push(`Destination (item ${n})`); if (!qnum(it.km)) miss.push(`Total mileage (item ${n})`); }
    else if (!(cInc(it) > 0)) miss.push(`Amount (item ${n})`);
  });
  if (miss.length) { toast('Sila isi: ' + miss.slice(0, 4).join(', ') + (miss.length > 4 ? '…' : ''), 4000); return; }
  ccur.items = items;
  items.forEach(it => { if (it.scan === 'ok' || it.scan === 'check') it.scan = 'edited'; delete it.scanDup; });
  ccur.status = 'pending'; ccur.updatedAt = new Date().toISOString();
  clearTimeout(csaveT); csaveT = null;
  await DB.cput(ccur);
  await setClaimCfg({ fullName: ccur.name, dept: ccur.dept });
  const id = ccur.id;
  const btn = $('#cSendBtn'); if (btn) { btn.disabled = true; btn.textContent = 'Menghantar…'; }
  if (!S.url) toast('Disimpan. Akan dihantar bila server ditetapkan.', 3500);
  else if (!navigator.onLine) toast('Offline. Claim akan dihantar bila ada internet.', 3500);
  else await sync({ quiet: false });
  location.hash = '#/cview/' + encodeURIComponent(id);
}

/* ---------------- Paparan ---------------- */
async function renderCView(id) {
  const c = await DB.cget(id);
  if (!c || !cMine(c)) { location.replace('#/c'); return; }
  ccur = null;
  setTitle('Claim ' + cTitle(c));
  const [label, cls] = STATUS[c.status] || STATUS.draft;
  const canShare = isNative() || !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] }));
  const items = (c.items || []).filter(cHas);
  const nRc = items.filter(i => i.receiptId).length;
  $('#app').innerHTML = `
    <div class="noBox">
      <div><small>Expense Claim</small><span class="no">${esc(cTitle(c))}</span></div>
      <span class="badge ${cls}">${label}</span>
    </div>
    <div class="acts">
      ${canShare ? `<button class="btn p" id="cShare">Kongsi PDF</button>` : ''}
      ${isNative() ? '' : `<button class="btn ${canShare ? '' : 'p'}" id="cDl">Muat turun PDF</button>`}
      <button class="btn" id="cXls">${isNative() ? 'Kongsi Excel' : 'Muat turun Excel'}</button>
      <button class="btn" id="cEdit">${c.status === 'draft' ? 'Sambung isi' : 'Edit'}</button>
      ${c.status === 'pending' ? `<button class="btn" id="cSync" style="grid-column:1/-1">Hantar ke server sekarang</button>` : ''}
    </div>
    ${c.status === 'draft' ? `<div class="banner">Draf ini hanya disimpan dalam phone. Tekan <b>Sambung isi</b> kemudian <b>Hantar ke Server</b> untuk simpan dalam rekod.</div>` : ''}
    <div class="sec"><h2>BUTIRAN</h2><dl class="kv">
      <dt>Name</dt><dd>${esc(c.name || '-')}</dd><dt>Dept</dt><dd>${esc(c.dept || '-')}</dd><dt>Date</dt><dd>${esc(cTitle(c))}</dd>
    </dl></div>
    <div class="sec"><h2>PERBELANJAAN</h2>
      ${items.length ? items.map(it => `<div class="qv">
        <div class="r1" style="display:flex;justify-content:space-between;gap:8px"><b>${esc(it.code)}</b><span class="mt">${esc(fmtDate(it.date))}${it.resit ? ' · Resit ' + esc(it.resit) : ''}${it.receiptId ? ' · 📎' : ''}</span></div>
        <div class="qvd">${esc(cDetails(it) || '-')}</div>
        ${it.remark ? `<div class="mt">Remark: ${esc(it.remark)}</div>` : ''}
        <div class="qvm">RM ${money(cEx(it))}${cTax(it) ? ' + tax RM ' + money(cTax(it)) : ''} = <b>RM ${money(cInc(it))}</b></div></div>`).join('') : '<div class="txt">-</div>'}
      <div class="qsum">Total Amount: <b>RM ${money(cTotal(c))}</b></div>
      ${nRc ? `<div class="hint" style="text-align:right">${nRc} gambar resit akan dilampirkan dalam PDF</div>` : ''}
    </div>
    <div class="meta">Dikemas kini ${esc(c.updatedAt ? fmtDT(new Date(c.updatedAt)) : '-')}</div>`;
  if ($('#cShare')) $('#cShare').onclick = () => exportClaimPDF(c, true);
  if ($('#cDl')) $('#cDl').onclick = () => exportClaimPDF(c, false);
  $('#cXls').onclick = () => exportClaimXLSX(c);
  $('#cEdit').onclick = () => { location.hash = '#/cedit/' + encodeURIComponent(c.id); };
  if ($('#cSync')) $('#cSync').onclick = () => sync();
}

const cFileBase = c => ('Claim_' + String(c.name || c.owner || '').trim().split(/\s+/).slice(0, 3).join('_') + '_' + (c.claimDate || today()))
  .replace(/[^\w\-]+/g, '_');

/* ---------------- PDF (susun atur borang Excel asal) ---------------- */
async function makeClaimPDF(c) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const PW = 297, PH = 210, L = 14, R = PW - 14, W = R - L, BOTTOM = PH - 12;
  const XW = [18.3, 28, 29.3, 14.3, 9.5, 22.2, 12.2, 15.5, 22.5];      // lebar lajur Excel A..I (Dept dilebarkan dari 6.5 supaya SERVICE muat)
  const sum = XW.reduce((a, b) => a + b, 0), cw = XW.map(w => w * W / sum);
  const cx = cw.reduce((a, w, i) => (a.push(i ? a[i - 1] + cw[i - 1] : L), a), []);
  const FS = 9, LH = FS * 1.25 * 25.4 / 72, ASC = LH * 0.78, PX = 1.3;
  const font = (st = 'normal', sz = FS) => { doc.setFont('helvetica', st); doc.setFontSize(sz); doc.setTextColor(0, 0, 0); };
  doc.setLineWidth(0.25); doc.setDrawColor(0);
  const items = (c.items || []).filter(cHas);

  // Kepala borang
  font('bold', 12); doc.text('Expense Claim Reimbursement Form', cx[2], 20);
  let y = 32;
  font('bold', 10); doc.text('Name :', L, y + 4);
  doc.rect(cx[1], y, cw[1] + cw[2], 5.6); font('normal', 10); doc.text(clean(c.name || ''), cx[1] + (cw[1] + cw[2]) / 2, y + 4, { align: 'center' });
  font('bold', 10); doc.text('Date: ', cx[8] - 1, y + 4, { align: 'right' });
  doc.rect(cx[8], y, cw[8], 5.6); doc.text(clean(cTitle(c)), cx[8] + 1, y + 4);
  y += 9;
  font('bold', 10); doc.text('Dept :', L, y + 4);
  doc.rect(cx[1], y, cw[1], 5.6); font('normal', 10); doc.text(clean(c.dept || ''), cx[1] + 1, y + 4);
  y += 13;

  const head = ['Date', 'Resit No.', 'Details/Description', 'Expense Code', 'Dept', 'Amount Excluding Tax ', 'Tax', 'Amount Inc. Tax', 'Remark'];
  const drawRow = (cells, { bold = false, minH = 6, align = [] } = {}) => {
    font(bold ? 'bold' : 'normal');
    const fit = cells.map((t, i) => {            // perkataan tunggal yang terlalu lebar (cth. SERVICE dalam lajur Dept): kecilkan fon
      const s = clean(t); if (/\s/.test(s.trim()) || !s) return FS;
      let z = FS; doc.setFontSize(z); while (z > 6 && doc.getTextWidth(s) > cw[i] - 2 * PX) { z -= 0.5; doc.setFontSize(z); }
      doc.setFontSize(FS); return z;
    });
    const wr = cells.map((t, i) => { doc.setFontSize(fit[i]); const a = doc.splitTextToSize(clean(t), cw[i] - 2 * PX); doc.setFontSize(FS); return a; });
    const h = Math.max(minH, Math.max(...wr.map(a => a.length)) * LH + 1.6);
    return { h, paint: () => {
      cells.forEach((t, i) => {
        doc.rect(cx[i], y, cw[i], h);
        const a = align[i] || 'left', tx = a === 'right' ? cx[i] + cw[i] - PX : cx[i] + PX;
        doc.setFontSize(fit[i]);
        wr[i].forEach((ln, k) => doc.text(ln, tx, y + 0.8 + ASC + k * LH, { align: a }));
        doc.setFontSize(FS);
      });
      y += h;
    } };
  };
  const header = () => drawRow(head, { bold: true });
  header().paint();
  const AL = ['left', 'left', 'left', 'left', 'left', 'right', 'right', 'left', 'left'];
  const rows = items.map(it => [fmtDate(it.date), it.resit || '', cDetails(it), it.code, it.dept || '', money(cEx(it)), cTax(it) ? money(cTax(it)) : '0.00', money(cInc(it)), it.remark || '']);
  while (rows.length < 7) rows.push(['', '', '', '', '', '', '', '', '']);   // borang asal: 7 baris
  rows.forEach(cells => {
    const r = drawRow(cells, { align: AL });
    if (y + r.h > BOTTOM - 20) { doc.addPage('a4', 'landscape'); y = 16; header().paint(); }
    r.paint();
  });
  drawRow(['Total ', '', '', '', '', '', '', '', '']).paint();
  font('normal', 9); doc.text('Total Amount', cx[7] - 2, y + 4.2, { align: 'right' });
  font('bold', 9); doc.text(money(cTotal(c)), cx[7] + PX, y + 4.2);
  y += 9;
  if (y + 27 > BOTTOM) { doc.addPage('a4', 'landscape'); y = 20; }
  font('italic', 9); doc.text('Note : Please number Receipts for identification purposes', cx[1], y + 3);
  y += Math.min(22, Math.max(12, BOTTOM - y - 15));
  font('normal', 9.5);
  doc.text('Signed by Employee:', L, y); doc.line(L + 33, y + 0.6, L + 150, y + 0.6);
  y += 12;
  doc.text('Signed/Approved by Manager:', L, y); doc.line(L + 47, y + 0.6, L + 150, y + 0.6);

  // Muka surat resit
  let missing = 0;
  for (const it of items) {
    if (!it.receiptId) continue;
    const data = await getReceipt(it);
    if (!data) { missing++; continue; }
    doc.addPage('a4', 'landscape');
    font('bold', 11); doc.text(clean(`Resit No. ${it.resit || '-'}  |  ${it.code}  |  ${fmtDate(it.date)}  |  RM ${money(cInc(it))}`), L, 14);
    font('normal', 9); const d = doc.splitTextToSize(clean(cDetails(it).replace(/\n/g, ' · ')), W); doc.text(d.slice(0, 2), L, 19.5);
    try {
      const pr = doc.getImageProperties(data), boxW = W, boxH = PH - 30 - 10;
      const k = Math.min(boxW / pr.width, boxH / pr.height), w = pr.width * k, h = pr.height * k;
      doc.addImage(data, 'JPEG', L + (boxW - w) / 2, 28, w, h, undefined, 'FAST');
    } catch (e) { missing++; }
  }
  return { doc, missing };
}

async function exportClaimPDF(c, share) {
  try {
    toast('Menjana PDF…', 1500);
    const { doc, missing } = await makeClaimPDF(c);
    if (missing) toast(`${missing} gambar resit tidak dapat dimuat (perlu internet). PDF tetap dijana.`, 4000);
    await deliverFile(cFileBase(c) + '.pdf', doc.output('blob'), share);
  } catch (e) { console.error(e); toast('Gagal jana PDF: ' + e.message, 3500); }
}

/* ---------------- Excel (template asal diisi) ---------------- */
function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return res();
    const s = document.createElement('script'); s.src = src; s.dataset.src = src; s.onload = res; s.onerror = () => rej(new Error('Gagal memuat ' + src));
    document.head.appendChild(s);
  });
}
async function makeClaimXLSX(c) {
  if (!window.ExcelJS) await loadScript('exceljs.min.js');
  const buf = await (await fetch('claim_template.xlsx')).arrayBuffer();
  const wb = new window.ExcelJS.Workbook(); await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  const items = (c.items || []).filter(cHas);
  const FIRST = 11, TPL_ROWS = 7;                                // baris item 11–17 dalam template
  const extra = Math.max(0, items.length - TPL_ROWS);
  if (extra) ws.duplicateRow(FIRST + TPL_ROWS - 1, extra, true);
  const lastItemRow = FIRST + TPL_ROWS - 1 + extra, totalRow = lastItemRow + 2;   // 'Total Amount' (asal H19)
  ws.getColumn('C').width = 29.3; ws.getColumn('E').width = 9.5;   // Dept dilebarkan supaya SERVICE muat (lebar keseluruhan kekal)
  ws.getCell('A' + (lastItemRow + 1)).alignment = { horizontal: 'left' };
  ws.getCell('B5').value = c.name || '';
  ws.getCell('I5').value = cTitle(c);
  ws.getCell('B7').value = c.dept || '';
  for (let r = FIRST; r <= lastItemRow; r++) for (const col of 'ABCDEFGHI') ws.getCell(col + r).value = null;   // buang contoh
  items.forEach((it, k) => {
    const r = FIRST + k, det = cDetails(it);
    ws.getCell('A' + r).value = fmtDate(it.date);
    ws.getCell('B' + r).value = it.resit || '';
    ws.getCell('C' + r).value = det;
    ws.getCell('D' + r).value = it.code;
    ws.getCell('E' + r).value = it.dept || '';
    ws.getCell('F' + r).value = cEx(it);
    ws.getCell('G' + r).value = cTax(it);
    ws.getCell('H' + r).value = { formula: `F${r}+G${r}`, result: cInc(it) };
    ws.getCell('I' + r).value = it.remark || '';
    // salin gaya setiap sel (baris yang diduplikasi berkongsi objek gaya yang sama dalam ExcelJS)
    for (const col of 'ABCDEFGHI') {
      const cell = ws.getCell(col + r), st = JSON.parse(JSON.stringify(cell.style || {}));
      if ('FGH'.includes(col)) st.numFmt = '0.00';
      st.alignment = { vertical: 'top', wrapText: col === 'C' || col === 'I', horizontal: col === 'F' || col === 'G' ? 'right' : 'left' };
      cell.style = st;
    }
    // anggaran baris selepas dilipat dalam lajur C (~28 aksara sebaris)
    const lines = det.split('\n').reduce((n, s) => n + Math.max(1, Math.ceil(s.length / 28)), 0);
    if (lines > 1) ws.getRow(r).height = 15 * lines;
  });
  ws.getCell('H' + totalRow).value = { formula: `SUM(H${FIRST}:H${lastItemRow + 1})`, result: Math.round(cTotal(c) * 100) / 100 };
  ws.getCell('H' + totalRow).numFmt = '0.00';
  const out = await wb.xlsx.writeBuffer();
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
async function exportClaimXLSX(c) {
  try {
    toast('Menjana Excel…', 1500);
    await deliverFile(cFileBase(c) + '.xlsx', await makeClaimXLSX(c), isNative());
  } catch (e) { console.error(e); toast('Gagal jana Excel: ' + e.message, 3500); }
}

/* ---------------- Tetapan claim ---------------- */
async function claimSettingsHTML() {
  const c = await claimCfg();
  return `<div class="sec">
    <h2>CLAIM</h2>
    <label class="f"><span>Nama penuh pada borang claim</span><input id="ccName" value="${esc(c.fullName)}" placeholder="cth. MUHAMMAD HAZWAN BIN RUSLAN" autocapitalize="characters"></label>
    <div class="grid2">
      <label class="f"><span>Dept</span><input id="ccDept" value="${esc(c.dept)}" autocapitalize="characters"></label>
      <label class="f"><span>Kadar mileage (RM/km)</span><input id="ccRate" inputmode="decimal" value="${esc(c.rate.toFixed(2))}"></label>
    </div>
    <div class="hint">Digunakan untuk claim baharu. Claim sedia ada mengekalkan kadar asalnya.</div>
  </div>`;
}
function bindClaimSettings() {
  $('#ccName').onchange = e => setClaimCfg({ fullName: e.target.value.trim() });
  $('#ccDept').onchange = e => setClaimCfg({ dept: e.target.value.trim() || 'SERVICE' });
  $('#ccRate').onchange = e => { const v = qnum(e.target.value); if (v > 0) { setClaimCfg({ rate: v }); toast('Kadar mileage: RM' + v.toFixed(2) + '/km'); } };
}
