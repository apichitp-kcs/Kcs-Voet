// KCS Vote — Electron main process (admin + display windows, config, files).
'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, net, screen, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const APP_ROOT = __dirname;
const CONFIG_NAME = 'kcs-vote.config.json';

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// ---------------------------------------------------------------------------
// Config: portable JSON file. Search order:
//   1. folder of the portable .exe (PORTABLE_EXECUTABLE_DIR)
//   2. folder of the installed .exe, if a config file is already there
//   3. %APPDATA%/KCS Vote
// The Supabase admin password inside is AES-256-GCM encrypted with a key
// derived (scrypt) from the local app password, so the file works on any PC
// but is useless without the app password.
// ---------------------------------------------------------------------------
function configPath() {
  const candidates = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) candidates.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, CONFIG_NAME));
  if (app.isPackaged) candidates.push(path.join(path.dirname(process.execPath), CONFIG_NAME));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  if (process.env.PORTABLE_EXECUTABLE_DIR) return candidates[0];
  return path.join(app.getPath('userData'), CONFIG_NAME);
}
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return null; }
}
function writeConfig(cfg) {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
const KDF = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
function derive(password, saltB64) {
  const out = crypto.scryptSync(String(password).normalize('NFC'), Buffer.from(saltB64, 'base64'), 64, KDF);
  return { verifier: out.subarray(0, 32), key: out.subarray(32) };
}
function encrypt(key, text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function decrypt(key, box) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8');
}
function buildConfig({ supabaseUrl, anonKey, adminEmail, supabasePassword, appPassword, voterUrl }) {
  const salt = crypto.randomBytes(16).toString('base64');
  const { verifier, key } = derive(appPassword, salt);
  return {
    version: 1,
    supabaseUrl: String(supabaseUrl).trim().replace(/\/+$/, ''),
    anonKey: String(anonKey).trim(),
    adminEmail: String(adminEmail).trim(),
    voterUrl: String(voterUrl || '').trim(),
    kdf: { algo: 'scrypt', ...KDF, salt },
    verifier: verifier.toString('base64'),
    secret: encrypt(key, supabasePassword),
    createdAt: new Date().toISOString(),
  };
}
const publicCfg = (c) => c && ({ supabaseUrl: c.supabaseUrl, anonKey: c.anonKey, adminEmail: c.adminEmail, voterUrl: c.voterUrl });

let failures = 0; let lockedUntil = 0;
function unlock(password) {
  const cfg = readConfig();
  if (!cfg) throw new Error('NOT_CONFIGURED');
  if (Date.now() < lockedUntil) throw new Error(`LOCKED:${Math.ceil((lockedUntil - Date.now()) / 1000)}`);
  const { verifier, key } = derive(password, cfg.kdf.salt);
  const ok = crypto.timingSafeEqual(verifier, Buffer.from(cfg.verifier, 'base64'));
  if (!ok) {
    failures += 1;
    if (failures >= 5) { lockedUntil = Date.now() + 30_000 * (failures - 4); }
    throw new Error('BAD_PASSWORD');
  }
  failures = 0;
  return { ...publicCfg(cfg), supabasePassword: decrypt(key, cfg.secret) };
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
let adminWin = null;
let displayWin = null;
let lastDisplayState = null;

const webPrefs = {
  preload: path.join(APP_ROOT, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false,
};

function createAdmin() {
  adminWin = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700, show: false,
    title: 'KCS Vote — Admin', icon: path.join(APP_ROOT, 'build', 'icon.png'),
    backgroundColor: '#f6f7fb',
    webPreferences: { ...webPrefs, backgroundThrottling: false },
  });
  adminWin.loadURL('app://kcs/renderer/admin.html');
  adminWin.once('ready-to-show', () => { adminWin.maximize(); adminWin.show(); });
  adminWin.on('closed', () => {
    adminWin = null;
    if (displayWin) displayWin.close();
  });
  lockNavigation(adminWin);
}

function openDisplay() {
  if (displayWin) { displayWin.focus(); return; }
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const target = displays.find((d) => d.id !== primary.id) || primary;
  const external = target.id !== primary.id;
  displayWin = new BrowserWindow({
    x: target.bounds.x + 40, y: target.bounds.y + 40, width: 1280, height: 720,
    title: 'KCS Vote — Display', icon: path.join(APP_ROOT, 'build', 'icon.png'),
    backgroundColor: '#0e1440', autoHideMenuBar: true,
    fullscreen: external,
    webPreferences: { ...webPrefs, backgroundThrottling: false },
  });
  displayWin.setMenuBarVisibility(false);
  displayWin.loadURL('app://kcs/renderer/display.html');
  displayWin.webContents.on('did-finish-load', () => {
    if (lastDisplayState) displayWin.webContents.send('display:state', lastDisplayState);
  });
  displayWin.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { displayWin.setFullScreen(!displayWin.isFullScreen()); e.preventDefault(); }
    if (input.type === 'keyDown' && input.key === 'Escape' && displayWin.isFullScreen()) { displayWin.setFullScreen(false); }
  });
  displayWin.on('closed', () => {
    displayWin = null;
    if (adminWin) adminWin.webContents.send('display:closed');
  });
  lockNavigation(displayWin);
}

function lockNavigation(win) {
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://kcs/')) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------------------------------------------------------------------------
// Files: Excel import/export, PDF, QR
// ---------------------------------------------------------------------------
const ExcelJS = require('exceljs');
const QRCode = require('qrcode');
const updater = require('./updater');

async function readXlsx(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets.find((w) => w.actualRowCount > 0) || wb.worksheets[0];
  if (!ws) return { sheet: '', rows: [] };
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = [];
    for (let c = 1; c <= Math.max(row.cellCount, ws.columnCount); c++) {
      const cell = row.getCell(c);
      vals.push(String(cell.text ?? '').replace(/\s+/g, ' ').trim());
    }
    if (vals.some((v) => v !== '')) rows.push(vals);
  });
  return { sheet: ws.name, file: path.basename(file), rows };
}

async function writeTemplate(file) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('employees');
  ws.columns = [
    { header: 'emp_code', key: 'c', width: 14 },
    { header: 'first_name', key: 'f', width: 20 },
    { header: 'last_name', key: 'l', width: 20 },
    { header: 'department', key: 'd', width: 24 },
  ];
  ws.addRow(['10001', 'สมชาย', 'ใจดี', 'ฝ่ายผลิต']);
  ws.addRow(['10002', 'สมหญิง', 'รักงาน', 'ฝ่ายบัญชี']);
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2A3890' } };
  await wb.xlsx.writeFile(file);
}

const BLUE = 'FF2A3890';
function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } };
  row.alignment = { vertical: 'middle' };
  row.height = 22;
}

async function writeResultsXlsx(file, d) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'KCS Vote'; wb.created = new Date();
  const logo = wb.addImage({ filename: path.join(APP_ROOT, 'renderer', 'assets', 'kcs-logo-transparent.png'), extension: 'png' });

  const ws = wb.addWorksheet(d.labels.ranking, { views: [{ showGridLines: false }] });
  ws.addImage(logo, { tl: { col: 0, row: 0 }, ext: { width: 220, height: 91 } });
  ws.getCell('C2').value = d.title; ws.getCell('C2').font = { size: 16, bold: true, color: { argb: BLUE } };
  ws.getCell('C3').value = `${d.labels.exported}: ${d.exportedAt}`;
  ws.getCell('C4').value = `${d.labels.voted}: ${d.voted} / ${d.eligible}  ·  ${d.labels.method}: ${d.method}`;
  ws.getRow(7).values = d.labels.rankCols;
  styleHeader(ws.getRow(7));
  d.scores.forEach((s) => ws.addRow([s.rank, s.person ? `${s.label} — ${s.person}` : s.label, s.department || '', Number(s.score), s.raw_votes, s.is_tie ? d.labels.tie : '']));
  ws.columns = [{ width: 8 }, { width: 36 }, { width: 22 }, { width: 16 }, { width: 14 }, { width: 10 }];
  ws.getColumn(4).numFmt = d.weighted ? '0.0000' : '0';

  const wt = wb.addWorksheet(d.labels.turnout, { views: [{ showGridLines: false }] });
  wt.getRow(1).values = d.labels.turnoutCols; styleHeader(wt.getRow(1));
  d.turnout.forEach((t) => wt.addRow([t.department, t.headcount, t.voted, t.turnout_pct == null ? '' : Number(t.turnout_pct) / 100,
    t.low_turnout ? '⚠' : '', t.excluded ? '✕' : '']));
  wt.columns = [{ width: 28 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 12 }];
  wt.getColumn(4).numFmt = '0.0%';

  const wr = wb.addWorksheet(d.labels.rules, { views: [{ showGridLines: false }] });
  wr.getColumn(1).width = 110;
  d.rulesLines.forEach((line, i) => {
    const c = wr.getCell(i + 1, 1); c.value = line; c.alignment = { wrapText: true, vertical: 'top' };
    if (i === 0) c.font = { bold: true, size: 14, color: { argb: BLUE } };
  });
  await wb.xlsx.writeFile(file);
}

async function htmlToPdf(page, data, file, opts = {}) {
  const win = new BrowserWindow({ show: false, width: 1123, height: 794, webPreferences: { ...webPrefs, preload: undefined } });
  try {
    await win.loadURL(`app://kcs/renderer/${page}`);
    await win.webContents.executeJavaScript(`window.render(${JSON.stringify(data)})`);
    const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, landscape: !!opts.landscape,
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } });
    fs.writeFileSync(file, pdf);
  } finally { win.destroy(); }
}

async function printHtml(page, data) {
  const win = new BrowserWindow({ show: false, webPreferences: { ...webPrefs, preload: undefined } });
  await win.loadURL(`app://kcs/renderer/${page}`);
  await win.webContents.executeJavaScript(`window.render(${JSON.stringify(data)})`);
  return new Promise((resolve) => win.webContents.print({ printBackground: true }, (ok, reason) => { win.destroy(); resolve({ ok, reason }); }));
}

const qrDataUrl = (url, width = 1024) => QRCode.toDataURL(url, { width, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#1E2A78', light: '#FFFFFF' } });

async function saveDialog(defaultName, filters) {
  const r = await dialog.showSaveDialog(adminWin, { defaultPath: path.join(app.getPath('documents'), defaultName), filters });
  return r.canceled ? null : r.filePath;
}
const safeName = (s) => String(s || 'KCS-Vote').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    // only our own pages may call us
    if (!event.senderFrame || !event.senderFrame.url.startsWith('app://kcs/')) throw new Error('FORBIDDEN');
    return fn(event, ...args);
  });
}

function registerIpc() {
  handle('cfg:status', () => {
    const c = readConfig();
    return { configured: !!c, path: configPath(), ...(publicCfg(c) || {}), version: app.getVersion() };
  });
  handle('cfg:setup', (_e, input) => {
    for (const k of ['supabaseUrl', 'anonKey', 'adminEmail', 'supabasePassword', 'appPassword']) {
      if (!input || !String(input[k] || '').trim()) throw new Error(`MISSING:${k}`);
    }
    if (String(input.appPassword).length < 8) throw new Error('WEAK_PASSWORD');
    writeConfig(buildConfig(input));
    return true;
  });
  handle('cfg:unlock', (_e, password) => unlock(password));
  handle('cfg:setVoterUrl', (_e, url) => {
    const c = readConfig(); if (!c) throw new Error('NOT_CONFIGURED');
    c.voterUrl = String(url || '').trim(); writeConfig(c); return true;
  });
  handle('cfg:changePassword', (_e, oldPw, newPw) => {
    if (String(newPw).length < 8) throw new Error('WEAK_PASSWORD');
    const plain = unlock(oldPw);
    const c = readConfig();
    const next = buildConfig({ ...plain, appPassword: newPw });
    writeConfig({ ...next, createdAt: c.createdAt });
    return true;
  });
  handle('cfg:importFile', async () => {
    const r = await dialog.showOpenDialog(adminWin, { filters: [{ name: 'KCS Vote config', extensions: ['json'] }], properties: ['openFile'] });
    if (r.canceled) return false;
    const c = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    if (!c || c.version !== 1 || !c.verifier || !c.secret || !c.supabaseUrl) throw new Error('BAD_CONFIG_FILE');
    writeConfig(c); return true;
  });
  handle('cfg:exportFile', async () => {
    const file = await saveDialog(CONFIG_NAME, [{ name: 'JSON', extensions: ['json'] }]);
    if (!file) return false;
    fs.copyFileSync(configPath(), file); return file;
  });
  handle('cfg:reset', () => { try { fs.unlinkSync(configPath()); } catch { /* none */ } return true; });

  handle('xlsx:open', async () => {
    const r = await dialog.showOpenDialog(adminWin, { filters: [{ name: 'Excel', extensions: ['xlsx'] }], properties: ['openFile'] });
    if (r.canceled) return null;
    return readXlsx(r.filePaths[0]);
  });
  // Saves straight into Downloads (no dialog to miss) and shows it in Explorer.
  handle('xlsx:template', async () => {
    const dir = app.getPath('downloads');
    fs.mkdirSync(dir, { recursive: true });
    let file = path.join(dir, 'kcs-employees-template.xlsx');
    for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `kcs-employees-template (${i}).xlsx`);
    await writeTemplate(file);
    shell.showItemInFolder(file);
    return file;
  });
  handle('export:xlsx', async (_e, data) => {
    const file = await saveDialog(`${safeName(data.title)}-${stamp()}.xlsx`, [{ name: 'Excel', extensions: ['xlsx'] }]);
    if (!file) return null; await writeResultsXlsx(file, data); return file;
  });
  handle('export:pdf', async (_e, data) => {
    const file = await saveDialog(`${safeName(data.title)}-${stamp()}.pdf`, [{ name: 'PDF', extensions: ['pdf'] }]);
    if (!file) return null; await htmlToPdf('report.html', data, file); return file;
  });
  handle('qr:dataUrl', (_e, url) => qrDataUrl(String(url)));
  handle('qr:savePng', async (_e, url) => {
    const file = await saveDialog('kcs-vote-qr.png', [{ name: 'PNG', extensions: ['png'] }]);
    if (!file) return null;
    await QRCode.toFile(file, String(url), { width: 2048, margin: 2, color: { dark: '#1E2A78', light: '#FFFFFF' } });
    return file;
  });
  handle('qr:posterPdf', async (_e, data) => {
    const file = await saveDialog('kcs-vote-qr-poster.pdf', [{ name: 'PDF', extensions: ['pdf'] }]);
    if (!file) return null;
    await htmlToPdf('poster.html', { ...data, qr: await qrDataUrl(data.url, 1400) }, file); return file;
  });
  handle('qr:print', async (_e, data) => printHtml('poster.html', { ...data, qr: await qrDataUrl(data.url, 1400) }));
  handle('file:show', (_e, file) => { shell.showItemInFolder(String(file)); return true; });

  handle('display:open', () => { openDisplay(); return true; });
  handle('display:close', () => { if (displayWin) displayWin.close(); return true; });
  handle('display:isOpen', () => !!displayWin);
  handle('display:fullscreen', () => { if (displayWin) displayWin.setFullScreen(!displayWin.isFullScreen()); return true; });
  handle('display:state', (_e, state) => {
    lastDisplayState = state;
    if (displayWin) displayWin.webContents.send('display:state', state);
    return true;
  });
  handle('display:qr', (_e, url) => qrDataUrl(String(url), 900));

  handle('update:status', () => updater.getStatus());
  handle('update:check', () => { updater.check(); return true; });
  handle('update:install', () => { updater.install(); return true; });
  handle('update:releases', () => { updater.openReleases(); return true; });
}

// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const { host, pathname } = new URL(req.url);
    const rel = path.normalize(decodeURIComponent(pathname)).replace(/^([\\/])+/, '');
    const allowed = rel.startsWith(`renderer${path.sep}`)
      || rel.startsWith(path.join('node_modules', 'three', 'build'))
      || rel.startsWith(path.join('node_modules', '@supabase', 'supabase-js', 'dist', 'umd'));
    if (host !== 'kcs' || !allowed || rel.includes('..')) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path.join(APP_ROOT, rel)).toString());
  });
  Menu.setApplicationMenu(null);
  registerIpc();
  createAdmin();
  updater.setup((st) => { if (adminWin) adminWin.webContents.send('update:status', st); });
  if (process.env.KCS_SMOKE_DIR) smokeTest(process.env.KCS_SMOKE_DIR);
});

// `npm run smoke`: renders the admin gate, a PDF report, an Excel export and the
// QR poster with sample data into KCS_SMOKE_DIR, then quits. No Supabase needed.
async function smokeTest(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const L = { ranking: 'อันดับ', turnout: 'อัตรามาโหวต', rules: 'กติกา', exported: 'ส่งออกเมื่อ', voted: 'โหวตแล้ว', method: 'วิธีคิดคะแนน', tie: 'เสมอ',
    rankCols: ['อันดับ', 'ตัวเลือก', 'แผนก', 'คะแนน', 'เสียงดิบ', 'เสมอ'], turnoutCols: ['แผนก', 'พนักงาน', 'มาโหวต', 'อัตรา', 'มาโหวตน้อย', 'ไม่นับ'],
    params: 'พารามิเตอร์', status: 'สถานะ', page: 'รายงานผลการโหวต' };
  const depts = ['ฝ่ายผลิต', 'ฝ่ายหล่อ', 'ฝ่ายแม่พิมพ์', 'ฝ่ายบัญชี', 'ฝ่ายบุคคล'];
  const data = {
    lang: 'th', title: 'รางวัลแผนกยอดเยี่ยม 2569', description: 'ทดสอบรายงาน', status: 'ประกาศผลแล้ว', exportedAt: new Date().toLocaleString('th-TH'),
    voted: 120, eligible: 150, weighted: true, method: 'ถ่วงน้ำหนักตามแผนก', params: [['น้ำหนักโหวตแผนกตัวเอง', '×0.5'], ['อัตรามาโหวตขั้นต่ำ', '30%']],
    scores: depts.map((d, i) => ({ rank: i === 2 ? 2 : i + 1, label: d, department: d, score: (2.4 - i * 0.45).toFixed(6), raw_votes: 40 - i * 6, is_tie: i === 1 || i === 2 })),
    turnout: depts.map((d, i) => ({ department: d, headcount: 50 - i * 8, voted: 40 - i * 9, turnout_pct: ((40 - i * 9) / (50 - i * 8) * 100).toFixed(2), low_turnout: i === 4, excluded: i === 4 })),
    rulesTitle: 'วิธีคิดคะแนน', rules: ['ทุกแผนกมีน้ำหนักรวม 1 คะแนน', 'โหวตแผนกตัวเองนับ ×0.5'], rulesLines: ['วิธีคิดคะแนน', '1. ทุกแผนกมีน้ำหนักรวม 1 คะแนน'], labels: L,
  };
  try {
    await new Promise((r) => adminWin.webContents.once('did-finish-load', r));
    await new Promise((r) => setTimeout(r, 1500));
    fs.writeFileSync(path.join(dir, 'admin-gate.png'), (await adminWin.webContents.capturePage()).toPNG());
    await htmlToPdf('report.html', data, path.join(dir, 'report.pdf'));
    await writeResultsXlsx(path.join(dir, 'results.xlsx'), data);
    await htmlToPdf('poster.html', { url: 'https://kcs-vote.pages.dev', title: data.title, head: 'สแกนเพื่อโหวต', sub: 'Scan to vote', qr: await qrDataUrl('https://kcs-vote.pages.dev', 1400) }, path.join(dir, 'poster.pdf'));
    await writeTemplate(path.join(dir, 'template.xlsx'));
    const back = await readXlsx(path.join(dir, 'template.xlsx'));
    fs.writeFileSync(path.join(dir, 'template-read.json'), JSON.stringify(back, null, 2));
    const { autoUpdater } = require('electron-updater');
    console.log('updater module', typeof autoUpdater.checkForUpdates === 'function' ? 'ok' : 'MISSING', updater.getStatus().current);
    console.log('SMOKE OK', dir);
  } catch (e) { console.error('SMOKE FAIL', e); process.exitCode = 1; }
  app.quit();
}

// The smoke test uses its own profile so it can run while the real app is open.
if (process.env.KCS_SMOKE_DIR) app.setPath('userData', path.join(app.getPath('temp'), 'kcs-vote-smoke'));
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (adminWin) { if (adminWin.isMinimized()) adminWin.restore(); adminWin.focus(); } });
app.on('window-all-closed', () => app.quit());
