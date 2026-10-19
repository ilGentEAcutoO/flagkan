// Builds the EN and TH HyperFrames projects from one edit plan so both cuts share
// timing and motion. Only VO, captions, on-screen text and the UI language of the
// captured footage differ.  Usage: node build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { PLANS, CHAPTERS, URLS } from './scenes.mjs';
import { EXTRA } from './extra.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1');
const VIDEOS = path.resolve(HERE, '..', '..');
const PROJ = { en: path.join(VIDEOS, 'flagkan-demo'), th: path.join(VIDEOS, 'flagkan-demo-th') };
const S = JSON.parse(fs.readFileSync(path.join(HERE, 'script.json'), 'utf8'));
const T = JSON.parse(fs.readFileSync(path.join(HERE, 'timing.json'), 'utf8'));
const CAPDIR = path.join(HERE, 'cap');
const LIVE = fs.existsSync(path.join(HERE, 'live.json')) ? JSON.parse(fs.readFileSync(path.join(HERE, 'live.json'), 'utf8')) : {};
const TOK = LIVE.tokens || { BASE: '98', LIFT: '1.7' };
const fillT = s => Object.entries(TOK).sort((a, b) => b[0].length - a[0].length).reduce((a, [k, v]) => a.split('{' + k + '}').join(String(v)), s);
const meta = (shot, lang) => { const p = path.join(CAPDIR, `${shot}-${lang}.json`); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };

// ---- layout ---------------------------------------------------------------
const WX = 200, WY = 34, WW = 1520, BAR = 46, CH = 855; // window + content
const VW = 1440, K = WW / VW; // viewport css px -> content px
const SHOT_OF = { open: 'landing', board: 'board', coin: 'coin', check: 'check', grade: 'grade', proof: 'proof' };
const ORDER = S.scenes.map(s => s.id);

const r3 = v => Math.round(v * 1000) / 1000;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- per-scene timing shared by both languages ------------------------------
function sceneInfo(id) {
  const out = {};
  for (const lang of ['en', 'th']) {
    const shot = SHOT_OF[id]; const mt = shot ? meta(shot, lang) : null;
    const origin = mt ? (mt.marks.find(x => x.name === 'origin')?.origin || 0) : 0;
    const m = n => { const x = mt?.marks.find(y => y.name === n); if (!x) return NaN; return x.t - origin; };
    const rect = n => { const xs = mt?.marks.filter(y => y.name === 'rect:' + n && y.rect); return xs?.length ? xs.at(-1).rect : null; };
    out[lang] = { mt, origin, m, rect };
  }
  return out;
}
const INFO = Object.fromEntries(ORDER.map(id => [id, sceneInfo(id)]));
const EXT = { check: i => Math.max(i.en.m('result'), i.th.m('result')) + 6.2 };
const DUR = {}; const START = {}; let acc = 0;
for (const id of ORDER) {
  let d = T[id].dur;
  if (EXT[id]) { const e = EXT[id](INFO[id]); if (Number.isFinite(e)) d = Math.max(d, e); }
  if (EXTRA[id]?.minDur) d = Math.max(d, EXTRA[id].minDur(T[id].slots));
  DUR[id] = r3(d); START[id] = r3(acc); acc += d;
}
const TOTAL = r3(acc);

// ---- camera math ------------------------------------------------------------
function camFor(rect, pad = 40, max = 2.1) {
  if (!rect) return { s: 1, x: 0, y: 0 };
  const [x, y, w, h] = rect.map(v => v * K);
  const s = Math.max(1, Math.min(max, Math.min(WW / (w + 2 * pad * K), CH / (h + 2 * pad * K))));
  let tx = WW / 2 - (x + w / 2) * s, ty = CH / 2 - (y + h / 2) * s;
  tx = Math.min(0, Math.max(WW - WW * s, tx)); ty = Math.min(0, Math.max(CH - CH * s, ty));
  return { s: r3(s), x: r3(tx), y: r3(ty) };
}

const COLORS = { red: '#B7321F', yellow: '#E8A100', green: '#0B7A55', ink: '#26211B' };

function build(lang) {
  const P = PROJ[lang];
  fs.mkdirSync(path.join(P, 'assets', 'cap'), { recursive: true });
  let html = '', over = '', js = '', audio = '';
  const tl = (code) => { js += code + '\n'; };

  // footage + camera per scene
  for (const id of ORDER) {
    const st = START[id], du = DUR[id], inf = INFO[id][lang];
    const slots = T[id].slots; const s = i => slots[i];
    const shot = SHOT_OF[id];
    if (shot && inf.mt) {
      const src = `${shot}-${lang}.mp4`;
      fs.copyFileSync(path.join(CAPDIR, src), path.join(P, 'assets', 'cap', src));
      const fadeIn = id === 'open' ? 0 : 0.35;
      const vStart = r3(Math.max(0, st - fadeIn)), vDur = r3(du + fadeIn + 0.35);
      const mediaStart = r3(Math.max(0, inf.origin - (st - vStart)));
      html += `
      <div class="cam" id="cam-${id}">
        <video id="v-${id}" class="clip foot" data-layout-allow-overflow src="assets/cap/${src}" muted playsinline data-start="${vStart}" data-duration="${vDur}" data-media-start="${mediaStart}" data-track-index="1"></video>
        <div class="marks" id="mk-${id}" data-layout-allow-overflow>@@MARKS-${id}@@</div>
      </div>`;
      let mhtml = '';
      // crossfade in
      tl(`tl.fromTo('#cam-${id}', {opacity: ${fadeIn ? 0 : 1}}, {opacity: 1, duration: ${fadeIn || 0.01}, ease: 'none'}, ${vStart});`);
      tl(`tl.set('#cam-${id}', {opacity: 0}, ${r3(st + du + 0.35)});`);
      const plan = PLANS[id] ? PLANS[id](s, inf.m) : { cam: [{ at: 0, rect: null }], marks: [] };
      // camera keys (rects from this language's capture; positions are shared UI so they match)
      let first = true;
      const keys = plan.cam.filter(k => Number.isFinite(k.at)).sort((a, b) => a.at - b.at);
      for (let ki = 0; ki < keys.length; ki++) {
        const k = { ...keys[ki] };
        if (ki + 1 < keys.length) k.dur = Math.max(0.2, Math.min(k.dur || 0.9, keys[ki + 1].at - k.at - 0.05));
        const c = camFor(k.rect ? inf.rect(k.rect) : null, k.pad, k.max);
        if (first) { tl(`tl.set('#cam-${id} .foot, #mk-${id}', {x: ${c.x}, y: ${c.y}, scale: ${c.s}, transformOrigin: '0 0'}, ${vStart});`); first = false; }
        else tl(`tl.to('#cam-${id} .foot, #mk-${id}', {x: ${c.x}, y: ${c.y}, scale: ${c.s}, duration: ${k.dur || 0.9}, ease: 'power3.inOut'}, ${r3(st + k.at)});`);
      }
      // ring + label marks (inside the camera, counter-scaled by the settled zoom)
      let n = 0;
      for (const mk of plan.marks) {
        const rc = inf.rect(mk.rect); if (!rc || !Number.isFinite(mk.at)) continue;
        // zoom in effect at that time = last cam key with at <= mk.at
        const camK = plan.cam.filter(k => Number.isFinite(k.at) && k.at <= mk.at).at(-1);
        const zs = camK ? camFor(camK.rect ? inf.rect(camK.rect) : null, camK.pad, camK.max).s : 1;
        const [x, y, w, h] = rc.map(v => v * K); const p = 8 / zs;
        const col = COLORS[mk.color] || COLORS.ink; const mid = `m-${id}-${n++}`;
        const fs_ = r3(24 / zs), bw = r3(3.5 / zs);
        const lab = mk.label ? mk.label[lang] : null;
        const ly = mk.pos === 'top' ? `bottom:${r3(CH - (y - p) + 10 / zs)}px` : `top:${r3(y + h + p + 10 / zs)}px`;
        const lx = mk.pos === 'inBR' ? `right:${r3(WW - (x + w) + 14 / zs)}px;bottom:${r3(CH - (y + h) + 14 / zs)}px` : mk.pos === 'inTR' ? `right:${r3(WW - (x + w) + 14 / zs)}px;top:${r3(y + 12 / zs)}px` : `left:${r3(Math.min(Math.max(x - p, 10), WW - 40))}px;${ly}`;
        mhtml += `
          ${mk.noRing ? '' : `<div class="ring" id="${mid}-r" style="left:${r3(x - p)}px;top:${r3(y - p)}px;width:${r3(w + 2 * p)}px;height:${r3(h + 2 * p)}px;border:${bw}px solid ${col};border-radius:${r3(12 / zs)}px;box-shadow:0 0 0 ${r3(6 / zs)}px ${col}26"></div>`}
          <div class="tag" id="${mid}-t" style="${lx};font-size:${fs_}px;padding:${r3(7 / zs)}px ${r3(14 / zs)}px;border-radius:${r3(99 / zs)}px;border-width:${r3(2 / zs)}px;box-shadow:${r3(4 / zs)}px ${r3(4 / zs)}px 0 #26211B"><i style="background:${col};width:${r3(9 / zs)}px;height:${r3(9 / zs)}px;margin-right:${r3(9 / zs)}px"></i>${esc(lab)}</div>`.replace(/<div class="tag"[^]*$/, lab ? '$&' : '');
        const a = r3(st + mk.at), e = r3(st + mk.at + mk.dur);
        if (!mk.noRing) tl(`tl.fromTo('#${mid}-r', {opacity: 0, scale: 1.06}, {opacity: 1, scale: 1, duration: 0.35, ease: 'power2.out'}, ${a});`);
        tl(`tl.fromTo('#${mid}-t', {opacity: 0, y: ${mk.pos === 'top' ? 8 : -8}}, {opacity: 1, y: 0, duration: 0.35, ease: 'power2.out'}, ${r3(a + 0.12)});`);
        tl(`tl.to([${mk.noRing ? '' : `'#${mid}-r', `}'#${mid}-t'], {opacity: 0, duration: 0.3, ease: 'power1.in'}, ${e});`);
      }
      html = html.replace(`@@MARKS-${id}@@`, mhtml);
      // click sfx from capture marks
      for (const x of (inf.mt.marks || [])) {
        if (!['open', 'lang', 'fRed', 'fAll', 'q', 'focus', 'go', 'close', 'reopen'].includes(x.name)) continue;
        const t = r3(st + x.t - inf.origin); if (t < st || t > st + du) continue;
        audio += `<audio id="sfx-${id}-${x.name}" src="assets/sfx/click-soft.mp3" data-start="${t}" data-duration="0.37" data-track-index="22" data-volume="0.5"></audio>\n`;
      }
      for (const x of (inf.mt.marks || []).filter(x => x.name === 'arrive' || (x.name === 'tick' && x.n > 0)).filter((x, i, a) => i === 0 || x.t - a[i - 1].t > 1)) {
        const t = r3(st + x.t - inf.origin); if (t < st + 0.2 || t > st + (slots[3] ?? du)) continue;
        audio += `<audio id="sfx-${id}-tick-${Math.round(t * 10)}" src="assets/sfx/pop.mp3" data-start="${t}" data-duration="0.72" data-track-index="23" data-volume="0.45"></audio>\n`;
      }
    }
    // extra overlays (motion graphics) for this scene
    if (EXTRA[id]) {
      const x = EXTRA[id].build({ lang, st, du, s, START, DUR, r3, esc, WW, CH });
      html += x.html || ''; over += x.over || ''; js += x.js || ''; audio += x.audio || '';
    }
    // VO
    audio += `<audio id="vo-${id}" src="assets/voice/${id}.wav" data-start="${st}" data-duration="${r3(T[id].dur)}" data-track-index="10" data-volume="1"></audio>\n`;
    if (id !== 'open' && id !== 'outro') audio += `<audio id="sfx-${id}-in" src="assets/sfx/whoosh-short.mp3" data-start="${r3(Math.max(0, st - 0.3))}" data-duration="0.57" data-track-index="21" data-volume="0.28"></audio>\n`;
  }

  // chrome bar: url + chapter per scene
  let urls = '', chaps = '';
  ORDER.forEach((id, i) => {
    urls += `<span class="url" id="u-${id}">${esc(URLS[id])}</span>`;
    if (CHAPTERS[id][lang]) chaps += `<span class="chap" id="c-${id}"><b>${String(i).padStart(2, '0')}</b>${esc(CHAPTERS[id][lang])}</span>`;
    tl(`tl.fromTo('#u-${id}', {opacity: 0}, {opacity: 1, duration: 0.25}, ${r3(START[id])}); tl.to('#u-${id}', {opacity: 0, duration: 0.2}, ${r3(START[id] + DUR[id] - 0.1)});`);
    if (CHAPTERS[id][lang] && id !== 'open') tl(`tl.fromTo('#c-${id}', {opacity: 0, y: 10}, {opacity: 1, y: 0, duration: 0.4, ease: 'power2.out'}, ${r3(START[id] + 0.1)}); tl.to('#c-${id}', {opacity: 0, y: -8, duration: 0.25}, ${r3(START[id] + DUR[id] - 0.2)});`);
  });

  // captions (one timed clip per VO chunk)
  let caps = '';
  for (const id of ORDER) {
    const sc = S.scenes.find(x => x.id === id);
    sc.chunks.forEach((ch, i) => {
      const t0 = r3(START[id] + T[id].slots[i]);
      const len = T[id].len[lang][i];
      const next = i + 1 < sc.chunks.length ? START[id] + T[id].slots[i + 1] : START[id] + DUR[id];
      const d = r3(Math.min(next - 0.02, START[id] + T[id].slots[i] + len + 0.45) - t0);
      const text = fillT(lang === 'en' ? (ch.enShow || ch.en) : ch.th);
      const ink = id === 'outro' || (id === 'open' && T[id].slots[i] < (EXTRA.open?.winIn ?? 2.8));
      caps += `<div class="cap clip${ink ? ' ink' : ''}" id="cap-${id}-${i}" data-start="${t0}" data-duration="${d}" data-track-index="5"><span>${esc(text)}</span></div>\n`;
    });
  }

  const fonts = ['400', '500', '600', '700', '800'].map(w => `
@font-face{font-family:'Sarabun';font-weight:${w};src:url('assets/fonts/sarabun-thai-${w}-normal.woff2') format('woff2');unicode-range:U+02D7,U+0303,U+0331,U+0E01-0E5B,U+200C-200D,U+25CC;}
@font-face{font-family:'Sarabun';font-weight:${w};src:url('assets/fonts/sarabun-latin-${w}-normal.woff2') format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}`).join('')
    + ['400', '700'].map(w => `\n@font-face{font-family:'JetBrains Mono';font-weight:${w};src:url('assets/fonts/jetbrains-mono-latin-${w}-normal.woff2') format('woff2');}`).join('');
  const fdir = path.join(P, 'assets', 'fonts'); fs.mkdirSync(fdir, { recursive: true });
  for (const w of ['400', '500', '600', '700', '800']) for (const sub of ['thai', 'latin']) fs.copyFileSync(path.join(HERE, 'node_modules/@fontsource/sarabun/files', `sarabun-${sub}-${w}-normal.woff2`), path.join(fdir, `sarabun-${sub}-${w}-normal.woff2`));
  for (const w of ['400', '700']) fs.copyFileSync(path.join(HERE, 'node_modules/@fontsource/jetbrains-mono/files', `jetbrains-mono-latin-${w}-normal.woff2`), path.join(fdir, `jetbrains-mono-latin-${w}-normal.woff2`));

  // window enters after the title sting, leaves for the outro
  const winIn = EXTRA.open?.winIn ?? 2.8;
  tl(`tl.fromTo('#win', {y: 260, opacity: 0, scale: 0.92, rotationX: 14}, {y: 0, opacity: 1, scale: 1, rotationX: 0, duration: 1.2, ease: 'power3.out'}, ${winIn});`);
  tl(`tl.to('#win', {y: -40, opacity: 0, scale: 0.94, duration: 0.8, ease: 'power2.in'}, ${r3(START.outro + 0.1)});`);
  tl(`tl.fromTo('#progfill', {scaleX: 0}, {scaleX: 1, duration: ${TOTAL}, ease: 'none'}, 0);`);
  tl(`tl.fromTo('#capband', {opacity: 0}, {opacity: 1, duration: 0.3}, 0.2);`);

  // music bed
  if (fs.existsSync(path.join(P, 'assets', 'music', 'bed.wav'))) audio += `<audio id="music" src="assets/music/bed.wav" data-start="0" data-duration="${TOTAL}" data-track-index="40" data-volume="1"></audio>\n`;

  const page = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=1920, height=1080" />
<title>FlagKan demo (${lang.toUpperCase()})</title>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js" integrity="sha384-sG0Hv1tP1lZCk9KQmrIbY/XNwi+OY84GQqhMscbnsoBFqAz8KNCil1kvfL3Hbbk2" crossorigin="anonymous"></script>
<style>${fonts}
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:#16130E}
#root{position:relative;width:100%;height:100%;overflow:hidden;background:#16130E;font-family:'Sarabun',sans-serif;color:#FFFDF7}
#bg{position:absolute;inset:0;background:
  radial-gradient(900px 600px at 12% 8%, rgba(183,50,31,.20), transparent 60%),
  radial-gradient(800px 520px at 92% 18%, rgba(232,161,0,.12), transparent 60%),
  radial-gradient(900px 700px at 70% 105%, rgba(11,122,85,.18), transparent 60%), #16130E}
#grid{position:absolute;inset:0;background-image:radial-gradient(rgba(255,253,247,.06) 1.2px, transparent 1.3px);background-size:28px 28px}
#stage{position:absolute;inset:0;perspective:1800px}
#win{position:absolute;left:${WX}px;top:${WY}px;width:${WW}px;height:${BAR + CH}px;border-radius:16px;overflow:hidden;background:#FFFDF7;border:2px solid #26211B;box-shadow:8px 8px 0 #000,0 40px 90px -20px rgba(0,0,0,.6);opacity:0}
#bar{position:absolute;left:0;top:0;width:100%;height:${BAR}px;background:#FCEFD9;border-bottom:2px solid #26211B;display:flex;align-items:center}
#dots{display:flex;gap:8px;margin-left:18px}
#dots i{display:block;width:14px;height:14px;border-radius:50%;border:2px solid #26211B}
#urlbox{position:absolute;left:50%;top:8px;width:560px;margin-left:-280px;height:28px;border-radius:99px;background:#FFFDF7;border:2px solid #26211B}
.url{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:500 15px 'JetBrains Mono',monospace;color:#5E5242;opacity:0}
.url::before{content:'';display:inline-block;width:9px;height:11px;margin-right:9px;border:2px solid #8F806A;border-radius:2px 2px 3px 3px}
.chap{position:absolute;right:16px;top:7px;height:30px;border-radius:99px;display:flex;align-items:center;gap:10px;padding:0 14px;border-radius:15px;background:#26211B;color:#FFFDF7;font-weight:700;font-size:16px;opacity:0;white-space:nowrap}
.chap b{font:700 13px 'JetBrains Mono',monospace;color:#E8A100}
#view{position:absolute;left:0;top:${BAR}px;width:${WW}px;height:${CH}px;overflow:hidden;background:#FFFDF7}
.cam{position:absolute;inset:0;opacity:0}
.foot{position:absolute;left:0;top:0;width:${WW}px;height:${CH}px;object-fit:cover}
.marks{position:absolute;left:0;top:0;width:${WW}px;height:${CH}px}
.ring{position:absolute;opacity:0}
.tag{position:absolute;display:flex;align-items:center;background:#FFFFFF;color:#26211B;font-weight:800;white-space:nowrap;opacity:0;border-style:solid;border-color:#26211B}
.tag i{display:inline-block;border-radius:50%}
#prog{position:absolute;left:0;right:0;bottom:0;height:4px;background:rgba(255,248,234,.08)}
#progfill{display:block;width:100%;height:100%;background:linear-gradient(90deg,#E0523A,#F2B233,#2FBF86);transform-origin:0 50%}
#capband{position:absolute;left:0;right:0;top:${WY + BAR + CH}px;bottom:0;opacity:0}
.cap{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:0 160px}
.cap.ink span{color:#26211B;text-shadow:none}
.cap span{display:block;text-align:center;font-weight:600;font-size:${lang === 'th' ? 35 : 34}px;line-height:1.3;color:#FFFDF7;letter-spacing:${lang === 'th' ? 0 : -0.2}px;text-shadow:0 2px 12px rgba(0,0,0,.5)}
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${TOTAL}" data-width="1920" data-height="1080">
  <div id="bg"></div><div id="grid"></div>
  <div id="stage">
    <div id="win">
      <div id="bar"><div id="dots"><i style="background:#B7321F"></i><i style="background:#E8A100"></i><i style="background:#0B7A55"></i></div>
        <div id="urlbox">${urls}</div>${chaps}</div>
      <div id="view">${html}
      </div>
    </div>
  </div>
  <div id="overlays">${over}</div>
  <div id="capband">${caps}</div>
  <div id="prog"><i id="progfill"></i></div>
${audio}
</div>
<script>
const tl = gsap.timeline({ paused: true });
${js}
window.__timelines["main"] = tl;
</script>
</body>
</html>
`;
  fs.writeFileSync(path.join(P, 'index.html'), page);
  return { total: TOTAL };
}

for (const lang of ['en', 'th']) build(lang);
fs.writeFileSync(path.join(HERE, 'layout.json'), JSON.stringify({ total: TOTAL, start: START, dur: DUR }, null, 1));
console.log('built', TOTAL.toFixed(2), 's', JSON.stringify(Object.fromEntries(ORDER.map(id => [id, [START[id], DUR[id]]]))));
