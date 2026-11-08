# 헬기 운항기상 판단 도우미 (heli-wx) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 상황실 운항관제 담당자가 출발 기지→목적지를 넣으면 기상·NOTAM을 모아 119항공대 운영 규정 제21조 기준 조언(🟢🟡🔴⚪)과 근거를 보여주는 로컬 웹앱.

**Architecture:** `python run.py`가 표준 라이브러리 HTTP 서버로 `web/` 정적 파일을 제공하고 `/api/*`로 기상청 API허브를 대리 호출·정규화(JSON)한다. 판정·NOTAM 해석·지리 계산은 브라우저 ES 모듈의 순수 함수로 두어 node 테스트로 검증한다. 지도·장소검색·행정구역은 카카오맵 JS SDK.

**Tech Stack:** Python 3 표준 라이브러리(http.server, urllib, unittest), 바닐라 JS ES 모듈, Node 22 `node --test`, 카카오맵 JS SDK(`libraries=services`), Playwright(화면 점검만).

**Spec:** `docs/superpowers/specs/2026-11-08-heli-wx-advisor-design.md`

## Global Constraints

- 파이썬 외부 패키지 금지(pip 설치 없이 실행). 브라우저 측 외부 라이브러리는 카카오맵 SDK만.
- API허브 인증키는 `config.local.json`에만, 브라우저로 절대 전달 금지. 카카오 **JavaScript 키**만 `/api/client-config`로 전달(도메인 제한 키).
- `config.local.json`, `logs/` 는 `.gitignore`.
- 등급 상수: `RED`, `YELLOW`, `GREEN`, `NA`(⚪). `NA`는 어떤 경우에도 `GREEN`으로 취급 금지.
- 기준값(미만이면 제한): 주간육상 3200m/1000ft, 주간해상 4800m/1500ft, 야간육상 4800m/2000ft, 야간해상 4800m/2000ft. 기준과 같으면 충족. 주의 구간 = 기준 이상 ~ 기준×1.5 미만.
- 유효시간: METAR·ASOS 90분, AWS 20분, 낙뢰 30분. 반경: METAR 30NM, ASOS 25km, 낙뢰 20km, NOTAM 근접 5NM.
- 바람은 판정 금지(정보만). TAF TEMPO·PROB 미달 = `YELLOW`, 기본·FM·BECMG 미달 = `RED`.
- 화면 문구 한국어. 🔴 시 단서 문구: "제21조① 단서 — 긴급운항 시 즉시 통제관 보고, 기종별 교범 운용한계 내에서 조종사 의견 청취 후 통제관 판단".
- 시간: 내부 UTC(ISO 문자열), 화면 KST.
- 사용자 실행 포트 8000.

## Review Focus

1. 기상청 응답이 예상과 다른 형식/빈 응답/HTML 오류페이지 → 해당 항목 `NA`, 서버 500 금지 (Task 3·4 테스트)
2. 결측값 `-9`, `-99.9` 등 → 값 없음 처리, 0으로 판정 금지 (Task 3 테스트)
3. NOTAM 여러 건이 줄바꿈·공백 뒤섞여 붙여넣어짐, 헤더(GG RKZZNAXX 등) 포함 → 건별 분리 (Task 2 테스트)
4. 출발지=목적지(거리 0) 또는 경로 주변 관측소 0개 → 오류 없이 `NA` "주변 관측소 없음" (Task 1·5 테스트)
5. 자정·월말을 넘는 B)/C), `PERM`/`EST` → 정확한 기간·발효 판정 (Task 2 테스트)

---

### Task 1: 뼈대 + 설정 + geo.js

**Files:**
- Create: `config.json`, `.gitignore`, `web/geo.js`, `tests/js/geo.test.mjs`, `package.json`(`{"type":"module","scripts":{"test":"node --test tests/js/"}}`)

**Interfaces:**
- Produces (`web/geo.js`):
  - `distanceKm(a:{lat,lon}, b:{lat,lon}) -> number` (haversine, R=6371.0088)
  - `KM_PER_NM = 1.852`
  - `pointToSegmentKm(p, a, b) -> number` (점-선분 최단거리, 등거리 근사 투영 허용)
  - `sampleRoute(a, b, stepKm=10) -> [{lat,lon}]` (양끝 포함)
  - `sunTimesUtc(lat, lon, dateUtc:Date) -> {sunrise:Date, sunset:Date}` (NOAA 근사)
  - `isNightDuring(fromLatLon, toLatLon, departUtc:Date, arriveUtc:Date) -> boolean` (출발지·목적지 중 어느 쪽이든 비행 구간이 일몰~일출에 걸치면 true)
- Produces (`config.json`): `{ "limits": {"day":{"land":{"visM":3200,"ceilFt":1000},"sea":{"visM":4800,"ceilFt":1500}},"night":{"land":{"visM":4800,"ceilFt":2000},"sea":{"visM":4800,"ceilFt":2000}},"cautionFactor":1.5,"basis":"119항공대 운영 규정 제21조①" }, "radius":{"metarNm":30,"asosKm":25,"lightningKm":20,"notamNearNm":5}, "freshnessMin":{"metar":90,"asos":90,"aws":20,"lightning":30}, "cruiseKt":110, "bases":[], "airports":[{"icao":"RKSI","name":"인천","lat":37.4602,"lon":126.4407}, ...] }`
  - `airports`: RKSI 인천, RKSS 김포, RKPC 제주, RKPK 김해, RKTN 대구, RKTU 청주, RKNY 양양, RKNW 원주, RKJB 무안, RKJJ 광주, RKJY 여수, RKPU 울산, RKTH 포항, RKPS 사천, RKJK 군산 (좌표는 AIP 기준 소수 4자리)
  - `bases`: 빈 배열(사용자가 기지 좌표 제공 시 채움, `{name,lat,lon}`). 화면은 빈 경우 출발지도 검색으로 받는다.

- [ ] Step 1: 테스트 작성 — `distanceKm(서울시청 37.5663,126.9779 → 부산시청 35.1798,129.0750)` ≈ 325±3km; `pointToSegmentKm` 선분 위 점=0, 끝점 바깥 점=끝점까지 거리; `sampleRoute` 같은 점 입력 시 길이 1, 100km 경로 step 10 → 11점; `sunTimesUtc(37.57,126.98, 2026-11-08)` 일출 KST 07:00±10분, 일몰 KST 17:25±10분; `isNightDuring` 서울 KST 16:50→17:40 true, 12:00→12:30 false.
- [ ] Step 2: `npm test` → FAIL(모듈 없음)
- [ ] Step 3: `web/geo.js` 구현, `config.json`·`.gitignore`(`config.local.json`, `logs/`, `node_modules/`) 작성
- [ ] Step 4: `npm test` → PASS
- [ ] Step 5: commit `feat: 설정과 지리 계산 모듈`

### Task 2: NOTAM 해석기 `web/notam.js`

**Files:** Create `web/notam.js`, `tests/js/notam.test.mjs`, `tests/fixtures/notam_d2840.txt`(스펙 6장 예시 원문 + 헤더 `GG RKZZNAXX`/`210500 RKRRYNYX` 포함)

**Interfaces:**
- Consumes: `geo.js` `pointToSegmentKm`, `KM_PER_NM`
- Produces:
  - `splitNotams(text) -> string[]` (각 건 `X1234/26 NOTAM[NRC]` 시작 기준 분리, 앞 헤더 무시)
  - `parseNotam(raw) -> {id, series, kind, qcode, qcodeText, center:{lat,lon}|null, radiusNm|null, geomSource:'E'|'Q'|null, start:Date|null, end:Date|null, endPerm:boolean, endEst:boolean, lower:string, upper:string, text:string, needsPermission:boolean, phones:string[], parseError:string|null, raw}`
  - `assessNotam(n, routeA, routeB, departUtc, arriveUtc, nearNm=5) -> {...n, inScope:boolean, distanceNm|null, relation:'CROSS'|'NEAR'|'CLEAR'|'UNKNOWN', activeDuringFlight:boolean|null, grade:'YELLOW'|'GREEN'|'NA'}`
    - `inScope = series==='D'`; 범위 밖은 grade `GREEN`·화면에서 접기.
    - distance = 선분-중심 거리(NM) − 반경; ≤0 CROSS, ≤nearNm NEAR, 그 외 CLEAR. center 없으면 UNKNOWN & `NA`.
    - grade: inScope && (CROSS|NEAR) && activeDuringFlight → `YELLOW`; 파싱오류 → `NA`.
- Q-code 표: `QRPCA` 비행금지구역 활성, `QRRCA` 제한구역 활성, `QRDCA` 위험구역 활성, `QWULW` 무인기 비행, `QOBCE` 장애물 설치, `QWPLW` 낙하산 강하, 그 외는 코드 그대로.
- 좌표: E) `(\d{6})N(\d{7})E` 도분초 + `RADIUS ([\d.]+)\s*NM`; 실패 시 Q-line `(\d{4})N(\d{5})E(\d{3})` 도분+반경NM.
- 시간: B)/C) `YYMMDDhhmm` → UTC Date. `PERM` → end null & endPerm. 뒤에 `EST` → endEst true.
- 사전허가: E)에 `FIRE FIGHTING|EMERG|PRIOR PERMISSION|PPR` → true; 전화 `\d{2,3}-\d{3,4}-\d{4}`.

- [ ] Step 1: 테스트 — 픽스처: id `D2840/26`, series `D`, qcode `QRPCA`, center 37+35/60+23/3600, 126+58/60+32/3600 (±1e-6), radiusNm 2, geomSource 'E', start `2026-09-26T15:00:00Z`, end `2026-12-26T14:59:00Z`, lower 'SFC', upper 'FL600', needsPermission true, phones ['02-524-0315']. E) 좌표 줄 삭제 버전 → geomSource 'Q', radiusNm 3. 두 건 붙여넣기(D건+`A1234/26` 건, 사이 빈 줄 여러 개) → splitNotams 길이 2, 두 번째 inScope false. `C)PERM` → endPerm. `C)2612261459EST` → endEst. 쓰레기 텍스트 → parseError 존재, grade `NA`. assessNotam: 김포(37.5583,126.7906)→서울역(37.5547,126.9707) 경로, 비행 2026-11-09 → CROSS 또는 NEAR, active true, YELLOW; 같은 경로 비행 2027-01-10 → active false, GREEN.
- [ ] Step 2: `npm test` → FAIL
- [ ] Step 3: 구현
- [ ] Step 4: `npm test` → PASS
- [ ] Step 5: commit `feat: NOTAM 해석기(D시리즈, E) 우선 좌표)`

### Task 3: 기상청 응답 파서 `server/parsers.py`

**Files:** Create `server/__init__.py`, `server/parsers.py`, `tests/py/test_parsers.py`, `tests/fixtures/kma/{asos.txt,aws.txt,stn_sfc.txt,stn_aws.txt,warn.txt,lgt.txt,metar.txt,taf.txt}` (API허브 도움말 형식 기준 샘플. 사용자가 실제 응답 제공 시 교체)

**Interfaces:**
- Produces:
  - `parse_table(text, columns:list[str]|None=None) -> list[dict[str,str]]` — `#` 주석 줄 무시, 공백/쉼표 구분 자동, `#START7777`/`#7777END` 허용. columns 없으면 마지막 `#` 헤더 줄에서 이름 추출.
  - `num(s) -> float|None` — `-9`, `-99`, `-99.9`, `-999`, `''`, 비숫자 → None.
  - `parse_asos(text, stations:dict) -> list[dict]` → `{stn,name,lat,lon,obsTime(ISO UTC),visM,ceilFt|None,cloudTenths,windDir,windMs,gustMs}`; 컬럼: `TM STN WD WS GST_WD GST_WS ... CA_TOT ... CH_MIN ... VS` (VS 10m 단위→m, CH_MIN 100m 단위→ft, 전운량 <6이면 ceilFt None). TM은 KST → UTC 변환.
  - `parse_stations(text) -> dict[str, {name,lat,lon}]` (stn_inf: `STN_ID LON LAT ... STN_KO`)
  - `parse_aws(text, stations) -> list[{stn,name,lat,lon,obsTime,windDir,windMs,gustMs|None}]` (컬럼 `YYMMDDHHMI STN WD1 WS1 WDS WSS WD10 WS10 ...`; 평균은 WD10/WS10, 순간 WSS)
  - `parse_warn(text) -> list[{regUp,regUpName,regId,regName,tmFc,tmEf,kind,level,cmd}]` (컬럼 `REG_UP REG_KO_UP REG_ID REG_KO TM_FC TM_EF WRN LVL CMD ED_TM`)
  - `parse_lightning(text) -> list[{time,lat,lon}]`
  - `extract_reports(text, kind:'METAR'|'SPECI'|'TAF') -> list[str]` — XML/JSON/텍스트 어디서든 `(METAR|SPECI|TAF)( COR| AMD)? RK\w{2} .*?=` 원문 추출(공백 정규화)
  - `parse_metar(raw, airports) -> {icao,name,lat,lon,obsTime,visM,ceilFt|None,windDir,windKt,gustKt,raw}` — `CAVOK`→visM 10000 & ceil None; `9999`→10000; `BKN|OVC|VV`최저 ×100ft; 기준 달·연은 현재 UTC로 보정.
  - `parse_taf(raw, airports) -> {icao,name,lat,lon,issued,validFrom,validTo,groups:[{type:'BASE'|'FM'|'BECMG'|'TEMPO'|'PROB',from,to,visM|None,ceilFt|None}],raw}` — 그룹에 시정·운고 없으면 직전 BASE/FM 값 상속하지 않고 None(판정은 None 무시).
- 실패 규칙: 어떤 파서도 예외를 밖으로 던지지 않는다. 해석 불가 행은 건너뛰고 빈 리스트 가능.

- [ ] Step 1: 테스트 — `num('-9') is None`; ASOS 샘플 VS `150`→1500m, CH_MIN `8`, CA_TOT `7`→ceilFt 2625(8×100m→ft, 반올림), CA_TOT `3`→None; METAR `METAR RKSS 080600Z 32012G25KT 2500 BR BKN008 OVC020 12/10 Q1015=` → visM 2500, ceilFt 800, gustKt 25; `CAVOK` 케이스; TAF `TAF RKSS 080500Z 0806/0912 31010KT 6000 BKN030 TEMPO 0809/0812 2000 BR BKN008 FM090300 9999 SCT040=` → groups BASE(6000,3000), TEMPO(2000,800, 08 09Z~12Z), FM(10000,None); HTML 오류페이지 입력 → 모든 파서 `[]`; warn 샘플 강풍주의보 1건 파싱.
- [ ] Step 2: `python3 -m unittest discover -s tests/py` → FAIL
- [ ] Step 3: 구현
- [ ] Step 4: 테스트 → PASS
- [ ] Step 5: commit `feat: 기상청 API허브 응답 파서`

### Task 4: 중계 서버 `server/kma.py` + `run.py`

**Files:** Create `server/kma.py`, `run.py`, `tests/py/test_server.py`, `config.local.example.json` (`{"kmaAuthKey":"","kakaoJsKey":""}`)

**Interfaces:**
- Consumes: Task 3 파서, `config.json`
- Produces (HTTP, 모두 `{"items":[...], "fetchedAt":ISO, "stale":bool, "ageMin":int|null, "error":str|null}`):
  - `GET /api/client-config` → `{kakaoJsKey, config}` (config.json 내용; API허브 키 미포함)
  - `GET /api/metar`, `/api/taf`, `/api/asos`, `/api/aws`(현재 + 10분 전 두 번 조회해 `windMs10ago` 병합), `/api/warn`, `/api/lightning`(최근 30분)
  - `POST /api/log` body `{from,to,overall,distanceKm}` → `logs/history.csv` 한 줄 추가(`timestampKST,from,to,distanceKm,overall`)
  - 정적: `/` → `web/index.html`, `/web/*`
- `class KmaClient(auth_key, fetch=urllib_fetch, now=utcnow)`:
  - `get(kind) -> dict` 위 응답형. 5분 캐시. fetch 실패/타임아웃(5초) 시 캐시 있으면 `stale:true`+ageMin, 없으면 `items:[]`+error.
  - URL(기본 `https://apihub.kma.go.kr/api/typ01/url/` · `.../typ01/cgi-bin/url/` · `.../typ02/openApi/`): `kma_sfctm2.php?tm=&stn=0&help=0`, `stn_inf.php?inf=SFC&help=0`, `stn_inf.php?inf=AWS&help=0`, `nph-aws2_min?tm2=YYYYMMDDHHmm&stn=0&disp=0&help=0`, `wrn_now_data.php?fe=f&tm=&disp=0&help=0`, `lgt_pnt.php?tm1=&tm2=&help=0`, `AmmIwxxmService/getMetar?pageNo=1&numOfRows=100&dataType=JSON`, `AmmIwxxmService/getTaf?...`. 모든 URL에 `authKey` 추가. URL 템플릿은 `server/kma.py` 상단 상수 `ENDPOINTS` 한곳에 모아 실제 응답 확인 후 수정 용이하게.
  - METAR/TAF 공항 지정 파라미터가 필요하면 `config.airports` 각 ICAO 반복 호출.
- `run.py`: `python run.py [--port 8000] [--mock]`; `--mock`이면 fetch가 `tests/fixtures/kma/*` 반환. 시작 시 브라우저 열기(`webbrowser.open`), config.local.json 없으면 예제 복사 안내 후 종료 코드 1.

- [ ] Step 1: 테스트 — 가짜 fetch로: 정상 → items>0; 두 번째 호출은 fetch 미호출(캐시); fetch 예외 + 캐시 있음 → stale true; fetch 예외 + 캐시 없음 → items [] & error; `/api/client-config` 응답 문자열에 kmaAuthKey 값이 포함되지 않음; `/api/log` 후 CSV 1행.
- [ ] Step 2: FAIL 확인
- [ ] Step 3: 구현(ThreadingHTTPServer)
- [ ] Step 4: PASS 확인 + `python run.py --mock` 기동 후 `curl localhost:8000/api/asos` items>0
- [ ] Step 5: commit `feat: 기상청 중계 서버와 실행 스크립트`

### Task 5: 판정 엔진 `web/judge.js`

**Files:** Create `web/judge.js`, `tests/js/judge.test.mjs`

**Interfaces:**
- Consumes: `geo.js`, `notam.js` `assessNotam`, 서버 정규화 JSON
- Produces:
  - `limitsFor(config, isNight, isSea) -> {visM, ceilFt}`
  - `gradeValue(value|null, limit, factor=1.5) -> 'RED'|'YELLOW'|'GREEN'|'NA'` (null→NA, <limit RED, <limit×factor YELLOW)
  - `worst(grades[]) -> grade` (순서 RED>YELLOW>NA>GREEN; 빈 배열 NA)
  - `evaluate(input) -> result`
    - input: `{from:{name,lat,lon}, to:{name,lat,lon}, departUtc:Date, cruiseKt, isNight, isSea, data:{metar,taf,asos,aws,warn,lightning}, notams:parsed[], routeRegions:[{sido,sigungu}], now:Date, config}`
    - result: `{overall, overallNote, distanceKm, distanceNm, durationMin, arriveUtc, limits, rows:[{segment:'출발지'|'경로'|'목적지', item, value, limit, grade, source, obsTime, note}], wind:[{segment,stn,name,windDir,windMs,gustMs,trend:'증가'|'감소'|'유지'|null,obsTime}], notams:assessed[], hasNA:boolean, reportText}`
  - 규칙: 스펙 5.2·5.3 그대로. 구간별 관측소 선택(출발지/목적지 = 반경 내 최근접 1개씩 METAR·ASOS, 경로 = 선분 반경 내 전부 → 항목별 최악값과 해당 관측소). 유효시간 초과 관측은 `NA`("자료 오래됨"). TAF는 [출발, 도착+30분]과 겹치는 그룹만. 특보: `routeRegions`의 시군구명이 `regName`에 포함되면 매칭, 시도만 일치하고 시군구 불일치면 YELLOW "특보구역 확인 필요"; 종류 `태풍|강풍|풍랑|대설|호우` → RED, 기타 → YELLOW. 낙뢰: 유효시간 내 & 경로 20km 이내 존재 → YELLOW "경로 변경 검토(제21조②)". 종합 산정: RED/YELLOW가 있으면 그 최악값. 없을 때 **출발지·목적지의 시정 또는 운고가 NA면 overall `NA`**("핵심 기상자료 없음 — 직접 확인"), 그 외 NA만 있으면 overall `GREEN` + overallNote "단, 일부 자료 확인 필요"(스펙 5.3). RED → overallNote 단서 문구(Global Constraints).
  - `reportText` 예: `[운항기상 조언] 김포→서울역 15km/5분(도착 14:35) | 종합: 주의 | 목적지 시정 8000m·운고 3000ft 적합 | 특보: 없음 | NOTAM 1건 경로 통과(D2840/26, 사전허가 CDC 02-524-0315) | 바람(목적지) 북서 6m/s 순간 11m/s` — 항목 구분자 ` | `.
- [ ] Step 1: 테스트 — `gradeValue(3199,3200)`=RED, `(3200,3200)`=YELLOW, `(4800,3200)`=GREEN, `(null,..)`=NA; limitsFor 4조합; `worst([])`=NA, `worst(['GREEN','NA'])`=NA; evaluate 시나리오: (a) 관측소 0개 → 시정·운고 행 NA, overall `NA`; (a2) 핵심자료 정상·낙뢰 자료만 NA → overall GREEN + overallNote "단, 일부 자료 확인 필요", (b) 목적지 METAR 시정 2500 주간육상 → overall RED & overallNote 단서 포함, (c) TAF TEMPO만 미달 → YELLOW, (d) 강풍주의보 경로 시군구 일치 → RED, (e) 오래된 METAR(100분 전) → NA, (f) 바람 강해도 grade 영향 없음, (g) 출발=목적지 → distance 0, 예외 없음.
- [ ] Step 2: FAIL
- [ ] Step 3: 구현
- [ ] Step 4: PASS
- [ ] Step 5: commit `feat: 제21조 판정 엔진`

### Task 6: 화면 `web/index.html` + `web/app.js`

**Files:** Create `web/index.html`, `web/app.js`, `web/style.css`, `tests/e2e/smoke.mjs`

**Interfaces:**
- Consumes: `/api/client-config`, `/api/*`, `geo.js`, `notam.js`, `judge.js`
- 구성(스펙 7장): 좌측 입력 패널(출발 기지 select 또는 검색, 목적지 검색+지도클릭, 출발시각 `datetime-local` 기본 현재 KST, 순항속도 kt, 주간/야간 자동+토글, 육상/해상 자동제안+토글, NOTAM textarea, [판단 실행]), 우측 지도, 하단 결과(종합 신호등·요약, 경로정보, 근거 표, 바람 카드, NOTAM 목록 D만 펼침, [보고문 복사], 수동 확인 링크 고정: `https://aim.koca.go.kr/xNotam/index.do?type=search2&language=ko_KR`, `https://amo.kma.go.kr/`, `https://www.weather.go.kr/w/special-report/overall.do`).
- 카카오: SDK `https://dapi.kakao.com/v2/maps/sdk.js?appkey={key}&libraries=services&autoload=false` 동적 로드. 로드 실패 시 지도 영역에 "카카오맵 로드 실패 — 도메인 등록(localhost:8000) 확인" 표시하고 위·경도 직접 입력 칸 노출(판정은 계속 가능).
- 경로 시군구: `sampleRoute` 점마다 `geocoder.coord2RegionCode`(H 타입) → 중복 제거. 결과 없음(해상) 비율>0 이면 육상/해상 토글을 해상으로 제안(사용자 변경 가능).
- [판단 실행] 시 6개 API 병렬 호출(Promise.allSettled) → evaluate → 렌더 → `POST /api/log`.
- 지도: 경로 Polyline, 관측소 원형 마커(등급색), NOTAM Circle(반경 NM→m), 낙뢰 점.
- [ ] Step 1: `tests/e2e/smoke.mjs` 작성 — `python run.py --mock --port 8010` 기동 후 Playwright로 열기, 카카오 로드 실패 경로로 위·경도 직접 입력(김포→서울역), 픽스처 NOTAM 붙여넣기, 실행 → 종합 신호등 요소 존재, NOTAM 목록에 `D2840/26` 표시, 보고문 텍스트에 `D2840/26` 포함, 콘솔 에러 0.
- [ ] Step 2: 실행 → FAIL
- [ ] Step 3: 구현
- [ ] Step 4: 실행 → PASS, 스크린샷 `docs/screens/mock.png`(deviceScaleFactor 2) 저장
- [ ] Step 5: commit `feat: 운항관제 화면`

### Task 7: 실제 응답 점검 도구 + 사용 설명서

**Files:** Create `server/check_api.py`, `README.md`

- `python server/check_api.py` → 각 ENDPOINT 호출, 상태코드·응답 앞 40줄 출력, 출력 내 인증키 문자열은 `****`로 치환, 파서 결과 건수 표시(0건이면 "형식 확인 필요").
- `README.md`(한국어): 설치(파이썬만), `config.local.json` 작성법, 카카오 도메인 등록, 실행, 판정 기준과 조문, 한계(조언 도구·최종판단은 사람), 장애 시 수동 확인 링크, 휴대폰 브라우저로 API 응답 확인하는 URL 목록(키 자리 `{KEY}`).
- [ ] Step 1: 키 마스킹 테스트 — 응답에 키 포함된 가짜 fetch → 출력에 키 없음
- [ ] Step 2: FAIL → Step 3 구현 → Step 4 PASS
- [ ] Step 5: commit `feat: API 점검 도구와 사용 설명서`

### Task 8 (여유 시): 저고도 중요기상예보 `amo_sigwx.php`

- 실제 응답 형식 확인 후 진행(형식 미확인 시 보고서 고도화 계획으로 이연). 착빙·난기류 구역이 경로를 지나면 YELLOW(제21조④⑥). 파서 `parse_sigwx(text) -> [{kind:'ICE'|'TURB', polygon:[{lat,lon}], validFrom, validTo}]`, `/api/sigwx`, judge 행 추가.
