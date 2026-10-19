import { chromium } from 'playwright';
const out = process.argv[2];
const b = await chromium.launch({ headless: false, executablePath: 'C:/Users/suanw/AppData/Local/ms-playwright/chromium-1246/chrome-win64/chrome.exe' });
const c = await b.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1 });
const p = await c.newPage();
for (const [n,u] of [['index','/'],['board','/board.html'],['proof','/proof'],['about','/about.html']]) {
  await p.goto('https://flag.sornkan.com'+u, { waitUntil: 'networkidle' }).catch(()=>{});
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${out}/${n}.png`, fullPage: true });
}
await p.goto('https://flag.sornkan.com/board.html', { waitUntil: 'networkidle' });
await p.waitForTimeout(2000);
await p.locator('#rows tr').first().click().catch(e=>console.log('click fail',e.message));
await p.waitForTimeout(3000);
await p.screenshot({ path: `${out}/modal.png` });
const h = await p.evaluate(()=>document.querySelector('#modal')?.scrollHeight);
console.log('modal h', h);
await b.close();