// Writes voter/config.js from environment variables or the root .env file.
// Used locally (`npm run voter:config`) and as the Cloudflare Pages build command.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const envFile = new URL('../.env', import.meta.url);
const fileVars = {};
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) fileVars[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const get = (k) => process.env[k] || fileVars[k] || '';
const url = get('SUPABASE_URL').replace(/\/+$/, '');
const key = get('SUPABASE_ANON_KEY');
if (!/^https:\/\/.+/.test(url) || !key) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY are required (env vars or .env).');
  process.exit(1);
}
// The anon / publishable key is public by design: RLS + RPC checks protect the data.
writeFileSync(new URL('../voter/config.js', import.meta.url),
  `window.KCS_CONFIG = ${JSON.stringify({ SUPABASE_URL: url, SUPABASE_ANON_KEY: key }, null, 2)};\n`);
console.log('voter/config.js written for', url);
