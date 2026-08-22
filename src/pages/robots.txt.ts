import type { APIRoute } from 'astro';

/**
 * robots.txt 를 정적 엔드포인트로 생성합니다.
 *
 * public/robots.txt 에 Sitemap URL 을 하드코딩하면 커스텀 도메인으로 배포했을 때
 * canonical 도메인과 sitemap 도메인이 어긋납니다. `Astro.site`(= PUBLIC_SITE_URL)
 * 기준으로 매 빌드마다 생성해 항상 일치시킵니다.
 */
export const GET: APIRoute = ({ site }) => {
  const base = site ?? new URL('https://jubdeal.pages.dev');
  const sitemapUrl = new URL('sitemap-index.xml', base);

  const body = ['User-agent: *', 'Allow: /', '', `Sitemap: ${sitemapUrl.href}`, ''].join('\n');

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
