// @ts-check
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';

// astro.config 는 Astro 가 .env 를 읽기 전에 평가되므로 process.env 만으로는
// 로컬 .env 의 PUBLIC_SITE_URL 이 반영되지 않습니다. 직접 로드합니다.
//
// 모드는 Astro/Vite 의 규칙(dev → 'development', build → 'production')에 맞춥니다.
// NODE_ENV 를 그대로 쓰면 CI 의 NODE_ENV=test 때문에 '.env.test' 를 찾게 됩니다.
// (모드와 무관하게 `.env` 와 `.env.local` 은 항상 로드됩니다.)
const mode = process.argv.includes('dev') ? 'development' : 'production';

// 세 번째 인자를 'PUBLIC_' 으로 제한해, 비밀 값이 이 설정 파일 경로로 새지 않게 합니다.
const { PUBLIC_SITE_URL } = loadEnv(mode, process.cwd(), 'PUBLIC_');

/**
 * 줍딜(JubDeal) Astro 설정
 *
 * Cloudflare Pages 배포 전제:
 *  - 완전 정적(SSG) 빌드만 사용합니다. 산출물은 `dist/` 폴더의 순수 정적 파일이며
 *    Cloudflare Pages에 별도 어댑터/런타임 설정 없이 그대로 업로드됩니다.
 *  - Cloudflare Pages Build 설정 → Build command: `npm run build`, Output directory: `dist`
 */
export default defineConfig({
  // 운영에서는 Cloudflare Pages 환경변수 PUBLIC_SITE_URL 을 사용합니다.
  site: (PUBLIC_SITE_URL ?? '').trim() || 'https://jubdeal.pages.dev',
  output: 'static',
  trailingSlash: 'ignore',
  integrations: [react(), sitemap()],
  build: {
    // 정적 호스팅에서 가장 무난한 형태: /deals/foo/index.html
    format: 'directory',
    inlineStylesheets: 'auto',
  },
  vite: {
    build: {
      // 소스맵을 배포물에 포함하지 않습니다(코드 노출 최소화).
      sourcemap: false,
    },
  },
});
