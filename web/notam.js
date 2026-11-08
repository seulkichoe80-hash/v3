// NOTAM 해석기: D 시리즈만 확인 대상, 구역 좌표는 E) 우선(도분초), 실패 시 Q-line(도분) 근사
import { pointToSegmentKm, KM_PER_NM } from './geo.js';

const START_RE = /\(?\s*([A-Z]\d{4}\/\d{2})\s+NOTAM[NRC]\b/g;
export const QCODE_TEXT = {
  QRPCA: '비행금지구역 활성', QRRCA: '제한구역 활성', QRDCA: '위험구역 활성',
  QWULW: '무인기 비행', QOBCE: '장애물 설치', QWPLW: '낙하산 강하',
};

export function splitNotams(text) {
  const src = String(text || '');
  const idx = [...src.matchAll(START_RE)].map((m) => m.index);
  if (idx.length === 0) return src.trim() ? [src.trim()] : [];
  return idx.map((s, i) => src.slice(s, idx[i + 1] ?? src.length).trim());
}

function utc(yymmddhhmm) {
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(yymmddhhmm);
  if (!m) return null;
  return new Date(Date.UTC(2000 + +m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
}
const dms = (d, m, s, h) => (d + m / 60 + s / 3600) * (h === 'S' || h === 'W' ? -1 : 1);

export function parseNotam(raw) {
  const t = String(raw || '').replace(/\r/g, '');
  const flat = t.replace(/\s+/g, ' ');
  const n = { id: null, series: null, kind: null, qcode: null, qcodeText: null, center: null, radiusNm: null,
    geomSource: null, start: null, end: null, endPerm: false, endEst: false, lower: '', upper: '', text: '',
    needsPermission: false, phones: [], parseError: null, raw: t };
  const head = /([A-Z])(\d{4}\/\d{2})\s+NOTAM([NRC])/.exec(flat);
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

  n.needsPermission = /FIRE\s*FIGHTING|EMERG|PRIOR\s+PERMISSION|\bPPR\b/i.test(n.text);
  n.phones = [...new Set(n.text.match(/\d{2,3}-\d{3,4}-\d{4}/g) || [])];
  if (!n.center) n.parseError = 'NOTAM 구역 좌표 해석 불가';
  return n;
}

export function assessNotam(n, routeA, routeB, departUtc, arriveUtc, nearNm = 5) {
  const out = { ...n, inScope: n.series === 'D', distanceNm: null, relation: 'UNKNOWN', activeDuringFlight: null, grade: 'NA' };
  if (n.start) {
    const endOk = n.endPerm || !n.end || n.end >= departUtc;
    out.activeDuringFlight = n.start <= arriveUtc && endOk;
  }
  if (n.center) {
    out.distanceNm = pointToSegmentKm(n.center, routeA, routeB) / KM_PER_NM - (n.radiusNm || 0);
    out.relation = out.distanceNm <= 0 ? 'CROSS' : out.distanceNm <= nearNm ? 'NEAR' : 'CLEAR';
  }
  if (!n.id) out.grade = 'NA';
  else if (!out.inScope) out.grade = 'GREEN';
  else if (!n.center) out.grade = 'NA';
  else if ((out.relation === 'CROSS' || out.relation === 'NEAR') && out.activeDuringFlight !== false) out.grade = 'YELLOW';
  else out.grade = 'GREEN';
  if (!n.id) out.inScope = false;
  return out;
}
