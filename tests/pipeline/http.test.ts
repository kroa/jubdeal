import { describe, expect, it, vi } from 'vitest';
import { PoliteFetcher, RobotsDisallowedError, parseRetryAfter } from '@pipeline/fetch/http';

/** 경로별 응답을 지정할 수 있는 fetch 목 */
function makeFetch(
  routes: Record<string, { status?: number; body?: string; headers?: Record<string, string> }>,
) {
  const calls: string[] = [];

  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);

    const route = routes[url] ?? { status: 404, body: 'not found' };
    return new Response(route.body ?? '', {
      status: route.status ?? 200,
      headers: route.headers,
    });
  });

  return { impl: impl as unknown as typeof fetch, calls };
}

function makeFetcher(
  routes: Parameters<typeof makeFetch>[0],
  overrides: Partial<ConstructorParameters<typeof PoliteFetcher>[0]> = {},
) {
  const { impl, calls } = makeFetch(routes);
  const sleeps: number[] = [];
  let clock = 0;

  const fetcher = new PoliteFetcher({
    userAgent: 'JubDealBot/1.0 (+https://jubdeal.pages.dev)',
    requestIntervalMs: 1000,
    timeoutMs: 5000,
    fetchImpl: impl,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    nowImpl: () => clock,
    ...overrides,
  });

  return { fetcher, calls, sleeps };
}

describe('PoliteFetcher — robots.txt 준수', () => {
  it('요청 전에 robots.txt 를 먼저 읽는다', async () => {
    const { fetcher, calls } = makeFetcher({
      'https://x.com/robots.txt': { body: 'User-agent: *\nAllow: /\n' },
      'https://x.com/page': { body: '<html>ok</html>' },
    });

    await fetcher.fetchText('https://x.com/page');

    expect(calls[0]).toBe('https://x.com/robots.txt');
    expect(calls[1]).toBe('https://x.com/page');
  });

  it('robots.txt 는 호스트당 한 번만 읽는다', async () => {
    const { fetcher, calls } = makeFetcher({
      'https://x.com/robots.txt': { body: 'User-agent: *\nAllow: /\n' },
      'https://x.com/a': { body: 'a' },
      'https://x.com/b': { body: 'b' },
    });

    await fetcher.fetchText('https://x.com/a');
    await fetcher.fetchText('https://x.com/b');

    expect(calls.filter((url) => url.endsWith('robots.txt'))).toHaveLength(1);
  });

  it('차단된 경로는 가져오지 않는다', async () => {
    const { fetcher, calls } = makeFetcher({
      'https://x.com/robots.txt': { body: 'User-agent: *\nDisallow: /private\n' },
      'https://x.com/private/a': { body: 'secret' },
    });

    await expect(fetcher.fetchText('https://x.com/private/a')).rejects.toThrow(
      RobotsDisallowedError,
    );
    expect(calls).not.toContain('https://x.com/private/a');
  });

  it('robots.txt 가 404 면 허용으로 간주한다', async () => {
    const { fetcher } = makeFetcher({
      'https://x.com/page': { body: 'ok' },
      // robots.txt 는 라우트에 없으므로 404
    });

    await expect(fetcher.fetchText('https://x.com/page')).resolves.toBe('ok');
  });

  it('http/https 가 아니면 거부한다', async () => {
    const { fetcher } = makeFetcher({});
    await expect(fetcher.fetchText('file:///etc/passwd')).rejects.toThrow(/프로토콜/);
  });
});

describe('PoliteFetcher — 레이트 리밋', () => {
  it('같은 호스트 요청 사이에 간격을 둔다', async () => {
    const { fetcher, sleeps } = makeFetcher({
      'https://x.com/robots.txt': { body: 'User-agent: *\nAllow: /\n' },
      'https://x.com/a': { body: 'a' },
      'https://x.com/b': { body: 'b' },
    });

    await fetcher.fetchText('https://x.com/a');
    await fetcher.fetchText('https://x.com/b');

    // robots → a → b 사이마다 간격이 들어갑니다.
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(1000);
  });

  it('robots 의 Crawl-delay 가 더 길면 그쪽을 따른다', async () => {
    const { fetcher, sleeps } = makeFetcher({
      'https://x.com/robots.txt': { body: 'User-agent: *\nCrawl-delay: 5\n' },
      'https://x.com/a': { body: 'a' },
    });

    await fetcher.fetchText('https://x.com/a');

    expect(Math.max(...sleeps)).toBe(5000);
  });
});

describe('PoliteFetcher — 오류 처리', () => {
  it('404 는 재시도하지 않고 실패시킨다', async () => {
    const { fetcher, calls } = makeFetcher({
      'https://x.com/robots.txt': { body: 'User-agent: *\nAllow: /\n' },
    });

    await expect(fetcher.fetchText('https://x.com/missing')).rejects.toThrow(/404/);
    expect(calls.filter((url) => url.endsWith('/missing'))).toHaveLength(1);
  });

  it('503 은 재시도한다', async () => {
    let attempts = 0;
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('robots.txt')) return new Response('User-agent: *\nAllow: /\n');
      attempts += 1;
      if (attempts < 3) return new Response('', { status: 503 });
      return new Response('ok');
    }) as unknown as typeof fetch;

    const { fetcher } = makeFetcher({}, { fetchImpl: impl });

    await expect(fetcher.fetchText('https://x.com/flaky')).resolves.toBe('ok');
    expect(attempts).toBe(3);
  });

  it('응답이 상한을 넘으면 잘라낸다', async () => {
    const { fetcher } = makeFetcher(
      {
        'https://x.com/robots.txt': { body: 'User-agent: *\nAllow: /\n' },
        'https://x.com/big': { body: 'x'.repeat(5000) },
      },
      { maxBytes: 100 },
    );

    const text = await fetcher.fetchText('https://x.com/big');
    expect(text).toHaveLength(100);
  });

  it('식별 가능한 User-Agent 를 보낸다', async () => {
    const seen: Array<Record<string, string>> = [];
    const impl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response('ok');
    }) as unknown as typeof fetch;

    const { fetcher } = makeFetcher({}, { fetchImpl: impl });
    await fetcher.fetchText('https://x.com/a');

    expect(seen[0]?.['User-Agent']).toContain('JubDealBot');
    expect(seen[0]?.['User-Agent']).toContain('https://');
  });
});

describe('parseRetryAfter', () => {
  it('초 단위 숫자를 ms 로 바꾼다', () => {
    expect(parseRetryAfter('12')).toBe(12_000);
  });

  it('HTTP-date 를 남은 ms 로 바꾼다', () => {
    const now = Date.parse('2026-08-23T00:00:00Z');
    expect(parseRetryAfter('Sun, 23 Aug 2026 00:00:30 GMT', now)).toBe(30_000);
  });

  it('과거 시각이면 0', () => {
    const now = Date.parse('2026-08-23T00:01:00Z');
    expect(parseRetryAfter('Sun, 23 Aug 2026 00:00:00 GMT', now)).toBe(0);
  });

  it('해석할 수 없으면 null', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('나중에')).toBeNull();
  });
});
