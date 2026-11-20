// node keepalive-worker/test.mjs — checks the Worker with a fake fetch
import worker from './src/index.js';
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn) => realSetTimeout(fn, 0); // skip the 5 s retry wait
async function run(responses, env) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const r = responses.shift();
    if (r === 'throw') throw new Error('network down');
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  await worker.scheduled({ scheduledTime: Date.now() }, env);
  return calls;
}
const env = { SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_ANON_KEY: 'eyJabc' };
let c = await run([{ status: 200, body: { ok: true, at: 'now' } }], env);
console.assert(c.length === 1 && c[0].url === 'https://x.supabase.co/rest/v1/rpc/keep_alive' && c[0].headers.Authorization === 'Bearer eyJabc' && c[0].body === '{"source":"cf-worker"}', 'success');
c = await run(['throw', { status: 200, body: { ok: true } }], env);
console.assert(c.length === 2, 'retry once');
c = await run([{ status: 500, body: {} }, { status: 401, body: { message: 'x' } }, { status: 200, body: {} }], { ...env, ALERT_WEBHOOK: 'https://hook' });
console.assert(c.length === 3 && c[2].url === 'https://hook', 'alert after two failures');
c = await run([{ status: 200, body: { ok: true } }], { ...env, SUPABASE_ANON_KEY: 'sb_publishable_x' });
console.assert(!c[0].headers.Authorization && c[0].headers.apikey === 'sb_publishable_x', 'publishable key');
console.log('worker tests done');
