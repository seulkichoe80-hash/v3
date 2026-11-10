import test from 'node:test';
import assert from 'node:assert/strict';
import { isLand, isOpenSea, routeOverSea } from '../../web/landmask.js';
const P = (name, lat, lon) => ({ name, lat, lon });
test('주요 지점 육지/바다', () => {
  for (const [n, la, lo] of [['서울', 37.5665, 126.978], ['부산', 35.18, 129.07], ['제주', 33.4996, 126.5312], ['울릉도', 37.5, 130.87], ['포항 영일대', 36.0551, 129.3782], ['대전', 36.35, 127.38]]) assert.ok(isLand(la, lo), n + ' 육지');
  for (const [n, la, lo] of [['동해 한가운데', 37.0, 130.0], ['서해 먼바다', 36.0, 124.0], ['남해 먼바다', 32.5, 128.5]]) assert.ok(isOpenSea(la, lo), n + ' 바다');
});
test('울릉도 → 포항(영일대) 경로는 해상', () => {
  const r = routeOverSea([P('울릉도', 37.5062, 130.8604), P('영일대', 36.0551, 129.3782)]);
  assert.ok(r.sea && r.seaPoints > 10, JSON.stringify(r));
});
test('내륙·연안 육상 경로는 육상', () => {
  assert.equal(routeOverSea([P('김포', 37.5583, 126.7906), P('서울역', 37.5547, 126.9707)]).sea, false);
  assert.equal(routeOverSea([P('대전', 36.35, 127.38), P('수원 아주대', 37.279, 127.0466)]).sea, false);
  assert.equal(routeOverSea([P('경남119항공대', 35.5545, 128.1159), P('아주대병원', 37.279, 127.0466)]).sea, false);
});
test('섬을 오가는 경로: 제주 → 부산은 해상', () => {
  assert.ok(routeOverSea([P('제주', 33.4996, 126.5312), P('부산', 35.18, 129.07)]).sea);
});
