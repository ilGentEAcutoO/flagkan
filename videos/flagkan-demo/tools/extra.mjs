// Motion-graphic layers per scene (title sting, rule cards, terminal, outro).
// build({lang, st, du, s, START, DUR, r3, esc}) -> {html (inside the browser view), over (full frame), js, audio}
import fs from 'node:fs';

const HERE = new URL('.', import.meta.url);
const live = () => { try { return JSON.parse(fs.readFileSync(new URL('./live.json', HERE), 'utf8')); } catch { return null; } };

const L = (o, lang) => (typeof o === 'string' ? o : o[lang]);

function wordmark(id, size) {
  return `<div class="wm" id="${id}" style="font-size:${size}px"><span class="wmdots"><i class="d1"></i><i class="d2"></i><i class="d3"></i></span><span class="wmt"><b>Flag</b>Kan</span></div>`;
}

const STYLE = `<style>
.full{position:absolute;inset:0;pointer-events:none}
.paper{position:absolute;inset:0;background:#FFFDF7}
.paper::after{content:'';position:absolute;inset:0;background-image:radial-gradient(rgba(38,33,27,.07) 1.2px, transparent 1.3px);background-size:28px 28px}
.wm{position:relative;z-index:1;display:flex;align-items:center;gap:.42em;font-weight:800;letter-spacing:-.02em;color:#26211B;line-height:1}
.wm .wmdots{display:flex;gap:.16em}
.wm .wmdots i{display:block;width:.5em;height:.5em;border-radius:50%;border:.045em solid #26211B;box-sizing:border-box}
.wm .d1{background:#B7321F}.wm .d2{background:#E8A100}.wm .d3{background:#0B7A55}
.wm .wmt{padding:0 .04em .16em 0;margin-bottom:-.16em}
.wm .wmt b{color:#B7321F;font-weight:800}
.sub{position:relative;z-index:1;font-weight:700;color:#6E6252;letter-spacing:.01em}
.pill{position:relative;z-index:1;display:inline-flex;align-items:center;gap:12px;padding:12px 28px;border-radius:99px;background:#FFFFFF;color:#26211B;border:2px solid #26211B;box-shadow:5px 5px 0 #26211B;font:700 30px 'JetBrains Mono',monospace}
.chipx{display:inline-flex;align-items:center;gap:10px;padding:8px 18px;border-radius:99px;border:2px solid #26211B;color:#26211B;font-weight:700;font-size:21px;background:#FFFFFF}
.chipx i{display:block;width:11px;height:11px;border-radius:50%;border:2px solid #26211B}
.rcard{position:absolute;width:420px;padding:24px 28px;border-radius:16px;background:#FFFFFF;color:#26211B;border:2px solid #26211B;box-shadow:6px 6px 0 #26211B}
.rcard .k{font:700 15px 'JetBrains Mono',monospace;letter-spacing:.08em;color:#B7321F;text-transform:uppercase}
.rcard .v{margin-top:8px;font-weight:800;font-size:44px;line-height:1.05;letter-spacing:-.02em}
.rcard .d{margin-top:8px;font-weight:500;font-size:21px;line-height:1.35;color:#6E6252}
.term{position:absolute;left:190px;top:150px;width:1540px;height:640px;border-radius:16px;background:#16130E;border:2px solid #FFFDF7;box-shadow:8px 8px 0 #000;overflow:hidden}
.term .tb{height:44px;background:#26211B;display:flex;align-items:center;padding-left:18px;gap:8px;border-bottom:2px solid #FFFDF7}
.term .tb i{display:block;width:14px;height:14px;border-radius:50%;border:2px solid #FFFDF7}
.term .tb span{margin-left:auto;margin-right:auto;font:500 15px 'JetBrains Mono',monospace;color:#CDBFA6;transform:translateX(-30px)}
.term pre{margin:0;padding:26px 30px;font:400 21px/1.6 'JetBrains Mono',monospace;color:#E9DFCC;white-space:pre}
.term .cmdl{color:#FFFDF7;font-weight:700}
.term .pr{color:#3FBF8A}.term .ky{color:#E8A100}.term .nm{color:#FFFDF7;font-weight:700}.term .st{color:#E99A86}
.term .ln{display:block;opacity:0}
.term .hl{background:rgba(232,161,0,.16);box-shadow:inset 4px 0 0 #E8A100}
.term .typed{display:inline-block;overflow:hidden;vertical-align:bottom;white-space:pre}
.asof{position:absolute;right:236px;top:${34 + 46 + 18}px;padding:8px 16px;border-radius:99px;background:#FFFFFF;color:#26211B;border:2px solid #26211B;box-shadow:4px 4px 0 #26211B;font:700 17px 'Sarabun',sans-serif;opacity:0}
.asof i{display:inline-block;width:10px;height:10px;border-radius:50%;background:#0B7A55;border:2px solid #26211B;margin-right:9px;vertical-align:0}
</style>`;

export const EXTRA = {
  open: {
    winIn: 2.9,
    build({ lang, st, r3 }) {
      const over = `${STYLE}
<div class="full" id="sting"><div class="paper" id="sting-paper"></div><div id="sting-in" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px">
  ${wordmark('wm-open', 150)}
  <div class="sub" id="sting-sub" style="font-size:36px">${L({ en: 'Live product demo', th: 'เดโมการใช้งานจริง' }, lang)}</div>
</div></div>`;
      const js = `
tl.fromTo('#wm-open .d1', {scale: 0, opacity: 0}, {scale: 1, opacity: 1, duration: .45, ease: 'back.out(2.4)'}, .25);
tl.fromTo('#wm-open .d2', {scale: 0, opacity: 0}, {scale: 1, opacity: 1, duration: .45, ease: 'back.out(2.4)'}, .37);
tl.fromTo('#wm-open .d3', {scale: 0, opacity: 0}, {scale: 1, opacity: 1, duration: .45, ease: 'back.out(2.4)'}, .49);
tl.fromTo('#wm-open .wmt', {opacity: 0, x: -30, clipPath: 'inset(0 100% 0 0)'}, {opacity: 1, x: 0, clipPath: 'inset(0 0% 0 0)', duration: .8, ease: 'power3.out'}, .9);
tl.fromTo('#sting-sub', {opacity: 0, y: 16}, {opacity: 1, y: 0, duration: .6, ease: 'power2.out'}, 1.5);
tl.to('#sting-in', {opacity: 0, scale: 1.06, y: -50, duration: .55, ease: 'power2.in'}, 2.6);
tl.to('#sting-paper', {yPercent: -100, duration: .8, ease: 'power3.inOut'}, 2.75);
`;
      const audio = `<audio id="sfx-open-bass" src="assets/sfx/impact-bass-1.mp3" data-start="1.4" data-duration="2.12" data-track-index="24" data-volume="0.3"></audio>
<audio id="sfx-open-whoosh" src="assets/sfx/whoosh.mp3" data-start="2.75" data-duration="0.57" data-track-index="23" data-volume="0.3"></audio>
<audio id="sfx-open-pop1" src="assets/sfx/pop.mp3" data-start="0.25" data-duration="0.72" data-track-index="25" data-volume="0.3"></audio>
<audio id="sfx-open-pop2" src="assets/sfx/pop.mp3" data-start="0.37" data-duration="0.72" data-track-index="26" data-volume="0.3"></audio>
<audio id="sfx-open-pop3" src="assets/sfx/pop.mp3" data-start="0.49" data-duration="0.72" data-track-index="27" data-volume="0.3"></audio>\n`;
      return { over, js, audio };
    },
  },

  grade: {
    build({ lang, st, du, s, r3 }) {
      const cards = [
        { k: { en: 'dead if', th: 'นับว่าพัง ถ้า' }, v: { en: 'Price −90%', th: 'ราคา −90%' }, d: { en: 'or worse, within 6 hours', th: 'หรือหนักกว่า ภายใน 6 ชม.' }, at: s(2) },
        { k: { en: 'or', th: 'หรือ' }, v: { en: 'Liquidity < $1K', th: 'สภาพคล่อง < $1K' }, d: { en: 'from the same feed as first sight', th: 'วัดจากแหล่งเดียวกับตอนเห็นครั้งแรก' }, at: s(3) },
        { k: { en: 'or', th: 'หรือ' }, v: { en: 'No trades', th: 'ไม่มีการเทรด' }, d: { en: 'in the final hour', th: 'ในชั่วโมงสุดท้าย' }, at: s(3) + 2.0 },
      ];
      let over = '', js = '';
      cards.forEach((c, i) => {
        const id = `rc-${i}`;
        over += `<div class="rcard" id="${id}" style="left:${1250}px;top:${130 + i * 236}px;opacity:0"><div class="k">${L(c.k, lang)}</div><div class="v">${L(c.v, lang)}</div><div class="d">${L(c.d, lang)}</div></div>`;
        js += `tl.fromTo('#${id}', {opacity: 0, x: 60}, {opacity: 1, x: 0, duration: .55, ease: 'power3.out'}, ${r3(st + c.at)});\n`;
        js += `tl.to('#${id}', {opacity: 0, x: 40, duration: .35, ease: 'power2.in'}, ${r3(st + du - 0.45)});\n`;
      });
      const audio = cards.map((c, i) => `<audio id="sfx-grade-${i}" src="assets/sfx/click-soft.mp3" data-start="${r3(st + c.at)}" data-duration="0.37" data-track-index="${28 + i}" data-volume="0.4"></audio>`).join('\n') + '\n';
      return { over, js, audio };
    },
  },

  proof: {
    build({ lang, st, du, r3 }) {
      const lv = live();
      const asof = lv ? (lang === 'th' ? `ข้อมูลสด ณ ${lv.asofTh}` : `Live data as of ${lv.asofEn}`) : '';
      if (!asof) return {};
      return {
        over: `<div class="asof" id="asof-proof"><i></i>${asof}</div>`,
        js: `tl.fromTo('#asof-proof', {opacity: 0, y: -8}, {opacity: 1, y: 0, duration: .4}, ${r3(st + 0.6)}); tl.to('#asof-proof', {opacity: 0, duration: .3}, ${r3(st + du - 0.3)});\n`,
      };
    },
  },

  api: {
    minDur: () => 11.5,
    build({ lang, st, du, s, r3, esc }) {
      const lv = live();
      const term = lv?.term || [{ cmd: 'curl -s flag.sornkan.com/api/proof', out: ['{}'] }];
      const color = ln => esc(ln).replace(/("[^"]+")(:)/g, '<span class="ky">$1</span>$2').replace(/: ?(-?[\d.]+|true|false|null)/g, (m0, v) => m0.replace(v, `<span class="nm">${v}</span>`));
      let pre = '', js = '', audio = '';
      let t = st + 0.6, k = 0;
      term.forEach((blk, bi) => {
        const n = blk.cmd.length, typeDur = Math.min(1.6, n * 0.016);
        pre += `<span class="ln cmdl" id="tc-${bi}"><span class="pr">$ </span><span class="typed" id="tt-${bi}" style="width:0ch">${esc(blk.cmd)}</span></span>`;
        js += `tl.fromTo('#tc-${bi}', {opacity: 0}, {opacity: 1, duration: .05}, ${r3(t)});\n`;
        js += `tl.fromTo('#tt-${bi}', {width: '0ch'}, {width: '${n}ch', duration: ${r3(typeDur)}, ease: 'steps(${n})'}, ${r3(t)});\n`;
        audio += `<audio id="sfx-api-type-${bi}" src="assets/sfx/typing.mp3" data-start="${r3(t)}" data-duration="${r3(Math.min(1.5, typeDur))}" data-track-index="${28 + bi * 2}" data-volume="0.3"></audio>\n`;
        t += typeDur + 0.25;
        audio += `<audio id="sfx-api-key-${bi}" src="assets/sfx/key-press.mp3" data-start="${r3(t)}" data-duration="0.4" data-track-index="${29 + bi * 2}" data-volume="0.35"></audio>\n`;
        t += 0.35;
        blk.out.forEach((ln, i) => {
          const hi = /"(base_dead_rate|baseline_all_red_accuracy|survival|lift)"/.test(ln) ;
          pre += `<span class="ln${hi ? ' hl' : ''}" id="to-${k}">${color(ln)}</span>`;
          js += `tl.fromTo('#to-${k}', {opacity: 0}, {opacity: 1, duration: .1}, ${r3(t + i * 0.05)});\n`; k++;
        });
        t += blk.out.length * 0.05 + 1.4;
        pre += `<span class="ln" style="opacity:1;height:14px"></span>`;
      });
      const over = `<div class="full" id="api-dim" style="background:rgba(22,19,14,.6);opacity:0"></div>
<div class="term" id="term" style="opacity:0"><div class="tb"><i style="background:#B7321F"></i><i style="background:#E8A100"></i><i style="background:#0B7A55"></i><span>~ — public API, no key needed</span></div><pre>${pre}</pre></div>`;
      js = `tl.fromTo('#api-dim', {opacity: 0}, {opacity: 1, duration: .4}, ${r3(st)});
tl.fromTo('#term', {opacity: 0, y: 40, scale: .97}, {opacity: 1, y: 0, scale: 1, duration: .6, ease: 'power3.out'}, ${r3(st + 0.1)});
` + js + `tl.to(['#term', '#api-dim'], {opacity: 0, duration: .4}, ${r3(st + du - 0.45)});\n`;
      return { over, js, audio };
    },
  },

  outro: {
    build({ lang, st, du, r3 }) {
      const over = `<div class="full" id="outro-wrap"><div class="paper" id="outro-paper"></div></div><div class="full" id="outro" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:30px">
  ${wordmark('wm-out', 128)}
  <div class="sub" id="out-tag" style="font-size:48px;color:#26211B;font-weight:800;letter-spacing:${lang === 'th' ? '0.01em' : '-0.02em'}">${L({ en: 'Check before you buy.', th: 'เช็กก่อนซื้อ' }, lang)}</div>
  <div class="pill" id="out-url"><span style="color:#B7321F">↗</span>flag.sornkan.com</div>
  <div id="out-chips" style="display:flex;gap:14px;margin-top:18px">
    <span class="chipx"><i style="background:#E8A100"></i>Solami RPC</span>
    <span class="chipx"><i style="background:#0B7A55"></i>TypeSafe Jev</span>
    <span class="chipx"><i style="background:#B7321F"></i>LightGBM</span>
    <span class="chipx"><i style="background:#FCEFD9"></i>Cloudflare Workers</span>
  </div>
  <div class="sub" id="out-nfa" style="font-size:20px;color:#8F806A;margin-top:6px;font-weight:600">${L({ en: 'FlagKan flags risk patterns. It is not financial advice.', th: 'FlagKan ชี้สัญญาณความเสี่ยง ไม่ใช่คำแนะนำการลงทุน' }, lang)}</div>
</div>`;
      const a = st + 0.5;
      const js = `
tl.fromTo('#outro-paper', {yPercent: 100}, {yPercent: 0, duration: .8, ease: 'power3.inOut'}, ${r3(st)});
tl.fromTo('#wm-out .d1', {scale: 0}, {scale: 1, duration: .45, ease: 'back.out(2.4)'}, ${r3(a)});
tl.fromTo('#wm-out .d2', {scale: 0}, {scale: 1, duration: .45, ease: 'back.out(2.4)'}, ${r3(a + .15)});
tl.fromTo('#wm-out .d3', {scale: 0}, {scale: 1, duration: .45, ease: 'back.out(2.4)'}, ${r3(a + .3)});
tl.fromTo('#wm-out .wmt', {opacity: 0, clipPath: 'inset(0 100% 0 0)'}, {opacity: 1, clipPath: 'inset(0 0% 0 0)', duration: .7, ease: 'power3.out'}, ${r3(a + .5)});
tl.fromTo('#out-tag', {opacity: 0, y: 18}, {opacity: 1, y: 0, duration: .55, ease: 'power2.out'}, ${r3(a + 0.9)});
tl.fromTo('#out-url', {opacity: 0, y: 18, scale: .96}, {opacity: 1, y: 0, scale: 1, duration: .55, ease: 'back.out(1.6)'}, ${r3(a + 2.0)});
tl.fromTo('#out-chips .chipx', {opacity: 0, y: 12}, {opacity: 1, y: 0, duration: .4, stagger: .1, ease: 'power2.out'}, ${r3(a + 2.6)});
tl.fromTo('#out-nfa', {opacity: 0}, {opacity: 1, duration: .5}, ${r3(a + 3.2)});
`;
      const audio = `<audio id="sfx-out-impact" src="assets/sfx/impact-bass-1.mp3" data-start="${r3(a + 0.45)}" data-duration="2.12" data-track-index="28" data-volume="0.3"></audio>
<audio id="sfx-out-chime" src="assets/sfx/chime.mp3" data-start="${r3(a + 2.0)}" data-duration="2.5" data-track-index="29" data-volume="0.22"></audio>\n`;
      return { over, js, audio };
    },
  },
};
