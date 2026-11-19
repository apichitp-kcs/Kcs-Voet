/* KCS Vote — voter page (no build step, no framework).
 * Talks to Supabase PostgREST RPCs with the public anon key only:
 *   get_open_topics(), voter_names(topic), submit_vote(topic, employee, option, request)
 * Add ?demo=1 to the URL to try the UI with fake data (no network).
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ i18n
  const T = {
    th: {
      loading: 'กำลังโหลด…',
      noTopic: 'ขณะนี้ยังไม่มีหัวข้อที่เปิดโหวต',
      noTopicHint: 'โปรดรอประกาศจากผู้จัดงาน แล้วลองใหม่อีกครั้ง',
      retry: 'ลองใหม่',
      chooseTopic: 'เลือกหัวข้อที่ต้องการโหวต',
      scheduled: 'เปิดโหวตเวลา',
      ended: 'หมดเวลาโหวตแล้ว',
      closesAt: 'ปิดรับโหวตเวลา',
      step1: 'ขั้นที่ 1/3 · เลือกชื่อของคุณ',
      searchPh: 'พิมพ์ชื่อหรือนามสกุล…',
      allDepts: 'ทุกแผนก',
      voted: 'โหวตแล้ว',
      noMatch: 'ไม่พบชื่อ ลองพิมพ์ใหม่หรือเลือกแผนกอื่น',
      countNames: (n) => `${n} รายชื่อ`,
      youAre: 'คุณคือ',
      department: 'แผนก',
      isThisYou: 'ใช่คุณหรือไม่?',
      yesMe: 'ใช่ ฉันเอง',
      notMe: 'ไม่ใช่ฉัน',
      step2: 'ขั้นที่ 2/3 · เลือก 1 ตัวเลือก',
      yourDept: 'แผนกของคุณ',
      next: 'ถัดไป',
      back: 'ย้อนกลับ',
      step3: 'ขั้นที่ 3/3 · ยืนยันการโหวต',
      reviewName: 'ผู้โหวต',
      reviewChoice: 'ตัวเลือกของคุณ',
      reviewNote: 'เมื่อยืนยันแล้วจะแก้ไขไม่ได้ และการโหวตเป็นความลับ',
      confirm: 'ยืนยันการโหวต',
      sending: 'กำลังส่ง…',
      thanks: 'ขอบคุณที่ร่วมโหวต!',
      thanksSub: 'ระบบบันทึกการโหวตของคุณเรียบร้อยแล้ว ผลจะประกาศบนจอหลัก',
      again: 'กลับหน้าแรก (สำหรับผู้โหวตคนถัดไป)',
      anonymity: 'การโหวตเป็นความลับ — ระบบไม่บันทึกว่าใครเลือกอะไร',
      errors: {
        ALREADY_VOTED: 'ชื่อนี้โหวตไปแล้ว หากไม่ใช่คุณ โปรดแจ้งผู้ดูแลระบบ',
        TOPIC_CLOSED: 'หัวข้อนี้ปิดรับโหวตแล้ว',
        TIME_ENDED: 'หมดเวลาโหวตแล้ว',
        NOT_STARTED: 'ยังไม่ถึงเวลาเปิดโหวต',
        TOPIC_NOT_FOUND: 'ไม่พบหัวข้อนี้',
        UNKNOWN_VOTER: 'ไม่พบรายชื่อนี้ในระบบ',
        BAD_OPTION: 'ตัวเลือกไม่ถูกต้อง โปรดเลือกใหม่',
        BAD_REQUEST: 'ข้อมูลไม่ครบ โปรดลองใหม่',
        RATE_LIMITED: 'มีการส่งข้อมูลถี่เกินไป โปรดรอสักครู่แล้วลองใหม่',
        NETWORK: 'เชื่อมต่อไม่ได้ โปรดตรวจสอบอินเทอร์เน็ตแล้วลองใหม่',
        CONFIG: 'ระบบยังไม่ได้ตั้งค่า (config.js)',
        UNKNOWN: 'เกิดข้อผิดพลาด โปรดลองใหม่',
      },
    },
    en: {
      loading: 'Loading…',
      noTopic: 'No voting topic is open right now',
      noTopicHint: 'Please wait for the organiser’s announcement and try again.',
      retry: 'Try again',
      chooseTopic: 'Choose a topic to vote on',
      scheduled: 'Opens at',
      ended: 'Voting time has ended',
      closesAt: 'Closes at',
      step1: 'Step 1/3 · Find your name',
      searchPh: 'Type first or last name…',
      allDepts: 'All departments',
      voted: 'Voted',
      noMatch: 'No match. Try another spelling or department.',
      countNames: (n) => `${n} names`,
      youAre: 'You are',
      department: 'Department',
      isThisYou: 'Is this you?',
      yesMe: 'Yes, that’s me',
      notMe: 'Not me',
      step2: 'Step 2/3 · Pick ONE option',
      yourDept: 'Your department',
      next: 'Next',
      back: 'Back',
      step3: 'Step 3/3 · Confirm your vote',
      reviewName: 'Voter',
      reviewChoice: 'Your choice',
      reviewNote: 'Votes cannot be changed after confirming. Your vote is secret.',
      confirm: 'Confirm vote',
      sending: 'Sending…',
      thanks: 'Thank you for voting!',
      thanksSub: 'Your vote has been recorded. Results will be announced on the main screen.',
      again: 'Back to start (for the next voter)',
      anonymity: 'Secret ballot — the system never stores who chose what.',
      errors: {
        ALREADY_VOTED: 'This name has already voted. If it was not you, please tell the administrator.',
        TOPIC_CLOSED: 'Voting for this topic is closed.',
        TIME_ENDED: 'Voting time has ended.',
        NOT_STARTED: 'Voting has not started yet.',
        TOPIC_NOT_FOUND: 'Topic not found.',
        UNKNOWN_VOTER: 'This name is not in the list.',
        BAD_OPTION: 'Invalid option, please choose again.',
        BAD_REQUEST: 'Missing data, please try again.',
        RATE_LIMITED: 'Too many requests. Please wait a moment and try again.',
        NETWORK: 'Cannot connect. Check your internet connection and try again.',
        CONFIG: 'The system is not configured yet (config.js).',
        UNKNOWN: 'Something went wrong. Please try again.',
      },
    },
  };

  const params = new URLSearchParams(location.search);
  const DEMO = params.get('demo') === '1';
  const S = {
    lang: (params.get('lang') || localStorage.getItem('kcs-lang') || 'th') === 'en' ? 'en' : 'th',
    step: 'loading', topics: [], topic: null, voters: [], me: null, option: null,
    query: '', dept: '', requestId: null, error: null, busy: false,
  };
  const t = (k) => T[S.lang][k];
  const app = document.getElementById('app');

  // ------------------------------------------------------------------ utils
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
  // Thai-friendly search: ignore case, spaces, tone marks and other combining vowels/diacritics.
  const norm = (s) => String(s || '').normalize('NFC').toLowerCase()
    .replace(/[ัิ-ฺ็-๎̀-ͯ]/g, '').replace(/\s+/g, '');
  const fullName = (v) => `${v.first_name} ${v.last_name || ''}`.trim();
  const label = (o) => (S.lang === 'en' && o.label_en) || o.label;
  const title = (tp) => (S.lang === 'en' && tp.title_en) || tp.title;
  const desc = (tp) => (S.lang === 'en' && tp.description_en) || tp.description || '';
  const fmtTime = (iso) => new Date(iso).toLocaleString(S.lang === 'th' ? 'th-TH' : 'en-GB',
    { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  // ------------------------------------------------------------------ API
  class ApiError extends Error { constructor(code) { super(code); this.code = code; } }
  const cfg = window.KCS_CONFIG || {};

  async function rpc(fn, args) {
    if (DEMO) return demoRpc(fn, args);
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_URL.includes('YOUR-PROJECT')) throw new ApiError('CONFIG');
    const headers = { 'Content-Type': 'application/json', apikey: cfg.SUPABASE_ANON_KEY };
    if (cfg.SUPABASE_ANON_KEY.startsWith('eyJ')) headers.Authorization = 'Bearer ' + cfg.SUPABASE_ANON_KEY; // legacy JWT anon key
    let res;
    try {
      res = await fetch(`${cfg.SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args || {}), cache: 'no-store' });
    } catch (e) { throw new ApiError('NETWORK'); }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (body && body.message) || '';
      throw new ApiError(T.th.errors[msg] ? msg : res.status === 429 ? 'RATE_LIMITED' : 'UNKNOWN');
    }
    return body;
  }

  /** Submit with automatic retry on network failure. The same request id makes
   *  retries idempotent (the server answers {ok:true, duplicate:true}). */
  async function submitWithRetry() {
    const args = { p_topic: S.topic.id, p_employee: S.me.id, p_option: S.option.id, p_request: S.requestId };
    let last;
    for (let i = 0; i < 4; i++) {
      try {
        const r = await rpc('submit_vote', args);
        if (r && r.ok) return r;
        throw new ApiError((r && r.code) || 'UNKNOWN');
      } catch (e) {
        last = e;
        if (e.code !== 'NETWORK') throw e;
        await new Promise((ok) => setTimeout(ok, 800 * (i + 1)));
      }
    }
    throw last;
  }

  // ------------------------------------------------------------------ data
  async function loadTopics() {
    S.step = 'loading'; render();
    try {
      S.topics = await rpc('get_open_topics', {});
      if (S.topic) S.topic = S.topics.find((x) => x.id === S.topic.id) || null;
      if (!S.topics.length) S.step = 'none';
      else if (S.topics.length === 1) await pickTopic(S.topics[0].id);
      else S.step = 'topics';
    } catch (e) { fail(e); }
    render();
  }

  async function pickTopic(id) {
    S.topic = S.topics.find((x) => x.id === id);
    S.me = null; S.option = null; S.query = ''; S.dept = '';
    if (S.topic.state !== 'open') { S.step = 'topics'; return; }
    await loadNames();
    S.step = 'names';
  }

  async function loadNames() {
    S.voters = await rpc('voter_names', { p_topic: S.topic.id });
    if (!S.voters.length) throw new ApiError('TOPIC_CLOSED');
  }

  function fail(e) {
    S.error = (e && e.code) || 'UNKNOWN';
    S.step = 'error';
    if (!(e instanceof ApiError)) console.error(e);
  }

  // ------------------------------------------------------------------ render
  function stepHeader(text) {
    return `<div class="topic-head">
      <h1>${esc(title(S.topic))}</h1>
      ${desc(S.topic) ? `<p class="muted">${esc(desc(S.topic))}</p>` : ''}
      ${S.topic.close_at ? `<p class="pill">${t('closesAt')} ${esc(fmtTime(S.topic.close_at))}</p>` : ''}
    </div><p class="step">${text}</p>`;
  }

  function render() {
    document.documentElement.lang = S.lang;
    document.getElementById('lang').textContent = S.lang === 'th' ? 'EN' : 'ไทย';
    document.getElementById('foot').textContent = `🔒 ${t('anonymity')}`;
    const v = views[S.step] || views.loading;
    app.innerHTML = v();
    app.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', onAction));
    if (S.step === 'names') bindNames();
    window.scrollTo({ top: 0 });
  }

  const views = {
    loading: () => `<div class="center"><div class="spinner"></div><p class="muted">${t('loading')}</p></div>`,
    none: () => `<div class="card center">
        <div class="big-icon">🗳️</div><h2>${t('noTopic')}</h2><p class="muted">${t('noTopicHint')}</p>
        <button class="btn primary" data-act="reload">${t('retry')}</button></div>`,
    error: () => `<div class="card center">
        <div class="big-icon">⚠️</div><h2>${esc(T[S.lang].errors[S.error] || T[S.lang].errors.UNKNOWN)}</h2>
        <button class="btn primary" data-act="reload">${t('retry')}</button></div>`,
    topics: () => `<h2 class="h2">${t('chooseTopic')}</h2><div class="list">${S.topics.map((tp) => `
        <button class="topic-card" data-act="topic" data-id="${tp.id}" ${tp.state !== 'open' ? 'disabled' : ''}>
          <strong>${esc(title(tp))}</strong>
          ${desc(tp) ? `<span class="muted">${esc(desc(tp))}</span>` : ''}
          ${tp.state === 'scheduled' ? `<span class="pill">${t('scheduled')} ${esc(fmtTime(tp.open_at))}</span>` : ''}
          ${tp.state === 'ended' ? `<span class="pill warn">${t('ended')}</span>` : ''}
        </button>`).join('')}</div>`,
    names: () => {
      const depts = [...new Set(S.voters.map((v) => v.department))].sort((a, b) => a.localeCompare(b, 'th'));
      return `${S.topics.length > 1 ? `<button class="link" data-act="topics">‹ ${t('back')}</button>` : ''}
        ${stepHeader(t('step1'))}
        <div class="search">
          <input id="q" type="search" inputmode="search" autocomplete="off" autocorrect="off" spellcheck="false"
                 placeholder="${t('searchPh')}" value="${esc(S.query)}" aria-label="${t('searchPh')}">
          <select id="dept" aria-label="${t('department')}">
            <option value="">${t('allDepts')}</option>
            ${depts.map((d) => `<option ${d === S.dept ? 'selected' : ''}>${esc(d)}</option>`).join('')}
          </select>
        </div>
        <p class="muted small" id="count"></p>
        <ul class="names" id="names" role="listbox"></ul>`;
    },
    me: () => `${stepHeader(t('step1'))}
      <div class="card who">
        <p class="muted">${t('youAre')}</p>
        <p class="who-name">${esc(fullName(S.me))}</p>
        <p class="who-dept"><span class="muted">${t('department')}</span> <strong>${esc(S.me.department)}</strong></p>
        <p class="muted">${t('isThisYou')}</p>
        <div class="row">
          <button class="btn ghost" data-act="notme">${t('notMe')}</button>
          <button class="btn primary" data-act="isme">${t('yesMe')}</button>
        </div>
      </div>`,
    choose: () => `${stepHeader(t('step2'))}
      <div class="options">${S.topic.options.map((o) => `
        <button class="option ${S.option && S.option.id === o.id ? 'selected' : ''}" data-act="option" data-id="${o.id}" aria-pressed="${S.option && S.option.id === o.id}">
          <span class="opt-label">${esc(label(o))}</span>
          ${o.department && o.department === S.me.department ? `<span class="tag">${t('yourDept')}</span>` : ''}
          <span class="check" aria-hidden="true">✓</span>
        </button>`).join('')}</div>
      <div class="sticky-actions">
        <button class="btn ghost" data-act="toMe">${t('back')}</button>
        <button class="btn primary" data-act="review" ${S.option ? '' : 'disabled'}>${t('next')}</button>
      </div>`,
    review: () => `${stepHeader(t('step3'))}
      <div class="card review">
        <p class="muted">${t('reviewName')}</p><p class="strong">${esc(fullName(S.me))} · ${esc(S.me.department)}</p>
        <p class="muted">${t('reviewChoice')}</p><p class="choice">${esc(label(S.option))}</p>
        <p class="note">${t('reviewNote')}</p>
        ${S.error ? `<p class="err" role="alert">${esc(T[S.lang].errors[S.error] || T[S.lang].errors.UNKNOWN)}</p>` : ''}
        <div class="row">
          <button class="btn ghost" data-act="toChoose" ${S.busy ? 'disabled' : ''}>${t('back')}</button>
          <button class="btn primary" data-act="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? t('sending') : t('confirm')}</button>
        </div>
      </div>`,
    done: () => `<div class="card center done">
        <div class="tick" aria-hidden="true"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24"/><path d="M14 27l8 8 16-17"/></svg></div>
        <h2>${t('thanks')}</h2><p class="muted">${t('thanksSub')}</p>
        <button class="btn ghost" data-act="restart">${t('again')}</button></div>`,
  };

  function bindNames() {
    const q = document.getElementById('q');
    const sel = document.getElementById('dept');
    const list = document.getElementById('names');
    const count = document.getElementById('count');
    const draw = () => {
      const nq = norm(S.query);
      const rows = S.voters.filter((v) => (!S.dept || v.department === S.dept)
        && (!nq || norm(fullName(v)).includes(nq) || norm(v.last_name + v.first_name).includes(nq)));
      count.textContent = T[S.lang].countNames(rows.length);
      list.innerHTML = rows.length ? rows.slice(0, 200).map((v) => `
        <li><button class="name ${v.voted ? 'is-voted' : ''}" data-id="${v.id}" ${v.voted ? 'disabled aria-disabled="true"' : ''}>
          <span><strong>${esc(fullName(v))}</strong><small>${esc(v.department)}</small></span>
          ${v.voted ? `<em>${t('voted')}</em>` : '<b aria-hidden="true">›</b>'}
        </button></li>`).join('') : `<li class="muted empty">${t('noMatch')}</li>`;
    };
    q.addEventListener('input', () => { S.query = q.value; draw(); });
    sel.addEventListener('change', () => { S.dept = sel.value; draw(); });
    list.addEventListener('click', (ev) => {
      const b = ev.target.closest('button.name');
      if (!b || b.disabled) return;
      S.me = S.voters.find((v) => v.id === b.dataset.id);
      S.option = null; S.error = null;
      S.step = 'me'; render();
    });
    draw();
  }

  async function onAction(ev) {
    const el = ev.currentTarget;
    switch (el.dataset.act) {
      case 'reload': S.error = null; S.topic = null; return loadTopics();
      case 'topics': S.step = 'topics'; return render();
      case 'topic':
        try { await pickTopic(el.dataset.id); } catch (e) { fail(e); }
        return render();
      case 'notme': S.me = null; S.step = 'names'; return render();
      case 'isme': S.step = 'choose'; return render();
      case 'toMe': S.step = 'me'; return render();
      case 'toChoose':
        S.step = S.error === 'ALREADY_VOTED' ? 'names' : 'choose'; S.error = null;
        if (S.step === 'names') { S.me = null; try { await loadNames(); } catch (e) { fail(e); } }
        return render();
      case 'option':
        S.option = S.topic.options.find((o) => o.id === el.dataset.id);
        app.querySelectorAll('.option').forEach((b) => {
          const on = b.dataset.id === S.option.id;
          b.classList.toggle('selected', on); b.setAttribute('aria-pressed', on);
        });
        app.querySelector('[data-act="review"]').disabled = false;
        return;
      case 'review': S.requestId = uuid(); S.error = null; S.step = 'review'; return render();
      case 'submit':
        S.busy = true; S.error = null; render();
        try {
          await submitWithRetry();
          S.step = 'done';
        } catch (e) {
          S.error = e.code || 'UNKNOWN';
          if (['TOPIC_CLOSED', 'TIME_ENDED', 'TOPIC_NOT_FOUND'].includes(S.error)) S.step = 'error';
        }
        S.busy = false; return render();
      case 'restart':
        S.me = null; S.option = null; S.query = ''; S.dept = ''; S.error = null;
        return loadTopics();
    }
  }

  document.getElementById('lang').addEventListener('click', () => {
    S.lang = S.lang === 'th' ? 'en' : 'th';
    localStorage.setItem('kcs-lang', S.lang);
    render();
  });

  // Keep "voted" flags fresh while someone is browsing the name list.
  setInterval(async () => {
    if (S.step !== 'names' || document.hidden) return;
    try {
      const fresh = await rpc('voter_names', { p_topic: S.topic.id });
      if (!fresh.length) return loadTopics();
      S.voters = fresh;
      const q = document.getElementById('q');
      if (q) q.dispatchEvent(new Event('input'));
    } catch (_) { /* ignore background errors */ }
  }, 20000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ['none', 'topics', 'error'].includes(S.step)) loadTopics();
  });

  // ------------------------------------------------------------------ demo mode
  const demo = (() => {
    const depts = ['ฝ่ายผลิต', 'ฝ่ายหล่อ', 'ฝ่ายแม่พิมพ์', 'ฝ่ายควบคุมคุณภาพ', 'ฝ่ายซ่อมบำรุง', 'ฝ่ายคลังสินค้า',
      'ฝ่ายจัดซื้อ', 'ฝ่ายบัญชี', 'ฝ่ายบุคคล', 'ฝ่ายขาย', 'ฝ่ายไอที', 'ฝ่ายวิศวกรรม'];
    const firsts = ['สมชาย', 'สมหญิง', 'วิชัย', 'อรุณี', 'ประเสริฐ', 'กาญจนา', 'ธนพล', 'นภา', 'ศักดิ์ชัย', 'มาลี', 'John', 'Somsak'];
    const lasts = ['ใจดี', 'รักงาน', 'ศรีสุข', 'มั่นคง', 'บุญมา', 'แก้วใส', 'ทองดี', 'Smith'];
    const voters = Array.from({ length: 60 }, (_, i) => ({
      id: 'demo-' + i, first_name: firsts[i % firsts.length], last_name: lasts[(i * 7) % lasts.length] + (i > 20 ? ' ' + i : ''),
      department: depts[i % depts.length], voted: i % 9 === 0,
    }));
    const topic = { id: 'demo-topic', title: 'รางวัลแผนกยอดเยี่ยมประจำปี 2569', title_en: 'Best Department Award 2026',
      description: 'เลือกแผนกที่คุณคิดว่าทำผลงานได้ดีที่สุดในปีนี้', description_en: 'Choose the department that performed best this year',
      state: 'open', open_at: null, close_at: new Date(Date.now() + 3 * 3600e3).toISOString(),
      options: depts.map((d, i) => ({ id: 'opt-' + i, label: d, label_en: null, department: d })) };
    return { voters, topic };
  })();
  async function demoRpc(fn, args) {
    await new Promise((ok) => setTimeout(ok, 250));
    if (fn === 'get_open_topics') return [demo.topic];
    if (fn === 'voter_names') return demo.voters.map((v) => ({ ...v }));
    if (fn === 'submit_vote') {
      const v = demo.voters.find((x) => x.id === args.p_employee);
      if (v.voted) return { ok: false, code: 'ALREADY_VOTED' };
      v.voted = true; return { ok: true };
    }
    throw new ApiError('UNKNOWN');
  }

  loadTopics();
})();
