// 규정 원문 기반 안내(제21조 기준표, 제22조 특수조건 확인표)와 설정값 표시. 판정 등급에는 영향을 주지 않는다.
export const msToKt = (ms) => (ms === null || ms === undefined || Number.isNaN(ms) ? null : Math.round(ms * 1.94384));

const SEG = (l, s) => `시정 ${s.visM}m · 운고 ${s.ceilFt}ft`;

// 판정 기준표: '규정(조문)'과 '시스템 설정값(규정 아님, config.json에서 변경)'을 나눠서 보여준다.
export function criteriaTable(config) {
  const L = config.limits, r = config.radius, f = config.freshnessMin;
  const reg = [
    { label: '주간 · 육상', value: SEG('', L.day.land), basis: '제21조①1' },
    { label: '주간 · 해상', value: SEG('', L.day.sea), basis: '제21조①1' },
    { label: '야간 · 육상', value: SEG('', L.night.land), basis: '제21조①2' },
    { label: '야간 · 해상', value: SEG('', L.night.sea), basis: '제21조①2' },
    { label: '제한 조건', value: '기준 미만이면 비행 제한(시정·운고). 항로·목적지에서 기준 이하로 감소할 우려, 기상특보(태풍·강풍·풍랑·강설·강우·악시정·요란기류) 발령 시 제한', basis: '제21조①' },
    { label: '뇌우·착빙', value: '비행경로에 뇌우가 있거나 예상되면 경로 변경, 착빙 지역은 회피', basis: '제21조②④' },
    { label: '풍속', value: '기종별 교범 적용(시스템은 판정하지 않고 값만 표시)', basis: '제21조①' },
    { label: '주간·야간', value: '주간=일출~일몰, 야간=일몰~다음 날 일출 전', basis: '제2조 17·18호' },
    { label: '긴급운항', value: '제한 조건이어도 통제관 보고 후 조종사 의견을 들어 통제관이 판단', basis: '제21조① 단서' },
  ];
  const set = [
    { label: '주의 구간', value: `규정 기준의 ${L.cautionFactor}배 미만(기준 이상이어도 근접하면 "주의")` },
    { label: 'TAF 일시 악화', value: 'TEMPO·PROB 그룹이 기준 미만이면 "주의", 기본·FM·BECMG가 미만이면 "제한" (비행 시간 + 도착 후 30분)' },
    { label: '자료 유효시간', value: `METAR·ASOS ${f.metar}분, AWS ${f.aws}분, 낙뢰 ${f.lightning}분 초과 시 "자료없음"` },
    { label: '관측소 반경', value: `METAR ${r.metarNm}NM, ASOS ${r.asosKm}km 이내를 경로 판정에 사용(구간 내 최악값)` },
    { label: '낙뢰', value: `최근 ${f.lightning}분, 경로 ${r.lightningKm}km 이내 → "주의"(경로 변경 검토)` },
    { label: 'NOTAM', value: `D 시리즈, 경로 통과(완충구역 BUFFER ZONE 포함) 또는 가장 바깥 경계에서 ${r.notamNearNm}NM 이내 + 비행 시간대 발효 → "주의"` },
    { label: '기상특보 구분', value: '태풍·강풍·풍랑·대설·호우(주의보 이상)가 경로 시군구와 일치하면 "제한", 같은 시·도 또는 기타 특보는 "주의"' },
    { label: '운고(ASOS)', value: '층별 구름 자료가 없어 "중하층 운량 6/10 이상"일 때 최저운고를 운고로 근사(규정은 가장 낮은 구름층이 5/8 이상일 때). 중하층 운량이 없고 전운량 6/10 이상이면 "자료없음"' },
    { label: '순항속도', value: `기본 ${config.cruiseKt}kt (입력 변경 가능)` },
  ];
  return { regulation: reg, settings: set };
}

// 제22조 특수조건 확인표(야간·해상). 규정 원문을 그대로 옮긴 것이며 판정에는 반영하지 않는다.
const PROVISO = '제17조에 따른 긴급운항의 경우 즉시 통제관에게 보고하고 기종별 교범에 명시된 운용한계 내에서 조종사의 의견을 들어 통제관의 판단하에 비행하게 할 수 있음';
export function art22Items({ isNight, isSea }) {
  const out = [];
  if (isNight) out.push({ title: '제22조① 야간 운항 조건', proviso: PROVISO, items: [
    '운항구간의 기상상태가 비행에 영향을 미치지 않을 것',
    '항공기: 「항공안전법 시행규칙」 제117조제2항을 준용한 항공계기 및 조명설비가 갖춰져야 하며 통신장비가 정상일 것',
    '수색구조 임무를 위해서는 야간투시경을 갖출 것',
    '착륙장에는 조명시설을 갖추거나 식별이 가능한 지상조명지원이 가능할 것'] });
  if (isSea) {
    out.push({ title: '제22조④ 해상비행 조건', items: [
      '회전익 항공기 부양장치 및 계기비행 장비장착',
      '탑승자 전원 항공용 구명조끼 및 비상탈출호흡기 착용',
      '항공대원 전원 체온보호용 슈트 착용(통제관 또는 항공대장이 종합적으로 판단해 착용하지 않도록 할 수 있음)',
      '항공대원 해상생환교육 이수'] });
    out.push({ title: '제22조⑤ 앞바다·내수면 임무 조건', items: [
      '육지로부터 자동회전 착륙거리를 벗어나 앞바다를 비행하는 경우, 또는 내수면에서 인명구조·담수임무인 경우: 항공용 구명조끼 및 비상탈출호흡기를 착용하고 구명보트를 갖출 것'] });
  }
  return out;
}
