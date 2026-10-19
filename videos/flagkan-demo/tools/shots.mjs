// Timed screenplays for each captured scene. Every action is scheduled on the scene's
// shared VO slots (timing.json) so the EN and TH takes move identically. Element rects
// are logged as marks ("rect:<name>") so the edit can punch in on real UI positions.
// Usage: node shots.mjs <shot[,shot]|all> <en|th|both>
import fs from 'node:fs';
import { start } from './rec.mjs';

const BASE = 'https://flag.sornkan.com';
const OUT = 'C:/Users/suanw/projects/hack/videos/flagkan-demo/tools/cap';
const T = JSON.parse(fs.readFileSync(new URL('./timing.json', import.meta.url), 'utf8'));
const CFG = JSON.parse(fs.readFileSync(new URL('./capture.json', import.meta.url), 'utf8'));
if (CFG.checkMint === 'fresh') CFG.checkMint = JSON.parse(fs.readFileSync(new URL('./fresh.json', import.meta.url), 'utf8')).mint;
if (CFG.coinMint === 'auto') CFG.coinMint = JSON.parse(fs.readFileSync(new URL('./live.json', import.meta.url), 'utf8')).coin.mint;
let CUR = null;
const slot = (sc, i) => T[sc].slots[i];

const langInit = lang => `try{localStorage.setItem('flagkan_lang','${lang}');localStorage.setItem('flagkan_per','20');localStorage.removeItem('flagkan_watch')}catch(e){}`;

async function open(name, lang, url) {
  const r = await start(`${name}-${lang}`, OUT, { lang, storage: langInit(lang) });
  CUR = r;
  r.page.on('pageerror', e => console.log('pageerror:', e.message));
  await r.page.goto(BASE + url, { waitUntil: 'networkidle' }).catch(() => {});
  await r.page.waitForTimeout(1800);
  r.origin = 0;
  r.at = async function (t) { const due = this._wall0 + this.origin * 1000 + t * 1000; const ms = due - Date.now(); if (ms > 0) await this.page.waitForTimeout(ms); };
  return r;
}

const SHOTS = {
  // Landing page hero, slow drift for the cold open.
  async landing(lang) {
    const r = await open('landing', lang, '/');
    await r.page.mouse.move(1300, 760); r.pos = [1300, 760];
    await r.begin();
    await r.rect('hero', '.hero');
    await r.at(1.5); await r.move(1000, 560, 2500);
    await r.at(T.open.dur + 1.3);
    return r.end();
  },
  // Board: wait for a real WebSocket tick, then run the tour relative to it.
  async board(lang) {
    // the live socket is capped per IP: retry until the page reports "live" (or give up -> polling)
    let r, live = false;
    const tries = Number(process.env.LIVE_TRIES || 1);
    for (let k = 0; k < tries; k++) {
      r = await open('board', lang, '/board.html');
      live = await r.page.waitForFunction(() => /(^|\s)live(\s|$)/.test(document.getElementById('liveSt')?.className || ''), null, { timeout: 10000 }).then(() => true).catch(() => false);
      if (live || k === tries - 1) break;
      console.log('board: not live yet, retry', k + 1); await r.browser.close(); await new Promise(z => setTimeout(z, 20000));
    }
    console.log('board live =', live);
    // mark row arrivals from the DOM too (works for the polling fallback)
    await r.page.evaluate(() => { const rows = document.getElementById('rows'); let top = rows.querySelector('tr')?.getAttribute('data-m');
      new MutationObserver(() => { const t = rows.querySelector('tr')?.getAttribute('data-m'); if (t && t !== top) { top = t; window.__fkTick && window.__fkTick('arrive', 1); } }).observe(rows, { childList: true, subtree: true }); });
    await r.page.mouse.move(1150, 720); r.pos = [1150, 720];
    await r.begin();
    await r.rect('stats', '.bstat');
    await r.rect('live', '#liveSt');
    await r.rect('top3', '#rows tr:nth-child(-n+3)');
    const tickAt = slot('board', 2) + 1.2; // the push lands 1.2s into the "pushes" line
    r.keepSec = tickAt + 6; // ring buffer while waiting for a real arrival
    const t0 = Date.now();
    let tick = null;
    while (Date.now() - t0 < 420000) {
      const m = r.marks.find(x => (x.name === 'arrive' || (x.name === 'tick' && x.n > 0)) && x.t > tickAt + 0.3);
      if (m) { tick = m; break; }
      await r.page.waitForTimeout(150);
    }
    if (!tick) throw new Error('no new row within 420s');
    r.keepSec = 0;
    r.live = live;
    r.origin = tick.t - tickAt;
    r.mark('origin', { origin: r.origin, tickN: tick.n, live });
    await r.wait(500);
    await r.rect('top3b', '#rows tr:nth-child(-n+3)');
    await r.at(slot('board', 3) - 0.6);
    await r.rect('row', '#rows tr:nth-child(2)');
    for (const [k, c] of [['light', 3], ['conf', 4], ['price', 5], ['liq', 6], ['top1', 7]]) await r.rect(k, `#rows tr:nth-child(-n+5) td:nth-child(${c}), thead th:nth-child(${c})`);
    await r.rect('filters', '#q, #fAll, #fRed, #fYel, #fGrn, #fStar');
    await r.at(slot('board', 3)); await r.moveTo('#rows tr:nth-child(2) td:nth-child(3)', 700);
    await r.at(slot('board', 3) + 1.4); await r.moveTo('#rows tr:nth-child(2) td:nth-child(4)', 600);
    await r.at(slot('board', 3) + 2.4); await r.moveTo('#rows tr:nth-child(2) td:nth-child(6)', 700);
    await r.at(slot('board', 4) + 0.1); await r.moveTo('#rows tr:nth-child(2) td:nth-child(7)', 600);
    await r.at(slot('board', 5)); await r.click('#fRed', 700, 'fRed');
    await r.at(slot('board', 5) + 1.0); await r.click('#fAll', 500, 'fAll');
    await r.at(slot('board', 5) + 1.7); await r.click('#q', 500, 'q');
    await r.page.keyboard.type(CFG.search, { delay: 110 });
    await r.at(T.board.dur + 1.3);
    return r.end();
  },
  // Coin detail: open the chosen coin, travel the Why panel, switch language.
  async coin(lang) {
    const r = await open('coin', lang, '/board.html');
    const onPage = await r.page.locator(`#rows tr[data-m="${CFG.coinMint}"]`).count();
    const rowSel = onPage ? `#rows tr[data-m="${CFG.coinMint}"] td:nth-child(2)` : '#rows tr:nth-child(1) td:nth-child(2)';
    if (!onPage) { await r.page.fill('#q', CFG.coinMint); await r.page.waitForTimeout(800); }
    await r.page.mouse.move(900, 700); r.pos = [900, 700];
    await r.begin();
    await r.at(slot('coin', 0) + 0.2); await r.click(rowSel, 900, 'open', 0.25, 0.5);
    await r.page.waitForSelector('#modal.open #dProbs', { timeout: 15000 }); r.mark('opened'); await r.wait(500);
    await r.rect('verdict', '#dVerdict, #dProbs, #dProbCap');
    await r.rect('sigs', '#sigs');
    await r.rect('sig6', '#sigs > *:nth-child(6)');
    await r.rect('facts', '#dFacts');
    await r.rect('card', '#modal .mcard');
    await r.rect('lang', '#bEN, #bTH');
    await r.at(slot('coin', 1)); await r.moveTo('#dProbs', 800);
    await r.at(slot('coin', 2)); await r.moveTo('#sigs', 800, 0.12, 0.15);
    await r.at(slot('coin', 4)); await r.moveTo('#sigs > *:nth-child(6)', 800, 0.2, 0.5);
    await r.at(slot('coin', 5) + 0.3); await r.move(r.pos[0] - 200, r.pos[1] + 70, 700);
    // the language toggle sits behind the modal: close, switch, reopen the same coin
    await r.at(slot('coin', 7) - 0.9); await r.click('#dClose', 600, 'close');
    await r.at(slot('coin', 7) + 0.1); await r.click(lang === 'en' ? '#bTH' : '#bEN', 700, 'lang');
    await r.at(slot('coin', 7) + 1.2); await r.click(rowSel, 700, 'reopen', 0.25, 0.5);
    await r.page.waitForSelector('#modal.open #dProbs', { timeout: 15000 }); r.mark('reopened');
    await r.at(T.coin.dur + 1.3);
    return r.end();
  },
  // On-demand check of a pasted mint.
  async check(lang) {
    const r = await open('check', lang, '/board.html');
    await r.page.mouse.move(820, 520); r.pos = [820, 520];
    await r.begin();
    await r.rect('input', '#mint, #go');
    await r.at(slot('check', 0) + 0.2); await r.click('#mint', 800, 'focus');
    await r.at(slot('check', 0) + 1.4);
    // a paste: the text appears at once
    await r.page.evaluate(m => { const i = document.getElementById('mint'); i.value = m; i.dispatchEvent(new Event('input', { bubbles: true })); }, CFG.checkMint);
    r.mark('pasted');
    await r.at(slot('check', 1)); await r.click('#go', 700, 'go');
    await r.page.waitForSelector('#modal.open #dProbs', { timeout: 40000 }).catch(() => console.log('check: no modal'));
    r.mark('result');
    await r.wait(400);
    await r.rect('verdict', '#dVerdict, #dProbs, #dProbCap');
    await r.rect('card', '#modal .mcard');
    await r.rect('chart', '#chart');
    await r.move(1150, 600, 900);
    await r.at(Math.max(T.check.dur + 1.3, (Date.now() - r._wall0) / 1000 + 7.5));
    return r.end();
  },
  // Grading: the "Graded coins" tab (every resolved coin, dead / alive), real outcomes.
  async grade(lang) {
    const r = await open('grade', lang, '/proof#coins');
    await r.page.waitForSelector('#rows tr td .oc', { timeout: 20000 }).catch(() => {});
    await r.page.waitForTimeout(500);
    // frame the table so the first surviving coin sits in the lower-middle of the view
    const y = await r.page.evaluate(() => { const rows = [...document.querySelectorAll('#rows tr')]; const a = rows.find(tr => tr.querySelector('.oc.alive'));
      if (!a) return 0; const ay = a.getBoundingClientRect().top + scrollY; return Math.max(0, ay - 520); });
    await r.page.evaluate(y => scrollTo(0, y), y); await r.page.waitForTimeout(600);
    await r.page.mouse.move(1000, 700); r.pos = [1000, 700];
    await r.begin();
    const alive = await r.page.evaluate(() => { const rows = [...document.querySelectorAll('#rows tr')]; return rows.findIndex(tr => tr.querySelector('.oc.alive') && !/^(Bonk|dogwifhat|Jupiter|cat in a dogs world)$/i.test((tr.querySelector('.coinname')?.textContent || '').trim()) && tr.getBoundingClientRect().top > 100 && tr.getBoundingClientRect().bottom < 800); });
    r.mark('aliveRow', { idx: alive });
    await r.rect('focus', alive >= 0 ? `#rows tr:nth-child(${alive + 1})` : '#rows');
    const anyRow = await r.page.evaluate(() => { const rows = [...document.querySelectorAll('#rows tr')]; return Math.max(0, rows.findIndex(tr => tr.getBoundingClientRect().top > 300)); });
    await r.at(slot('grade', 0) + 0.2); await r.moveTo(`#rows tr:nth-child(${anyRow + 1}) td:nth-child(4)`, 900);
    if (alive >= 0) {
      await r.rect('alive', `#rows tr:nth-child(${alive + 1})`);
      await r.at(slot('grade', 1) + 0.4); await r.moveTo(`#rows tr:nth-child(${alive + 1}) td:nth-child(4)`, 900);
    }
    await r.at(slot('grade', 2) + 0.2); await r.move(r.pos[0] - 300, r.pos[1] + 40, 2500);
    await r.at(T.grade.dur + 1.3);
    return r.end();
  },
  // Criteria: the honest story cards, then the Ranking tab, then LightGBM vs LR.
  async proof(lang) {
    const r = await open('proof', lang, '/proof#summary');
    await r.page.waitForFunction(() => { const v = document.querySelector('#story .step:nth-of-type(3) .sv'); return v && /\d/.test(v.textContent); }, null, { timeout: 20000 }).catch(() => {});
    await r.page.waitForTimeout(800);
    await r.page.mouse.move(1150, 760); r.pos = [1150, 760];
    await r.begin();
    await r.rect('story', '#story');
    for (let i = 1; i <= 3; i++) await r.rect('step' + i, `#story .step:nth-of-type(${i})`);
    await r.rect('tabs', '#tabs');
    await r.at(slot('proof', 1)); await r.moveTo('#story .step:nth-of-type(1)', 800, 0.86, 0.3);
    await r.at(slot('proof', 2)); await r.moveTo('#story .step:nth-of-type(2)', 800, 0.86, 0.3);
    await r.at(slot('proof', 4)); await r.moveTo('#story .step:nth-of-type(3)', 800, 0.86, 0.3);
    await r.at(slot('proof', 5) - 0.1); await r.click('#t-ranking', 700, 'tabRk');
    await r.wait(500); r.mark('rkIn');
    await r.rect('rk', '#rk'); await r.rect('rkchart', '#rk .chart'); await r.rect('rkbig', '#rk .rkbig');
    await r.moveTo('#rk .chart', 700, 0.08, 0.5);
    await r.at(slot('proof', 6) - 0.1); await r.click('#t-models', 700, 'tabModels');
    await r.wait(500); r.mark('chalIn');
    await r.rect('chal', '#chal');
    await r.moveTo('#chal', 700, 0.5, 0.4);
    await r.at(T.proof.dur + 1.3);
    return r.end();
  },
};

const [, , which = 'all', langs = 'both'] = process.argv;
const L = langs === 'both' ? ['en', 'th'] : [langs];
const names = which === 'all' ? Object.keys(SHOTS) : which.split(',');
for (const n of names) for (const lang of L) {
  let m;
  try { m = await SHOTS[n](lang); }
  catch (e) { console.error(n, lang, 'FAILED', e.message); try { await CUR.page.screenshot({ path: OUT + `/${n}-${lang}-fail.png` }); await CUR.browser.close(); } catch {} continue; }
  console.log(n, lang, 'dur', m.duration.toFixed(1), 'fps', m.fpsAvg.toFixed(0), JSON.stringify(m.marks.filter(x => !x.name.startsWith('rect')).map(x => x.name + '@' + x.t.toFixed(2))));
}
