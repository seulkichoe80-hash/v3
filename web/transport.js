// 출동 수단 비교: 헬기(접수→이륙 준비 + 비행) vs 구급차(도로 이동). 조언용이며 최종 판단은 통제관.
export function compareTransport({ prepMin, flightMin, overall, road, closeMin = 5, ambPrepMin = 0 }) {
  const heli = { prepMin, flightMin, totalMin: prepMin + flightMin };
  const amb = road && Number.isFinite(road.durationMin) ? { prepMin: ambPrepMin, roadMin: road.durationMin, totalMin: ambPrepMin + road.durationMin, distanceKm: road.distanceKm, source: road.source, note: road.note || '' } : null;
  const out = { heli, amb, diffMin: amb ? amb.totalMin - heli.totalMin : null, verdict: 'NONE', text: '', caution: [] };
  if (overall === 'RED') {
    out.verdict = 'AMBULANCE'; out.text = '헬기는 규정상 비행제한 — 구급차 이송 우선 검토 (제21조)';
  } else if (!amb) {
    out.verdict = 'NONE'; out.text = '구급차 이동시간을 구하지 못해 비교 불가 — 헬기 소요시간만 참고';
  } else if (out.diffMin >= closeMin) {
    out.verdict = 'HELI'; out.text = `헬기가 약 ${out.diffMin}분 빠름`;
  } else if (out.diffMin <= -closeMin) {
    out.verdict = 'AMBULANCE'; out.text = `구급차가 약 ${-out.diffMin}분 빠름`;
  } else {
    out.verdict = 'SIMILAR'; out.text = `소요시간 비슷(차이 ${Math.abs(out.diffMin)}분 미만) — 환자 상태·현장 여건으로 판단`;
  }
  if (overall === 'YELLOW' && out.verdict !== 'AMBULANCE') out.caution.push('헬기 기상 주의 항목 있음 — 근거 표 확인');
  if (overall === 'NA' && out.verdict !== 'AMBULANCE') out.caution.push('기상 자료 일부 없음 — 헬기 운항 가능 여부를 직접 확인');
  if (amb && amb.source === 'estimate') out.caution.push('구급차 시간은 직선거리 기반 추정(실제 도로·교통 반영 안 됨)');
  if (amb && amb.source === 'kakao') out.caution.push('구급차 시간은 일반 승용차 기준 길찾기 값(긴급주행·교통상황에 따라 달라짐)');
  return out;
}
