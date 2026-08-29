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
├── .github/workflows/
│   ├── ci.yml                   # 품질 게이트 → 빌드 → 배포
│   └── collect.yml              # 매일 혜택 수집 → 검증 → PR 생성
├── scripts/pipeline/            # 크롤러 + LLM 정규화 파이프라인
│   ├── cli.ts                   #   CLI (기본 dry run)
│   ├── run.ts                   #   오케스트레이터
│   ├── sources.json             #   소스 레지스트리 (여기에 소스를 추가)
│   ├── fetch/robots.ts          #   robots.txt 파서 (RFC 9309)
│   ├── fetch/http.ts            #   예의 있는 수집기 (robots·레이트리밋·SSRF 차단)
│   ├── adapters/index.ts        #   html / rss / fixture 어댑터
│   ├── extract/                 #   LLM 추출 (스키마 강제 + 신뢰도)
│   ├── assemble.ts              #   추출 결과 → Deal (안정적 id·slug)
│   └── merge.ts                 #   기존 데이터와 병합 (검수분 보호)
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
├── tests/                       # 유닛 테스트 (405개)
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
| `LLM_PROVIDER`       | `auto`(기본) / `claude-cli` / `gemini` / `openrouter` | 선택 |
| `GEMINI_API_KEY`     | Gemini 사용 시 (2순위 폴백)               | 폴백 사용 시 |
| `GEMINI_MODELS`      | 쓸 모델 고정. 비우면 자동 탐색            | 선택 |
| `OPENROUTER_API_KEY` | Gemini 도 막혔을 때 (3순위 폴백)          | 폴백 사용 시 |
| `DATABASE_URL`       | 추후 DB 연동용                           | 선택 |

### 운영 환경 (Cloudflare Pages)

**Git 연동이 아니라 Direct Upload 방식입니다.** GitHub Actions 가 빌드하고
`wrangler` 로 산출물을 올립니다. Cloudflare 대시보드에서 저장소를 연결할 필요가 없습니다.

이 방식을 고른 이유는 **품질 게이트를 배포 앞에 세우기 위해서**입니다.
Git 연동은 Cloudflare 가 직접 빌드하므로 테스트·린트 실패와 무관하게 배포됩니다.
Direct Upload 는 `ci.yml` 의 `deploy` 잡이 `build` 를 거쳐야만 실행되고,
`build` 는 다시 품질 게이트와 보안 검사를 모두 통과해야 합니다.

준비물은 저장소 시크릿 두 개뿐입니다.
(**Settings → Secrets and variables → Actions → Secrets**)

| 이름 | 값 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | [API 토큰](https://dash.cloudflare.com/profile/api-tokens) — Custom token, 권한은 `Account` → `Cloudflare Pages` → **Edit** 하나면 충분합니다 |
| `CLOUDFLARE_ACCOUNT_ID` | 32자리 16진수. 대시보드 URL(`dash.cloudflare.com/<여기>`) 또는 Workers & Pages 우측 사이드바에서 복사 |

둘 다 없으면 배포 단계는 **조용히 건너뜁니다**(실패가 아닙니다).
Pages 프로젝트는 워크플로가 없으면 만들어 주므로 미리 생성하지 않아도 됩니다.

빌드에 주입되는 공개 값은 `Variables` 탭에 넣습니다.
`PUBLIC_` 접두 값은 브라우저 번들에 그대로 들어가므로 **비밀을 넣지 마세요.**

| 이름 | 기본값 |
| --- | --- |
| `PUBLIC_SITE_URL` | `https://jubdeal.pages.dev` |
| `PUBLIC_SITE_NAME` | `줍딜` |

> Cloudflare 대시보드의 Environment variables 는 **Git 연동으로 빌드할 때만** 쓰입니다.
> 지금 구성에서는 빌드가 GitHub Actions 에서 일어나므로 거기 넣은 값은 반영되지 않습니다.

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

## 10-1. 자동 수집 파이프라인

`deals.json` 을 손으로 채우는 대신, 공개 소스를 수집해 LLM 이 스키마로 정규화합니다.

```bash
# 소스 설정 (여기에 수집 대상을 추가합니다)
scripts/pipeline/sources.json

# 실행 — 기본은 dry run 이라 파일을 건드리지 않습니다
npm run pipeline -- --max-items 5

# 실제 반영 (VSCode 에 로그인된 Claude 를 그대로 사용 — API 키 불필요)
npm run pipeline -- --write --max-items 20
```

### 흐름

```
수집 → LLM 추출 → 조립 → 병합 → 검증 → PR
  │        │         │        │       │
  │        │         │        │       └ parseDealsFile 재검증 후에만 기록
  │        │         │        └ 검수 완료 항목은 덮어쓰지 않음
  │        │         └ id·slug·타임스탬프는 파이프라인이 생성 (모델이 아님)
  │        └ isDeal / confidence 판정, 저신뢰는 검수 큐로
  └ robots.txt 준수, 호스트별 레이트리밋, 같은 사이트 링크만
```

### 설계상 지키는 것

| 항목 | 이유 |
| --- | --- |
| **id·slug 는 모델이 아니라 코드가 생성** | 모델에 맡기면 매 실행 값이 달라져 같은 혜택이 중복 등록됩니다 |
| **검수 완료(`verified`) 항목은 덮어쓰지 않음** | 큐레이터가 고친 값을 크롤러가 매일 되돌리면 아무도 손대지 않게 됩니다 |
| **모르는 값은 지어내지 않고 검수 큐로** | 가격·종료일을 추측해 넣으면 사용자가 헛걸음합니다 |
| **`--max-items` 로 LLM 호출 상한** | 수집량이 그대로 과금으로 이어지지 않게 합니다 |
| **기본이 dry run** | 실수로 `deals.json` 을 덮어쓰는 사고를 막습니다 |
| **`main` 에 직접 쓰지 않고 PR 생성** | 자동 수집분은 `verified: false` — 사람이 확인 후 머지 |

### 수집 예절 · 안전

- `robots.txt` 를 RFC 9309 규칙(최장일치·Allow 우선·와일드카드·그룹 병합)대로 준수하고,
  **리다이렉트 홉마다 다시 확인**합니다. `redirect: 'follow'` 로 두면 리다이렉트된 호스트의
  robots 를 통째로 건너뛰게 됩니다.
- 사설·루프백·링크로컬(`169.254.169.254` 등) 주소를 차단합니다 (SSRF 방어).
- 목록의 링크는 **같은 사이트**만 따라갑니다. 소스별 요청 예산 상한도 함께 겁니다.
- `User-Agent` 에 연락 가능한 URL 을 강제하며, ASCII 가 아니면 실행을 거부합니다
  (HTTP 헤더는 ByteString 이라 한글이 들어가면 모든 요청이 실패합니다).
- `Crawl-delay` 를 존중하되 `Retry-After` 에는 상한을 둬, 사이트 한 곳이 실행 전체를
  붙잡지 못하게 합니다.

### 수집 소스

`scripts/pipeline/sources.json` 에 정의합니다. 현재 활성 소스:

| ID | 소스 | 방식 | 성격 |
| --- | --- | --- | --- |
| `ppomppu-coupon` | 뽐뿌 쿠폰게시판 | RSS | 무료·응모·쿠폰 (줍딜 컨셉에 가장 가까움) |
| `ppomppu-hot` | 뽐뿌 뽐뿌게시판 | RSS | 국내 핫딜 |
| `ruliweb-market` | 루리웹 예판·핫딜 | RSS | 게임·전자기기 위주 |
| `clien-jirum` | 클리앙 알뜰구매 | HTML | 국내 핫딜 |
| ~~`eomisae-fs`~~ | 어미새 인기정보 | HTML | **비활성** — 아래 참고 |

소스별 성과(첫 실행 기준, 성공 / 검수 대기):

| 소스 | 성공 | 검수 | 통과율 |
| --- | --- | --- | --- |
| 뽐뿌 뽐뿌게시판 | 12 | 7 | 63% |
| 뽐뿌 쿠폰게시판 | 11 | 7 | 61% |
| 루리웹 예판·핫딜 | 10 | 11 | 48% |
| 클리앙 알뜰구매 | 8 | 14 | 36% |
| 어미새 인기정보 | 1 | 5 | **17%** |

어미새는 패션 커뮤니티라 글 본문이 "제목 + 상품 링크"뿐인 경우가 많습니다.
가격·기간·조건이 링크 너머에 있어 텍스트만으로는 판단할 근거가 없고,
거절 사유도 전부 "본문에 상세 정보가 없음"이었습니다. 구조적인 문제라
프롬프트나 선택자를 손봐도 나아지지 않아 껐습니다.
(설정은 남겨 뒀으니 `enabled: true` 로 되돌릴 수 있습니다.)

#### 새 소스를 넣기 전 확인할 것

1. **robots.txt** — 크롤러가 강제하므로 허용되지 않으면 아예 못 가져옵니다.
2. **봇 UA 응답** — robots 가 허용해도 서버가 우리 UA 를 막을 수 있습니다.
   브라우저인 척하지 마세요. 막는 곳은 안 쓰는 게 맞습니다.
3. **JS 렌더링 여부** — 목록을 클라이언트에서 그리면 HTML 만으로는 항목이 안 나옵니다.
4. **인코딩** — 한국 사이트에는 EUC-KR 이 아직 흔합니다. (자동 처리됩니다)
5. **링크 스킴** — 피드가 http 주소를 뱉는데 서버는 https 만 받는 경우가 있습니다.
   (자동으로 올려 줍니다)
6. **목록 상태 파라미터** — 정렬·페이지 값이 링크에 섞이면 같은 글이 중복 수집되고
   안정 ID 가 흔들립니다. `stripParams` 에 지워야 할 이름을 적으세요.

#### CI(데이터센터 IP)에서는 뽐뿌 본문을 못 읽습니다

뽐뿌는 GitHub Actions 의 IP 를 봇으로 보고 `ppck=1` 챌린지로 리다이렉트한 뒤
403 을 돌려줍니다. 같은 요청이 가정용 회선에서는 200 이라 로컬에서는 드러나지 않습니다.

우회하지 않습니다. 대신 그 소스는 **RSS 요약만으로** 처리합니다.
쿠폰게시판 요약은 49~135자라 퀴즈·포인트 같은 단순 혜택은 이것만으로도 추출됩니다.
차단기를 넣고 다시 돌린 CI 실행에서 **12건 전부 성공, 거절 0건**이었습니다.
다만 조건이 복잡한 글은 검수 큐로 갑니다.

상세가 연속 3회 실패하면 그 소스의 남은 항목은 더 두드리지 않습니다.
실패가 뻔한 요청에 레이트리밋 대기(항목당 3~5초)를 태우지 않기 위해서입니다.
그 방어가 없을 때 한 번 실행에서 29번을 헛되이 두드렸고, 넣은 뒤에는 6번(소스당 3번)입니다.

검토했으나 제외한 곳:

| 소스 | 사유 |
| --- | --- |
| **네이버 카페** | robots.txt 가 `Disallow: /` — 구글·빙까지 전면 차단. 아래 참고 |
| 쿨엔조이 | robots.txt 가 `Disallow: /` |
| 퀘이사존 | 목록을 클라이언트에서 렌더링. HTML 만으로는 항목이 안 나옴 |
| 에펨코리아 | 봇 차단 목록이 광범위 |

#### 네이버 카페는 왜 못 가져오는가

`cafe.naver.com/robots.txt` 는 다음과 같습니다.

```
# BOT ACCESS FOR THE PURPOSES OF AI TRAINING AND RETRIEVAL-AUGMENTED
# GENERATION (RAG) IS STRICTLY PROHIBITED.
User-agent: *
Disallow: /
```

`*` 뿐 아니라 Googlebot·Bingbot 까지 개별로 차단하고, 맨 윗줄에 AI·RAG 목적의
접근을 명시적으로 금지합니다. 우리 크롤러는 robots.txt 를 강제하므로 요청 자체가
차단되고, 로그인 세션으로 우회하는 것은 네이버 이용약관과 카페 자체 규정을
어기는 일이라 하지 않습니다.

**대안은 네이버가 공식 제공하는 검색 API 입니다.**

```bash
# https://developers.naver.com 에서 애플리케이션 등록 (무료, 일 25,000회)
NAVER_CLIENT_ID=
NAVER_CLIENT_SECRET=
```

`GET https://openapi.naver.com/v1/search/cafearticle.json?query=...` 로 공개된
카페 글의 **제목·링크·짧은 요약**을 받을 수 있습니다.

다만 한계가 분명합니다.

- 본문은 오지 않습니다. 링크를 따라가려 해도 그 URL 이 다시 robots 차단입니다.
- 즉 제목과 한 줄 요약만으로 혜택을 구조화해야 하는데,
  가격·기간·참여조건을 뽑기에는 근거가 부족해 대부분 검수 큐로 갑니다.
- 카페 글은 회원 등급 제한이 걸린 경우가 많아 검색에 잡히지 않는 것도 많습니다.

그래서 이 프로젝트는 카페를 소스로 쓰지 않습니다.
정가거부 같은 카페가 모으는 정보의 상당 부분은 뽐뿌 쿠폰게시판·루리웹·클리앙에도
올라오므로, 접근 가능한 소스를 넓히는 쪽이 실효가 큽니다.

### LLM 프로바이더

**Anthropic API 를 직접 호출하지 않습니다.** 세 경로를 순서대로 시도합니다.

| 순위 | 프로바이더 | 인증 | 쓰는 곳 |
| --- | --- | --- | --- |
| 1 | **Claude Code (VSCode 연결)** | 이미 로그인된 **구독 인증** — API 키 불필요 | 로컬 |
| 2 | **Google Gemini** | `GEMINI_API_KEY` ([발급](https://aistudio.google.com/apikey)) | 1번이 막혔을 때, 그리고 CI |
| 3 | **OpenRouter (무료 티어)** | `OPENROUTER_API_KEY` (무료 발급) | 2번까지 막혔을 때 |

쉼표로 여러 개를 적으면 **적은 순서대로** 시도합니다. 하나만 적으면 폴백이 없습니다.

```bash
LLM_PROVIDER=auto               # 기본. claude-cli → gemini → openrouter
LLM_PROVIDER=gemini,openrouter  # Gemini 를 쓰고 막히면 OpenRouter (요금 없는 조합)
LLM_PROVIDER=claude-cli         # 구독 인증만 (폴백 없음)
LLM_PROVIDER=openrouter         # OpenRouter 만 (VSCode 가 없는 환경)
```

오타는 조용히 무시하지 않고 그 자리에서 실패시킵니다.
무시하면 의도와 다른 프로바이더가 돌면서 요금이 나갑니다.

폴백은 **요금제 한도·인증·연결 문제일 때만** 일어납니다. 스키마 위반처럼 프로바이더를
바꿔도 똑같이 실패할 오류는 폴백하지 않습니다 — 같은 실패를 두 번 하며 비용만 두 배가 됩니다.

### Gemini

키는 [aistudio.google.com/apikey](https://aistudio.google.com/apikey) 에서 발급합니다.

```bash
# .env
GEMINI_API_KEY=AIza...

# 비워 두면 사용 가능한 모델을 조회해 flash 계열을 먼저 씁니다.
# 모델 이름은 자주 바뀌므로 고정하지 않는 쪽을 권합니다.
GEMINI_MODELS=
```

Gemini 는 구조화 출력 스키마가 OpenAPI 서브셋이라 JSON Schema 를 그대로 받지 않습니다
(`additionalProperties` 를 모르고, null 을 `anyOf` 대신 `nullable: true` 로 씁니다).
`toGeminiSchema()` 가 변환해 보내고, 그래도 거부하면 프롬프트 방식으로 물러섭니다.

무료 등급은 분당·일일 요청 수가 제한됩니다. 429 는 대개 일시적이라 그 모델을
영구 배제하지 않고 다음 모델로만 넘어갑니다.

최신 모델일수록 503 `This model is currently experiencing high demand` 가 자주
납니다. 이것도 일시 상태이므로 429 와 똑같이 다룹니다. 모델을 여러 개 적어 두면
붐비는 모델을 건너뛰고 다음 것으로 이어집니다.

### OpenRouter 무료 티어

키는 [openrouter.ai/keys](https://openrouter.ai/keys) 에서 무료로 발급합니다.

```bash
OPENROUTER_API_KEY=sk-or-v1-...

# 비워 두면 /models 를 조회해 무료(:free) 모델을 자동 탐색합니다.
OPENROUTER_FREE_MODELS=

# 위 목록이 모두 실패하면 순서대로 시도할 예비 모델
OPENROUTER_FALLBACK_MODELS=
```

무료 모델은 유료 모델과 성질이 달라 세 가지를 따로 다룹니다.

**1. 대부분 구조화 출력을 지원하지 않습니다.**
실측 시점 기준 `:free` 모델 18개 중 5개만 `structured_outputs` 를 지원했습니다.
자동 탐색은 **지원 모델을 먼저** 고르고, 그다음 컨텍스트가 큰 순서로 정렬합니다.
지원하지 않는 모델을 만나면 프롬프트로 JSON 을 요구한 뒤 본문에서 꺼내는 방식으로 바꿔
재시도합니다(코드펜스·설명이 섞여도 파싱합니다). 다만 스키마를 강제하지 못하므로
정확도가 떨어지고, 그만큼 검수 큐로 넘어가는 비율이 올라갑니다.

**2. 레이트 리밋이 빡빡합니다.**
한 모델이 429 를 내면 그 모델만 이번 실행에서 배제하고 다음 모델로 넘어갑니다.
프로바이더 전체를 포기하지 않습니다. 마지막에 성공한 모델은 다음 요청에서 먼저 시도합니다.

> OpenRouter 무료 티어는 크레딧 잔액에 따라 일일 요청 수가 제한됩니다.
> `--max-items` 를 작게 잡고 여러 번 나눠 돌리는 편이 안전합니다.

**3. 유료 모델은 호출 자체를 막습니다.**
`OPENROUTER_FREE_MODELS` / `OPENROUTER_FALLBACK_MODELS` 에 유료 모델을 적어도
요청이 나가지 않습니다. 실행 전에 모델 목록에서 단가를 확인해 0원이 아니면 건너뛰고,
어떤 모델이 왜 막혔는지 단가와 함께 알려 줍니다. 오타 하나로 요금이 나가는 일을 막는 장치입니다.
목록을 확인할 수 없을 때는 보수적으로 `:free` 접미사 모델만 허용합니다.
의도적으로 유료 모델을 쓰려면 `OPENROUTER_ALLOW_PAID=true` 를 설정하세요.

**4. 목록에 텍스트 모델이 아닌 것도 섞여 있습니다.**
자동 탐색은 출력이 텍스트뿐인 모델만 고릅니다. 단가가 0이라는 이유로
음악 생성 모델(`google/lyria-*` 등)이 딸려 들어오면 슬롯만 낭비하게 됩니다.

> **정확도에 대해**: 무료 모델은 품질 편차가 큽니다. 한국어 프로모션 문구에서
> 조건·기간을 읽어내는 일은 생각보다 까다로워, 모델에 따라 종료일을 틀리게 잡거나
> 혜택이 아닌 글을 혜택으로 볼 수 있습니다. `confidence` 임계값과 검수 큐가 그 방어선이니,
> 모델을 바꾼 뒤에는 **검수 큐 적재량과 실제로 반영된 항목의 정확도를 꼭 확인**하세요.
> 자동 수집분은 `verified: false` 로 들어가고 PR 로만 반영되므로, 머지 전에 사람이 봅니다.

### 비용

**Claude Code 경로**: Claude Code 는 자체 시스템 프롬프트와 도구 정의를 함께 실어 보냅니다
(약 22k 토큰). 첫 호출은 캐시 생성 비용을 내지만 이후 동일한 호출은 캐시를 읽습니다.
실측: 1회차 **$0.047** → 2회차 **$0.0043** (약 1/10). 연속 처리할수록 유리합니다.
`CLAUDE_CLI_MAX_BUDGET_USD` 로 호출당 상한을 겁니다.

**OpenRouter 무료 경로**: 과금이 없습니다. 대신 위의 레이트 리밋과 품질 편차를 감수합니다.

**비용 표기**: 프로바이더가 실제 비용을 알려주면 그 값을 씁니다.
알려주지 않으면 **추정하지 않고 "알려주지 않음"으로 적습니다.**
남의 요금표로 값을 만들어 내면, 무료 등급 실행에 요금이 있는 것처럼 보입니다.
(Gemini 는 응답에 비용을 담지 않습니다. 무료 등급이면 0 입니다.)

실행 요약에 추정 비용이 출력되고, 프로바이더가 실제 비용을 알려주면 그 값을 씁니다.

### 소스 추가하기

`scripts/pipeline/sources.json` 에 항목을 추가하면 코드 수정 없이 동작합니다.

```jsonc
{
  "id": "my-source",           // 영소문자·숫자·하이픈. id 생성에 쓰이므로 바꾸지 마세요
  "name": "소스 표시명",
  "kind": "html",              // html | rss | fixture
  "url": "https://example.com/events",
  "enabled": true,
  "maxItems": 10,              // 1~100
  "selectors": {
    "item": ".event-list li",  // 목록의 각 항목
    "link": "a",               // 항목 안의 상세 링크
    "title": ".event-title",
    "detail": "article"        // 상세 페이지의 본문 영역
  }
}
```

> 수집 대상의 이용약관과 `robots.txt` 를 먼저 확인하세요.
> 파이프라인이 `robots.txt` 를 지키더라도, 약관상 수집이 금지된 사이트는 별개의 문제입니다.

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
