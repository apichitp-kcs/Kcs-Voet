// DEV ONLY (excluded from the build). Runs the admin UI in a normal browser
// against the REAL SQL migration inside PGlite (Postgres/WASM), with fake IPC.
// Serve the repo root and open /desktop/renderer/dev-admin.html (password: anything).
import { PGlite } from '../../node_modules/@electric-sql/pglite/dist/index.js';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const ready = (async () => {
  const db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin; create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;`);
  for (const f of ['20261119000001_kcs_vote_init.sql', '20261119000002_keep_alive.sql']) await db.exec(await (await fetch('../../supabase/migrations/' + f)).text());
  // simulate a Worker that stopped 5 days ago (so the stale banner shows)
  await db.exec("insert into keep_alive_log values (1, now() - interval '5 days', 'cf-worker')");
  await db.query('insert into admins(user_id) values ($1)', [ADMIN]);
  window.__db = db;
  return db;
})();

async function callRpc(fn, args = {}, role = 'authenticated') {
  const db = await ready;
  const meta = await db.query(`select proretset, prorettype::regtype::text as rt from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`, [fn]);
  if (!meta.rows.length) return { data: null, error: { message: `function ${fn} not found` } };
  const keys = Object.keys(args);
  const vals = keys.map((k) => { const v = args[k]; return Array.isArray(v) && v.every((x) => typeof x !== "object") ? `{${v.map((x) => JSON.stringify(String(x))).join(',')}}` : v !== null && typeof v === 'object' ? JSON.stringify(v) : v; });
  const call = `${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
  const { proretset, rt } = meta.rows[0];
  try {
    await db.exec(`set request.jwt.claim.sub = '${role === 'anon' ? '' : ADMIN}'; set role ${role};`);
    const r = proretset || rt === 'record'
      ? await db.query(`select * from ${call}`, vals)
      : await db.query(`select ${call} as r`, vals);
    return { data: proretset ? r.rows : r.rows[0].r, error: null };
  } catch (e) {
    return { data: null, error: { message: e.message } };
  } finally { await db.exec('reset role;'); }
}
window.__rpc = callRpc;

window.supabase = {
  createClient: () => ({
    auth: { signInWithPassword: async () => ({ error: null }), signOut: async () => ({}) },
    rpc: (fn, args) => callRpc(fn, args),
    channel: () => { const ch = { on: () => ch, subscribe: (cb) => { setTimeout(() => cb('CLOSED'), 10); return ch; } }; return ch; },
    removeChannel: async () => {},
  }),
};

const depts = ['ฝ่ายผลิต', 'ฝ่ายหล่อ', 'ฝ่ายแม่พิมพ์', 'ฝ่ายควบคุมคุณภาพ', 'ฝ่ายซ่อมบำรุง', 'ฝ่ายคลังสินค้า', 'ฝ่ายจัดซื้อ', 'ฝ่ายบัญชี', 'ฝ่ายบุคคล', 'ฝ่ายขาย', 'ฝ่ายไอที', 'ฝ่ายวิศวกรรม'];
const sizes = [40, 25, 15, 12, 10, 9, 8, 8, 6, 7, 5, 5];
const rows = [['รหัสพนักงาน', 'ชื่อ-นามสกุล', 'แผนก']];
let n = 1;
depts.forEach((d, i) => { for (let k = 0; k < sizes[i]; k++) { rows.push([String(10000 + n), `นาย พนักงาน${n} สกุล${k}`, d]); n++; } });
const cfg = { supabaseUrl: 'https://dev.local', anonKey: 'x', adminEmail: 'admin@kcs.local', voterUrl: 'https://kcs-vote.pages.dev' };
window.kcs = {
  cfg: { status: async () => ({ configured: true, path: '(dev harness)', ...cfg, version: 'dev' }), unlock: async () => ({ ...cfg, supabasePassword: 'x' }),
    setup: async () => true, setVoterUrl: async () => true, changePassword: async () => true, importFile: async () => false, exportFile: async () => false, reset: async () => true },
  xlsx: { open: async () => ({ file: 'employees.xlsx', sheet: 'Sheet1', rows }), template: async () => null },
  exportXlsx: async (d) => { console.log('exportXlsx', d); return null; },
  exportPdf: async (d) => { console.log('exportPdf', d); return null; },
  qr: { dataUrl: async () => 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#fff"/><rect x="1" y="1" width="3" height="3" fill="#1E2A78"/><rect x="6" y="1" width="3" height="3" fill="#1E2A78"/><rect x="1" y="6" width="3" height="3" fill="#1E2A78"/></svg>'),
    savePng: async () => null, posterPdf: async () => null, print: async () => null },
  showFile: async () => true,
  update: { status: async () => ({ state: 'ready', version: '1.2.0', current: '1.1.0' }), check: async () => true, install: async () => true, releases: async () => true, onStatus: () => {} },
  display: { open: async () => true, close: async () => true, isOpen: async () => false, fullscreen: async () => true,
    send: async (s) => { window.__displayState = s; }, onState: () => {}, onClosed: () => {} },
};
