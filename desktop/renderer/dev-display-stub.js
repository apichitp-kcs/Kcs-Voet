// DEV ONLY (excluded from the build): fakes the IPC bridge so display.html can
// be previewed in a normal browser:  dev-display.html?mode=reveal&lang=th
(function () {
  const q = new URLSearchParams(location.search);
  const depts = ['ฝ่ายผลิต', 'ฝ่ายหล่อ', 'ฝ่ายแม่พิมพ์', 'ฝ่ายควบคุมคุณภาพ', 'ฝ่ายซ่อมบำรุง', 'ฝ่ายคลังสินค้า', 'ฝ่ายจัดซื้อ', 'ฝ่ายบัญชี', 'ฝ่ายบุคคล', 'ฝ่ายขาย', 'ฝ่ายไอที', 'ฝ่ายวิศวกรรม'];
  const scores = [2.41, 2.05, 1.62, 1.1, 0.95, 0.9, 0.62, 0.55, 0.4, 0.2, 0.15, 0.05];
  const results = depts.map((d, i) => ({ id: 'o' + i, label: d, label_en: null, score: scores[i], raw: 30 - i * 2, rank: i + 1, tie: false, position: i + 1 }));
  const state = {
    lang: q.get('lang') || 'th', mode: q.get('mode') || 'voting', nonce: 1,
    topic: { id: 't', title: 'รางวัลแผนกยอดเยี่ยมประจำปี 2569', title_en: 'Best Department Award 2026', description: 'เลือกแผนกที่ทำผลงานได้ดีที่สุดในปีนี้', weighting_enabled: true, self_vote_weight: 0.5, min_turnout_pct: 30, exclude_low_turnout: true },
    voted: 87, eligible: 150, voterUrl: 'https://kcs-vote.pages.dev', qr: null, results, weighted: true,
  };
  let cb = null;
  window.kcs = { display: { onState: (fn) => { cb = fn; setTimeout(() => fn(state), 0); }, onClosed() {} } };
  window.__setState = (patch) => cb && cb(Object.assign(state, patch));
})();
