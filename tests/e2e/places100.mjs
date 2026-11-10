// 주요지점 100곳: 처음 30곳만 보이고, 종류 칩·검색·더 보기·최근 사용·종류 변경이 동작한다
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node22/lib/node_modules/playwright'); }
const PORT = 8026, ROOT = new URL('../../', import.meta.url).pathname;
const srv = spawn('python3', ['run.py', '--mock', '--port', String(PORT), '--no-browser'], { cwd: ROOT, env: { ...process.env, HELIWX_NOTAM_FILE: `/tmp/p100-${Date.now()}.json` } });
const fail = (m) => { console.error('FAIL:', m); srv.kill(); process.exit(1); };
for (let i = 0; i < 40; i++) { try { await fetch(`http://localhost:${PORT}/api/client-config`); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
const cats = ['항공대', '병원', '헬리패드', ''];
for (let i = 0; i < 100; i++) {
  const r = await fetch(`http://localhost:${PORT}/api/places`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `지점${String(i).padStart(3, '0')}`, lat: 36 + (i % 10) * 0.1, lon: 127 + (i % 7) * 0.1, memo: i % 10 === 0 ? '옥상' : '', cat: cats[i % 4] }) });
  if (!r.ok) fail('주요지점 등록 실패 ' + i);
}
const browser = await pw.chromium.launch(); const page = await browser.newPage();
await page.route(/dapi\.kakao\.com/, (r) => r.abort());
await page.goto(`http://localhost:${PORT}/`); await page.waitForSelector('#map-off:not([hidden])');
await page.click('#places-sum');
const n = () => page.locator('#place-list li[data-id]').count();
if ((await n()) !== 30) fail('처음에는 30곳만 보여야 함: ' + await n());
if (!(await page.isVisible('#place-more'))) fail('더 보기 버튼 없음');
await page.click('#place-more'); if ((await n()) !== 60) fail('더 보기 뒤 60곳이어야 함');
await page.click('#place-more'); await page.click('#place-more'); if ((await n()) !== 100 || (await page.isVisible('#place-more'))) fail('끝까지 보면 100곳, 버튼 사라짐: ' + await n());
await page.click('#place-chips .chip[data-cat="병원"]'); if ((await n()) !== 25) fail('병원 종류는 25곳: ' + await n());
await page.click('#place-chips .chip[data-cat="기타"]'); if ((await n()) !== 25) fail('종류 없는 지점은 기타 25곳: ' + await n());
await page.click('#place-chips .chip[data-cat="전체"]');
await page.fill('#place-q', '옥상'); if ((await n()) !== 10) fail('메모 검색 10곳: ' + await n());
await page.fill('#place-q', '지점042'); if ((await n()) !== 1) fail('이름 검색 1곳');
// 선택 → ①시트로 이동, 최근 사용에 올라옴
await page.click('#place-list li .pick'); if (!(await page.isVisible('#sheet-1'))) fail('선택 뒤 ①시트로 와야 함');
await page.click('#places-sum'); await page.fill('#place-q', '');
if (!(await page.isVisible('#place-recent')) || !/지점042/.test(await page.textContent('#place-recent'))) fail('최근 사용에 방금 고른 지점이 없음');
// 종류 변경이 저장된다(새로고침 후에도 유지)
await page.fill('#place-q', '지점001'); await page.selectOption('#place-list li .catsel', '병원');
await page.waitForTimeout(400); await page.reload(); await page.waitForSelector('#map-off:not([hidden])'); await page.click('#places-sum');
await page.fill('#place-q', '지점001'); if ((await page.inputValue('#place-list li .catsel')) !== '병원') fail('종류 변경이 유지되지 않음');
const list = await (await fetch(`http://localhost:${PORT}/api/places`)).json();
if (list.places.length !== 100) fail('종류 변경으로 중복 생성됨: ' + list.places.length);
console.log('PASS places100'); await browser.close(); srv.kill();
