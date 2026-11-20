// KCS Vote — admin renderer.
import { STR, ERR } from './i18n.js';
import { rulesText } from './rules.js';
import { Bars3D, fmtValue } from './chart3d.js';

const A = {
  lang: localStorage.getItem('kcs-admin-lang') || 'th',
  sb: null, cfg: null, view: 'live',
  topics: [], topicId: localStorage.getItem('kcs-topic') || null, stats: null, depts: [],
  realtime: false, channel: null, pollTimer: null, refreshTimer: null,
  chart: null, display: { open: false, mode: 'idle', nonce: 0 }, qr: null,
  importData: null, editing: null,
};
const t = (k, ...a) => { const v = STR[A.lang][k] ?? STR.th[k] ?? k; return typeof v === 'function' ? v(...a) : v; };
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const topic = () => A.topics.find((x) => x.id === A.topicId) || null;
const tTitle = (tp) => (tp && ((A.lang === 'en' && tp.title_en) || tp.title)) || '';
const oLabel = (o) => (A.lang === 'en' && o.label_en) || o.label;
// name + position of the person behind an option (from the topic's option list)
const personOf = (tp, optionId) => { const o = tp?.options?.find((x) => x.id === optionId); return { person_name: o?.person_name || null, person_title: o?.person_title || null }; };
const personText = (p) => [p.person_name, p.person_title].filter(Boolean).join(' · ');
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(A.lang === 'th' ? 'th-TH' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16); };

// ---------------------------------------------------------------- feedback
function toast(msg, kind = '', action) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) { const b = document.createElement('button'); b.textContent = action.label; b.onclick = action.fn; el.append(b); }
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' || action ? 9000 : 4000);
}
function errText(e) {
  const raw = (e && (e.message || e.error_description || e.msg)) || String(e);
  const code = raw.split(':')[0].replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  return ERR[A.lang][code] ? `${ERR[A.lang][code]}${raw.includes(':') && code !== raw ? ' — ' + raw.split(':').slice(1).join(':') : ''}` : raw;
}
const fail = (e) => { console.error(e); toast(errText(e), 'err'); };

/** Modal dialog. Resolves to true / input string, or null when cancelled. */
function ask({ title, body = '', input = null, ok = t('save'), danger = false, placeholder = '' }) {
  return new Promise((resolve) => {
    const m = $('#modal');
    m.innerHTML = `<div class="modal-card ${danger ? 'danger' : ''}" role="dialog" aria-modal="true">
      <h2>${esc(title)}</h2>${body ? `<div class="muted">${body}</div>` : ''}
      ${input !== null ? `<input id="mIn" type="text" value="${esc(input)}" placeholder="${esc(placeholder)}">` : ''}
      <div class="row" style="justify-content:flex-end"><button class="btn ghost" id="mNo">${t('cancel')}</button>
      <button class="btn ${danger ? 'warn' : ''}" id="mOk">${esc(ok)}</button></div></div>`;
    m.hidden = false;
    const done = (v) => { m.hidden = true; m.innerHTML = ''; resolve(v); };
    $('#mNo').onclick = () => done(null);
    $('#mOk').onclick = () => done(input !== null ? $('#mIn').value : true);
    m.onkeydown = (e) => { if (e.key === 'Escape') done(null); if (e.key === 'Enter') $('#mOk').click(); };
    ($('#mIn') || $('#mOk')).focus();
  });
}

// ---------------------------------------------------------------- supabase
async function rpc(fn, args = {}) {
  const { data, error } = await A.sb.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}
async function connect(cfg, password) {
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.anonKey, {
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
  });
  const { error } = await sb.auth.signInWithPassword({ email: cfg.adminEmail, password });
  if (error) throw new Error(`${t('errLogin')}: ${error.message}`);
  const { data, error: e2 } = await sb.rpc('admin_whoami');
  if (e2) throw new Error(e2.message);
  if (!data.is_admin) { await sb.auth.signOut(); throw new Error(`${t('errNotAdmin')} (user_id ${data.user_id})`); }
  return sb;
}

// ---------------------------------------------------------------- gate
async function showGate() {
  $('#shell').hidden = true;
  const st = await window.kcs.cfg.status();
  const g = $('#gate'); g.hidden = false;
  if (st.configured) {
    g.innerHTML = `<form class="gate-card" id="unlockForm">
      <img src="assets/kcs-logo-transparent.png" alt="KCS"><h1>${t('unlockTitle')}</h1>
      <p class="muted small">${esc(st.adminEmail)} · ${esc(st.supabaseUrl)}</p>
      <div class="form"><label class="f">${t('appPassword')}<input id="pw" type="password" autocomplete="current-password" required></label>
      <div id="gErr" class="err" hidden></div>
      <button class="btn" id="goBtn">${t('unlock')}</button></div>
      <p class="small muted" style="margin-top:18px">${t('configAt')}: <span class="mono">${esc(st.path)}</span></p>
      <div class="row" style="justify-content:center"><button type="button" class="btn ghost sm" id="langG">${A.lang === 'th' ? 'English' : 'ภาษาไทย'}</button>
      <button type="button" class="btn danger sm" id="resetCfg">${t('resetConfig')}</button></div></form>`;
    $('#pw').focus();
    $('#langG').onclick = () => { setLang(A.lang === 'th' ? 'en' : 'th'); showGate(); };
    $('#resetCfg').onclick = async () => { if (await ask({ title: t('resetConfig'), body: esc(t('confirmResetCfg')), ok: t('resetConfig'), danger: true })) { await window.kcs.cfg.reset(); showGate(); } };
    $('#unlockForm').onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('#goBtn'); btn.disabled = true; btn.textContent = t('connecting');
      try {
        const cfg = await window.kcs.cfg.unlock($('#pw').value);
        A.sb = await connect(cfg, cfg.supabasePassword);
        A.cfg = { ...cfg, supabasePassword: undefined };
        await enterApp();
      } catch (err) {
        const m = String(err.message || err);
        $('#gErr').hidden = false;
        $('#gErr').textContent = m.includes('BAD_PASSWORD') ? t('errBadPassword') : m.includes('LOCKED:') ? t('errLocked', m.split('LOCKED:')[1]) : errText(err);
        btn.disabled = false; btn.textContent = t('unlock'); $('#pw').select();
      }
    };
  } else {
    g.innerHTML = `<form class="gate-card" id="setupForm">
      <img src="assets/kcs-logo-transparent.png" alt="KCS"><h1>${t('setupTitle')}</h1><p class="muted small">${t('setupHint')}</p>
      <div class="form">
        <label class="f">${t('supabaseUrl')}<input id="sUrl" type="url" placeholder="https://xxxx.supabase.co" required></label>
        <label class="f">${t('anonKey')}<input id="sKey" type="text" required></label>
        <label class="f">${t('adminEmail')}<input id="sEmail" type="email" required></label>
        <label class="f">${t('adminPassword')}<input id="sPw" type="password" required></label>
        <label class="f">${t('voterUrl')}<input id="sVoter" type="url" placeholder="https://kcs-vote.pages.dev"></label>
        <label class="f">${t('newAppPassword')}<input id="aPw" type="password" minlength="8" required></label>
        <label class="f">${t('confirmPassword')}<input id="aPw2" type="password" minlength="8" required></label>
        <div id="gErr" class="err" hidden></div>
        <button class="btn" id="goBtn">${t('testAndSave')}</button>
        <div class="row" style="justify-content:center"><button type="button" class="btn ghost sm" id="impCfg">${t('importConfig')}</button>
        <button type="button" class="btn ghost sm" id="langG">${A.lang === 'th' ? 'English' : 'ภาษาไทย'}</button></div>
      </div></form>`;
    $('#langG').onclick = () => { setLang(A.lang === 'th' ? 'en' : 'th'); showGate(); };
    $('#impCfg').onclick = async () => { try { if (await window.kcs.cfg.importFile()) showGate(); } catch (e) { fail(e); } };
    $('#setupForm').onsubmit = async (e) => {
      e.preventDefault();
      const errEl = $('#gErr'); errEl.hidden = true;
      const input = { supabaseUrl: $('#sUrl').value.trim().replace(/\/+$/, ''), anonKey: $('#sKey').value.trim(), adminEmail: $('#sEmail').value.trim(),
        supabasePassword: $('#sPw').value, voterUrl: $('#sVoter').value.trim(), appPassword: $('#aPw').value };
      if (input.appPassword !== $('#aPw2').value) { errEl.hidden = false; errEl.textContent = t('errMismatch'); return; }
      if (input.appPassword.length < 8) { errEl.hidden = false; errEl.textContent = t('errWeak'); return; }
      const btn = $('#goBtn'); btn.disabled = true; btn.textContent = t('connecting');
      try {
        A.sb = await connect(input, input.supabasePassword);
        await window.kcs.cfg.setup(input);
        A.cfg = { ...input, supabasePassword: undefined, appPassword: undefined };
        await enterApp();
      } catch (err) { errEl.hidden = false; errEl.textContent = errText(err); btn.disabled = false; btn.textContent = t('testAndSave'); }
    };
  }
}

async function enterApp() {
  $('#gate').hidden = true; $('#gate').innerHTML = '';
  $('#shell').hidden = false;
  applyStaticText();
  await loadTopics();
  subscribeRealtime();
  startPolling();
  keepAliveStart();
  A.display.open = await window.kcs.display.isOpen();
  show(A.view);
}

async function lockApp() {
  stopPolling();
  clearInterval(A.kaTimer); A.kaTimer = null;
  if (A.channel) { await A.sb.removeChannel(A.channel); A.channel = null; }
  if (A.chart) { A.chart.dispose(); A.chart = null; }
  try { await A.sb.auth.signOut(); } catch { /* offline */ }
  A.sb = null; A.cfg = null;
  showGate();
}

function setLang(l) {
  A.lang = l; localStorage.setItem('kcs-admin-lang', l);
  document.documentElement.lang = l;
}
function applyStaticText() {
  $$('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
  $('#langBtn').textContent = A.lang === 'th' ? 'EN' : 'ไทย';
  const items = [['live', '📊', 'navLive'], ['topics', '🗳️', 'navTopics'], ['employees', '👥', 'navEmployees'], ['undo', '↩️', 'navUndo'],
    ['rules', '📜', 'navRules'], ['qr', '▦', 'navQr'], ['audit', '🧾', 'navAudit'], ['settings', '⚙️', 'navSettings']];
  $('#nav').innerHTML = items.map(([id, ico, k]) => `<button data-view="${id}" class="${A.view === id ? 'on' : ''}"><span class="ico">${ico}</span>${t(k)}</button>`).join('');
  $$('#nav button').forEach((b) => { b.onclick = () => show(b.dataset.view); });
}

// ---------------------------------------------------------------- data + realtime
async function loadTopics() {
  A.topics = await rpc('admin_list_topics');
  if (!topic()) A.topicId = (A.topics.find((x) => x.status === 'open') || A.topics[0] || {}).id || null;
  if (A.topicId) localStorage.setItem('kcs-topic', A.topicId);
}
async function refreshStats() {
  if (!A.sb || !A.topicId) { A.stats = null; return; }
  try {
    A.stats = await rpc('admin_live_stats', { p_topic: A.topicId });
    const i = A.topics.findIndex((x) => x.id === A.topicId);
    if (i >= 0) A.topics[i] = { ...A.topics[i], ...A.stats.topic, votes: A.stats.voted, accepting: A.stats.accepting };
    if (A.view === 'live') updateLive();
    pushDisplay();
  } catch (e) { console.warn('stats', e); }
}
const scheduleRefresh = () => { clearTimeout(A.refreshTimer); A.refreshTimer = setTimeout(refreshStats, 150); };
function subscribeRealtime() {
  A.channel = A.sb.channel('kcs-admin-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'topic_counters' }, scheduleRefresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'topics' }, async () => { await loadTopics(); scheduleRefresh(); })
    .subscribe((status) => { A.realtime = status === 'SUBSCRIBED'; const el = $('#rt'); if (el) setRt(el); });
}
const setRt = (el) => { el.className = `pill-dot ${A.realtime ? 'on' : ''}`; el.textContent = A.realtime ? t('realtimeOn') : t('realtimePoll'); };
function startPolling() {
  stopPolling();
  let n = 0;
  // Fallback polling every 2 s; with realtime connected only a safety refresh every 10 s.
  A.pollTimer = setInterval(() => { n++; if (!A.realtime || n % 5 === 0) refreshStats(); }, 2000);
  refreshStats();
}
function stopPolling() { clearInterval(A.pollTimer); A.pollTimer = null; }

// ---------------------------------------------------------------- keep-alive (anti-pause)
// Every app start and every 6 h while open: a real DB read+write via keep_alive().
const KA_STALE_MS = 3 * 24 * 3600e3;
const kaAge = (s) => (s && s.last_ping ? Date.now() - new Date(s.last_ping).getTime() : Infinity);
async function keepAlivePing() {
  try { await rpc('keep_alive', { source: 'desktop' }); } catch (e) { console.warn('keep_alive', e); }
}
async function keepAliveStart() {
  // read the status BEFORE pinging, so a silent Worker/GitHub job is still noticed
  try { A.kaBefore = await rpc('get_keep_alive_status'); } catch (e) { A.kaBefore = null; console.warn(e); }
  await keepAlivePing();
  clearInterval(A.kaTimer);
  A.kaTimer = setInterval(keepAlivePing, 6 * 3600e3);
  if (A.kaBefore && kaAge(A.kaBefore) > KA_STALE_MS) toast(t('kaStaleBefore', fmtDate(A.kaBefore.last_ping) || t('kaNever')), 'err');
}

// ---------------------------------------------------------------- display relay
async function pushDisplay() {
  const tp = topic();
  const s = A.stats;
  const revealed = tp && tp.status === 'revealed';
  let mode = A.display.mode;
  if (!revealed && ['reveal', 'ranking'].includes(mode)) mode = tp && tp.status === 'open' ? 'voting' : 'idle';
  if (A.cfg?.voterUrl && !A.qr) { try { A.qr = await window.kcs.qr.dataUrl(A.cfg.voterUrl); } catch { /* ignore */ } }
  const state = {
    lang: A.lang, mode, nonce: A.display.nonce,
    topic: tp && { id: tp.id, title: tp.title, title_en: tp.title_en, description: tp.description, description_en: tp.description_en, status: tp.status,
      weighting_enabled: tp.weighting_enabled, self_vote_weight: tp.self_vote_weight, min_turnout_pct: tp.min_turnout_pct, exclude_low_turnout: tp.exclude_low_turnout },
    voted: s ? s.voted : 0, eligible: s ? s.eligible : 0,
    voterUrl: A.cfg?.voterUrl || '', qr: A.qr,
    // results leave this window ONLY after the topic is revealed
    results: revealed && s ? s.scores.map((x) => ({ id: x.option_id, label: x.label, label_en: x.label_en, ...personOf(tp, x.option_id), score: x.score, raw: x.raw_votes, rank: x.rank, tie: x.is_tie && Number(x.score) > 0, position: x.position })) : null,
    weighted: tp ? tp.weighting_enabled : true,
  };
  window.kcs.display.send(state);
}
async function setDisplayMode(mode) {
  if (!A.display.open) { await window.kcs.display.open(); A.display.open = true; }
  A.display.mode = mode;
  if (mode === 'reveal') A.display.nonce++;
  pushDisplay();
  if (A.view === 'live') updateLive();
}
window.kcs.display.onClosed(() => { A.display.open = false; if (A.view === 'live') updateLive(); });

// ---------------------------------------------------------------- views
function show(view) {
  A.view = view;
  if (A.chart && view !== 'live') { A.chart.dispose(); A.chart = null; }
  $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  const v = $('#view');
  v.scrollTop = 0;
  ({ live: viewLive, topics: viewTopics, employees: viewEmployees, undo: viewUndo, rules: viewRules, qr: viewQr, audit: viewAudit, settings: viewSettings })[view]();
}

function topicSelect(id = 'topicSel', filter = () => true) {
  const list = A.topics.filter(filter);
  return `<select id="${id}" style="min-width:320px;max-width:520px">${list.map((x) => `<option value="${x.id}" ${x.id === A.topicId ? 'selected' : ''}>${esc(tTitle(x))} · ${t('st_' + x.status)}</option>`).join('')}</select>`;
}
function bindTopicSelect(cb) {
  const sel = $('#topicSel');
  if (sel) sel.onchange = async () => { A.topicId = sel.value; localStorage.setItem('kcs-topic', A.topicId); A.stats = null; await refreshStats(); cb && cb(); };
}

// ---- Live & control
function viewLive() {
  const v = $('#view');
  if (!A.topics.length) { v.innerHTML = `<div class="head"><h1>${t('navLive')}</h1></div><div class="card">${t('noTopics')}</div>`; return; }
  v.innerHTML = `
  <div class="head"><h1>${t('navLive')}</h1>${topicSelect()}<span id="stBadge"></span><span id="rt"></span><span class="spacer"></span></div>
  <div class="card" style="margin-bottom:16px"><div class="row" id="ctl"></div><div class="small muted" id="window" style="margin-top:8px"></div></div>
  <div class="kpis">
    <div class="card kpi"><h3>${t('voted')}</h3><div class="big" id="kVoted">0</div><div class="bar"><i id="kBar" style="width:0"></i></div></div>
    <div class="card kpi"><h3>${t('turnout')}</h3><div class="big" id="kPct">0%</div></div>
    <div class="card kpi display-ctl"><h3>${t('display')}</h3><div class="row" id="dispBtns"></div></div>
  </div>
  <div class="card display-ctl" style="margin-bottom:16px"><div class="row"><h2 style="margin:0">${t('display')}</h2><span class="small muted" id="dispHint"></span></div><div class="modes" id="modes"></div></div>
  <div class="grid g-live">
    <div class="card"><h2 id="chartTitle"></h2><div class="chart" id="chart"><div class="chart-empty" id="chartEmpty">—</div></div></div>
    <div class="card"><div class="row"><h2 style="margin:0">${t('ranking')}</h2><span class="small muted" id="tieHint"></span></div>
      <div class="tablewrap" style="margin-top:10px"><table><thead><tr><th>${t('rank')}</th><th>${t('option')}</th><th class="num">${t('score')}</th><th class="num">${t('rawVotes')}</th><th></th></tr></thead><tbody id="rankBody"></tbody></table></div></div>
  </div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h2>${t('turnout')}</h2><div class="tablewrap"><table><thead><tr><th>${t('department')}</th><th class="num">${t('headcount')}</th><th class="num">${t('votedCol')}</th><th class="num">%</th><th></th><th></th></tr></thead><tbody id="toBody"></tbody></table></div></div>
    <div class="card rules" id="rulesCard"></div>
  </div>`;
  setRt($('#rt'));
  bindTopicSelect(() => { if (A.chart) { A.chart.dispose(); A.chart = null; } viewLive(); });
  A.chart = new Bars3D($('#chart'), { theme: 'light' });
  updateLive();
}

function updateLive() {
  const tp = topic(); const s = A.stats;
  if (!tp || !$('#ctl')) return;
  const st = tp.status;
  const opt = $(`#topicSel option[value="${tp.id}"]`);
  if (opt) opt.textContent = `${tTitle(tp)} · ${t('st_' + st)}`;
  $('#stBadge').innerHTML = `<span class="badge ${st}">${t('st_' + st)}</span>${st === 'open' && s && !s.accepting ? ` <span class="badge warn">${t('notAccepting')}</span>` : ''}`;
  $('#window').textContent = [tp.open_at && `${t('scheduledAt')}: ${fmtDate(tp.open_at)}`, tp.close_at && `${t('endsAt')}: ${fmtDate(tp.close_at)}`].filter(Boolean).join(' · ');
  const ctl = $('#ctl');
  ctl.innerHTML = `
    <button class="btn ok" data-a="open" ${['draft', 'closed'].includes(st) ? '' : 'disabled'}>▶ ${t('openVoting')}</button>
    <button class="btn warn" data-a="close" ${st === 'open' ? '' : 'disabled'}>■ ${t('closeVoting')}</button>
    <button class="btn gold" data-a="reveal" ${st === 'closed' ? '' : 'disabled'} title="${t('revealOnlyAfter')}">🏆 ${t('reveal')}</button>
    ${st === 'revealed' ? `<button class="btn ghost" data-a="hide">${t('hideResults')}</button>` : ''}
    <span class="spacer"></span>
    <button class="btn ghost" data-a="xlsx" ${s ? '' : 'disabled'}>⬇ ${t('exportXlsx')}</button>
    <button class="btn ghost" data-a="pdf" ${s ? '' : 'disabled'}>⬇ ${t('exportPdf')}</button>
    <button class="btn danger" data-a="reset" ${st === 'open' ? 'disabled' : ''}>⟲ ${t('resetTopic')}</button>`;
  $$('button', ctl).forEach((b) => { b.onclick = () => control(b.dataset.a); });

  $('#dispBtns').innerHTML = A.display.open
    ? `<button class="btn ghost sm" id="dFs">⛶ ${t('fullscreen')}</button><button class="btn danger sm" id="dClose">${t('closeDisplay')}</button>`
    : `<button class="btn" id="dOpen">🖥 ${t('openDisplay')}</button>`;
  if ($('#dOpen')) $('#dOpen').onclick = async () => { await window.kcs.display.open(); A.display.open = true; if (A.display.mode === 'idle' && st === 'open') A.display.mode = 'voting'; pushDisplay(); updateLive(); };
  if ($('#dFs')) $('#dFs').onclick = () => window.kcs.display.fullscreen();
  if ($('#dClose')) $('#dClose').onclick = async () => { await window.kcs.display.close(); A.display.open = false; updateLive(); };
  const modes = ['idle', 'voting', 'reveal', 'ranking', 'rules'];
  $('#modes').innerHTML = modes.map((m) => `<button class="btn ghost ${A.display.mode === m ? 'active' : ''}" data-m="${m}" ${['reveal', 'ranking'].includes(m) && st !== 'revealed' ? 'disabled' : ''}>${t('dm_' + m)}</button>`).join('');
  $$('#modes button').forEach((b) => { b.onclick = () => setDisplayMode(b.dataset.m); });
  $('#dispHint').textContent = st !== 'revealed' ? t('revealOnlyAfter') : '';

  if (!s) return;
  $('#kVoted').innerHTML = `${s.voted} <small>/ ${s.eligible}</small>`;
  const pct = s.eligible ? (s.voted / s.eligible) * 100 : 0;
  $('#kBar').style.width = `${pct.toFixed(1)}%`;
  $('#kPct').textContent = `${pct.toFixed(1)}%`;

  $('#chartTitle').textContent = tp.weighting_enabled ? t('liveChart') : t('liveChartRaw');
  const items = s.scores.map((x) => ({ id: x.option_id, label: oLabel(x), value: Number(x.score), tie: x.is_tie && Number(x.score) > 0, sub: tp.weighting_enabled ? `${x.raw_votes} ${t('votesUnit')}` : '' }));
  $('#chartEmpty').hidden = items.length > 0;
  if (A.chart) A.chart.setData(items);

  const anyTie = s.scores.some((x) => x.is_tie && Number(x.score) > 0);
  $('#tieHint').textContent = anyTie ? `⚠ ${t('tieHint')}` : '';
  const isTie = (x) => x.is_tie && Number(x.score) > 0;
  $('#rankBody').innerHTML = s.scores.map((x, i) => `<tr class="${isTie(x) ? 'tie' : ''} ${i === 0 ? 'first' : ''}">
    <td><span class="rankno r${x.rank}">${x.rank}</span></td><td>${esc(oLabel(x))}${isTie(x) ? ` <span class="badge warn">${t('tie')}</span>` : ''}${personText(personOf(tp, x.option_id)) ? `<div class="small muted">👤 ${esc(personText(personOf(tp, x.option_id)))}</div>` : ''}</td>
    <td class="num">${tp.weighting_enabled ? Number(x.score).toFixed(4) : x.score}</td><td class="num">${x.raw_votes}</td>
    <td>${isTie(x) ? `<button class="btn ghost icon" data-mv="-1" data-i="${i}" ${i === 0 ? 'disabled' : ''}>▲</button><button class="btn ghost icon" data-mv="1" data-i="${i}" ${i === s.scores.length - 1 ? 'disabled' : ''}>▼</button>` : ''}</td></tr>`).join('');
  $$('#rankBody [data-mv]').forEach((b) => { b.onclick = () => moveTie(Number(b.dataset.i), Number(b.dataset.mv)); });

  $('#toBody').innerHTML = s.turnout.map((d) => `<tr class="${d.low_turnout ? 'low' : ''}">
    <td>${esc(d.department)}</td><td class="num">${d.headcount}</td><td class="num">${d.voted}</td><td class="num">${d.turnout_pct ?? '—'}</td>
    <td>${d.low_turnout ? `<span class="badge warn">⚠ ${t('lowTurnout')}</span>` : ''}</td>
    <td>${d.low_turnout && tp.weighting_enabled && tp.exclude_low_turnout
      ? `<button class="btn ${d.excluded ? 'ghost' : 'danger'} sm" data-dept="${esc(d.department)}">${d.excluded ? t('include') : t('exclude')}</button> <span class="small muted">${d.excluded ? t('excluded') : t('included')}</span>` : ''}</td></tr>`).join('');
  $$('#toBody [data-dept]').forEach((b) => { b.onclick = () => toggleInclude(b.dataset.dept); });

  const r = rulesText(tp, A.lang);
  $('#rulesCard').innerHTML = `<h2>${esc(r.title)}</h2><ol>${r.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ol>`;
}

async function moveTie(i, dir) {
  const order = A.stats.scores.map((x) => x.option_id);
  const j = i + dir;
  if (j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  try { await rpc('admin_set_tiebreak', { p_topic: A.topicId, p_order: order }); await refreshStats(); } catch (e) { fail(e); }
}
async function toggleInclude(dept) {
  const tp = topic();
  const set = new Set(tp.low_turnout_included || []);
  set.has(dept) ? set.delete(dept) : set.add(dept);
  try { await rpc('admin_set_low_turnout_included', { p_topic: A.topicId, p_departments: [...set] }); await loadTopics(); await refreshStats(); } catch (e) { fail(e); }
}

async function control(action) {
  const tp = topic(); if (!tp) return;
  try {
    if (action === 'open') {
      if (!await ask({ title: t('openVoting'), body: esc(t('confirmOpen')) + `<br><b>${esc(tTitle(tp))}</b>`, ok: t('openVoting') })) return;
      await rpc('admin_set_status', { p_topic: tp.id, p_status: 'open' });
      if (A.display.open) A.display.mode = 'voting';
    } else if (action === 'close') {
      if (!await ask({ title: t('closeVoting'), body: esc(t('confirmClose')), ok: t('closeVoting'), danger: true })) return;
      await rpc('admin_set_status', { p_topic: tp.id, p_status: 'closed' });
    } else if (action === 'reveal') {
      if (!await ask({ title: t('reveal'), body: esc(t('confirmReveal')), ok: t('reveal') })) return;
      await rpc('admin_set_status', { p_topic: tp.id, p_status: 'revealed' });
      await loadTopics(); await refreshStats();
      await setDisplayMode('reveal');
    } else if (action === 'hide') {
      await rpc('admin_set_status', { p_topic: tp.id, p_status: 'closed' });
      A.display.mode = 'idle';
    } else if (action === 'reset') {
      if (!await ask({ title: t('resetTopic'), body: esc(t('confirmReset1')), ok: t('resetTopic'), danger: true })) return;
      const typed = await ask({ title: t('resetTopic'), body: esc(t('confirmReset2')), input: '', placeholder: 'RESET', ok: t('resetTopic'), danger: true });
      if (typed === null) return;
      if (typed.trim() !== 'RESET') { toast('RESET ≠ ' + typed, 'err'); return; }
      await rpc('admin_reset_topic', { p_topic: tp.id, p_confirm: 'RESET' });
      A.display.mode = 'idle';
    } else if (action === 'xlsx' || action === 'pdf') {
      const data = exportData();
      const file = action === 'xlsx' ? await window.kcs.exportXlsx(data) : await window.kcs.exportPdf(data);
      if (file) toast(`${t('exported')}: ${file}`, 'ok', { label: t('showInFolder'), fn: () => window.kcs.showFile(file) });
      return;
    }
    await loadTopics(); await refreshStats(); updateLive();
  } catch (e) { fail(e); }
}

function exportData() {
  const tp = topic(); const s = A.stats;
  const r = rulesText(tp, A.lang);
  const L = A.lang === 'th'
    ? { ranking: 'อันดับ', turnout: 'อัตรามาโหวต', rules: 'กติกา', exported: 'ส่งออกเมื่อ', voted: 'โหวตแล้ว', method: 'วิธีคิดคะแนน', tie: 'เสมอ',
      rankCols: ['อันดับ', 'ตัวเลือก', 'แผนก', 'คะแนน', 'เสียงดิบ', 'เสมอ'], turnoutCols: ['แผนก', 'พนักงาน', 'มาโหวต', 'อัตรา', 'มาโหวตน้อย', 'ไม่นับ'],
      weightedName: 'ถ่วงน้ำหนักตามแผนก', rawName: '1 คน 1 เสียง', params: 'พารามิเตอร์', selfW: 'น้ำหนักโหวตแผนกตัวเอง', minT: 'อัตรามาโหวตขั้นต่ำ', excl: 'ไม่นับแผนกที่มาโหวตน้อย', yes: 'ใช่', no: 'ไม่', status: 'สถานะ', page: 'รายงานผลการโหวต' }
    : { ranking: 'Ranking', turnout: 'Turnout', rules: 'Rules', exported: 'Exported', voted: 'Voted', method: 'Method', tie: 'Tie',
      rankCols: ['Rank', 'Option', 'Department', 'Score', 'Raw votes', 'Tie'], turnoutCols: ['Department', 'Staff', 'Voted', 'Rate', 'Low turnout', 'Excluded'],
      weightedName: 'Department-weighted', rawName: 'One person one vote', params: 'Parameters', selfW: 'Own-department weight', minT: 'Minimum turnout', excl: 'Exclude low turnout', yes: 'Yes', no: 'No', status: 'Status', page: 'Voting results report' };
  return {
    lang: A.lang, title: tTitle(tp), description: (A.lang === 'en' && tp.description_en) || tp.description || '',
    status: t('st_' + tp.status), exportedAt: new Date().toLocaleString(A.lang === 'th' ? 'th-TH' : 'en-GB'),
    voted: s.voted, eligible: s.eligible, weighted: tp.weighting_enabled,
    method: tp.weighting_enabled ? L.weightedName : L.rawName,
    params: tp.weighting_enabled ? [[L.selfW, `×${Number(tp.self_vote_weight)}`], [L.minT, `${Number(tp.min_turnout_pct)}%`], [L.excl, tp.exclude_low_turnout ? L.yes : L.no]] : [],
    scores: s.scores.map((x) => ({ rank: x.rank, label: oLabel(x), person: personText(personOf(tp, x.option_id)), department: x.department, score: x.score, raw_votes: x.raw_votes, is_tie: x.is_tie && Number(x.score) > 0 })),
    turnout: s.turnout, rulesTitle: r.title, rules: r.lines, rulesLines: [r.title, ...r.lines.map((l, i) => `${i + 1}. ${l}`)], labels: L,
  };
}

// ---- Topics
async function viewTopics() {
  const v = $('#view');
  try { A.depts = await rpc('admin_departments'); } catch (e) { fail(e); }
  v.innerHTML = `<div class="head"><h1>${t('navTopics')}</h1><span class="spacer"></span><button class="btn" id="newT">＋ ${t('newTopic')}</button></div>
    <div class="grid g-topics"><div class="grid" id="tList"></div><div id="tEdit"></div></div>`;
  $('#newT').onclick = () => editTopic(null);
  drawTopicList();
  editTopic(A.editing && A.topics.find((x) => x.id === A.editing) ? A.editing : (A.topicId || null));
}
function drawTopicList() {
  $('#tList').innerHTML = A.topics.map((x) => `<div class="topic-item ${x.id === A.editing ? 'on' : ''}" data-id="${x.id}">
    <b>${esc(tTitle(x))}</b><div class="row small"><span class="badge ${x.status}">${t('st_' + x.status)}</span><span class="muted">${x.votes} ${t('votesCount')} · ${x.options.length} ${t('options')}</span></div></div>`).join('')
    || `<div class="muted">${t('noTopics')}</div>`;
  $$('#tList .topic-item').forEach((el) => { el.onclick = () => editTopic(el.dataset.id); });
}
function editTopic(id) {
  A.editing = id;
  drawTopicList();
  const tp = id ? A.topics.find((x) => x.id === id) : { title: '', options: [], weighting_enabled: true, self_vote_weight: 0.5, min_turnout_pct: 30, exclude_low_turnout: true, allow_undo: true, votes: 0 };
  const locked = tp.votes > 0;
  const deptOpts = (sel) => `<option value="">${t('none')}</option>${A.depts.map((d) => `<option ${d.department === sel ? 'selected' : ''}>${esc(d.department)}</option>`).join('')}`;
  const optRow = (o, i) => `<div class="opt-row" data-id="${o.id || ''}"><span class="n">${i + 1}</span>
    <input type="text" class="oTh" value="${esc(o.label)}" placeholder="${t('labelTh')}"><input type="text" class="oEn" value="${esc(o.label_en || '')}" placeholder="${t('labelEn')}">
    <select class="oDept">${deptOpts(o.department)}</select>
    <span class="row" style="gap:4px;flex-wrap:nowrap"><button class="btn ghost icon" data-up>▲</button><button class="btn ghost icon" data-down>▼</button>${locked ? '' : '<button class="btn danger icon" data-del>✕</button>'}</span>
    <div class="opt-person"><span class="pi" aria-hidden="true">👤</span><input type="text" class="oName" maxlength="120" value="${esc(o.person_name || '')}" placeholder="${t('personName')}"><input type="text" class="oPos" maxlength="120" value="${esc(o.person_title || '')}" placeholder="${t('personTitle')}"></div></div>`;
  $('#tEdit').innerHTML = `<form class="card grid" id="tForm">
    <div class="row"><h2 style="margin:0">${id ? t('edit') : t('newTopic')}</h2><span class="spacer"></span>
      ${id ? `<button type="button" class="btn ghost sm" id="dupT">${t('duplicate')}</button><button type="button" class="btn danger sm" id="delT" ${tp.status === 'open' ? 'disabled' : ''}>${t('delete')}</button>` : ''}</div>
    <div class="grid g2"><label class="f">${t('titleTh')}<input id="fTitle" type="text" value="${esc(tp.title)}" required></label>
      <label class="f">${t('titleEn')}<input id="fTitleEn" type="text" value="${esc(tp.title_en || '')}"></label>
      <label class="f">${t('descTh')}<textarea id="fDesc">${esc(tp.description || '')}</textarea></label>
      <label class="f">${t('descEn')}<textarea id="fDescEn">${esc(tp.description_en || '')}</textarea></label></div>
    <fieldset><legend>${t('options')}</legend>
      ${locked ? `<div class="badge warn">${t('optionsLocked')}</div>` : ''}
      <div class="opt-row opt-head small muted"><span></span><span>${t('labelTh')}</span><span>${t('labelEn')}</span><span>${t('linkedDept')}</span><span></span></div>
      <div class="hint">👤 ${t('personHint')}</div>
      <div id="opts" class="grid" style="gap:10px">${tp.options.map(optRow).join('')}</div>
      ${locked ? '' : `<div class="row"><button type="button" class="btn ghost sm" id="addO">＋ ${t('addOption')}</button><button type="button" class="btn ghost sm" id="fillD">🏢 ${t('fillDepts')} (${A.depts.length})</button></div>`}
    </fieldset>
    <fieldset><legend>${t('schedule')}</legend><div class="grid g2">
      <label class="f">${t('openAt')}<input id="fOpen" type="datetime-local" value="${toLocalInput(tp.open_at)}"></label>
      <label class="f">${t('closeAt')}<input id="fClose" type="datetime-local" value="${toLocalInput(tp.close_at)}"></label></div>
      <div class="hint">${t('manualHint')}</div></fieldset>
    <fieldset><legend>${t('scoring')}</legend>
      <label class="check"><input type="checkbox" id="fW" ${tp.weighting_enabled ? 'checked' : ''}>${t('weighting')}</label>
      <div class="grid g2"><label class="f">${t('selfWeight')}<input id="fSelf" type="number" min="0" max="1" step="0.05" value="${Number(tp.self_vote_weight)}"></label>
      <label class="f">${t('minTurnout')}<input id="fMin" type="number" min="0" max="100" step="1" value="${Number(tp.min_turnout_pct)}"></label></div>
      <label class="check"><input type="checkbox" id="fEx" ${tp.exclude_low_turnout ? 'checked' : ''}>${t('excludeLow')}</label>
      <label class="check"><input type="checkbox" id="fUndo" ${tp.allow_undo ? 'checked' : ''}>${t('allowUndo')}</label>
      <div class="hint">🔒 ${t('allowUndoHint')}</div></fieldset>
    <div class="row"><span class="spacer"></span><button class="btn" id="saveT">${t('save')}</button></div></form>`;

  const optsEl = $('#opts');
  const renumber = () => $$('.opt-row .n', optsEl).forEach((n, i) => { n.textContent = i + 1; });
  const bindRows = () => $$('.opt-row', optsEl).forEach((row) => {
    const up = $('[data-up]', row), down = $('[data-down]', row), del = $('[data-del]', row);
    up.onclick = () => { if (row.previousElementSibling) optsEl.insertBefore(row, row.previousElementSibling); renumber(); };
    down.onclick = () => { if (row.nextElementSibling) optsEl.insertBefore(row.nextElementSibling, row); renumber(); };
    if (del) del.onclick = () => { row.remove(); renumber(); };
  });
  bindRows();
  if ($('#addO')) $('#addO').onclick = () => { optsEl.insertAdjacentHTML('beforeend', optRow({ label: '' }, optsEl.children.length)); bindRows(); $$('.oTh', optsEl).at(-1).focus(); };
  if ($('#fillD')) $('#fillD').onclick = () => {
    const have = new Set($$('.oDept', optsEl).map((s) => s.value).filter(Boolean));
    A.depts.filter((d) => !have.has(d.department)).forEach((d) => optsEl.insertAdjacentHTML('beforeend', optRow({ label: d.department, department: d.department }, optsEl.children.length)));
    $$('.opt-row', optsEl).forEach((r) => { if (!$('.oTh', r).value.trim()) r.remove(); });
    renumber(); bindRows();
  };
  if ($('#dupT')) $('#dupT').onclick = async () => { try { const nid = await rpc('admin_duplicate_topic', { p_topic: id }); await loadTopics(); A.editing = nid; viewTopics(); } catch (e) { fail(e); } };
  if ($('#delT')) $('#delT').onclick = async () => {
    if (!await ask({ title: t('delete'), body: esc(t('confirmDelete')) + `<br><b>${esc(tTitle(tp))}</b>`, ok: t('delete'), danger: true })) return;
    try { await rpc('admin_delete_topic', { p_topic: id }); A.editing = null; if (A.topicId === id) A.topicId = null; await loadTopics(); viewTopics(); } catch (e) { fail(e); }
  };
  $('#tForm').onsubmit = async (e) => {
    e.preventDefault();
    const iso = (v) => (v ? new Date(v).toISOString() : null);
    const payload = {
      id: id || undefined, title: $('#fTitle').value, title_en: $('#fTitleEn').value, description: $('#fDesc').value, description_en: $('#fDescEn').value,
      open_at: iso($('#fOpen').value), close_at: iso($('#fClose').value),
      weighting_enabled: $('#fW').checked, self_vote_weight: Math.min(1, Math.max(0, Number($('#fSelf').value) || 0)),
      min_turnout_pct: Math.min(100, Math.max(0, Number($('#fMin').value) || 0)), exclude_low_turnout: $('#fEx').checked, allow_undo: $('#fUndo').checked,
      options: $$('.opt-row[data-id]', optsEl).map((r) => ({ id: r.dataset.id || undefined, label: $('.oTh', r).value.trim(), label_en: $('.oEn', r).value.trim(), department: $('.oDept', r).value, person_name: $('.oName', r).value.trim(), person_title: $('.oPos', r).value.trim() }))
        .filter((o) => o.label),
    };
    if (tp.allow_undo && !payload.allow_undo && tp.votes > 0
        && !await ask({ title: t('allowUndo'), body: esc(t('allowUndoHint')), ok: t('save'), danger: true })) return;
    try {
      const nid = await rpc('admin_save_topic', { p: payload });
      A.editing = nid; if (!A.topicId) A.topicId = nid;
      await loadTopics(); toast(t('saved'), 'ok'); viewTopics();
    } catch (err) { fail(err); }
  };
}

// ---- Employees
const HEAD_RX = {
  emp_code: /^(emp_?code|employee\s*(id|code|no\.?)|code|id|no\.?|รหัส.*)$/i,
  first_name: /^(first\s*_?name|given\s*name|name|ชื่อ|ชื่อจริง)$/i,
  last_name: /^(last\s*_?name|surname|family\s*name|นามสกุล)$/i,
  full_name: /^(full\s*_?name|ชื่อ\s*-?\s*นามสกุล|ชื่อ-สกุล|ชื่อสกุล)$/i,
  department: /^(dept|department|section|แผนก|ฝ่าย|หน่วยงาน|ส่วนงาน)$/i,
};
async function viewEmployees() {
  const v = $('#view');
  v.innerHTML = `<div class="head"><h1>${t('navEmployees')}</h1><span class="spacer"></span>
    <button class="btn ghost" id="tpl">⬇ ${t('template')}</button><button class="btn" id="imp">⬆ ${t('importXlsx')}</button></div>
    ${A.topics.some((x) => x.status === 'open') ? `<div class="card" style="margin-bottom:16px"><span class="badge warn">⚠ ${t('openTopicWarn')}</span></div>` : ''}
    <div id="impBox"></div>
    <div class="grid g2" style="margin-top:16px"><div class="card"><h2>${t('departments')}</h2><div class="tablewrap"><table><thead><tr><th>${t('department')}</th><th class="num">${t('people')}</th></tr></thead><tbody id="dBody"></tbody></table></div></div>
    <div class="card"><div class="row"><h2 style="margin:0">${t('current')}</h2><input type="search" id="eSearch" placeholder="${t('search')}" style="max-width:260px;margin-left:auto"></div>
    <div class="tablewrap" style="margin-top:10px"><table><thead><tr><th>${t('empCode')}</th><th>${t('firstName')}</th><th>${t('lastName')}</th><th>${t('department')}</th></tr></thead><tbody id="eBody"></tbody></table></div></div></div>`;
  $('#tpl').onclick = async () => {
    try {
      const f = await window.kcs.xlsx.template();
      if (f) toast(`${t('exported')}: ${f}`, 'ok', { label: t('showInFolder'), fn: () => window.kcs.showFile(f) });
    } catch (e) { fail(e); }
  };
  $('#imp').onclick = async () => { try { const d = await window.kcs.xlsx.open(); if (d) { A.importData = d; drawImport(true); } } catch (e) { fail(e); } };
  try {
    const [depts, emps] = await Promise.all([rpc('admin_departments'), rpc('admin_list_employees')]);
    $('#dBody').innerHTML = depts.map((d) => `<tr><td>${esc(d.department)}</td><td class="num">${d.headcount}</td></tr>`).join('')
      + `<tr class="first"><td>Σ</td><td class="num">${depts.reduce((a, d) => a + d.headcount, 0)}</td></tr>`;
    const draw = () => {
      const q = $('#eSearch').value.trim().toLowerCase();
      $('#eBody').innerHTML = emps.filter((e) => !q || `${e.emp_code} ${e.first_name} ${e.last_name} ${e.department}`.toLowerCase().includes(q)).slice(0, 500)
        .map((e) => `<tr><td class="mono">${esc(e.emp_code)}</td><td>${esc(e.first_name)}</td><td>${esc(e.last_name)}</td><td>${esc(e.department)}</td></tr>`).join('');
    };
    $('#eSearch').oninput = draw; draw();
  } catch (e) { fail(e); }
  if (A.importData) drawImport(false);
}
function drawImport(autoMap) {
  const d = A.importData; const box = $('#impBox');
  if (autoMap) {
    const head = d.rows[0] || [];
    d.hasHeader = head.some((h) => Object.values(HEAD_RX).some((rx) => rx.test(h)));
    d.map = {};
    for (const [k, rx] of Object.entries(HEAD_RX)) { const i = head.findIndex((h) => rx.test(h)); d.map[k] = d.hasHeader && i >= 0 ? i : -1; }
    if (!d.hasHeader) Object.assign(d.map, { emp_code: 0, first_name: 1, last_name: 2, department: 3, full_name: -1 });
  }
  const cols = Math.max(...d.rows.map((r) => r.length));
  const colName = (i) => (d.hasHeader ? d.rows[0][i] : '') || `#${i + 1}`;
  const sel = (k) => `<label class="f">${t({ emp_code: 'empCode', first_name: 'firstName', last_name: 'lastName', full_name: 'fullName', department: 'department' }[k])}
    <select data-map="${k}"><option value="-1">${t('notUsed')}</option>${Array.from({ length: cols }, (_, i) => `<option value="${i}" ${d.map[k] === i ? 'selected' : ''}>${esc(colName(i))}</option>`).join('')}</select></label>`;
  const rows = parseImport();
  const bad = rows.filter((r) => r.err).length;
  box.innerHTML = `<div class="card grid"><div class="row"><h2 style="margin:0">${t('preview')} — ${esc(d.file)} (${esc(d.sheet)})</h2><span class="spacer"></span>
    <label class="check"><input type="checkbox" id="hdr" ${d.hasHeader ? 'checked' : ''}>${t('headerRow')}</label></div>
    <div><h3>${t('colMap')}</h3><div class="grid" style="grid-template-columns:repeat(5,1fr)">${['emp_code', 'first_name', 'last_name', 'full_name', 'department'].map(sel).join('')}</div></div>
    <div class="row"><span class="badge open">${rows.length - bad} ${t('rowsOk')}</span>${bad ? `<span class="badge warn">${bad} ${t('rowsErr')}</span>` : ''}<span class="spacer"></span>
      <span class="small muted">${t('replaceHint')}</span>
      <button class="btn ghost" id="doMerge" ${bad || !rows.length ? 'disabled' : ''}>${t('merge')}</button><button class="btn warn" id="doReplace" ${bad || !rows.length ? 'disabled' : ''}>${t('replace')}</button>
      <button class="btn ghost" id="impCancel">${t('cancel')}</button></div>
    ${bad ? `<div class="err">${t('fixErrors')}</div>` : ''}
    <div class="tablewrap"><table><thead><tr><th>#</th><th>${t('empCode')}</th><th>${t('firstName')}</th><th>${t('lastName')}</th><th>${t('department')}</th><th></th></tr></thead>
    <tbody>${rows.sort((a, b) => (b.err ? 1 : 0) - (a.err ? 1 : 0)).slice(0, 400).map((r) => `<tr class="${r.err ? 'bad' : ''}"><td class="muted">${r.line}</td><td class="mono">${esc(r.emp_code)}</td><td>${esc(r.first_name)}</td><td>${esc(r.last_name)}</td><td>${esc(r.department)}</td><td>${r.err ? `<b style="color:var(--danger)">${esc(r.err)}</b>` : '✓'}</td></tr>`).join('')}</tbody></table></div></div>`;
  $$('[data-map]', box).forEach((s) => { s.onchange = () => { d.map[s.dataset.map] = Number(s.value); drawImport(false); }; });
  $('#hdr').onchange = (e) => { d.hasHeader = e.target.checked; drawImport(false); };
  $('#impCancel').onclick = () => { A.importData = null; box.innerHTML = ''; };
  const run = async (mode) => {
    if (mode === 'replace' && !await ask({ title: t('replace'), body: esc(t('confirmReplace', rows.length)), ok: t('replace'), danger: true })) return;
    try {
      const r = await rpc('admin_import_employees', { p_rows: rows.map(({ emp_code, first_name, last_name, department }) => ({ emp_code, first_name, last_name, department })), p_mode: mode });
      toast(t('imported', r), 'ok'); A.importData = null; viewEmployees();
    } catch (e) { fail(e); }
  };
  $('#doMerge').onclick = () => run('merge');
  $('#doReplace').onclick = () => run('replace');
}
function parseImport() {
  const d = A.importData; const m = d.map;
  const body = d.hasHeader ? d.rows.slice(1) : d.rows;
  const get = (r, k) => (m[k] >= 0 ? String(r[m[k]] ?? '').trim() : '');
  const out = body.map((r, i) => {
    let first = get(r, 'first_name'); let last = get(r, 'last_name');
    if (!first && m.full_name >= 0) {
      const full = get(r, 'full_name').replace(/^(นาย|นางสาว|นาง|น\.ส\.|Mr\.?|Mrs\.?|Ms\.?|Miss)\s*/i, '');
      const sp = full.search(/\s/); first = sp > 0 ? full.slice(0, sp) : full; last = sp > 0 ? full.slice(sp + 1).trim() : '';
    }
    return { line: i + (d.hasHeader ? 2 : 1), emp_code: get(r, 'emp_code'), first_name: first, last_name: last, department: get(r, 'department') };
  });
  const seen = new Map();
  out.forEach((r) => seen.set(r.emp_code, (seen.get(r.emp_code) || 0) + 1));
  out.forEach((r) => {
    if (!r.emp_code || !r.first_name || !r.department) r.err = t('errBlank');
    else if (seen.get(r.emp_code) > 1) r.err = t('errDup');
  });
  return out;
}

// ---- Undo
function viewUndo() {
  const v = $('#view');
  const eligible = (x) => ['open', 'closed'].includes(x.status);
  if (!A.topics.some(eligible)) { v.innerHTML = `<div class="head"><h1>${t('undoTitle')}</h1></div><div class="card muted">${t('noTopics')}</div>`; return; }
  if (!eligible(topic() || {})) A.topicId = A.topics.find(eligible).id;
  v.innerHTML = `<div class="head"><h1>${t('undoTitle')}</h1>${topicSelect('topicSel', eligible)}</div>
    <div class="card grid"><div class="muted">${t('undoHint')}</div><input type="search" id="uq" placeholder="${t('search')}">
    <div class="tablewrap"><table><thead><tr><th>${t('firstName')}</th><th>${t('lastName')}</th><th>${t('department')}</th><th>${t('status')}</th><th></th></tr></thead><tbody id="uBody"></tbody></table></div></div>`;
  bindTopicSelect(load);
  let timer; let seq = 0;
  $('#uq').oninput = () => { clearTimeout(timer); timer = setTimeout(load, 250); };
  async function load() {
    const my = ++seq;
    try {
      const rows = await rpc('admin_voter_status', { p_topic: A.topicId, p_search: $('#uq').value.trim() });
      if (my !== seq || !$('#uBody')) return; // a newer search already answered
      $('#uBody').innerHTML = rows.map((r) => `<tr><td>${esc(r.first_name)}</td><td>${esc(r.last_name)}</td><td>${esc(r.department)}</td>
        <td>${r.voted ? `<span class="badge open">${t('hasVoted')}</span>` : `<span class="muted small">${t('notVoted')}</span>`}</td>
        <td>${r.voted ? `<button class="btn danger sm" data-id="${r.id}" data-n="${esc(r.first_name + ' ' + r.last_name)}">↩ ${t('undo')}</button>` : ''}</td></tr>`).join('');
      $$('#uBody [data-id]').forEach((b) => { b.onclick = () => undo(b.dataset.id, b.dataset.n); });
    } catch (e) { fail(e); }
  }
  async function undo(id, name) {
    const reason = await ask({ title: t('confirmUndo', name), body: esc(t('undoHint')), input: '', placeholder: t('undoReason'), ok: t('undo'), danger: true });
    if (reason === null) return;
    try { await rpc('admin_undo_vote', { p_topic: A.topicId, p_employee: id, p_reason: reason }); toast(t('undone'), 'ok'); load(); refreshStats(); } catch (e) { fail(e); }
  }
  load();
}

// ---- Rules
function viewRules() {
  const v = $('#view');
  const tp = topic();
  if (!tp) { v.innerHTML = `<div class="head"><h1>${t('navRules')}</h1></div><div class="card">${t('noTopics')}</div>`; return; }
  const th = rulesText(tp, 'th'); const en = rulesText(tp, 'en');
  v.innerHTML = `<div class="head"><h1>${t('navRules')}</h1>${topicSelect()}<span class="spacer"></span><button class="btn" id="showRules">🖥 ${t('dm_rules')}</button></div>
    <div class="grid g2"><div class="card rules"><h2>🇹🇭 ${esc(th.title)}</h2><ol>${th.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ol></div>
    <div class="card rules"><h2>🇬🇧 ${esc(en.title)}</h2><ol>${en.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ol></div></div>`;
  bindTopicSelect(viewRules);
  $('#showRules').onclick = () => setDisplayMode('rules');
}

// ---- QR
async function viewQr() {
  const v = $('#view');
  const url = A.cfg.voterUrl || '';
  v.innerHTML = `<div class="head"><h1>${t('qrTitle')}</h1></div>
    <div class="card grid" style="grid-template-columns:auto 1fr;gap:28px;align-items:start">
      <div>${url ? `<img class="qr-img" id="qrImg" alt="QR">` : `<div class="qr-img" style="display:grid;place-items:center;color:var(--muted)">${t('noVoterUrl')}</div>`}</div>
      <div class="grid"><p class="muted">${t('qrHint')}</p>
        <label class="f">${t('voterUrl')}<div class="row" style="flex-wrap:nowrap"><input id="vUrl" type="url" value="${esc(url)}" placeholder="https://kcs-vote.pages.dev"><button class="btn ghost" id="saveUrl">${t('setVoterUrl')}</button></div></label>
        <div class="row"><button class="btn" id="qPng" ${url ? '' : 'disabled'}>⬇ ${t('savePng')}</button><button class="btn ghost" id="qPdf" ${url ? '' : 'disabled'}>⬇ ${t('posterPdf')}</button><button class="btn ghost" id="qPrint" ${url ? '' : 'disabled'}>🖨 ${t('print')}</button></div>
        ${url ? `<a class="mono" href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>` : ''}</div></div>`;
  if (url) $('#qrImg').src = await window.kcs.qr.dataUrl(url);
  const poster = () => ({ url, title: tTitle(topic()) || 'KCS Vote', head: t('posterTitle'), sub: t('posterSub') });
  $('#saveUrl').onclick = async () => {
    const u = $('#vUrl').value.trim();
    if (u && !/^https?:\/\//.test(u)) { toast('URL must start with https://', 'err'); return; }
    await window.kcs.cfg.setVoterUrl(u); A.cfg.voterUrl = u; A.qr = null; toast(t('saved'), 'ok'); viewQr(); pushDisplay();
  };
  if (url) {
    $('#qPng').onclick = async () => { const f = await window.kcs.qr.savePng(url); if (f) toast(`${t('exported')}: ${f}`, 'ok', { label: t('showInFolder'), fn: () => window.kcs.showFile(f) }); };
    $('#qPdf').onclick = async () => { const f = await window.kcs.qr.posterPdf(poster()); if (f) toast(`${t('exported')}: ${f}`, 'ok', { label: t('showInFolder'), fn: () => window.kcs.showFile(f) }); };
    $('#qPrint').onclick = () => window.kcs.qr.print(poster());
  }
}

// ---- Audit
async function viewAudit() {
  const v = $('#view');
  v.innerHTML = `<div class="head"><h1>${t('navAudit')}</h1><span class="spacer"></span><button class="btn ghost" id="ref">⟳ ${t('refresh')}</button></div>
    <div class="card"><div class="tablewrap" style="max-height:none"><table><thead><tr><th>${t('time')}</th><th>${t('action')}</th><th>${t('topic')}</th><th>${t('details')}</th></tr></thead><tbody id="aBody"></tbody></table></div></div>`;
  $('#ref').onclick = viewAudit;
  try {
    const rows = await rpc('admin_audit', { p_limit: 300 });
    const name = (id) => tTitle(A.topics.find((x) => x.id === id)) || (id ? id.slice(0, 8) : '');
    $('#aBody').innerHTML = rows.map((r) => `<tr><td class="small">${fmtDate(r.at)}</td><td><b>${esc(r.action)}</b></td><td>${esc(name(r.topic_id))}</td><td class="mono">${esc(JSON.stringify(r.details))}</td></tr>`).join('');
  } catch (e) { fail(e); }
}

// ---- Settings
async function viewSettings() {
  const v = $('#view');
  const st = await window.kcs.cfg.status();
  let ka = null; try { ka = await rpc('get_keep_alive_status'); } catch (e) { console.warn(e); }
  const kaStale = kaAge(ka) > KA_STALE_MS; const beforeStale = A.kaBefore && kaAge(A.kaBefore) > KA_STALE_MS;
  v.innerHTML = `<div class="head"><h1>${t('navSettings')}</h1></div>
    <div class="card grid" style="margin-bottom:16px"><div class="row"><h2 style="margin:0">${t('kaTitle')}</h2><span class="spacer"></span><button class="btn ghost sm" id="kaPing">⟳ ${t('kaPingNow')}</button></div>
      ${kaStale || beforeStale ? `<div class="err">⚠ ${esc(kaStale ? t('kaStale') : t('kaStaleBefore', fmtDate(A.kaBefore.last_ping) || t('kaNever')))}</div>` : ''}
      <div>${t('kaLast')}: <b>${ka && ka.last_ping ? esc(fmtDate(ka.last_ping)) : t('kaNever')}</b>${ka && ka.source ? ` <span class="badge">${esc(ka.source)}</span>` : ''}</div>
      ${A.kaBefore ? `<div class="small muted">${t('kaBeforeLabel')}: ${A.kaBefore.last_ping ? esc(fmtDate(A.kaBefore.last_ping)) + ' (' + esc(A.kaBefore.source || '') + ')' : t('kaNever')}</div>` : ''}
      <div class="hint">${t('kaHint')}</div></div>
    <div class="card grid" style="margin-bottom:16px"><div class="row"><h2 style="margin:0">${t('updTitle')}</h2><span class="spacer"></span>
      <button class="btn ghost sm" id="updCheck">⟳ ${t('updCheck')}</button>${A.upd && ['ready', 'portable-new'].includes(A.upd.state) ? `<button class="btn sm" id="updGo2">${A.upd.state === 'ready' ? t('updRestart') : t('updDownload')}</button>` : ''}</div>
      <div>${t('updVersion')}: <b>v${esc(st.version)}</b> · <span id="updState">${esc(updText(A.upd))}</span></div>
      <div class="hint">${t('updHint')}</div></div>
    <div class="grid g2">
    <div class="card grid"><h2>${t('language')}</h2><div class="row"><button class="btn ${A.lang === 'th' ? '' : 'ghost'}" data-l="th">ภาษาไทย</button><button class="btn ${A.lang === 'en' ? '' : 'ghost'}" data-l="en">English</button></div>
      <h2 style="margin-top:12px">${t('configAt')}</h2><div class="mono">${esc(st.path)}</div><div class="small muted">${esc(st.supabaseUrl)} · ${esc(st.adminEmail)} · v${esc(st.version)}</div>
      <div class="row"><button class="btn ghost" id="expCfg">⬇ ${t('exportConfig')}</button></div><div class="hint">${t('exportConfigHint')}</div>
      <div class="row"><button class="btn danger" id="rstCfg">${t('resetConfig')}</button></div></div>
    <form class="card grid" id="pwForm"><h2>${t('changePassword')}</h2>
      <label class="f">${t('currentPassword')}<input type="password" id="pOld" required></label>
      <label class="f">${t('newPassword')}<input type="password" id="pNew" minlength="8" required></label>
      <label class="f">${t('confirmPassword')}<input type="password" id="pNew2" minlength="8" required></label>
      <div class="row"><button class="btn">${t('save')}</button></div></form></div>`;
  $$('[data-l]').forEach((b) => { b.onclick = () => { setLang(b.dataset.l); applyStaticText(); pushDisplay(); viewSettings(); }; });
  $('#kaPing').onclick = async () => { await keepAlivePing(); viewSettings(); };
  $('#updCheck').onclick = () => window.kcs.update.check();
  if ($('#updGo2')) $('#updGo2').onclick = updAction;
  $('#expCfg').onclick = async () => { const f = await window.kcs.cfg.exportFile(); if (f) toast(`${t('exported')}: ${f}`, 'ok', { label: t('showInFolder'), fn: () => window.kcs.showFile(f) }); };
  $('#rstCfg').onclick = async () => { if (await ask({ title: t('resetConfig'), body: esc(t('confirmResetCfg')), ok: t('resetConfig'), danger: true })) { await window.kcs.cfg.reset(); lockApp(); } };
  $('#pwForm').onsubmit = async (e) => {
    e.preventDefault();
    if ($('#pNew').value !== $('#pNew2').value) { toast(t('errMismatch'), 'err'); return; }
    try { await window.kcs.cfg.changePassword($('#pOld').value, $('#pNew').value); toast(t('done'), 'ok'); e.target.reset(); }
    catch (err) { toast(String(err.message).includes('BAD_PASSWORD') ? t('errBadPassword') : errText(err), 'err'); }
  };
}

// ---------------------------------------------------------------- auto-update
A.upd = null;
function updText(s) {
  if (!s) return '';
  return ({ ready: t('updReady', s.version), downloading: t('updDownloading', s.version, s.percent || 0), 'portable-new': t('updPortable', s.version),
    latest: t('updLatest'), checking: t('updChecking'), error: `${t('updError')}${s.message ? ': ' + s.message : ''}`, dev: t('updDev') })[s.state] || '';
}
async function updAction() {
  if (!A.upd) return;
  if (A.upd.state === 'portable-new') return window.kcs.update.releases();
  if (A.upd.state === 'ready' && await ask({ title: t('updTitle'), body: esc(t('updConfirm')), ok: t('updRestart') })) window.kcs.update.install();
}
function renderUpdate(s) {
  A.upd = s;
  const bar = $('#updBar');
  const show = s && ['ready', 'downloading', 'portable-new'].includes(s.state);
  bar.hidden = !show;
  bar.innerHTML = show ? `<span>${s.state === 'downloading' ? '⬇' : '🆕'} ${esc(updText(s))}</span>${s.state === 'downloading' ? ''
    : `<button class="btn sm" id="updGo">${s.state === 'ready' ? t('updRestart') : t('updDownload')}</button>`}` : '';
  if ($('#updGo')) $('#updGo').onclick = updAction;
  if (A.view === 'settings' && $('#updState')) $('#updState').textContent = updText(s);
}
window.kcs.update.onStatus(renderUpdate);
window.kcs.update.status().then(renderUpdate).catch(() => {});

// ---------------------------------------------------------------- boot
$('#langBtn').onclick = () => { setLang(A.lang === 'th' ? 'en' : 'th'); applyStaticText(); pushDisplay(); show(A.view); };
$('#lockBtn').onclick = lockApp;
setLang(A.lang);
showGate();
