import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCoord, formatCoord } from '../../web/coords.js';

const near = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;
const G = { lat: 37 + 33 / 60 + 30 / 3600, lon: 126 + 47 / 60 + 26 / 3600 };

test('십진수', () => {
  const r = parseCoord('37.5583, 126.7906', 'dd'); assert.ok(near(r.lat, 37.5583) && near(r.lon, 126.7906));
  assert.ok(parseCoord('37.5583 126.7906', 'dd').lat);
  assert.ok(parseCoord('-33.9, 151.2', 'dd').lat < 0);
});
test('도·분(십진)', () => {
  const r = parseCoord('37 33.5, 126 47.4333', 'ddm'); assert.ok(near(r.lat, G.lat) && near(r.lon, G.lon, 1e-3));
  const r2 = parseCoord("37°33.5'N 126°47.4333'E", 'ddm'); assert.ok(near(r2.lat, G.lat) && near(r2.lon, G.lon, 1e-3));
});
test('도·분·초', () => {
  for (const s of ['37 33 30, 126 47 26', `37°33'30"N 126°47'26"E`, '373330N1264726E', 'N37 33 30 E126 47 26']) {
    const r = parseCoord(s, 'dms'); assert.ok(!r.error, s + ' ' + r.error); assert.ok(near(r.lat, G.lat) && near(r.lon, G.lon), s);
  }
  const s = parseCoord('33 51 0 S 151 12 0 E', 'dms'); assert.ok(s.lat < 0 && s.lon > 0);
  const swap = parseCoord('126 47 26 E 37 33 30 N', 'dms'); assert.ok(near(swap.lat, G.lat) && near(swap.lon, G.lon));
});
test('오류', () => {
  assert.ok(parseCoord('', 'dd').error);
  assert.ok(parseCoord('37 33, 126 47', 'dms').error);        // 숫자 개수 부족
  assert.ok(parseCoord('37 61 0, 126 47 26', 'dms').error);   // 분 ≥ 60
  assert.ok(parseCoord('95, 126', 'dd').error);               // 위도 범위
  assert.ok(parseCoord('abc', 'ddm').error);
});
test('한반도 밖 경고', () => {
  assert.ok(parseCoord('35.68, 139.69', 'dd').warning);
  assert.ok(!parseCoord('37.5, 127', 'dd').warning);
});
test('표시 형식과 왕복', () => {
  assert.equal(formatCoord(G, 'dd'), '37.55833, 126.79056');
  assert.equal(formatCoord(G, 'ddm'), "37°33.500'N 126°47.433'E");
  assert.equal(formatCoord(G, 'dms'), `37°33'30.0"N 126°47'26.0"E`);
  for (const f of ['dd', 'ddm', 'dms']) { const r = parseCoord(formatCoord(G, f), f); assert.ok(near(r.lat, G.lat) && near(r.lon, G.lon), f); }
});
