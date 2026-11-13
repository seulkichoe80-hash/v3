import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseNotam, parseBuffer, assessNotamRoute } from '../../web/notam.js';
import { evaluate } from '../../web/judge.js';

const fx = readFileSync(new URL('../fixtures/notam_d3559.txt', import.meta.url), 'utf8');
const config = JSON.parse(readFileSync(new URL('../../config.json', import.meta.url)));
const NOW = new Date('2026-11-13T00:30:00Z');   // 효력 시간 안(00:10~02:50 UTC)
const N = parseNotam(fx);
const east = (dNm) => ({ lat: N.center.lat, lon: N.center.lon + (dNm * 1.852) / (111.32 * Math.cos((N.center.lat * Math.PI) / 180)) });
const route = (dNm) => [{ name: 'a', ...{ lat: east(dNm).lat - 0.05, lon: east(dNm).lon } }, { name: 'b', ...{ lat: east(dNm).lat + 0.05, lon: east(dNm).lon } }];
const rel = (d) => assessNotamRoute(N, route(d), NOW, new Date(NOW.getTime() + 3600e3), 5);

test('D3559/26: 금지구역 3NM + 완충구역 바깥 10NM(중심에서 13NM, Q선 반경 13NM과 일치)', () => {
  assert.equal(N.id, 'D3559/26'); assert.equal(N.radiusNm, 3); assert.ok(N.prohibited);
  assert.deepEqual([N.buffer.widthNm, N.buffer.outerNm, N.buffer.uncertain], [10, 13, false]);
  assert.match(N.buffer.basis, /바깥으로 10NM.*13NM/);
  assert.equal(N.exceptions.length, 2); assert.match(N.exceptions[0], /EMERG MISSION ACFT/);
  assert.deepEqual(N.phones, ['031-669-7020', '031-661-4471']); assert.ok(N.needsPermission);
  assert.equal(N.start.toISOString(), '2026-11-13T00:10:00.000Z'); assert.equal(N.end.toISOString(), '2026-11-13T02:50:00.000Z');
});
test('경로 위치별 관계: 금지구역 / 완충구역 / 근접 / 무관', () => {
  assert.equal(rel(2).relation, 'CROSS');                    // 중심에서 2NM
  assert.equal(rel(8).relation, 'BUFFER');                   // 3~13NM 사이
  assert.equal(rel(12.5).relation, 'BUFFER');
  assert.equal(rel(15).relation, 'NEAR'); assert.equal(rel(15).grade, 'YELLOW');   // 완충 바깥 2NM
  assert.equal(rel(19).relation, 'CLEAR'); assert.equal(rel(19).grade, 'GREEN');   // 바깥 6NM(근접 5NM 밖)
  assert.equal(rel(8).grade, 'YELLOW');
});
test('해석 검증: Q선 반경이 10이면 중심에서 10NM, 맞는 값이 없으면 넓은 쪽·불확실', () => {
  assert.deepEqual(parseBuffer('BUFFER ZONE : FM OUTSIDE OF PROHIBITED AREA TO 10NM', 3, 10), { widthNm: 7, outerNm: 10, basis: '중심에서 10NM (Q선 반경 10NM과 일치)', uncertain: false });
  const u = parseBuffer('BUFFER ZONE : FM OUTSIDE OF PROHIBITED AREA TO 10NM', 3, null);
  assert.deepEqual([u.outerNm, u.uncertain], [13, true]);
  assert.equal(parseBuffer('BUFFER ZONE : FM 3NM TO 10NM', 3, 13).outerNm, 10);   // 원문이 구간으로 적은 경우
  assert.equal(parseBuffer('AREA : CIRCLE RADIUS 3NM', 3, 3), null);
});
test('판단 결과: 완충구역 통과는 주의 + 사전조율·승인 + 연락처', () => {
  const r = evaluate({
    from: { name: '출발', ...route(8)[0] }, to: { name: '도착', ...route(8)[1] }, points: [{ name: '출발', ...route(8)[0], stayMin: 0 }, { name: '도착', ...route(8)[1], stayMin: 0 }],
    departUtc: NOW, cruiseKt: 110, isNight: false, isSea: false, now: NOW, config,
    data: { metar: [], taf: [], asos: [], aws: [], warn: [], lightning: [] }, dataStatus: {}, notams: [N], notamsProvided: true, routeRegions: [],
  });
  const row = r.rows.find((x) => x.item === 'NOTAM' && /D3559/.test(x.value));
  assert.ok(row && /완충구역 통과/.test(row.value) && row.grade === 'YELLOW', JSON.stringify(row));
  assert.match(row.note, /사전조율·승인 필요 031-669-7020, 031-661-4471/);
});
