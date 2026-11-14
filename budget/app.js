/* Stacked: a private budget tracker. All data lives in this browser's localStorage. Nothing is sent anywhere. */
'use strict';
const KEY = 'stacked_v1', APP = 'stacked', VER = 1;
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parseD = s => { const [a, b, c] = s.split('-').map(Number); return new Date(a, b - 1, c || 1); };
const today = () => ymd(new Date());
const curMK = () => today().slice(0, 7);
const mkAdd = (mk, n) => { const d = parseD(mk + '-01'); d.setMonth(d.getMonth() + n); return ymd(d).slice(0, 7); };
const daysIn = mk => { const [y, m] = mk.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const MN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const mkLabel = (mk, long) => { const [y, m] = mk.split('-').map(Number); return (long ? MN[m - 1] : MN[m - 1].slice(0, 3)) + ' ' + y; };
const fmtDay = s => parseD(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const fmtShort = s => parseD(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const r2 = n => Math.round((+n || 0) * 100) / 100;
const cents = n => Math.round((+n || 0) * 100);
const CUR = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const CUR0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const money = n => CUR.format(r2(n) || 0);
const money0 = n => CUR0.format(Math.round(n) || 0);
const kmoney = n => Math.abs(n) >= 1000 ? '$' + (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : money0(n);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const sum = a => a.reduce((x, y) => x + y, 0);
const initials = s => { const w = String(s).replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean); return ((w[0] || '?')[0] + (w[1] ? w[1][0] : (w[0] || '').slice(1, 2))).toUpperCase(); };
const PALETTE = ['#30d158', '#0a84ff', '#ff9f0a', '#bf5af2', '#ff375f', '#64d2ff', '#ffd60a', '#ac8e68', '#5e5ce6', '#66d4cf', '#ff6482', '#a2845e', '#8e8e93'];
const UNCAT = 'uncat', OTHER_INC = 'other';
// Category names mirror the old spreadsheet. Budgets start at $0; nothing personal ships with the app.
const DEFAULT_CATS = [
  ['rent', 'Rent', '#0a84ff'], ['car', 'Car Payment', '#5e5ce6'], ['roth', 'Roth IRA', '#30d158', 1], ['osrs', 'OSRS Membership', '#ffd60a'],
  ['savings', 'Savings', '#66d4cf', 1], ['free', 'Free Spending', '#ff375f'], ['groceries', 'Groceries', '#ff9f0a'], ['gas', 'Gas', '#bf5af2'],
  [UNCAT, 'Uncategorized', '#8e8e93']
].map(([id, name, color, sv]) => ({ id, name, color, save: !!sv }));
const DEFAULT_INC = [
  { id: 'pay1', name: 'Paycheck 1', day: 6 }, { id: 'pay2', name: 'Paycheck 2', day: 20 },
  { id: 'job2', name: 'Job 2 (hourly)', day: 15, hourly: true }, { id: 'mileage', name: 'Mileage', day: 0 }
];
const blank = () => ({ v: VER, settings: { rate: 29 }, cats: DEFAULT_CATS.map(c => ({ ...c })), months: {}, txns: [], recurring: [], demo: false, created: today() });

let S = SY.mode === 'sheet' ? (loadSheetCache() || emptySheetState()) : load();
function load() {
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.v) return normalize(s); } catch (e) { console.warn('load failed', e); }
  return blank();
}
function normalize(s) {
  const b = blank();
  s.settings = { ...b.settings, ...(s.settings || {}) };
  s.cats = Array.isArray(s.cats) && s.cats.length ? s.cats : b.cats;
  if (!s.cats.find(c => c.id === UNCAT)) s.cats.push({ ...DEFAULT_CATS.find(c => c.id === UNCAT) });
  s.months = s.months && typeof s.months === 'object' ? s.months : {};
  for (const m of Object.values(s.months)) { m.budgets = m.budgets || {}; m.income = m.income || []; m.recurDone = m.recurDone || {}; }
  s.txns = Array.isArray(s.txns) ? s.txns.filter(t => t && /^\d{4}-\d\d-\d\d$/.test(t.date) && isFinite(+t.amt)) : [];
  s.txns.forEach(t => { t.amt = r2(t.amt); t.type = t.type === 'inc' ? 'inc' : 'exp'; t.id = t.id || uid(); if (t.src === 'manual') t.src = 'app'; if (t.src === 'auto') t.src = 'bill'; });
  s.recurring = Array.isArray(s.recurring) ? s.recurring : [];
  s.v = VER; return s;
}
function save() {
  if (SY.mode === 'sheet') { persistSheetCache(); renderSync(); scheduleSync(); return; }
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('Could not save: storage is full or blocked'); }
}
const inSheet = () => SY.mode === 'sheet';
// In Google Sheet mode a month is only created from fresh sheet data (see sync), never from a stale offline copy.
const touchMonth = mk => inSheet() ? monthData(mk) : M(mk);
const catById = id => S.cats.find(c => c.id === id) || S.cats.find(c => c.id === UNCAT);

/* ---------- months ---------- */
function shiftPay(p, mk) { if (!p) return ''; const d = +p.slice(8, 10); return mk + '-' + pad(Math.min(d, daysIn(mk))); }
function monthData(mk, persist) {
  if (S.months[mk]) return S.months[mk];
  const prev = Object.keys(S.months).filter(k => k < mk).sort().pop();
  let m;
  if (prev) {
    const p = S.months[prev];
    m = {
      budgets: { ...p.budgets }, recurDone: {}, copiedFrom: prev,
      income: p.income.map(l => ({ id: l.id, name: l.name, hourly: !!l.hourly, hours: 0, planned: l.hourly && l.hours ? r2(l.hours * S.settings.rate) : (+l.planned || 0), payDate: shiftPay(l.payDate, mk) }))
    };
  } else {
    m = {
      budgets: Object.fromEntries(S.cats.map(c => [c.id, 0])), recurDone: {},
      income: DEFAULT_INC.map(l => ({ id: l.id, name: l.name, hourly: !!l.hourly, hours: 0, planned: 0, payDate: l.day ? mk + '-' + pad(Math.min(l.day, daysIn(mk))) : '' }))
    };
  }
  if (persist) S.months[mk] = m;
  return m;
}
const M = mk => monthData(mk, true);
// Bills are added once per month. r.last = last month already handled; ids are deterministic
// ("bill-<bill>-<month>") so two devices adding the same bill can never create a duplicate.
function runRecurring() {
  const cm = curMK(); let n = 0;
  for (const r of S.recurring) {
    if (!r.active || !r.start) continue;
    let mk = r.last && r.last >= r.start ? mkAdd(r.last, 1) : r.start;
    for (let guard = 0; mk <= cm && guard < 240; mk = mkAdd(mk, 1), guard++) {
      const lm = S.months[mk]; if (lm && lm.recurDone && lm.recurDone[r.id]) continue;
      const id = 'bill-' + r.id + '-' + mk;
      if (S.txns.some(t => t.id === id)) continue;
      S.txns.push({ id, date: mk + '-' + pad(Math.min(r.day || 1, daysIn(mk))), amt: r2(r.amt), type: 'exp', cat: r.cat, note: r.name, src: 'bill', created: nowISO(), ts: Date.now() });
      n++;
    }
    if (!r.last || r.last < cm) r.last = cm;
  }
  return n;
}
function rolloverCore() {
  const cm = curMK(); const had = !!S.months[cm];
  M(cm); const n = runRecurring();
  return { newMonth: !had && Object.keys(S.months).length > 1, added: n };
}
function rollover() {
  if (inSheet()) return { newMonth: false, added: 0 }; // done after each fresh read instead
  const r = rolloverCore(); save(); return r;
}
const plannedOf = l => l.hourly && +l.hours ? r2(l.hours * S.settings.rate) : (+l.planned || 0);

function stats(mk) {
  const m = monthData(mk);
  const tx = S.txns.filter(t => t.date.startsWith(mk));
  const byCat = {}, byInc = {}; let spent = 0, inc = 0;
  for (const t of tx) {
    if (t.type === 'inc') { inc += t.amt; byInc[t.cat] = (byInc[t.cat] || 0) + t.amt; }
    else { const c = catById(t.cat).id; byCat[c] = (byCat[c] || 0) + t.amt; spent += t.amt; }
  }
  const budget = sum(S.cats.map(c => +m.budgets[c.id] || 0));
  const plannedInc = sum(m.income.map(plannedOf));
  const saved = sum(S.cats.filter(c => c.save).map(c => byCat[c.id] || 0));
  return { m, tx, byCat, byInc, spent: r2(spent), inc: r2(inc), budget: r2(budget), plannedInc: r2(plannedInc), saved: r2(saved), left: r2(budget - spent), net: r2(inc - spent) };
}

/* ---------- ui state ---------- */
let view = 'home', vMK = curMK(), txF = { q: '', type: 'all', cat: '', scope: 'month' }, planTab = 'cats', incOpen = new Set(), incShut = new Set(), vYear = +curMK().slice(0, 4);
const TITLES = { home: 'Home', tx: 'Activity', plan: 'Plan', year: 'Year', set: 'Settings' };
function go(v) {
  if (v === 'add') return txSheet();
  view = v;
  $$('nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $$('main > .view').forEach(e => e.classList.add('hide'));
  const el = $('#v-' + v); el.classList.remove('hide'); el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  $('#ttl').textContent = TITLES[v];
  render(); window.scrollTo({ top: 0 });
}
function render() {
  $('#mpill').classList.toggle('hide', view === 'set');
  $('#mlab').textContent = view === 'year' ? String(vYear) : mkLabel(vMK);
  ({ home: renderHome, tx: renderTx, plan: renderPlan, year: renderYear, set: renderSet })[view]();
}
function shiftView(n) {
  if (view === 'year') vYear += n; else vMK = mkAdd(vMK, n);
  render();
}
$('#mprev').onclick = () => shiftView(-1);
$('#mnext').onclick = () => shiftView(1);
$('#mlab').onclick = () => { vMK = curMK(); vYear = +vMK.slice(0, 4); render(); };
$('#gear').onclick = () => go('set');
$$('nav button').forEach(b => b.onclick = () => go(b.dataset.v));

/* ---------- sync status UI ---------- */
let needRender = false;
function safeRender() {
  const a = document.activeElement;
  if (a && a.closest && a.closest('main') && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) {
    if (!needRender) { needRender = true; a.addEventListener('blur', () => { needRender = false; render(); }, { once: true }); }
    return;
  }
  render();
}
function syncText() {
  const n = pendingCount(), last = SY.lastSync ? new Date(SY.lastSync).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const w = n ? ` · ${n} change${n > 1 ? 's' : ''} waiting` : '';
  switch (SY.status) {
    case 'syncing': return 'Syncing with Google Sheets…';
    case 'ok': return n ? 'Saving to Google Sheets…' : 'Synced' + (last ? ' at ' + last : '');
    case 'offline': return 'Offline' + w + '. Will sync when you\'re back online.';
    case 'signin': return (SY.msg || 'Sign in with Google to sync') + w;
    case 'error': return 'Sync problem: ' + SY.msg + w;
    default: return (hasToken() ? 'Ready to sync' : 'Sign in with Google to sync') + w;
  }
}
function syncState() {
  const n = pendingCount();
  if (SY.status === 'ok') return n ? 'pend' : 'ok';
  if (SY.status === 'idle') return hasToken() ? 'pend' : 'signin';
  return SY.status;
}
function renderSync() {
  const b = $('#sync'); if (!b) return;
  b.classList.toggle('hide', !inSheet());
  if (!inSheet()) return;
  const st = syncState();
  b.className = 'icb sync s-' + st; b.title = syncText(); b.setAttribute('aria-label', syncText()); b.dataset.state = st;
  const el = $('#set-sync'); if (el) el.textContent = syncText();
}
function syncTap() {
  if (!inSheet()) return;
  if (!hasToken() || SY.status === 'signin') { signIn().then(() => sync('signin'), e => { setStatus('signin', e.message); toast(e.message); }); return; }
  if (SY.status === 'error') toast(SY.msg);
  else toast(syncText());
  sync('manual');
}
function sheetBanner() {
  if (!inSheet()) return '';
  if (SY.status === 'signin') return `<div class="banner warn"><span style="flex:1"><b>Not syncing.</b> ${esc(SY.msg || 'Sign in with Google to sync your budget sheet.')}${pendingCount() ? ` ${pendingCount()} change(s) are saved on this device.` : ''}</span><button data-act="signin">Sign in</button></div>`;
  if (SY.status === 'error') return `<div class="banner err"><span style="flex:1">${esc(SY.msg)}</span><button data-act="retry">Retry</button></div>`;
  if (SY.status === 'offline') return `<div class="banner off"><span style="flex:1"><b>Offline.</b> ${pendingCount() ? pendingCount() + ' change(s) saved on this device, ' : 'Changes are saved on this device and '}will sync when you're back online.</span></div>`;
  return '';
}
function bindBanner(root) {
  $$('[data-act="signin"]', root).forEach(b => b.onclick = syncTap);
  $$('[data-act="retry"]', root).forEach(b => b.onclick = () => sync('retry'));
}
function promptSheetId() {
  loadGis().catch(() => { });
  openSheet(`<h3>Connect your Stacked sheet</h3>
  <div class="sub" style="line-height:1.45">Paste the link to your <b>Stacked Budget Data</b> spreadsheet. In the Google Sheets app open it, tap <b>⋮ › Share &amp; export › Copy link</b>, then paste it here. It's saved only on this device.</div>
  <label>Your sheet link</label><div class="row"><input id="p-sid" placeholder="https://docs.google.com/spreadsheets/d/…" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(SY.sheetId)}"><button id="p-paste" style="flex:none">Paste</button></div>
  <button class="pri" id="p-go" style="width:100%;margin-top:14px">Connect &amp; sign in with Google</button>
  <a class="sub" href="https://docs.google.com/spreadsheets/u/0/?q=Stacked%20Budget%20Data" target="_blank" rel="noopener noreferrer" style="display:block;text-align:center;margin-top:14px;color:#fff">Find it in Google Sheets ↗</a>
  <div class="row" style="margin-top:18px"><button id="p-x">Cancel</button><button class="lnk sub" id="p-new" style="flex:none">No sheet yet? Create a new one</button></div>`, sh => {
    const inp = $('#p-sid', sh);
    $('#p-x', sh).onclick = closeSheet;
    $('#p-paste', sh).onclick = async () => {
      try { const t = await navigator.clipboard.readText(); const id = sheetIdFrom(t); if (id) inp.value = t.trim(); else toast('The clipboard doesn\'t have a Google Sheets link'); }
      catch (e) { inp.focus(); toast('Long-press the box and tap Paste'); }
    };
    $('#p-go', sh).onclick = () => {
      const id = sheetIdFrom(inp.value);
      if (!id) { toast('That doesn\'t look like a Google Sheets link'); return inp.focus(); }
      closeSheet(); connectSheet(id);
    };
    $('#p-new', sh).onclick = () => {
      if (sheetIdFrom(inp.value) || SY.sheetId) { if (!confirm('You already have a sheet link saved. Creating a new sheet starts EMPTY and won\'t include anything from it. Create a new one anyway?')) return; }
      if (!confirm('Create a NEW, empty "Stacked Budget Data" spreadsheet in your Google Drive?\n\nIf you already have one, tap Cancel and paste its link instead.')) return;
      closeSheet(); createNewSheet();
    };
  });
}
async function createNewSheet() {
  if (!hasToken()) { try { await signIn(); } catch (e) { toast(e.message); return; } }
  try { setStatus('syncing'); await createStackedSheet(); } catch (e) { setStatus(hasToken() ? 'error' : 'signin', e.message); toast('Could not create the sheet: ' + e.message); return; }
  vMK = curMK(); go('home'); await sync('connect');
  toast(SY.status === 'ok' ? 'New sheet created: Stacked Budget Data' : SY.msg || 'Created, but the first sync failed');
}

/* ---------- toast ---------- */
let tT;
function toast(msg, action, fn) {
  const t = $('#toast'); $('#tmsg').textContent = msg;
  const a = $('#tact'); a.classList.toggle('hide', !action); a.textContent = action || ''; a.onclick = () => { t.classList.remove('show'); fn && fn(); };
  t.classList.add('show'); clearTimeout(tT); tT = setTimeout(() => t.classList.remove('show'), action ? 5000 : 2600);
}

/* ---------- sheet ---------- */
function openSheet(html, mount) {
  const sh = $('#sheet'), sc = $('#scrim');
  sh.innerHTML = '<div class="grab"></div>' + html;
  sh.classList.remove('hide'); sc.classList.remove('hide'); sh.scrollTop = 0;
  requestAnimationFrame(() => { sh.classList.add('show'); sc.classList.add('show'); });
  mount && mount(sh);
}
function closeSheet() {
  const sh = $('#sheet'), sc = $('#scrim');
  sh.classList.remove('show'); sc.classList.remove('show');
  setTimeout(() => { if (!sh.classList.contains('show')) { sh.classList.add('hide'); sc.classList.add('hide'); sh.innerHTML = ''; } }, 380);
}
$('#scrim').onclick = closeSheet;
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#sheet').classList.contains('show')) closeSheet();
  const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '');
  if (typing || $('#sheet').classList.contains('show') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'n' || e.key === 'a') { e.preventDefault(); txSheet(); }
  if (e.key === 'ArrowLeft') shiftView(-1);
  if (e.key === 'ArrowRight') shiftView(1);
});

/* ---------- small components ---------- */
const badge = (c, cls = '') => `<div class="bdg ${cls}" style="background:${esc(c.color)}">${esc(initials(c.name))}</div>`;
const incBadge = (cls = '') => `<div class="bdg ${cls}" style="background:#1f3a26;color:var(--grn)">+</div>`;
function barCls(spent, budget) { if (budget <= 0) return spent > 0 ? 'red' : ''; if (Math.abs(budget - spent) < 0.5) return 'done'; const p = spent / budget; return p > 1 ? 'red' : p >= 0.85 ? 'amb' : ''; }
const pct = (a, b) => b > 0 ? Math.max(0, Math.min(100, a / b * 100)) : (a > 0 ? 100 : 0);
function incLineName(t) {
  if (t.cat === OTHER_INC) return 'Other income';
  const m = monthData(t.date.slice(0, 7)); const l = m.income.find(x => x.id === t.cat);
  if (l) return l.name;
  for (const k of Object.keys(S.months)) { const x = S.months[k].income.find(i => i.id === t.cat); if (x) return x.name; }
  return inSheet() && t.cat ? t.cat : 'Income';
}
function txRow(t, swipe) {
  const inc = t.type === 'inc', c = inc ? null : catById(t.cat);
  const lbl = inc ? incLineName(t) : c.name;
  const title = t.note || lbl;
  const sub = lbl + ' · ' + fmtShort(t.date) + (t.card ? ' · ••' + t.card : '');
  const tags = (t.src === 'bill' ? '<span class="tag">AUTO</span>' : '') + (t.src === 'import' ? '<span class="tag">IMPORTED</span>' : '') + (t.src === 'finny' ? '<span class="tag">FINNY</span>' : '') + (t.rawCat ? `<span class="tag" style="color:var(--amb)">${esc(t.rawCat)}?</span>` : '');
  const inner = `${inc ? incBadge('sm') : badge(c, 'sm')}<div class="mid"><div class="t1">${esc(title)}${tags}</div><div class="t2">${esc(sub)}</div></div><div class="amt ${inc ? 'inc' : ''}">${inc ? '+' : t.amt < 0 ? '+' : '−'}${money(Math.abs(t.amt))}</div>`;
  if (!swipe) return `<div class="tx" data-t="${esc(t.id)}">${inner}</div>`;
  return `<div class="swr" data-id="${esc(t.id)}"><div class="swa"><button class="ed" data-e="${esc(t.id)}">Edit</button><button class="dl" data-d="${esc(t.id)}">Delete</button></div><div class="swf tx" data-t="${esc(t.id)}">${inner}</div></div>`;
}
function bindTx(root) {
  $$('[data-t]', root).forEach(el => el.addEventListener('click', () => {
    if (el._sw && Date.now() - el._sw < 350) return;
    const w = el.closest('.swr'); if (w && w._open && w._open()) { w._close(); return; }
    txSheet(S.txns.find(t => t.id === el.dataset.t));
  }));
  $$('[data-e]', root).forEach(b => b.onclick = e => { e.stopPropagation(); txSheet(S.txns.find(t => t.id === b.dataset.e)); });
  $$('[data-d]', root).forEach(b => b.onclick = e => { e.stopPropagation(); delTx(b.dataset.d); });
  $$('.swr', root).forEach(w => {
    const f = $('.swf', w), W = 160; let x0 = 0, y0 = 0, dx = 0, drag = false, open = false, lock = null;
    const setX = x => f.style.transform = `translateX(${x}px)`;
    w._close = () => { open = false; setX(0); }; w._open = () => open;
    f.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; lock = null; drag = true; f.classList.add('drag'); }, { passive: true });
    f.addEventListener('touchmove', e => {
      if (!drag) return; const mx = e.touches[0].clientX - x0, my = e.touches[0].clientY - y0;
      if (lock == null && (Math.abs(mx) > 6 || Math.abs(my) > 6)) lock = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
      if (lock !== 'x') return; dx = mx; setX(Math.max(-W - 30, Math.min(0, (open ? -W : 0) + dx)));
    }, { passive: true });
    f.addEventListener('touchend', () => { drag = false; f.classList.remove('drag'); if (lock !== 'x') return; const p = (open ? -W : 0) + dx; open = p < -W / 2; setX(open ? -W : 0); f._sw = Date.now(); });
  });
}
function delTx(id) {
  const i = S.txns.findIndex(t => t.id === id); if (i < 0) return;
  const [t] = S.txns.splice(i, 1); save(); render();
  toast('Deleted ' + money(t.amt) + (t.type === 'inc' ? ' · ' + incLineName(t) : ''), 'Undo', () => { S.txns.push(t); save(); render(); });
}

/* ---------- charts ---------- */
function donut(st) {
  const items = S.cats.map(c => ({ c, v: st.byCat[c.id] || 0 })).filter(x => x.v > 0).sort((a, b) => b.v - a.v);
  const total = sum(items.map(x => x.v));
  const R = 54, C = 2 * Math.PI * R; let off = 0;
  const segs = items.map(x => {
    const len = x.v / total * C, gap = items.length > 1 ? Math.min(2.5, len * 0.3) : 0;
    const s = `<circle class="sg" cx="70" cy="70" r="${R}" fill="none" stroke="${esc(x.c.color)}" stroke-width="18" stroke-dasharray="${Math.max(0, len - gap).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 70 70)"/>`;
    off += len; return s;
  }).join('');
  const top = items.slice(0, 6), rest = items.slice(6);
  const leg = top.map(x => `<div><span class="dot" style="background:${esc(x.c.color)}"></span><span>${esc(x.c.name)}</span><b>${Math.round(x.v / total * 100)}%</b></div>`).join('') +
    (rest.length ? `<div><span class="dot" style="background:#444"></span><span>${rest.length} more</span><b>${Math.round(sum(rest.map(x => x.v)) / total * 100)}%</b></div>` : '');
  return `<div class="card"><div class="ctitle"><b>Where it went</b><span class="sub">${items.length} categor${items.length === 1 ? 'y' : 'ies'}</span></div>
  ${total > 0 ? `<div class="donut"><svg viewBox="0 0 140 140" role="img" aria-label="Spending by category"><circle cx="70" cy="70" r="${R}" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="18"/>${segs}
  <text x="70" y="70" text-anchor="middle" fill="#fff" font-size="18" font-weight="800">${esc(kmoney(total))}</text><text x="70" y="86" text-anchor="middle" fill="#8e8e93" font-size="10">spent</text></svg><div class="legend">${leg}</div></div>`
    : '<div class="sub" style="padding:30px 0;text-align:center">No spending yet this month</div>'}</div>`;
}
function lineChart(mk, st) {
  const D = daysIn(mk), cm = curMK(), W = 320, H = 130, P = 6;
  const lastDay = mk < cm ? D : mk === cm ? +today().slice(8, 10) : 0;
  const daily = new Array(D + 1).fill(0);
  st.tx.filter(t => t.type === 'exp').forEach(t => daily[+t.date.slice(8, 10)] += t.amt);
  const cum = [0]; let run = 0; for (let d = 1; d <= D; d++) { run += daily[d]; cum[d] = run; }
  const maxY = Math.max(st.budget, ...cum.slice(1, lastDay + 1), 1) * 1.12;
  const x = d => P + (d - 1) / (D - 1) * (W - 2 * P), y = v => H - 18 - v / maxY * (H - 30);
  let path = '', area = '';
  if (lastDay > 0) {
    const pts = []; for (let d = 1; d <= lastDay; d++) pts.push(x(d).toFixed(1) + ',' + y(cum[d]).toFixed(1));
    path = 'M' + pts.join(' L');
    area = path + ` L${x(lastDay).toFixed(1)},${y(0)} L${x(1)},${y(0)} Z`;
  }
  const bills = new Array(D + 1).fill(0);
  st.tx.filter(t => t.type === 'exp' && t.src === 'bill').forEach(t => bills[+t.date.slice(8, 10)] += t.amt);
  const billTot = sum(bills), varB = Math.max(0, st.budget - billTot);
  const paceAt = d => { let b = 0; for (let i = 1; i <= d; i++) b += bills[i]; return Math.min(st.budget, b + varB * d / D); };
  const pacePts = []; for (let d = 1; d <= D; d++) pacePts.push(x(d).toFixed(1) + ',' + y(paceAt(d)).toFixed(1));
  const pace = st.budget > 0 ? `<path d="M${x(1)},${y(0)} L${pacePts.join(' L')}" fill="none" stroke="#5a5a5e" stroke-width="1.5" stroke-dasharray="4 4"/><text x="${x(D)}" y="${y(st.budget) - 6}" text-anchor="end">Budget ${esc(kmoney(st.budget))}</text>` : '';
  const ticks = [1, 8, 15, 22, D].map(d => `<text x="${x(d)}" y="${H - 2}" text-anchor="middle">${d}</text>`).join('');
  const end = lastDay > 0 ? `<circle cx="${x(lastDay)}" cy="${y(cum[lastDay])}" r="4.5" fill="#fff" stroke="#000" stroke-width="2"/>` : '';
  const paceAmt = lastDay > 0 ? paceAt(lastDay) : 0, over = st.budget > 0 && lastDay > 0 && cum[lastDay] > paceAmt;
  const col = over ? '#ff9f0a' : '#30d158';
  const paceTxt = st.budget > 0 && lastDay > 0 ? (over ? `<span class="amb">${money0(cum[lastDay] - paceAmt)} ahead of pace</span>` : `<span class="grn">${money0(paceAmt - cum[lastDay])} under pace</span>`) : '<span class="sub">—</span>';
  return `<div class="card chart"><div class="ctitle"><b>Spending over the month</b><span style="font-size:12.5px;font-weight:600">${paceTxt}</span></div>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative spending over the month"><defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".35"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
  <line x1="${P}" y1="${y(0)}" x2="${W - P}" y2="${y(0)}" stroke="#2c2c2e"/>${pace}${area ? `<path d="${area}" fill="url(#ga)"/><path d="${path}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>` : ''}${end}${ticks}</svg></div>`;
}

/* ---------- HOME ---------- */
function renderHome() {
  const mk = vMK, st = stats(mk), cm = curMK(), m = st.m;
  const hasAny = S.txns.length || Object.values(S.months).some(x => sum(Object.values(x.budgets).map(Number)) > 0);
  let h = sheetBanner() + (S.demo ? `<div class="banner"><span style="flex:1"><b>Demo data</b> · these are fake numbers so you can look around.</span><button id="clrdemo">Clear demo</button></div>` : '');
  if (!hasAny && inSheet()) {
    const waiting = SY.status === 'syncing';
    h += `<div class="card empty"><div class="ill"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M4 9h16M4 15h16M10 9v12"/></svg></div>
    <h3>${waiting ? 'Loading your sheet…' : 'Your budget lives in Google Sheets'}</h3><p>${waiting ? 'Reading your spreadsheet.' : 'Sign in with Google to load your budget. A copy is kept on this device so it works offline.'}</p>
    <div class="btns">${waiting ? '' : '<button class="pri" data-act="signin">Sign in with Google</button>'}<button class="lnk sub" id="e-local" style="margin-top:6px">Use this device only instead</button></div></div>`;
    $('#v-home').innerHTML = h; bindBanner($('#v-home'));
    $('#e-local').onclick = () => { setMode('local'); go('home'); };
    return;
  }
  if (!hasAny) {
    h += `<div class="card empty"><div class="ill"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v4c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 10v4c0 1.7 3.1 3 7 3s7-1.3 7-3v-4M5 14v4c0 1.7 3.1 3 7 3s7-1.3 7-3v-4"/></svg></div>
    <h3>Welcome to Stacked</h3><p>Your budget, minus the spreadsheet. Keep it in your own Google Sheet or only on this device. No servers, no tracking.</p>
    <div class="btns"><button class="pri" id="e-sheet">${SY.sheetId ? 'Reconnect my Google Sheet' : 'Connect my Google Sheet'}</button><button id="e-plan">Set a budget on this device only</button><button id="e-imp">Import a CSV or backup</button><button class="lnk sub" id="e-demo" style="margin-top:6px">Try it with demo data (fake numbers)</button></div></div>`;
    $('#v-home').innerHTML = h; bindBanner($('#v-home'));
    $('#e-sheet').onclick = () => SY.sheetId ? connectSheet(SY.sheetId) : promptSheetId();
    $('#e-plan').onclick = () => { planTab = 'cats'; go('plan'); };
    $('#e-imp').onclick = () => pickFile();
    $('#e-demo').onclick = loadDemo;
    return;
  }
  const D = daysIn(mk), dayN = mk === cm ? +today().slice(8, 10) : mk < cm ? D : 0, daysLeft = mk === cm ? D - dayN + 1 : mk > cm ? D : 0;
  const over = st.left < 0, p = pct(st.spent, st.budget);
  const perDay = daysLeft > 0 && st.left > 0 ? `${money0(st.left / daysLeft)}/day for ${daysLeft} day${daysLeft > 1 ? 's' : ''}` : mk < cm ? 'month closed' : '';
  const rate = st.inc > 0 ? Math.round(st.saved / st.inc * 100) : null;
  h += `<div class="card hero ${over ? 'over' : ''}"><div class="eyebrow">${over ? 'Over budget' : 'Left to spend'} · ${MN[+mk.slice(5) - 1]}</div>
   <div class="xl ${over ? 'red' : ''}">${money(Math.abs(st.left))}</div>
   <div class="sub">${money(st.spent)} spent of ${money(st.budget)}${perDay ? ' · ' + perDay : ''}</div>
   <div class="bar"><i class="${barCls(st.spent, st.budget) || 'grn'}" data-w="${p}"></i></div>
   <div class="stats"><div class="stat"><span>Income</span><b class="grn">${money0(st.inc)}</b><small>of ${money0(st.plannedInc)}</small></div>
   <div class="stat"><span>Left over</span><b class="${st.net < 0 ? 'red' : ''}">${money0(st.net)}</b><small>income − spent</small></div>
   <div class="stat"><span>Saved</span><b>${money0(st.saved)}</b><small>${rate == null ? 'no income yet' : rate + '% of income'}</small></div></div></div>`;
  h += `<div class="charts">${donut(st)}${lineChart(mk, st)}</div>`;
  const cats = S.cats.filter(c => (+m.budgets[c.id] || 0) > 0 || (st.byCat[c.id] || 0) !== 0);
  const rows = cats.map(c => {
    const b = +m.budgets[c.id] || 0, s = st.byCat[c.id] || 0, rem = b - s, cls = barCls(s, b);
    return `<div class="crow" data-c="${esc(c.id)}">${badge(c)}<div class="mid"><div class="nm"><span>${esc(c.name)}</span><span class="${cls}">${cls === 'done' ? '✓ on budget' : rem < 0 ? money(-rem) + ' over' : money(rem) + ' left'}</span></div>
    <div class="bar"><i class="${cls}" data-w="${pct(s, b)}"></i></div><div class="meta"><span>${money(s)} of ${money(b)}</span><span>${b > 0 ? Math.round(s / b * 100) + '%' : 'no budget'}</span></div></div></div>`;
  }).join('');
  const recent = st.tx.slice().sort((a, b) => b.date.localeCompare(a.date) || (b.ts || 0) - (a.ts || 0)).slice(0, 5);
  const incRows = m.income.map(l => {
    const got = st.byInc[l.id] || 0, pl = plannedOf(l);
    return `<div class="kv" data-hi="${esc(l.id)}" style="cursor:pointer"><span>${esc(l.name)}${l.payDate ? `<span class="tiny"> · ${fmtShort(l.payDate)}</span>` : ''}</span><span>${got > 0 ? `<b class="${overRx(got, pl) ? 'amb' : 'grn'}">${overRx(got, pl) ? '⚠ ' : ''}${money(got)}</b>` : `<span class="sub">${pl ? money(pl) + ' planned' : '—'}</span>`}</span></div>`;
  }).join('') + (st.byInc[OTHER_INC] ? `<div class="kv"><span>Other income</span><b class="grn">${money(st.byInc[OTHER_INC])}</b></div>` : '');
  h += `<div class="g2"><div><h2>Budget vs actual <button class="lnk" id="h-plan">Edit</button></h2><div class="card">${rows || '<div class="sub">No budgets set for this month yet.</div>'}</div></div>
   <div><h2>Recent <button class="lnk" id="h-all">See all</button></h2><div class="card list">${recent.map(t => txRow(t)).join('') || '<div class="sub">Nothing logged yet. Tap + to add.</div>'}</div>
   <h2>Income <button class="lnk" id="h-inc">Edit</button></h2><div class="card">${incRows}</div></div></div>`;
  $('#v-home').innerHTML = h; bindBanner($('#v-home'));
  animBars('#v-home');
  bindTx($('#v-home'));
  $$('#v-home [data-c]').forEach(r => r.onclick = () => { txF = { q: '', type: 'exp', cat: r.dataset.c, scope: 'month' }; go('tx'); });
  $('#h-plan').onclick = () => { planTab = 'cats'; go('plan'); };
  $('#h-inc').onclick = () => { planTab = 'inc'; go('plan'); };
  $$('#v-home [data-hi]').forEach(r => r.onclick = () => { planTab = 'inc'; incOpen.add(r.dataset.hi); incShut.delete(r.dataset.hi); go('plan'); });
  $('#h-all').onclick = () => { txF = { q: '', type: 'all', cat: '', scope: 'month' }; go('tx'); };
  const cd = $('#clrdemo'); if (cd) cd.onclick = clearAll;
}
function animBars(root) { requestAnimationFrame(() => requestAnimationFrame(() => $$(root + ' .bar i').forEach(i => i.style.width = i.dataset.w + '%'))); }

/* ---------- ACTIVITY ---------- */
function incLinesFor() { // income lines seen in the shown period, by id
  const seen = new Map(), mks = txF.scope === 'month' ? [vMK] : Object.keys(S.months).sort().reverse();
  mks.forEach(mk => (S.months[mk] || { income: [] }).income.forEach(l => { if (!seen.has(l.id)) seen.set(l.id, l.name); }));
  S.txns.forEach(t => { if (t.type === 'inc' && !seen.has(t.cat) && (txF.scope !== 'month' || t.date.startsWith(vMK))) seen.set(t.cat, t.cat === OTHER_INC ? 'Other income' : incLineName(t)); });
  return [...seen].map(([id, name]) => ({ id, name }));
}
function renderTx() {
  const el = $('#v-tx');
  const keep = document.activeElement && document.activeElement.id === 'q';
  let list = S.txns.slice();
  if (txF.scope === 'month') list = list.filter(t => t.date.startsWith(vMK));
  if (txF.type !== 'all') list = list.filter(t => t.type === txF.type);
  if (txF.cat) list = list.filter(t => t.type === 'exp' && catById(t.cat).id === txF.cat);
  if (txF.type === 'inc' && txF.line) list = list.filter(t => t.cat === txF.line);
  const q = txF.q.trim().toLowerCase();
  if (q) list = list.filter(t => [t.note, t.type === 'inc' ? incLineName(t) : catById(t.cat).name, String(t.amt), money(t.amt), t.card, t.date].join(' ').toLowerCase().includes(q));
  list.sort((a, b) => b.date.localeCompare(a.date) || (b.ts || 0) - (a.ts || 0));
  const out = sum(list.filter(t => t.type === 'exp').map(t => t.amt)), inn = sum(list.filter(t => t.type === 'inc').map(t => t.amt));
  const dayTot = {}, dayIn = {}; list.forEach(t => { if (t.type === 'exp') dayTot[t.date] = (dayTot[t.date] || 0) + t.amt; else dayIn[t.date] = (dayIn[t.date] || 0) + t.amt; });
  let h = `<input id="q" type="search" placeholder="Search notes, categories, amounts" value="${esc(txF.q)}" autocomplete="off" style="margin-bottom:10px">
  <div class="chips"><button class="chip ${txF.scope === 'month' ? 'on' : ''}" data-sc="month">${esc(mkLabel(vMK))}</button><button class="chip ${txF.scope === 'all' ? 'on' : ''}" data-sc="all">All time</button>
  <span style="width:1px;background:#333;flex:none;margin:4px 2px"></span>
  <button class="chip ${txF.type === 'all' ? 'on' : ''}" data-ty="all">All</button><button class="chip ${txF.type === 'exp' ? 'on' : ''}" data-ty="exp">Spending</button><button class="chip ${txF.type === 'inc' ? 'on' : ''}" data-ty="inc">Income</button></div>
  ${txF.type === 'inc' ? `<div class="chips" id="tx-lines"><button class="chip ${!txF.line ? 'on' : ''}" data-lf="">Any income</button>${incLinesFor().map(x => `<button class="chip ${txF.line === x.id ? 'on' : ''}" data-lf="${esc(x.id)}"><span class="dot" style="background:var(--grn)"></span>${esc(x.name)}</button>`).join('')}</div>`
    : `<div class="chips"><button class="chip ${!txF.cat ? 'on' : ''}" data-cf="">Any category</button>${S.cats.map(c => `<button class="chip ${txF.cat === c.id ? 'on' : ''}" data-cf="${esc(c.id)}"><span class="dot" style="background:${esc(c.color)}"></span>${esc(c.name)}</button>`).join('')}</div>`}
  ${txF.type === 'inc' && list.length ? '<div class="tiny" style="margin:0 6px 4px">Tap a payment to edit it, or swipe left to delete.</div>' : ''}
  <div class="sub" style="margin:2px 6px 0" id="tx-count">${list.length} transaction${list.length === 1 ? '' : 's'} · −${money(out)}${inn ? ` · <span class="grn">+${money(inn)}</span>` : ''}</div>`;
  if (!list.length) h += `<div class="card empty" style="margin-top:12px"><h3>Nothing here</h3><p>${q || txF.cat || txF.type !== 'all' ? 'No transactions match these filters.' : 'No transactions this month yet.'}</p><button class="pri" id="tx-add">Add transaction</button></div>`;
  let lastD = '', shown = 0;
  for (const t of list) {
    if (shown++ >= 600) { h += '<div class="sub" style="text-align:center;margin:12px">Showing the latest 600. Search to narrow down.</div>'; break; }
    if (t.date !== lastD) {
      lastD = t.date;
      h += `<div class="dayh"><span>${fmtDay(t.date)}${txF.scope === 'all' ? ' ' + t.date.slice(0, 4) : ''}</span><span>${dayTot[t.date] ? '−' + money(dayTot[t.date]) : dayIn[t.date] ? '<span class="grn">+' + money(dayIn[t.date]) + '</span>' : ''}</span></div>`;
    }
    h += txRow(t, true);
  }
  el.innerHTML = h;
  const qi = $('#q');
  qi.oninput = () => { txF.q = qi.value; renderTx(); };
  if (keep) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); }
  $$('[data-sc]', el).forEach(b => b.onclick = () => { txF.scope = b.dataset.sc; renderTx(); });
  $$('[data-ty]', el).forEach(b => b.onclick = () => { txF.type = b.dataset.ty; txF.line = ''; if (b.dataset.ty === 'inc') txF.cat = ''; renderTx(); });
  $$('[data-lf]', el).forEach(b => b.onclick = () => { txF.line = b.dataset.lf; renderTx(); });
  $$('[data-cf]', el).forEach(b => b.onclick = () => { txF.cat = b.dataset.cf; if (txF.cat && txF.type === 'inc') txF.type = 'all'; renderTx(); });
  const ta = $('#tx-add'); if (ta) ta.onclick = () => txSheet();
  bindTx(el);
}

/* ---------- ADD / EDIT ---------- */
function parseAmt(s) {
  s = String(s ?? '').trim(); if (!s) return NaN;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s) || /-$/.test(s) || /^\$-/.test(s);
  s = s.replace(/^(USD|US\$)/i, '').replace(/[()$,\s]/g, '').replace(/^[-+]/, '').replace(/-$/, '');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  const v = parseFloat(s); return neg ? -v : v;
}
function txSheet(t, preset = {}) {
  const edit = !!t;
  let ty = t ? t.type : preset.type || 'exp';
  let sel = t ? t.cat : preset.cat || '';
  const defDate = t ? t.date : preset.date || (vMK === curMK() ? today() : vMK + '-01');
  const amtVal = t ? String(t.amt) : preset.amt ? String(preset.amt) : '';
  openSheet(`<h3>${edit ? (t.type === 'inc' ? 'Edit payment' : 'Edit transaction') : preset.replace ? 'Replace payment' : preset.type === 'inc' ? 'Log income' : 'Add transaction'}${edit && t.src === 'bill' ? '<span class="tag">AUTO BILL</span>' : ''}</h3>
  <div class="seg"><button data-tt="exp" class="${ty === 'exp' ? 'on' : ''}">Expense</button><button data-tt="inc" class="${ty === 'inc' ? 'on' : ''}">Income</button></div>
  <div class="amtin" id="f-amtw"><span>$</span><input id="f-amt" inputmode="decimal" enterkeyhint="done" autocomplete="off" placeholder="0" value="${esc(amtVal)}" aria-label="Amount"></div>
  <input id="f-note" placeholder="What was it? (optional)" value="${esc(t ? t.note || '' : preset.note || '')}" autocomplete="off" maxlength="80" aria-label="Note">
  <div class="row" style="margin-top:8px"><input type="date" id="f-date" value="${esc(defDate)}" aria-label="Date"><input id="f-card" placeholder="Card (last 4)" inputmode="numeric" maxlength="4" value="${esc(t ? t.card || '' : '')}" aria-label="Card last 4"></div>
  <div class="iwarn hide" id="f-warn" role="alert"></div>
  <div class="hint" id="f-hint">${edit ? 'Category' : preset.replace ? 'Tap the line to save. This replaces what was logged.' : 'Tap a category to save'}</div>
  <div class="cgrid" id="f-cats"></div>
  ${edit ? `<div class="row" style="margin-top:16px"><button class="dng" id="f-del">Delete</button><button class="pri" id="f-save">Save</button></div>` : ''}`, sh => {
    const amt = $('#f-amt', sh), dateI = $('#f-date', sh); let warned = '';
    const drawCats = () => {
      let items;
      if (ty === 'exp') items = S.cats.map(c => ({ id: c.id, html: badge(c), name: esc(c.name) }));
      else {
        const m = monthData((dateI.value || defDate).slice(0, 7));
        items = m.income.map(l => ({ id: l.id, html: incBadge(), name: esc(l.name) + (l.hourly ? ` <span class="tiny">$${esc(S.settings.rate)}/hr</span>` : '') })).concat([{ id: OTHER_INC, html: incBadge(), name: 'Other income' }]);
      }
      if (edit && !items.find(i => i.id === sel)) sel = items[0].id;
      $('#f-cats', sh).innerHTML = items.map(i => `<button class="cbtn ${(edit || preset.cat) && sel === i.id ? 'on' : ''}" data-cat="${esc(i.id)}">${i.html}<span>${i.name}</span></button>`).join('');
      $$('[data-cat]', sh).forEach(b => b.onclick = () => {
        sel = b.dataset.cat;
        if (edit) { $$('[data-cat]', sh).forEach(x => x.classList.toggle('on', x === b)); return; }
        commit();
      });
    };
    const commit = () => {
      const v = parseAmt(amt.value);
      if (!isFinite(v) || v === 0) { const w = $('#f-amtw', sh); w.classList.remove('err'); void w.offsetWidth; w.classList.add('err'); amt.focus(); return; }
      const date = /^\d{4}-\d\d-\d\d$/.test(dateI.value) ? dateI.value : defDate;
      const rec = { type: ty, amt: r2(v), cat: sel || (ty === 'exp' ? UNCAT : OTHER_INC), note: $('#f-note', sh).value.trim(), date, card: $('#f-card', sh).value.replace(/\D/g, '').slice(0, 4) };
      if (edit) { if (rec.cat !== t.cat || rec.type !== t.type) delete t.rawCat; Object.assign(t, rec); save(); closeSheet(); render(); toast('Saved'); return; }
      const n = { id: uid(), ts: Date.now(), created: nowISO(), src: 'app', ...rec };
      if (ty === 'inc' && !preset.ack && !preset.replace) { // same amount on the same line within 3 days = probably a double log
        const d0 = parseD(date).getTime(), dup = S.txns.find(x => x.type === 'inc' && x.cat === n.cat && cents(x.amt) === cents(n.amt) && Math.abs(parseD(x.date).getTime() - d0) <= 3 * 864e5);
        const key = n.cat + '|' + cents(n.amt) + '|' + date;
        if (dup && warned !== key) {
          warned = key; const lbl = incLineName(n), w = $('#f-warn', sh);
          w.textContent = `Possible double log: ${money(dup.amt)} to ${lbl} was already logged on ${fmtShort(dup.date)}. Tap ${lbl} again to save anyway.`;
          w.classList.remove('hide'); return;
        }
      }
      const old = preset.replace ? S.txns.filter(x => preset.replace.includes(x.id)) : [];
      if (old.length) S.txns = S.txns.filter(x => !preset.replace.includes(x.id));
      touchMonth(date.slice(0, 7));
      S.txns.push(n); save(); closeSheet(); render();
      const lbl = ty === 'exp' ? catById(n.cat).name : incLineName(n);
      toast(`${old.length ? 'Replaced with' : ty === 'exp' ? 'Added' : 'Logged'} ${money(n.amt)} · ${lbl}`, 'Undo', () => { S.txns = S.txns.filter(x => x.id !== n.id).concat(old); save(); render(); });
    };
    $$('[data-tt]', sh).forEach(b => b.onclick = () => { ty = b.dataset.tt; if (!edit) sel = ''; $$('[data-tt]', sh).forEach(x => x.classList.toggle('on', x === b)); drawCats(); });
    dateI.onchange = () => { if (ty === 'inc') drawCats(); };
    drawCats();
    amt.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); if (edit || sel) commit(); else $('#f-note', sh).focus(); } });
    if (edit) { $('#f-save', sh).onclick = commit; $('#f-del', sh).onclick = () => { closeSheet(); delTx(t.id); }; }
    else amt.focus({ preventScroll: true });
  });
}

/* ---------- PLAN ---------- */
const chk = (id, on, text) => `<label style="display:flex;gap:10px;align-items:center;color:#ddd;font-size:14px"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}> ${text}</label>`;
function renderPlan() {
  const el = $('#v-plan'), mk = vMK, st = stats(mk), m = st.m;
  let h = `<div class="seg"><button data-pt="cats" class="${planTab === 'cats' ? 'on' : ''}">Budgets</button><button data-pt="inc" class="${planTab === 'inc' ? 'on' : ''}">Income</button><button data-pt="bills" class="${planTab === 'bills' ? 'on' : ''}">Bills</button></div>`;
  if (planTab === 'cats') {
    const unassigned = r2(st.plannedInc - st.budget), prev = mkAdd(mk, -1);
    h += `<div class="card hero"><div class="eyebrow">${esc(mkLabel(mk, true))} plan</div><div class="xl" style="font-size:36px">${money(st.budget)}</div>
    <div class="sub">budgeted of ${money(st.plannedInc)} planned income · <span class="${unassigned < 0 ? 'red' : 'grn'}">${unassigned < 0 ? money(-unassigned) + ' over-planned' : money(unassigned) + ' unassigned'}</span></div>
    <div class="row" style="margin-top:14px"><button id="p-copy">Copy ${MN[+prev.slice(5) - 1].slice(0, 3)}</button><button id="p-addc">+ Category</button></div></div>
    <div class="card">${S.cats.map(c => {
      const b = +m.budgets[c.id] || 0, s = st.byCat[c.id] || 0, cls = barCls(s, b);
      return `<div class="prow">${badge(c)}<div class="mid" data-ec="${esc(c.id)}" style="cursor:pointer"><b>${esc(c.name)}${c.save ? ' <span class="tag">SAVINGS</span>' : ''}</b><span class="tiny ${cls}">${money(s)} spent${b ? ' · ' + Math.round(s / b * 100) + '%' : ''}</span></div>
      <div class="money-in"><input class="num" inputmode="decimal" data-b="${esc(c.id)}" value="${b ? r2(b) : ''}" placeholder="0" aria-label="${esc(c.name)} budget"></div></div>`;
    }).join('')}</div><div class="sub" style="margin:0 6px">Tap a category name to rename, recolor or delete it. Budgets here are for ${esc(mkLabel(mk))}; each new month starts as a copy of the month before.</div>`;
  } else if (planTab === 'inc') {
    const lines = m.income.map((l, i) => ({ l, i, id: l.id }));
    if (st.byInc[OTHER_INC]) lines.push({ l: null, i: -1, id: OTHER_INC });
    h += `<div class="card hero"><div class="eyebrow">${esc(mkLabel(mk, true))} income</div><div class="xl" style="font-size:36px">${money(st.inc)}</div>
    <div class="sub">received of ${money(st.plannedInc)} planned</div><div class="bar"><i class="grn" data-w="${pct(st.inc, st.plannedInc)}"></i></div></div>
    <div class="card ilist">${lines.map(x => incLineHTML(x, st)).join('')}</div><button id="p-addi" style="width:100%">+ Income line</button>
    <div class="sub" style="margin:10px 6px;line-height:1.45">Tap <b>Log</b> when a paycheck lands. Tap a line to see its payments, fix or delete one, or change what you planned. Hourly lines estimate pay as hours × $${esc(S.settings.rate)}/hr.</div>`;
  } else {
    const rec = S.recurring.slice().sort((a, b) => a.day - b.day);
    h += `<div class="card hero"><div class="eyebrow">Recurring bills</div><div class="xl" style="font-size:36px">${money(sum(rec.filter(r => r.active).map(r => r.amt)))}</div><div class="sub">a month · added automatically when each month starts</div></div>
    <div class="card">${rec.map(r => { const c = catById(r.cat); return `<div class="prow" data-er="${esc(r.id)}" style="cursor:pointer;${r.active ? '' : 'opacity:.45'}">${badge(c)}<div class="mid"><b>${esc(r.name)}</b><span class="tiny">Day ${r.day} · ${esc(c.name)}${r.active ? '' : ' · paused'}</span></div><b>${money(r.amt)}</b></div>`; }).join('') || '<div class="sub">No recurring bills yet. Add rent, car payment, Roth IRA, memberships…</div>'}</div>
    <button id="p-addr" style="width:100%">+ Recurring bill</button>`;
  }
  el.innerHTML = h;
  animBars('#v-plan');
  $$('[data-pt]', el).forEach(b => b.onclick = () => { planTab = b.dataset.pt; renderPlan(); });
  const numIn = (attr, f) => $$(`[data-${attr}]`, el).forEach(i => i.onchange = () => { const v = parseAmt(i.value); f(i.dataset[attr], isFinite(v) ? Math.max(0, r2(v)) : 0); save(); renderPlan(); });
  numIn('b', (id, v) => { M(mk).budgets[id] = v; });
  numIn('ip', (i, v) => { M(mk).income[+i].planned = v; });
  numIn('h', (i, v) => { M(mk).income[+i].hours = v; });
  $$('[data-log]', el).forEach(b => b.onclick = e => { e.stopPropagation(); const i = +b.dataset.log; logIncome(i >= 0 ? m.income[i] : null); });
  $$('[data-ix]', el).forEach(d => d.onclick = () => { const id = d.dataset.ix, open = d.closest('.iline').classList.contains('open'); if (open) { incOpen.delete(id); incShut.add(id); } else { incOpen.add(id); incShut.delete(id); } renderPlan(); });
  bindTx(el);
  $$('[data-ec]', el).forEach(d => d.onclick = () => catSheet(S.cats.find(c => c.id === d.dataset.ec)));
  $$('[data-el]', el).forEach(d => d.onclick = () => incSheet(+d.dataset.el));
  $$('[data-er]', el).forEach(d => d.onclick = () => recSheet(S.recurring.find(r => r.id === d.dataset.er)));
  const on = (id, f) => { const x = $('#' + id, el); if (x) x.onclick = f; };
  on('p-copy', () => {
    const prev = mkAdd(mk, -1), pm = S.months[prev];
    if (!pm) return toast('Nothing saved for ' + mkLabel(prev));
    M(mk).budgets = { ...pm.budgets }; save(); renderPlan(); toast('Copied the ' + mkLabel(prev) + ' budget');
  });
  on('p-addc', () => catSheet(null));
  on('p-addi', () => incSheet(-1));
  on('p-addr', () => recSheet(null));
}
const IC_EDIT = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const IC_TRASH = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
const linePays = (id, mk) => S.txns.filter(t => t.type === 'inc' && t.cat === id && t.date.startsWith(mk)).sort((a, b) => a.date.localeCompare(b.date) || (a.ts || 0) - (b.ts || 0));
const overRx = (got, pl) => pl > 0 && got > pl * 1.5;
function incLineHTML(x, st) {
  const { l, i, id } = x, name = l ? l.name : 'Other income', ps = linePays(id, vMK), got = r2(sum(ps.map(t => t.amt))), pl = l ? plannedOf(l) : 0;
  const over = overRx(got, pl), open = incOpen.has(id) || (over && !incShut.has(id));
  const status = !ps.length ? `<span class="sub">Not logged yet${l && l.payDate ? ' · due ' + fmtShort(l.payDate) : ''}${pl ? ' · ' + money(pl) + ' planned' : ''}</span>`
    : ps.length === 1 ? `<span class="grn">Logged ${money(got)} on ${fmtShort(ps[0].date)}</span>${pl ? ` <span class="sub">· of ${money(pl)}</span>` : ''}`
    : `<span class="grn">Logged ${money(got)}</span> <span class="sub">· ${ps.length} payments${pl ? ' · of ' + money(pl) : ''}</span>`;
  const icon = !ps.length ? '<span class="ist" aria-hidden="true"></span>' : `<span class="ist ${over ? 'warn' : 'ok'}" aria-hidden="true">${over ? '!' : '✓'}</span>`;
  const right = !ps.length && l ? `<button class="sm pri" data-log="${i}" aria-label="Log ${esc(name)}">Log</button>` : `<span class="chev" aria-hidden="true">›</span>`;
  let body = '';
  if (open) {
    body = `<div class="ixp">${ps.map(payRow).join('') || `<div class="sub" style="padding:4px 2px 10px">No payments logged for ${esc(name)} in ${esc(mkLabel(vMK))}.</div>`}
    <button class="ilog" data-log="${i}">${ps.length ? '+ Log another payment' : '+ Log payment'}</button>
    ${l ? `<div class="iplan"><span class="tiny">${l.hourly ? 'Hours this month × $' + esc(S.settings.rate) + ' = <b style="color:#fff">' + money0(plannedOf(l)) + '</b>' : 'Planned for ' + esc(mkLabel(vMK))}</span>
      ${l.hourly ? `<input class="hrs" inputmode="decimal" data-h="${i}" value="${+l.hours || ''}" placeholder="hrs" aria-label="${esc(name)} hours">` : `<div class="money-in"><input class="num" inputmode="decimal" data-ip="${i}" value="${+l.planned || ''}" placeholder="0" aria-label="${esc(name)} planned"></div>`}</div>
    <button class="lnk sub" data-el="${i}" style="margin-top:4px">Rename, pay date, or remove line ›</button>` : ''}</div>`;
  }
  return `<div class="iline${open ? ' open' : ''}${over ? ' over' : ''}" data-line="${esc(id)}"><div class="ihead" data-ix="${esc(id)}" role="button" aria-expanded="${open}">${icon}<div class="mid"><b>${esc(name)}</b><span class="tiny">${status}</span></div>${right}</div>
  ${over ? `<div class="iwarn">⚠ ${money(got)} is ${Math.round(got / pl * 100)}% of the ${money(pl)} planned. Logged twice? Delete the extra payment below.</div>` : ''}${body}</div>`;
}
function payRow(t) {
  const tags = (t.src === 'finny' ? '<span class="tag">FINNY</span>' : '') + (t.src === 'import' ? '<span class="tag">IMPORTED</span>' : '') + (t.src === 'migrated' ? '<span class="tag">SHEET</span>' : '');
  return `<div class="swr pay" data-id="${esc(t.id)}"><div class="swa"><button class="ed" data-e="${esc(t.id)}">Edit</button><button class="dl" data-d="${esc(t.id)}">Delete</button></div>
  <div class="swf tx" data-t="${esc(t.id)}"><div class="mid"><div class="t1">${money(t.amt)}${tags}</div><div class="t2">${esc(fmtShort(t.date))}${t.note ? ' · ' + esc(t.note) : ''}</div></div>
  <button class="ib" data-e="${esc(t.id)}" aria-label="Edit ${money(t.amt)} payment">${IC_EDIT}</button><button class="ib del" data-d="${esc(t.id)}" aria-label="Delete ${money(t.amt)} payment">${IC_TRASH}</button></div></div>`;
}
function logIncome(l) {
  const id = l ? l.id : OTHER_INC, name = l ? l.name : 'Other income', ps = linePays(id, vMK);
  const preset = { type: 'inc', cat: id, amt: l ? plannedOf(l) || '' : '', note: l ? l.name : '' };
  if (!ps.length) return txSheet(null, preset);
  const last = ps[ps.length - 1], got = r2(sum(ps.map(t => t.amt)));
  const msg = ps.length === 1 ? `${name} already has ${money(last.amt)} logged on ${fmtShort(last.date)}. Add another?`
    : `${name} already has ${ps.length} payments (${money(got)}) logged in ${mkLabel(vMK)}, the latest ${money(last.amt)} on ${fmtShort(last.date)}. Add another?`;
  openSheet(`<h3>Already logged</h3><div class="sub" id="dup-msg" style="line-height:1.45;font-size:15px">${esc(msg)}</div>
  <div class="stack" style="margin-top:18px"><button class="pri" id="dup-rep">Replace ${ps.length > 1 ? 'all ' + ps.length + ' with one payment' : 'it'}</button><button id="dup-add">Add another</button><button class="lnk sub" id="dup-x" style="margin-top:4px">Cancel</button></div>`, sh => {
    $('#dup-x', sh).onclick = closeSheet;
    $('#dup-add', sh).onclick = () => txSheet(null, { ...preset, ack: true });
    $('#dup-rep', sh).onclick = () => txSheet(null, { ...preset, amt: last.amt, date: last.date, note: last.note || preset.note, replace: ps.map(t => t.id) });
  });
}
function catSheet(c) {
  const isNew = !c, used = c ? S.txns.filter(t => t.type === 'exp' && t.cat === c.id).length : 0;
  let color = c ? c.color : PALETTE[(S.cats.length - 1) % PALETTE.length];
  openSheet(`<h3>${isNew ? 'New category' : 'Edit category'}</h3>
  <label>Name</label><input id="c-name" value="${esc(c ? c.name : '')}" maxlength="32" placeholder="e.g. Dining out">
  ${isNew ? `<label>Budget for ${esc(mkLabel(vMK))}</label><div class="money-in"><input id="c-bud" inputmode="decimal" placeholder="0"></div>` : ''}
  <label>Color</label><div class="chips" style="flex-wrap:wrap">${PALETTE.map(p => `<button class="chip" data-col="${p}" style="width:34px;padding:0;background:${p};outline:${p === color ? '2px solid #fff' : 'none'};outline-offset:2px" aria-label="Color ${p}"></button>`).join('')}</div>
  ${chk('c-save', c && c.save, 'Counts as savings (Roth IRA, savings account…)')}
  <div class="row" style="margin-top:16px">${!isNew && c.id !== UNCAT ? '<button class="dng" id="c-del">Delete</button>' : ''}<button class="pri" id="c-ok">${isNew ? 'Add category' : 'Save'}</button></div>`, sh => {
    $$('[data-col]', sh).forEach(b => b.onclick = () => { color = b.dataset.col; $$('[data-col]', sh).forEach(x => x.style.outline = x === b ? '2px solid #fff' : 'none'); });
    $('#c-ok', sh).onclick = () => {
      const name = $('#c-name', sh).value.trim(); if (!name) return $('#c-name', sh).focus();
      if (S.cats.some(x => x !== c && x.name.toLowerCase() === name.toLowerCase())) return toast('A category with that name already exists');
      if (isNew) {
        const id = uid(); S.cats.splice(Math.max(0, S.cats.findIndex(x => x.id === UNCAT)), 0, { id, name, color, save: $('#c-save', sh).checked });
        const v = parseAmt($('#c-bud', sh).value); M(vMK).budgets[id] = isFinite(v) ? Math.max(0, r2(v)) : 0;
      } else Object.assign(c, { name, color, save: $('#c-save', sh).checked });
      save(); closeSheet(); render();
    };
    const d = $('#c-del', sh); if (d) d.onclick = () => {
      if (!confirm(`Delete "${c.name}"?${used ? ` Its ${used} transaction${used > 1 ? 's' : ''} will move to Uncategorized.` : ''}`)) return;
      S.txns.forEach(t => { if (t.type === 'exp' && t.cat === c.id) t.cat = UNCAT; });
      S.recurring.forEach(r => { if (r.cat === c.id) r.cat = UNCAT; });
      S.cats = S.cats.filter(x => x !== c); Object.values(S.months).forEach(m => delete m.budgets[c.id]);
      save(); closeSheet(); render();
    };
  });
}
function incSheet(i) {
  const m = M(vMK), l = i >= 0 ? m.income[i] : null;
  openSheet(`<h3>${l ? 'Edit income line' : 'New income line'}</h3>
  <label>Name</label><input id="i-name" value="${esc(l ? l.name : '')}" maxlength="32" placeholder="e.g. Paycheck 1">
  <label>Pay date (${esc(mkLabel(vMK))})</label><input type="date" id="i-date" value="${esc(l ? l.payDate : '')}">
  ${chk('i-hr', l && l.hourly, `Hourly: estimate from hours × $${esc(S.settings.rate)}/hr`)}
  <div class="row" style="margin-top:16px">${l ? '<button class="dng" id="i-del">Remove</button>' : ''}<button class="pri" id="i-ok">${l ? 'Save' : 'Add'}</button></div>`, sh => {
    $('#i-ok', sh).onclick = () => {
      const name = $('#i-name', sh).value.trim(); if (!name) return $('#i-name', sh).focus();
      const d = $('#i-date', sh).value, rec = { name, payDate: /^\d{4}-\d\d-\d\d$/.test(d) ? d : '', hourly: $('#i-hr', sh).checked };
      if (l) Object.assign(l, rec); else m.income.push({ id: uid(), planned: 0, hours: 0, ...rec });
      save(); closeSheet(); render();
    };
    const d = $('#i-del', sh); if (d) d.onclick = () => { if (!confirm(`Remove "${l.name}" from ${mkLabel(vMK)}? Income you already logged stays.`)) return; m.income.splice(i, 1); save(); closeSheet(); render(); };
  });
}
function recSheet(r) {
  openSheet(`<h3>${r ? 'Edit recurring bill' : 'New recurring bill'}</h3>
  <label>Name</label><input id="r-name" value="${esc(r ? r.name : '')}" maxlength="40" placeholder="e.g. Rent">
  <div class="row"><div><label>Amount</label><div class="money-in"><input id="r-amt" inputmode="decimal" value="${r ? r.amt : ''}" placeholder="0"></div></div><div><label>Day of month</label><input id="r-day" inputmode="numeric" value="${r ? r.day : 1}"></div></div>
  <label>Category</label><select id="r-cat">${S.cats.map(c => `<option value="${esc(c.id)}" ${r && r.cat === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
  <div style="margin-top:12px">${r ? chk('r-act', r.active, 'Active') : chk('r-now', true, `Also add it to ${esc(mkLabel(curMK()))}`)}</div>
  <div class="sub" style="margin-top:8px">Bills are added once a month. Editing a bill doesn't change ones already added.</div>
  <div class="row" style="margin-top:16px">${r ? '<button class="dng" id="r-del">Delete</button>' : ''}<button class="pri" id="r-ok">${r ? 'Save' : 'Add bill'}</button></div>`, sh => {
    if (!r) { const nm = $('#r-name', sh); nm.oninput = () => { const c = S.cats.find(c => c.name.toLowerCase() === nm.value.trim().toLowerCase()); if (c) $('#r-cat', sh).value = c.id; }; }
    $('#r-ok', sh).onclick = () => {
      const name = $('#r-name', sh).value.trim(), amt = parseAmt($('#r-amt', sh).value), day = Math.min(31, Math.max(1, parseInt($('#r-day', sh).value) || 1));
      if (!name) return $('#r-name', sh).focus();
      if (!isFinite(amt) || amt <= 0) return $('#r-amt', sh).focus();
      const rec = { name, amt: r2(amt), day, cat: $('#r-cat', sh).value };
      if (r) { const was = r.active; Object.assign(r, rec, { active: $('#r-act', sh).checked }); if (r.active && !was) { r.start = curMK(); r.last = mkAdd(curMK(), -1); } }
      else S.recurring.push({ id: uid(), ...rec, active: true, start: $('#r-now', sh).checked ? curMK() : mkAdd(curMK(), 1) });
      const n = runRecurring(); save(); closeSheet(); render(); if (n) toast(`Added ${n} bill${n > 1 ? 's' : ''} to ${mkLabel(curMK())}`);
    };
    const d = $('#r-del', sh); if (d) d.onclick = () => { if (!confirm(`Delete "${r.name}"? Bills already added stay in your history.`)) return; S.recurring = S.recurring.filter(x => x !== r); save(); closeSheet(); render(); };
  });
}

/* ---------- YEAR ---------- */
function renderYear() {
  const y = vYear, months = Array.from({ length: 12 }, (_, i) => y + '-' + pad(i + 1));
  const ss = months.map(mk => ({ mk, has: !!S.months[mk] || S.txns.some(t => t.date.startsWith(mk)) })).map(o => o.has ? { mk: o.mk, has: true, ...stats(o.mk) } : { mk: o.mk, has: false, spent: 0, inc: 0, budget: 0, saved: 0, byCat: {}, net: 0 });
  const tInc = sum(ss.map(s => s.inc)), tSp = sum(ss.map(s => s.spent)), tSaved = sum(ss.map(s => s.saved)), tNet = tInc - tSp;
  const W = 330, H = 150, maxV = Math.max(1, ...ss.map(s => Math.max(s.inc, s.spent))) * 1.08, bw = W / 12;
  const yy = v => H - 18 - v / maxV * (H - 28);
  const bars = ss.map((s, i) => {
    const x0 = i * bw + bw * 0.16, w = bw * 0.32;
    return `<g class="mrow" data-mk="${s.mk}"><rect x="${(i * bw).toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="${H}" fill="transparent"/>
    <rect x="${x0.toFixed(1)}" y="${yy(s.inc).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0, H - 18 - yy(s.inc)).toFixed(1)}" rx="2.5" fill="#30d158"/><rect x="${(x0 + w + 1.5).toFixed(1)}" y="${yy(s.spent).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0, H - 18 - yy(s.spent)).toFixed(1)}" rx="2.5" fill="${s.budget && s.spent > s.budget ? '#ff453a' : '#e5e5ea'}"/>
    <text x="${(i * bw + bw / 2).toFixed(1)}" y="${H - 3}" text-anchor="middle" ${s.mk === curMK() ? 'style="fill:#fff;font-weight:700"' : ''}>${MN[i][0]}</text></g>`;
  }).join('');
  const catT = S.cats.map(c => ({ c, v: sum(ss.map(s => s.byCat[c.id] || 0)), b: sum(months.map(mk => +(S.months[mk]?.budgets[c.id]) || 0)) })).filter(x => x.v || x.b).sort((a, b) => b.v - a.v);
  const maxC = Math.max(1, ...catT.map(x => x.v));
  const rate = tInc > 0 ? Math.round(tSaved / tInc * 100) : null;
  const h = `<div class="card hero ${tNet < 0 ? 'over' : ''}"><div class="eyebrow">${y} · left over</div><div class="xl ${tNet < 0 ? 'red' : ''}">${money(tNet)}</div><div class="sub">income minus spending, all year</div>
   <div class="stats"><div class="stat"><span>Income</span><b class="grn">${money0(tInc)}</b></div><div class="stat"><span>Spent</span><b>${money0(tSp)}</b></div><div class="stat"><span>Saved</span><b>${money0(tSaved)}</b><small>${rate == null ? '—' : rate + '% of income'}</small></div></div></div>
  <div class="g2"><div><div class="card chart"><div class="ctitle"><b>Income vs spending</b><span class="tiny"><span class="dot" style="background:#30d158"></span> in &nbsp; <span class="dot" style="background:#e5e5ea"></span> out</span></div>
  <svg viewBox="0 0 ${W} ${H}" class="ybars" role="img" aria-label="Monthly income and spending">${bars}</svg><div class="tiny" style="margin-top:6px">Tap a month to open it. Red bars went over budget.</div></div>
  <h2>By category</h2><div class="card">${catT.map(x => `<div class="crow" style="cursor:default">${badge(x.c, 'sm')}<div class="mid"><div class="nm"><span>${esc(x.c.name)}</span><span>${money0(x.v)}</span></div><div class="bar" style="height:5px"><i style="background:${esc(x.c.color)}" data-w="${x.v / maxC * 100}"></i></div><div class="meta"><span>${x.b ? 'budget ' + money0(x.b) : ''}</span><span class="${barCls(x.v, x.b)}">${x.b ? Math.round(x.v / x.b * 100) + '% used' : ''}</span></div></div></div>`).join('') || '<div class="sub">No spending in ' + y + '.</div>'}</div></div>
  <div><h2>Months</h2><div class="card">${ss.filter(s => s.has && (s.inc || s.spent)).map(s => `<div class="kv mrow" data-mk="${s.mk}"><span>${MN[+s.mk.slice(5) - 1]}</span><span><span class="grn">+${money0(s.inc)}</span> <span class="sub">·</span> −${money0(s.spent)} <span class="sub">·</span> <b class="${s.net < 0 ? 'red' : ''}">${s.net < 0 ? '−' : ''}${money0(Math.abs(s.net))}</b></span></div>`).join('') || '<div class="sub">Nothing logged in ' + y + ' yet.</div>'}</div></div></div>`;
  $('#v-year').innerHTML = h;
  animBars('#v-year');
  $$('#v-year [data-mk]').forEach(g => g.addEventListener('click', () => { vMK = g.dataset.mk; go('home'); }));
}

/* ---------- SETTINGS ---------- */
function renderSet() {
  const n = S.txns.length, kb = Math.max(1, Math.round((localStorage.getItem(KEY) || '').length / 1024));
  const sheetCard = inSheet() ? `<div class="seg"><button class="on" data-mode="sheet">Google Sheet</button><button data-mode="local">This device only</button></div>
   <label style="margin-top:0">Spreadsheet link or ID</label><input id="s-sid" value="${esc(SY.sheetId)}" autocomplete="off" placeholder="https://docs.google.com/spreadsheets/d/…">
   <div class="sub" id="set-sync" style="margin:10px 2px">${esc(syncText())}</div>
   <div class="row"><button class="pri" id="s-sync">${hasToken() ? 'Sync now' : 'Sign in with Google'}</button>${hasToken() ? '<button id="s-out">Sign out</button>' : ''}</div>
   <a class="sub" id="s-open" href="https://docs.google.com/spreadsheets/d/${encodeURIComponent(SY.sheetId)}/edit" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin-top:12px;color:#fff">Open the spreadsheet ↗</a>`
    : `<div class="seg"><button data-mode="sheet">Google Sheet</button><button class="on" data-mode="local">This device only</button></div>
   <div class="sub" style="line-height:1.45">Right now your budget is stored only in this browser. Connect a Google Sheet to keep it in your Google account and let your assistant add transactions.</div>`;
  $('#v-set').innerHTML = `<h2>Storage</h2><div class="card">${sheetCard}</div>
  <h2>Pay</h2><div class="card"><label style="margin-top:0">Hourly rate (used by hourly income lines)</label><div class="row"><div class="money-in" style="flex:1"><input id="s-rate" inputmode="decimal" value="${esc(S.settings.rate)}"></div><button class="pri" id="s-save" style="flex:none">Save</button></div></div>
  <h2>Import</h2><div class="card"><button class="pri" id="s-imp" style="width:100%">Import CSV or JSON</button>
   <div class="sub" style="margin-top:10px;line-height:1.45">Bank and card CSVs (you pick the columns), Stacked CSV/JSON files, or a full backup. Duplicates are detected and skipped.</div>
   <button class="lnk sub" id="s-fmt" style="margin-top:8px">Stacked CSV format ›</button><div id="fmt" class="hide"><pre>date,type,category,amount,note,card
2026-01-02,expense,Groceries,54.20,Corner Market,1234
2026-01-06,income,Paycheck 1,1500.00,,</pre><div class="sub" style="line-height:1.45">type is <code>expense</code> or <code>income</code>. category matches a category name, or an income line for income. Unknown categories go to Uncategorized. Dates can be YYYY-MM-DD or MM/DD/YYYY. An optional <code>id</code> column makes re-imports exact.</div></div></div>
  <h2>Backup &amp; export</h2><div class="card"><div class="row"><button id="s-json">Backup (JSON)</button><button id="s-csv">Export CSV</button></div>
   <button id="s-rest" style="width:100%;margin-top:8px">Restore from backup</button>
   <div class="sub" style="margin-top:10px">${n} transaction${n === 1 ? '' : 's'} · ${kb} KB on this device. Back up now and then: clearing Safari's website data erases it.</div></div>
  <h2>Demo</h2><div class="card"><button id="s-demo" style="width:100%">Load demo data (fake numbers)</button><div class="sub" style="margin-top:8px">Replaces what's here with made-up sample data so you can try things out.</div></div>
  <h2>Privacy</h2><div class="card"><div class="sub" style="line-height:1.5">Stacked has no server, analytics or trackers. ${inSheet() ? 'Your data goes straight from this browser to your own Google Sheet (and a copy stays here for offline use). Nothing else sees it.' : 'In device-only mode your budget lives only in this browser.'} The app's files are public, but your numbers and your sheet ID are never in them.</div>
   <button class="dng" id="s-wipe" style="width:100%;margin-top:12px">${inSheet() ? 'Disconnect & remove this device\'s copy' : 'Erase all data on this device'}</button></div>
  <div class="tiny" style="text-align:center;margin:18px 0 6px">Stacked v${VER} · a sibling of Clocked</div>`;
  if (inSheet() || SY.sheetId) loadGis().catch(() => { });
  $$('[data-mode]').forEach(b => b.onclick = () => {
    if (b.dataset.mode === 'sheet' && !inSheet()) { if (SY.sheetId) connectSheet(SY.sheetId); else promptSheetId(); }
    if (b.dataset.mode === 'local' && inSheet()) { if (!confirm('Stop syncing on this device? Your Google Sheet stays as it is. This device switches to its separate device-only data.')) return; clearToken(); setMode('local'); go('set'); }
  });
  const ss = $('#s-sync'); if (ss) ss.onclick = () => {
    const id = sheetIdFrom($('#s-sid').value);
    if (!id) return toast('That doesn\'t look like a Google Sheets link or ID');
    if (id !== SY.sheetId || !hasToken()) connectSheet(id); else { sync('manual'); toast('Syncing…'); }
  };
  const so = $('#s-out'); if (so) so.onclick = () => { signOut(); go('set'); toast('Signed out of Google. Your sheet is unchanged.'); };
  $('#s-save').onclick = () => { const v = parseAmt($('#s-rate').value); if (!isFinite(v) || v <= 0) return toast('Enter a valid rate'); S.settings.rate = r2(v); save(); toast('Rate saved: ' + money(v) + '/hr'); };
  $('#s-imp').onclick = () => pickFile();
  $('#s-rest').onclick = () => pickFile();
  $('#s-fmt').onclick = () => $('#fmt').classList.toggle('hide');
  $('#s-json').onclick = exportJSON;
  $('#s-csv').onclick = exportCSV;
  $('#s-demo').onclick = loadDemo;
  $('#s-wipe').onclick = clearAll;
}
function clearAll() {
  if (inSheet()) {
    const n = pendingCount();
    if (!confirm(n ? `Disconnect this device? ${n} change${n > 1 ? 's' : ''} haven't reached your Google Sheet yet. They stay saved on this device and sync when you reconnect. Your sheet is not changed.` : 'Disconnect and remove the copy stored on this device? Your Google Sheet is not changed.')) return;
    if (!n) { try { localStorage.removeItem(cacheKey(SY.sheetId)); } catch (e) { } idbSafe('cache:' + SY.sheetId, undefined); }
    signOut(); setMode('local'); vMK = curMK(); go('home'); toast(n ? 'Disconnected. Unsynced changes kept on this device.' : 'Disconnected. Your sheet is untouched.'); return;
  }
  if (!confirm(S.demo ? 'Clear the demo data?' : 'Erase ALL budget data on this device? Make a backup first if you might want it back.')) return;
  S = blank(); save(); vMK = curMK(); rollover(); go('home'); toast('All clear');
}

/* ---------- export ---------- */
function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function exportJSON() { download(`stacked-backup-${today()}.json`, JSON.stringify({ app: APP, version: VER, exported: new Date().toISOString(), data: S }, null, 1), 'application/json'); toast('Backup downloaded'); }
const csvCell = v => { let s = String(v ?? ''); if (/^[=+@]/.test(s) || (/^-/.test(s) && isNaN(+s))) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function exportCSV() {
  const rows = [['date', 'type', 'category', 'amount', 'note', 'card', 'id']];
  S.txns.slice().sort((a, b) => a.date.localeCompare(b.date)).forEach(t => rows.push([t.date, t.type === 'inc' ? 'income' : 'expense', t.type === 'inc' ? incLineName(t) : catById(t.cat).name, t.amt.toFixed(2), t.note || '', t.card || '', t.id]));
  download(`stacked-transactions-${today()}.csv`, rows.map(r => r.map(csvCell).join(',')).join('\r\n'), 'text/csv'); toast('CSV downloaded');
}

/* ---------- import ---------- */
function pickFile() {
  const f = $('#file'); f.value = '';
  f.onchange = () => { const file = f.files[0]; if (file) file.text().then(t => handleFile(file.name, t)).catch(() => toast('Could not read that file')); };
  f.click();
}
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const delim = [',', ';', '\t'].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}
function parseDateAny(s) {
  s = String(s ?? '').trim(); let m;
  const valid = (y, mo, d) => { const x = new Date(y, mo - 1, d); return x.getFullYear() === y && x.getMonth() === mo - 1 && x.getDate() === d ? ymd(x) : null; };
  if (/^\d{5}(\.\d+)?$/.test(s)) { const d = new Date(1899, 11, 30); d.setDate(d.getDate() + Math.floor(+s)); return ymd(d); } // spreadsheet serial date
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return valid(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/))) { let y = +m[3]; if (y < 100) y += 2000; return valid(y, +m[1], +m[2]); }
  if (!/[a-z]/i.test(s)) return null;
  const d = new Date(s); return isNaN(d) ? null : ymd(d);
}
const normV = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 18);
const dupKey = t => t.date + '|' + cents(Math.abs(t.amt)) + '|' + t.type + '|' + normV(t.note);
function classify(cands) {
  const ids = new Set(S.txns.map(t => t.id));
  const have = {}; S.txns.forEach(t => { const k = dupKey(t); have[k] = (have[k] || 0) + 1; });
  const loose = {}; S.txns.forEach(t => { const k = t.type + '|' + cents(Math.abs(t.amt)); (loose[k] = loose[k] || []).push(t.date); });
  const seen = {};
  for (const c of cands) {
    if (c.err) { c.status = 'err'; continue; }
    if (c.extId && ids.has(c.extId)) { c.status = 'dup'; continue; }
    const k = dupKey(c); seen[k] = (seen[k] || 0) + 1;
    if (seen[k] <= (have[k] || 0)) { c.status = 'dup'; continue; } // same date, amount, type & description already saved
    const near = (loose[c.type + '|' + cents(Math.abs(c.amt))] || []).some(d => Math.abs(parseD(d) - parseD(c.date)) <= 2 * 864e5);
    c.status = near ? 'maybe' : 'new'; // same amount within 2 days, different description (e.g. one you typed in by hand)
  }
  cands.forEach(c => c.pick = c.status === 'new');
  return cands;
}
function matchCat(name, type, date) {
  const n = String(name || '').trim().toLowerCase(); if (!n) return null;
  if (type === 'inc') {
    const l = monthData(date.slice(0, 7)).income.find(x => x.name.toLowerCase() === n); if (l) return l.id;
    for (const k of Object.keys(S.months)) { const x = S.months[k].income.find(i => i.name.toLowerCase() === n); if (x) return x.id; }
    return null;
  }
  const c = S.cats.find(c => c.name.toLowerCase() === n || c.id === n); return c ? c.id : null;
}
function handleFile(name, text) {
  if (/\.json$/i.test(name) || /^\s*[[{]/.test(text)) {
    let j; try { j = JSON.parse(text); } catch (e) { return toast('That JSON file could not be read'); }
    if (j && j.app === APP && j.data) return restoreSheet(j);
    const arr = Array.isArray(j) ? j : Array.isArray(j?.transactions) ? j.transactions : null;
    if (!arr) return toast('Unrecognized JSON. Expected a Stacked backup or a list of transactions.');
    const rows = [['date', 'type', 'category', 'amount', 'note', 'card', 'id']].concat(arr.map(t => [t.date, t.type, t.category ?? t.cat ?? '', t.amount ?? t.amt, t.note ?? t.vendor ?? t.description ?? '', t.card ?? '', t.id ?? ''].map(v => String(v ?? ''))));
    return importSheet(rows, name);
  }
  const rows = parseCSV(text);
  if (rows.length < 2) return toast('No rows found in that file');
  importSheet(rows, name);
}
function guessMap(hdr) {
  const H = hdr.map(h => h.trim().toLowerCase());
  const f = (...res) => { for (const re of res) { const i = H.findIndex(h => re.test(h)); if (i >= 0) return i; } return -1; };
  return {
    app: H.includes('date') && H.includes('amount') && H.includes('type') && H.includes('category'),
    date: f(/^date$/, /transaction date|trans\.? date/, /posting date|post date|posted/, /date/),
    amount: f(/^amount$/, /amount/), debit: f(/debit|withdraw|money out|outflow/), credit: f(/credit|deposit|money in|inflow/),
    note: f(/^note$/, /^vendor$/, /description|merchant|payee|^name$|details|memo/),
    category: f(/^category$/, /category/), type: f(/^type$/, /transaction type/), card: f(/^card/, /card/), id: f(/^id$/)
  };
}
function importSheet(rows, fname) {
  const hdr = rows[0], body = rows.slice(1), mp = guessMap(hdr);
  let cands = [];
  const opts = (sel, none) => (none ? `<option value="-1">${none}</option>` : '') + hdr.map((h, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(h || 'Column ' + (i + 1))}</option>`).join('');
  openSheet(`<h3>Import</h3><div class="sub" style="margin-top:-6px;word-break:break-all">${esc(fname)}</div>
  <div class="sub" style="margin-top:6px">${mp.app ? 'Stacked format detected.' : 'Bank or card file: check the columns below.'} ${body.length} row${body.length === 1 ? '' : 's'}.</div>
  <div class="${mp.app ? 'hide' : ''}">
   <div class="row"><div><label>Date</label><select id="m-date">${opts(mp.date)}</select></div><div><label>Description</label><select id="m-note">${opts(mp.note, '(none)')}</select></div></div>
   <div class="row"><div><label>Amount</label><select id="m-amt">${opts(mp.amount, '(use debit/credit)')}</select></div><div><label>Category column</label><select id="m-cat">${opts(mp.category, '(none)')}</select></div></div>
   <div class="row"><div><label>Debit / money out</label><select id="m-deb">${opts(mp.debit, '(none)')}</select></div><div><label>Credit / money in</label><select id="m-cre">${opts(mp.credit, '(none)')}</select></div></div>
   <label>Amount sign</label><select id="m-sign"><option value="auto">Detect automatically</option><option value="negout">Negative = spending (most banks &amp; cards)</option><option value="posout">Positive = spending</option></select>
   <div class="row"><div><label>Money coming in</label><select id="m-in"><option value="income">Import as income</option><option value="skip">Skip (card payments, transfers)</option></select></div>
   <div><label>No matching category</label><select id="m-fb">${S.cats.map(c => `<option value="${esc(c.id)}" ${c.id === UNCAT ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div></div>
  </div>
  <div class="sub" id="im-sum" style="margin:14px 0 8px"></div>
  <div style="max-height:44vh;overflow:auto;border-radius:12px;background:#0b0b0c;padding:0 8px"><table class="imp" id="im-tbl"></table></div>
  <div class="row" style="margin-top:14px"><button id="im-cancel">Cancel</button><button class="pri" id="im-go">Import</button></div>`, sh => {
    const g = id => +$('#' + id, sh).value;
    const setGo = () => { const pk = cands.filter(x => x.pick).length; $('#im-go', sh).textContent = `Import ${pk}`; $('#im-go', sh).disabled = !pk; };
    const build = () => {
      const m = mp.app ? mp : { date: g('m-date'), note: g('m-note'), amount: g('m-amt'), category: g('m-cat'), debit: g('m-deb'), credit: g('m-cre'), type: mp.type, card: mp.card, id: -1 };
      const fallback = mp.app ? UNCAT : $('#m-fb', sh).value, moneyIn = mp.app ? 'income' : $('#m-in', sh).value;
      const cell = (r, i) => i >= 0 ? String(r[i] ?? '').trim() : '';
      let sign = mp.app ? 'app' : $('#m-sign', sh).value;
      if (sign === 'auto') { const vals = body.map(r => parseAmt(cell(r, m.amount))).filter(isFinite); sign = vals.filter(v => v < 0).length >= vals.length / 2 ? 'negout' : 'posout'; }
      cands = body.map(r => {
        const date = parseDateAny(cell(r, m.date)); let amt, type;
        if (mp.app) { amt = Math.abs(parseAmt(cell(r, m.amount))); type = /^(inc|income|in|credit|deposit)/i.test(cell(r, m.type)) ? 'inc' : 'exp'; }
        else if (m.amount >= 0) { const v = parseAmt(cell(r, m.amount)); type = (sign === 'negout' ? v < 0 : v > 0) ? 'exp' : 'inc'; amt = Math.abs(v); }
        else {
          const d = parseAmt(cell(r, m.debit)), c = parseAmt(cell(r, m.credit));
          if (isFinite(d) && d !== 0) { type = 'exp'; amt = Math.abs(d); } else if (isFinite(c) && c !== 0) { type = 'inc'; amt = Math.abs(c); } else amt = NaN;
        }
        const o = { date, amt: r2(amt), type, note: cell(r, m.note), card: cell(r, m.card).replace(/\D/g, '').slice(-4), extId: mp.app ? cell(r, m.id) : '' };
        if (!date) o.err = 'bad date'; else if (!isFinite(amt) || amt === 0) o.err = 'bad amount';
        else if (type === 'inc' && moneyIn === 'skip') o.err = 'skipped';
        else o.cat = matchCat(cell(r, m.category), type, date) || (type === 'inc' ? OTHER_INC : fallback);
        return o;
      });
      classify(cands); draw();
    };
    const draw = () => {
      const c = { new: 0, dup: 0, maybe: 0, err: 0 }; cands.forEach(x => c[x.status]++);
      $('#im-sum', sh).innerHTML = `<b style="color:#fff">${c.new} new</b> · ${c.dup} duplicate${c.dup === 1 ? '' : 's'} skipped${c.maybe ? ` · <span class="amb">${c.maybe} possible duplicate${c.maybe > 1 ? 's' : ''}</span> (unticked, tick to import)` : ''}${c.err ? ` · ${c.err} unreadable/skipped` : ''}`;
      const lbl = { new: 'NEW', maybe: 'MAYBE DUP', dup: 'DUPLICATE' };
      $('#im-tbl', sh).innerHTML = '<tr><th></th><th>Date</th><th>Description</th><th>Category</th><th style="text-align:right">Amount</th><th></th></tr>' + cands.slice(0, 400).map((x, i) => `<tr style="${x.status === 'err' || x.status === 'dup' ? 'opacity:.5' : ''}">
        <td>${x.status === 'err' ? '' : `<input type="checkbox" data-pk="${i}" ${x.pick ? 'checked' : ''} aria-label="Import row">`}</td><td style="white-space:nowrap">${x.date ? fmtShort(x.date) : '?'}</td><td>${esc((x.note || '').slice(0, 28))}</td>
        <td>${x.err ? '' : esc(x.type === 'inc' ? incLineName({ cat: x.cat, date: x.date }) : catById(x.cat).name)}</td><td class="r ${x.type === 'inc' ? 'grn' : ''}">${isFinite(x.amt) && x.amt ? (x.type === 'inc' ? '+' : '') + money(x.amt) : ''}</td>
        <td><span class="pill ${x.status === 'new' ? 'new' : x.status === 'maybe' ? 'maybe' : 'dup'}">${lbl[x.status] || esc(x.err).toUpperCase()}</span></td></tr>`).join('') + (cands.length > 400 ? `<tr><td colspan="6" class="sub">…and ${cands.length - 400} more</td></tr>` : '');
      $$('[data-pk]', sh).forEach(b => b.onchange = () => { cands[+b.dataset.pk].pick = b.checked; setGo(); });
      setGo();
    };
    $$('select', sh).forEach(s => s.onchange = build);
    $('#im-cancel', sh).onclick = closeSheet;
    $('#im-go', sh).onclick = () => {
      const picked = cands.filter(x => x.pick && !x.err), stamp = Date.now(), ids = new Set(S.txns.map(t => t.id));
      picked.forEach((x, i) => { touchMonth(x.date.slice(0, 7)); const id = x.extId && !ids.has(x.extId) ? x.extId : uid(); ids.add(id); S.txns.push({ id, ts: stamp + i, date: x.date, amt: x.amt, type: x.type, cat: x.cat, note: x.note, card: x.card, src: 'import', created: nowISO() }); });
      save(); closeSheet();
      const skipped = cands.length - picked.length, months = picked.map(x => x.date.slice(0, 7)).sort();
      if (months.length) vMK = months[months.length - 1];
      go(view === 'set' ? 'home' : view); toast(`Imported ${picked.length}${skipped ? ` · ${skipped} skipped` : ''}`);
    };
    build();
  });
}
function restoreSheet(j) {
  let d; try { d = normalize(JSON.parse(JSON.stringify(j.data))); } catch (e) { return toast('That backup looks damaged'); }
  openSheet(`<h3>Restore backup</h3><div class="card" style="background:#1c1c1e"><div class="kv"><span>Backup made</span><b>${esc(j.exported ? new Date(j.exported).toLocaleString() : 'unknown')}</b></div><div class="kv"><span>Transactions</span><b>${d.txns.length}</b></div><div class="kv"><span>Months</span><b>${Object.keys(d.months).length}</b></div><div class="kv"><span>Categories</span><b>${d.cats.length}</b></div></div>
  <div class="btns">${inSheet() ? '' : '<button class="pri" id="rs-rep">Replace everything with this backup</button>'}<button id="rs-mrg">Merge: add only what's new</button><button id="rs-x">Cancel</button></div>
  <div class="sub" style="margin-top:10px">${inSheet() ? 'Merge adds the backup\'s new transactions to your Google Sheet and skips duplicates. (Replace is off while a sheet is connected.)' : 'Replace wipes what\'s on this device first. Merge keeps your data and skips duplicates.'}</div>`, sh => {
    $('#rs-x', sh).onclick = closeSheet;
    if ($('#rs-rep', sh)) $('#rs-rep', sh).onclick = () => { S = d; rollover(); save(); closeSheet(); vMK = curMK(); go('home'); toast(`Restored ${d.txns.length} transactions`); };
    $('#rs-mrg', sh).onclick = () => {
      d.cats.forEach(c => { if (!S.cats.find(x => x.id === c.id || x.name.toLowerCase() === c.name.toLowerCase())) S.cats.splice(Math.max(0, S.cats.findIndex(x => x.id === UNCAT)), 0, c); });
      const ids = new Set(S.txns.map(t => t.id)), keys = new Set(S.txns.map(dupKey)); let n = 0;
      d.txns.forEach(t => {
        if (ids.has(t.id) || keys.has(dupKey(t))) return;
        if (t.type === 'exp' && !S.cats.find(x => x.id === t.cat)) { const c = d.cats.find(x => x.id === t.cat); t.cat = (c && S.cats.find(x => x.name.toLowerCase() === c.name.toLowerCase())?.id) || UNCAT; }
        S.txns.push(t); n++;
      });
      for (const [k, m] of Object.entries(d.months)) if (!S.months[k]) S.months[k] = m;
      save(); closeSheet(); go('home'); toast(`Merged ${n} new transaction${n === 1 ? '' : 's'}`);
    };
  });
}

/* ---------- demo data (all made up) ---------- */
function loadDemo() {
  if (inSheet()) {
    if (!confirm('Demo data runs in device-only mode. Your Google Sheet is not touched, and you can switch back in Settings.')) return;
    setMode('local');
  }
  if (S.txns.length && !S.demo && !confirm('Replace your device-only data with demo data? Back up first if you want to keep it.')) return;
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = a => a[Math.floor(rnd() * a.length)];
  S = blank(); S.demo = true; S.settings.rate = 25;
  const cm = curMK(), y = cm.slice(0, 4), td = +today().slice(8, 10);
  const B = { rent: 1200, car: 310, roth: 200, osrs: 14, savings: 250, free: 450, groceries: 360, gas: 175, uncat: 0 };
  S.recurring = [
    { id: 'r1', name: 'Rent', amt: 1200, day: 1, cat: 'rent' }, { id: 'r2', name: 'Car payment', amt: 310, day: 12, cat: 'car' },
    { id: 'r3', name: 'Roth IRA contribution', amt: 200, day: 15, cat: 'roth' }, { id: 'r4', name: 'Game membership', amt: 13.99, day: 9, cat: 'osrs' },
    { id: 'r5', name: 'Transfer to savings', amt: 250, day: 20, cat: 'savings' }].map(r => ({ ...r, active: true, start: y + '-01' }));
  const FREE = ['Coffee Bar', 'Taco Spot', 'Pizza Place', 'Movie Night', 'Bookstore', 'Online Order', 'Burger Joint', 'Ramen House', 'Sports Bar', 'Hardware Store', 'Concert Tickets', 'Pharmacy'];
  const GRO = ['Corner Market', 'Fresh Grocer', 'Big Box Grocery', 'Farmers Market'], GAS = ['Fuel Stop', 'Quick Gas', 'Highway Station'];
  for (let mk = y + '-01'; mk <= cm; mk = mkAdd(mk, 1)) {
    const m = M(mk), last = mk === cm ? td : daysIn(mk);
    m.budgets = { ...B };
    m.income = [{ id: 'pay1', name: 'Paycheck 1', planned: 1650, payDate: mk + '-06', hourly: false, hours: 0 }, { id: 'pay2', name: 'Paycheck 2', planned: 1650, payDate: mk + '-20', hourly: false, hours: 0 },
      { id: 'job2', name: 'Job 2 (hourly)', planned: 0, payDate: mk + '-15', hourly: true, hours: 18 + Math.round(rnd() * 8) }, { id: 'mileage', name: 'Mileage', planned: 0, payDate: '', hourly: false, hours: 0 }];
    const add = (d, amt, cat, note, type = 'exp') => { if (d <= last) S.txns.push({ id: uid(), ts: d, date: mk + '-' + pad(d), amt: r2(amt), type, cat, note, src: 'app' }); };
    add(6, 1650, 'pay1', 'Paycheck', 'inc'); add(20, 1650, 'pay2', 'Paycheck', 'inc'); add(15, plannedOf(m.income[2]) * (0.9 + rnd() * 0.15), 'job2', 'Hourly pay', 'inc');
    if (rnd() > .6) add(25, 40 + Math.round(rnd() * 60), 'mileage', 'Mileage reimbursement', 'inc');
    const nf = 9 + Math.floor(rnd() * 6); for (let i = 0; i < nf; i++) add(1 + Math.floor(rnd() * daysIn(mk)), 8 + rnd() * (rnd() > .85 ? 120 : 45), 'free', pick(FREE));
    for (let i = 0; i < 5; i++) add(2 + i * 6 + Math.floor(rnd() * 3), 35 + rnd() * 55, 'groceries', pick(GRO));
    for (let i = 0; i < 4; i++) add(3 + i * 7 + Math.floor(rnd() * 3), 28 + rnd() * 22, 'gas', pick(GAS));
  }
  runRecurring(); save(); vMK = cm; vYear = +y; go('home'); toast('Demo data loaded (fake numbers)');
}

/* ---------- boot ---------- */
function boot() {
  // one-time setup link: ...#sheet=<id> (preferred: the hash never reaches a server) or ...?sheet=<id>. Removed from the address bar right away.
  const qs = new URLSearchParams(location.search), qid = sheetIdFrom(qs.get('sheet') || '');
  const hm = location.hash.match(/(?:^#|&)sheet=([A-Za-z0-9_-]{20,})/), lid = hm ? hm[1] : qid;
  if (hm || qs.has('sheet')) { qs.delete('sheet'); history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs : '')); }
  if (lid) { if (lid !== SY.sheetId) setSheetId(lid); else { cookieSet(lid); idbSafe('sid', lid); } setMode('sheet'); }
  $('#sync').onclick = syncTap;
  const r = rollover(); vMK = curMK(); vYear = +vMK.slice(0, 4);
  go('home'); renderSync();
  if (inSheet()) { loadGis().catch(() => { }); if (hasToken()) sync('open'); else setStatus('signin'); }
  if (SY.recovered && inSheet()) setTimeout(() => toast('Reconnected to your saved Google Sheet'), 300);
  recoverFromIdb().then(changed => {
    if (!changed) return;
    renderSync(); safeRender();
    if (inSheet()) { loadGis().catch(() => { }); if (hasToken()) sync('open'); else setStatus('signin'); toast('Reconnected to your saved Google Sheet'); }
  });
  let lastFocus = 0;
  const reread = () => { if (inSheet() && Date.now() - lastFocus > 4000) { lastFocus = Date.now(); sync('focus'); } };
  window.addEventListener('focus', reread);
  window.addEventListener('online', () => { if (inSheet()) sync('online'); });
  window.addEventListener('offline', () => { if (inSheet()) setStatus('offline'); });
  if (r.newMonth) toast(`New month: budget carried over${r.added ? ` · ${r.added} bill${r.added > 1 ? 's' : ''} added` : ''}`);
  else if (r.added) toast(`${r.added} recurring bill${r.added > 1 ? 's' : ''} added`);
  let lastMK = curMK();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (inSheet()) { const now = curMK(); if (now !== lastMK) { if (vMK === lastMK) vMK = now; lastMK = now; } reread(); return; }
    const rr = rollover(), now = curMK();
    if (now !== lastMK) { if (vMK === lastMK) vMK = now; lastMK = now; render(); if (rr.newMonth) toast('New month: budget carried over'); }
    else if (rr.added) render();
  });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
