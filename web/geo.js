// 지리 계산: 거리, 점-선분 최단거리, 경로 샘플링, 일출·일몰(NOAA 근사)
export const KM_PER_NM = 1.852;
const R = 6371.0088;
const rad = (d) => d * Math.PI / 180;
const deg = (r) => r * 180 / Math.PI;

export function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// 등거리 근사 평면 투영(수백 km 이내 오차 무시 가능)
export function pointToSegmentKm(p, a, b) {
  const lat0 = rad((a.lat + b.lat + p.lat) / 3);
  const xy = (q) => [rad(q.lon) * Math.cos(lat0) * R, rad(q.lat) * R];
  const [px, py] = xy(p), [ax, ay] = xy(a), [bx, by] = xy(b);
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
}

export function sampleRoute(a, b, stepKm = 10) {
  const d = distanceKm(a, b);
  if (d < 1e-6) return [{ lat: a.lat, lon: a.lon }];
  const n = Math.max(1, Math.round(d / stepKm));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
  }
  return pts;
}

// NOAA 일출·일몰 근사. dateUtc가 속한 KST 날짜 기준이 아니라, 주어진 UTC 날짜(정오 기준)로 계산.
export function sunTimesUtc(lat, lon, dateUtc) {
  const d = new Date(Date.UTC(dateUtc.getUTCFullYear(), dateUtc.getUTCMonth(), dateUtc.getUTCDate()));
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const N = Math.floor((d - start) / 86400e3) + 1;
  const g = 2 * Math.PI / 365 * (N - 1 + 0.5);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const cosH = (Math.cos(rad(90.833)) / (Math.cos(rad(lat)) * Math.cos(decl))) - Math.tan(rad(lat)) * Math.tan(decl);
  const H = deg(Math.acos(Math.max(-1, Math.min(1, cosH))));
  const rise = 720 - 4 * (lon + H) - eqt, set = 720 - 4 * (lon - H) - eqt; // 분(UTC)
  return { sunrise: new Date(d.getTime() + rise * 60e3), sunset: new Date(d.getTime() + set * 60e3) };
}

function isNightAt(p, t) {
  // t가 속한 현지(경도 기준) 날짜의 일출·일몰과 비교
  const local = new Date(t.getTime() + (p.lon / 15) * 3600e3);
  const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  const { sunrise, sunset } = sunTimesUtc(p.lat, p.lon, day);
  return t < sunrise || t >= sunset;
}

// 출발~도착 구간 중 어느 시점이든 출발지 또는 목적지가 야간이면 true (5분 간격 검사)
export function isNightDuring(from, to, departUtc, arriveUtc) {
  const end = Math.max(departUtc.getTime(), arriveUtc.getTime());
  for (let t = departUtc.getTime(); ; t += 5 * 60e3) {
    const tt = new Date(Math.min(t, end));
    if (isNightAt(from, tt) || isNightAt(to, tt)) return true;
    if (tt.getTime() >= end) return false;
  }
}
