// 카카오 연동 점검: 가짜 SDK로 장소검색(목록 표시·Enter 선택)과 주요지점 검색이 함께 동작하는지
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node22/lib/node_modules/playwright'); }
const PORT = 8016, ROOT = new URL('../../', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'hw-'));
const srv = spawn('python3', ['run.py', '--mock', '--port', String(PORT), '--no-browser'], { cwd: ROOT, env: { ...process.env, HELIWX_NOTAM_FILE: join(dir, 'n.json') } });
const fail = (m) => { console.error('FAIL:', m); srv.kill(); process.exit(1); };
for (let i = 0; i < 40; i++) { try { await fetch(`http://localhost:${PORT}/api/client-config`); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
// 카카오 키가 있어야 SDK를 부르므로 client-config 응답에 시험용 키를 넣는다
const browser = await pw.chromium.launch(); const page = await browser.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (/Content Security Policy|violates the following/i.test(m.text())) errors.push('CSP: ' + m.text().slice(0, 160)); });
await page.route('**/api/client-config', async (route) => { const r = await route.fetch(); const j = await r.json(); j.kakaoJsKey = 'TESTKEY'; route.fulfill({ json: j }); });
await page.route(/dapi\.kakao\.com\/v2\/maps\/sdk\.js/, (r) => r.fulfill({ contentType: 'text/javascript', body: readFileSync(ROOT + 'tests/e2e/kakao_stub.js', 'utf8') }));
await page.goto(`http://localhost:${PORT}/`);
await page.waitForTimeout(800);
if (await page.isVisible('#map-off')) fail('가짜 SDK인데 지도 실패로 처리됨: ' + await page.textContent('#map-off'));
// 주요지점 하나 등록(좌표 입력) 후 카카오 검색과 함께 나오는지
await page.click('#places-sum');
await page.fill('#place-name', '아주대 헬리패드'); await page.fill('#place-coord', '37.2795, 127.0470'); await page.click('#place-add');
await page.waitForFunction(() => /아주대 헬리패드/.test(document.querySelector('#place-list').textContent), null, { timeout: 5000 }).catch(() => fail('주요지점 추가 안 됨'));
await page.fill('#pt-from-q', '아주대'); await page.dispatchEvent('#pt-from-q', 'input');
await page.waitForFunction(() => /아주대학교병원/.test(document.querySelector('#pt-from-results').textContent), null, { timeout: 5000 }).catch(() => fail('카카오 장소검색 결과가 목록에 안 나옴'));
if (!/★\s*아주대 헬리패드/.test(await page.textContent('#pt-from-results'))) fail('주요지점이 검색 목록에 같이 안 나옴');
// Enter → 첫 결과(주요지점 ★가 먼저) 선택
await page.press('#pt-from-q', 'Enter');
if (!/아주대 헬리패드/.test(await page.textContent('#pt-from-loc'))) fail('Enter로 첫 결과 선택 안 됨');
// 목적지: 카카오 결과 클릭
await page.fill('#pt-to-q', '정부대전'); await page.dispatchEvent('#pt-to-q', 'input');
await page.waitForFunction(() => /정부대전청사/.test(document.querySelector('#pt-to-results').textContent), null, { timeout: 5000 }).catch(() => fail('목적지 검색 결과 없음'));
await page.click('#pt-to-results li:has-text("정부대전청사")');
if (!/정부대전청사 \(36\.36/.test(await page.textContent('#pt-to-loc'))) fail('검색 결과 클릭 선택 안 됨');
// 결과 없음 안내
await page.fill('#pt-to-q', '없는장소이름'); await page.dispatchEvent('#pt-to-q', 'input');
await page.waitForFunction(() => /검색 결과 없음/.test(document.querySelector('#pt-to-results').textContent), null, { timeout: 5000 }).catch(() => fail('결과 없음 안내 없음'));
if (errors.length) fail('페이지 오류: ' + errors.join(' / '));
console.log('PASS kakao');
await browser.close(); srv.kill();
