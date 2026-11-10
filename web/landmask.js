// 내장 해안선으로 경로가 바다 위를 지나는지 판별한다(카카오 지도 없이도 동작, 카카오 판별과 합쳐 사용).
// 육지에서 약 3km 이상 떨어진 점만 "바다"로 보고, 그런 점이 하나라도 있으면 해상 경로로 본다(해상 기준이 더 엄격하므로 안전 쪽).
import { LAND } from './landdata.js';
import { sampleRouteMulti } from './geo.js';

const RINGS = LAND.map((r) => {
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const [x, y] of r) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  return { r, minX, maxX, minY, maxY };
});

function inRing(lon, lat, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function isLand(lat, lon) {
  for (const g of RINGS) if (lon >= g.minX && lon <= g.maxX && lat >= g.minY && lat <= g.maxY && inRing(lon, lat, g.r)) return true;
  return false;
}
const OFF = 0.028;   // 위도 약 3.1km(경도 약 2.5km)
const DIRS = [[0, 0], [OFF, 0], [-OFF, 0], [0, OFF], [0, -OFF], [OFF, OFF], [OFF, -OFF], [-OFF, OFF], [-OFF, -OFF]];
// 점과 주변 8방향(약 3km)이 모두 육지가 아니면 열린 바다
export function isOpenSea(lat, lon) {
  return DIRS.every(([dy, dx]) => !isLand(lat + dy, lon + dx));
}
export function routeOverSea(pts, stepKm = 5) {
  const samples = sampleRouteMulti(pts, stepKm);
  const sea = samples.filter((p) => isOpenSea(p.lat, p.lon)).length;
  return { sea: sea > 0, seaPoints: sea, total: samples.length };
}
