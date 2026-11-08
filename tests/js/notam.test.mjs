import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { splitNotams, parseNotam, assessNotam } from '../../web/notam.js';

const fx = readFileSync(new URL('../fixtures/notam_d2840.txt', import.meta.url), 'utf8');
const gimpo = { lat: 37.5583, lon: 126.7906 }, seoulSt = { lat: 37.5547, lon: 126.9707 };

test('D2840/26 해석', () => {
  const list = splitNotams(fx); assert.equal(list.length, 1);
  const n = parseNotam(list[0]);
  assert.equal(n.id, 'D2840/26'); assert.equal(n.series, 'D'); assert.equal(n.qcode, 'QRPCA');
  assert.equal(n.qcodeText, '비행금지구역 활성');
  assert.ok(Math.abs(n.center.lat - (37 + 35 / 60 + 23 / 3600)) < 1e-6);
  assert.ok(Math.abs(n.center.lon - (126 + 58 / 60 + 32 / 3600)) < 1e-6);
  assert.equal(n.radiusNm, 2); assert.equal(n.geomSource, 'E');
  assert.equal(n.start.toISOString(), '2026-09-26T15:00:00.000Z');
  assert.equal(n.end.toISOString(), '2026-12-26T14:59:00.000Z');
  assert.equal(n.lower, 'SFC'); assert.equal(n.upper, 'FL600');
  assert.equal(n.needsPermission, true); assert.deepEqual(n.phones, ['02-524-0315']);
  assert.equal(n.parseError, null);
});
test('E) 좌표 없으면 Q-line 근사', () => {
  const n = parseNotam(fx.replace(/A CIRCLE RADIUS.*\n/, ''));
  assert.equal(n.geomSource, 'Q'); assert.equal(n.radiusNm, 3);
  assert.ok(Math.abs(n.center.lat - (37 + 35 / 60)) < 1e-6);
});
test('여러 건 분리, 비D 시리즈 범위 밖', () => {
  const other = 'A1234/26 NOTAMN\nQ)RKRR/QMRLC/IV/NBO/A/000/999/3733N12647E005\nA)RKSS B)2611010000 C)2611302359\nE)RWY 14R/32L CLSD';
  const list = splitNotams(fx + '\n\n\n   \n' + other);
  assert.equal(list.length, 2);
  const a = assessNotam(parseNotam(list[1]), gimpo, seoulSt, new Date('2026-11-09T03:00:00Z'), new Date('2026-11-09T03:10:00Z'));
  assert.equal(a.inScope, false);
});
test('PERM / EST', () => {
  assert.equal(parseNotam(fx.replace('C)2612261459', 'C)PERM')).endPerm, true);
  const e = parseNotam(fx.replace('C)2612261459', 'C)2612261459EST'));
  assert.equal(e.endEst, true); assert.equal(e.end.toISOString(), '2026-12-26T14:59:00.000Z');
});
test('해석 불가 입력 → NA', () => {
  const n = parseNotam('아무 의미 없는 텍스트');
  assert.ok(n.parseError);
  assert.equal(assessNotam(n, gimpo, seoulSt, new Date(), new Date()).grade, 'NA');
});
test('경로 관계와 발효 판정', () => {
  const n = parseNotam(splitNotams(fx)[0]);
  const a = assessNotam(n, gimpo, seoulSt, new Date('2026-11-09T03:00:00Z'), new Date('2026-11-09T03:10:00Z'));
  assert.ok(['CROSS', 'NEAR'].includes(a.relation), a.relation);
  assert.equal(a.activeDuringFlight, true); assert.equal(a.grade, 'YELLOW');
  const b = assessNotam(n, gimpo, seoulSt, new Date('2027-01-10T03:00:00Z'), new Date('2027-01-10T03:10:00Z'));
  assert.equal(b.activeDuringFlight, false); assert.equal(b.grade, 'GREEN');
  const far = assessNotam(n, { lat: 35.1, lon: 129 }, { lat: 35.2, lon: 129.1 }, new Date('2026-11-09T03:00:00Z'), new Date('2026-11-09T03:10:00Z'));
  assert.equal(far.relation, 'CLEAR'); assert.equal(far.grade, 'GREEN');
});
test('좌표 없는 비D 시리즈는 범위 밖(GREEN)', () => {
  const a = assessNotam(parseNotam('A1111/26 NOTAMN\nA)RKSS B)2611010000 C)2611302359\nE)TWY A CLSD'), gimpo, seoulSt, new Date('2026-11-09T03:00:00Z'), new Date('2026-11-09T03:10:00Z'));
  assert.equal(a.grade, 'GREEN'); assert.equal(a.inScope, false);
});
