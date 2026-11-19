# 보안 설계

## 인증과 접근 제어

- Worker가 Google OAuth Authorization Code flow를 처리한다. 무작위 state는 D1과 HttpOnly cookie 양쪽에 저장해 callback에서 대조하고 한 번 사용 후 삭제한다.
- Google UserInfo의 검증된 이메일만 사용한다. D1의 초대/기존 사용자 또는 `BOOTSTRAP_ADMIN_EMAIL`인지 확인한 뒤 사용자 문서를 생성한다.
- 세션 토큰은 암호학적으로 안전한 난수로 만들고 원문은 HttpOnly/SameSite=Lax cookie에만 전달한다. D1에는 SHA-256 해시와 30일 만료 시각만 저장한다.
- 관리자 여부는 `admins` 테이블을 서버에서 조회한다. 브라우저가 보내는 관리자 플래그를 신뢰하지 않는다.
- 일반 사용자의 history 쿼리는 현재 D1 세션의 사용자 ID로 제한한다. 전체 수신자/본문은 관리자 API만 반환한다.
- OAuth redirect URI는 정확한 Worker hostname의 `/auth/callback`으로 제한한다. Client secret은 Cloudflare Worker secret으로 관리한다.

## 요청과 입력

- 변경 요청은 브라우저의 동일 출처 `Origin` 헤더를 확인한다.
- 초대 이메일, 소스 ID/이름/정렬, URL, 시간대, 시간, 요약 언어, LLM URL을 서버에서 검증한다.
- D1 값은 바인드 파라미터를 쓴다. SQL 식별자가 필요한 설정 키는 코드의 고정 목록만 사용한다.
- Worker와 D1 간 TLS 및 Cloudflare 플랫폼 접근 통제를 사용한다. API 응답은 `no-store`로 캐시를 금지한다.

## SSRF와 콘텐츠 안전

- RSS/Atom과 LLM Base URL은 HTTP(S)만 허용하고 userinfo, loopback, 사설/링크 로컬 주소를 차단한다.
- RSS 리다이렉트를 수동으로 최대 3회 따라가며 각 목적지를 재검증한다. 응답 크기는 1MB, 후보는 소스당 3개로 제한한다.
- 요약 프롬프트는 뉴스 텍스트를 비신뢰 데이터로 취급하며 데이터 안의 지시를 무시하도록 명시한다.
- 이메일 본문 HTML 렌더러는 본문 텍스트를 이스케이프하고 Markdown 링크의 HTTP(S)만 허용한다. UI의 본문 조회는 `textContent`를 쓴다.

## 비밀과 개인정보

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `RESEND_API_KEY`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`은 `wrangler secret put`으로 등록한다. LLM endpoint/model도 Worker secrets에서만 읽으며 D1, 설정 API 응답, 브라우저 자산에 저장하거나 반환하지 않는다.
- 발신자와 최초 관리자 주소는 비밀이 아닌 배포 설정이다.
- 이메일 주소는 사용자·전송 기록에 저장된다. 전달 스냅샷은 수신자에게 표시되지 않고 관리자만 읽는다.
- 로그에는 원시 예외 본문이나 API 키를 남기지 않는다. 실패 코드를 축약해 runs/deliveries에 기록한다.
- 오래된 업무 데이터는 30일 보관 정책에 따라 자동 삭제한다. D1 백업/복구 보존은 Cloudflare 계정 정책과 별도로 검토한다.

## 운영 전 강화

- Cloudflare dashboard에서 도메인별 WAF/rate limit 규칙을 설정한다. 특히 `/auth/google`, `/auth/callback`, `/api/admin/*` 및 POST 엔드포인트를 보호한다.
- Google OAuth Consent Screen을 내부/외부 배포에 맞게 게시하고 authorized redirect URI를 정확히 등록한다.
- Resend 발신 도메인 검증 후 `MAIL_FROM`을 검증된 발신 주소로 바꾼다.
- 주기적으로 D1 관리자 목록과 세션을 점검하고, 초대 사용자 제한과 Worker 비용 알림을 설정한다.