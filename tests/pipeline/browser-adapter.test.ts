import { describe, expect, it, vi } from 'vitest';
import { createBrowserAdapter } from '@pipeline/adapters/browser';
import type { CollectContext, SourceConfig } from '@pipeline/types';

/**
 * 브라우저 어댑터
 * ---------------------------------------------------------------------------
 * 진짜 브라우저를 띄우지 않고, Playwright 가 노출하는 표면만 흉내 냅니다.
 * 여기서 확인하려는 건 렌더링이 아니라 **우리 규칙**입니다.
 * 검문을 통과시키는지, 무엇을 차단하는지, 실패를 조용히 넘기지 않는지.
 */

const SOURCE: SourceConfig = {
  id: 'spa',
  name: 'SPA 소스',
  kind: 'browser',
  url: 'https://spa.test/list',
  enabled: true,
  maxItems: 3,
  selectors: { item: '.card' },
};

interface FakeOptions {
  /** 목록에서 긁힐 항목들 */
  entries?: Array<{ href: string; title: string; listText: string }>;
  /** 상세 선택자로 읽힐 텍스트 */
  detailText?: string;
}

/** Playwright 의 사용 표면만 흉내 낸 가짜 브라우저 */
function makeFakeBrowser(options: FakeOptions = {}) {
  const entries = options.entries ?? [];
  const routed: string[] = [];
  const visited: string[] = [];
  let routeHandler: ((route: FakeRoute) => unknown) | null = null;

  interface FakeRoute {
    request: () => { resourceType: () => string };
    abort: () => void;
    continue: () => void;
  }

  const locator = (selector: string) => ({
    evaluateAll: async (fn: unknown, arg: unknown) => {
      const run = fn as (els: unknown[], a: unknown) => unknown;
      // evaluateAll 은 브라우저 안에서 도는 함수라 여기서는 결과만 흉내 냅니다.
      void run;
      void arg;
      void selector;
      return entries;
    },
    first: () => ({
      innerText: async () => options.detailText ?? '',
    }),
  });

  const page = {
    goto: async (url: string) => {
      visited.push(url);
      return null;
    },
    waitForSelector: async () => {},
    waitForTimeout: async () => {},
    locator,
  };

  const context = {
    route: async (_pattern: string, handler: (route: FakeRoute) => unknown) => {
      routeHandler = handler;
    },
    newPage: async () => page,
  };

  const browser = {
    newContext: async () => context,
    close: vi.fn(async () => {}),
  };

  /** 라우트 핸들러에 특정 리소스 종류를 흘려 보고 차단 여부를 봅니다. */
  function probeResource(type: string): 'abort' | 'continue' {
    let verdict: 'abort' | 'continue' = 'continue';
    routeHandler?.({
      request: () => ({ resourceType: () => type }),
      abort: () => {
        verdict = 'abort';
      },
      continue: () => {
        verdict = 'continue';
      },
    });
    routed.push(type);
    return verdict;
  }

  return { browser, visited, probeResource, closed: browser.close };
}

function makeCtx(overrides: Partial<CollectContext> = {}) {
  const allowed: string[] = [];

  const ctx: CollectContext = {
    now: new Date('2026-09-02T00:00:00+09:00'),
    log: () => {},
    userAgent: 'JubDealBot/1.0 (+https://jubdeal.pages.dev/about)',
    fetchText: async () => {
      throw new Error('browser 어댑터는 fetchText 를 쓰지 않아야 합니다.');
    },
    assertAllowed: async (url: string) => {
      allowed.push(url);
    },
    ...overrides,
  };

  return { ctx, allowed };
}

describe('예의 있는 수집 규칙', () => {
  it('페이지를 열기 전에 robots 검문을 통과시킨다', async () => {
    /*
      Playwright 가 네트워크를 담당하므로 PoliteFetcher 를 거치지 않습니다.
      검문을 빼먹으면 robots.txt·레이트리밋·사설망 차단이 통째로 우회됩니다.
      어댑터 종류에 따라 "예의 있는 수집"이 달라지면 안 됩니다.
    */
    const fake = makeFakeBrowser({
      entries: [{ href: '/a', title: '항목', listText: '충분히 긴 목록 텍스트입니다. '.repeat(3) }],
    });
    const { ctx, allowed } = makeCtx();

    const adapter = createBrowserAdapter({ launch: async () => fake.browser as never });
    await adapter.collect(SOURCE, ctx);

    expect(allowed).toContain(SOURCE.url);
  });

  it('검문에서 막히면 브라우저를 띄우지도 않는다', async () => {
    let launched = false;
    const fake = makeFakeBrowser();
    const { ctx } = makeCtx({
      assertAllowed: async () => {
        throw new Error('robots.txt 가 금지합니다');
      },
    });

    const adapter = createBrowserAdapter({
      launch: async () => {
        launched = true;
        return fake.browser as never;
      },
    });

    await expect(adapter.collect(SOURCE, ctx)).rejects.toThrow(/robots/);
    expect(launched).toBe(false);
  });

  it('브라우저는 실패해도 반드시 닫는다', async () => {
    // 안 닫으면 CI 러너에 크롬 프로세스가 남습니다.
    const fake = makeFakeBrowser({ entries: [] });
    const { ctx } = makeCtx();

    const adapter = createBrowserAdapter({ launch: async () => fake.browser as never });
    await expect(adapter.collect(SOURCE, ctx)).rejects.toThrow();

    expect(fake.closed).toHaveBeenCalled();
  });
});

describe('리소스 차단', () => {
  it('이미지·폰트·미디어는 받지 않는다', async () => {
    const fake = makeFakeBrowser({
      entries: [{ href: '/a', title: '항목', listText: '충분히 긴 목록 텍스트입니다. '.repeat(3) }],
    });
    const { ctx } = makeCtx();

    const adapter = createBrowserAdapter({ launch: async () => fake.browser as never });
    await adapter.collect(SOURCE, ctx);

    expect(fake.probeResource('image')).toBe('abort');
    expect(fake.probeResource('font')).toBe('abort');
    expect(fake.probeResource('media')).toBe('abort');
  });

  it('stylesheet 는 차단하지 않는다', async () => {
    /*
      무거워 보이지만 막으면 SPA 가 부팅에 실패합니다.
      카드고릴라에서 실제로 확인했습니다 — 차단하면 이벤트 링크는커녕
      페이지 전체의 <a> 가 0개가 됩니다(차단 안 하면 106개).
      오류도 나지 않고 빈 페이지라 "요즘 이벤트가 없나 보다"로 오해하게 됩니다.
    */
    const fake = makeFakeBrowser({
      entries: [{ href: '/a', title: '항목', listText: '충분히 긴 목록 텍스트입니다. '.repeat(3) }],
    });
    const { ctx } = makeCtx();

    const adapter = createBrowserAdapter({ launch: async () => fake.browser as never });
    await adapter.collect(SOURCE, ctx);

    expect(fake.probeResource('stylesheet')).toBe('continue');
    expect(fake.probeResource('document')).toBe('continue');
    expect(fake.probeResource('script')).toBe('continue');
  });
});

describe('셀렉터가 죽었을 때', () => {
  it('목록이 0건이면 조용히 넘기지 않고 알린다', async () => {
    /*
      SPA 는 개편되면 셀렉터가 소리 없이 죽습니다.
      0건을 정상으로 처리하면 보고서에 "수집 0건"만 남아
      "요즘 혜택이 없나 보다"로 읽힙니다. 소스 오류로 올려야 고칠 수 있습니다.
    */
    const fake = makeFakeBrowser({ entries: [] });
    const { ctx } = makeCtx();

    const adapter = createBrowserAdapter({ launch: async () => fake.browser as never });

    await expect(adapter.collect(SOURCE, ctx)).rejects.toThrow(/선택자 '\.card'/);
  });

  it('item 선택자가 없으면 설정 오류로 알린다', async () => {
    const fake = makeFakeBrowser();
    const { ctx } = makeCtx();

    const adapter = createBrowserAdapter({ launch: async () => fake.browser as never });
    const source = { ...SOURCE, selectors: { detail: '.body' } };

    await expect(adapter.collect(source, ctx)).rejects.toThrow(/selectors\.item/);
  });
});

describe('링크 처리', () => {
  it('외부 호스트 링크는 따라가지 않는다', async () => {
    // 목록에 광고가 섞이면 엉뚱한 호스트를 우리가 대신 열게 됩니다.
    const fake = makeFakeBrowser({
      entries: [
        { href: 'https://evil.test/x', title: '외부', listText: '외부 링크입니다. '.repeat(5) },
        { href: '/ok', title: '내부', listText: '내부 링크입니다. '.repeat(5) },
      ],
    });
    const { ctx } = makeCtx();

    const adapter = createBrowserAdapter({ launch: async () => fake.browser as never });
    const items = await adapter.collect(SOURCE, ctx);

    expect(items.map((i) => i.url)).toEqual(['https://spa.test/ok']);
  });

  it('같은 링크가 두 번 나오면 한 번만 담는다', async () => {
    const listText = '같은 글이 두 번 실렸습니다. '.repeat(4);
    const fake = makeFakeBrowser({
      entries: [
        { href: '/same', title: '항목', listText },
        { href: '/same', title: '항목', listText },
      ],
    });
    const { ctx } = makeCtx();

    const adapter = createBrowserAdapter({ launch: async () => fake.browser as never });
    const items = await adapter.collect(SOURCE, ctx);

    expect(items).toHaveLength(1);
  });

  it('본문이 너무 짧으면 담지 않는다', async () => {
    const fake = makeFakeBrowser({
      entries: [{ href: '/tiny', title: '항목', listText: '짧음' }],
    });
    const { ctx } = makeCtx();

    const adapter = createBrowserAdapter({ launch: async () => fake.browser as never });
    const items = await adapter.collect(SOURCE, ctx);

    expect(items).toEqual([]);
  });
});
