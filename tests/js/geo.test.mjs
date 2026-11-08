import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceKm, pointToSegmentKm, sampleRoute, sunTimesUtc, isNightDuring, KM_PER_NM } from '../../web/geo.js';

const seoul = { lat: 37.5663, lon: 126.9779 }, busan = { lat: 35.1798, lon: 129.0750 };
const kst = (s) => new Date(s + '+09:00');
const kstMin = (d) => { const k = new Date(d.getTime() + 9 * 3600e3); return k.getUTCHours() * 60 + k.getUTCMinutes(); };

test('distanceKm 서울-부산 ≈ 325km', () => {
  assert.ok(Math.abs(distanceKm(seoul, busan) - 325) < 3, String(distanceKm(seoul, busan)));
  assert.equal(KM_PER_NM, 1.852);
});
test('pointToSegmentKm', () => {
  const a = { lat: 37, lon: 127 }, b = { lat: 37, lon: 128 };
  assert.ok(pointToSegmentKm({ lat: 37, lon: 127.5 }, a, b) < 0.5);
  const beyond = { lat: 37, lon: 128.5 };
  assert.ok(Math.abs(pointToSegmentKm(beyond, a, b) - distanceKm(beyond, b)) < 0.5);
  assert.ok(Math.abs(pointToSegmentKm({ lat: 37.1, lon: 127.5 }, a, b) - 11.1) < 0.3);
  assert.ok(pointToSegmentKm(beyond, a, a) - distanceKm(beyond, a) < 0.01);
});
test('sampleRoute', () => {
  assert.equal(sampleRoute(seoul, seoul).length, 1);
  const a = { lat: 37, lon: 127 }; const b = { lat: 37 + 100 / 111.2, lon: 127 };
  assert.equal(sampleRoute(a, b, 10).length, 11);
});
test('sunTimesUtc 서울 2026-11-08', () => {
  const { sunrise, sunset } = sunTimesUtc(37.57, 126.98, new Date('2026-11-08T03:00:00Z'));
  assert.ok(Math.abs(kstMin(sunrise) - (7 * 60)) <= 10, 'sunrise ' + kstMin(sunrise));
  assert.ok(Math.abs(kstMin(sunset) - (17 * 60 + 25)) <= 10, 'sunset ' + kstMin(sunset));
});
test('isNightDuring', () => {
  assert.equal(isNightDuring(seoul, seoul, kst('2026-11-08T16:50:00'), kst('2026-11-08T17:40:00')), true);
  assert.equal(isNightDuring(seoul, seoul, kst('2026-11-08T12:00:00'), kst('2026-11-08T12:30:00')), false);
  assert.equal(isNightDuring(seoul, seoul, kst('2026-11-08T02:00:00'), kst('2026-11-08T02:30:00')), true);
});
