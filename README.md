# 줍딜 (JubDeal)

> 정가 주고 사면 지는 겁니다. 길에 떨어진 알짜 혜택만 줍는 곳.

매일 새로 올라오는 **무료 증정 · 100원 딜 · 쿠폰 · 캐시백** 정보만 걸러 모아 보여주는
Cloudflare Pages 기반 Jamstack 웹 애플리케이션입니다.

---

## 목차

1. [기술 스택](#1-기술-스택)
2. [프레임워크로 Astro를 고른 이유](#2-프레임워크로-astro를-고른-이유)
3. [프로젝트 구조](#3-프로젝트-구조)
4. [로컬 실행](#4-로컬-실행)
5. [테스트 실행](#5-테스트-실행)
6. [환경변수 관리](#6-환경변수-관리)
7. [GitHub 저장소 연결](#7-github-저장소-연결)
8. [Cloudflare Pages 배포](#8-cloudflare-pages-배포)
9. [CI/CD 품질 게이트](#9-cicd-품질-게이트)
10. [혜택 데이터 추가하기](#10-혜택-데이터-추가하기)
11. [보안 원칙](#11-보안-원칙)

---

## 1. 기술 스택

| 영역          | 선택                                        |
| ------------- | ------------------------------------------- |
| 프레임워크    | **Astro 7** (정적 빌드, `output: 'static'`) |
| UI 아일랜드   | **React 19** (필터·다크모드만 하이드레이션) |
| 언어          | **TypeScript** (strict)                     |
| 데이터 검증   | **Zod 4** (빌드 타임 스키마 검증)           |
| 테스트        | **Vitest 4** + Testing Library              |
| 린트 / 포맷   | ESLint 9 (flat config) + Prettier           |
| CI/CD         | GitHub Actions                              |
| 호스팅        | Cloudflare Pages                            |

---

## 2. 프레임워크로 Astro를 고른 이유

Next.js `output: 'export'` 와 비교했을 때 Cloudflare Pages 환경에서 Astro가 더 잘 맞습니다.

| 항목               | Astro (선택)                              | Next.js static export                                     |
| ------------------ | ----------------------------------------- | --------------------------------------------------------- |
| 배포 산출물        | 순수 정적 파일(`dist/`) — 어댑터 불필요   | `out/` 정적 파일이지만 런타임 제약이 붙음                 |
| 기본 JS 전송량     | 0KB. 필요한 컴포넌트만 아일랜드로 하이드레이션 | 페이지 전체 하이드레이션                              |
| 이미지 최적화      | 정적 빌드에서 그대로 사용 가능            | `next/image` 기본 로더 사용 불가 (커스텀 로더 필요)        |
| 미들웨어 / ISR     | 정적 모드에서 애초에 사용하지 않음        | export 시 미지원 — 나중에 쓰려면 구조 변경 필요            |
| 콘텐츠 중심 사이트 | 최적화된 사용처                           | 앱 중심 설계라 오버스펙                                    |

줍딜은 **혜택 카드 목록을 보여주는 콘텐츠 사이트**이고, 인터랙션은 필터링과 다크모드
정도입니다. 페이지 전체를 하이드레이션할 이유가 없어서 Astro의 아일랜드 구조가 그대로
들어맞습니다. 필터 UI는 React로 작성했으므로 Testing Library 유닛 테스트도 그대로 가능합니다.

---

## 3. 프로젝트 구조

```
jubdeal/
├── .github/workflows/ci.yml     # CI 파이프라인 (품질 게이트 → 빌드 → 배포)
├── public/
│   ├── _headers                 # Cloudflare Pages 보안 헤더 (CSP, HSTS 등)
│   └── favicon.svg
├── src/
│   ├── components/              # React 아일랜드
│   │   ├── Badge.tsx            #   상태 / 마감 / 유형 / 난이도 뱃지
│   │   ├── DealBoard.tsx        #   필터 상태를 소유하는 최상위 아일랜드
│   │   ├── DealCard.tsx         #   혜택 카드
│   │   ├── DealDetailStatus.tsx #   상세 페이지의 시간 의존 영역(뱃지·CTA)
│   │   ├── DealStats.tsx        #   히어로 통계 (목록과 같은 시계 공유)
│   │   ├── FilterBar.tsx        #   필터 UI (제어 컴포넌트)
│   │   └── ThemeToggle.tsx      #   다크모드 토글
│   ├── hooks/
│   │   └── use-live-now.ts      # 빌드 시각으로 시드 후 현재 시각으로 갱신하는 공용 시계
│   ├── data/
│   │   └── deals.json           # 혜택 데이터셋 (빌드 타임 검증 대상)
│   ├── layouts/
│   │   └── BaseLayout.astro     # 공통 레이아웃 · SEO · FOUC 방지 스크립트
│   ├── lib/                     # 순수 함수 — UI 의존성 없음, 전부 테스트됨
│   │   ├── deal-filter.ts       #   필터 / 정렬 / 개수 집계
│   │   ├── deal-schema.ts       #   Zod 런타임 검증
│   │   ├── deal-status.ts       #   상태·마감·할인율 계산 (KST 기준)
│   │   ├── deals.ts             #   데이터 로더 (검증 실패 시 빌드 중단)
│   │   └── format.ts            #   표시용 포맷터
│   ├── pages/
│   │   ├── 404.astro
│   │   ├── about.astro
│   │   ├── deals/[slug].astro   # 혜택 상세 (정적 생성)
│   │   ├── index.astro          # 메인
│   │   └── robots.txt.ts        # robots.txt (site URL 기준 동적 생성)
│   ├── styles/                  # 디자인 토큰 + 컴포넌트 스타일
│   └── types/deal.ts            # 핵심 도메인 타입 (Single Source of Truth)
├── tests/                       # 유닛 테스트 (233개)
├── .env.example                 # 환경변수 템플릿 (실제 값 없음)
├── .gitignore
└── vitest.config.ts
```

---

## 4. 로컬 실행

### 사전 요구사항

- **Node.js 22 이상** (`.nvmrc` 참고 — `nvm use` 로 맞출 수 있습니다)
- npm 9 이상

### 실행 절차

```bash
# 1) 저장소 클론
git clone https://github.com/<your-account>/jubdeal.git
cd jubdeal

# 2) 의존성 설치
npm ci

# 3) 환경변수 파일 생성 (필수는 아니지만 권장)
cp .env.example .env

# 4) 개발 서버 실행
npm run dev
```

브라우저에서 **http://localhost:4321** 로 접속합니다.

### 그 밖의 명령어

| 명령어                  | 설명                                                     |
| ----------------------- | -------------------------------------------------------- |
| `npm run dev`           | 개발 서버 (HMR)                                          |
| `npm run build`         | 프로덕션 정적 빌드 → `dist/`                             |
| `npm run preview`       | 빌드 결과를 로컬에서 미리보기                            |
| `npm run lint`          | ESLint 검사                                              |
| `npm run lint:fix`      | ESLint 자동 수정                                         |
| `npm run format`        | Prettier 포맷 적용                                       |
| `npm run format:check`  | 포맷 검사 (CI에서 사용)                                  |
| `npm run typecheck`     | `astro check` + `tsc --noEmit`                           |
| `npm test`              | 유닛 테스트 1회 실행                                     |
| `npm run test:watch`    | 테스트 watch 모드                                        |
| `npm run test:coverage` | 커버리지 측정 (임계값 미달 시 실패)                      |
| **`npm run verify`**    | **lint → format → typecheck → test → build 전체를 순서대로 실행** |

> 커밋 전에 `npm run verify` 를 한 번 돌리면 CI에서 걸릴 문제를 미리 잡을 수 있습니다.

---

## 5. 테스트 실행

```bash
npm test                 # 전체 테스트
npm run test:watch       # 파일 변경 감지 모드
npm run test:coverage    # 커버리지 리포트 (coverage/index.html)
npm test -- deal-status  # 특정 파일만
```

### 테스트 구성

| 파일                              | 대상                                              |
| --------------------------------- | ------------------------------------------------- |
| `tests/deal-status.test.ts`       | 상태 판정 · KST 날짜 계산 · 할인율 · 정렬 우선순위 |
| `tests/deal-filter.test.ts`       | 필터 조합 · 검색 · 정렬 · 축별 개수 집계          |
| `tests/deal-schema.test.ts`       | Zod 스키마 · **실제 `deals.json` 데이터 검증**    |
| `tests/deals.test.ts`             | 데이터 로더 · 모듈 캐시 · 기준 시각 반영          |
| `tests/format.test.ts`            | 가격 · 마감 문구 · 날짜 포맷터                    |
| `tests/use-live-now.test.tsx`     | 공용 시계 훅 · 하이드레이션 시드 · 주기 갱신       |
| `tests/robots.test.ts`            | robots.txt 의 sitemap URL 이 도메인을 따라가는지  |
| `tests/DealCard.test.tsx`         | 카드 렌더링 · 뱃지 · CTA 활성/비활성              |
| `tests/FilterBar.test.tsx`        | 칩 토글 · 검색 · 정렬 · 초기화 상호작용 · 포커스  |
| `tests/DealBoard.test.tsx`        | 필터–목록 연동 · 포커스 이동 · 자정 넘김          |
| `tests/DealStats.test.tsx`        | 히어로 통계가 목록과 일치하는지                   |
| `tests/DealDetailStatus.test.tsx` | 상세 페이지 상태·CTA 의 실시간 재계산             |
| `tests/ThemeToggle.test.tsx`      | 다크모드 전환 · OS 추종 · SSR 출력 일치           |

**테스트 결정성**: 상태 계산 함수는 모두 현재 시각 `now` 를 인자로 받고, 컴포넌트 테스트는
`vi.setSystemTime()` 으로 시각을 고정합니다. 실제 달력이 바뀌어도 테스트 결과는 변하지 않습니다.

**환경 분리**: 순수 로직은 가벼운 `node` 환경에서, DOM이 필요한 컴포넌트 테스트만 파일 상단의
`// @vitest-environment jsdom` 주석으로 jsdom을 켭니다. jsdom 초기화가 느린 머신에서도
전체 실행 시간이 안정적으로 유지됩니다.

---

## 6. 환경변수 관리

### 원칙

- **소스코드에 키·비밀번호·연결 문자열을 절대 하드코딩하지 않습니다.**
- `.env`, `.env.local`, `*.secret` 등은 `.gitignore` 로 차단되어 있습니다.
- `.env.example` 에는 **형태만 알 수 있는 placeholder** 만 둡니다.

### 로컬 개발

```bash
cp .env.example .env
# .env 파일을 열어 실제 값을 채웁니다. 이 파일은 커밋되지 않습니다.
```

### 변수 종류

| 접두사       | 노출 범위                     | 주의사항                                     |
| ------------ | ----------------------------- | -------------------------------------------- |
| `PUBLIC_...` | **브라우저 번들에 포함**      | 비밀 값을 절대 넣지 마세요                   |
| 그 외        | 빌드 서버에서만 사용          | API 키·DB 연결 문자열은 반드시 이쪽에        |

| 변수                 | 용도                                     | 필수 |
| -------------------- | ---------------------------------------- | ---- |
| `PUBLIC_SITE_URL`    | canonical / sitemap / OG 태그 생성       | 권장 |
| `PUBLIC_SITE_NAME`   | 사이트 표기명                            | 선택 |
| `DEALS_API_KEY`      | 추후 크롤러 파이프라인 연동용            | 선택 |
| `ANTHROPIC_API_KEY`  | 추후 LLM 정규화 파이프라인 연동용        | 선택 |
| `DATABASE_URL`       | 추후 DB 연동용                           | 선택 |

### 운영 환경 (Cloudflare Pages)

운영 값은 저장소가 아니라 **Cloudflare Pages Dashboard** 에서 관리합니다.

1. Cloudflare Dashboard → **Workers & Pages** → 프로젝트 선택
2. **Settings** → **Environment variables**
3. **Add variable** 로 하나씩 등록
   - `Production` 과 `Preview` 환경을 따로 설정할 수 있습니다.
   - 비밀 값은 **Encrypt** 를 눌러 암호화 저장하세요. 저장 후에는 다시 조회되지 않습니다.
4. 저장 후 **재배포해야** 새 값이 반영됩니다.

> GitHub Actions에서 빌드하는 경우에는 저장소 **Settings → Secrets and variables → Actions** 에
> 등록하고, 비밀이 아닌 값은 `Variables` 탭에 넣으세요. (`ci.yml` 이 `vars.PUBLIC_SITE_URL` 을 참조합니다)

---

## 7. GitHub 저장소 연결

```bash
# 1) Git 저장소 초기화 (이미 되어 있으면 건너뜁니다)
git init -b main

# 2) 커밋 전에 민감정보가 없는지 확인
git status                 # .env 가 목록에 없어야 정상입니다
cat .gitignore | head -20

# 3) 첫 커밋
git add .
git commit -m "chore: 줍딜 초기 프로젝트 구성"

# 4) GitHub에 빈 저장소를 만든 뒤 연결
git remote add origin https://github.com/<your-account>/jubdeal.git
git push -u origin main
```

> **GitHub CLI를 쓴다면**
>
> ```bash
> gh repo create jubdeal --private --source=. --remote=origin --push
> ```

### 푸시 전 체크리스트

- [ ] `git status` 에 `.env` 가 보이지 않는가
- [ ] `npm run verify` 가 전부 통과하는가
- [ ] 소스코드에 실제 API 키가 들어간 곳이 없는가

> 실수로 시크릿을 커밋했다면 **즉시 해당 키를 폐기(rotate)** 하세요.
> 커밋을 되돌려도 Git 히스토리와 포크에는 값이 남습니다.

---

## 8. Cloudflare Pages 배포

배포 방법은 두 가지이며, **품질 게이트를 실제로 강제하려면 방법 B를 권합니다.**

### 방법 A — Git 연동 (설정이 간단함)

1. [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Pages**
2. **Connect to Git** → GitHub 계정 인증 → `jubdeal` 저장소 선택
3. 빌드 설정을 다음과 같이 입력합니다.

   | 항목                       | 값              |
   | -------------------------- | --------------- |
   | Framework preset           | `Astro`         |
   | Build command              | `npm run build` |
   | Build output directory     | `dist`          |
   | Root directory             | (비워 둠)       |

4. **Environment variables** 에 `NODE_VERSION = 22` 와 `PUBLIC_SITE_URL` 을 추가합니다.
5. **Save and Deploy** 를 누르면 빌드가 시작되고, 완료 후
   `https://jubdeal.pages.dev` 로 접속할 수 있습니다.
6. 이후 `main` 에 푸시할 때마다 자동 배포되고, PR을 열면 Preview 배포 URL이 생성됩니다.

> ⚠️ **알아 두어야 할 점**
> Git 연동 방식에서 Cloudflare는 **GitHub Actions의 성공/실패와 무관하게** 자체적으로 빌드합니다.
> 즉 테스트가 실패해도 Cloudflare 빌드 자체가 성공하면 배포가 나갑니다.
> 테스트 실패 시 배포를 실제로 막으려면 아래 방법 B를 쓰거나,
> GitHub의 **브랜치 보호 규칙**으로 `main` 에 머지되는 것 자체를 막아야 합니다
> (Settings → Branches → Add rule → *Require status checks to pass* 에 `품질 게이트` / `빌드` 지정).

### 방법 B — GitHub Actions에서 Direct Upload (권장)

테스트를 통과한 산출물만 배포되도록, GitHub Actions가 빌드하고 Cloudflare에 직접 업로드합니다.

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Upload assets** 로 `jubdeal` 이라는 이름의 프로젝트를 먼저 만들어 둡니다.
   (프로젝트 이름을 바꾸려면 `ci.yml` 의 `--project-name=jubdeal` 도 함께 수정하세요.)

2. **API 토큰 발급**
   Cloudflare Dashboard → 우측 상단 프로필 → **API Tokens** → **Create Token**
   → *Custom token* 으로 다음 권한을 부여합니다.
   - `Account` → `Cloudflare Pages` → **Edit**

3. **Account ID 확인**
   Workers & Pages 개요 페이지 우측에 표시됩니다.

4. **GitHub Secrets 등록**
   저장소 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

   | 이름                    | 값                       |
   | ----------------------- | ------------------------ |
   | `CLOUDFLARE_API_TOKEN`  | 2단계에서 발급한 토큰    |
   | `CLOUDFLARE_ACCOUNT_ID` | 3단계에서 확인한 ID      |

5. `main` 에 푸시하면 `품질 게이트 → 보안 검사 → 빌드 → 배포` 순으로 실행됩니다.

> 두 시크릿이 없으면 배포 잡은 **자동으로 건너뜁니다.** 방법 A를 쓰는 동안에도 CI가 실패하지 않습니다.

### 커스텀 도메인 연결

Pages 프로젝트 → **Custom domains** → **Set up a domain** 에서 도메인을 입력하면
Cloudflare가 DNS 레코드를 자동으로 추가합니다. 연결 후 `PUBLIC_SITE_URL` 을 새 도메인으로
갱신하고 재배포하세요.

---

## 9. CI/CD 품질 게이트

`.github/workflows/ci.yml` 은 네 개의 잡으로 구성되며, **앞 단계가 실패하면 뒤 단계는 실행되지 않습니다.**

```
┌─────────────────────┐   ┌─────────────────┐
│  품질 게이트         │   │  보안 검사       │
│  · Lint             │   │  · .env 커밋 차단│
│  · Typecheck        │   │  · 시크릿 스캔   │
│  · 포맷 검사        │   │  · npm audit    │
│  · 테스트 + 커버리지 │   │                 │
└──────────┬──────────┘   └────────┬────────┘
           └───────────┬───────────┘
                       ▼
              ┌─────────────────┐
              │  빌드            │
              │  · astro build  │
              │  · 산출물 검증   │
              └────────┬────────┘
                       ▼
              ┌─────────────────────────────┐
              │  배포 (main 푸시 & 시크릿 有) │
              │  · Cloudflare Pages         │
              └─────────────────────────────┘
```

### 게이트 세부 내용

- **테스트 실패 → 즉시 중단.** 빌드 잡이 `needs: [quality, security]` 로 묶여 있습니다.
- **커버리지 임계값**: lines 80% / functions 80% / branches 75% / statements 80%.
  미달 시 `test:coverage` 가 실패합니다. (현재 실제 커버리지는 98%대)
- **데이터 검증**: `deals.json` 이 스키마를 위반하면 테스트와 빌드 양쪽에서 실패합니다.
  깨진 데이터가 운영에 나가지 않습니다.
- **보안 검사**: 환경변수 파일이 추적되고 있는지, 소스에 API 키 패턴이 있는지,
  `.env.example` 에 실제 값이 들어갔는지 검사합니다. 취약점은 런타임 의존성만 차단 기준으로
  삼고(`--omit=dev`), 개발 의존성은 경고로 남겨 무관한 PR이 막히지 않게 했습니다.
- **타임존 고정**: 상태 계산이 KST 기준이므로 러너에 `TZ=Asia/Seoul` 을 지정해
  빌드 산출물이 실행 환경에 좌우되지 않게 합니다.
- **배포 중 취소 방지**: `cancel-in-progress` 는 PR 에서만 켭니다.
  `main` 푸시는 배포까지 이어지므로 중간에 취소되면 업로드가 깨질 수 있습니다.
- **산출물 검증**: 환경변수 주입 실수로 `<title>`·`og:site_name` 이 비는 결함은
  로컬 빌드로는 재현되지 않아, CI 산출물에서 직접 문자열을 확인합니다.

---

## 10. 혜택 데이터 추가하기

`src/data/deals.json` 의 `deals` 배열에 항목을 추가하면 됩니다.
스키마는 `src/types/deal.ts` 에 정의되어 있고, 빌드 시 Zod가 검증합니다.

```jsonc
{
  "id": "dl_2026_0820_brand_event", // 재수집해도 유지되는 고유 ID
  "slug": "brand-event", // URL용. 영소문자·숫자·하이픈만
  "title": "브랜드 아메리카노 무료 쿠폰",
  "summary": "카드에 보이는 한 줄 요약",
  "brand": { "name": "브랜드명" },
  "category": "cafe", // food|cafe|convenience|shopping|beauty|culture|finance|app|etc
  "dealType": "free", // free|penny|discount|coupon|cashback|point|giveaway
  "difficulty": "easy", // easy|normal|hard
  "price": { "original": 4500, "final": 0, "currency": "KRW" },
  "limit": { "firstComeFirstServed": true, "quantity": 1000, "remaining": 320 },
  "period": {
    "startAt": "2026-08-20T10:00:00+09:00",
    "endAt": "2026-08-31T23:59:59+09:00" // null이면 상시 진행
  },
  "link": { "url": "https://example.com/event", "label": "쿠폰 받으러 가기" },
  "howTo": ["앱 설치", "회원가입", "쿠폰함 확인"],
  "caution": ["1인 1회 한정"],
  "tags": ["신규가입", "무료음료"],
  "source": {
    "name": "브랜드 공식 앱",
    "url": "https://example.com/source",
    "collectedAt": "2026-08-20T05:30:00+09:00",
    "method": "manual", // manual|crawler|llm
    "confidence": 0.95 // LLM 추출 시 신뢰도
  },
  "meta": { "featured": false, "verified": true, "updatedAt": "2026-08-20T05:30:00+09:00" }
}
```

추가 후 검증:

```bash
npm test -- deal-schema   # 스키마 위반 즉시 확인
npm run dev               # 화면에서 확인
```

### 상태는 저장하지 않고 계산합니다

`진행중 / 오늘마감 / 오픈예정 / 소진 / 종료` 는 데이터에 저장하지 않고
`period` 와 `limit.remaining` 으로부터 **KST 기준으로 매번 계산**합니다.
빌드가 오래됐더라도 브라우저에서 현재 시각으로 다시 계산하므로 마감 표시가 어긋나지 않습니다.

### 자동 크롤러 / LLM 파이프라인 확장

`source.method` 와 `source.confidence` 필드가 이를 위해 미리 설계되어 있습니다.

1. 크롤러가 원문을 수집합니다.
2. LLM이 원문을 `Deal` 형태의 JSON으로 정규화합니다.
3. `safeParseDeal()` 로 검증해 실패하거나 `confidence` 가 낮은 건은 사람 검수 큐로 보냅니다.
4. 통과분만 `deals.json` 에 병합하고 커밋 → CI가 다시 검증 → 배포.

이때 교체가 필요한 것은 `src/lib/deals.ts` 하나뿐이고, UI 코드는 그대로 재사용됩니다.

---

## 11. 보안 원칙

이 프로젝트는 **Zero Leakage** 를 전제로 구성되어 있습니다.

| 항목                | 조치                                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| 시크릿 하드코딩     | 소스코드에 일절 없음. 전부 환경변수로 주입                                 |
| `.gitignore`        | `.env*`, `*.secret`, `*.pem`, `*.key`, `.dev.vars`, `node_modules`, `dist` 등 차단 |
| `.env.example`      | placeholder만 포함 — 실제 값 없음                                          |
| CI 시크릿 스캔      | 커밋된 환경변수 파일 · API 키 패턴 · private key 블록 자동 검사            |
| `.env.example` 검사 | `PUBLIC_` 이 아닌 **모든** 항목이 빈 값인지 확인 (키 이름과 무관하게 탐지) |
| 의존성 취약점       | 런타임 의존성은 차단(`--omit=dev`), 개발 의존성은 경고로 CI에서 실행       |
| 외부 링크           | 모든 외부 링크에 `rel="noopener noreferrer nofollow"` 적용                 |
| 보안 헤더           | `public/_headers` 에 CSP · HSTS · `X-Frame-Options: DENY` 등 설정          |
| 소스맵              | 프로덕션 빌드에서 비활성화                                                 |
| 개인정보            | 수집·저장하지 않음. 로그인·폼·쿠키 없음                                    |
| GitHub Actions 권한 | `permissions: contents: read` 로 최소 권한만 부여                          |

### 시크릿을 실수로 커밋했다면

1. **해당 키를 즉시 폐기하고 새로 발급합니다.** (가장 중요)
2. 그다음 히스토리를 정리합니다 (`git filter-repo` 등).
3. 커밋을 되돌리는 것만으로는 유출이 해결되지 않습니다 — 히스토리·포크·캐시에 값이 남습니다.

---

## 라이선스

이 저장소는 개인 프로젝트 템플릿입니다.

`src/data/deals.json` 에 들어 있는 혜택은 **동작 확인용 샘플 데이터**이며,
브랜드명과 링크(`example.com`)는 실제가 아닙니다. 운영에 쓰기 전에 실제로 검증한
혜택 데이터로 교체하세요.
