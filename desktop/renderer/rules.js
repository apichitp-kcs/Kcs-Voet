// Plain-language scoring rules (Thai / English), generated from the topic's
// parameters. Shown in the admin rules panel, on the display and in exports.
const fmt = (n) => String(Number(n)).replace(/\.0+$/, '');

export function rulesText(topic, lang = 'th') {
  const s = fmt(topic?.self_vote_weight ?? 0.5);
  const p = fmt(topic?.min_turnout_pct ?? 30);
  const weighted = topic?.weighting_enabled !== false;
  const exclude = topic?.exclude_low_turnout !== false;
  if (lang === 'en') {
    if (!weighted) {
      return { title: 'How the score is calculated', lines: [
        'One person, one vote: each option’s score is its number of votes.',
        'Highest score ranks first. Equal scores are shown as a tie and the organiser decides their order.',
        'Voting is secret: the system never stores who chose what.',
      ] };
    }
    return { title: 'How the score is calculated (fair department weighting)', lines: [
      'Every department has the same total weight of 1 point, no matter how many people work there — big departments cannot win just by size.',
      'A department’s 1 point is shared among the choices of its members who actually voted (e.g. 10 voters → each vote is worth 1/10).',
      `A vote for your own department counts ×${s} of a normal vote; the department’s votes are then re-balanced so they still add up to exactly 1 point.`,
      `A department where fewer than ${p}% of staff voted is flagged “low turnout”${exclude ? ' and its points are not counted (the organiser may re-include it).' : ' (its points are still counted).'}`,
      'Final score = sum of points from all departments. Highest score ranks first; equal scores are a tie and the organiser decides their order.',
      'Voting is secret: the system never stores who chose what.',
    ] };
  }
  if (!weighted) {
    return { title: 'วิธีคิดคะแนน', lines: [
      'นับแบบ 1 คน 1 เสียง: คะแนนของแต่ละตัวเลือกคือจำนวนเสียงที่ได้รับ',
      'คะแนนมากที่สุดได้อันดับ 1 หากคะแนนเท่ากันถือว่าเสมอ และผู้จัดงานเป็นผู้ตัดสินลำดับ',
      'การโหวตเป็นความลับ ระบบไม่บันทึกว่าใครเลือกอะไร',
    ] };
  }
  return { title: 'วิธีคิดคะแนน (ถ่วงน้ำหนักอย่างเป็นธรรมระหว่างแผนก)', lines: [
    'ทุกแผนกมีน้ำหนักรวมเท่ากันคือ 1 คะแนน ไม่ว่าจะมีพนักงานมากหรือน้อย แผนกใหญ่จึงไม่ได้เปรียบเพราะคนเยอะ',
    '1 คะแนนของแผนกจะแบ่งตามการเลือกของพนักงานในแผนกที่มาโหวตจริง (เช่น มาโหวต 10 คน แต่ละเสียงมีค่า 1/10)',
    `การโหวตให้แผนกของตัวเองนับเป็น ×${s} ของเสียงปกติ จากนั้นปรับสัดส่วนให้คะแนนของแผนกรวมกันยังเท่ากับ 1 คะแนนพอดี`,
    `แผนกที่มีผู้มาโหวตน้อยกว่า ${p}% ของจำนวนพนักงาน จะถูกระบุว่า “ผู้มาโหวตน้อย”${exclude ? ' และไม่นำคะแนนมาคิด (ผู้จัดงานสามารถนำกลับมานับได้)' : ' (ยังนำคะแนนมาคิดตามปกติ)'}`,
    'คะแนนสุดท้าย = ผลรวมคะแนนจากทุกแผนก เรียงจากมากไปน้อย หากคะแนนเท่ากันถือว่าเสมอ และผู้จัดงานเป็นผู้ตัดสินลำดับ',
    'การโหวตเป็นความลับ ระบบไม่บันทึกว่าใครเลือกอะไร',
  ] };
}
