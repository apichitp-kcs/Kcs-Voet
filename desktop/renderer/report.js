// Renders the PDF report (called by main via executeJavaScript).
window.render = function render(d) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const th = d.lang === 'th';
  document.documentElement.lang = d.lang;
  const L = d.labels;
  const max = Math.max(...d.scores.map((s) => Number(s.score)), 1e-9);
  const num = (v) => (d.weighted ? Number(v).toFixed(4) : String(v));
  document.getElementById('root').innerHTML = `
  <header><img src="assets/kcs-logo-transparent.png" alt="KCS"><div class="t"><div class="muted">${esc(L.page)}</div><h1>${esc(d.title)}</h1>
    ${d.description ? `<div class="muted">${esc(d.description)}</div>` : ''}</div></header>
  <div class="meta">
    <div>${esc(L.voted)}<b>${d.voted} / ${d.eligible} (${d.eligible ? ((d.voted / d.eligible) * 100).toFixed(1) : 0}%)</b></div>
    <div>${esc(L.method)}<b>${esc(d.method)}</b></div>
    <div>${esc(L.status)}<b>${esc(d.status)}</b></div>
  </div>
  ${d.params.length ? `<div class="muted">${esc(L.params)}: ${d.params.map(([k, v]) => `${esc(k)} <b>${esc(v)}</b>`).join(' · ')}</div>` : ''}
  <h2>${esc(L.ranking)}</h2>
  <table><thead><tr><th>${esc(L.rankCols[0])}</th><th>${esc(L.rankCols[1])}</th><th class="barcell"></th><th class="n">${esc(L.rankCols[3])}</th><th class="n">${esc(L.rankCols[4])}</th></tr></thead><tbody>
  ${d.scores.map((s) => `<tr class="r${s.rank}"><td>${s.rank}${s.is_tie ? ` <span class="flag">(${esc(L.tie)})</span>` : ''}</td><td>${esc(s.label)}</td>
    <td class="barcell"><div class="bar" style="width:${(Number(s.score) / max * 100).toFixed(1)}%"></div></td><td class="n">${num(s.score)}</td><td class="n">${s.raw_votes}</td></tr>`).join('')}
  </tbody></table>
  <h2>${esc(L.turnout)}</h2>
  <table><thead><tr>${L.turnoutCols.map((c, i) => `<th class="${i > 0 && i < 4 ? 'n' : ''}">${esc(c)}</th>`).join('')}</tr></thead><tbody>
  ${d.turnout.map((x) => `<tr><td>${esc(x.department)}</td><td class="n">${x.headcount}</td><td class="n">${x.voted}</td><td class="n">${x.turnout_pct ?? '—'}%</td>
    <td class="flag">${x.low_turnout ? '⚠' : ''}</td><td class="flag">${x.excluded ? '✕' : ''}</td></tr>`).join('')}
  </tbody></table>
  <h2>${esc(d.rulesTitle)}</h2><ol>${d.rules.map((l) => `<li>${esc(l)}</li>`).join('')}</ol>
  <footer><span>KCS Vote · K Casting and Solution Co., Ltd.</span><span>${esc(L.exported)}: ${esc(d.exportedAt)}</span></footer>`;
  void th;
  return document.fonts.ready.then(() => Promise.all([...document.images].map((i) => (i.complete ? 0 : new Promise((r) => { i.onload = r; i.onerror = r; }))))).then(() => true);
};
