import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BlockedHostError,
  PoliteFetcher,
  RobotsDisallowedError,
  isBlockedHost,
  isRetryable,
  isValidHeaderValue,
} from '@pipeline/fetch/http';
import { isAllowed, parseRobotsTxt, selectGroup } from '@pipeline/fetch/robots';
import { fetchBudgetFor, htmlAdapter, isSameSite } from '@pipeline/adapters/index';
import { makeSlug } from '@pipeline/assemble';
import { mergeDeals } from '@pipeline/merge';
import type { Deal, DealsFile } from '@/types/deal';
import { DEAL_SCHEMA_VERSION } from '@/types/deal';
import type { CollectContext, SourceConfig } from '@pipeline/types';

/**
 * 리뷰에서 확인된 결함들의 회귀 테스트.
 * 각 테스트는 "고치기 전이라면 반드시 실패하는" 형태로 씁니다.
 */

const UA = 'JubDealBot/1.0 (+https://jubdeal.pages.dev/about)';

/* -------------------------------------------------------------------------- */
/* User-Agent 인코딩                                                           */
/* -------------------------------------------------------------------------- */

describe('User-Agent 인코딩', () => {
  it('비-ASCII User-Agent 로는 Fetcher 를 만들 수 없다', () => {
    // HTTP 헤더 값은 ByteString 이라, 한글이 들어가면 요청 자체가 TypeError 로 죽습니다.
    expect(
      () =>
        new PoliteFetcher({ userAgent: 'Bot/1.0 (수집)', requestIntervalMs: 0, timeoutMs: 100 }),
    ).toThrow(/ASCII/);
  });

  it('실제 sources.json 의 User-Agent 로 헤더를 만들 수 있다', () => {
    // 손으로 쓴 ASCII 리터럴이 아니라 **실제 배포되는 설정**을 검증해야 의미가 있습니다.
    const config = JSON.parse(readFileSync('scripts/pipeline/sources.json', 'utf8'));

    expect(isValidHeaderValue(config.userAgent)).toBe(true);
    expect(() => new Headers({ 'User-Agent': config.userAgent })).not.toThrow();
    expect(config.userAgent).toContain('http');
  });

  it('헤더 인코딩 오류는 재시도 대상이 아니다', () => {
    // cause 가 없는 TypeError = 영구적 설정 오류. 재시도하면 백오프만 태웁니다.
    const encodingError = new TypeError('Cannot convert argument to a ByteString');
    expect(isRetryable(encodingError)).toBe(false);

    // undici 의 진짜 네트워크 실패는 cause 가 붙습니다.
    const networkError = new TypeError('fetch failed');
    (networkError as { cause?: unknown }).cause = new Error('ECONNREFUSED');
    expect(isRetryable(networkError)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* SSRF / 리다이렉트                                                           */
/* -------------------------------------------------------------------------- */

describe('isBlockedHost', () => {
  it('클라우드 메타데이터 엔드포인트를 막는다', () => {
    expect(isBlockedHost('169.254.169.254')).toContain('메타데이터');
  });

  it('사설·루프백 대역을 막는다', () => {
    for (const host of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', 'localhost', '::1']) {
      expect(isBlockedHost(host)).not.toBeNull();
    }
  });

  it('공인 호스트는 통과시킨다', () => {
    for (const host of ['example.com', '8.8.8.8', '172.32.0.1']) {
      expect(isBlockedHost(host)).toBeNull();
    }
  });
});

function makeFetcher(
  handler: (url: string) => Response,
  overrides: Partial<ConstructorParameters<typeof PoliteFetcher>[0]> = {},
) {
  const calls: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  }) as unknown as typeof fetch;

  const fetcher = new PoliteFetcher({
    userAgent: UA,
    requestIntervalMs: 0,
    timeoutMs: 1000,
    fetchImpl: impl,
    sleepImpl: async () => {},
    nowImpl: () => 0,
    ...overrides,
  });

  return { fetcher, calls };
}

describe('리다이렉트 처리', () => {
  it('다른 호스트로 리다이렉트되면 그 호스트의 robots 를 다시 확인한다', async () => {
    // 고치기 전에는 undici 가 내부에서 따라가 B 의 robots 를 아예 읽지 않았습니다.
    const { fetcher, calls } = makeFetcher((url) => {
      if (url === 'https://a.com/robots.txt') return new Response('User-agent: *\nAllow: /\n');
      if (url === 'https://a.com/list') {
        return new Response('', { status: 302, headers: { location: 'https://b.com/secret' } });
      }
      if (url === 'https://b.com/robots.txt') return new Response('User-agent: *\nDisallow: /\n');
      return new Response('비밀 내용');
    });

    await expect(fetcher.fetchText('https://a.com/list')).rejects.toThrow(RobotsDisallowedError);

    expect(calls).toContain('https://b.com/robots.txt');
    expect(calls).not.toContain('https://b.com/secret');
  });

  it('내부망으로 리다이렉트되면 차단한다', async () => {
    const { fetcher, calls } = makeFetcher((url) => {
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /\n');
      if (url === 'https://a.com/go') {
        return new Response('', {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        });
      }
      return new Response('토큰');
    });

    await expect(fetcher.fetchText('https://a.com/go')).rejects.toThrow(BlockedHostError);
    expect(calls.some((url) => url.includes('169.254'))).toBe(false);
  });

  it('리다이렉트 홉 수를 제한한다', async () => {
    let hop = 0;
    const { fetcher } = makeFetcher((url) => {
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /\n');
      hop += 1;
      return new Response('', {
        status: 302,
        headers: { location: `https://a.com/hop${hop}` },
      });
    });

    await expect(fetcher.fetchText('https://a.com/start')).rejects.toThrow(/리다이렉트가/);
  });

  it('정상 리다이렉트는 따라가 본문을 돌려준다', async () => {
    const { fetcher } = makeFetcher((url) => {
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /\n');
      if (url === 'https://a.com/old') {
        return new Response('', { status: 301, headers: { location: '/new' } });
      }
      return new Response('새 위치의 내용');
    });

    await expect(fetcher.fetchText('https://a.com/old')).resolves.toBe('새 위치의 내용');
  });
});

describe('robots.txt 가 5xx 인 경우', () => {
  it('RFC 9309 대로 전체 금지로 간주한다', async () => {
    // 서버가 아파서 못 주는 것과 "금지"를 구분할 수 없으므로 보수적으로 봅니다.
    const { fetcher, calls } = makeFetcher((url) => {
      if (url.endsWith('/robots.txt')) return new Response('', { status: 503 });
      return new Response('내용');
    });

    await expect(fetcher.fetchText('https://a.com/page')).rejects.toThrow(RobotsDisallowedError);
    expect(calls).not.toContain('https://a.com/page');
  });

  it('404 는 여전히 전체 허용이다', async () => {
    const { fetcher } = makeFetcher((url) => {
      if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
      return new Response('내용');
    });

    await expect(fetcher.fetchText('https://a.com/page')).resolves.toBe('내용');
  });
});

describe('Retry-After 상한', () => {
  it('아주 긴 Retry-After 도 상한까지만 기다린다', async () => {
    const sleeps: number[] = [];
    const { fetcher } = makeFetcher(
      (url) => {
        if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /\n');
        return new Response('', { status: 429, headers: { 'retry-after': '86400' } });
      },
      { sleepImpl: async (ms) => void sleeps.push(ms), maxRetryAfterMs: 5000 },
    );

    await expect(fetcher.fetchText('https://a.com/page')).rejects.toThrow();
    // 사이트 한 곳이 실행 전체를 하루 붙잡지 못하게 합니다.
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(5000);
  });
});

/* -------------------------------------------------------------------------- */
/* robots 파서                                                                 */
/* -------------------------------------------------------------------------- */

describe('robots 파서 보강', () => {
  it('같은 User-agent 그룹이 여러 번 나오면 규칙을 합친다', () => {
    // 첫 그룹만 쓰면 뒤쪽 Disallow 가 통째로 무시됩니다.
    const robots = parseRobotsTxt('User-agent: *\nDisallow: /a\n\nUser-agent: *\nDisallow: /b\n');

    expect(selectGroup(robots, UA)?.rules).toHaveLength(2);
    expect(isAllowed(robots, UA, 'https://x.com/b/1')).toBe(false);
  });

  it('퍼센트 인코딩된 경로와 원문 패턴을 같게 본다', () => {
    const robots = parseRobotsTxt('User-agent: *\nDisallow: /비밀\n');

    expect(isAllowed(robots, UA, 'https://x.com/%EB%B9%84%EB%B0%80/1')).toBe(false);
    expect(isAllowed(robots, UA, 'https://x.com/비밀/1')).toBe(false);
    expect(isAllowed(robots, UA, 'https://x.com/공개/1')).toBe(true);
  });

  it('여러 그룹의 Crawl-delay 중 가장 긴 값을 쓴다', () => {
    const robots = parseRobotsTxt(
      'User-agent: *\nCrawl-delay: 1\n\nUser-agent: *\nCrawl-delay: 7\n',
    );

    expect(selectGroup(robots, UA)?.crawlDelaySec).toBe(7);
  });
});

/* -------------------------------------------------------------------------- */
/* 어댑터 SSRF · 예산                                                          */
/* -------------------------------------------------------------------------- */

describe('isSameSite', () => {
  it('같은 호스트와 서브도메인을 허용한다', () => {
    expect(isSameSite('https://example.com/list', 'https://example.com/a')).toBe(true);
    expect(isSameSite('https://example.com/list', 'https://news.example.com/a')).toBe(true);
  });

  it('다른 사이트를 거부한다', () => {
    expect(isSameSite('https://example.com/list', 'https://evil.com/a')).toBe(false);
    expect(isSameSite('https://example.com/list', 'http://169.254.169.254/')).toBe(false);
  });
});

describe('어댑터 요청 예산', () => {
  it('maxItems 보다 훨씬 많은 링크가 있어도 요청 수가 제한된다', async () => {
    const links = Array.from(
      { length: 200 },
      (_, i) => `<li class="item"><a href="/e/${i}">항목 ${i}</a></li>`,
    ).join('');

    const fetched: string[] = [];
    const ctx: CollectContext = {
      now: new Date('2026-08-23T12:00:00+09:00'),
      log: () => {},
      fetchText: async (url) => {
        fetched.push(url);
        if (url.endsWith('/list')) return `<ul>${links}</ul>`;
        // 모든 상세가 실패 → 예산이 없으면 200번 요청하게 됩니다.
        throw new Error('boom');
      },
    };

    const source: SourceConfig = {
      id: 'demo',
      name: '데모',
      kind: 'html',
      url: 'https://example.com/list',
      enabled: true,
      maxItems: 2,
      selectors: { item: '.item', link: 'a' },
    };

    await htmlAdapter.collect(source, ctx);

    const detailCalls = fetched.filter((url) => url.includes('/e/'));
    expect(detailCalls.length).toBeLessThanOrEqual(fetchBudgetFor(2));
  });

  it('외부 호스트 링크는 아예 요청하지 않는다', async () => {
    const fetched: string[] = [];
    const ctx: CollectContext = {
      now: new Date('2026-08-23T12:00:00+09:00'),
      log: () => {},
      fetchText: async (url) => {
        fetched.push(url);
        return '<ul><li class="item"><a href="http://169.254.169.254/">메타데이터</a></li></ul>';
      },
    };

    const source: SourceConfig = {
      id: 'demo',
      name: '데모',
      kind: 'html',
      url: 'https://example.com/list',
      enabled: true,
      maxItems: 5,
      selectors: { item: '.item', link: 'a' },
    };

    await htmlAdapter.collect(source, ctx);
    expect(fetched.some((url) => url.includes('169.254'))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* slug 충돌                                                                   */
/* -------------------------------------------------------------------------- */

describe('makeSlug 충돌 방지', () => {
  it('아주 긴 경로에서도 해시 접미사가 잘리지 않는다', () => {
    // 해시가 잘리면 서로 다른 혜택이 같은 slug 를 갖고,
    // deals.json 중복 검사에 걸려 파이프라인이 매일 통째로 중단됩니다.
    const long = 'a'.repeat(200);
    const one = makeSlug('source', `https://x.com/${long}/aaa`, 'seed-1');
    const two = makeSlug('source', `https://x.com/${long}/aaa`, 'seed-2');

    expect(one).not.toBe(two);
    expect(one.length).toBeLessThanOrEqual(80);
    expect(one).toMatch(/-[0-9a-f]{8}$/);
  });

  it('서로 다른 URL 은 서로 다른 slug 를 만든다', () => {
    const slugs = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const url = `https://x.com/${'z'.repeat(120)}/event-${i}`;
      slugs.add(makeSlug('src', url, `src:${url}`));
    }
    expect(slugs.size).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* merge 안전성                                                                */
/* -------------------------------------------------------------------------- */

function makeDeal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: 'dl_a',
    slug: 'a',
    title: '혜택',
    summary: '요약',
    brand: { name: '브랜드' },
    category: 'cafe',
    dealType: 'free',
    difficulty: 'easy',
    price: { final: 0, currency: 'KRW' },
    limit: { firstComeFirstServed: false },
    period: { startAt: '2026-08-01T00:00:00+09:00', endAt: '2026-09-30T23:59:59+09:00' },
    link: { url: 'https://example.com/a' },
    tags: [],
    source: {
      name: '소스A',
      url: 'https://example.com/a',
      collectedAt: '2026-08-23T03:00:00.000Z',
      method: 'llm',
    },
    meta: { verified: false, updatedAt: '2026-08-23T03:00:00.000Z' },
    ...overrides,
  };
}

function makeFile(deals: Deal[]): DealsFile {
  return {
    schemaVersion: DEAL_SCHEMA_VERSION,
    generatedAt: '2026-08-22T00:00:00+09:00',
    deals,
  };
}

const NOW = new Date('2026-08-23T12:00:00+09:00');

describe('merge 안전성', () => {
  it('다른 소스가 같은 링크를 써도 기존 항목을 덮어쓰지 않는다', () => {
    // 링크만 보고 동일하다고 판단하면, 기존 항목의 id·slug 아래
    // 전혀 다른 혜택이 들어앉습니다.
    const existing = makeDeal({ title: '소스A 의 혜택' });
    const other = makeDeal({
      id: 'dl_b',
      slug: 'b',
      title: '소스B 의 전혀 다른 혜택',
      source: { ...existing.source, name: '소스B' },
    });

    const result = mergeDeals(makeFile([existing]), [other], { now: NOW });

    const kept = result.file.deals.find((deal) => deal.id === 'dl_a');
    expect(kept?.title).toBe('소스A 의 혜택');
    expect(result.file.deals).toHaveLength(2);
  });

  it('같은 소스의 같은 링크는 갱신한다', () => {
    const existing = makeDeal({ title: '옛 제목' });
    const updated = makeDeal({ id: 'dl_new', slug: 'new', title: '새 제목' });

    const result = mergeDeals(makeFile([existing]), [updated], { now: NOW });

    expect(result.file.deals).toHaveLength(1);
    expect(result.file.deals[0]?.id).toBe('dl_a');
    expect(result.file.deals[0]?.title).toBe('새 제목');
  });

  it('사람이 검수한 항목은 prune 대상에서 제외한다', () => {
    const curated = makeDeal({
      meta: { verified: true, updatedAt: '2026-01-01T00:00:00+09:00' },
      period: { startAt: '2020-01-01T00:00:00+09:00', endAt: '2020-02-01T00:00:00+09:00' },
    });

    const result = mergeDeals(makeFile([curated]), [], { now: NOW, pruneAfterDays: 30 });

    expect(result.pruned).toHaveLength(0);
    expect(result.file.deals).toHaveLength(1);
  });

  it('변경이 없으면 generatedAt 도 그대로 둔다', () => {
    // 무조건 갱신하면 "변경 여부" 게이트가 항상 참이 되어 매일 빈 PR 이 생깁니다.
    const file = makeFile([makeDeal()]);
    const result = mergeDeals(file, [makeDeal()], { now: NOW });

    expect(result.file.generatedAt).toBe(file.generatedAt);
  });

  it('변경이 있으면 generatedAt 을 갱신한다', () => {
    const result = mergeDeals(makeFile([]), [makeDeal()], { now: NOW });
    expect(result.file.generatedAt).toBe(NOW.toISOString());
  });
});
