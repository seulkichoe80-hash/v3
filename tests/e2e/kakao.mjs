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
await page.click('#sheet-tab-1');
await page.fill('#pt-from-q', '아주대'); await page.dispatchEvent('#pt-from-q', 'input');
await page.waitForFunction(() => /아주대학교병원/.test(document.querySelector('#pt-from-results').textContent), null, { timeout: 5000 }).catch(() => fail('카카오 장소검색 결과가 목록에 안 나옴'));
if (!/주요지점\s*아주대 헬리패드/.test(await page.textContent('#pt-from-results'))) fail('주요지점이 검색 목록에 같이 안 나옴');
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
// 구급차 칸: 검색 결과를 고르면 목록이 닫혀야 함
await page.fill('#amb-from-q', '아주대'); await page.dispatchEvent('#amb-from-q', 'input');
await page.waitForFunction(() => document.querySelectorAll('#amb-from-results li').length > 0, null, { timeout: 5000 }).catch(() => fail('구급차 칸 검색 결과 없음'));
await page.click('#amb-from-results li:has-text("아주대학교병원")');
if ((await page.locator('#amb-from-results li').count()) !== 0) fail('선택 뒤에도 목록이 남아 있음');
if (!/아주대학교병원/.test(await page.textContent('#amb-loc'))) fail('구급차 출발지 선택이 반영되지 않음');
await page.fill('#amb-to-q', '정부대전'); await page.dispatchEvent('#amb-to-q', 'input');
await page.waitForFunction(() => document.querySelectorAll('#amb-to-results li').length > 0, null, { timeout: 5000 });
await page.click('h2#h-input'); await page.waitForTimeout(100);
if ((await page.locator('#amb-to-results li').count()) !== 0) fail('바깥을 눌러도 목록이 안 닫힘');
// 구급차 칸: 장소명이 아닌 주소로도 검색된다(키워드 검색에 없는 주소)
await page.click('#sheet-tab-1');
await page.fill('#amb-from-q', '경기 평택시 평남로 616'); await page.dispatchEvent('#amb-from-q', 'input');
await page.waitForFunction(() => /경기 평택시 평남로 616/.test(document.querySelector('#amb-from-results').textContent), null, { timeout: 5000 }).catch(() => fail('주소 검색 결과가 안 나옴'));
await page.click('#amb-from-results li:has-text("평남로")');
if (!/평남로 616/.test(await page.textContent('#amb-loc'))) fail('주소로 고른 현장이 반영되지 않음');
await page.fill('#amb-to-q', '존재하지않는곳xyz'); await page.dispatchEvent('#amb-to-q', 'input');
await page.waitForFunction(() => /검색 결과 없음/.test(document.querySelector('#amb-to-results').textContent), null, { timeout: 5000 }).catch(() => fail('결과 없음 안내가 안 나옴'));
// 지도 위 위치·좌표 찾기: 검색 → 이동·핀·좌표 카드 → 복사·지점 지정
if (!(await page.isVisible('#ms-q'))) fail('지도 위 검색창이 안 보임');
await page.fill('#ms-q', '정부대전'); await page.dispatchEvent('#ms-q', 'input');
await page.waitForFunction(() => /정부대전청사/.test(document.querySelector('#ms-results').textContent), null, { timeout: 5000 }).catch(() => fail('지도 위 검색 결과가 안 나옴'));
await page.click('#ms-results li:has-text("정부대전청사")');
if (!(await page.isVisible('#ms-card')) || !/정부대전청사/.test(await page.textContent('#ms-name'))) fail('위치 카드가 안 뜸');
if (!/36\.361200, 127\.384500/.test(await page.textContent('#ms-dec')) || !/36/.test(await page.textContent('#ms-coord'))) fail('좌표 표시 이상: ' + await page.textContent('#ms-dec'));
if (!(await page.evaluate(() => (window.__sc || []).some((c) => Math.abs(c[0] - 36.3612) < 1e-6) && window.__sl === 3))) fail('검색한 곳으로 지도가 이동하지 않음');
await page.click('#ms-via'); if (!/정부대전청사/.test(await page.inputValue('#pt-via1-name'))) fail('[경유지로]가 반영되지 않음');
await page.click('#ms-to'); if (!/정부대전청사 \(36\.36/.test(await page.textContent('#pt-to-loc'))) fail('[목적지로]가 반영되지 않음');
await page.click('#ms-save'); if ((await page.inputValue('#place-name')) !== '정부대전청사' || !/36\.36/.test(await page.inputValue('#place-coord'))) fail('[주요지점 저장] 미리 채움 이상');
await page.click('#sheet-tab-1');
await page.click('#ms-close'); if (await page.isVisible('#ms-card')) fail('위치 카드 닫기 안 됨');
// 주소로도 찾기
await page.fill('#ms-q', '경기 평택시 평남로 616'); await page.dispatchEvent('#ms-q', 'input');
await page.waitForFunction(() => /경기 평택시 평남로 616/.test(document.querySelector('#ms-results').textContent), null, { timeout: 5000 }).catch(() => fail('주소 검색이 안 됨'));
await page.click('#ms-results li:has-text("평남로")'); if (!/37\.016000, 127\.077000/.test(await page.textContent('#ms-dec'))) fail('주소 검색 좌표 이상');
// 좌표를 입력하고 Enter
await page.fill('#ms-q', '37.5, 127.0'); await page.press('#ms-q', 'Enter'); if (!/37\.500000, 127\.000000/.test(await page.textContent('#ms-dec'))) fail('좌표 입력 이동 이상');
await page.click('#ms-close');
// 브이월드 키가 없으면 지도 종류 버튼 전체를 숨기고(일반 지도만), 위성(스카이뷰) 버튼은 없다
if (await page.isVisible('#maptype')) fail('키가 없는데 지도 종류 버튼이 보임');
if (await page.locator('#mt-sky').count()) fail('위성 버튼은 삭제되어야 함');
if (errors.length) fail('페이지 오류: ' + errors.join(' / '));
console.log('PASS kakao');
await browser.close(); srv.kill();
