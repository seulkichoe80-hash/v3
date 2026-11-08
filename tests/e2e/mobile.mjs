// 폰 화면(390px) 점검: 근거 표·구간표가 가로로 잘리지 않고, 판정 글자가 화면 안에 있는지
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node22/lib/node_modules/playwright'); }
const PORT = 8018, ROOT = new URL('../../', import.meta.url).pathname;
const srv = spawn('python3', ['run.py', '--mock', '--port', String(PORT), '--no-browser'], { cwd: ROOT });
const fail = (m) => { console.error('FAIL:', m); srv.kill(); process.exit(1); };
for (let i = 0; i < 40; i++) { try { await fetch(`http://localhost:${PORT}/api/client-config`); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
await page.route(/dapi\.kakao\.com/, (r) => r.abort());
await page.goto(`http://localhost:${PORT}/`);
await page.waitForSelector('#map-off:not([hidden])', { timeout: 10000 });
await page.fill('#pt-from-name', '김포'); await page.fill('#pt-from-coord', '37.5583, 126.7906'); await page.dispatchEvent('#pt-from-coord', 'change');
await page.click('#add-via');
await page.fill('#pt-via1-name', '경유A'); await page.fill('#pt-via1-coord', '37.62, 126.88'); await page.dispatchEvent('#pt-via1-coord', 'change');
await page.fill('#pt-to-name', '서울역'); await page.fill('#pt-to-coord', '37.5547, 126.9707'); await page.dispatchEvent('#pt-to-coord', 'change');
await page.click('#run'); await page.waitForSelector('#overall[data-grade]', { timeout: 10000 });
const bad = await page.evaluate(() => {
  const W = window.innerWidth, out = [];
  for (const e of document.querySelectorAll('#rows *, #legs *')) { const r = e.getBoundingClientRect(); if (r.width > 0 && r.right > W + 1) out.push(e.tagName + ' right=' + Math.round(r.right)); }
  return out.slice(0, 5);
});
if (bad.length) fail('폰 화면 밖으로 넘치는 요소: ' + bad.join(', '));
// 판정 배지가 보여야 함
const badge = await page.evaluate(() => { const e = document.querySelector('#rows .badge'); const r = e.getBoundingClientRect(); return { right: r.right, w: window.innerWidth, text: e.textContent }; });
if (badge.right > badge.w) fail('판정 배지가 잘림: ' + JSON.stringify(badge));
if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) fail('페이지 가로 스크롤 발생');
console.log('PASS mobile');
await browser.close(); srv.kill();
