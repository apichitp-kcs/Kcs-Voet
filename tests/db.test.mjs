// Runs the real Supabase migration inside PGlite (Postgres compiled to WASM)
// and tests scoring + the one-vote-per-name guarantee.   npm test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const MIG_DIR = new URL('../supabase/migrations/', import.meta.url);
const migrations = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => readFileSync(new URL(f, MIG_DIR), 'utf8'));

const ADMIN = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';

// Minimal stand-ins for what Supabase provides (roles + auth.uid()).
const SUPABASE_SHIM = `
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth, public to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`;

async function freshDb() {
  const db = new PGlite();
  await db.exec(SUPABASE_SHIM);
  for (const sql of migrations) await db.exec(sql);
  await db.query('insert into admins(user_id) values ($1)', [ADMIN]);
  return db;
}

/** Run fn with a given Postgres role / JWT subject, like PostgREST does. */
async function as(db, role, sub, fn) {
  await db.exec(`set request.jwt.claim.sub = '${sub ?? ''}'; set role ${role};`);
  try { return await fn(); } finally { await db.exec('reset role; reset request.jwt.claim.sub;'); }
}
const asAdmin = (db, fn) => as(db, 'authenticated', ADMIN, fn);
const asAnon = (db, fn) => as(db, 'anon', null, fn);

async function rpc(db, sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows;
}

/** departments: {A: 50, B: 5, C: 10} -> employees A-001.. ; returns {A:[ids], ...} */
async function seedEmployees(db, departments) {
  const ids = {};
  for (const [dept, n] of Object.entries(departments)) {
    ids[dept] = [];
    for (let i = 1; i <= n; i++) {
      const r = await db.query(
        `insert into employees(emp_code, first_name, last_name, department)
         values ($1, $2, $3, $4) returning id`,
        [`${dept}-${String(i).padStart(3, '0')}`, `ชื่อ${dept}${i}`, `นามสกุล${i}`, dept]);
      ids[dept].push(r.rows[0].id);
    }
  }
  return ids;
}

/** Topic with one option per department (department-linked => self-vote detection). */
async function createDeptTopic(db, depts, extra = {}) {
  return asAdmin(db, async () => {
    const [{ id }] = await rpc(db, 'select admin_save_topic($1::jsonb) as id', [JSON.stringify({
      title: 'แผนกยอดเยี่ยม', title_en: 'Best department',
      options: depts.map((d) => ({ label: `แผนก ${d}`, label_en: `Dept ${d}`, department: d })),
      ...extra,
    })]);
    await rpc(db, `select admin_set_status($1, 'open')`, [id]);
    const opts = await rpc(db, 'select id, department from topic_options where topic_id = $1', [id]);
    return { id, opt: Object.fromEntries(opts.map((o) => [o.department, o.id])) };
  });
}

async function vote(db, topic, employee, option, request = randomUUID()) {
  return asAnon(db, async () => (await rpc(db,
    'select submit_vote($1, $2, $3, $4) as r', [topic, employee, option, request]))[0].r);
}

async function castMany(db, topic, employees, option) {
  for (const e of employees) {
    const r = await vote(db, topic, e, option);
    assert.equal(r.ok, true, JSON.stringify(r));
  }
}

async function scores(db, topic) {
  const s = await asAdmin(db, async () => (await rpc(db, 'select admin_live_stats($1) as s', [topic]))[0].s);
  const by = Object.fromEntries(s.scores.map((x) => [x.department, x]));
  return { ...s, by };
}
const num = (x) => Number(x);

// ---------------------------------------------------------------------------
describe('scoring', () => {
  test('a 50-person department cannot win by size (50 vs 5)', async () => {
    const db = await freshDb();
    const e = await seedEmployees(db, { A: 50, B: 5, C: 10 });
    const t = await createDeptTopic(db, ['A', 'B', 'C']);
    await castMany(db, t.id, e.A, t.opt.C);        // all 50 of A -> C
    await castMany(db, t.id, e.B, t.opt.A);        // all 5 of B  -> A
    const s = await scores(db, t.id);
    assert.equal(num(s.by.C.score), 1);
    assert.equal(num(s.by.A.score), 1);
    assert.equal(num(s.by.B.score), 0);
    assert.equal(s.by.C.raw_votes, 50);
    assert.equal(s.by.A.raw_votes, 5);
    // equal weighted score => tie, both rank 1
    assert.equal(s.by.A.rank, 1);
    assert.equal(s.by.C.rank, 1);
    assert.equal(s.by.A.is_tie, true);
    assert.equal(s.by.B.rank, 3);
    assert.equal(s.voted, 55);
    assert.equal(s.eligible, 65);
  });

  test('admin tiebreak decides the order of tied options', async () => {
    const db = await freshDb();
    const e = await seedEmployees(db, { A: 5, B: 5, C: 5 });
    const t = await createDeptTopic(db, ['A', 'B', 'C']);
    await castMany(db, t.id, e.A, t.opt.C);
    await castMany(db, t.id, e.C, t.opt.A);
    await asAdmin(db, () => rpc(db, 'select admin_set_tiebreak($1, $2::uuid[])', [t.id, [t.opt.C, t.opt.A, t.opt.B]]));
    let s = await scores(db, t.id);
    assert.deepEqual(s.scores.map((x) => x.department), ['C', 'A', 'B']);
    await asAdmin(db, () => rpc(db, 'select admin_set_tiebreak($1, $2::uuid[])', [t.id, [t.opt.A, t.opt.C, t.opt.B]]));
    s = await scores(db, t.id);
    assert.deepEqual(s.scores.map((x) => x.department), ['A', 'C', 'B']);
  });

  test('own-department votes count at self_vote_weight and the department still totals 1.0', async () => {
    const db = await freshDb();
    const e = await seedEmployees(db, { A: 5, B: 5 });
    const t = await createDeptTopic(db, ['A', 'B']);
    await castMany(db, t.id, e.B.slice(0, 4), t.opt.B);   // 4 self votes
    await castMany(db, t.id, e.B.slice(4), t.opt.A);      // 1 other vote
    // raw 4*0.5=2 and 1 -> B = 2/3, A = 1/3
    let s = await scores(db, t.id);
    assert.equal(num(s.by.B.score), 0.666667);
    assert.equal(num(s.by.A.score), 0.333333);
    assert.ok(Math.abs(num(s.by.A.score) + num(s.by.B.score) - 1) < 1e-5);

    await asAdmin(db, () => rpc(db, 'select admin_save_topic($1::jsonb)', [JSON.stringify({
      id: t.id, self_vote_weight: 1, options: Object.entries(t.opt).map(([d, id]) => ({ id, label: `แผนก ${d}`, department: d })),
    })]));
    s = await scores(db, t.id);
    assert.equal(num(s.by.B.score), 0.8);
    assert.equal(num(s.by.A.score), 0.2);
  });

  test('self_vote_weight = 0 with only self votes contributes nothing (no division by zero)', async () => {
    const db = await freshDb();
    const e = await seedEmployees(db, { A: 5, B: 5 });
    const t = await createDeptTopic(db, ['A', 'B'], { self_vote_weight: 0 });
    await castMany(db, t.id, e.B, t.opt.B);
    await castMany(db, t.id, e.A.slice(0, 2), t.opt.B);
    const s = await scores(db, t.id);
    assert.equal(num(s.by.B.score), 1);   // only department A's 1.0
    assert.equal(num(s.by.A.score), 0);
  });

  test('low-turnout departments are flagged, excluded, and can be re-included', async () => {
    const db = await freshDb();
    const e = await seedEmployees(db, { A: 50, B: 5 });
    const t = await createDeptTopic(db, ['A', 'B']);
    await castMany(db, t.id, e.A.slice(0, 10), t.opt.B);  // 20% of A -> low
    await castMany(db, t.id, e.B.slice(0, 2), t.opt.A);   // 40% of B -> ok
    let s = await scores(db, t.id);
    const tA = s.turnout.find((d) => d.department === 'A');
    assert.equal(tA.low_turnout, true);
    assert.equal(tA.excluded, true);
    assert.equal(num(tA.turnout_pct), 20);
    assert.equal(num(s.by.B.score), 0);
    assert.equal(num(s.by.A.score), 1);
    assert.equal(s.by.B.raw_votes, 10);                   // raw counts still shown

    await asAdmin(db, () => rpc(db, `select admin_set_low_turnout_included($1, array['A'])`, [t.id]));
    s = await scores(db, t.id);
    assert.equal(s.turnout.find((d) => d.department === 'A').excluded, false);
    assert.equal(s.turnout.find((d) => d.department === 'A').low_turnout, true); // still flagged
    assert.equal(num(s.by.B.score), 1);
  });

  test('weighting disabled = plain vote count, nothing excluded', async () => {
    const db = await freshDb();
    const e = await seedEmployees(db, { A: 50, B: 5 });
    const t = await createDeptTopic(db, ['A', 'B'], { weighting_enabled: false });
    await castMany(db, t.id, e.A.slice(0, 10), t.opt.A);
    await castMany(db, t.id, e.B, t.opt.B);
    const s = await scores(db, t.id);
    assert.equal(num(s.by.A.score), 10);
    assert.equal(num(s.by.B.score), 5);
    assert.equal(s.scores[0].department, 'A');
    assert.ok(s.turnout.every((d) => d.excluded === false));
  });
});

// ---------------------------------------------------------------------------
describe('one vote per name', () => {
  test('second vote under the same name is rejected; retry of the same request is idempotent', async () => {
    const db = await freshDb();
    const e = await seedEmployees(db, { A: 3, B: 3 });
    const t = await createDeptTopic(db, ['A', 'B']);
    const req = randomUUID();
    assert.deepEqual(await vote(db, t.id, e.A[0], t.opt.B, req), { ok: true });
    assert.deepEqual(await vote(db, t.id, e.A[0], t.opt.B, req), { ok: true, duplicate: true });
    assert.deepEqual(await vote(db, t.id, e.A[0], t.opt.A), { ok: false, code: 'ALREADY_VOTED' });
    const [{ n }] = await rpc(db, 'select count(*)::int n from ballots where topic_id = $1', [t.id]);
    assert.equal(n, 1);
    const [{ votes }] = await rpc(db, 'select votes from topic_counters where topic_id = $1', [t.id]);
    assert.equal(votes, 1);
    const names = await asAnon(db, () => rpc(db, 'select * from voter_names($1)', [t.id]));
    assert.equal(names.find((x) => x.id === e.A[0]).voted, true);
    assert.equal(names.find((x) => x.id === e.A[1]).voted, false);
    assert.ok(!('emp_code' in names[0]), 'emp_code must never reach voters');
  });

  test('100 rapid submits for one name produce exactly one ballot', async () => {
    const db = await freshDb();
    const e = await seedEmployees(db, { A: 2, B: 2 });
    const t = await createDeptTopic(db, ['A', 'B']);
    const results = await Promise.all(Array.from({ length: 100 }, () => vote(db, t.id, e.A[1], t.opt.A)));
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.ok(results.filter((r) => !r.ok).every((r) => ['ALREADY_VOTED', 'RATE_LIMITED'].includes(r.code)));
    const [{ n }] = await rpc(db, 'select count(*)::int n from ballots');
    assert.equal(n, 1);
  });

  test('rejects votes when the topic is not open or outside its time window', async () => {
    const db = await freshDb();
    const e = await seedEmployees(db, { A: 3, B: 3 });
    const t = await createDeptTopic(db, ['A', 'B']);
    const opts = Object.entries(t.opt).map(([d, id]) => ({ id, label: `แผนก ${d}`, department: d }));
    const save = (extra) => asAdmin(db, () => rpc(db, 'select admin_save_topic($1::jsonb)',
      [JSON.stringify({ id: t.id, options: opts, ...extra })]));

    await save({ open_at: new Date(Date.now() + 3600e3).toISOString() });
    assert.equal((await vote(db, t.id, e.A[0], t.opt.B)).code, 'NOT_STARTED');
    assert.equal((await asAnon(db, () => rpc(db, 'select * from voter_names($1)', [t.id]))).length, 0,
      'name list must be hidden before the window opens');

    await save({ open_at: new Date(Date.now() - 7200e3).toISOString(), close_at: new Date(Date.now() - 3600e3).toISOString() });
    assert.equal((await vote(db, t.id, e.A[0], t.opt.B)).code, 'TIME_ENDED');

    await save({ open_at: null, close_at: null });
    assert.equal((await vote(db, t.id, e.A[0], t.opt.B)).ok, true);
    await asAdmin(db, () => rpc(db, `select admin_set_status($1, 'closed')`, [t.id]));
    assert.equal((await vote(db, t.id, e.A[1], t.opt.B)).code, 'TOPIC_CLOSED');
    assert.equal((await asAnon(db, () => rpc(db, 'select * from voter_names($1)', [t.id]))).length, 0);
    assert.equal((await vote(db, t.id, e.A[1], randomUUID())).ok, false);
  });

  test('option from another topic and unknown voter are rejected', async () => {
    const db = await freshDb();
    const e = await seedEmployees(db, { A: 3, B: 3 });
    const t1 = await createDeptTopic(db, ['A', 'B']);
    const t2 = await createDeptTopic(db, ['A', 'B']);
    assert.equal((await vote(db, t1.id, e.A[0], t2.opt.B)).code, 'BAD_OPTION');
    assert.equal((await vote(db, t1.id, randomUUID(), t1.opt.B)).code, 'UNKNOWN_VOTER');
  });
});

// ---------------------------------------------------------------------------
describe('admin undo + anonymity', () => {
  test('undo removes exactly that ballot, frees the name and is audited without the choice', async () => {
    const db = await freshDb();
    const e = await seedEmployees(db, { A: 3, B: 3 });
    const t = await createDeptTopic(db, ['A', 'B']);
    await vote(db, t.id, e.A[0], t.opt.B);
    await vote(db, t.id, e.A[1], t.opt.B);
    await asAdmin(db, () => rpc(db, 'select admin_undo_vote($1, $2, $3)', [t.id, e.A[0], 'voted under wrong name']));
    const s = await scores(db, t.id);
    assert.equal(s.by.B.raw_votes, 1);
    assert.equal(s.voted, 1);
    assert.equal((await vote(db, t.id, e.A[0], t.opt.A)).ok, true, 'name is free again');
    const [log] = await rpc(db, `select details from audit_log where action = 'undo_vote'`);
    assert.equal(log.details.reason, 'voted under wrong name');
    assert.ok(!JSON.stringify(log.details).includes(t.opt.B), 'audit must not contain the option');
  });

  test('allow_undo = false stores no link; undo is refused; switching off erases links', async () => {
    const db = await freshDb();
    const e = await seedEmployees(db, { A: 3, B: 3 });
    const t = await createDeptTopic(db, ['A', 'B']);
    await vote(db, t.id, e.A[0], t.opt.B);
    const [{ n: linked }] = await rpc(db, 'select count(ballot_id)::int n from voters_registry');
    assert.equal(linked, 1);
    await asAdmin(db, () => rpc(db, 'select admin_save_topic($1::jsonb)', [JSON.stringify({
      id: t.id, allow_undo: false, options: Object.entries(t.opt).map(([d, id]) => ({ id, label: `แผนก ${d}`, department: d })) })]));
    await vote(db, t.id, e.A[1], t.opt.A);
    const [{ n: after }] = await rpc(db, 'select count(ballot_id)::int n from voters_registry');
    assert.equal(after, 0);
    await assert.rejects(asAdmin(db, () => rpc(db, 'select admin_undo_vote($1, $2, null)', [t.id, e.A[1]])), /UNDO_DISABLED/);
  });

  test('ballots carry no identity and no timestamp', async () => {
    const db = await freshDb();
    const cols = (await rpc(db, `select column_name from information_schema.columns
                                  where table_schema = 'public' and table_name = 'ballots'`)).map((r) => r.column_name).sort();
    assert.deepEqual(cols, ['id', 'option_id', 'topic_id', 'voter_department']);
  });
});

// ---------------------------------------------------------------------------
describe('access control', () => {
  test('anon cannot read tables or call admin RPCs; non-admin users get NOT_ADMIN', async () => {
    const db = await freshDb();
    const e = await seedEmployees(db, { A: 3, B: 3 });
    const t = await createDeptTopic(db, ['A', 'B']);
    for (const table of ['ballots', 'voters_registry', 'employees', 'topics', 'audit_log']) {
      await assert.rejects(asAnon(db, () => rpc(db, `select * from ${table}`)), /permission denied/, table);
    }
    await assert.rejects(asAnon(db, () => rpc(db, 'select admin_live_stats($1)', [t.id])), /permission denied/);
    await assert.rejects(asAnon(db, () => rpc(db, 'select * from score_topic($1)', [t.id])), /permission denied/);
    await assert.rejects(asAnon(db, () => rpc(db, 'select * from list_voters($1)', [t.id])), /permission denied/);
    await assert.rejects(as(db, 'authenticated', STRANGER, () => rpc(db, 'select admin_live_stats($1)', [t.id])), /NOT_ADMIN/);
    // authenticated non-admin sees no rows through RLS
    const rows = await as(db, 'authenticated', STRANGER, () => rpc(db, 'select * from topics'));
    assert.equal(rows.length, 0);
    await assert.rejects(as(db, 'authenticated', STRANGER, () => rpc(db, 'select * from ballots')), /permission denied/);
    assert.ok(e);
  });

  test('voters never get results from get_open_topics', async () => {
    const db = await freshDb();
    await seedEmployees(db, { A: 3, B: 3 });
    const t = await createDeptTopic(db, ['A', 'B']);
    const [{ r }] = await asAnon(db, () => rpc(db, 'select get_open_topics() as r'));
    assert.equal(r.length, 1);
    assert.equal(r[0].id, t.id);
    assert.ok(!JSON.stringify(r).match(/score|raw_votes|votes/));
  });
});

// ---------------------------------------------------------------------------
describe('topics + import', () => {
  test('import validates duplicates / blanks and supports replace and merge', async () => {
    const db = await freshDb();
    const imp = (rows, mode) => asAdmin(db, () => rpc(db, 'select admin_import_employees($1::jsonb, $2) as r', [JSON.stringify(rows), mode]));
    await assert.rejects(imp([{ emp_code: '1', first_name: 'a', department: 'X' }, { emp_code: '1', first_name: 'b', department: 'X' }], 'merge'), /DUPLICATE_CODES/);
    await assert.rejects(imp([{ emp_code: '1', first_name: 'a', department: '' }], 'merge'), /BLANK_FIELDS/);
    let [{ r }] = await imp([{ emp_code: '1', first_name: 'a', department: 'X' }, { emp_code: '2', first_name: 'b', department: 'Y' }], 'merge');
    assert.equal(r.total, 2);
    [{ r }] = await imp([{ emp_code: '3', first_name: 'c', department: 'X' }], 'merge');
    assert.equal(r.total, 3);
    [{ r }] = await imp([{ emp_code: '3', first_name: 'c2', department: 'Z' }], 'replace');
    assert.equal(r.total, 1);
    assert.equal(r.deleted, 2);
  });

  test('options are locked once votes exist; reset clears everything after explicit confirm', async () => {
    const db = await freshDb();
    const e = await seedEmployees(db, { A: 3, B: 3 });
    const t = await createDeptTopic(db, ['A', 'B']);
    await vote(db, t.id, e.A[0], t.opt.B);
    await assert.rejects(asAdmin(db, () => rpc(db, 'select admin_save_topic($1::jsonb)', [JSON.stringify({
      id: t.id, options: [{ label: 'new' }] })])), /OPTIONS_LOCKED/);
    await assert.rejects(asAdmin(db, () => rpc(db, `select admin_reset_topic($1, 'yes')`, [t.id])), /CONFIRM_REQUIRED/);
    await asAdmin(db, () => rpc(db, `select admin_reset_topic($1, 'RESET')`, [t.id]));
    const [{ n }] = await rpc(db, 'select (select count(*) from ballots) + (select count(*) from voters_registry) as n');
    assert.equal(Number(n), 0);
    const [{ status }] = await rpc(db, 'select status from topics where id = $1', [t.id]);
    assert.equal(status, 'draft');
  });

  test('status transitions are enforced', async () => {
    const db = await freshDb();
    await seedEmployees(db, { A: 3, B: 3 });
    const t = await createDeptTopic(db, ['A', 'B']);
    await assert.rejects(asAdmin(db, () => rpc(db, `select admin_set_status($1, 'revealed')`, [t.id])), /BAD_TRANSITION/);
    await asAdmin(db, () => rpc(db, `select admin_set_status($1, 'closed')`, [t.id]));
    await asAdmin(db, () => rpc(db, `select admin_set_status($1, 'revealed')`, [t.id]));
    const [{ status }] = await rpc(db, 'select status from topics where id = $1', [t.id]);
    assert.equal(status, 'revealed');
  });
});

// ---------------------------------------------------------------------------
describe('keep-alive', () => {
  test('anon can ping; output has no personal data; log is not readable', async () => {
    const db = await freshDb();
    await seedEmployees(db, { A: 3 });
    const [{ r }] = await asAnon(db, () => rpc(db, `select keep_alive('cf-worker') as r`));
    assert.deepEqual(Object.keys(r).sort(), ['at', 'ok']);
    assert.equal(r.ok, true);
    assert.ok(!/ชื่อ|A-00|emp_code|first_name/.test(JSON.stringify(r)), 'no personal data');
    await assert.rejects(asAnon(db, () => rpc(db, 'select * from keep_alive_log')), /permission denied/);
    await assert.rejects(as(db, 'authenticated', STRANGER, () => rpc(db, 'select * from keep_alive_log')), /permission denied/);
    const [log] = await rpc(db, 'select source, last_ping from keep_alive_log');
    assert.equal(log.source, 'cf-worker');
  });

  test('pings more often than once a minute are ignored but still ok', async () => {
    const db = await freshDb();
    await asAnon(db, () => rpc(db, `select keep_alive('github')`));
    const [first] = await rpc(db, 'select last_ping, source from keep_alive_log');
    const [{ r }] = await asAnon(db, () => rpc(db, `select keep_alive('desktop') as r`));
    assert.equal(r.ok, true);
    const [second] = await rpc(db, 'select last_ping, source from keep_alive_log');
    assert.equal(second.source, 'github');
    assert.equal(+second.last_ping, +first.last_ping);
    // after a minute it counts again
    await rpc(db, `update keep_alive_log set last_ping = now() - interval '2 minutes'`);
    await asAnon(db, () => rpc(db, `select keep_alive('desktop')`));
    const [third] = await rpc(db, 'select source from keep_alive_log');
    assert.equal(third.source, 'desktop');
  });

  test('source is sanitised and status is admin-only', async () => {
    const db = await freshDb();
    await asAnon(db, () => rpc(db, `select keep_alive('<script>x</script> ' || repeat('a', 100))`));
    const [{ source }] = await rpc(db, 'select source from keep_alive_log');
    assert.ok(/^[A-Za-z0-9_.:-]{1,40}$/.test(source), source);
    await assert.rejects(asAnon(db, () => rpc(db, 'select get_keep_alive_status()')), /permission denied/);
    await assert.rejects(as(db, 'authenticated', STRANGER, () => rpc(db, 'select get_keep_alive_status()')), /NOT_ADMIN/);
    const [{ s }] = await asAdmin(db, () => rpc(db, 'select get_keep_alive_status() as s'));
    assert.equal(s.source, source);
    assert.ok(s.last_ping);
  });
});
