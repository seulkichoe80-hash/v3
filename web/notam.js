// NOTAM 해석기: D 시리즈만 확인 대상, 구역 좌표는 E) 우선(도분초), 실패 시 Q-line(도분) 근사
import { pointToRouteKm, KM_PER_NM } from './geo.js';

const START_RE = /\(?\s*([A-Z]\d{4}\/\d{2})\s+NOTAM\s?[NRC]\b/g;
export const QCODE_TEXT = {
  QRPCA: '비행금지구역 활성', QRRCA: '제한구역 활성', QRDCA: '위험구역 활성',
  QWULW: '무인기 비행', QOBCE: '장애물 설치', QWPLW: '낙하산 강하',
};

export function splitNotams(text) {
  const src = String(text || '');
  const idx = [...src.matchAll(START_RE)].map((m) => m.index);
  if (idx.length === 0) return src.trim() ? [src.trim()] : [];
  const out = idx.map((s, i) => src.slice(s, idx[i + 1] ?? src.length).trim());
  const prefix = src.slice(0, idx[0]);
  if (/[QE]\)/.test(prefix)) out.unshift(prefix.trim()); // 첫 NOTAM 앞 본문은 버리지 않고 해석 불가로 표시
  return out;
}

function utc(yymmddhhmm) {
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(yymmddhhmm);
  if (!m) return null;
  return new Date(Date.UTC(2000 + +m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
}
const dms = (d, m, s, h) => (d + m / 60 + s / 3600) * (h === 'S' || h === 'W' ? -1 : 1);

// "BUFFER ZONE … TO 10NM" 해석. 완충구역이 금지구역 바깥 경계에서 바깥으로 N NM(폭)인지, 중심에서 N NM까지인지를
// Q선 반경(영향 범위 전체)과 비교해 판단한다. 어느 쪽도 맞지 않으면 더 넓은 쪽(보수적)을 쓰고 uncertain으로 표시한다.
export function parseBuffer(text, rNm, qRadiusNm) {
  const flat = String(text || '').replace(/\s+/g, ' ');
  const m = /BUFFER\s*ZONE[\s\S]*?\bTO\s+([\d.]+)\s*NM/i.exec(flat);
  if (!m) return null;
  const b = +m[1];
  if (!(b > 0)) return null;
  const range = /\bFM\s+([\d.]+)\s*NM\s+TO\s+[\d.]+\s*NM/i.test(flat);          // "FM 3NM TO 10NM"은 중심에서의 구간
  const near = (a, c) => a !== null && Math.abs(a - c) <= 1;
  if (range) return { widthNm: Math.max(0, b - rNm), outerNm: b, basis: '중심에서 거리(원문 구간 표기)', uncertain: false };
  if (near(qRadiusNm, rNm + b)) return { widthNm: b, outerNm: rNm + b, basis: `금지구역 바깥으로 ${b}NM (Q선 반경 ${qRadiusNm}NM과 일치)`, uncertain: false };
  if (b > rNm && near(qRadiusNm, b)) return { widthNm: b - rNm, outerNm: b, basis: `중심에서 ${b}NM (Q선 반경 ${qRadiusNm}NM과 일치)`, uncertain: false };
  return { widthNm: b, outerNm: rNm + b, basis: `금지구역 바깥으로 ${b}NM (해석 불확실 — 넓은 쪽 적용)`, uncertain: true };
}

export function parseNotam(raw) {
  const t = String(raw || '').replace(/\r/g, '');
  const flat = t.replace(/\s+/g, ' ');
  const n = { id: null, series: null, kind: null, qcode: null, qcodeText: null, center: null, radiusNm: null,
    geomSource: null, start: null, end: null, endPerm: false, endEst: false, lower: '', upper: '', text: '',
    needsPermission: false, phones: [], prohibited: false, buffer: null, exceptions: [], parseError: null, raw: t };
  const head = /([A-Z])(\d{4}\/\d{2})\s+NOTAM\s?([NRC])/.exec(flat);
  if (!head) { n.parseError = 'NOTAM 번호를 찾을 수 없음'; return n; }
  n.id = head[1] + head[2]; n.series = head[1]; n.kind = head[3];

  const q = /Q\)\s*[A-Z]{4}\/(Q[A-Z]{4})\/[^/]*\/[^/]*\/[^/]*\/(\d{3})\/(\d{3})\/(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])(\d{3})/.exec(flat);
  if (q) { n.qcode = q[1]; n.qcodeText = QCODE_TEXT[q[1]] || q[1]; }

  const eM = /E\)\s*([\s\S]*?)(?=\s[F]\)|\s[G]\)|$)/.exec(flat);
  n.text = eM ? eM[1].trim() : '';
  const c = /(\d{2})(\d{2})(\d{2}(?:\.\d+)?)([NS])\s*(\d{3})(\d{2})(\d{2}(?:\.\d+)?)([EW])/.exec(n.text);
  const r = /RADIUS\s+([\d.]+)\s*NM/i.exec(n.text);
  if (c && r) {
    n.center = { lat: dms(+c[1], +c[2], +c[3], c[4]), lon: dms(+c[5], +c[6], +c[7], c[8]) };
    n.radiusNm = +r[1]; n.geomSource = 'E';
  } else if (q) {
    n.center = { lat: dms(+q[4], +q[5], 0, q[6]), lon: dms(+q[7], +q[8], 0, q[9]) };
    n.radiusNm = +q[10]; n.geomSource = 'Q';
  }

  const b = /B\)\s*(\d{10})/.exec(flat); if (b) n.start = utc(b[1]);
  const ce = /C\)\s*(PERM|\d{10})\s*(EST)?/.exec(flat);
  if (ce) { if (ce[1] === 'PERM') n.endPerm = true; else n.end = utc(ce[1]); n.endEst = !!ce[2]; }

  const f = /F\)\s*([A-Z0-9]+)/.exec(flat), g = /G\)\s*([A-Z0-9]+)/.exec(flat);
  n.lower = f ? f[1] : (q ? (q[2] === '000' ? 'SFC' : 'FL' + q[2]) : '');
  n.upper = g ? g[1] : (q ? 'FL' + q[3] : '');

  n.prohibited = /PROHIBITED/i.test(n.text) || n.qcode === 'QRPCA';
  n.buffer = n.center && n.radiusNm ? parseBuffer(n.text, n.radiusNm, q ? +q[10] : null) : null;
  n.exceptions = [...t.matchAll(/^[ \t]*-?[ \t]*(EXC\b[^\n]*)$/gim)].map((m) => m[1].trim());
  n.needsPermission = /FIRE\s*FIGHTING|EMERG|PRIOR\s+PERMISSION|\bPPR\b|PRE-?COORDINATION|\bAPV\b/i.test(n.text);
  n.phones = [...new Set(n.text.match(/\d{2,3}-\d{3,4}-\d{4}/g) || [])];
  if (!n.center) n.parseError = 'NOTAM 구역 좌표 해석 불가';
  return n;
}

export function assessNotam(n, routeA, routeB, departUtc, arriveUtc, nearNm = 5) {
  return assessNotamRoute(n, [routeA, routeB], departUtc, arriveUtc, nearNm);
}

export function assessNotamRoute(n, route, departUtc, arriveUtc, nearNm = 5) {
  const out = { ...n, inScope: !n.id || n.series === 'D', distanceNm: null, relation: 'UNKNOWN', activeDuringFlight: null, grade: 'NA' };
  if (n.start) {
    const endOk = n.endPerm || !n.end || n.end >= departUtc;
    out.activeDuringFlight = n.start <= arriveUtc && endOk;
  }
  if (n.center) {
    const dC = pointToRouteKm(n.center, route) / KM_PER_NM, r = n.radiusNm || 0, outer = n.buffer ? n.buffer.outerNm : r;
    out.distanceNm = dC - outer;                                  // 가장 바깥 경계(완충구역이 있으면 완충구역 바깥)까지의 거리
    out.relation = dC <= r ? 'CROSS' : n.buffer && dC <= outer ? 'BUFFER' : out.distanceNm <= nearNm ? 'NEAR' : 'CLEAR';
  }
  if (!n.id) out.grade = 'NA';
  else if (!out.inScope) out.grade = 'GREEN';
  else if (!n.center) out.grade = 'NA';
  else if ((out.relation === 'CROSS' || out.relation === 'BUFFER' || out.relation === 'NEAR') && out.activeDuringFlight !== false) out.grade = 'YELLOW';
  else out.grade = 'GREEN';
  return out;
}
