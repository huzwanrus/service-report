/**
 * JN Service Report - Backend Google Sheets
 * ------------------------------------------
 * Menyimpan semua service report dan quotation, dan mengeluarkan nombor berkongsi
 * untuk semua engineer: report JNA001 ... JNZ999, quotation QO2026/11/001 (ikut bulan).
 * Claim (Expense Claim Form) disimpan dalam tab Claims; gambar resit dalam folder Google Drive.
 *
 * Cara pasang (ringkas):
 *  1. Buka Google Sheet baharu > Extensions > Apps Script.
 *  2. Padam kod sedia ada, tampal SEMUA kod ini, Save.
 *  3. Tukar nilai TOKEN di bawah kepada kata laluan rahsia anda sendiri.
 *  4. Pilih fungsi "setup" di toolbar dan tekan Run (benarkan akses bila diminta).
 *  5. Deploy > New deployment > Web app
 *       Execute as: Me    |    Who has access: Anyone
 *     Salin URL web app (berakhir dengan /exec) dan masukkan dalam Tetapan app.
 */

const TOKEN = 'TUKAR-KATA-LALUAN-INI';   // mesti sama dengan "Token" dalam Tetapan app
const START_NO = 'JNA001';               // nombor pertama jika belum ada report

const SHEET_REPORTS = 'Reports';
const SHEET_CONFIG = 'Config';

const COLUMNS = [
  'id', 'reportNo', 'reportDate', 'workTypes', 'client', 'location', 'location2',
  'contact', 'po', 'equipment', 'model', 'serial', 'warranty', 'fault', 'action',
  'parts', 'engineer', 'attDate', 'customerName', 'customerSign', 'engineerSign',
  'createdBy', 'createdAt', 'updatedAt', 'serverUpdatedAt'
];

/* Quotation: nombor QOYYYY/MM/NNN, NNN bermula 001 setiap bulan */
const SHEET_QUOTES = 'Quotations';
const QCOLUMNS = [
  'id', 'quoteNo', 'quoteDate', 'addr', 'intro', 'items', 'showTotal', 'notes', 'valid', 'total',
  'stamp', 'reportId', 'reportNo', 'createdBy', 'createdAt', 'updatedAt', 'serverUpdatedAt'
];

/* Claim: borang Expense Claim, resit disimpan dalam folder Google Drive */
const SHEET_CLAIMS = 'Claims';
const RECEIPT_FOLDER = 'JN Service Report - Resit Claim';
const CCOLUMNS = [
  'id', 'owner', 'name', 'dept', 'claimDate', 'period', 'items', 'total', 'mileageRate',
  'createdBy', 'createdAt', 'updatedAt', 'serverUpdatedAt'
];

/* ---------- Setup ---------- */
function setup() {
  const ss = SpreadsheetApp.getActive();
  let rep = ss.getSheetByName(SHEET_REPORTS);
  if (!rep) rep = ss.insertSheet(SHEET_REPORTS);
  rep.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]).setFontWeight('bold');
  rep.setFrozenRows(1);

  let cfg = ss.getSheetByName(SHEET_CONFIG);
  if (!cfg) cfg = ss.insertSheet(SHEET_CONFIG);
  if (!cfg.getRange('A1').getValue()) {
    cfg.getRange('A1:B1').setValues([['Last Report No', '']]);
    cfg.getRange('A2:B2').setValues([['Nota', 'Kosongkan B1 untuk mula dari ' + START_NO +
      '. Isi B1 dengan nombor terakhir (cth. JNA120) untuk sambung dari situ.']]);
    cfg.getRange('A1:A2').setFontWeight('bold');
  }
  quoteSheet_();
  claimSheet_();
  receiptFolder_();
  const def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 2 && def.getLastRow() === 0) ss.deleteSheet(def);
}

/* ---------- Report number ---------- */
function formatNo_(letterIdx, num) {
  return 'JN' + String.fromCharCode(65 + letterIdx) + ('00' + num).slice(-3);
}

function parseNo_(no) {
  const m = /^JN([A-Z])(\d{3})$/.exec(String(no || '').trim().toUpperCase());
  return m ? { letter: m[1].charCodeAt(0) - 65, num: parseInt(m[2], 10) } : null;
}

/** Nombor seterusnya selepas `last`. Selepas JNA999 -> JNB001. */
function nextAfter_(last) {
  const p = parseNo_(last);
  if (!p) return START_NO;
  let letter = p.letter, num = p.num + 1;
  if (num > 999) { num = 1; letter++; }
  if (letter > 25) throw new Error('Nombor report sudah mencapai JNZ999');
  return formatNo_(letter, num);
}

function issueNo_() {
  const cfg = SpreadsheetApp.getActive().getSheetByName(SHEET_CONFIG);
  const last = String(cfg.getRange('B1').getValue() || '').trim();
  const next = last ? nextAfter_(last) : START_NO;
  cfg.getRange('B1').setValue(next);
  return next;
}

/* ---------- Web API ---------- */
function doGet() {
  return json_({ ok: true, app: 'JN Service Report', time: new Date().toISOString() });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'Bad request' }); }
  if (req.token !== TOKEN) return json_({ ok: false, error: 'Token salah' });

  try {
    if (req.action === 'ping') return json_({ ok: true });
    if (req.action === 'submit') return json_(submit_(req.report));
    if (req.action === 'list') return json_(list_(req.since));
    if (req.action === 'qsubmit') return json_(qsubmit_(req.quote));
    if (req.action === 'qlist') return json_(qlist_(req.since));
    if (req.action === 'csubmit') return json_(csubmit_(req.claim));
    if (req.action === 'clist') return json_(clist_(req.since, req.owner));
    if (req.action === 'upload') return json_(upload_(req.file));
    if (req.action === 'getfile') return json_(getfile_(req.driveId));
    return json_({ ok: false, error: 'Action tidak dikenali' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function submit_(r) {
  if (!r || !r.id) return { ok: false, error: 'Report tiada id' };
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_REPORTS);
    const last = sh.getLastRow();
    let rowIdx = -1, existing = null;
    if (last > 1) {
      const ids = sh.getRange(2, 1, last - 1, 1).getValues();
      for (let i = 0; i < ids.length; i++) if (ids[i][0] === r.id) { rowIdx = i + 2; break; }
      if (rowIdx > 0) existing = sh.getRange(rowIdx, 1, 1, COLUMNS.length).getValues()[0];
    }
    // Nombor report hanya dikeluarkan oleh server, sekali sahaja bagi setiap report.
    const reportNo = existing && existing[1] ? existing[1] : issueNo_();
    const now = new Date().toISOString();
    const row = COLUMNS.map(function (c) {
      if (c === 'reportNo') return reportNo;
      if (c === 'serverUpdatedAt') return now;
      if (c === 'createdAt' && existing) return existing[COLUMNS.indexOf('createdAt')];
      const v = r[c];
      if (v === undefined || v === null) return '';
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v).slice(0, 49000);
    });
    const target = sh.getRange(rowIdx > 0 ? rowIdx : last + 1, 1, 1, COLUMNS.length);
    target.setNumberFormat('@');   // simpan sebagai teks supaya Sheets tidak tukar tarikh/nombor
    target.setValues([row]);
    return { ok: true, reportNo: reportNo, serverUpdatedAt: now };
  } finally {
    lock.releaseLock();
  }
}

function list_(since) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_REPORTS);
  const last = sh.getLastRow();
  if (last < 2) return { ok: true, reports: [] };
  const vals = sh.getRange(2, 1, last - 1, COLUMNS.length).getDisplayValues();
  const out = [];
  vals.forEach(function (row) {
    const o = {};
    COLUMNS.forEach(function (c, i) { o[c] = row[i]; });
    if (since && o.serverUpdatedAt && o.serverUpdatedAt <= since) return;
    ['workTypes', 'parts'].forEach(function (k) {
      try { o[k] = o[k] ? JSON.parse(o[k]) : []; } catch (e) { o[k] = []; }
    });
    out.push(o);
  });
  return { ok: true, reports: out };
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- Quotation ---------- */
function quoteSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_QUOTES);
  if (!sh) {
    sh = ss.insertSheet(SHEET_QUOTES);
    sh.getRange(1, 1, 1, QCOLUMNS.length).setValues([QCOLUMNS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Nombor seterusnya untuk bulan tarikh quotation: QO2026/11/001, QO2026/11/002 ... */
function issueQuoteNo_(sh, quoteDate) {
  const m = /^(\d{4})-(\d{2})/.exec(String(quoteDate || ''));
  const ym = m ? m[1] + '/' + m[2]
               : Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Kuala_Lumpur', 'yyyy/MM');
  const prefix = 'QO' + ym + '/';
  let max = 0;
  const last = sh.getLastRow();
  if (last > 1) {
    sh.getRange(2, 2, last - 1, 1).getDisplayValues().forEach(function (row) {
      const v = String(row[0] || '');
      if (v.indexOf(prefix) === 0) {
        const n = parseInt(v.slice(prefix.length), 10);
        if (n > max) max = n;
      }
    });
  }
  const n = max + 1;
  return prefix + (n < 1000 ? ('00' + n).slice(-3) : String(n));
}

function qsubmit_(q) {
  if (!q || !q.id) return { ok: false, error: 'Quotation tiada id' };
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = quoteSheet_();
    const last = sh.getLastRow();
    let rowIdx = -1, existing = null;
    if (last > 1) {
      const ids = sh.getRange(2, 1, last - 1, 1).getValues();
      for (let i = 0; i < ids.length; i++) if (ids[i][0] === q.id) { rowIdx = i + 2; break; }
      if (rowIdx > 0) existing = sh.getRange(rowIdx, 1, 1, QCOLUMNS.length).getValues()[0];
    }
    const quoteNo = existing && existing[1] ? existing[1] : issueQuoteNo_(sh, q.quoteDate);
    const now = new Date().toISOString();
    const row = QCOLUMNS.map(function (c) {
      if (c === 'quoteNo') return quoteNo;
      if (c === 'serverUpdatedAt') return now;
      if (c === 'createdAt' && existing) return existing[QCOLUMNS.indexOf('createdAt')];
      const v = q[c];
      if (v === undefined || v === null) return '';
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v).slice(0, 49000);
    });
    const target = sh.getRange(rowIdx > 0 ? rowIdx : last + 1, 1, 1, QCOLUMNS.length);
    target.setNumberFormat('@');
    target.setValues([row]);
    return { ok: true, quoteNo: quoteNo, serverUpdatedAt: now };
  } finally {
    lock.releaseLock();
  }
}

function qlist_(since) {
  const sh = quoteSheet_();
  const last = sh.getLastRow();
  if (last < 2) return { ok: true, quotes: [] };
  const vals = sh.getRange(2, 1, last - 1, QCOLUMNS.length).getDisplayValues();
  const out = [];
  vals.forEach(function (row) {
    const o = {};
    QCOLUMNS.forEach(function (c, i) { o[c] = row[i]; });
    if (!o.id) return;
    if (since && o.serverUpdatedAt && o.serverUpdatedAt <= since) return;
    try { o.items = o.items ? JSON.parse(o.items) : []; } catch (e) { o.items = []; }
    o.showTotal = String(o.showTotal).toLowerCase() === 'true';
    o.stamp = String(o.stamp).toLowerCase() !== 'false';
    out.push(o);
  });
  return { ok: true, quotes: out };
}


/* ---------- Claim ---------- */
function claimSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_CLAIMS);
  if (!sh) {
    sh = ss.insertSheet(SHEET_CLAIMS);
    sh.getRange(1, 1, 1, CCOLUMNS.length).setValues([CCOLUMNS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function normOwner_(s) { return String(s || '').trim().toLowerCase(); }

function csubmit_(c) {
  if (!c || !c.id) return { ok: false, error: 'Claim tiada id' };
  if (!normOwner_(c.owner)) return { ok: false, error: 'Claim tiada nama pemilik (isi Nama engineer dalam Tetapan)' };
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = claimSheet_();
    const last = sh.getLastRow();
    let rowIdx = -1, existing = null;
    if (last > 1) {
      const ids = sh.getRange(2, 1, last - 1, 1).getValues();
      for (let i = 0; i < ids.length; i++) if (ids[i][0] === c.id) { rowIdx = i + 2; break; }
      if (rowIdx > 0) existing = sh.getRange(rowIdx, 1, 1, CCOLUMNS.length).getValues()[0];
    }
    // claim hanya boleh dikemas kini oleh pemilik asal
    if (existing && normOwner_(existing[1]) !== normOwner_(c.owner)) return { ok: false, error: 'Claim ini milik engineer lain' };
    const now = new Date().toISOString();
    const row = CCOLUMNS.map(function (k) {
      if (k === 'serverUpdatedAt') return now;
      if (k === 'createdAt' && existing) return existing[CCOLUMNS.indexOf('createdAt')];
      const v = c[k];
      if (v === undefined || v === null) return '';
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v).slice(0, 49000);
    });
    const target = sh.getRange(rowIdx > 0 ? rowIdx : last + 1, 1, 1, CCOLUMNS.length);
    target.setNumberFormat('@');
    target.setValues([row]);
    return { ok: true, serverUpdatedAt: now };
  } finally {
    lock.releaseLock();
  }
}

/** Hanya claim milik `owner` dipulangkan. */
function clist_(since, owner) {
  const me = normOwner_(owner);
  if (!me) return { ok: true, claims: [] };
  const sh = claimSheet_();
  const last = sh.getLastRow();
  if (last < 2) return { ok: true, claims: [] };
  const vals = sh.getRange(2, 1, last - 1, CCOLUMNS.length).getDisplayValues();
  const out = [];
  vals.forEach(function (row) {
    const o = {};
    CCOLUMNS.forEach(function (k, i) { o[k] = row[i]; });
    if (!o.id || normOwner_(o.owner) !== me) return;
    if (since && o.serverUpdatedAt && o.serverUpdatedAt <= since) return;
    try { o.items = o.items ? JSON.parse(o.items) : []; } catch (e) { o.items = []; }
    out.push(o);
  });
  return { ok: true, claims: out };
}

function receiptFolder_() {
  const it = DriveApp.getFoldersByName(RECEIPT_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(RECEIPT_FOLDER);
}

/** Simpan gambar resit (base64) dalam folder Drive. */
function upload_(f) {
  if (!f || !f.data || !f.name) return { ok: false, error: 'Fail tiada data' };
  const mime = /^image\/(jpeg|png|webp)$/.test(f.mime || '') ? f.mime : 'image/jpeg';
  const folder = receiptFolder_();
  const name = String(f.name).replace(/[^\w.\-]+/g, '_').slice(0, 120);
  const ex = folder.getFilesByName(name);
  if (ex.hasNext()) return { ok: true, driveId: ex.next().getId() };   // sudah dimuat naik sebelum ini
  const blob = Utilities.newBlob(Utilities.base64Decode(f.data), mime, name);
  return { ok: true, driveId: folder.createFile(blob).getId() };
}

/** Ambil semula gambar resit. Hanya fail dalam folder resit dibenarkan. */
function getfile_(driveId) {
  let file;
  try { file = DriveApp.getFileById(String(driveId || '')); } catch (e) { return { ok: false, error: 'Fail tidak dijumpai' }; }
  const folderId = receiptFolder_().getId();
  let inFolder = false;
  const parents = file.getParents();
  while (parents.hasNext()) if (parents.next().getId() === folderId) { inFolder = true; break; }
  if (!inFolder) return { ok: false, error: 'Akses ditolak' };
  const blob = file.getBlob();
  return { ok: true, mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}
