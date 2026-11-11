// NOTAM 구역: 지도에 빨간 원(반경)과 좌표·반경 라벨, 목록에 좌표·반경 줄이 나온다
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node22/lib/node_modules/playwright'); }
const PORT = 8024, ROOT = new URL('../../', import.meta.url).pathname;
const srv = spawn('python3', ['run.py', '--mock', '--port', String(PORT), '--no-browser'], { cwd: ROOT, env: { ...process.env, HELIWX_NOTAM_FILE: `/tmp/nm-e2e-${Date.now()}.json` } });
const fail = (m) => { console.error('FAIL:', m); srv.kill(); process.exit(1); };
for (let i = 0; i < 40; i++) { try { await fetch(`http://localhost:${PORT}/api/client-config`); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
const browser = await pw.chromium.launch(); const page = await browser.newPage();
await page.route('**/api/client-config', async (route) => { const r = await route.fetch(); const j = await r.json(); j.kakaoJsKey = 'TESTKEY'; route.fulfill({ json: j }); });
await page.route(/dapi\.kakao\.com\/v2\/maps\/sdk\.js/, (r) => r.fulfill({ contentType: 'text/javascript', body: readFileSync(ROOT + 'tests/e2e/kakao_stub.js', 'utf8') }));
await page.goto(`http://localhost:${PORT}/`);
await page.waitForTimeout(800);
// 저장된 NOTAM이 있는 채로 새로고침해도(경로 없음) 지도는 대한민국 전체 시점이어야 하고 NOTAM 한 곳으로 확대되면 안 된다
await page.click('#sheet-tab-3'); if (!(await page.isVisible('#notam-1'))) await page.click('#notam-1-sum');
await page.fill('#notam-1', readFileSync(ROOT + 'tests/fixtures/notam_d2840.txt', 'utf8')); await page.click('#notam-1-save');
await page.waitForFunction(() => /저장됨/.test(document.querySelector('#notam-1-status').textContent), null, { timeout: 5000 });
await page.reload(); await page.waitForTimeout(900);
const sb = await page.evaluate(() => window.__sb || []);
if (sb.length !== 1) fail('새로고침 직후 지도 시점 설정이 1번이어야 함: ' + sb.length);
if (!(sb[0].some((p) => p[0] <= 33.1) && sb[0].some((p) => p[0] >= 38.5) && sb[0].some((p) => p[1] >= 131))) fail('처음 시점이 대한민국 전체가 아님: ' + JSON.stringify(sb[0]));
const circ = await page.evaluate(() => window.__kk.filter((x) => x.name === 'Circle').length);
if (circ < 1) fail('저장된 NOTAM이 지도에 표시되지 않음');
await page.click('#sheet-tab-1');
await page.fill('#pt-from-q', '아주대'); await page.dispatchEvent('#pt-from-q', 'input');
await page.waitForFunction(() => /아주대학교병원/.test(document.querySelector('#pt-from-results').textContent), null, { timeout: 5000 });
await page.press('#pt-from-q', 'Enter');
await page.fill('#pt-to-q', '정부대전'); await page.dispatchEvent('#pt-to-q', 'input');
await page.waitForFunction(() => /정부대전청사/.test(document.querySelector('#pt-to-results').textContent), null, { timeout: 5000 });
await page.click('#pt-to-results li:has-text("정부대전청사")');
await page.click('#sheet-tab-3');
if (!(await page.isVisible('#notam-1'))) await page.click('#notam-1-sum');
await page.fill('#notam-1', readFileSync(ROOT + 'tests/fixtures/notam_d2840.txt', 'utf8'));
// ① 판단 실행 전에도 NOTAM이 지도에 그려진다(빨간 원+라벨)
await page.waitForTimeout(600);
let pre = await page.evaluate(() => window.__kk.map((x) => ({ name: x.name, c: x.o.strokeColor, html: x.o.content })));
if (!pre.some((x) => x.name === 'Circle' && x.c === '#d6201a')) fail('판단 실행 전에 NOTAM 원이 안 그려짐');
if (!pre.some((x) => /nt-label/.test(x.html || '') && /D2840\/26/.test(x.html))) fail('판단 실행 전 NOTAM 라벨 없음');
// 비행금지·제한구역(R-75·P-73·P-518W·P-518·P-518E)도 판단 실행 전에 항상 그려진다
const polys = await page.evaluate(() => window.__kk.filter((x) => x.name === 'Polygon' && (x.o.strokeColor === '#8e24aa' || x.o.strokeColor === '#e67e00')).length);
if (polys < 5) fail('비행금지구역 다각형이 그려지지 않음: ' + polys);
if (pre.some((x) => /area-label/.test(x.html || ''))) fail('비행금지·제한구역 글자는 지도에 상시 표시하지 않아야 함');
// ② 판단 실행 전에는 지도 클릭으로 지점이 바뀐다
const clickMap = (la = 35.1, lo = 129.0) => page.evaluate(([a, b]) => window.__kl.click({ latLng: { getLat: () => a, getLng: () => b } }), [la, lo]);
const toLoc = () => page.textContent('#pt-to-loc');
const before = await toLoc(); await clickMap(); await page.waitForTimeout(200);
if ((await toLoc()) === before) fail('판단 실행 전에는 지도 클릭으로 목적지가 바뀌어야 함');
await page.click('#run'); await page.waitForSelector('#overall[data-grade]', { timeout: 15000 });
const rec = await page.evaluate(() => window.__kk.map((x) => ({ name: x.name, c: x.o.strokeColor, r: x.o.radius, html: x.o.content })));
const circle = rec.find((x) => x.name === 'Circle' && x.c === '#d6201a');
if (!circle || !(circle.r > 0)) fail('빨간 NOTAM 원이 안 그려짐: ' + JSON.stringify(rec.filter((x) => x.name === 'Circle')));
const label = rec.find((x) => x.name === 'CustomOverlay' && /nt-label/.test(x.html || ''));
if (!label || !/\d+\/\d+ \d\d:\d\d ~ .*KST/.test(label.html)) fail('라벨에 유효시간이 없음: ' + (label && label.html));
if (!label || !/D2840\/26/.test(label.html) || !/반경 [\d.]+NM/.test(label.html) || !/\d/.test(label.html.split('<br>')[1] || '')) fail('좌표·반경 라벨 이상: ' + (label && label.html));
if (!/📍/.test(await page.textContent('#notam-list')) || !/반경 [\d.]+NM/.test(await page.textContent('#notam-list'))) fail('목록에 좌표·반경 줄 없음');
// ③ 판단 실행 후에는 지도를 눌러도 출발·목적지가 바뀌지 않는다
if (await page.isChecked('#map-click-on')) fail('판단 실행 후 지도 클릭 지정이 꺼져 있어야 함');
const locked = await toLoc(); await clickMap(); await page.waitForTimeout(200);
if ((await toLoc()) !== locked) fail('판단 실행 후에도 지도 클릭으로 목적지가 바뀜');
await page.click('#sheet-tab-1'); await page.check('#map-click-on'); await clickMap(36.2, 128.3); await page.waitForTimeout(200);
if ((await toLoc()) === locked) fail('잠금을 해제하면 다시 지도 클릭으로 바뀌어야 함');
// 잠금 상태에서 지도를 누르면 지점은 안 바뀌고 누른 곳의 좌표 카드가 뜬다
await page.uncheck('#map-click-on'); const keep = await toLoc(); await clickMap(35.5, 128.5); await page.waitForTimeout(300);
if ((await toLoc()) !== keep) fail('잠금 상태에서 지점이 바뀜');
if (!(await page.isVisible('#ms-card')) || !/35\.500000, 128\.500000/.test(await page.textContent('#ms-dec'))) fail('잠금 상태 지도 클릭에 좌표 카드가 안 뜸: ' + await page.textContent('#ms-dec'));
console.log('PASS notammap'); await browser.close(); srv.kill();
