// Launches Electron with KCS_SMOKE_DIR set; outputs land in desktop/smoke-out/.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import electron from 'electron';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'smoke-out');
const r = spawnSync(electron, ['.'], { cwd: root, stdio: 'inherit', env: { ...process.env, KCS_SMOKE_DIR: out } });
process.exit(r.status ?? 1);
