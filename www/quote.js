'use strict';
/* JN Service Report — modul Quotation
 * Format PDF mengikut borang quotation asal Biz Medic: kepala surat penuh,
 * Times 11pt, jadual ITEM / DESCRIPTIONS / QTY / UNIT PRICE / TOTAL PRICE, cop.
 * Nombor QOYYYY/MM/NNN dikeluarkan oleh server (NNN bermula 001 setiap bulan).
 * Fail ini bergantung pada fungsi dalam app.js (DB, api, esc, toast, dll.).
 */
const Q_INTRO = 'We are pleased to quote you herewith the following item for your kind perusal and attention.';
const Q_VALID = '90 days from the above quoted date';
const Q_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const qui = { q: '', filter: 'all' };
let qcur = null, qsaveT = null;
let LETTERHEAD = null, STAMP_DEFAULT = null;

const qnum = v => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return isNaN(n) ? 0 : n; };
const money = n => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qOrd = d => (d % 100 >= 11 && d % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[d % 10] || 'th');
const qTotal = q => (q.items || []).reduce((s, it) => s + qnum(it.price) * qnum(it.qty), 0);
const qHas = it => String(it.desc || '').trim() || String(it.price || '').trim();

async function loadQuoteAssets() {
  try { LETTERHEAD = await blobToDataURL(await (await fetch('letterhead.jpg')).blob()); } catch (e) { LETTERHEAD = null; }
  try { STAMP_DEFAULT = await blobToDataURL(await (await fetch('stamp.png')).blob()); } catch (e) { STAMP_DEFAULT = null; }
}
async function quoteCfg() {
  const c = (await DB.getMeta('quoteCfg')) || {};
  return { stamp: c.stamp || STAMP_DEFAULT, custom: !!c.stamp, stampH: c.stampH || 30 };
}

/* ---------------- Tab atas: Service Report / Quotation ---------------- */
function tabsHTML(active) {
  return `<div class="tabs">
    <a href="#/" class="${active === 'r' ? 'on' : ''}">Service Report</a>
    <a href="#/q" class="${active === 'q' ? 'on' : ''}">Quotation</a>
  </div>`;
}

/* ---------------- Sync ---------------- */
async function syncQuotes(cb) {
  let sent = 0, pulled = 0;
  const pending = (await DB.qall()).filter(q => q.status === 'pending');
  for (const q of pending) {
    const { status, ...quote } = q;
    quote.total = qTotal(q).toFixed(2);
    const j = await api('qsubmit', { quote });
    const now = await DB.qget(q.id);
    if (!now) continue;
    now.quoteNo = j.quoteNo; now.serverUpdatedAt = j.serverUpdatedAt;
    if (now.updatedAt === q.updatedAt) now.status = 'synced';
    await DB.qput(now); sent++;
    if (qcur && qcur.id === now.id) { qcur.quoteNo = now.quoteNo; qcur.serverUpdatedAt = now.serverUpdatedAt; qcur.status = now.status; }
  }
  const since = (await DB.getMeta('lastQPull')) || '';
  const j = await api('qlist', { since });
  let max = since;
  for (const s of j.quotes || []) {
    if (!s.id) continue;
    const l = await DB.qget(s.id);
    if (!l || (l.status === 'synced' && (s.serverUpdatedAt || '') > (l.serverUpdatedAt || ''))) {
      s.items = Array.isArray(s.items) ? s.items : [];
      await DB.qput({ ...s, status: 'synced' }); pulled++;
    }
    if ((s.serverUpdatedAt || '') > max) max = s.serverUpdatedAt;
  }
  await DB.setMeta('lastQPull', max);
  return { sent, pulled };
}

/* ---------------- Senarai ---------------- */
function sortQuotes(a, b) {
  const rank = q => (q.status === 'draft' ? 0 : q.quoteNo ? 2 : 1);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (rank(a) === 2) return (b.quoteDate || '').localeCompare(a.quoteDate || '') || (b.quoteNo || '').localeCompare(a.quoteNo || '');
  return (b.updatedAt || '').localeCompare(a.updatedAt || '');
}

async function renderQList() {
  setTitle('Quotation');
  const all = (await DB.qall()).sort(sortQuotes);
  const q = qui.q.trim().toLowerCase();
  const list = all.filter(x => {
    if (qui.filter === 'draft' && x.status !== 'draft') return false;
    if (qui.filter === 'pending' && x.status !== 'pending') return false;
    if (!q) return true;
    return [x.quoteNo, x.addr, x.reportNo, ...(x.items || []).map(i => i.desc)].some(v => String(v || '').toLowerCase().includes(q));
  });
  const counts = { draft: all.filter(x => x.status === 'draft').length, pending: all.filter(x => x.status === 'pending').length };
  const chip = (k, label) => `<button data-qflt="${k}" class="${qui.filter === k ? 'on' : ''}">${label}</button>`;
  $('#app').innerHTML = `
    ${tabsHTML('q')}
    <div class="search"><input id="qq" type="search" placeholder="Cari no. quotation, penerima, item…" value="${esc(qui.q)}"></div>
    <div class="chips">
      ${chip('all', `Semua (${all.length})`)}
      ${chip('draft', `Draf (${counts.draft})`)}
      ${chip('pending', `Belum sync (${counts.pending})`)}
    </div>
    <div id="cards">
      ${list.length ? list.map(qcard).join('') : `<div class="empty">${all.length ? 'Tiada quotation sepadan.' : 'Belum ada quotation.<br>Tekan <b>Quotation Baharu</b> untuk mula.'}</div>`}
    </div>
    <button class="fab" onclick="location.hash='#/qnew'"><span style="font-size:20px;line-height:1">+</span> Quotation Baharu</button>`;
  $('#qq').addEventListener('input', e => {
    qui.q = e.target.value; const pos = e.target.selectionStart;
    renderQList().then(() => { const i = $('#qq'); i.focus(); try { i.setSelectionRange(pos, pos); } catch (x) {} });
  });
  $$('[data-qflt]').forEach(b => b.onclick = () => { qui.filter = b.dataset.qflt; renderQList(); });
}

function qcard(x) {
  const [label, cls] = STATUS[x.status] || STATUS.draft;
  const no = x.quoteNo ? `<span class="no">${esc(x.quoteNo)}</span>` : `<span class="no draft">${x.status === 'draft' ? 'DRAF' : 'Menunggu no.'}</span>`;
  const to = String(x.addr || '').split('\n')[0].trim();
  const items = (x.items || []).filter(qHas);
  const first = items.length ? String(items[0].desc || '').split('\n')[0] + (items.length > 1 ? ` (+${items.length - 1} item)` : '') : '';
  const mt = [fmtDate(x.quoteDate), 'RM ' + money(qTotal(x)), x.reportNo ? 'Report ' + x.reportNo : ''].filter(Boolean).join(' · ');
  return `<a class="card" href="#/qview/${encodeURIComponent(x.id)}">
    <div class="r1">${no}<span class="badge ${cls}">${label}</span></div>
    <div class="cl">${esc(to || '(Tiada penerima)')}</div>
    ${first ? `<div class="eq">${esc(first)}</div>` : ''}
    <div class="mt">${esc(mt)}</div></a>`;
}

/* ---------------- Cipta / Edit ---------------- */
function blankQuote(extra = {}) {
  const now = new Date().toISOString();
  return {
    id: uuid(), quoteNo: '', quoteDate: today(), addr: '', intro: Q_INTRO,
    items: [{ desc: '', qty: '1', unit: 'unit', price: '' }], showTotal: false, notes: '', valid: Q_VALID, stamp: true,
    reportId: '', reportNo: '', createdBy: S.engineer || '', createdAt: now, updatedAt: now, serverUpdatedAt: '', status: 'draft', ...extra
  };
}
async function newQuote(extra) {
  const q = blankQuote(extra); await DB.qput(q);
  location.replace('#/qedit/' + encodeURIComponent(q.id));
}
/** Dari service report: alamat client + item equipment. */
function quoteFromReport(r) {
  const addr = [r.client, r.location, r.location2].map(v => String(v || '').trim()).filter(Boolean).join('\n');
  const desc = [r.equipment, r.model ? '(' + r.model + ')' : '', r.serial ? 'sn: ' + r.serial : ''].filter(Boolean).join(' ');
  return newQuote({ addr, items: [{ desc, qty: '1', unit: 'unit', price: '' }], reportId: r.id, reportNo: r.reportNo || '' });
}

function qQueueSave() {
  if (!qcur) return;
  qcur.updatedAt = new Date().toISOString();
  if (qcur.status === 'synced') qcur.status = 'pending';
  clearTimeout(qsaveT);
  qsaveT = setTimeout(() => { qsaveT = null; DB.qput(qcur).then(() => updatePill()); }, 400);
}
async function qFlushSave() {
  if (qsaveT) { clearTimeout(qsaveT); qsaveT = null; if (qcur) await DB.qput(qcur); }
}

async function renderQEdit(id) {
  const x = await DB.qget(id);
  if (!x) { location.replace('#/q'); return; }
  qcur = x;
  if (!Array.isArray(qcur.items) || !qcur.items.length) qcur.items = [{ desc: '', qty: '1', unit: 'unit', price: '' }];
  setTitle(x.quoteNo ? 'Edit ' + x.quoteNo : 'Quotation Baharu');
  const isDraft = x.status === 'draft';
  const f = (k, label, o = {}) => `<label class="f"><span>${label}</span><input data-qk="${k}" type="${o.type || 'text'}" value="${esc(qcur[k] || '')}" placeholder="${esc(o.ph || '')}" autocomplete="off"></label>`;
  const t = (k, label, rows, ph = '') => `<label class="f"><span>${label}</span><textarea data-qk="${k}" rows="${rows}" placeholder="${esc(ph)}">${esc(qcur[k] || '')}</textarea></label>`;
  $('#app').innerHTML = `
    <div class="noBox">
      <div><small>Reference</small><span class="no ${x.quoteNo ? '' : 'draft'}">${esc(x.quoteNo || 'Belum ada')}</span></div>
      <small style="text-align:right;max-width:55%">${x.quoteNo ? 'Nombor tetap untuk quotation ini' : 'Nombor QO dikeluarkan oleh server selepas dihantar'}</small>
    </div>
    ${x.reportNo ? `<div class="hint" style="margin:-4px 0 10px">Dibuat daripada service report <b>${esc(x.reportNo)}</b></div>` : ''}
    <div class="sec">
      <h2>RUJUKAN</h2>
      ${f('quoteDate', 'Tarikh', { type: 'date' })}
    </div>
    <div class="sec">
      <h2>PENERIMA</h2>
      ${t('addr', 'Nama &amp; alamat (satu baris satu)', 5)}
    </div>
    <div class="sec">
      <h2>ISI SURAT</h2>
      ${t('intro', 'Ayat pembuka', 3)}
    </div>
    <div class="sec">
      <h2>ITEM</h2>
      <div id="qitems"></div>
      <button class="add" id="qAdd" type="button">+ Tambah item</button>
      <label class="chkrow"><input type="checkbox" id="qShowTotal" ${qcur.showTotal ? 'checked' : ''}> Papar baris jumlah keseluruhan</label>
      <div class="qsum">Jumlah: <b id="qGrand">RM ${money(qTotal(qcur))}</b></div>
    </div>
    <div class="sec">
      <h2>TERMA</h2>
      ${t('notes', 'Nota / terma tambahan (pilihan)', 2, 'Contoh: Payment terms: 30 days from invoice date')}
      ${f('valid', 'Validity')}
    </div>
    <div class="sec">
      <h2>COP</h2>
      <label class="chkrow" style="margin-top:0"><input type="checkbox" id="qStamp" ${qcur.stamp !== false ? 'checked' : ''}> Sertakan cop syarikat dalam PDF</label>
      <div class="hint">Gambar dan saiz cop boleh ditukar dalam Tetapan.</div>
    </div>
    ${isDraft ? `<button class="btn d" id="qDel" style="width:100%;margin-bottom:12px">Padam draf ini</button>` : ''}
    <div class="bar"><div>
      ${isDraft ? `<button class="btn" id="qDraftBtn">Simpan Draf</button><button class="btn p" id="qSendBtn">Hantar &amp; Dapat No.</button>`
                : `<button class="btn p" id="qSendBtn">Simpan &amp; Kemas Kini</button>`}
    </div></div>`;
  renderQItems();
  $$('[data-qk]').forEach(el => el.addEventListener('input', () => { qcur[el.dataset.qk] = el.value; qQueueSave(); }));
  $$('#app textarea[data-qk]').forEach(autoGrow);
  $$('#app textarea[data-qk]').forEach(el => el.addEventListener('input', () => autoGrow(el)));
  $('#qShowTotal').onchange = e => { qcur.showTotal = e.target.checked; qQueueSave(); };
  $('#qStamp').onchange = e => { qcur.stamp = e.target.checked; qQueueSave(); };
  $('#qAdd').onclick = () => {
    qcur.items.push({ desc: '', qty: '1', unit: 'unit', price: '' });
    if (qcur.items.length > 1) { qcur.showTotal = true; $('#qShowTotal').checked = true; }
    renderQItems(); qQueueSave();
    const d = $$('#qitems textarea').pop(); d && d.focus();
  };
  if ($('#qDraftBtn')) $('#qDraftBtn').onclick = async () => { await qFlushSave(); toast('Draf disimpan dalam phone'); location.hash = '#/qview/' + encodeURIComponent(qcur.id); };
  $('#qSendBtn').onclick = submitQuote;
  if ($('#qDel')) $('#qDel').onclick = async () => {
    if (!confirm('Padam draf quotation ini?')) return;
    clearTimeout(qsaveT); qsaveT = null; await DB.qdel(qcur.id); qcur = null; toast('Draf dipadam'); location.replace('#/q');
  };
}

function renderQItems() {
  const box = $('#qitems');
  box.innerHTML = qcur.items.map((it, i) => `
    <div class="qitem">
      <div class="hd"><span>Item ${i + 1}</span><button type="button" class="qdel" data-qrm="${i}">Buang</button></div>
      <label class="f"><span>Description</span><textarea rows="2" data-qi="${i}" data-qf="desc">${esc(it.desc)}</textarea></label>
      <div class="qrow">
        <label class="f"><span>Qty</span><input data-qi="${i}" data-qf="qty" inputmode="decimal" value="${esc(it.qty)}"></label>
        <label class="f"><span>Unit</span><input data-qi="${i}" data-qf="unit" value="${esc(it.unit)}"></label>
        <label class="f"><span>Harga seunit (RM)</span><input data-qi="${i}" data-qf="price" inputmode="decimal" value="${esc(it.price)}"></label>
      </div>
      <div class="qline">Jumlah: RM <span data-ql="${i}">${money(qnum(it.price) * qnum(it.qty))}</span></div>
    </div>`).join('');
  $$('textarea', box).forEach(autoGrow);
  $$('[data-qi]', box).forEach(el => el.addEventListener('input', () => {
    const i = +el.dataset.qi, it = qcur.items[i]; it[el.dataset.qf] = el.value;
    if (el.tagName === 'TEXTAREA') autoGrow(el);
    $(`[data-ql="${i}"]`).textContent = money(qnum(it.price) * qnum(it.qty));
    $('#qGrand').textContent = 'RM ' + money(qTotal(qcur));
    qQueueSave();
  }));
  $$('[data-qrm]', box).forEach(b => b.onclick = () => {
    const i = +b.dataset.qrm;
    if (qcur.items.length > 1) qcur.items.splice(i, 1); else qcur.items[0] = { desc: '', qty: '1', unit: 'unit', price: '' };
    renderQItems(); $('#qGrand').textContent = 'RM ' + money(qTotal(qcur)); qQueueSave();
  });
}

async function submitQuote() {
  const miss = [];
  if (!qcur.quoteDate) miss.push('Tarikh');
  if (!String(qcur.addr || '').trim()) miss.push('Penerima');
  if (!qcur.items.some(it => String(it.desc || '').trim())) miss.push('Sekurang-kurangnya satu item');
  if (miss.length) { toast('Sila isi: ' + miss.join(', '), 3500); return; }
  qcur.items = qcur.items.filter(qHas);
  qcur.status = 'pending'; qcur.updatedAt = new Date().toISOString();
  if (!qcur.createdBy) qcur.createdBy = S.engineer || '';
  clearTimeout(qsaveT); qsaveT = null;
  await DB.qput(qcur);
  const id = qcur.id;
  const btn = $('#qSendBtn'); if (btn) { btn.disabled = true; btn.textContent = 'Menghantar…'; }
  if (!S.url) toast('Disimpan. Akan dihantar bila server ditetapkan.', 3500);
  else if (!navigator.onLine) toast('Offline. Quotation akan dihantar bila ada internet.', 3500);
  else await sync({ quiet: false });
  location.hash = '#/qview/' + encodeURIComponent(id);
}

/* ---------------- Paparan ---------------- */
async function renderQView(id) {
  const x = await DB.qget(id);
  if (!x) { location.replace('#/q'); return; }
  qcur = null;
  setTitle(x.quoteNo || (x.status === 'draft' ? 'Draf' : 'Menunggu nombor'));
  const [label, cls] = STATUS[x.status] || STATUS.draft;
  const canShare = isNative() || !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] }));
  const items = (x.items || []).filter(qHas);
  const rep = x.reportId ? await DB.get(x.reportId) : null;
  $('#app').innerHTML = `
    <div class="noBox">
      <div><small>Reference</small><span class="no ${x.quoteNo ? '' : 'draft'}">${esc(x.quoteNo || (x.status === 'draft' ? 'DRAF' : 'Menunggu'))}</span></div>
      <span class="badge ${cls}">${label}</span>
    </div>
    <div class="acts">
      ${canShare ? `<button class="btn p" id="qShare">Kongsi PDF</button>` : ''}
      ${isNative() ? '' : `<button class="btn ${canShare ? '' : 'p'}" id="qDl">Muat turun PDF</button>`}
      <button class="btn" id="qEdit">${x.status === 'draft' ? 'Sambung isi' : 'Edit'}</button>
      <button class="btn" id="qDup">Salin ke quotation baharu</button>
      ${x.status === 'pending' ? `<button class="btn" id="qSync" style="grid-column:1/-1">Hantar ke server sekarang</button>` : ''}
      ${rep ? `<a class="btn" href="#/view/${encodeURIComponent(rep.id)}" style="grid-column:1/-1">Lihat service report ${esc(rep.reportNo || '')}</a>` : ''}
    </div>
    ${x.status === 'draft' ? `<div class="banner">Draf ini belum dihantar. PDF draf akan bertanda <b>DRAF</b> pada Reference. Tekan <b>Sambung isi</b> kemudian <b>Hantar &amp; Dapat No.</b> untuk nombor QO.</div>` : ''}
    <div class="sec"><h2>RUJUKAN</h2><dl class="kv"><dt>Reference</dt><dd>${esc(x.quoteNo || '-')}</dd><dt>Tarikh</dt><dd>${esc(fmtDate(x.quoteDate))}</dd></dl></div>
    <div class="sec"><h2>PENERIMA</h2><div class="txt">${esc(x.addr || '-')}</div></div>
    <div class="sec"><h2>ITEM</h2>
      ${items.length ? items.map((it, i) => `<div class="qv"><div class="qvd"><b>${i + 1}.</b> ${esc(it.desc)}</div>
        <div class="qvm">${esc([it.qty, it.unit].filter(Boolean).join(' '))} × RM ${money(qnum(it.price))} = <b>RM ${money(qnum(it.price) * qnum(it.qty))}</b></div></div>`).join('') : '<div class="txt">-</div>'}
      <div class="qsum">Jumlah: <b>RM ${money(qTotal(x))}</b>${x.showTotal ? '' : ' <span class="hint">(tidak dipaparkan dalam PDF)</span>'}</div>
    </div>
    ${x.notes ? `<div class="sec"><h2>NOTA</h2><div class="txt">${esc(x.notes)}</div></div>` : ''}
    <div class="sec"><h2>VALIDITY</h2><div class="txt">${esc(x.valid || '-')}</div></div>
    <div class="meta">Dikemas kini ${esc(x.updatedAt ? fmtDT(new Date(x.updatedAt)) : '-')}${x.createdBy ? ' · Dibuat oleh ' + esc(x.createdBy) : ''}</div>`;
  if ($('#qShare')) $('#qShare').onclick = () => exportQuotePDF(x, true);
  if ($('#qDl')) $('#qDl').onclick = () => exportQuotePDF(x, false);
  $('#qEdit').onclick = () => { location.hash = '#/qedit/' + encodeURIComponent(x.id); };
  $('#qDup').onclick = () => newQuote({
    addr: x.addr, intro: x.intro, items: JSON.parse(JSON.stringify(x.items || [])), showTotal: x.showTotal,
    notes: x.notes, valid: x.valid, stamp: x.stamp, reportId: x.reportId, reportNo: x.reportNo
  });
  if ($('#qSync')) $('#qSync').onclick = () => sync();
}

/* ---------------- PDF (format asal) ---------------- */
async function makeQuotePDF(x) {
  const cfg = await quoteCfg();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const PT = 25.4 / 72;                       // 1pt dalam mm
  const FS = 11, LH = FS * 1.3 * PT;          // Times 11pt, line-height 1.3
  const L = 25, R = 185, W = R - L, TOP = 52, BOTTOM = 297 - 30;
  const ASC = LH * 0.76;                      // jarak dari atas baris ke garis dasar
  let y = TOP;

  const bg = () => { if (LETTERHEAD) doc.addImage(LETTERHEAD, 'JPEG', 0, 0, 210, 297, 'lh', 'FAST'); };
  const newPage = () => { doc.addPage(); bg(); y = TOP; };
  const font = (style = 'normal', size = FS) => { doc.setFont('times', style); doc.setFontSize(size); doc.setTextColor(0, 0, 0); };
  // Balut teks ikut perkataan (perkataan tidak dipecahkan), hormati baris baharu
  const wrap = (text, width) => {
    const out = [];
    clean(text).split('\n').forEach(para => {
      const words = para.split(/ +/); let line = '';
      words.forEach(w => {
        const t = line ? line + ' ' + w : w;
        if (line && doc.getTextWidth(t) > width) { out.push(line); line = w; } else line = t;
      });
      out.push(line);
    });
    return out;
  };
  const lines = (arr, x0, opts) => { arr.forEach((ln, i) => doc.text(ln, x0, y + ASC + i * LH, opts)); y += arr.length * LH; };
  const block = (arr, x0) => {                // teks panjang yang boleh bersambung ke muka surat baru
    arr.forEach(ln => { if (y + LH > BOTTOM) newPage(); doc.text(ln, x0, y + ASC); y += LH; });
  };

  bg();
  font();
  // Reference / Date
  doc.text('Reference', L, y + ASC); doc.text(': ' + clean(x.quoteNo || 'DRAF'), L + 27, y + ASC); y += LH;
  doc.text('Date', L, y + ASC);
  if (x.quoteDate) {
    const [yy, mm, dd] = x.quoteDate.split('-').map(Number);
    let cx = L + 27; const base = y + ASC;
    doc.text(': ' + dd, cx, base); cx += doc.getTextWidth(': ' + dd);
    font('normal', FS * 0.72); doc.text(qOrd(dd), cx, base - FS * 0.33 * PT); cx += doc.getTextWidth(qOrd(dd));
    font(); doc.text(' ' + Q_MONTHS[mm - 1] + ' ' + yy, cx, base);
  } else doc.text(':', L + 27, y + ASC);
  y += LH;

  // Alamat penerima
  y += 12;
  block(wrap(x.addr || '', W), L);

  // RE: QUOTATION
  y += 9; if (y + LH > BOTTOM) newPage();
  font('bold'); doc.text('RE: QUOTATION', L, y + ASC);
  doc.setLineWidth(0.25); doc.setDrawColor(0); doc.line(L, y + ASC + 0.6, L + doc.getTextWidth('RE: QUOTATION'), y + ASC + 0.6);
  y += LH + 5; font();

  if (String(x.intro || '').trim()) { block(wrap(x.intro, W), L); y += 4; }

  // Jadual (margin 3mm bertindih dengan margin bawah ayat pembuka / RE, seperti CSS asal)
  const cw = [13, 75, 16, 31, 31].map(v => v * W / 166);
  const cx = cw.reduce((a, w, i) => (a.push(i ? a[i - 1] + cw[i - 1] : L), a), []);
  const PX = 1.6, PY = 1;
  const drawRow = (cells, { head = false, bold = false, align = [], fill = null, span = null } = {}) => {
    font(bold || head ? 'bold' : 'normal');
    const cols = span ? span : cw.map((w, i) => ({ x: cx[i], w }));
    const wrapped = cells.map((c, i) => wrap(c, cols[i].w - 2 * PX));
    const h = Math.max(...wrapped.map(a => a.length)) * LH + 2 * PY;
    return { h, paint: () => {
      doc.setLineWidth(0.26); doc.setDrawColor(0);
      cols.forEach((c, i) => {
        if (fill) { doc.setFillColor(...fill); doc.rect(c.x, y, c.w, h, 'FD'); } else doc.rect(c.x, y, c.w, h);
        font(bold || head ? 'bold' : 'normal');
        const a = head ? 'center' : (align[i] || 'left');
        const tx = a === 'center' ? c.x + c.w / 2 : a === 'right' ? c.x + c.w - PX : c.x + PX;
        wrapped[i].forEach((ln, k) => doc.text(ln, tx, y + PY + ASC + k * LH, { align: a }));
      });
      y += h;
    } };
  };
  const header = () => drawRow(['ITEM', 'DESCRIPTIONS', 'QTY', 'UNIT PRICE (RM)', 'TOTAL PRICE (RM)'], { head: true, fill: [217, 217, 217] });
  let hd = header(); if (y + hd.h + LH * 2 > BOTTOM) newPage(); hd.paint();
  let grand = 0;
  (x.items || []).forEach((it, i) => {
    const price = qnum(it.price), q = qnum(it.qty), line = price * q; grand += line;
    const has = qHas(it);
    const row = drawRow([String(i + 1), it.desc || '', [it.qty, it.unit].filter(Boolean).join(' '), has ? money(price) : '', has ? money(line) : ''],
      { align: ['center', 'left', 'center', 'center', 'center'] });
    if (y + row.h > BOTTOM) { newPage(); header().paint(); }
    row.paint();
  });
  if (x.showTotal) {
    const span = [{ x: cx[0], w: cw[0] + cw[1] + cw[2] + cw[3] }, { x: cx[4], w: cw[4] }];
    const row = drawRow(['TOTAL (RM)', money(grand)], { bold: true, align: ['right', 'center'], span });
    if (y + row.h > BOTTOM) { newPage(); header().paint(); }
    row.paint();
  }
  font();

  if (String(x.notes || '').trim()) { y += 6; block(wrap(x.notes, W), L); }
  if (String(x.valid || '').trim()) {
    y += 7; const v = wrap(x.valid, W - 23);
    if (y + v.length * LH > BOTTOM) newPage();
    doc.text('Validity:', L, y + ASC); lines(v, L + 23);
  }

  // Tandatangan + cop (tidak dipecahkan antara muka surat)
  y += 12;
  const sh = x.stamp !== false && cfg.stamp ? cfg.stampH : 0;
  if (y + 2 * LH + Math.max(32, sh) > BOTTOM) newPage();
  doc.text('Yours faithfully', L, y + ASC); y += LH;
  font('bold'); doc.text('BIZ MEDIC SDN.BHD.', L, y + ASC); y += LH; font();
  if (sh) {
    try {
      const pr = doc.getImageProperties(cfg.stamp); const w = sh * pr.width / pr.height;
      doc.addImage(cfg.stamp, cfg.stamp.startsWith('data:image/png') ? 'PNG' : 'JPEG', L, y, w, sh, 'stamp', 'FAST');
    } catch (e) { /* abaikan cop rosak */ }
  }
  return doc;
}

async function exportQuotePDF(x, share) {
  try {
    toast('Menjana PDF…', 1200);
    const doc = await makeQuotePDF(x);
    const name = 'Quotation_' + (x.quoteNo || 'DRAF-' + x.id.slice(0, 6)).replace(/[^\w\-()]+/g, '_') + '.pdf';
    await deliverFile(name, doc.output('blob'), share);
  } catch (e) { console.error(e); toast('Gagal jana PDF: ' + e.message, 3500); }
}

/* ---------------- Tetapan cop ---------------- */
async function stampSettingsHTML() {
  const c = await quoteCfg();
  return `<div class="sec">
    <h2>COP QUOTATION</h2>
    <div class="stampbox">${c.stamp ? `<img src="${c.stamp}" alt="Cop" style="height:${Math.round(c.stampH * 2.4)}px">` : '<span class="hint">Tiada cop</span>'}</div>
    <label class="f"><span>Saiz cop: <b id="stHv">${c.stampH}</b> mm</span><input id="stH" type="range" min="15" max="60" step="1" value="${c.stampH}"></label>
    <div class="sigbtns">
      <label class="sbtn">Tukar gambar cop<input type="file" accept="image/*" id="stFile" hidden></label>
      ${c.custom ? '<button type="button" class="sbtn" id="stReset">Guna cop asal</button>' : ''}
    </div>
    <div class="hint">Gambar cop disimpan dalam phone ini sahaja. Guna gambar cop atas kertas putih atau PNG lutsinar.</div>
  </div>`;
}
function bindStampSettings() {
  const save = async patch => { const c = (await DB.getMeta('quoteCfg')) || {}; await DB.setMeta('quoteCfg', { ...c, ...patch }); };
  $('#stH').oninput = e => { $('#stHv').textContent = e.target.value; const im = $('.stampbox img'); if (im) im.style.height = Math.round(e.target.value * 2.4) + 'px'; };
  $('#stH').onchange = e => save({ stampH: +e.target.value });
  $('#stFile').onchange = async e => {
    const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const url = URL.createObjectURL(f); const img = new Image(); img.src = url; await img.decode(); URL.revokeObjectURL(url);
      const k = Math.min(1, 700 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      await save({ stamp: c.toDataURL('image/png') }); toast('Cop dikemas kini'); renderSettings();
    } catch (err) { toast('Gambar tidak dapat dibuka', 3000); }
  };
  if ($('#stReset')) $('#stReset').onclick = async () => { await save({ stamp: '' }); toast('Cop asal digunakan'); renderSettings(); };
}
