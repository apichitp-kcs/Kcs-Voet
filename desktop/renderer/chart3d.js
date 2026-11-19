// Animated 3D bar chart (Three.js). Used by the admin live screen and the
// display "ranking" page.  new Bars3D(el, { theme: 'light' | 'dark' })
import * as THREE from '../node_modules/three/build/three.module.js';

export const FONT = 'Prompt, "Leelawadee UI", Tahoma, sans-serif';
const PODIUM = [0xE8B931, 0xC3CAD8, 0xCD8540];

/** Text -> canvas texture (Thai-safe, wraps to max 2 lines). */
export function textTexture(lines, { w = 1024, h = 256, size = 72, weight = 600, color = '#fff', bg = null, align = 'center' } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (bg) { g.fillStyle = bg; roundRect(g, 0, 0, w, h, h * 0.18); g.fill(); }
  g.fillStyle = color; g.textAlign = align; g.textBaseline = 'middle';
  const arr = Array.isArray(lines) ? lines : [lines];
  let fs = size;
  const fit = () => {
    g.font = `${weight} ${fs}px ${FONT}`;
    return arr.every((l, i) => g.measureText(l.text ?? l).width <= w * 0.92 / (l.scale && i ? 1 : 1));
  };
  while (fs > 18 && !fit()) fs -= 2;
  const lh = fs * 1.25;
  const total = arr.reduce((a, l) => a + lh * (l.scale || 1), 0);
  let y = h / 2 - total / 2;
  for (const l of arr) {
    const s = l.scale || 1;
    g.font = `${l.weight || weight} ${fs * s}px ${FONT}`;
    g.fillStyle = l.color || color;
    y += (lh * s) / 2;
    g.fillText(l.text ?? l, align === 'center' ? w / 2 : w * 0.04, y);
    y += (lh * s) / 2;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
/** Wrap a label into at most 2 lines of ~maxChars (Thai has no spaces: split by length). */
export function wrap2(text, maxChars = 14) {
  const s = String(text || '');
  if (s.length <= maxChars) return [s];
  const sp = s.lastIndexOf(' ', maxChars + 2);
  const cut = sp > 3 ? sp : maxChars;
  const rest = s.slice(cut).trim();
  return [s.slice(0, cut).trim(), rest.length > maxChars + 2 ? rest.slice(0, maxChars) + '…' : rest];
}

export class Bars3D {
  constructor(el, { theme = 'light', podiumColors = false, unit = '' } = {}) {
    this.el = el; this.theme = theme; this.podiumColors = podiumColors; this.unit = unit;
    this.bars = new Map(); this.maxH = 6; this.spacing = 1.7; this.t0 = performance.now();
    const dark = theme === 'dark';
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);
    this.scene.add(new THREE.HemisphereLight(0xffffff, dark ? 0x1a2160 : 0xdfe3f5, dark ? 1.1 : 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, dark ? 2.2 : 2.0);
    sun.position.set(-6, 14, 10); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -4, near: 1, far: 40 });
    this.scene.add(sun);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 40),
      new THREE.MeshStandardMaterial({ color: dark ? 0x141b52 : 0xf3f5fc, roughness: 0.9 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
    this.scene.add(floor);
    const grid = new THREE.GridHelper(80, 80, dark ? 0x2a3890 : 0xd5daf0, dark ? 0x1d2670 : 0xe6e9f6);
    grid.position.y = 0.002; this.scene.add(grid);
    this.group = new THREE.Group(); this.scene.add(this.group);

    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(el);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  resize() {
    const w = this.el.clientWidth || 600, h = this.el.clientHeight || 400;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%'; this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.frameCamera();
  }

  frameCamera() {
    const n = Math.max(this.bars.size, 3);
    const width = n * this.spacing + 3.2;
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const distW = (width / 2) / Math.tan(hfov / 2);
    const distH = ((this.maxH + 4.6) / 2) / Math.tan(vfov / 2);
    this.dist = Math.max(distW, distH) * 1.08;
    this.target = new THREE.Vector3(0, this.maxH * 0.3, 0);
  }

  /** items: [{ id, label, value, sub?, tie? }] in display order */
  setData(items, { maxValue } = {}) {
    const max = Math.max(maxValue || 0, ...items.map((i) => Number(i.value) || 0), 1e-9);
    const keep = new Set(items.map((i) => i.id));
    for (const [id, b] of this.bars) if (!keep.has(id)) { this.group.remove(b.root); this.bars.delete(id); }
    const n = items.length;
    items.forEach((it, i) => {
      let b = this.bars.get(it.id);
      if (!b) { b = this.makeBar(); this.bars.set(it.id, b); this.group.add(b.root); b.h = 0.001; }
      b.targetX = (i - (n - 1) / 2) * this.spacing;
      if (b.x === undefined) b.x = b.targetX;
      b.targetH = Math.max(0.02, (Number(it.value) || 0) / max * this.maxH);
      const color = this.podiumColors && i < 3 && Number(it.value) > 0 ? PODIUM[i] : (i === 0 && Number(it.value) > 0 ? 0x4357d6 : 0x2A3890);
      b.mat.color.setHex(color);
      const valueText = fmtValue(it.value) + (it.tie ? ' =' : '');
      if (b.valueText !== valueText) {
        b.valueText = valueText; b.value.material.map?.dispose();
        b.value.material.map = textTexture(valueText, { w: 512, h: 160, size: 96, color: this.theme === 'dark' ? '#fff' : '#1b1f33' });
        b.value.material.needsUpdate = true;
      }
      const labelKey = it.label + '|' + (it.sub || '');
      if (b.labelKey !== labelKey) {
        b.labelKey = labelKey; b.label.material.map?.dispose();
        const lines = wrap2(it.label, 10).map((t) => ({ text: t }));
        if (it.sub) lines.push({ text: it.sub, scale: 0.7, weight: 400, color: this.theme === 'dark' ? '#b9c2ff' : '#5d6480' });
        b.label.material.map = textTexture(lines, { w: 512, h: 256, size: 96, color: this.theme === 'dark' ? '#ffffff' : '#1b1f33' });
        b.label.material.needsUpdate = true;
      }
    });
    this.frameCamera();
  }

  makeBar() {
    const root = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x2A3890, roughness: 0.35, metalness: 0.25 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.05, 1, 1.05), mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    root.add(mesh);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.06, 1.1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2, metalness: 0.6, transparent: true, opacity: 0.55 }));
    root.add(cap);
    const value = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
    value.scale.set(1.6, 0.5, 1); root.add(value);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
    label.scale.set(1.7, 0.85, 1); label.position.set(0, 0.42, 3.4); root.add(label);
    return { root, mesh, cap, mat, value, label };
  }

  frame() {
    const t = (performance.now() - this.t0) / 1000;
    for (const b of this.bars.values()) {
      b.h += (b.targetH - b.h) * 0.07;
      b.x += (b.targetX - b.x) * 0.08;
      b.root.position.x = b.x;
      b.mesh.scale.y = b.h; b.mesh.position.y = b.h / 2;
      b.cap.position.y = b.h + 0.03;
      b.value.position.y = b.h + 0.45;
    }
    const a = Math.sin(t * 0.18) * 0.16;
    const elev = 0.30;
    this.camera.position.set(Math.sin(a) * this.dist, this.target.y + Math.sin(elev) * this.dist, Math.cos(a) * this.dist * Math.cos(elev));
    this.camera.lookAt(this.target);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.renderer.setAnimationLoop(null); this.ro.disconnect();
    this.renderer.dispose(); this.renderer.domElement.remove();
  }
}

export function fmtValue(v) {
  const n = Number(v) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(n >= 10 ? 1 : 3);
}
