// 화면 점검: python run.py --mock 기동 → 카카오 미로딩(오프라인) 대체 경로로 좌표 입력 → 판단 실행
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node22/lib/node_modules/playwright'); }

const PORT = 8010, ROOT = new URL('../../', import.meta.url).pathname;
const srv = spawn('python3', ['run.py', '--mock', '--port', String(PORT), '--no-browser'], { cwd: ROOT });
const fail = (m) => { console.error('FAIL:', m); srv.kill(); process.exit(1); };
for (let i = 0; i < 40; i++) { try { await fetch(`http://localhost:${PORT}/api/client-config`); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }

const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: Number(process.env.DSF || 1) });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/dapi\.kakao|ERR_|Failed to load resource/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.route(/dapi\.kakao\.com/, (r) => r.abort());
await page.goto(`http://localhost:${PORT}/`);
await page.waitForSelector('#coord-fallback:not([hidden])', { timeout: 15000 }).catch(() => fail('좌표 직접 입력 대체 화면이 보이지 않음'));
await page.fill('#from-name', '김포'); await page.fill('#from-lat', '37.5583'); await page.fill('#from-lon', '126.7906');
await page.fill('#to-name', '서울역'); await page.fill('#to-lat', '37.5547'); await page.fill('#to-lon', '126.9707');
await page.fill('#notam-text', readFileSync(ROOT + 'tests/fixtures/notam_d2840.txt', 'utf8'));
await page.click('#run');
await page.waitForSelector('#overall[data-grade]', { timeout: 15000 }).catch(() => fail('종합 판정이 표시되지 않음'));
const grade = await page.getAttribute('#overall', 'data-grade');
const notamList = await page.textContent('#notam-list');
const report = await page.inputValue('#report-text');
if (!['RED', 'YELLOW', 'GREEN', 'NA'].includes(grade)) fail('등급 이상: ' + grade);
if (!notamList.includes('D2840/26')) fail('NOTAM 목록에 D2840/26 없음');
if (!report.includes('D2840/26')) fail('보고문에 D2840/26 없음');
if ((await page.locator('#rows tr').count()) < 6) fail('근거 표 행 부족');
if (!(await page.textContent('#landsea-auto')).includes('해상 기준')) fail('지도 없음 시 해상(엄격) 기준 안내 없음');
await page.fill('#cruise', '0'); await page.dispatchEvent('#cruise', 'change'); await page.click('#run');
await page.waitForFunction(() => document.querySelector('#run-msg').textContent.includes('판단 완료'), null, { timeout: 5000 }).catch(() => fail('순항속도 0 입력 시 멈춤'));
if (errors.length) fail('콘솔 오류: ' + errors.join(' / '));
if (process.env.SHOT) await page.screenshot({ path: ROOT + process.env.SHOT, fullPage: true });
console.log('PASS grade=' + grade);
await browser.close(); srv.kill();
