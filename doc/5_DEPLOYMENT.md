# 배포 및 초기 설정

## 준비

- Node.js 20 이상과 npm
- Cloudflare 계정 및 `npx wrangler login`
- Google Cloud project with OAuth consent screen and OAuth 2.0 Web application client
- Resend 계정/API key
- OpenAI 호환 LLM endpoint, 모델명, API key

## Cloudflare 리소스

1. `wrangler.jsonc`의 `name`을 Worker 이름에 맞춘다.
2. D1을 생성하고 생성된 UUID를 `d1_databases[0].database_id`에 기록한다.

   ```sh
   npx wrangler d1 create nitm
   ```

3. 로컬 DB에 마이그레이션을 적용한다.

   ```sh
   npm run db:local:migrate
   ```

4. Google, Resend, LLM Worker secrets를 등록한다. LLM 설정 세 값은 URL/model도 포함해 모두 secret binding으로 관리한다.
   기존 배포에서는 현재 D1의 LLM URL/model 값을 각각 `LLM_BASE_URL`, `LLM_MODEL` secret으로 옮긴다. 실제 secret 값은 API나 관리자 화면에 반환되지 않는다.

   ```sh
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put LLM_API_KEY
   npx wrangler secret put LLM_BASE_URL
   npx wrangler secret put LLM_MODEL
   ```

5. `wrangler.jsonc`에서 `BOOTSTRAP_ADMIN_EMAIL`과 `MAIL_FROM`을 설정한다.

6. 새 Worker 코드를 배포한다.

   ```sh
   npm run deploy
   ```

7. 새 Worker가 LLM 설정을 secrets에서 읽는지 확인한 뒤 D1 migration을 적용한다. 신규 설치는 배포 전에 전체 migration을 적용해도 된다.

   ```sh
   npm run db:remote:migrate
   ```

   `0004_llm_config_secrets.sql`은 D1에 저장됐던 LLM URL/model/언어를 삭제한다. `0005_lesson_model_metadata.sql`은 새 lesson의 요청 모델과 provider 응답 모델을 보존한다. 기존 설치는 secret 등록과 Worker 배포를 먼저 해야 LLM 설정 공백이 생기지 않는다.

8. Google Cloud Console에서 OAuth consent screen을 구성하고 OAuth 2.0 Client ID 유형을 **Web application**으로 만든다. Authorized redirect URI에 `https://<worker-domain>/auth/callback`을 추가한다. 로컬 OAuth 테스트를 위해 `http://localhost:8787/auth/callback`도 추가할 수 있다.
9. Worker hostname에 접속해 **Google로 로그인**으로 최초 관리자 계정에 로그인한다.
10. 관리자 화면에서 시간대와 발송 시각을 저장하고 secret 등록 상태를 확인한다. 이후 뉴스 소스를 확인하고 테스트 메일을 보낸다.

## 로컬 개발

```sh
npm install
cp .dev.vars.example .dev.vars
# Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .dev.vars.
npx wrangler secret put RESEND_API_KEY --local
npx wrangler secret put LLM_API_KEY --local
npx wrangler secret put LLM_BASE_URL --local
npx wrangler secret put LLM_MODEL --local
npm run db:local:migrate
npm run dev
```

Google OAuth client의 authorized redirect URI에 `http://localhost:8787/auth/callback`을 추가한다. 로컬과 운영 모두 Google OAuth flow를 사용한다.

## 변경 배포

프로젝트 버전을 올릴 때는 저장소 루트 `VERSION`만 수정한다. `npm run dev`, `npm run check`, `npm run deploy`가 실행 전에 package metadata와 `public/version.txt`를 자동 동기화하므로 별도 버전 파일을 직접 수정하지 않는다.

DB 스키마 변경은 새 번호의 SQL migration으로 추가한 뒤 remote migration을 수행하고 Worker를 배포한다. 이미 운영 중인 migration 파일을 수정해선 안 된다.

Migration `0005_lesson_model_metadata.sql`은 요청한 모델과 provider가 응답한 모델을 기존 lesson에 별도 보관한다. 기존 lesson은 응답 모델이 기록되지 않았으므로 이메일에 `기존 lesson: 응답 모델 기록 없음`으로 표시되고, migration 이후 생성되는 lesson부터 실제 응답 모델이 저장된다.