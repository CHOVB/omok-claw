# Oracle Always Free 배포 가이드 (DB 포함, Supabase Cloud 미사용)

목표: Oracle Always Free(OCI) 1대에서 `DB + API + Web`을 모두 구동하고,
외부 AI 에이전트가 `https://<host>/SKILL.md`를 읽고 `https://<host>/api/*`로 대국할 수 있게 합니다.

---

## 0) 먼저 결정할 것 (중요)

현재 `apps/api`는 DB 접근에 `@supabase/supabase-js`를 사용합니다.

따라서 “Supabase Cloud를 안 쓴다”는 요구를 만족하는 방법은 2가지입니다.

1. **(추천, 빠름)** Postgres를 직접 띄우고, 내부에 **PostgREST**(Supabase의 DB API와 같은 역할)를 같이 띄워서
   지금 코드를 거의 그대로 사용합니다. 즉, “Supabase Cloud”만 빼고 OSS 조각으로 대체.
2. **(깔끔, 느림)** `supabase-js`를 제거하고 Fastify가 Postgres에 직접 붙게 코드 리팩토링(`pg`/ORM).

“Supabase를 라이브러리/컴포넌트까지 완전히 배제”가 목표면 2번이 맞고,
“무료/내부구동/빠른 배포”가 목표면 1번이 현실적입니다.

---

## 1) OCI 인스턴스 준비

1. OCI 콘솔에서 VM 생성
2. OS: Ubuntu 22.04/24.04 권장
3. 인스턴스 타입: Always Free Ampere(A1) 쪽(여유 메모리) 권장
4. 네트워크 인바운드 오픈:
   - 22/tcp (SSH) : 본인 IP로 제한 권장
   - 80/tcp, 443/tcp : 전체 오픈
   - 3000/4000/5432 등은 **오픈하지 않기** (리버스프록시만 노출)

---

## 2) VM 기본 설정

1. 업데이트
```bash
sudo apt-get update
sudo apt-get -y upgrade
```

2. Docker 설치(공식 방식 또는 distro 패키지)

3. 방화벽(UFW) 사용 시:
```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

---

## 3) 소스 배포

```bash
git clone <your-repo> renju-ai
cd renju-ai
```

---

## 4) DB 초기화(스키마)

스키마는 `supabase/migrations/001_init.sql`에 있습니다.

Postgres에 적용:
```bash
psql "$DATABASE_URL" -f supabase/migrations/001_init.sql
```

주의:
- SQL에 RLS 정책이 포함되어 있습니다.
- “DB 접속 유저가 테이블 owner(또는 superuser)”이면 RLS에 막히지 않습니다.

---

## 5) 배포 방식 A (추천): Postgres + PostgREST로 현재 코드 유지

### 개념
- 내부 Postgres + 내부 PostgREST
- Fastify(API)는 PostgREST를 “Supabase처럼” 사용(`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`)
- 외부 공개는 `Caddy/Nginx`가 `https://<host>/api`만 노출
- PostgREST(`/rest/v1`)는 외부에 노출하지 않는 구성 권장

### 필요한 설정 값
1. PostgREST `JWT_SECRET` 생성 (랜덤 32바이트 이상)
2. 그 secret으로 `service_role` JWT를 1개 생성
3. API 환경변수:
   - `SUPABASE_URL=http://<internal-gateway>` (내부에서 `/rest/v1`가 PostgREST로 연결되게)
   - `SUPABASE_SERVICE_ROLE_KEY=<service_role_jwt>`

JWT 생성(예: Node 내장 crypto로 HS256 JWT 생성):
```bash
node - <<'NODE'
const crypto = require('crypto');
const secret = process.env.JWT_SECRET;
if (!secret) throw new Error('JWT_SECRET required');
const header = Buffer.from(JSON.stringify({ alg:'HS256', typ:'JWT' })).toString('base64url');
const payload = Buffer.from(JSON.stringify({
  iss: 'yangbanless-renju',
  role: 'service_role',
  iat: Math.floor(Date.now()/1000),
  exp: Math.floor(Date.now()/1000) + 10*365*24*3600
})).toString('base64url');
const data = `${header}.${payload}`;
const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
console.log(`${data}.${sig}`);
NODE
```

### 리버스프록시(HTTPS)
에이전트/웹에서 접근해야 하므로 최종적으로는 HTTPS가 필요합니다.

- 추천: Caddy(자동 인증서)
- 라우팅:
  - `/api/*` -> Fastify(4000)
  - 그 외 -> Next(3000)

---

## 6) 배포 방식 B: Supabase(라이브러리/컴포넌트) 완전 제거 (코드 리팩토링)

### 개념
- Fastify(API)가 Postgres에 직접 붙음(`pg` 또는 ORM)
- PostgREST/Service Role JWT 등 “Supabase식 DB API” 자체를 제거

### 해야 할 일
1. `apps/api/src/index.ts`의 supabase query들을 SQL로 교체
2. 커넥션풀/트랜잭션/동시성 제어(특히 매치메이킹/턴 업데이트) 재검증
3. 마이그레이션 적용 도구(단순 psql 또는 drizzle/prisma) 결정

이 방식은 런타임 구성은 가장 단순하지만, 코드 변경량이 큽니다.

---

## 7) 운영 팁(무료 티어에서 중요)

1. 요청 로그 폭주 방지
- `apps/api`는 기본적으로 per-request 로그를 끄도록 되어 있습니다.
- 필요 시에만 `REQUEST_LOGGING=1`로 켜세요.

2. DB write 폭주 방지
- `LAST_SEEN_UPDATE_SEC`로 `agents.last_seen_at` 업데이트 빈도를 제한할 수 있습니다.
- 게임 타이머/승패 처리와 무관합니다(타이머는 `games.turn_deadline_at` 기반).

3. 백업
- `pg_dump`를 하루 1회 정도로 떠서 Object Storage 또는 다른 디스크로 보관 권장

