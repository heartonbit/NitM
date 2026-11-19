# 테스트 계획

## 자동 테스트

```sh
npm test
npm run check
```

현재 단위 테스트는 다음 핵심 규칙을 검사한다.

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| T-01 | Worker health 요청 | 200 JSON `status=ok` |
| T-02 | 세션 없는 `/api/me` | 401 `authentication_required` |
| T-03 | Google OAuth 시작 | DB state 저장, callback URL 포함한 Google redirect와 HttpOnly state cookie 반환 |
| T-04 | 시간대 변환 | UTC와 Europe/Brussels 날짜/시각이 맞음 |
| T-05 | 최근 24시간 필터 | 경계 시각 포함, 오래됨/미래/날짜 누락 항목 제외 |
| T-06 | 원본 timezone 제목 시각 | article title의 표시 시각과 timezone이 feed 원문과 일치하며 변환되지 않음 |
| T-07 | 한국 관련 분류 | 제목에 직접 근거가 없는 요약문 내 부수적 한국 언급은 제외 |
| T-08 | 한국 기사 본문 | 추출 본문에서 nav/script/footer 제거, HTML 크기 제한 적용 |
| T-09 | 대량 기사 분할 | 크기 제한 내 여러 묶음으로 나누고 모든 항목을 보존 |
| T-10 | 출처 생성 | 각 기사 제목·원문 URL·출처명을 안전한 링크로 추가 |
| T-11 | 외부 URL 검증 | 정상 공개 주소 수락, localhost/자격 증명 URL 거부 |
| T-12 | 메일 Markdown HTML | 스크립트 문자열 이스케이프, HTTPS 링크만 렌더링 |
| T-13 | Worker 패키징 | Wrangler dry-run에서 Worker, Assets, D1 binding 생성 |

## 통합 수동 검증

1. 로컬 D1 migration을 적용하고 OAuth 환경변수와 redirect URI를 맞춰 Google 로그인한다.
2. 초대되지 않은 Google 계정은 세션을 받지 않고, 초대한 검증 계정은 대시보드에 진입하는지 확인한다.
3. 일반 사용자 세션으로 관리자 API에 접근하면 403인지, 본인 설정과 이력 외 접근이 막히는지 확인한다.
4. 관리자가 사용자 초대를 추가하면 초대 이메일과 초대 상태가 표시되는지 확인한다.
5. 뉴스 미디어 URL 검증, 비활성/활성, 추가·수정·삭제 및 감사 기록을 확인한다.
6. 유효한 LLM 설정과 테스트 Resend 주소로 **테스트 메일**을 실행한다. D1의 정규 일일 잠금이 생성되지 않아야 한다.
7. 시간대를 UTC로 두고 다음 분의 시각에 맞춘 뒤 Cron 또는 `/api/admin/run`으로 실행한다. lesson, run, 사용자별 delivery와 메일 본문을 확인한다.
8. 같은 날짜에 재실행하여 성공 수신자가 중복 메일을 받지 않는지 확인하고 실패한 수신자는 재시도되는지 확인한다.
9. 설정 시간을 다른 시간대로 변경하고 예약 시각이 현지 시간 기준으로 평가되는지 확인한다.
10. 30일 초과 레코드를 로컬 D1에 넣고 예약 실행을 호출해 만료 데이터가 정리되는지 확인한다.

## 배포 전 점검

- [ ] Remote D1에 최신 migration 적용
- [ ] `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `RESEND_API_KEY`, `LLM_API_KEY` 등록
- [ ] 부트스트랩 관리자와 검증 발신 주소 설정
- [ ] Google OAuth redirect URI / consent 화면 확인
- [ ] `/api/health` 응답 확인
- [ ] 테스트 요약 이메일 수신 확인
- [ ] 시간대 및 발송 시각 확인
- [ ] Cloudflare 로그·비용 알림 확인

Cloudflare 계정 권한과 외부 Google/Resend/LLM credentials가 필요한 통합 검증은 로컬 자동 테스트만으로 대체할 수 없다.