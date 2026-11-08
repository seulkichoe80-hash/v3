// 낡은 화면 감지: 열어 둔 페이지의 버전과 서버 버전이 달라지면 [판단 실행] 때 새로고침 안내가 뜬다
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node22/lib/node_modules/playwright'); }
const PORT = 8022, ROOT = new URL('../../', import.meta.url).pathname;
const srv = spawn('python3', ['run.py', '--mock', '--port', String(PORT), '--no-browser'], { cwd: ROOT });
const fail = (m) => { console.error('FAIL:', m); srv.kill(); process.exit(1); };
for (let i = 0; i < 40; i++) { try { await fetch(`http://localhost:${PORT}/api/client-config`); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
const browser = await pw.chromium.launch(); const page = await browser.newPage();
await page.route(/dapi\.kakao\.com/, (r) => r.abort());
let n = 0;
await page.route('**/api/client-config', async (route) => { const r = await route.fetch(); const j = await r.json(); j.version = (++n === 1) ? 'aaaaaaa' : 'bbbbbbb'; route.fulfill({ json: j }); });
await page.goto(`http://localhost:${PORT}/`);
await page.waitForSelector('#map-off:not([hidden])', { timeout: 10000 });
if (!/aaaaaaa/.test(await page.textContent('#ver'))) fail('푸터에 버전 표시 없음: ' + await page.textContent('#ver'));
if (await page.isVisible('#stale-banner')) fail('버전이 같을 때는 안내띠가 보이면 안 됨');
await page.fill('#pt-from-coord', '37.5583, 126.7906'); await page.dispatchEvent('#pt-from-coord', 'change');
await page.fill('#pt-to-coord', '37.5547, 126.9707'); await page.dispatchEvent('#pt-to-coord', 'change');
await page.click('#run'); await page.waitForFunction(() => /판단 완료/.test(document.querySelector('#run-msg').textContent), null, { timeout: 10000 });
await page.waitForSelector('#stale-banner:not([hidden])', { timeout: 5000 }).catch(() => fail('서버 버전이 바뀌었는데 새로고침 안내가 안 뜸'));
if (!/새로고침/.test(await page.textContent('#stale-banner'))) fail('안내 문구 이상');
console.log('PASS stale'); await browser.close(); srv.kill();
