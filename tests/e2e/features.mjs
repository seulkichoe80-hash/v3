// 사용 편의 기능 모음: 출발·도착 바꾸기, Enter 실행, 한 줄 요약, 수신 상태, 다시 시도, 최근 경로, 지금 버튼, 경유지 복제,
// 결과 접기, 글자 크게·야간 화면·사용법, 오래된 판단 안내, 주요지점 CSV 내려받기·불러오기
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node22/lib/node_modules/playwright'); }
const PORT = 8027, ROOT = new URL('../../', import.meta.url).pathname;
const srv = spawn('python3', ['run.py', '--mock', '--port', String(PORT), '--no-browser'], { cwd: ROOT, env: { ...process.env, HELIWX_NOTAM_FILE: `/tmp/feat-${Date.now()}.json` } });
const fail = (m) => { console.error('FAIL:', m); srv.kill(); process.exit(1); };
for (let i = 0; i < 40; i++) { try { await fetch(`http://localhost:${PORT}/api/client-config`); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
const browser = await pw.chromium.launch(); const ctx = await browser.newContext({ acceptDownloads: true }); const page = await ctx.newPage();
await page.route(/dapi\.kakao\.com/, (r) => r.abort());
await page.clock.install();
await page.goto(`http://localhost:${PORT}/`); await page.waitForSelector('#map-off:not([hidden])');
const set = async (id, v) => { await page.fill(id, v); await page.dispatchEvent(id, 'change'); };
const ran = () => page.waitForFunction(() => /판단 완료/.test(document.querySelector('#run-msg').textContent), null, { timeout: 15000 });
await set('#pt-from-name', '항공대A'); await set('#pt-from-coord', '36.50, 127.25');
await set('#pt-to-name', '병원B'); await set('#pt-to-coord', '37.50, 127.05');
// 경유지 복제
await page.click('#add-via'); await set('#pt-via1-name', '현장C'); await set('#pt-via1-coord', '37.00, 127.10');
await page.click('[data-act="dup"]'); if ((await page.locator('fieldset.place.via').count()) !== 2) fail('경유지 복제 안 됨');
await page.click('fieldset.place.via:nth-of-type(2) [data-act="del"], [data-act="del"] >> nth=1');
if ((await page.locator('fieldset.place.via').count()) !== 1) fail('복제한 경유지 삭제 안 됨');
// 출발·도착 바꾸기 (경유지 포함 순서 반전)
await page.click('#swap');
if ((await page.inputValue('#pt-from-name')) !== '병원B' || (await page.inputValue('#pt-to-name')) !== '항공대A') fail('출발·도착 바꾸기 안 됨');
await page.click('#swap');
if ((await page.inputValue('#pt-from-name')) !== '항공대A') fail('다시 바꾸면 원래대로여야 함');
// 지금 버튼
await page.fill('#depart', '2020-01-01T00:00'); await page.click('#depart-now');
if ((await page.inputValue('#depart')).startsWith('2020')) fail('[지금] 버튼이 시각을 바꾸지 못함');
// Enter로 실행 + 한 줄 요약 + 수신 상태 + 보고문 조회 시각
await page.focus('#cruise'); await page.keyboard.press('Enter'); await ran();
if (!(await page.isVisible('#headline')) || !/헬기/.test(await page.textContent('#headline'))) fail('결과 한 줄 요약이 없음');
if ((await page.locator('#data-status .ds').count()) < 5) fail('자료 수신 상태 표시가 없음');
if (!/조회 \d+\/\d+ \d\d:\d\d KST/.test(await page.inputValue('#report-text'))) fail('보고문에 조회 시각이 없음');
// 다시 시도 버튼(경고가 있을 때) → 재실행
if (await page.locator('#retry-run').count()) { await page.evaluate(() => { document.querySelector('#run-msg').textContent = ''; }); await page.click('#retry-run'); await ran(); }
// 최근 경로: 바꾸기 후 최근 조회에서 불러오면 원래 경로
await page.click('#swap');
const opt = await page.locator('#recent-routes option').count(); if (opt < 2) fail('최근 조회 경로가 저장되지 않음');
await page.selectOption('#recent-routes', '0');
if ((await page.inputValue('#pt-from-name')) !== '항공대A') fail('최근 조회에서 불러오기 안 됨');
// 결과 접기/펼치기
if (!(await page.isVisible('#wind'))) fail('바람은 기본 펼침');
await page.click('details.sec:has(#wind) > summary'); if (await page.isVisible('#wind')) fail('바람 접기 안 됨');
await page.click('details.sec:has(#wind) > summary');
// 글자 크게·야간 화면·사용법
await page.click('#btn-big'); if (!(await page.evaluate(() => document.body.classList.contains('big')))) fail('글자 크게 안 됨');
await page.click('#btn-dark'); if (!(await page.evaluate(() => document.documentElement.classList.contains('dark')))) fail('야간 화면 안 됨');
await page.reload(); await page.waitForSelector('#map-off:not([hidden])');
if (!(await page.evaluate(() => document.body.classList.contains('big') && document.documentElement.classList.contains('dark')))) fail('화면 설정이 기억되지 않음');
await page.click('#btn-big'); await page.click('#btn-dark');
if (await page.isVisible('#help-panel')) fail('사용법은 기본 숨김'); await page.click('#btn-help'); if (!(await page.isVisible('#help-panel'))) fail('사용법 열기 안 됨');
// 새로고침하면 출발지도 비어 있다(최근 경로 목록에서만 불러옴)
if ((await page.inputValue('#pt-from-name')) !== '' || (await page.inputValue('#pt-from-coord')) !== '') fail('새로고침 후 출발지가 남아 있음');
// 오래된 판단 안내(20분 경과)
await set('#pt-from-coord', '36.50, 127.25'); await set('#pt-to-coord', '37.50, 127.05'); await page.click('#run'); await ran();
await page.clock.fastForward(21 * 60 * 1000); await page.waitForTimeout(100);
if (!(await page.isVisible('#old-banner')) || !/분 전/.test(await page.textContent('#old-banner'))) fail('오래된 판단 안내가 안 뜸');
// 해상 자동 판별: 울릉도 → 포항 영일대는 바다 위를 지나므로 해상 기준(4800m·1500ft), 내륙은 육상
await set('#pt-from-name', '울릉도'); await set('#pt-from-coord', '37.5062, 130.8604'); await set('#pt-to-name', '영일대'); await set('#pt-to-coord', '36.0551, 129.3782');
await page.click('#run'); await ran();
if (!/해상/.test(await page.textContent('#landsea-auto')) || !/해상 4800m\/(1500|2000)ft/.test(await page.textContent('#route-info'))) fail('울릉도→포항이 해상으로 판별되지 않음: ' + await page.textContent('#route-info'));
await set('#pt-from-name', '대전'); await set('#pt-from-coord', '36.35, 127.38'); await set('#pt-to-name', '수원'); await set('#pt-to-coord', '37.279, 127.0466');
await page.click('#run'); await ran();
if (!/육상/.test(await page.textContent('#landsea-auto'))) fail('내륙 경로가 육상으로 판별되지 않음');
// NOTAM은 경로상에 해당할 때만 안내: 경로와 먼 NOTAM은 접힌 '경로와 무관' 목록으로, 가까우면 본 목록에
await page.click('#sheet-tab-3'); if (!(await page.isVisible('#notam-1'))) await page.click('#notam-1-sum');
await page.fill('#notam-1', (await import('node:fs')).readFileSync(ROOT + 'tests/fixtures/notam_d2840.txt', 'utf8'));
await page.click('#sheet-tab-1'); await page.click('#run'); await ran();
if ((await page.locator('#notam-list > .n').count()) !== 0) fail('경로와 먼 NOTAM이 본 목록에 나옴: ' + (await page.textContent('#notam-list')).slice(0, 300));
if (!/경로상에 해당하는 NOTAM이 없습니다/.test(await page.textContent('#notam-list')) || (await page.locator('#notam-list details.faroff').count()) !== 1) fail('경로 무관 NOTAM 안내가 이상함: ' + await page.textContent('#notam-list'));
await set('#pt-from-name', '김포'); await set('#pt-from-coord', '37.5583, 126.7906'); await set('#pt-to-name', '서울역'); await set('#pt-to-coord', '37.5547, 126.9707');
await page.click('#run'); await ran();
if (!/비행금지구역 P-73/.test(await page.textContent('#rows')) || !/수도방위사령부/.test(await page.textContent('#rows'))) fail('서울역 도착 경로에 P-73 안내가 없음');
if (!/비행제한구역 R-75/.test(await page.textContent('#rows'))) fail('서울 도착 경로에 R-75 안내가 없음');
if ((await page.locator('#notam-list > .n').count()) !== 1 || !/D2840\/26/.test(await page.textContent('#notam-list > .n'))) fail('경로에 걸리는 NOTAM이 본 목록에 없음');
// NOTAM 칸 정리: ①이 비어 있으면 ②③이 ①②로 올라오고, 삭제하면 아래 칸이 당겨진다
const put = (n, text) => fetch(`http://localhost:${PORT}/api/notams/${n}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
const keys = async () => Object.keys((await (await fetch(`http://localhost:${PORT}/api/notams`)).json()).slots).sort();
for (const n of [1, 2, 3, 4]) await fetch(`http://localhost:${PORT}/api/notams/${n}`, { method: 'DELETE' });
await put(2, 'D1111/26 NOTAMN\nE) AAA'); await put(3, 'D2222/26 NOTAMN\nE) BBB');
await page.reload(); await page.waitForSelector('#map-off:not([hidden])'); await page.click('#sheet-tab-3'); await page.waitForTimeout(800);
if (!/D1111\/26/.test(await page.inputValue('#notam-1')) || !/D2222\/26/.test(await page.inputValue('#notam-2')) || (await page.locator('#notam-3').count()) !== 0) fail('비어 있는 ①을 채우도록 위로 당겨지지 않음');
if ((await keys()).join() !== '1,2') fail('서버 저장 위치가 정리되지 않음: ' + await keys());
await page.click('#notam-1-sum'); page.once('dialog', (d) => d.accept()); await page.click('#notam-1-del');
await page.waitForFunction(() => /D2222\/26/.test(document.querySelector('#notam-1').value) && document.querySelector('#notam-2').value === '', null, { timeout: 8000 }).catch(() => fail('삭제 뒤 아래 칸이 당겨지지 않음'));
if ((await keys()).join() !== '1') fail('삭제 뒤 서버 저장이 정리되지 않음: ' + await keys());
await put(1, ''); await fetch(`http://localhost:${PORT}/api/notams/1`, { method: 'DELETE' });
await page.click('#sheet-tab-1');
// 주요지점 CSV: 불러오기(잘못된 줄 건너뜀, 같은 이름 갱신) → 내려받기
await page.click('#places-sum');
const csv = '\ufeff이름,종류,위도,경도,메모\r\n가나병원,병원,37.5,127.0,"옥상, 헬리패드"\r\n다라항공대,항공대,36.5,127.2,\r\n오류줄,병원,abc,127,\r\n가나병원,헬리패드,37.6,127.1,수정\r\n';
await page.setInputFiles('#place-csv-in', { name: 'p.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf-8') });
await page.waitForFunction(() => /불러오기 완료/.test(document.querySelector('#place-csv-msg').textContent), null, { timeout: 8000 }).catch(() => fail('CSV 불러오기 결과가 안 나옴'));
const m = await page.textContent('#place-csv-msg'); if (!/추가 2곳/.test(m) || !/갱신 1곳/.test(m) || !/건너뜀 1건/.test(m)) fail('CSV 불러오기 집계 이상: ' + m);
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('#place-csv-out')]);
const body = (await (await import('node:fs/promises')).readFile(await dl.path(), 'utf-8'));
if (!/이름,종류,위도,경도,메모/.test(body.replace(/"/g, '')) || !/가나병원/.test(body) || !/헬리패드/.test(body)) fail('CSV 내려받기 내용 이상: ' + body.slice(0, 200));
console.log('PASS features'); await browser.close(); srv.kill();
