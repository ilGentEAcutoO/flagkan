import { start } from './rec.mjs';
const r = await start('dbg', 'C:/Users/suanw/projects/hack/agent-temp/demo-cap', { lang:'en' });
try {
await r.page.goto('https://flag.sornkan.com/board.html', { waitUntil: 'networkidle' });
await r.page.waitForTimeout(1500);
await r.page.fill('#q', '8rtCBqHfRmZK1KkULkMUY1355CLNxRaCvuU3FFoHEADS'); await r.page.waitForTimeout(800);
await r.begin();
await r.click('#rows tr:nth-child(1) td:nth-child(2)', 900, 'open');
await r.wait(1500);
console.log(await r.page.evaluate(()=>document.getElementById('modal').className));
await r.page.screenshot({path:'C:/Users/suanw/projects/hack/agent-temp/demo-cap/dbg.png'});
} finally { await r.browser.close(); }
