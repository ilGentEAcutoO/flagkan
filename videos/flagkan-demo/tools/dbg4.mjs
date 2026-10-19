import { start } from './rec.mjs';
const r = await start('dbg', 'C:/Users/suanw/projects/hack/agent-temp/demo-cap', { lang: 'en', storage: "try{localStorage.setItem('flagkan_lang','en')}catch(e){}" });
r.page.on('pageerror', e => console.log('pageerror', e.message));
const t0 = Date.now();
await r.page.goto('https://flag.sornkan.com/board.html', { waitUntil: 'networkidle' }).catch(e => console.log('goto', e.message.slice(0, 80)));
console.log('goto took', Date.now() - t0);
for (let i = 0; i < 4; i++) { await r.page.waitForTimeout(1500); console.log(await r.page.evaluate(() => [location.href, document.getElementById('liveSt')?.className, !!document.getElementById('rows')].join(' | '))); }
await r.browser.close();
