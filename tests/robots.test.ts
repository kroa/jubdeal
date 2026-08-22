import { describe, expect, it } from 'vitest';
import { GET } from '@/pages/robots.txt';

/** Astro 가 정적 엔드포인트에 넘기는 컨텍스트 중 이 엔드포인트가 쓰는 부분만 흉내냅니다. */
function callGet(site: URL | undefined) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return GET({ site } as any) as Response;
}

async function bodyOf(site: URL | undefined): Promise<string> {
  const response = await callGet(site);
  return response.text();
}

describe('robots.txt 엔드포인트', () => {
  it('모든 크롤러를 허용한다', async () => {
    const body = await bodyOf(new URL('https://jubdeal.pages.dev'));

    expect(body).toContain('User-agent: *');
    expect(body).toContain('Allow: /');
  });

  it('Sitemap URL 을 site 기준으로 만든다', async () => {
    // 하드코딩하면 커스텀 도메인 배포 시 canonical 도메인과 어긋납니다.
    const body = await bodyOf(new URL('https://jubdeal.example.com'));

    expect(body).toContain('Sitemap: https://jubdeal.example.com/sitemap-index.xml');
    expect(body).not.toContain('pages.dev');
  });

  it('경로가 있는 site 에서도 sitemap 을 올바르게 붙인다', async () => {
    const body = await bodyOf(new URL('https://example.com/jubdeal/'));

    expect(body).toContain('Sitemap: https://example.com/jubdeal/sitemap-index.xml');
  });

  it('site 가 없으면 기본 도메인으로 폴백한다', async () => {
    const body = await bodyOf(undefined);

    expect(body).toContain('Sitemap: https://jubdeal.pages.dev/sitemap-index.xml');
  });

  it('text/plain 으로 응답한다', async () => {
    const response = callGet(new URL('https://jubdeal.pages.dev'));

    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
  });

  it('마지막 줄이 개행으로 끝난다', async () => {
    const body = await bodyOf(new URL('https://jubdeal.pages.dev'));

    expect(body.endsWith('\n')).toBe(true);
  });
});
