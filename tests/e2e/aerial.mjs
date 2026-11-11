// 항공사진(브이월드) 보기: 인증키가 있을 때만 버튼이 보이고, 눌러도 경로·NOTAM·비행금지구역이 같은 좌표로 그려지며 타일 주소가 올바르다
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node22/lib/node_modules/playwright'); }
const PORT = 8028, ROOT = new URL('../../', import.meta.url).pathname;
const srv = spawn('python3', ['run.py', '--mock', '--port', String(PORT), '--no-browser'], { cwd: ROOT, env: { ...process.env, VWORLD_KEY: 'TESTKEY', HELIWX_NOTAM_FILE: `/tmp/aer-${Date.now()}.json` } });
const fail = (m) => { console.error('FAIL:', m); srv.kill(); process.exit(1); };
for (let i = 0; i < 40; i++) { try { await fetch(`http://localhost:${PORT}/api/client-config`); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
const cc = await (await fetch(`http://localhost:${PORT}/api/client-config`)).json();
if (cc.vworldKey !== 'TESTKEY') fail('client-config에 브이월드 키가 없음');
const browser = await pw.chromium.launch(); const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
const tiles = [];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
await page.route(/api\.vworld\.kr/, (r) => { tiles.push(r.request().url()); r.fulfill({ contentType: 'image/png', body: PNG }); });
await page.route('**/api/client-config', async (route) => { const r = await route.fetch(); const j = await r.json(); j.kakaoJsKey = 'TESTKEY'; route.fulfill({ json: j }); });
await page.route(/dapi\.kakao\.com\/v2\/maps\/sdk\.js/, (r) => r.fulfill({ contentType: 'text/javascript', body: readFileSync(ROOT + 'tests/e2e/kakao_stub.js', 'utf8') }));
await page.goto(`http://localhost:${PORT}/`); await page.waitForTimeout(800);
if (!(await page.isVisible('#mt-aerial')) || !(await page.isVisible('#mt-road'))) fail('키가 있는데 [일반]/[항공사진] 버튼이 안 보임');
if (await page.locator('#mt-sky').count()) fail('위성 버튼은 삭제되어야 함');
if (await page.isVisible('#mt-labels')) fail('지명 버튼은 항공사진을 켠 뒤에만 보임');
// 경로·NOTAM 준비
await page.fill('#pt-from-q', '아주대'); await page.dispatchEvent('#pt-from-q', 'input');
await page.waitForFunction(() => /아주대학교병원/.test(document.querySelector('#pt-from-results').textContent), null, { timeout: 5000 }); await page.press('#pt-from-q', 'Enter');
await page.fill('#pt-to-q', '정부대전'); await page.dispatchEvent('#pt-to-q', 'input');
await page.waitForFunction(() => /정부대전청사/.test(document.querySelector('#pt-to-results').textContent), null, { timeout: 5000 }); await page.click('#pt-to-results li:has-text("정부대전청사")');
await page.click('#sheet-tab-3'); if (!(await page.isVisible('#notam-1'))) await page.click('#notam-1-sum');
await page.fill('#notam-1', readFileSync(ROOT + 'tests/fixtures/notam_d2840.txt', 'utf8')); await page.click('#sheet-tab-1');
await page.click('#mt-aerial');
await page.waitForSelector('#map2:not([hidden])', { timeout: 8000 }).catch(() => fail('항공사진 지도가 열리지 않음'));
if ((await page.evaluate(() => getComputedStyle(document.querySelector('#map')).visibility)) !== 'hidden') fail('항공사진 모드에서 카카오 지도가 가려져야 함');
await page.waitForTimeout(800);
if (!tiles.some((u) => /\/TESTKEY\/Satellite\/\d+\/\d+\/\d+\.jpeg/.test(u))) fail('위성 타일 주소가 이상함: ' + tiles.slice(0, 2));
if (!tiles.some((u) => /\/TESTKEY\/Hybrid\/\d+\/\d+\/\d+\.png/.test(u))) fail('지명 타일 요청이 없음');
// 타일 주소의 {z}/{y}/{x} 순서 확인: 같은 z에서 y(행)가 x(열)와 바뀌지 않았는지(한반도는 x≈ 2^z*0.85, y ≈ 2^z*0.39)
const t = tiles.find((u) => /Satellite\/(\d+)\/(\d+)\/(\d+)\.jpeg/.test(u)); const [, z, y, x] = t.match(/Satellite\/(\d+)\/(\d+)\/(\d+)\.jpeg/).map(Number);
if (!(x / 2 ** z > 0.8 && x / 2 ** z < 0.9 && y / 2 ** z > 0.3 && y / 2 ** z < 0.45)) fail('타일 행·열 순서가 틀림: ' + t);
const shapes = await page.locator('#map2 path.leaflet-interactive').count();
if (shapes < 8) fail('경로·NOTAM·비행금지구역이 그려지지 않음: ' + shapes);
if (!(await page.textContent('#map2')).includes('D2840/26')) fail('항공사진 위 NOTAM 라벨이 없음');
if (!/P-518/.test(await page.textContent('#map2'))) fail('항공사진 위 비행금지구역 라벨이 없음');
// 지도 클릭으로 지점 지정(잠금이 꺼져 있으면 동작)
const before = await page.textContent('#pt-to-loc');
await page.mouse.click(650, 450); await page.waitForTimeout(500);
if ((await page.textContent('#pt-to-loc')) === before) fail('항공사진 지도 클릭으로 목적지가 지정되지 않음');
// 확대 한계 21, 아래층(낮은 단계 사진)+위층(19단계)+지명층, 지명 끄기·켜기와 기억
const info = await page.evaluate(() => { const A = window.__heliAerial; let sat = 0; A.map.eachLayer((l) => { if (l._url && /Satellite/.test(l._url)) sat++; }); return { max: A.map.getMaxZoom(), sat, labels: A.map.hasLayer(A.labels) }; });
if (info.max !== 21 || info.sat !== 2 || !info.labels) fail('항공사진 지도 설정 이상: ' + JSON.stringify(info));
if (!(await page.isVisible('#mt-labels'))) fail('항공사진에서 지명 버튼이 보여야 함');
await page.click('#mt-labels'); if (await page.evaluate(() => window.__heliAerial.map.hasLayer(window.__heliAerial.labels))) fail('지명 끄기가 안 됨');
await page.click('#mt-labels'); if (!(await page.evaluate(() => window.__heliAerial.map.hasLayer(window.__heliAerial.labels)))) fail('지명 켜기가 안 됨');
await page.click('#mt-labels');   // 끈 상태로 새로고침해도 유지되는지 아래에서 확인
// 일반 지도로 복귀
await page.click('#mt-road'); if (!(await page.isHidden('#map2')) || (await page.evaluate(() => getComputedStyle(document.querySelector('#map')).visibility)) === 'hidden') fail('일반 지도로 돌아오지 않음');
// 선택이 새로고침 후 유지
await page.click('#mt-aerial'); await page.waitForSelector('#map2:not([hidden])'); await page.reload(); await page.waitForTimeout(1500);
if (await page.isHidden('#map2')) fail('항공사진 선택이 새로고침 후 유지되지 않음');
if (await page.evaluate(() => window.__heliAerial.map.hasLayer(window.__heliAerial.labels))) fail('지명 끄기 선택이 새로고침 후 유지되지 않음');
console.log('PASS aerial'); await browser.close(); srv.kill();
