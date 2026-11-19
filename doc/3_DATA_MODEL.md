# 데이터 모델 및 API

## D1 테이블

| 테이블 | 용도 | 주요 필드 |
|---|---|---|
| `users` | 로그인 사용자 및 수신 상태 | `id`, `email`, `name`, `subscribed`, 생성/수정 UTC 시각 |
| `invites` | 이메일 초대 및 전송 상태 | `email`, `note`, `invited_by`, `email_sent_at` |
| `admins` | 관리자 권한 | `email`, `created_at` |
| `sources` | RSS/Atom 미디어 설정 | `id`, `name`, `url`, `enabled`, `sort_order` |
| `settings` | 발송 일정 | `timezone`, `send_time` |
| `lessons` | 날짜별 생성 브리핑 | `date`, `title`, `markdown`, `sources_json`, `requested_model`, `response_model` |
| `deliveries` | 발송 시점의 메일 스냅샷 | `date`, `user_id`, `recipient_email`, `status`, `subject`, `body`, 시각 |
| `runs` | 예약/수동 실행 요약 | `date`, `status`, `counts_json`, `error_code`, 실행 시각 |
| `audit_logs` | 관리자 변경 기록 | `actor_email`, `action`, `target`, `created_at` |
| `sessions` | 해시된 브라우저 세션 | `token_hash`, `user_id`, `expires_at` |
| `oauth_states` | 일회용 OAuth state | `state`, `expires_at` |
| `digest_locks` | 날짜별 파이프라인 멱등 잠금 | `date`, `status`, 실행 시각 |

`migrations/0001_initial.sql`이 최초 스키마와 기본값을 만든다. `0002_cloudflare_access.sql`은 이전 Access 전환 당시 auth 테이블을 제거했고, `0003_google_oauth_sessions.sql`은 Google OAuth 세션과 state 테이블을 다시 만든다. `0004_llm_config_secrets.sql`은 과거 D1에 저장했던 LLM URL/model/언어를 삭제한다. `0005_lesson_model_metadata.sql`은 요청 모델과 provider 응답 모델을 각각 보존한다. migration 이전에 생성된 lesson은 응답 모델이 `response_model`에 기록되지 않아 이메일에 기록 없음으로 표시된다. 30일 보관 대상은 lessons, deliveries, runs, audit_logs이며 만료 세션과 OAuth state도 정리한다.

## API

| Method / path | 권한 | 기능 |
|---|---|---|
| `GET /api/health` | 공개 | Worker 상태 확인 |
| `GET /auth/google` | 공개 | Google OAuth 시작 |
| `GET /auth/callback` | OAuth state | 계정 확인 후 세션 발급 |
| `POST /auth/logout` | 로그인 | 현재 D1 세션 폐기 |
| `GET /api/me` | 로그인 | 현재 사용자 및 관리자 여부 |
| `GET, PUT /api/settings` | 로그인 | 본인 수신 상태 조회/수정 |
| `GET /api/history` | 로그인 | 본인 최근 100건 |
| `GET /api/history/{date}` | 로그인 | 본인 해당 날짜 메일 본문 |
| `GET /api/admin/overview` | 관리자 | 사용자·초대·최근 전송·실행·브리핑 요약 |
| `POST /api/admin/invites` | 관리자 | 초대 등록 및 초대 메일 발송 시도 |
| `DELETE /api/admin/invites/{email}` | 관리자 | 미사용 초대 삭제 |
| `PATCH /api/admin/users/{id}` | 관리자 | 사용자 수신 상태 변경 |
| `GET, POST /api/admin/sources` | 관리자 | 미디어 조회/추가 |
| `PUT, DELETE /api/admin/sources/{id}` | 관리자 | 미디어 수정/삭제 |
| `GET, PUT /api/admin/settings` | 관리자 | 시간대·시각 조회/수정 및 LLM Worker secrets 등록 상태 조회 |
| `POST /api/admin/test-email` | 관리자 | 실제 뉴스 요약 생성 후 본인에게 시험 발송 |
| `POST /api/admin/run` | 관리자 | 오늘 브리핑 수동 실행 |
| `GET /api/admin/lessons/{date}` | 관리자 | 원문 요약 조회 |
| `GET /api/admin/deliveries/{id}` | 관리자 | 발송 메일 스냅샷 조회 |
| `GET /api/admin/audit` | 관리자 | 최근 관리자 변경 조회 |

모든 변경 API는 동일 출처 `Origin`을 요구한다. 인증 후 본인 세션 사용자 ID를 이용해 조회 범위를 제한한다. 입력 오류는 `{ "error": "safe_code" }` 형태로 반환한다. D1의 전달 레코드는 발송 순간의 수신자 주소와 메일 내용을 보존한다.