import test from 'node:test';
import assert from 'node:assert/strict';
import { compareTransport as c } from '../../web/transport.js';
const road = (m, source = 'kakao') => ({ durationMin: m, distanceKm: 50, source });
test('헬기 = 준비 + 비행', () => { const r = c({ prepMin: 15, flightMin: 38, overall: 'GREEN', road: road(120) }); assert.equal(r.heli.totalMin, 53); assert.equal(r.verdict, 'HELI'); assert.equal(r.diffMin, 67); });
test('구급차가 빠른 경우', () => { const r = c({ prepMin: 15, flightMin: 10, overall: 'GREEN', road: road(20) }); assert.equal(r.verdict, 'AMBULANCE'); assert.match(r.text, /5분/); });
test('차이 5분 미만이면 비슷', () => { const r = c({ prepMin: 15, flightMin: 20, overall: 'GREEN', road: road(38) }); assert.equal(r.verdict, 'SIMILAR'); });
test('경계: 정확히 5분 차이는 빠른 쪽 우세', () => { assert.equal(c({ prepMin: 15, flightMin: 20, overall: 'GREEN', road: road(40) }).verdict, 'HELI'); assert.equal(c({ prepMin: 15, flightMin: 20, overall: 'GREEN', road: road(30) }).verdict, 'AMBULANCE'); });
test('규정상 비행제한이면 시간과 무관하게 구급차', () => { const r = c({ prepMin: 15, flightMin: 10, overall: 'RED', road: road(300) }); assert.equal(r.verdict, 'AMBULANCE'); assert.match(r.text, /비행제한/); });
test('구급차 시간 없음 → 비교 불가', () => { const r = c({ prepMin: 15, flightMin: 10, overall: 'GREEN', road: null }); assert.equal(r.verdict, 'NONE'); assert.equal(r.amb, null); });
test('자료없음·주의·추정값은 경고를 붙임', () => {
  assert.ok(c({ prepMin: 15, flightMin: 10, overall: 'NA', road: road(100) }).caution.some((x) => /자료/.test(x)));
  assert.ok(c({ prepMin: 15, flightMin: 10, overall: 'YELLOW', road: road(100) }).caution.some((x) => /주의/.test(x)));
  assert.ok(c({ prepMin: 15, flightMin: 10, overall: 'GREEN', road: road(100, 'estimate') }).caution.some((x) => /추정/.test(x)));
});
test('입력 안내 문구가 있으면 그대로 표시', () => { assert.match(c({ prepMin: 15, flightMin: 10, overall: 'GREEN', road: null, missing: '구급차 이동시간 칸에 입력' }).text, /입력/); });
test('비행제한이어도 구급차 시간이 없으면 사유를 경고로 남김', () => {
  const r = c({ prepMin: 15, flightMin: 10, overall: 'RED', road: null, missing: '구급차 이동시간 칸에 입력' });
  assert.equal(r.verdict, 'AMBULANCE'); assert.match(r.missing, /입력/); assert.ok(r.caution.some((x) => /입력/.test(x)));
});
