// QR poster (A4) — called by main via executeJavaScript.
window.render = function render(d) {
  document.getElementById('h').textContent = d.head;
  document.getElementById('s').textContent = d.sub;
  document.getElementById('t').textContent = d.title || '';
  document.getElementById('u').textContent = d.url;
  const img = document.getElementById('qr');
  img.src = d.qr;
  return document.fonts.ready.then(() => Promise.all([...document.images].map((i) => (i.complete ? 0 : new Promise((r) => { i.onload = r; i.onerror = r; }))))).then(() => true);
};
