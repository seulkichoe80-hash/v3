// 공용 누적 사용량: [판단 실행]마다 누적 건수가 1씩 늘고 상단 배지·패널에 표시된다
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node22/lib/node_modules/playwright'); }
const PORT = 8023, ROOT = new URL('../../', import.meta.url).pathname;
const env = { ...process.env, HELIWX_NOTAM_FILE: `/tmp/usage-e2e-${Date.now()}.json` };
const srv = spawn('python3', ['run.py', '--mock', '--port', String(PORT), '--no-browser'], { cwd: ROOT, env });
const fail = (m) => { console.error('FAIL:', m); srv.kill(); process.exit(1); };
for (let i = 0; i < 40; i++) { try { await fetch(`http://localhost:${PORT}/api/client-config`); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
const browser = await pw.chromium.launch(); const page = await browser.newPage();
await page.route(/dapi\.kakao\.com/, (r) => r.abort());
await page.goto(`http://localhost:${PORT}/`);
await page.waitForSelector('#usage-chip:not([hidden])', { timeout: 10000 }).catch(() => fail('누적 배지가 안 보임'));
if (await page.textContent('#usage-total') !== '0') fail('초기 누적은 0이어야 함');
await page.fill('#pt-from-coord', '37.5583, 126.7906'); await page.dispatchEvent('#pt-from-coord', 'change');
await page.fill('#pt-to-coord', '37.5547, 126.9707'); await page.dispatchEvent('#pt-to-coord', 'change');
for (let k = 1; k <= 2; k++) {
  if (k > 1) await page.waitForTimeout(1100);   // 같은 출발·목적지·초는 한 건으로 합쳐지므로 간격을 둠
  await page.click('#run'); await page.waitForFunction((n) => document.querySelector('#usage-total').textContent === String(n), k, { timeout: 10000 }).catch(() => fail(`${k}번째 실행 뒤 누적이 ${k}이 아님`));
}
if (!/오늘 2건/.test(await page.textContent('#usage-sub'))) fail('오늘 건수 표시 이상: ' + await page.textContent('#usage-sub'));
const csv = await (await fetch(`http://localhost:${PORT}/api/usage?format=csv`)).text();
if (csv.trim().split('\n').length !== 3) fail('CSV 행 수 이상');
console.log('PASS usage'); await browser.close(); srv.kill();
