import test from 'node:test';
import assert from 'node:assert/strict';
import { AREAS } from '../../web/airspace.js';
import { pointInPolygon, routeDistanceToPolygonKm } from '../../web/geo.js';
import { airspaceRows } from '../../web/judge.js';
const P = (name, lat, lon) => ({ name, lat, lon });
const byId = (id) => AREAS.find((a) => a.id === id);
test('좌표 변환: P518 첫 점 37°39′N 126°10′E', () => {
  const p = byId('P518').poly[0]; assert.ok(Math.abs(p.lat - 37.65) < 1e-9 && Math.abs(p.lon - (126 + 10 / 60)) < 1e-9);
  assert.equal(byId('P518W').poly.length, 7); assert.equal(byId('P518E').poly.length, 4);
});
test('P73 캡슐: 두 중심과 그 사이는 안, 먼 곳은 밖, 반경 약 2NM', () => {
  const poly = byId('P73').poly, c1 = P('c1', 37 + 32 / 60 + 9 / 3600, 126 + 58 / 60 + 38 / 3600), c2 = P('c2', 37 + 32 / 60 + 32 / 3600, 126 + 59 / 60 + 43 / 3600);
  assert.ok(pointInPolygon(c1, poly) && pointInPolygon(c2, poly));
  assert.ok(pointInPolygon(P('중간', (c1.lat + c2.lat) / 2, (c1.lon + c2.lon) / 2), poly));
  assert.ok(pointInPolygon(P('서울역', 37.5547, 126.9707), poly), '서울역은 P73 안');
  assert.ok(!pointInPolygon(P('김포', 37.5583, 126.7906), poly));
  const d = routeDistanceToPolygonKm([P('a', 37.5358, 127.1), P('b', 37.5358, 127.2)], poly);   // 중심에서 동쪽 약 11km
  assert.ok(d > 3 && d < 12, String(d));
});
test('P518: 남쪽 경계선 위·아래', () => {
  const poly = byId('P518').poly;
  assert.ok(pointInPolygon(P('철원', 38.15, 127.3), poly)); assert.ok(pointInPolygon(P('파주 북부', 37.95, 126.85), poly));
  assert.ok(!pointInPolygon(P('서울', 37.5665, 126.978), poly)); assert.ok(!pointInPolygon(P('수원', 37.28, 127.04), poly));
});
test('airspaceRows: 통과·근접·해당없음·미지정', () => {
  const thru = airspaceRows(AREAS, [P('김포', 37.5583, 126.7906), P('서울역', 37.5547, 126.9707)]);
  assert.ok(thru.some((r) => /P-73/.test(r.item) && r.grade === 'YELLOW' && /경로 통과/.test(r.value)));
  assert.match(thru.find((r) => /P-73/.test(r.item)).note, /수도방위사령부/);
  const north = airspaceRows(AREAS, [P('수원', 37.28, 127.04), P('연천', 38.1, 127.1)]);
  assert.ok(north.some((r) => /P-518/.test(r.item) && /통과/.test(r.value)));
  const none = airspaceRows(AREAS, [P('대전', 36.35, 127.38), P('대구', 35.87, 128.6)]);
  assert.equal(none.length, 1); assert.equal(none[0].grade, 'GREEN'); assert.match(none[0].value, /해당 없음/);
  assert.deepEqual(airspaceRows(undefined, [P('a', 37, 127), P('b', 37.1, 127)]), []);
});
test('근접: P73에서 3NM 이내는 근접 경고, 그 밖은 없음', () => {
  const near = airspaceRows(AREAS, [P('a', 37.5358, 127.04), P('b', 37.5358, 127.1)]);   // 경계에서 동쪽 약 1km
  assert.ok(near.some((r) => /P-73/.test(r.item) && /근접/.test(r.value)), JSON.stringify(near));
  const far = airspaceRows(AREAS, [P('a', 37.5358, 127.2), P('b', 37.5358, 127.3)]);
  assert.ok(!far.some((r) => /P-73/.test(r.item) && r.grade === 'YELLOW'));
});

test('R-75: 좌표 15점, 서울 도심은 안·수원/인천은 밖, 비행제한(승인·통보) 안내', () => {
  const r = byId('R75'); assert.equal(r.poly.length, 15); assert.equal(r.kind, 'R');
  assert.ok(Math.abs(r.poly[0].lat - (37 + 39 / 60 + 49 / 3600)) < 1e-9 && Math.abs(r.poly[0].lon - (126 + 48 / 60 + 24 / 3600)) < 1e-9);
  for (const [n, la, lo] of [['서울시청', 37.5665, 126.978], ['강남', 37.4979, 127.0276], ['여의도', 37.5219, 126.9245]]) assert.ok(pointInPolygon(P(n, la, lo), r.poly), n + ' 안');
  for (const [n, la, lo] of [['수원', 37.28, 127.04], ['인천', 37.456, 126.705], ['의정부', 37.738, 127.047], ['김포공항', 37.5583, 126.7906]]) assert.ok(!pointInPolygon(P(n, la, lo), r.poly), n + ' 밖');
  const rows = airspaceRows(AREAS, [P('수원', 37.28, 127.04), P('서울역', 37.5547, 126.9707)]);
  const row = rows.find((x) => /R-75/.test(x.item));
  assert.ok(row && /비행제한구역/.test(row.item) && row.grade === 'YELLOW' && /승인/.test(row.limit + row.note) && /수도방위사령부/.test(row.note), JSON.stringify(rows));
});

test('P-518 S1(인천공항 보호구역): AIP 좌표 5점, 고도 1,600~6,000ft, 경로가 지나면 주의', () => {
  const s = byId('P518S1'); assert.equal(s.poly.length, 5);
  assert.match(s.lower, /1,600/); assert.match(s.upper, /6,000/);
  const rows = airspaceRows(AREAS, [{ lat: 37.69, lon: 126.2 }, { lat: 37.69, lon: 126.5 }], 3);
  assert.ok(rows.some((r) => /P-518 S1/.test(r.item) && /통과/.test(r.value)), JSON.stringify(rows.map((r) => r.item + r.value)));
});
