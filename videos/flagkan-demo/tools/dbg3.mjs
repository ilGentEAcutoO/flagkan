import { chromium } from 'playwright';
import { EXE } from './rec.mjs';
const b = await chromium.launch({ headless: true, executablePath: EXE });
const p = await (await b.newContext({ viewport: { width: 1440, height: 810 } })).newPage();
await p.goto('https://flag.sornkan.com/board.html', { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 6; i++) { await p.waitForTimeout(1500); console.log(await p.evaluate(() => [location.href, document.getElementById('liveSt')?.className, document.getElementById('liveSt')?.hidden, document.getElementById('liveStT')?.textContent, !!document.getElementById('rows'), document.querySelectorAll('#rows tr').length].join(' | '))); }
await b.close();
