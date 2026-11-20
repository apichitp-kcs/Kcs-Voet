// KCS Vote keep-alive Worker (Cron Trigger only, no fetch handler = no public URL).
// Calls the keep_alive() RPC with the public anon key so the Supabase database
// sees real activity and the free project is never paused.

async function ping(env) {
  const url = `${String(env.SUPABASE_URL).replace(/\/+$/, '')}/rest/v1/rpc/keep_alive`;
  const key = env.SUPABASE_ANON_KEY;
  const headers = { 'Content-Type': 'application/json', apikey: key };
  // Legacy anon keys are JWTs and go in Authorization too; new sb_publishable_
  // keys are not JWTs and must only be sent as `apikey`.
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ source: 'cf-worker' }) });
  const body = await res.json().catch(() => null);
  if (res.status !== 200 || !body || body.ok !== true) {
    throw new Error(`HTTP ${res.status} ${JSON.stringify(body)?.slice(0, 200)}`);
  }
  return body;
}

export default {
  async scheduled(event, env) {
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
      console.error('keep-alive: SUPABASE_URL / SUPABASE_ANON_KEY secrets are missing');
      return;
    }
    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await ping(env);
        console.log(`keep-alive ok (attempt ${attempt}) at ${r.at}`);
        return;
      } catch (e) {
        lastErr = e;
        console.warn(`keep-alive attempt ${attempt} failed: ${e.message}`);
        if (attempt === 1) await new Promise((r) => setTimeout(r, 5000));
      }
    }
    console.error(`keep-alive FAILED: ${lastErr.message}`);
    if (env.ALERT_WEBHOOK) {
      // Works with Slack / Discord / Google Chat style incoming webhooks.
      const text = `⚠️ KCS Vote keep-alive failed twice (${new Date(event.scheduledTime).toISOString()}): ${lastErr.message}`;
      await fetch(env.ALERT_WEBHOOK, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, content: text }),
      }).catch((e) => console.error('alert webhook failed', e.message));
    }
  },
};
