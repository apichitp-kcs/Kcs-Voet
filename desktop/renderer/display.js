// KCS Vote — projector display. Pure presentation: all data arrives from the
// admin window over IPC (results only after the topic is "revealed").
import * as THREE from '../node_modules/three/build/three.module.js';
import { STR } from './i18n.js';
import { rulesText } from './rules.js';
import { Bars3D, textTexture, fmtValue, wrap2 } from './chart3d.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const layer = $('#layer');
let S = null; let modeKey = ''; let pending = null; let ready = false;
const t = (k, ...a) => { const v = STR[S?.lang || 'th'][k]; return typeof v === 'function' ? v(...a) : v; };
const title = () => (S.topic && ((S.lang === 'en' && S.topic.title_en) || S.topic.title)) || 'KCS Vote';
const lbl = (r) => (S.lang === 'en' && r.label_en) || r.label;
const who = (r) => [r.person_name, r.person_title].filter(Boolean).join(' · ');

// Register before any await so the first state from main is never missed.
window.kcs.display.onState((s) => { if (!ready) { pending = s; return; } applyState(s); });

// ------------------------------------------------------------------ renderer
const canvas = $('#stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
let current = null;
const clock = new THREE.Clock();
function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  if (current) { current.camera.aspect = window.innerWidth / window.innerHeight; current.camera.updateProjectionMatrix(); }
}
window.addEventListener('resize', resize);
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!current) return;
  current.update(dt, clock.elapsedTime);
  renderer.render(current.scene, current.camera);
});
function setScene(sc) { if (current && current !== sc) current.dispose(); current = sc; resize(); }

function gradientBg(inner = '#2A3890', outer = '#070b2a') {
  const c = document.createElement('canvas'); c.width = 64; c.height = 512;
  const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 0, 512);
  gr.addColorStop(0, outer); gr.addColorStop(0.55, inner); gr.addColorStop(1, outer);
  g.fillStyle = gr; g.fillRect(0, 0, 64, 512);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; return tex;
}
function dotTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.3, 'rgba(190,205,255,.6)'); gr.addColorStop(1, 'rgba(120,140,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c);
}
const DOT = dotTexture();
function disposeScene(scene) {
  scene.traverse((o) => {
    o.geometry?.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    mats.forEach((m) => { if (m.map && m.map !== DOT) m.map.dispose(); m.dispose(); });
  });
  if (scene.background?.dispose) scene.background.dispose();
}

// ------------------------------------------------------------------ ambient scene
function ambientScene() {
  const scene = new THREE.Scene();
  scene.background = gradientBg('#26338a', '#080c30');
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
  camera.position.set(0, 0, 30);
  const N = 1400; const pos = new Float32Array(N * 3); const speed = new Float32Array(N);
  for (let i = 0; i < N; i++) { pos[i * 3] = (Math.random() - 0.5) * 90; pos[i * 3 + 1] = (Math.random() - 0.5) * 60; pos[i * 3 + 2] = (Math.random() - 0.5) * 50; speed[i] = 0.3 + Math.random(); }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.55, map: DOT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.8 }));
  scene.add(pts);
  const rings = [];
  for (let i = 0; i < 3; i++) {
    const r = new THREE.Mesh(new THREE.TorusGeometry(10 + i * 5, 0.06, 8, 160),
      new THREE.MeshBasicMaterial({ color: i === 1 ? 0xf2c94c : 0x7d8cff, transparent: true, opacity: 0.18 - i * 0.03 }));
    r.rotation.x = 1.1 + i * 0.25; r.position.set(14, -4, -10); scene.add(r); rings.push(r);
  }
  return {
    scene, camera,
    update(dt, tm) {
      const p = geo.attributes.position.array;
      for (let i = 0; i < N; i++) { p[i * 3 + 1] += speed[i] * dt * 0.6; if (p[i * 3 + 1] > 30) p[i * 3 + 1] = -30; }
      geo.attributes.position.needsUpdate = true;
      pts.rotation.y = Math.sin(tm * 0.05) * 0.15;
      rings.forEach((r, i) => { r.rotation.z += dt * (0.05 + i * 0.03) * (i % 2 ? -1 : 1); });
    },
    dispose() { disposeScene(scene); },
  };
}

// ------------------------------------------------------------------ reveal scene
const ease = { outBack: (k) => 1 + 2.70158 * (k - 1) ** 3 + 1.70158 * (k - 1) ** 2, outCubic: (k) => 1 - (1 - k) ** 3, inOut: (k) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2) };
const MEDAL = [0xf2c94c, 0xcfd6e4, 0xd39a62, 0x6f7fe8, 0x6f7fe8];
const MEDAL_CSS = ['#f2c94c', '#cfd6e4', '#d39a62', '#9aa6ff', '#9aa6ff'];
// place index -> x, height, width
const SLOTS = [{ x: 0, h: 3.1, w: 2.8 }, { x: -3.1, h: 2.2, w: 2.6 }, { x: 3.1, h: 1.6, w: 2.6 }, { x: -6.9, h: 1.3, w: 2.2 }, { x: 6.9, h: 1.0, w: 2.2 }];

class RevealScene {
  constructor(results) {
    this.results = results; this.anims = []; this.time = 0;
    const scene = this.scene = new THREE.Scene();
    scene.background = gradientBg('#1b2470', '#04061c');
    scene.fog = new THREE.Fog(0x070a2a, 22, 60);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    this.camPos = new THREE.Vector3(0, 7.5, 24); this.camTarget = new THREE.Vector3(0, 2, 0);
    this.camPosGoal = this.camPos.clone(); this.camTargetGoal = this.camTarget.clone();

    this.ambient = new THREE.AmbientLight(0x8090ff, 0.35); scene.add(this.ambient);
    this.hemi = new THREE.HemisphereLight(0xbfc8ff, 0x0a0f3a, 0.55); scene.add(this.hemi);
    const key = new THREE.DirectionalLight(0xffffff, 0.9); key.position.set(-8, 16, 12); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048); Object.assign(key.shadow.camera, { left: -14, right: 14, top: 12, bottom: -6 });
    scene.add(key); this.key = key;

    const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 96), new THREE.MeshStandardMaterial({ color: 0x0d1348, metalness: 0.55, roughness: 0.35 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
    const stage = new THREE.Mesh(new THREE.CylinderGeometry(9.6, 10, 0.25, 96), new THREE.MeshStandardMaterial({ color: 0x18217a, metalness: 0.4, roughness: 0.4 }));
    stage.position.y = 0.125; stage.receiveShadow = true; scene.add(stage);
    const edge = new THREE.Mesh(new THREE.TorusGeometry(9.8, 0.05, 8, 160), new THREE.MeshBasicMaterial({ color: 0x8fa0ff }));
    edge.rotation.x = -Math.PI / 2; edge.position.y = 0.26; scene.add(edge); this.edge = edge;

    // floating sparkles
    const N = 700; const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { pos[i * 3] = (Math.random() - 0.5) * 60; pos[i * 3 + 1] = Math.random() * 25; pos[i * 3 + 2] = -Math.random() * 30 - 4; }
    this.spark = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pos, 3)),
      new THREE.PointsMaterial({ size: 0.35, map: DOT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.7 }));
    scene.add(this.spark);

    // sweeping search lights (fake volumetric cones)
    this.beams = [];
    for (let i = 0; i < 4; i++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(2.6, 26, 32, 1, true),
        new THREE.MeshBasicMaterial({ color: i % 2 ? 0x8fa0ff : 0xffffff, transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      cone.geometry.translate(0, -13, 0);
      const pivot = new THREE.Group(); pivot.position.set(-12 + i * 8, 22, -6); pivot.add(cone);
      scene.add(pivot); this.beams.push({ pivot, cone, phase: i * 1.7 });
    }

    // podium slots
    this.slots = results.slice(0, 5).map((r, p) => this.makeSlot(r, p));

    // winner spotlight
    this.spot = new THREE.SpotLight(0xfff2cc, 0, 40, 0.32, 0.6, 1.2);
    this.spot.position.set(0, 16, 6); this.spot.castShadow = true; this.spot.shadow.mapSize.set(1024, 1024);
    scene.add(this.spot); scene.add(this.spot.target);

    this.confetti = new Confetti(scene);
  }

  makeSlot(r, p) {
    const s = SLOTS[p];
    const group = new THREE.Group(); group.position.x = s.x; this.scene.add(group);
    const rankNo = r.rank;
    const numTex = textTexture([{ text: String(rankNo) }], { w: 512, h: 512, size: 360, weight: 700, color: MEDAL_CSS[p] });
    const side = new THREE.MeshStandardMaterial({ color: 0x2A3890, roughness: 0.3, metalness: 0.35 });
    const top = new THREE.MeshStandardMaterial({ color: MEDAL[p], roughness: 0.25, metalness: p < 3 ? 0.85 : 0.3, emissive: MEDAL[p], emissiveIntensity: 0.08 });
    const block = new THREE.Mesh(new THREE.BoxGeometry(s.w, s.h, 2.4), [side, side, top, side, new THREE.MeshStandardMaterial({ color: 0x2A3890, roughness: 0.3, metalness: 0.35 }), side]);
    block.geometry.translate(0, s.h / 2, 0);
    block.castShadow = true; block.receiveShadow = true; block.scale.y = 0.0001; group.add(block);
    const num = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(s.w, s.h) * 0.85, Math.min(s.w, s.h) * 0.85), new THREE.MeshBasicMaterial({ map: numTex, transparent: true }));
    num.position.set(0, s.h / 2, 1.205); num.scale.setScalar(0.0001); group.add(num);
    const lines = wrap2(lbl(r), 16).map((x) => ({ text: x }));
    if (r.person_name) lines.push({ text: r.person_name, scale: 0.62, weight: 500, color: '#dfe5ff' });
    lines.push({ text: scoreText(r), scale: 0.62, weight: 500, color: MEDAL_CSS[p] });
    const lh = r.person_name ? 520 : 420;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: textTexture(lines, { w: 1024, h: lh, size: 120, weight: 700, color: '#ffffff', bg: 'rgba(10,16,60,0.78)' }), transparent: true, depthWrite: false }));
    const lw = p === 0 ? 4.6 : 3.6;
    label.scale.set(0.0001, 0.0001, 1); label.position.set(0, s.h + 1.35 + (p === 0 ? 0.3 : 0), 0.4);
    group.add(label);
    const light = new THREE.PointLight(MEDAL[p], 0, 9, 1.6); light.position.set(0, s.h + 2.2, 2.4); group.add(light);
    return { r, p, s, group, block, num, label, lw, la: lh / 1024, light, risen: false };
  }

  anim(dur, fn, delay = 0) {
    return new Promise((done) => this.anims.push({ t0: this.time + delay, dur, fn, done }));
  }
  rise(slot) {
    slot.risen = true;
    return this.anim(1.3, (k) => { slot.block.scale.y = Math.max(0.0001, ease.outBack(k)); slot.num.scale.setScalar(Math.max(0.0001, ease.outCubic(Math.max(0, k * 1.6 - 0.6)))); });
  }
  showLabel(slot) {
    slot.light.intensity = 0;
    this.anim(1.2, (k) => { slot.light.intensity = k * (slot.p === 0 ? 30 : 14); });
    return this.anim(0.8, (k) => { const e = ease.outBack(k); slot.label.scale.set(slot.lw * e, slot.lw * slot.la * e, 1); });
  }
  focus(x, y, dist, height) {
    this.camTargetGoal.set(x * 0.6, y, 0);
    this.camPosGoal.set(x * 0.45, height, dist);
  }

  update(dt) {
    this.time += dt;
    for (const a of [...this.anims]) {
      const k = Math.min(1, Math.max(0, (this.time - a.t0) / a.dur));
      if (this.time >= a.t0) a.fn(k);
      if (k >= 1) { this.anims.splice(this.anims.indexOf(a), 1); a.done(); }
    }
    this.camPos.lerp(this.camPosGoal, 1 - Math.exp(-dt * 1.4));
    this.camTarget.lerp(this.camTargetGoal, 1 - Math.exp(-dt * 1.6));
    const sway = Math.sin(this.time * 0.25) * 0.6;
    this.camera.position.set(this.camPos.x + sway, this.camPos.y, this.camPos.z);
    this.camera.lookAt(this.camTarget);
    this.beams.forEach((b) => { b.pivot.rotation.z = Math.sin(this.time * 0.45 + b.phase) * 0.55; b.pivot.rotation.x = Math.cos(this.time * 0.3 + b.phase) * 0.25; });
    this.spark.rotation.y = Math.sin(this.time * 0.04) * 0.2;
    this.edge.material.color.setHSL(0.64, 0.8, 0.65 + Math.sin(this.time * 2) * 0.1);
    this.slots.forEach((s) => { if (s.label.scale.x > 0.01) s.label.position.y = s.s.h + 1.35 + (s.p === 0 ? 0.3 : 0) + Math.sin(this.time * 1.6 + s.p) * 0.08; });
    this.confetti.update(dt, this.time);
  }
  dispose() { disposeScene(this.scene); }
}

class Confetti {
  constructor(scene) {
    this.N = 1100;
    const geo = new THREE.PlaneGeometry(0.13, 0.24);
    const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.5, metalness: 0.3 });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.N);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const colors = [0xf2c94c, 0xffffff, 0x4357d6, 0xe85d75, 0x3ccf91, 0x9aa6ff, 0xffa53c];
    const c = new THREE.Color();
    this.p = []; this.dummy = new THREE.Object3D();
    for (let i = 0; i < this.N; i++) {
      this.mesh.setColorAt(i, c.setHex(colors[i % colors.length]));
      this.p.push({ pos: new THREE.Vector3(0, -50, 0), vel: new THREE.Vector3(), rot: new THREE.Euler(), rv: new THREE.Vector3(), alive: false, rest: false });
    }
    this.mesh.frustumCulled = false; scene.add(this.mesh);
    this.rain = 0; this.next = 0;
  }
  burst(x = 0, y = 4) {
    let n = 0;
    for (const q of this.p) {
      if (q.alive && !q.rest) continue;
      q.pos.set(x + (Math.random() - 0.5) * 1.5, y + Math.random(), (Math.random() - 0.5) * 1.5);
      const a = Math.random() * Math.PI * 2; const sp = 5 + Math.random() * 9;
      q.vel.set(Math.cos(a) * sp * 0.7, 9 + Math.random() * 9, Math.sin(a) * sp * 0.5);
      q.rv.set(Math.random() * 8, Math.random() * 8, Math.random() * 8); q.alive = true; q.rest = false;
      if (++n > 520) break;
    }
    this.rain = 7;
  }
  update(dt, tm) {
    if (this.rain > 0) {
      this.rain -= dt; this.next -= dt;
      while (this.next < 0) {
        this.next += 0.012;
        const q = this.p.find((z) => !z.alive);
        if (!q) break;
        q.pos.set((Math.random() - 0.5) * 26, 16 + Math.random() * 3, (Math.random() - 0.5) * 10 - 1);
        q.vel.set((Math.random() - 0.5) * 2, -2 - Math.random() * 2, 0); q.rv.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
        q.alive = true; q.rest = false;
      }
    }
    const d = this.dummy;
    this.p.forEach((q, i) => {
      if (q.alive && !q.rest) {
        q.vel.y -= 9.8 * dt * 0.55;
        q.vel.multiplyScalar(1 - dt * 1.1);
        q.vel.x += Math.sin(tm * 3 + i) * dt * 1.2;
        q.pos.addScaledVector(q.vel, dt);
        q.rot.x += q.rv.x * dt; q.rot.y += q.rv.y * dt; q.rot.z += q.rv.z * dt;
        if (q.pos.y < 0.27 && Math.hypot(q.pos.x, q.pos.z) < 10) { q.pos.y = 0.27; q.rest = true; q.rot.x = -Math.PI / 2; }
        else if (q.pos.y < 0.01) { q.pos.y = 0.01; q.rest = true; q.rot.x = -Math.PI / 2; }
      }
      d.position.copy(q.pos); d.rotation.copy(q.rot); d.scale.setScalar(q.alive ? 1 : 0.0001);
      d.updateMatrix(); this.mesh.setMatrixAt(i, d.matrix);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

function scoreText(r) {
  return S.weighted ? `${fmtValue(r.score)} ${t('points')}` : `${r.raw} ${t('votesUnit')}`;
}

// skippable waits (Space / → / click advance)
let skip = null;
const wait = (ms) => new Promise((ok) => { const id = setTimeout(() => { skip = null; ok(); }, ms); skip = () => { clearTimeout(id); skip = null; ok(); }; });
window.addEventListener('keydown', (e) => { if ([' ', 'ArrowRight', 'Enter', 'PageDown'].includes(e.key) && skip) { e.preventDefault(); skip(); } });
window.addEventListener('click', () => skip && skip());

let runId = 0;
async function runReveal() {
  const my = ++runId;
  const alive = () => my === runId && current instanceof RevealScene;
  const res = [...(S.results || [])].sort((a, b) => a.position - b.position);
  if (!res.length) { enterIdle(); return; }
  const sc = new RevealScene(res);
  setScene(sc);
  layer.innerHTML = `<div class="reveal-title" id="rt"><h1>${esc(t('announcing'))}</h1><p>${esc(title())}</p></div><div id="cap"></div>`;
  const cap = (r, p) => {
    const cls = ['gold', 'silver', 'bronze'][p] || '';
    $('#cap').innerHTML = `<div class="caption ${cls}"><div class="rk">${esc(p === 0 ? `🏆 ${t('winner')}` : t('place', r.rank))}${r.tie ? `<span class="tie">${esc(STR[S.lang].tie)}</span>` : ''}</div>
      <div class="nm">${esc(lbl(r))}</div>${who(r) ? `<div class="pp">👤 ${esc(who(r))}</div>` : ''}<div class="sc">${esc(scoreText(r))}</div></div>`;
  };
  await wait(3000); if (!alive()) return;
  $('#rt').classList.add('small');
  const n = Math.min(res.length, 5);
  // ranks 5 -> 4 one by one
  for (const p of [4, 3]) {
    if (p >= n) continue;
    const slot = sc.slots[p];
    sc.focus(slot.s.x, 0.9, 15, 5.5);
    await wait(700); if (!alive()) return;
    await sc.rise(slot); if (!alive()) return;
    sc.showLabel(slot); cap(slot.r, p);
    await wait(3600); if (!alive()) return;
    $('#cap').innerHTML = '';
  }
  // podium build
  sc.focus(0, 1.3, 19, 7.5);
  await wait(600); if (!alive()) return;
  await Promise.all(sc.slots.slice(0, Math.min(3, n)).map((s, i) => sc.anim(0.01, () => {}, i * 0.25).then(() => sc.rise(s))));
  await wait(1400); if (!alive()) return;
  for (const p of [2, 1]) {
    if (p >= n) continue;
    const slot = sc.slots[p];
    sc.focus(slot.s.x, slot.s.h - 0.2, 13.5, 5.8);
    await wait(900); if (!alive()) return;
    sc.showLabel(slot); cap(slot.r, p);
    await wait(3800); if (!alive()) return;
    $('#cap').innerHTML = '';
  }
  // drum roll for the winner
  const win = sc.slots[0];
  sc.focus(0, 2.4, 15, 6.5);
  const amb = sc.ambient.intensity; const hemi = sc.hemi.intensity;
  await sc.anim(1.0, (k) => { sc.ambient.intensity = amb * (1 - 0.7 * k); sc.hemi.intensity = hemi * (1 - 0.7 * k); sc.key.intensity = 0.9 * (1 - 0.6 * k); });
  sc.beams.forEach((b) => { b.cone.material.opacity = 0.11; });
  await wait(2200); if (!alive()) return;
  sc.spot.target.position.set(0, win.s.h, 0); sc.spot.position.set(0, 16, 5);
  sc.anim(0.5, (k) => { sc.spot.intensity = 900 * k; sc.ambient.intensity = amb * (0.3 + 0.7 * k); sc.hemi.intensity = hemi * (0.3 + 0.7 * k); sc.key.intensity = 0.36 + 0.54 * k; });
  sc.showLabel(win); cap(win.r, 0);
  sc.confetti.burst(0, win.s.h + 0.5);
  sc.beams.forEach((b) => { b.cone.material.color.setHex(0xf2c94c); b.cone.material.opacity = 0.09; });
  sc.focus(0, 2.3, 12.5, 5.6);
  await wait(6500); if (!alive()) return;
  sc.focus(0, 1.4, 20, 8);
}

// ------------------------------------------------------------------ DOM modes
let ambient = null;
const ensureAmbient = () => { if (!(current && current.isAmbient)) { ambient = ambientScene(); ambient.isAmbient = true; setScene(ambient); } };
const brand = () => `<div class="brand"><img src="assets/kcs-logo-white.png" alt="KCS"><span>K Casting and Solution</span></div>`;
let chart = null;
const dropChart = () => { if (chart) { chart.dispose(); chart = null; } };

function enterIdle() {
  ensureAmbient(); dropChart();
  layer.innerHTML = `<div class="idle fade"><div><img src="assets/kcs-logo-white.png" alt="KCS"><h1>${esc(S.topic ? title() : 'KCS Vote')}</h1><p>${esc(t('waiting'))}</p></div></div>`;
}
function enterVoting() {
  ensureAmbient(); dropChart();
  const desc = S.topic ? ((S.lang === 'en' && S.topic.description_en) || S.topic.description || '') : '';
  layer.innerHTML = `${brand()}<div class="voting fade">
    <div><h1>${esc(title())}</h1>${desc ? `<p class="desc">${esc(desc)}</p>` : ''}
      <div class="counter"><div class="ring"><svg viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#9aa6ff"/><stop offset="1" stop-color="#f2c94c"/></linearGradient></defs>
        <circle class="bg" cx="50" cy="50" r="44"/><circle class="fg" id="ringFg" cx="50" cy="50" r="44" stroke-dasharray="276.46" stroke-dashoffset="276.46"/></svg><div class="pct" id="pct">0%</div></div>
      <div><div class="count-label">${esc(t('votedSoFar'))}</div><div class="count-big" id="cnt">0 <small>/ 0</small></div></div></div>
      <div class="soon">🔒 ${esc(t('resultsSoon'))}</div></div>
    <div class="qrcard">${S.qr ? `<img src="${S.qr}" alt="QR">` : '<div style="width:46vh;height:46vh"></div>'}<b>${esc(t('scanToVote'))}</b><span>${esc(S.voterUrl)}</span></div></div>`;
  updateVoting(true);
}
let lastVoted = -1;
function updateVoting(force) {
  const cnt = $('#cnt'); if (!cnt) return;
  const pct = S.eligible ? S.voted / S.eligible : 0;
  cnt.innerHTML = `${S.voted} <small>/ ${S.eligible}</small>`;
  $('#pct').textContent = `${Math.round(pct * 100)}%`;
  $('#ringFg').style.strokeDashoffset = String(276.46 * (1 - pct));
  if (!force && S.voted !== lastVoted) { cnt.classList.remove('bump'); void cnt.offsetWidth; cnt.classList.add('bump'); }
  lastVoted = S.voted;
}
function enterRanking() {
  ensureAmbient(); dropChart();
  const res = [...(S.results || [])].sort((a, b) => a.position - b.position);
  layer.innerHTML = `${brand()}<div class="panel-title fade">${esc(t('fullRanking'))}<small>${esc(title())}</small></div>
    <div class="chart-wrap" id="cw"></div>
    <div class="rank-list" style="--rs:${Math.min(1, 9 / Math.max(res.length, 1)).toFixed(2)}">${res.map((r, i) => `<div class="it r${r.rank}" style="animation-delay:${i * 0.08}s"><span class="no">${r.rank}</span><span>${esc(lbl(r))}${r.tie ? ` <small>(${esc(STR[S.lang].tie)})</small>` : ''}${r.person_name ? `<small class="pp">${esc(r.person_name)}</small>` : ''}</span><span class="sc">${esc(scoreText(r))}</span></div>`).join('')}</div>`;
  chart = new Bars3D($('#cw'), { theme: 'dark', podiumColors: true });
  chart.setData(res.map((r) => ({ id: r.id, label: lbl(r), value: S.weighted ? Number(r.score) : r.raw, tie: r.tie })));
}
function enterRules() {
  ensureAmbient(); dropChart();
  const alt = S.lang === 'th' ? 'en' : 'th';
  const r = rulesText(S.topic || {}, S.lang); const r2 = rulesText(S.topic || {}, alt);
  layer.innerHTML = `${brand()}<div class="panel-title fade">${esc(t('rulesTitle'))}<small>${esc(title())}</small></div>
    <div class="rules fade"><ol>${r.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ol>
    <div class="alt"><b>${esc(r2.title)}</b><ol>${r2.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ol></div></div>`;
}

function applyState(s) {
  const prev = S; S = s;
  const key = `${s.mode}|${s.mode === 'reveal' ? s.nonce : ''}|${s.lang}|${s.topic?.id || ''}`;
  if (key !== modeKey) {
    modeKey = key; runId++;
    dropChart();
    ({ idle: enterIdle, voting: enterVoting, reveal: runReveal, ranking: enterRanking, rules: enterRules }[s.mode] || enterIdle)();
  } else if (s.mode === 'voting') {
    if (prev && prev.qr !== s.qr) enterVoting(); else updateVoting(false);
  } else if (s.mode === 'ranking' && chart && JSON.stringify(prev?.results) !== JSON.stringify(s.results)) {
    enterRanking();
  }
}

// ------------------------------------------------------------------ boot
await Promise.all(['400', '500', '600', '700'].map((w) => document.fonts.load(`${w} 48px Prompt`, 'กขabc'))).catch(() => {});
S = pending || { lang: 'th', mode: 'idle', voted: 0, eligible: 0 };
ready = true;
modeKey = '';
applyState(S);
setTimeout(() => { $('#hint').style.display = 'none'; }, 8000);
