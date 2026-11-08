# 헬기 운항기상 판단 도우미 (heli-wx)

상황실 **운항관제 담당자**가 출발지 → 목적지(현장)를 입력하면, 경로·출발지·목적지의 기상과 항공고시보(NOTAM)를 모아
**「119항공대 운영 규정」 제21조(비행제한)** 기준으로 **임무판단 조언**과 근거를 보여 줍니다.

> 본 시스템은 **조언용**입니다. 운항 여부는 통제관·기장이 최종 판단합니다(제21조① 단서, 제24조②).

## 1. 준비 (최초 1회)

1. **파이썬 3.9 이상**만 있으면 됩니다. 추가 설치(pip)는 필요 없습니다.
2. `config.local.example.json`을 `config.local.json`으로 복사하고 키를 입력합니다.
   ```json
   { "kmaAuthKey": "기상청 API허브 인증키", "kakaoJsKey": "카카오 JavaScript 키" }
   ```
   - `config.local.json`은 이 PC에만 둡니다. 공유·배포하지 않습니다.
3. **카카오 개발자 콘솔** → 내 애플리케이션 → 플랫폼 → Web → 사이트 도메인에 `http://localhost:8000`을 추가합니다.
4. (선택) 출발 기지 목록: `config.json`의 `"bases"`에 넣으면 드롭다운에 나타납니다.
   ```json
   "bases": [ { "name": "OO 항공대", "lat": 37.0000, "lon": 127.0000 } ]
   ```

## 2. 실행

```bash
python run.py
```
브라우저가 자동으로 `http://localhost:8000`을 엽니다. 종료는 창에서 `Ctrl+C`를 누릅니다.

- 시험 자료로 화면만 보기: `python run.py --mock`
- 포트 변경: `python run.py --port 8080` (이 경우 카카오 도메인도 같이 등록해야 합니다)

## 3. 사용 순서

1. 출발지: 기지를 선택하거나 장소를 검색합니다.
2. 목적지: 장소를 검색하거나 지도를 클릭합니다. 지도가 안 뜨면 [좌표 직접 입력]을 씁니다.
3. 출발 예정시각, 순항속도를 확인합니다. 주간/야간과 육상/해상은 자동으로 정해지고 바꿀 수 있습니다.
4. [xNotam 열기]로 조회한 결과를 **NOTAM 칸에 붙여넣습니다**.
5. **[판단 실행]**을 누릅니다. 종합 판정, 근거 표, 바람, NOTAM, 보고문이 나옵니다. **[보고문 복사]**로 상황 보고에 씁니다.

## 4. 판정 기준

| 구분 | 시정 미만 시 제한 | 운고 미만 시 제한 |
|---|---|---|
| 주간 육상 / 해상 | 3,200m / 4,800m | 1,000ft / 1,500ft |
| 야간 육상 / 해상 | 4,800m / 4,800m | 2,000ft / 2,000ft |

| 항목 | 🔴 규정상 비행제한 | 🟡 주의 | 근거 |
|---|---|---|---|
| 시정·운고 실황 (METAR·ASOS) | 기준 미만 | 기준의 1.5배 미만 | 제21조①1·2 |
| 공항 예보 TAF (출발~도착+30분) | 기본 예보가 기준 미만 | TEMPO·PROB 미달 | ①3 |
| 기상특보 | 태풍·강풍·풍랑·대설·호우 (경로 시군구 일치) | 같은 시·도 특보, 기타 특보 | ①4 |
| 낙뢰 (최근 30분, 경로 20km) | — | 경로 변경 검토 | ② |
| NOTAM (D 시리즈) | — | 경로 통과/5NM 이내 + 발효 | 제15조⑤ |
| 바람 | **판정 안 함**: 평균·순간최대·추세만 표시 | | 기종별 교범 |

- 자료가 없거나 오래되면(METAR·ASOS 90분, AWS 20분 초과) **⚪ 자료없음**으로 표시합니다. 절대 "가능"으로 처리하지 않습니다.
- 출발지·목적지의 시정 또는 운고 자료가 없으면 종합 판정도 ⚪입니다.
- 기준값은 `config.json`의 `limits`에 있습니다. 규정이 개정되면 이 값만 고치면 됩니다.

## 5. 장애 시

- 기상청 API 하나가 실패해도 나머지는 계속 판정합니다. 실패한 항목만 ⚪로 표시하고, 직전 자료가 있으면 "N분 전 자료"로 씁니다.
- 프로그램이 동작하지 않으면 화면 하단 **수동 확인 링크**(xNotam, 항공기상청, 기상특보)로 업무를 계속합니다.

## 6. 알려진 한계

- NOTAM은 자동 수집하지 않습니다(xNotam 공개 API 없음). 붙여넣기 방식입니다.
- 경로는 출발지와 목적지를 잇는 직선입니다.
- 특보구역은 행정구역 이름으로 맞춥니다. 산지/평지처럼 쪼개진 구역이나 해상 특보구역은 정확히 맞추지 못할 수 있어 🟡와 원문 확인으로 보완합니다.
- 저고도 중요기상예보(착빙·난기류)는 아직 반영하지 않았습니다(고도화 예정).

## 7. 실제 응답 형식 점검

기상청 응답 형식이 예상과 다르면 일부 항목이 ⚪로 나옵니다. 아래 명령으로 점검합니다.
```bash
python server/check_api.py
```
출력(인증키는 `****`로 가려짐)을 복사해 전달하면 해석기를 맞출 수 있습니다.

**PC가 없을 때 (휴대폰 브라우저로 확인):** 아래 주소의 `{KEY}`를 인증키로 바꿔 열고, 화면 내용을 **키를 지운 뒤** 전달합니다.
- 지상관측(ASOS): `https://apihub.kma.go.kr/api/typ01/url/kma_sfctm2.php?tm=&stn=108&help=1&authKey={KEY}`
- AWS 매분: `https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min?tm2=&stn=400&disp=0&help=1&authKey={KEY}`
- 특보현황: `https://apihub.kma.go.kr/api/typ01/url/wrn_now_data.php?fe=f&tm=&disp=1&help=1&authKey={KEY}`
- 낙뢰: `https://apihub.kma.go.kr/api/typ01/url/lgt_pnt.php?tm1=&tm2=&help=1&authKey={KEY}`
- 지점정보: `https://apihub.kma.go.kr/api/typ01/url/stn_inf.php?inf=SFC&stn=&help=1&authKey={KEY}`
- METAR: `https://apihub.kma.go.kr/api/typ02/openApi/AmmIwxxmService/getMetar?pageNo=1&numOfRows=10&dataType=JSON&icao=RKSS&authKey={KEY}`
- TAF: `https://apihub.kma.go.kr/api/typ02/openApi/AmmIwxxmService/getTaf?pageNo=1&numOfRows=10&dataType=JSON&icao=RKSS&authKey={KEY}`

## 8. 보안·데이터

- API 인증키는 PC의 `config.local.json`에만 저장되고, 브라우저 화면으로 전달되지 않습니다.
- 개인정보를 수집하지 않습니다. 처리 데이터는 공개 기상·항공정보뿐입니다.
- 조회 이력(`logs/history.csv`)에는 시각·출발·목적지·거리·종합판정만 기록합니다.

## 9. 개발·시험

```bash
npm test                                   # 판정·NOTAM·지리 계산 (node 22)
python -m unittest discover -s tests/py    # 기상청 응답 해석·서버
node tests/e2e/smoke.mjs                   # 화면 점검 (Playwright)
```
