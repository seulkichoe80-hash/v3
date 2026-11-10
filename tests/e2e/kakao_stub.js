// 시험용 가짜 카카오맵 SDK: 장소검색·좌표→주소·행정구역·지도 객체를 흉내낸다.
(function () {
  const noop = function () {};
  function LatLng(lat, lng) { this.lat = lat; this.lng = lng; this.getLat = () => lat; this.getLng = () => lng; }
  window.__kk = [];
  function Obj() { this.setMap = noop; }
  const Rec = (name) => function (o) { this.setMap = noop; window.__kk.push({ name, o }); };
  const Status = { OK: 'OK', ZERO_RESULT: 'ZERO_RESULT', ERROR: 'ERROR' };
  const DB = [{ place_name: '아주대학교병원', y: '37.2790', x: '127.0466', road_address_name: '경기 수원시 영통구 월드컵로 164', address_name: '' },
              { place_name: '정부대전청사', y: '36.3612', x: '127.3845', road_address_name: '대전 서구 청사로 189', address_name: '' }];
  window.kakao = { maps: {
    load: (cb) => setTimeout(cb, 0), LatLng,
    Map: function () { this.addControl = noop; this.setBounds = noop; },
    ZoomControl: function () {}, ControlPosition: { RIGHT: 'R' },
    LatLngBounds: function () { this.extend = noop; },
    Polyline: Obj, CustomOverlay: Rec('CustomOverlay'), Circle: Rec('Circle'), Polygon: Obj,
    event: { addListener: (t, ev, fn) => { (window.__kl = window.__kl || {})[ev] = fn; } },
    services: { Status,
      Places: function () { this.keywordSearch = (q, cb) => { const r = DB.filter((d) => d.place_name.includes(q.replace(/\s/g, '').slice(0, 2))); setTimeout(() => cb(r, r.length ? Status.OK : Status.ZERO_RESULT), 10); }; },
      Geocoder: function () {
        this.coord2RegionCode = (x, y, cb) => setTimeout(() => cb([{ region_type: 'H', region_1depth_name: '경기도', region_2depth_name: '수원시 영통구' }], Status.OK), 5);
        this.coord2Address = (x, y, cb) => setTimeout(() => cb([{ address: { address_name: '테스트 주소' } }], Status.OK), 5);
      } } } };
})();
