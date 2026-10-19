// Snapshot /api/proof at capture time -> live.json (as-of stamps + terminal lines for the API scene).
import fs from 'node:fs';

const r = await fetch('https://flag.sornkan.com/api/proof');
const d = await r.json();
const now = new Date();
const pad = n => String(n).padStart(2, '0');
const utc = `${now.getUTCDate()} Oct ${now.getUTCFullYear()}, ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())} UTC`;
const th = new Date(now.getTime() + 7 * 3600e3);
const thS = `${th.getUTCDate()} ต.ค. ${th.getUTCFullYear() + 543} ${pad(th.getUTCHours())}:${pad(th.getUTCMinutes())} น.`;

// terminal: two real jq queries against the same payload
const h = d.headline || {};
const hpick = {}; for (const k of ['n', 'base_dead_rate', 'accuracy', 'baseline_all_red_accuracy']) hpick[k] = h[k];
const t10 = (d.ranking?.first_sight?.top || []).find(x => x.frac === 0.1) || {};
const term = [
  { cmd: `curl -s flag.sornkan.com/api/proof | jq -c '.headline | {n, base_dead_rate, accuracy, baseline_all_red_accuracy}'`, out: [JSON.stringify(hpick).replace(/,"/g, ',"')] },
  { cmd: `curl -s flag.sornkan.com/api/proof | jq '.ranking.first_sight.top[] | select(.frac == 0.1)'`, out: JSON.stringify(t10, null, 2).split('\n') },
];
const lines = term.flatMap(x => x.out);
const highlight = [];
const top10 = (d.ranking?.first_sight?.top || []).find(x => x.frac === 0.1);
const lift = top10 ? top10.lift.toFixed(1) : null;
const digitTh = { '0': 'ศูนย์', '1': 'หนึ่ง', '2': 'สอง', '3': 'สาม', '4': 'สี่', '5': 'ห้า', '6': 'หก', '7': 'เจ็ด', '8': 'แปด', '9': 'เก้า' };
const liftTh = lift ? lift.split('.').map((p, i) => i === 0 ? digitTh[p] || p : 'จุด' + [...p].map(c => digitTh[c]).join('')).join('') : null;
// numbers exactly as the Criteria page shows them right now
const { chromium } = await import('playwright');
const { EXE } = await import('./rec.mjs');
const br = await chromium.launch({ headless: true, executablePath: EXE });
const pg = await br.newPage();
await pg.goto('https://flag.sornkan.com/proof#summary', { waitUntil: 'networkidle' });
await pg.waitForFunction(() => { const v = document.querySelector('#story .step:nth-of-type(3) .sv'); return v && /\d/.test(v.textContent); }, null, { timeout: 20000 });
const dom = await pg.evaluate(() => [...document.querySelectorAll('#story .step')].map(st => ({ sv: st.querySelector('.sv')?.textContent.trim(), sd: st.querySelector('.sd')?.textContent.trim(), sn: st.querySelector('.sn')?.textContent.trim() })));
await br.close();
const num = t => (t || '').replace(/[^\d.]/g, '');
const pLift = num(dom[2].sv);
const survM = (dom[2].sn || '').match(/(\d[\d,]*) surviv/);
const liftThP = pLift.split('.').map((q, i) => i === 0 ? [...q].map(c => digitTh[c]).join('') : 'จุด' + [...q].map(c => digitTh[c]).join('')).join('');
const tokens = { BASE: num(dom[0].sv), ACC: num(dom[1].sv), LIFT: pLift, LIFT_TH: liftThP, LIFTR: String(Math.round(Number(pLift))), SURV: survM ? survM[1] : '?' };
console.log('DOM', JSON.stringify(dom));
// demo coin: newest-first page, prefer yellow/green with holder data, else a red with a clear whale
const rr = await (await fetch('https://flag.sornkan.com/api/rounds?limit=12')).json();
const rows = rr.rounds || [];
const score = x => (x.choice === 'yellow' ? 3 : x.choice === 'green' ? 2.5 : 1) + (x.top1 != null ? 1 : 0) + (x.name && x.name.length <= 10 ? 0.5 : 0);
const coin = rows.slice(2, 12).sort((a, b) => score(b) - score(a))[0] || rows[0];
const out = { coin: coin && { mint: coin.mint, name: coin.name, choice: coin.choice }, tokens, term, fetchedAt: now.toISOString(), asofEn: utc, asofTh: thS, apiLines: lines, apiHighlight: highlight, headline: h, ranking: d.ranking, challenger: d.challenger };
fs.writeFileSync(new URL('./live.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(utc, '|', thS, '| coin', out.coin && out.coin.name, out.coin && out.coin.choice); console.log(lines.join('\n'));
