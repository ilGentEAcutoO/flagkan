// Screen recorder for the FlagKan demo: headed Chromium + CDP screencast (lossless-ish JPEG
// frames with timestamps) -> constant 30fps H.264. A fake cursor + click ripple is injected
// into the page so pointer motion is part of the real footage. Marks are logged to JSON so
// the HyperFrames composition can time punch-ins/callouts to real events.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const EXE = 'C:/Users/suanw/AppData/Local/ms-playwright/chromium-1246/chrome-win64/chrome.exe';
export const VW = 1440, VH = 810, DSF = 2;

const CURSOR_JS = `
(() => {
  if (window.__fkCursor) return; window.__fkCursor = 1;
  const css = '#__fkc{position:fixed;left:0;top:0;width:28px;height:28px;z-index:2147483647;pointer-events:none;transform:translate(-200px,-200px);transition:none}'+
    '#__fkc svg{position:relative;width:28px;height:28px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}'+
    '#__fkc::before{content:"";position:absolute;left:-15px;top:-16px;width:40px;height:40px;border-radius:50%;background:radial-gradient(rgba(242,178,51,.45),rgba(242,178,51,0) 70%)}'+
    '.__fkr{position:fixed;z-index:2147483646;pointer-events:none;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:3px solid #B7321F;animation:__fkr .55s ease-out forwards}'+
    '@keyframes __fkr{from{transform:scale(.4);opacity:.95}to{transform:scale(3.6);opacity:0}}';
  const add = () => {
    if (document.getElementById('__fkc')) return;
    const st = document.createElement('style'); st.textContent = css; document.documentElement.appendChild(st);
    const c = document.createElement('div'); c.id = '__fkc';
    c.innerHTML = '<svg viewBox="0 0 28 28"><path d="M5 3 L5 22 L10 17.5 L13.6 25 L17 23.4 L13.4 16 L20 16 Z" fill="#1d1a16" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    const p = window.__fkPos; if (p) c.style.transform = 'translate(' + (p[0]-4) + 'px,' + (p[1]-2) + 'px)';
  };
  addEventListener('mousemove', e => { window.__fkPos=[e.clientX,e.clientY]; const c=document.getElementById('__fkc'); if(c) c.style.transform='translate('+(e.clientX-4)+'px,'+(e.clientY-2)+'px)'; }, true);
  addEventListener('mousedown', e => { const r=document.createElement('div'); r.className='__fkr'; r.style.left=e.clientX+'px'; r.style.top=e.clientY+'px'; document.documentElement.appendChild(r); setTimeout(()=>r.remove(),700); }, true);
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', add); else add();
  // log WebSocket ticks so the edit can call out real-time pushes
  const WS = window.WebSocket; if (WS && !WS.__fk) {
    window.__fkTicks = [];
    const W = function(u, p){ const s = p ? new WS(u,p) : new WS(u);
      s.addEventListener('message', ev => { try { const m = JSON.parse(ev.data); window.__fkTicks.push({t:Date.now(), type:m.type, n:(m.rounds||[]).length}); if (window.__fkTick) window.__fkTick(m.type,(m.rounds||[]).length); } catch(e){} });
      return s; };
    W.prototype = WS.prototype; Object.assign(W, {CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3}); W.__fk = 1; window.WebSocket = W;
  }
})();`;

export async function start(name, outDir, { lang = 'en', storage } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: !process.env.HEADED, executablePath: EXE,
    args: [`--window-size=${VW + 20},${VH + 140}`, '--hide-scrollbars', '--force-device-scale-factor=' + DSF] });
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: DSF, locale: lang === 'th' ? 'th-TH' : 'en-US' });
  await ctx.addInitScript(CURSOR_JS);
  if (storage) await ctx.addInitScript(storage);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const frames = []; const marks = []; let t0 = null; let rec = false;
  cdp.on('Page.screencastFrame', async f => {
    try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch {}
    if (!rec) return;
    const ts = f.metadata.timestamp * 1000;
    if (t0 === null) t0 = ts;
    frames.push({ t: ts, data: f.data });
    if (r.keepSec && frames.length % 30 === 0) { const cut = ts - r.keepSec * 1000; let k = 0; while (k < frames.length && frames[k].t < cut) k++; if (k) frames.splice(0, k); }
  });
  await page.exposeFunction('__fkTick', (type, n) => { if (rec && t0 !== null && (type === 'tick' || type === 'arrive')) marks.push({ name: type, n, t: (Date.now() - r._wall0) / 1000 }); });
  const r = {
    page, ctx, browser, marks,
    pos: [VW / 2, VH / 2],
    async begin() {
      rec = true; t0 = null;
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: VW * DSF, maxHeight: VH * DSF, everyNthFrame: 1 });
      // keep frames flowing even on a still page: a 1px invisible ticker forces compositor frames
      await page.evaluate(() => { if (!document.getElementById('__fkt')) { const d = document.createElement('div'); d.id='__fkt'; d.style.cssText='position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:.01;z-index:2147483647;pointer-events:none'; document.documentElement.appendChild(d); let k=0; (function L(){ d.style.background = (k++%2)?'#000':'#111'; requestAnimationFrame(L); })(); } });
      await page.waitForTimeout(300);
      t0 = Date.now(); // wall-clock base for marks; frame base fixed below
      frames.length = 0; this._wall0 = t0;
    },
    async rect(nm, sel) {
      const b = await page.evaluate(sel => { const els = [...document.querySelectorAll(sel)].filter(e => e.offsetParent || e.getClientRects().length); if (!els.length) return null;
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const e of els) { const r = e.getBoundingClientRect(); x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom); }
        return [x0, y0, x1 - x0, y1 - y0].map(v => Math.round(v)); }, sel);
      this.mark('rect:' + nm, { rect: b }); return b;
    },
    mark(nm, extra = {}) { marks.push({ name: nm, t: (Date.now() - this._wall0) / 1000, ...extra }); },
    async wait(ms) { await page.waitForTimeout(ms); },
    async move(x, y, ms = 700) {
      const [x0, y0] = this.pos; const t0 = Date.now();
      for (;;) {
        const k = Math.min(1, (Date.now() - t0) / ms); const e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        await page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e);
        if (k >= 1) break;
        await page.waitForTimeout(12);
      }
      this.pos = [x, y];
    },
    async moveTo(sel, ms = 700, dx = 0.5, dy = 0.5) {
      const b = await page.locator(sel).first().boundingBox();
      if (!b) throw new Error('no box ' + sel);
      await this.move(b.x + b.width * dx, b.y + b.height * dy, ms); return b;
    },
    async click(sel, ms = 700, name, dx = 0.5, dy = 0.5) {
      await this.moveTo(sel, ms, dx, dy); await page.waitForTimeout(120);
      if (name) this.mark(name);
      await page.mouse.click(this.pos[0], this.pos[1]);
    },
    async smoothScroll(dy, ms = 1200, sel) {
      await page.evaluate(([dy, ms, sel]) => new Promise(res => {
        const el = sel ? document.querySelector(sel) : document.scrollingElement;
        const s = el.scrollTop, t0 = performance.now();
        (function L(t) { const k = Math.min(1, (t - t0) / ms); const e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
          el.scrollTop = s + dy * e; if (k < 1) requestAnimationFrame(L); else res(); })(t0);
      }), [dy, ms, sel]);
    },
    async end() {
      await cdp.send('Page.stopScreencast'); rec = false;
      await page.waitForTimeout(200);
      // marks are wall-clock relative to begin(); frames use screencast timestamps. Align by first frame.
      const base = frames.length ? frames[0].t : 0;
      const shift = (this._wall0 - base) / 1000; // marks are wall-clock from begin(); re-base on the first kept frame
      for (const m of marks) { m.t = m.t + shift; if (m.origin !== undefined) m.origin = m.origin + shift; }
      const dir = path.join(outDir, name + '-frames'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
      let list = '';
      for (let i = 0; i < frames.length; i++) {
        const fn = `f${String(i).padStart(5, '0')}.jpg`;
        fs.writeFileSync(path.join(dir, fn), Buffer.from(frames[i].data, 'base64'));
        const d = i + 1 < frames.length ? (frames[i + 1].t - frames[i].t) / 1000 : 1 / 30;
        list += `file '${fn}'\nduration ${Math.max(0.001, d).toFixed(4)}\n`;
      }
      list += `file 'f${String(frames.length - 1).padStart(5, '0')}.jpg'\n`;
      fs.writeFileSync(path.join(dir, 'list.txt'), list);
      const dur = frames.length ? (frames.at(-1).t - base) / 1000 : 0;
      const mp4 = path.join(outDir, name + '.mp4');
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'),
        '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-movflags', '+faststart', mp4]);
      const meta = { name, frames: frames.length, duration: dur, fpsAvg: frames.length / Math.max(dur, 0.001),
        width: VW * DSF, height: VH * DSF, viewport: [VW, VH], marks, wallStart: this._wall0, frameStart: base };
      fs.writeFileSync(path.join(outDir, name + '.json'), JSON.stringify(meta, null, 2));
      fs.rmSync(dir, { recursive: true, force: true });
      await browser.close();
      return meta;
    },
  };
  return r;
}
