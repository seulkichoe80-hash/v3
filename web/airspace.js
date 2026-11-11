// 비행금지·제한구역(AIP Korea ENR 5.1). 좌표는 담당자가 제공한 ENR 5.1 발췌문의 값을 그대로 옮겼다(DDMMSSN DDDMMSSE).
// 개정(AIRAC)이 바뀌면 이 파일의 좌표와 AIRAC_NOTE만 교체한다.
export const AIRAC_NOTE = 'AIP ENR 5.1 발췌(담당자 제공) — 현행 개정 여부 확인 필요';

function dms(s) {   // '373900N 1261000E' → {lat, lon}
  const m = /^(\d{2})(\d{2})(\d{2})([NS])\s+(\d{3})(\d{2})(\d{2})([EW])$/.exec(s.trim());
  if (!m) throw new Error('좌표 형식 오류: ' + s);
  const v = (d, mi, se, h, neg) => (+d + +mi / 60 + +se / 3600) * (h === neg ? -1 : 1);
  return { lat: v(m[1], m[2], m[3], m[4], 'S'), lon: v(m[5], m[6], m[7], m[8], 'W') };
}
const ring = (list) => list.map(dms);

// 두 원(반경 r NM)의 외곽을 이은 캡슐 모양(P73: "Area connecting the outlines of circles")
function capsule(c1, c2, rNm, n = 24) {
  const rKm = rNm * 1.852, kmLat = 110.574, kmLon = (lat) => 111.32 * Math.cos((lat * Math.PI) / 180);
  const lat0 = (c1.lat + c2.lat) / 2;
  const theta = Math.atan2((c2.lat - c1.lat) * kmLat, (c2.lon - c1.lon) * kmLon(lat0));   // c1→c2 방향
  const pt = (c, a) => ({ lat: c.lat + (Math.sin(a) * rKm) / kmLat, lon: c.lon + (Math.cos(a) * rKm) / kmLon(lat0) });
  const out = [];
  for (let i = 0; i <= n; i++) out.push(pt(c2, theta - Math.PI / 2 + (Math.PI * i) / n));   // c2 쪽 반원
  for (let i = 0; i <= n; i++) out.push(pt(c1, theta + Math.PI / 2 + (Math.PI * i) / n));   // c1 쪽 반원
  return out;
}

export const AREAS = [
  {
    id: 'R75', short: 'R-75', name: '수도권 비행제한구역', kind: 'R', upper: '10,000ft AMSL(원문 확인 필요)', lower: 'SFC', authority: '수도방위사령부',
    remark: '수도권(서울) 비행제한구역. 진입 전 비행계획 통보·승인 여부를 AIP ENR 5.1 비고와 관할기관에서 확인', label: { lat: 37.5, lon: 127.06 }, color: '#e67e00',
    // RK R75 CAPITAL: 표의 점 순서대로 이어 마지막 점에서 처음 점으로 닫음
    poly: ring(['373949N 1264824E', '373752N 1264813E', '373701N 1264754E', '373530N 1264817E', '373409N 1264824E', '372653N 1265722E', '372653N 1270338E', '373233N 1270647E', '373447N 1270930E', '373656N 1270830E', '373827N 1270800E', '374033N 1270513E', '374136N 1270317E', '374200N 1270140E', '373758N 1265259E']),
    approx: '',
  },
  {
    id: 'P73', short: 'P-73', name: '서울 비행금지구역', kind: 'P', upper: 'UNL', lower: 'GND', authority: '수도방위사령부',
    remark: 'ENR 1.2 (RK P73 부근 비행절차) 참조', label: { lat: 37.5358, lon: 126.9772 }, color: '#8e24aa',
    poly: capsule(dms('373209N 1265838E'), dms('373232N 1265943E'), 2),
    approx: '',
  },
  {
    id: 'P518W', short: 'P-518W', name: '한반도 전술구역(서부)', kind: 'P', upper: 'UNL', lower: 'GND', authority: 'MCRC/FOC · VMC-IMC',
    remark: '비무장지대 서측 해상. 북방한계선(NLL) 구간은 표에 중간 좌표가 없어 두 지점을 직선으로 이은 근사', label: { lat: 37.75, lon: 125.0 }, color: '#8e24aa',
    poly: ring(['380000N 1240900E', '380000N 1245100E', '374255N 1260633E', '374213N 1260951E', '373900N 1261000E', '373000N 1255000E', '373000N 1243800E']),
    approx: '북방한계선(NLL) 구간은 직선 근사 — 경계 근처는 실제와 다를 수 있음',
  },
  {
    id: 'P518', short: 'P-518', name: '한반도 전술구역(휴전선 일대)', kind: 'P', upper: 'UNL', lower: 'GND', authority: 'MCRC/FOC · VMC-IMC',
    remark: '군사분계선과 아래 선 사이 구역. 민간회랑·인천공항 보호구역은 관제 IFR 항공기 전용이며 VFR(소방헬기)은 사용 불가',
    label: { lat: 38.05, lon: 127.0 }, color: '#8e24aa',
    // 남쪽 경계선은 AIP 좌표 그대로. 북쪽(군사분계선)은 좌표가 없어 북위 39°까지로 단순화(경로 판정에는 남쪽 경계만 쓰임)
    poly: [...ring(['373900N 1261000E', '374300N 1264100E', '373800N 1265300E', '375800N 1274000E', '380400N 1283100E', '380800N 1283200E', '381200N 1283600E']), { lat: 39.0, lon: 128.6 }, { lat: 39.0, lon: 126.1667 }],
    approx: '북쪽 경계(군사분계선)는 북위 39°로 단순화, 해안선 부분은 가장 가까운 지점으로 근사',
  },
  {
    id: 'P518E', short: 'P-518E', name: '한반도 전술구역(동부)', kind: 'P', upper: 'UNL', lower: 'GND', authority: 'MCRC/FOC · VMC-IMC',
    remark: '비무장지대 동측 해상', label: { lat: 38.45, lon: 128.6 }, color: '#8e24aa',
    poly: ring(['383800N 1282200E', '383800N 1283800E', '382200N 1284700E', '381600N 1283300E']),
    approx: '해안선 구간은 직선 근사',
  },
];
