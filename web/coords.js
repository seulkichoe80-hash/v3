// 좌표 입력 해석·표시: 'dd'(십진수) / 'ddm'(도·분 십진) / 'dms'(도·분·초)
export const COORD_FORMATS = { dd: '십진수', ddm: '도·분(십진)', dms: '도·분·초' };
export const COORD_PLACEHOLDER = {
  dd: '37.5583, 126.7906',
  ddm: "37 33.498, 126 47.436  또는  37°33.498'N 126°47.436'E",
  dms: `37 33 30, 126 47 26  또는  37°33'30"N 126°47'26"E  또는  373330N1264726E`,
};
const NEED = { dd: 2, ddm: 4, dms: 6 };
const KOREA = { lat: [32, 39.5], lon: [124, 132] };

export function parseCoord(text, fmt) {
  const src = String(text || '').trim().toUpperCase();
  if (!src) return { error: '좌표를 입력하세요' };
  // NOTAM식 압축 도분초: 373330N1264726E (초 소수 허용)
  const c = /^(\d{2})(\d{2})(\d{2}(?:\.\d+)?)([NS])\s*(\d{3})(\d{2})(\d{2}(?:\.\d+)?)([EW])$/.exec(src.replace(/\s+/g, ''));
  if (c && fmt === 'dms') return finish(dms(+c[1], +c[2], +c[3], c[4]), dms(+c[5], +c[6], +c[7], c[8]), [+c[2], +c[3], +c[6], +c[7]]);
  const s = src.replace(/[°º˚'′’"″”]/g, ' ');
  const nums = [...s.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => parseFloat(m[0]));
  const letters = [...s.matchAll(/[NSEW]/g)].map((m) => m[0]);
  if (/[^0-9NSEW.,\-\s]/.test(s)) return { error: '숫자와 N/S/E/W만 입력하세요' };
  if (nums.length !== NEED[fmt]) {
    return { error: `${COORD_FORMATS[fmt]} 형식은 숫자 ${NEED[fmt]}개가 필요합니다 (입력 ${nums.length}개)` };
  }
  const h = nums.length / 2;
  let a = nums.slice(0, h), b = nums.slice(h);
  let latH = letters.find((x) => x === 'N' || x === 'S') || 'N';
  let lonH = letters.find((x) => x === 'E' || x === 'W') || 'E';
  // 경도를 먼저 쓴 경우(E… N…) 교환
  if (letters.length >= 2 && (letters[0] === 'E' || letters[0] === 'W')) [a, b] = [b, a];
  const toDeg = (p, hem) => {
    const sign = p[0] < 0 || hem === 'S' || hem === 'W' ? -1 : 1;
    const d = Math.abs(p[0]);
    if (fmt === 'dd') return sign * d;
    if (fmt === 'ddm') return sign * (d + p[1] / 60);
    return sign * (d + p[1] / 60 + p[2] / 3600);
  };
  const subs = fmt === 'dd' ? [] : fmt === 'ddm' ? [a[1], b[1]] : [a[1], a[2], b[1], b[2]];
  return finish(toDeg(a, latH), toDeg(b, lonH), subs);
}

const dms = (d, m, s, h) => (d + m / 60 + s / 3600) * (h === 'S' || h === 'W' ? -1 : 1);

function finish(lat, lon, subs) {
  if (subs.some((v) => v < 0 || v >= 60)) return { error: '분·초는 0 이상 60 미만이어야 합니다' };
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return { error: '위도는 ±90, 경도는 ±180 이내여야 합니다' };
  const out = { lat, lon };
  if (lat < KOREA.lat[0] || lat > KOREA.lat[1] || lon < KOREA.lon[0] || lon > KOREA.lon[1]) out.warning = '한반도 범위 밖 좌표입니다 — 확인하세요';
  return out;
}

export function formatCoord(p, fmt) {
  if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return '';
  if (fmt === 'dd') return `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
  const one = (v, pos, neg, degW) => {
    const h = v < 0 ? neg : pos; const a = Math.abs(v);
    let d = Math.floor(a), m = (a - d) * 60;
    if (fmt === 'ddm') {
      let mm = Math.round(m * 1000) / 1000; if (mm >= 60) { d += 1; mm = 0; }
      return `${String(d).padStart(degW, '0')}°${mm.toFixed(3).padStart(6, '0')}'${h}`;
    }
    let mi = Math.floor(m), s = Math.round((m - mi) * 60 * 10) / 10;
    if (s >= 60) { s = 0; mi += 1; } if (mi >= 60) { mi = 0; d += 1; }
    return `${String(d).padStart(degW, '0')}°${String(mi).padStart(2, '0')}'${s.toFixed(1).padStart(4, '0')}"${h}`;
  };
  return `${one(p.lat, 'N', 'S', 2)} ${one(p.lon, 'E', 'W', 3)}`;
}
