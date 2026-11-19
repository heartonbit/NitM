# NitM 개발 문서

이 문서 세트는 [0_RFP.md](0_RFP.md)의 범위를 현재 구현인 Cloudflare Workers + D1 기준으로 구체화합니다. `ref/`의 Firebase 프로젝트는 업무 흐름과 기본 뉴스 소스·메일·요약 시나리오 참고용이며, 실행 시 Firebase는 사용하지 않습니다.

프로젝트 버전의 단일 기준은 저장소 루트의 `VERSION`입니다. 버전을 변경할 때 이 파일만 수정하면 dev/check/deploy 전 동기화 스크립트가 package metadata와 메일에서 읽는 공개 version asset을 갱신합니다. 뉴스 이메일 footer에는 앱 버전, 요청한 LLM 모델, provider가 응답한 모델이 각각 표시됩니다. provider가 응답 모델명을 반환하지 않으면 미기록으로 표시됩니다.

## 문서

1. [요구사항 및 범위](1_REQUIREMENTS.md)
2. [시스템 설계](2_SYSTEM_DESIGN.md)
3. [데이터 모델 및 API](3_DATA_MODEL.md)
4. [보안 설계](4_SECURITY.md)
5. [배포 및 초기 설정](5_DEPLOYMENT.md)
6. [운영 및 장애 대응](6_OPERATIONS.md)
7. [테스트 계획](7_TEST_PLAN.md)

## 기준 설정

- 런타임: Cloudflare Workers, Cron Triggers, Assets, D1
- 인증: Google OAuth 2.0 Authorization Code flow; Worker가 callback과 검증된 이메일을 확인하고 D1 초대 목록으로 앱 권한을 확인
- 시간대/발송 시각: 초기 `UTC` / `06:00`; 관리자 설정으로 변경
- 기본 요약 언어: Korean
- LLM: `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` 모두 Cloudflare Worker secrets로 관리
- 메일: Resend, `RESEND_API_KEY`; 기본 발신자 `NitM <onboarding@resend.dev>`
- 보관: 요약·전송 이력·실행 로그 30일

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, 그리고 모든 LLM 설정은 Cloudflare Worker secrets로 등록합니다. 초기 관리자는 배포 설정 `BOOTSTRAP_ADMIN_EMAIL`로 지정합니다. 아직 설정하지 않은 배포 환경은 관리자 화면을 사용할 수 없으므로 최초 배포 절차를 따르세요.