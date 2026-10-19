// Shared edit plan for the EN and TH demo cuts. Times are scene-local seconds,
// usually anchored on VO slots (s(i)) or on capture marks (m('name')).
// Rects name element boxes logged by shots.mjs ("rect:<name>").

export const CHAPTERS = {
  open: { en: 'FlagKan', th: 'FlagKan' },
  board: { en: 'Live board', th: 'กระดานสด' },
  coin: { en: 'Coin verdict', th: 'คำชี้รายเหรียญ' },
  check: { en: 'On-demand check', th: 'ตรวจเหรียญเอง' },
  grade: { en: 'Graded in 6h', th: 'ตรวจผลใน 6 ชม.' },
  proof: { en: 'Criteria', th: 'หลักเกณฑ์' },
  api: { en: 'Open API', th: 'API เปิด' },
  outro: { en: '', th: '' },
};

export const URLS = {
  open: 'flag.sornkan.com', board: 'flag.sornkan.com/board.html', coin: 'flag.sornkan.com/board.html',
  check: 'flag.sornkan.com/board.html', grade: 'flag.sornkan.com/proof', proof: 'flag.sornkan.com/proof',
  api: 'flag.sornkan.com/api/proof', outro: 'flag.sornkan.com',
};

// plan(s, m) -> { cam: [...], marks: [...] } where
//   cam:   { at, rect|null, dur=0.9, pad=40, max=2.1 }
//   marks: { at, dur, rect, color, label:{en,th}, pos }
export const PLANS = {
  open: (s, m) => ({
    cam: [{ at: 0, rect: null }, { at: 5.5, rect: 'hero', pad: 30, max: 1.35, dur: 6 }],
    marks: [],
  }),
  board: (s, m) => ({
    cam: [
      { at: 0, rect: null },
      { at: s(1) + 0.2, rect: 'stats', pad: 60, max: 1.9, dur: 1.0 },
      { at: s(2) + 0.6, rect: 'top3b', pad: 40, max: 1.6, dur: 1.0 },
      { at: s(3) - 0.2, rect: 'row', pad: 60, max: 1.45, dur: 0.9 },
      { at: s(5) - 0.3, rect: 'filters', pad: 80, max: 1.7, dur: 0.9 },
      { at: s(5) + 3.2, rect: null, dur: 1.1 },
    ],
    marks: [
      { at: s(1) + 0.9, dur: s(2) - s(1) - 0.3, rect: 'live', color: 'green', pos: 'bottom', label: { en: 'live connection', th: 'เชื่อมต่อสด' } },
      { at: s(2) + 1.3, dur: s(3) - s(2) - 1.3, rect: 'top3b', color: 'yellow', pos: 'bottom', label: { en: 'pushed live over WebSocket', th: 'ส่งมาสดผ่าน WebSocket' } },
      { at: s(3) + 0.2, dur: 1.3, rect: 'light', color: 'red', pos: 'top', label: { en: 'the light', th: 'ไฟ' } },
      { at: s(3) + 1.5, dur: 1.0, rect: 'conf', color: 'ink', pos: 'top', label: { en: 'confidence', th: 'ความมั่นใจ' } },
      { at: s(3) + 2.5, dur: 1.4, rect: 'liq', color: 'ink', pos: 'top', label: { en: 'price · liquidity', th: 'ราคา · สภาพคล่อง' } },
      { at: s(4) + 0.1, dur: s(5) - s(4) - 0.4, rect: 'top1', color: 'red', pos: 'top', label: { en: 'biggest wallet’s share', th: 'สัดส่วนกระเป๋าใหญ่สุด' } },
    ],
  }),
  coin: (s, m) => ({
    cam: [
      { at: 0, rect: null },
      { at: m('opened') + 0.4, rect: 'card', pad: 20, max: 1.25, dur: 0.9 },
      { at: s(1) - 0.1, rect: 'verdict', pad: 50, max: 1.9, dur: 0.9 },
      { at: s(2) - 0.1, rect: 'sigs', pad: 40, max: 1.75, dur: 1.0 },
      { at: s(4) - 0.1, rect: 'sig6', pad: 130, max: 2.0, dur: 0.9 },
      { at: s(5) - 0.1, rect: 'facts', pad: 40, max: 1.8, dur: 1.0 },
      { at: s(7) - 1.0, rect: null, dur: 0.7 },
      { at: m('reopened') + 0.2, rect: 'card', pad: 20, max: 1.25, dur: 0.9 },
    ],
    marks: [
      { at: s(1) + 0.4, dur: s(2) - s(1) - 0.5, rect: 'verdict', color: 'red', pos: 'bottom', label: { en: 'model odds: red · yellow · green', th: 'โอกาสจากโมเดล: แดง · เหลือง · เขียว' } },
      { at: s(2) + 0.5, dur: s(4) - s(2) - 0.7, rect: 'sigs', color: 'yellow', pos: 'top', label: { en: 'on-chain signals · Solami RPC', th: 'สัญญาณบนเชน · Solami RPC' } },
      { at: s(4) + 0.4, dur: s(5) - s(4) - 0.5, rect: 'sig6', color: 'green', pos: 'bottom', label: { en: 'Jev · TypeSafe AI judge', th: 'Jev · AI ผู้ตัดสินจาก TypeSafe' } },
      { at: s(5) + 0.6, dur: s(7) - s(5) - 1.2, rect: 'facts', color: 'ink', pos: 'bottom', label: { en: 'light = LightGBM model + hard rules', th: 'ไฟ = โมเดล LightGBM + กฎเด็ดขาด' } },
    ],
  }),
  check: (s, m) => ({
    cam: [
      { at: 0, rect: null },
      { at: s(0) - 0.1, rect: 'input', pad: 120, max: 2.0, dur: 1.0 },
      { at: m('result') + 0.2, rect: 'card', pad: 20, max: 1.25, dur: 0.9 },
      { at: m('result') + 2.2, rect: 'verdict', pad: 60, max: 1.7, dur: 1.0 },
    ],
    marks: [
      { at: m('pasted') + 0.1, dur: m('go') - m('pasted') + 0.3, rect: 'input', color: 'yellow', pos: 'bottom', label: { en: 'any Solana mint', th: 'mint ของเหรียญ Solana ตัวไหนก็ได้' } },
      { at: m('result') + 2.6, dur: 3.0, rect: 'verdict', color: 'red', pos: 'bottom', label: { en: 'judged fresh, in seconds', th: 'ตัดสินสด ๆ ในไม่กี่วินาที' } },
    ],
  }),
  grade: (s, m) => ({
    cam: [
      { at: 0, rect: null },
      { at: s(1) + 0.2, rect: "focus", pad: 40, max: 1.5, dur: 1.1 },
      { at: s(2) - 0.4, rect: null, dur: 0.9 },
    ],
    marks: [
      { at: s(1) + 0.9, dur: s(2) - s(1) - 0.6, rect: 'alive', color: 'green', pos: 'bottom', label: { en: 'survived the 6h check → alive', th: 'ผ่านการตรวจ 6 ชม. → รอด' } },
    ],
  }),
  proof: (s, m) => ({
    cam: [
      { at: 0, rect: 'story', pad: 30, max: 1.25 },
      { at: s(1) - 0.1, rect: 'story', pad: 24, max: 1.45, dur: 1.0 },
      { at: s(4) - 0.1, rect: 'step3', pad: 60, max: 1.8, dur: 1.0 },
      { at: s(5) - 0.6, rect: 'tabs', pad: 60, max: 1.3, dur: 0.5 },
      { at: m('rkIn') + 0.1, rect: 'rk', pad: 30, max: 1.5, dur: 1.0 },
      { at: s(6) - 0.6, rect: 'tabs', pad: 60, max: 1.3, dur: 0.5 },
      { at: m('chalIn') + 0.1, rect: 'chal', pad: 30, max: 1.6, dur: 1.0 },
    ],
    marks: [
      { at: s(1) + 0.6, dur: s(2) - s(1) - 0.8, rect: 'step1', color: 'red', pos: 'inBR', label: { en: 'the base rate', th: 'อัตราพื้นฐาน' } },
      { at: s(2) + 0.6, dur: s(4) - s(2) - 0.8, rect: 'step2', color: 'ink', pos: 'inTR', label: null },
      { at: s(4) + 0.5, dur: s(5) - s(4) - 0.9, rect: 'step3', color: 'green', pos: 'inTR', label: null },
      { at: m('rkIn') + 1.2, dur: s(6) - m('rkIn') - 1.5, rect: 'rkbig', color: 'green', pos: 'bottom', label: null },
      { at: m('rkIn') + 1.3, dur: s(6) - m('rkIn') - 1.6, rect: 'rkchart', color: 'green', pos: 'inTR', noRing: true, label: { en: 'safest 10% vs a random pick', th: '10% ที่ปลอดภัยสุด เทียบสุ่มเลือก' } },
      { at: m('chalIn') + 1.2, dur: 3.0, rect: 'chal', color: 'yellow', pos: 'top', label: { en: 'LightGBM vs the old model · same coins, live', th: 'LightGBM เทียบโมเดลเดิม · เหรียญชุดเดียวกัน สด ๆ' } },
    ],
  }),
};
