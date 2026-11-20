// Auto-update from GitHub Releases (repo set in package.json -> build.publish).
// * Installed (NSIS) app: electron-updater downloads new versions in the
//   background and installs them when the app is closed (never mid-event),
//   or immediately if the admin clicks "Restart & update". Both are SILENT:
//   no installer wizard; the new version replaces the old one in the same
//   folder and the app reopens by itself.
// * Downloaded installers are deleted at start-up so they do not pile up.
// * Portable exe cannot replace itself: it only checks the latest release and
//   shows a "new version available" link.
'use strict';
const { app, net, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// electron-updater keeps downloaded installers in %LOCALAPPDATA%/<name>-updater.
// At start-up nothing is being downloaded yet, so whatever is there is left
// over from an update that is already installed: remove it to free ~130 MB.
function cleanDownloads() {
  try {
    const base = process.env.LOCALAPPDATA;
    if (!base) return;
    const dir = path.join(base, `${require('./package.json').name}-updater`);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* in use or no permission: try again next start */ }
}

// Keep in sync with package.json -> build.publish (electron-builder strips the
// build section from the packaged package.json, so it cannot be read at runtime).
const pub = { owner: 'apichitp-kcs', repo: 'Kcs-Voet' };
const RELEASES_URL = `https://github.com/${pub.owner}/${pub.repo}/releases/latest`;
const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;

let status = { state: 'idle', current: app.getVersion(), portable: isPortable };
let notify = () => {};
const set = (s) => { status = { ...status, ...s, current: app.getVersion(), portable: isPortable }; notify(status); };

const newer = (a, b) => {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

async function checkPortable() {
  try {
    set({ state: 'checking' });
    const res = await net.fetch(`https://api.github.com/repos/${pub.owner}/${pub.repo}/releases/latest`,
      { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kcs-vote-desktop' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rel = await res.json();
    if (newer(rel.tag_name, app.getVersion())) set({ state: 'portable-new', version: String(rel.tag_name).replace(/^v/, '') });
    else set({ state: 'latest' });
  } catch (e) { set({ state: 'error', message: short(e) }); }
}

// Short, readable reason instead of electron-updater's multi-line dump.
function short(e) {
  const m = String((e && e.message) || e || '');
  if (/latest\.yml|404/i.test(m)) return 'NOT_READY';          // release still being built/uploaded
  if (/ENOTFOUND|ETIMEDOUT|ECONNRE|net::ERR|EAI_AGAIN|offline/i.test(m)) return 'OFFLINE';
  return m.split('\n')[0].slice(0, 120);
}

let autoUpdater = null;
function check() {
  if (!app.isPackaged) return set({ state: 'dev' });
  if (isPortable) return checkPortable();
  return autoUpdater.checkForUpdates().catch((e) => set({ state: 'error', message: short(e) }));
}

function setup(onStatus) {
  notify = onStatus;
  if (!app.isPackaged || process.env.KCS_SMOKE_DIR) { set({ state: 'dev' }); return; }
  if (!isPortable) {
    cleanDownloads();
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;   // silent when the app is closed
    autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
    autoUpdater.on('update-not-available', () => set({ state: 'latest' }));
    autoUpdater.on('update-available', (i) => set({ state: 'downloading', version: i.version, percent: 0 }));
    autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (i) => set({ state: 'ready', version: i.version }));
    autoUpdater.on('error', (e) => set({ state: 'error', message: short(e) }));
  }
  setTimeout(check, 5000);
  setInterval(check, 2 * 3600e3);
}

module.exports = {
  setup,
  check,
  getStatus: () => status,
  // isSilent = true (no wizard), isForceRunAfter = true (reopen the app)
  install: () => {
    if (!autoUpdater || status.state !== 'ready') return;
    set({ state: 'installing' });
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 600);
  },
  openReleases: () => shell.openExternal(RELEASES_URL),
};
