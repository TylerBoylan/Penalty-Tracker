/* Stacked ⇄ Google Sheets sync.
   Talks only to Google: accounts.google.com (sign-in) and sheets.googleapis.com (your spreadsheet).
   The spreadsheet ID and a cached copy of your data live in this browser's localStorage only.
   The access token lives in sessionStorage and expires after about an hour. */
'use strict';
const GS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const GS_API = 'https://sheets.googleapis.com/v4/spreadsheets/';
const GS_GIS = 'https://accounts.google.com/gsi/client';
const K_MODE = 'stacked_mode', K_SID = 'stacked_sheet_id', K_CACHE = 'stacked_sheet_cache', K_TOK = 'stacked_tok', K_CONSENT = 'stacked_consented';
const str = v => v == null ? '' : String(v).trim();
const lc = v => str(v).toLowerCase();
const TABS = {
  Transactions: { cols: ['id', 'date', 'type', 'category', 'amount', 'note', 'card', 'source', 'created_at'], key: r => str(r[0]) },
  Categories: { cols: ['id', 'name', 'color', 'is_savings', 'sort'], key: r => str(r[0]) },
  Budgets: { cols: ['month', 'category', 'amount'], key: r => str(r[0]) + '|' + lc(r[1]) },
  Income: { cols: ['month', 'line', 'planned', 'actual', 'pay_date', 'hourly', 'hours'], key: r => str(r[0]) + '|' + lc(r[1]) },
  Bills: { cols: ['id', 'name', 'amount', 'day', 'category', 'active', 'start_month', 'last_added_month'], key: r => str(r[0]) },
  Settings: { cols: ['key', 'value'], key: r => lc(r[0]) }
};
const TAB_ORDER = Object.keys(TABS);
const colL = n => String.fromCharCode(64 + n);
const truthy = v => v === true || /^(true|yes|y|1|x)$/i.test(str(v));
const numOr = (v, d = 0) => { const n = typeof v === 'number' ? v : parseAmt(str(v)); return isFinite(n) ? n : d; };
const hashStr = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); };
const normMonth = v => { const s = str(v); let m = s.match(/^(\d{4})-(\d{1,2})$/); if (m) return m[1] + '-' + pad(+m[2]); const d = parseDateAny(s); return d ? d.slice(0, 7) : ''; };
const nowISO = () => new Date().toISOString();
const sheetIdFrom = v => { const s = str(v); const m = s.match(/\/d\/([A-Za-z0-9_-]{20,})/); if (m) return m[1]; return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : ''; };

/* ---------- remembering the sheet (localStorage + IndexedDB + cookie) ----------
   iOS can wipe one store, and a Home Screen app doesn't share storage with Safari, so the sheet ID
   (never in the public files) is kept in three places on this device and recovered from any of them. */
const cacheKey = id => K_CACHE + ':' + id;
const ckPath = () => location.pathname.replace(/[^/]*$/, '') || '/';
function cookieGet() { try { const m = document.cookie.match(/(?:^|;\s*)stacked_sid=([A-Za-z0-9_-]{20,})/); return m ? m[1] : ''; } catch (e) { return ''; } }
function cookieSet(id) { try { document.cookie = `stacked_sid=${id || ''}; path=${ckPath()}; max-age=${id ? 34560000 : 0}; SameSite=Strict${location.protocol === 'https:' ? '; Secure' : ''}`; } catch (e) { } }
let idbP = null;
function idb() {
  if (!idbP) idbP = new Promise((res, rej) => {
    try { const r = indexedDB.open('stacked', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); }
  });
  return idbP;
}
async function idbGet(k) { const db = await idb(); return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
async function idbSet(k, v) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); if (v === undefined) tx.objectStore('kv').delete(k); else tx.objectStore('kv').put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); }
const idbSafe = (k, v) => idbSet(k, v).catch(() => { });
function lsCacheIds() { const out = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(K_CACHE + ':')) { const c = JSON.parse(localStorage.getItem(k) || 'null'); out.push({ id: k.slice(K_CACHE.length + 1), at: (c && c.savedAt) || 0 }); } } } catch (e) { } return out.sort((a, b) => b.at - a.at).map(x => x.id); }

const SY = { mode: 'local', sheetId: '', base: null, status: 'idle', msg: '', lastSync: 0, syncing: false, again: false, token: '', exp: 0, tabIds: null, timer: 0, title: '' };
(() => {
  try {
    // one-time move of the old single cache to a per-sheet key, so switching sheets never drops queued changes
    const old = localStorage.getItem(K_CACHE);
    if (old) { const c = JSON.parse(old); if (c && c.sheetId && !localStorage.getItem(cacheKey(c.sheetId))) localStorage.setItem(cacheKey(c.sheetId), old); localStorage.removeItem(K_CACHE); }
  } catch (e) { }
  try {
    SY.sheetId = localStorage.getItem(K_SID) || '';
    if (!SY.sheetId) { SY.sheetId = cookieGet() || lsCacheIds()[0] || ''; if (SY.sheetId) { SY.recovered = 'device'; localStorage.setItem(K_SID, SY.sheetId); } }
    const md = localStorage.getItem(K_MODE);
    SY.mode = SY.sheetId && (md === 'sheet' || (!md && SY.recovered)) ? 'sheet' : 'local';
    const t = JSON.parse(sessionStorage.getItem(K_TOK) || 'null'); if (t && t.exp > Date.now()) { SY.token = t.token; SY.exp = t.exp; }
  } catch (e) { /* storage blocked */ }
})();
const hasToken = () => !!SY.token && Date.now() < SY.exp - 60000;
function clearToken() { SY.token = ''; SY.exp = 0; try { sessionStorage.removeItem(K_TOK); } catch (e) { } }
function withS(st, fn) { const old = S; S = st; try { return fn(); } finally { S = old; } }

/* ---------- sign-in (Google Identity Services token client) ---------- */
let gisP = null, tokClient = null, tokWait = [];
const clientId = () => str(window.STACKED_CONFIG && window.STACKED_CONFIG.CLIENT_ID);
const clientReady = () => !!clientId() && clientId() !== 'REPLACE_ME';
const gisLoaded = () => !!(window.google && google.accounts && google.accounts.oauth2);
function loadGis() {
  if (gisLoaded()) return Promise.resolve();
  if (!clientReady()) return Promise.reject(new Error('Google sign-in is not set up yet (no OAuth client ID in config.js).'));
  if (!gisP) gisP = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = GS_GIS; s.async = true;
    s.onload = () => res(); s.onerror = () => { gisP = null; rej(new Error('Could not reach Google sign-in. Are you offline?')); };
    document.head.appendChild(s);
  });
  return gisP;
}
function finishWait(err, val) { const w = tokWait; tokWait = []; w.forEach(x => err ? x.rej(err) : x.res(val)); }
function signIn(forceConsent) {
  // Must run synchronously inside a tap so the Google popup isn't blocked: preload GIS first (loadGis()).
  return new Promise((res, rej) => {
    if (!clientReady()) return rej(new Error('Google sign-in is not set up yet: add your OAuth client ID to config.js.'));
    const go = () => {
      if (!tokClient) tokClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId(), scope: GS_SCOPE,
        callback: r => {
          if (!r || r.error) return finishWait(new Error('Google sign-in was cancelled or failed' + (r && r.error ? ' (' + r.error + ')' : '')));
          if (!google.accounts.oauth2.hasGrantedAllScopes(r, GS_SCOPE)) return finishWait(new Error('Stacked needs permission to edit your spreadsheet. Tick the box on Google\'s screen.'));
          SY.token = r.access_token; SY.exp = Date.now() + (+r.expires_in || 3599) * 1000;
          try { sessionStorage.setItem(K_TOK, JSON.stringify({ token: SY.token, exp: SY.exp })); localStorage.setItem(K_CONSENT, '1'); } catch (e) { }
          finishWait(null, SY.token);
        },
        error_callback: e => finishWait(new Error(e && e.type === 'popup_failed_to_open' ? 'The Google sign-in popup was blocked. Allow popups and try again.' : 'Google sign-in was closed before finishing.'))
      });
      tokWait.push({ res, rej });
      let consented = false; try { consented = !!localStorage.getItem(K_CONSENT); } catch (e) { }
      tokClient.requestAccessToken({ prompt: forceConsent || !consented ? 'consent' : '' });
    };
    if (gisLoaded()) go(); else loadGis().then(go, rej);
  });
}
function signOut() {
  const t = SY.token; clearToken();
  try { if (t && gisLoaded()) google.accounts.oauth2.revoke(t, () => { }); } catch (e) { }
  setStatus('signin');
}

/* ---------- Sheets REST ---------- */
async function gapi(path, opt = {}) {
  if (!hasToken()) throw Object.assign(new Error('Sign in with Google to sync.'), { auth: true });
  let r;
  try {
    r = await fetch(opt.url || GS_API + path, { method: opt.method || 'GET', headers: Object.assign({ Authorization: 'Bearer ' + SY.token }, opt.body ? { 'Content-Type': 'application/json' } : {}), body: opt.body ? JSON.stringify(opt.body) : undefined, cache: 'no-store' });
  } catch (e) { throw Object.assign(new Error('Offline. Changes are saved on this device and will sync later.'), { offline: true }); }
  if (r.status === 401) { clearToken(); throw Object.assign(new Error('Google sign-in expired. Tap to sign in again.'), { auth: true }); }
  if (!r.ok) {
    let m = ''; try { m = (await r.json()).error.message; } catch (e) { }
    throw Object.assign(new Error(r.status === 404 ? 'Spreadsheet not found. Check the sheet ID in Settings.' : r.status === 403 ? 'This Google account can\'t edit that spreadsheet (or the Sheets API isn\'t enabled).' : r.status === 429 ? 'Google is rate-limiting requests. Will retry shortly.' : 'Google Sheets error ' + r.status + (m ? ': ' + m : '')), { status: r.status });
  }
  return r.json();
}
const sidPath = () => encodeURIComponent(SY.sheetId);
async function ensureTabs() {
  const j = await gapi(sidPath() + '?fields=properties.title,sheets.properties(sheetId,title)');
  const title = j.properties && j.properties.title || '', ids = {};
  (j.sheets || []).forEach(s => ids[s.properties.title] = s.properties.sheetId);
  // Never set up Stacked tabs inside some other spreadsheet (e.g. an old budget workbook pasted by mistake).
  if (ids.Transactions == null) throw Object.assign(new Error(`"${title || 'That spreadsheet'}" isn't a Stacked sheet (it has no Transactions tab). Check the link in Settings.`), { notStacked: true });
  SY.title = title; SY.tabIds = ids;
  const missing = TAB_ORDER.filter(t => SY.tabIds[t] == null);
  if (missing.length) {
    const r = await gapi(sidPath() + ':batchUpdate', { method: 'POST', body: { requests: missing.map(t => ({ addSheet: { properties: { title: t, gridProperties: { frozenRowCount: 1 } } } })) } });
    r.replies.forEach((x, i) => SY.tabIds[missing[i]] = x.addSheet.properties.sheetId);
    await gapi(sidPath() + '/values:batchUpdate', { method: 'POST', body: { valueInputOption: 'RAW', data: missing.map(t => ({ range: t + '!A1', values: [TABS[t].cols] })) } });
  }
}
async function fetchAll() {
  if (!SY.tabIds) await ensureTabs();
  const q = TAB_ORDER.map(t => 'ranges=' + encodeURIComponent(t + '!A2:' + colL(TABS[t].cols.length))).join('&');
  const j = await gapi(sidPath() + '/values:batchGet?' + q + '&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING');
  const out = {}; TAB_ORDER.forEach((t, i) => out[t] = (j.valueRanges && j.valueRanges[i] && j.valueRanges[i].values) || []);
  return out;
}

/* ---------- model <-> rows ---------- */
const SRC_OUT = { manual: 'app', auto: 'bill' };
function txCatName(t) {
  if (t.type === 'inc') return t.cat === OTHER_INC ? 'Other income' : incLineName(t);
  return t.cat === UNCAT && t.rawCat ? t.rawCat : catById(t.cat).name;
}
function toRows(st) {
  return withS(st, () => {
    const R = {}; TAB_ORDER.forEach(t => R[t] = {});
    const put = (tab, row) => { R[tab][TABS[tab].key(row)] = row; };
    const byInc = {};
    st.txns.forEach(t => {
      const cn = txCatName(t);
      put('Transactions', [t.id, t.date, t.type === 'inc' ? 'income' : 'expense', cn, r2(t.amt), t.note || '', t.card || '', SRC_OUT[t.src] || t.src || 'app', t.created || '']);
      if (t.type === 'inc') { const k = t.date.slice(0, 7) + '|' + lc(cn); byInc[k] = r2((byInc[k] || 0) + t.amt); }
    });
    st.cats.forEach((c, i) => put('Categories', [c.id, c.name, c.color, !!c.save, i + 1]));
    Object.keys(st.months).sort().forEach(mk => {
      const m = st.months[mk];
      st.cats.forEach(c => { if (m.budgets[c.id] != null) put('Budgets', [mk, c.name, r2(+m.budgets[c.id] || 0)]); });
      m.income.forEach(l => put('Income', [mk, l.name, r2(+l.planned || 0), byInc[mk + '|' + lc(l.name)] || 0, l.payDate || '', !!l.hourly, +l.hours || 0]));
    });
    st.recurring.forEach(r => put('Bills', [r.id, r.name, r2(r.amt), +r.day || 1, catById(r.cat).name, !!r.active, r.start || '', r.last || '']));
    put('Settings', ['hourly_rate', r2(st.settings.rate)]);
    return R;
  });
}
function txSig(date, type, amt, note) { return date + '|' + type + '|' + cents(Math.abs(amt)) + '|' + normV(note); }
function parseSheet(raw) {
  const st = blank(); st.cats = []; st.months = {}; st.txns = []; st.recurring = []; st.demo = false;
  const catRows = (raw.Categories || []).map((r, i) => ({ r, i, s: numOr(r[4], 1e6 + i) })).filter(x => str(x.r[1])).sort((a, b) => a.s - b.s || a.i - b.i);
  catRows.forEach(({ r }, i) => {
    const name = str(r[1]), id = str(r[0]) || 'c-' + hashStr(lc(name));
    if (st.cats.some(c => c.id === id || lc(c.name) === lc(name))) return;
    st.cats.push({ id, name, color: /^#[0-9a-f]{6}$/i.test(str(r[2])) ? str(r[2]) : PALETTE[i % PALETTE.length], save: truthy(r[3]) });
  });
  if (!st.cats.find(c => c.id === UNCAT)) { const u = st.cats.find(c => lc(c.name) === 'uncategorized'); if (u) u.id = UNCAT; else st.cats.push({ ...DEFAULT_CATS.find(c => c.id === UNCAT) }); }
  const catByName = n => st.cats.find(c => lc(c.name) === lc(n));
  (raw.Settings || []).forEach(r => { if (lc(r[0]) === 'hourly_rate' && numOr(r[1]) > 0) st.settings.rate = r2(numOr(r[1])); });
  const mo = mk => st.months[mk] || (st.months[mk] = { budgets: {}, income: [], recurDone: {} });
  (raw.Budgets || []).forEach(r => { const mk = normMonth(r[0]), c = catByName(r[1]); if (!mk || !c) return; const m = mo(mk); if (m.budgets[c.id] == null) m.budgets[c.id] = r2(numOr(r[2])); });
  const sheetActual = {};
  (raw.Income || []).forEach(r => {
    const mk = normMonth(r[0]), name = str(r[1]); if (!mk || !name) return;
    const m = mo(mk); if (m.income.some(l => lc(l.name) === lc(name))) return;
    m.income.push({ id: name, name, planned: r2(numOr(r[2])), payDate: parseDateAny(r[4]) || '', hourly: truthy(r[5]), hours: numOr(r[6]) });
    sheetActual[mk + '|' + lc(name)] = r2(numOr(r[3]));
  });
  (raw.Bills || []).forEach(r => {
    const name = str(r[1]), amt = numOr(r[2], NaN); if (!name || !isFinite(amt)) return;
    const id = str(r[0]) || 'b-' + hashStr(lc(name)); if (st.recurring.some(x => x.id === id)) return;
    const c = catByName(r[4]);
    st.recurring.push({ id, name, amt: r2(amt), day: Math.min(31, Math.max(1, parseInt(r[3]) || 1)), cat: c ? c.id : UNCAT, active: str(r[5]) === '' ? true : truthy(r[5]), start: normMonth(r[6]) || curMK(), last: normMonth(r[7]) });
  });
  const seen = new Set(), occ = {}, blanks = {};
  (raw.Transactions || []).forEach(r => {
    const date = parseDateAny(r[1]), a = numOr(r[4], NaN); if (!date || !isFinite(a) || a === 0) return;
    const type = /^inc/i.test(str(r[2])) ? 'inc' : 'exp', name = str(r[3]);
    let cat, rawCat;
    if (type === 'exp') { const c = catByName(name); cat = c ? c.id : UNCAT; if (!c && name) rawCat = name; }
    else if (!name || lc(name) === 'other income') cat = OTHER_INC;
    else { const l = (st.months[date.slice(0, 7)] || { income: [] }).income.find(x => lc(x.name) === lc(name)); cat = l ? l.name : name; }
    let id = str(r[0]);
    if (!id) { const sig = txSig(date, type, a, r[5]); occ[sig] = (occ[sig] || 0) + 1; id = 'r-' + hashStr(sig + '#' + occ[sig]); blanks[id] = 1; }
    if (seen.has(id)) return; seen.add(id);
    const t = { id, date, type, amt: r2(type === 'inc' ? Math.abs(a) : a), cat, note: str(r[5]), card: str(r[6]).replace(/\D/g, '').slice(-4), src: lc(r[7]) || 'sheet', created: str(r[8]) };
    t.ts = Date.parse(t.created) || 0; if (rawCat) t.rawCat = rawCat;
    st.txns.push(t);
  });
  const base = toRows(st);
  Object.keys(blanks).forEach(id => { const row = base.Transactions[id]; if (row) row[0] = ''; });
  Object.entries(sheetActual).forEach(([k, v]) => { if (base.Income[k]) base.Income[k][3] = v; });
  return { S: st, base };
}
const rowStr = r => JSON.stringify(r.map(v => typeof v === 'number' ? r2(v) : typeof v === 'boolean' ? v : str(v)));
function diffRows(base, cur) {
  const ops = [];
  TAB_ORDER.forEach(tab => {
    const b = base[tab] || {}, c = cur[tab] || {};
    for (const k of Object.keys(c)) if (!b[k] || rowStr(b[k]) !== rowStr(c[k])) ops.push({ tab, key: k, row: c[k], old: b[k] || null });
    for (const k of Object.keys(b)) if (!c[k]) ops.push({ tab, key: k, row: null, old: b[k] });
  });
  return ops;
}
function rowsToRaw(R) { const o = {}; TAB_ORDER.forEach(t => o[t] = Object.values(R[t] || {})); return o; }
async function commit(ops, fresh) {
  const idx = {}, blanks = [];
  TAB_ORDER.forEach(tab => { idx[tab] = {}; (fresh[tab] || []).forEach((r, i) => { const k = TABS[tab].key(r); if (k && k !== '|' && idx[tab][k] == null) idx[tab][k] = i + 2; }); });
  (fresh.Transactions || []).forEach((r, i) => {
    if (str(r[0])) return; const d = parseDateAny(r[1]), a = numOr(r[4], NaN);
    if (d && isFinite(a)) blanks.push({ row: i + 2, sig: txSig(d, /^inc/i.test(str(r[2])) ? 'inc' : 'exp', a, r[5]), used: false });
  });
  const updates = [], appends = {}, dels = [];
  for (const op of ops) {
    let n = idx[op.tab][op.key];
    if (n == null && op.tab === 'Transactions') { // a row someone appended without an id
      const ref = op.row || op.old; const sig = ref && txSig(ref[1], ref[2] === 'income' ? 'inc' : 'exp', ref[4], ref[5]);
      const b = blanks.find(x => !x.used && x.sig === sig); if (b) { b.used = true; n = b.row; }
    }
    const w = colL(TABS[op.tab].cols.length);
    if (op.row) { if (n) updates.push({ range: `${op.tab}!A${n}:${w}${n}`, values: [op.row] }); else (appends[op.tab] = appends[op.tab] || []).push(op.row); }
    else if (n) dels.push({ tab: op.tab, row: n });
  }
  if (updates.length) await gapi(sidPath() + '/values:batchUpdate', { method: 'POST', body: { valueInputOption: 'RAW', data: updates } });
  if (dels.length) {
    dels.sort((a, b) => b.row - a.row);
    await gapi(sidPath() + ':batchUpdate', { method: 'POST', body: { requests: dels.map(d => ({ deleteDimension: { range: { sheetId: SY.tabIds[d.tab], dimension: 'ROWS', startIndex: d.row - 1, endIndex: d.row } } })) } });
  }
  for (const [tab, rows] of Object.entries(appends)) await gapi(sidPath() + '/values/' + encodeURIComponent(tab + '!A1') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', { method: 'POST', body: { values: rows } });
}

/* ---------- sync engine ---------- */
let idbT = 0;
function persistSheetCache() {
  const c = { sheetId: SY.sheetId, S, base: SY.base, lastSync: SY.lastSync, savedAt: Date.now() }, js = JSON.stringify(c);
  try { localStorage.setItem(cacheKey(SY.sheetId), js); } catch (e) { toast('Could not save the offline copy: storage full?'); }
  clearTimeout(idbT); idbT = setTimeout(() => idbSafe('cache:' + c.sheetId, js), 250); // second copy, in case iOS clears localStorage
}
function loadSheetCache() {
  try { const c = JSON.parse(localStorage.getItem(cacheKey(SY.sheetId)) || 'null'); if (c && c.sheetId === SY.sheetId && c.S) { SY.base = c.base || null; SY.lastSync = c.lastSync || 0; return normalize(c.S); } } catch (e) { }
  SY.base = null; SY.lastSync = 0; return null;
}
const pendingCount = () => SY.mode === 'sheet' && SY.base ? diffRows(SY.base, toRows(S)).length : 0;
function scheduleSync(ms = 700) { clearTimeout(SY.timer); SY.timer = setTimeout(() => sync('save'), ms); }
async function sync(reason) {
  if (SY.mode !== 'sheet') return;
  if (SY.syncing) { SY.again = true; return; }
  if (!hasToken()) return setStatus('signin');
  if (navigator.onLine === false) return setStatus('offline');
  SY.syncing = true; setStatus('syncing');
  try {
    const start = toRows(S);
    const pending = SY.base ? diffRows(SY.base, start) : [];
    let fresh = await fetchAll();
    if (pending.length) { await commit(pending, fresh); fresh = await fetchAll(); }
    let p = parseSheet(fresh);
    // One-time fixes on fresh data: give ids to rows appended without one, refresh Income "actual",
    // start a new month (copy the budget) and add this month's recurring bills.
    const roll = withS(p.S, () => rolloverCore());
    const fixes = diffRows(p.base, toRows(p.S));
    if (fixes.length) { await commit(fixes, fresh); fresh = await fetchAll(); p = parseSheet(fresh); }
    const during = diffRows(start, toRows(S)); // edits made while this sync was running
    SY.base = p.base;
    if (during.length) {
      const rows = toRows(p.S); during.forEach(op => { if (op.row) rows[op.tab][op.key] = op.row; else delete rows[op.tab][op.key]; });
      S = parseSheet(rowsToRaw(rows)).S; SY.again = true;
    } else S = p.S;
    SY.lastSync = Date.now(); persistSheetCache(); setStatus('ok');
    if (roll.newMonth && reason !== 'connect') toast('New month: budget carried over' + (roll.added ? ` · ${roll.added} bill${roll.added > 1 ? 's' : ''} added` : ''));
    else if (roll.added) toast(`${roll.added} recurring bill${roll.added > 1 ? 's' : ''} added`);
    safeRender();
  } catch (e) {
    if (e.auth) setStatus('signin', e.message);
    else if (e.offline) setStatus('offline', e.message);
    else { setStatus('error', e.message); if (e.status === 404 || e.status === 403 || e.notStacked) SY.tabIds = null; }
    if (!e.auth && !e.offline) console.warn('sync failed:', e.message);
  } finally {
    SY.syncing = false;
    if (SY.again && SY.status === 'ok') { SY.again = false; scheduleSync(300); } else SY.again = false;
  }
}
function setStatus(s, msg) {
  const prev = SY.status, loud = x => x === 'signin' || x === 'error' || x === 'offline';
  SY.status = s; SY.msg = msg || '';
  if (typeof renderSync === 'function') renderSync();
  if (prev !== s && (loud(prev) || loud(s)) && typeof safeRender === 'function' && typeof view !== 'undefined') safeRender();
}
function setMode(mode) {
  SY.mode = mode; try { localStorage.setItem(K_MODE, mode); } catch (e) { } idbSafe('mode', mode);
  if (mode === 'sheet') { SY.tabIds = null; S = loadSheetCache() || emptySheetState(); }
  else { clearTimeout(SY.timer); S = load(); }
  if (typeof renderSync === 'function') renderSync();
}
function emptySheetState() { const s = blank(); s.cats = []; s.v = VER; return normalize(s); }
function setSheetId(id) { SY.sheetId = id; SY.tabIds = null; SY.base = null; SY.recovered = ''; try { localStorage.setItem(K_SID, id); } catch (e) { } cookieSet(id); idbSafe('sid', id); }
// Runs after boot: fills in anything iOS wiped from localStorage using the IndexedDB copy. Never overwrites newer data.
async function recoverFromIdb() {
  let sid, mode, cache;
  try { [sid, mode] = await Promise.all([idbGet('sid'), idbGet('mode')]); } catch (e) { return false; }
  let changed = false;
  if (!SY.sheetId && sid) {
    let md = null; try { md = localStorage.getItem(K_MODE); } catch (e) { }
    SY.sheetId = sid; SY.recovered = 'idb'; try { localStorage.setItem(K_SID, sid); } catch (e) { }
    if (md !== 'local' && mode !== 'local' && !(S.txns.length && SY.mode === 'local')) { SY.mode = 'sheet'; try { localStorage.setItem(K_MODE, 'sheet'); } catch (e) { } S = loadSheetCache() || emptySheetState(); }
    changed = true;
  }
  if (SY.sheetId) { cookieSet(SY.sheetId); if (sid !== SY.sheetId) idbSafe('sid', SY.sheetId); }
  if (SY.mode === 'sheet') {
    let have = false; try { have = !!localStorage.getItem(cacheKey(SY.sheetId)); } catch (e) { }
    if (!have) {
      try { cache = JSON.parse(await idbGet('cache:' + SY.sheetId) || 'null'); } catch (e) { cache = null; }
      if (cache && cache.S && !S.txns.length && !SY.lastSync) { SY.base = cache.base || null; SY.lastSync = cache.lastSync || 0; S = normalize(cache.S); persistSheetCache(); changed = true; }
    }
  }
  return changed;
}
// Brand-new spreadsheet, only when the user explicitly asks for one.
async function createStackedSheet() {
  const j = await gapi('', { url: GS_API.replace(/\/$/, ''), method: 'POST', body: { properties: { title: 'Stacked Budget Data' }, sheets: TAB_ORDER.map(t => ({ properties: { title: t, gridProperties: { frozenRowCount: 1 } } })) } });
  setSheetId(j.spreadsheetId);
  await gapi(sidPath() + '/values:batchUpdate', { method: 'POST', body: { valueInputOption: 'RAW', data: TAB_ORDER.map(t => ({ range: t + '!A1', values: [TABS[t].cols] })) } });
  const st = blank(); st.demo = false; S = normalize(st); SY.base = {}; TAB_ORDER.forEach(t => SY.base[t] = {});
  SY.mode = 'sheet'; try { localStorage.setItem(K_MODE, 'sheet'); } catch (e) { } idbSafe('mode', 'sheet');
  persistSheetCache();
  return j.spreadsheetId;
}
async function connectSheet(id) {
  // call from a tap: signIn() opens Google's popup
  if (id && id !== SY.sheetId) setSheetId(id); // other sheets' cached copies (and queued changes) stay under their own keys
  else if (id) { cookieSet(id); idbSafe('sid', id); }
  setMode('sheet'); go(view === 'set' ? 'set' : 'home');
  if (!hasToken()) { try { await signIn(); } catch (e) { setStatus('signin', e.message); toast(e.message); return; } }
  await sync('connect');
  if (SY.status === 'ok') toast('Connected to ' + (SY.title || 'your Google Sheet'));
  else if (SY.msg) toast(SY.msg);
}
