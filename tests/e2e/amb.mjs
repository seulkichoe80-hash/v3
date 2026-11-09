// 구급차 이동시간(현장→병원): 경유지가 없으면 입력 안내, 경유지 1이 있으면 자동, 칸에 좌표를 넣으면 그 값을 사용
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node22/lib/node_modules/playwright'); }
const PORT = 8025, ROOT = new URL('../../', import.meta.url).pathname;
const srv = spawn('python3', ['run.py', '--mock', '--port', String(PORT), '--no-browser'], { cwd: ROOT, env: { ...process.env, HELIWX_NOTAM_FILE: `/tmp/amb-e2e-${Date.now()}.json` } });
const fail = (m) => { console.error('FAIL:', m); srv.kill(); process.exit(1); };
for (let i = 0; i < 40; i++) { try { await fetch(`http://localhost:${PORT}/api/client-config`); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
const browser = await pw.chromium.launch(); const page = await browser.newPage();
await page.route(/dapi\.kakao\.com/, (r) => r.abort());
await page.goto(`http://localhost:${PORT}/`); await page.waitForSelector('#map-off:not([hidden])');
const run = async () => { await page.click('#run'); await page.waitForFunction(() => /판단 완료/.test(document.querySelector('#run-msg').textContent), null, { timeout: 15000 }); await page.waitForTimeout(150); };
const setPt = async (id, v) => { await page.fill(id, v); await page.dispatchEvent(id, 'change'); };
await setPt('#pt-from-coord', '35.2300, 128.6800'); await setPt('#pt-to-coord', '37.5100, 127.1000');
await run();
if (!/입력|추가/.test(await page.textContent('#transport .verdict'))) fail('경유지·입력이 없을 때 안내가 없음: ' + await page.textContent('#transport'));
if (!/헬기/.test(await page.textContent('#transport'))) fail('헬기 카드 없음');
await page.click('#add-via'); await setPt('#pt-via1-coord', '36.4000, 127.3000');
if (!/자동/.test(await page.textContent('#amb-loc'))) fail('경유지 1→목적지 자동 표시 없음: ' + await page.textContent('#amb-loc'));
await run();
let t = await page.textContent('#transport');
if (!/구급차\s*\d+분/.test(t) || !/직선거리 기반 추정/.test(t)) fail('경유지 자동 사용 시 구급차 시간 없음: ' + t.slice(0, 250));
if (!/항공대 → 현장 → 병원/.test(t)) fail('헬기 경로 표기 없음');
const first = t.match(/구급차\s*(\d+)분/)[1];
await page.fill('#amb-from-q', '37.0000, 127.2000'); await page.press('#amb-from-q', 'Enter');
if (/자동/.test((await page.textContent('#amb-loc')).split('→')[0])) fail('직접 입력한 현장이 반영되지 않음');
await run();
t = await page.textContent('#transport');
if (t.match(/구급차\s*(\d+)분/)[1] === first) fail('직접 입력한 현장으로 시간이 바뀌지 않음');
if (!/출동수단 비교/.test(await page.inputValue('#report-text'))) fail('보고문에 비교 없음');
console.log('PASS amb'); await browser.close(); srv.kill();
