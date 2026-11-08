// 저고도 SIGWX 전체 흐름: 서버(실제 XML 모양) → 화면 판정. 착빙 구역(동해, FL060 이상)을 지나는 경로 vs 지나지 않는 경로
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node22/lib/node_modules/playwright'); }
const PORT = 8021, ROOT = new URL('../../', import.meta.url).pathname;
const srv = spawn('python3', ['run.py', '--mock', '--port', String(PORT), '--no-browser'], { cwd: ROOT });
const fail = (m) => { console.error('FAIL:', m); srv.kill(); process.exit(1); };
for (let i = 0; i < 40; i++) { try { await fetch(`http://localhost:${PORT}/api/client-config`); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
const items = (await (await fetch(`http://localhost:${PORT}/api/sigwx`)).json()).items;
if (!items.length || !items.some((x) => x.kind === 'ICE' && x.points.length >= 3)) fail('서버가 SIGWX XML을 해석하지 못함');
const browser = await pw.chromium.launch(); const page = await browser.newPage();
await page.route(/dapi\.kakao\.com/, (r) => r.abort());
await page.goto(`http://localhost:${PORT}/`);
await page.waitForSelector('#map-off:not([hidden])', { timeout: 10000 });
const run = async (a, b) => {
  await page.fill('#pt-from-coord', a); await page.dispatchEvent('#pt-from-coord', 'change');
  await page.fill('#pt-to-coord', b); await page.dispatchEvent('#pt-to-coord', 'change');
  await page.click('#run'); await page.waitForFunction(() => /판단 완료/.test(document.querySelector('#run-msg').textContent), null, { timeout: 10000 });
  return page.evaluate(() => { const r = [...document.querySelectorAll('#rows tr')].find((x) => x.textContent.includes('저고도 중요기상')); return r ? { cls: r.className, text: r.textContent.replace(/\s+/g, ' ') } : null; });
};
await page.fill('#pt-from-name', 'A'); await page.fill('#pt-to-name', 'B');
const hit = await run('37.55, 129.0', '38.5, 133.0');
if (!hit || hit.cls !== 'YELLOW' || !/착빙/.test(hit.text) || !/FL060 이상/.test(hit.text)) fail('착빙 구역 통과 경로가 주의로 나오지 않음: ' + JSON.stringify(hit));
if (!/0℃ 고도선 5000ft·10000ft/.test(hit.text)) fail('0℃ 고도선 안내 없음: ' + hit.text);
const miss = await run('37.5583, 126.7906', '37.5547, 126.9707');
if (!miss || miss.cls !== 'GREEN' || !/경로 해당 없음/.test(miss.text)) fail('구역을 지나지 않는 경로가 가능으로 나오지 않음: ' + JSON.stringify(miss));
console.log('PASS sigwx'); await browser.close(); srv.kill();
