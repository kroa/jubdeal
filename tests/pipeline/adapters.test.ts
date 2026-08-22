import { describe, expect, it, vi } from 'vitest';
import {
  clampText,
  fixtureAdapter,
  getAdapter,
  htmlAdapter,
  htmlToText,
  normalizeWhitespace,
  rssAdapter,
} from '@pipeline/adapters/index';
import type { CollectContext, SourceConfig } from '@pipeline/types';

const NOW = new Date('2026-08-23T12:00:00+09:00');

function makeContext(pages: Record<string, string>): CollectContext & { fetched: string[] } {
  const fetched: string[] = [];

  return {
    fetched,
    now: NOW,
    log: vi.fn(),
    fetchText: async (url: string) => {
      fetched.push(url);
      const page = pages[url];
      if (page === undefined) throw new Error(`404 ${url}`);
      return page;
    },
  };
}

describe('htmlToText', () => {
  it('script·style 을 제거하고 텍스트만 남긴다', () => {
    const text = htmlToText('<body><script>alert(1)</script><style>p{}</style><p>본문</p></body>');

    expect(text).toBe('본문');
    expect(text).not.toContain('alert');
  });

  it('선택자로 본문 영역만 고른다', () => {
    const html = '<body><nav>메뉴</nav><article>진짜 본문</article></body>';
    expect(htmlToText(html, 'article')).toBe('진짜 본문');
  });

  it('선택자가 안 맞으면 body 전체로 폴백한다', () => {
    const html = '<body><p>본문</p></body>';
    expect(htmlToText(html, '.nope')).toContain('본문');
  });
});

describe('normalizeWhitespace', () => {
  it('연속 공백과 빈 줄을 정리한다', () => {
    expect(normalizeWhitespace('  a   b  \n\n\n  c  ')).toBe('a b\nc');
  });

  it('non-breaking space 를 일반 공백으로 바꾼다', () => {
    expect(normalizeWhitespace('a\u00a0b')).toBe('a b');
  });
});

describe('clampText', () => {
  it('상한 이하는 그대로 둔다', () => {
    expect(clampText('짧은 글', 100)).toBe('짧은 글');
  });

  it('상한을 넘으면 자르고 생략 표시를 붙인다', () => {
    const clamped = clampText('가'.repeat(50), 10);
    expect(clamped).toContain('이하 생략');
    expect(clamped.startsWith('가'.repeat(10))).toBe(true);
  });
});

describe('htmlAdapter', () => {
  const source: SourceConfig = {
    id: 'demo',
    name: '데모',
    kind: 'html',
    url: 'https://x.com/events',
    enabled: true,
    maxItems: 10,
    selectors: { item: '.item', link: 'a', title: '.t', detail: 'article' },
  };

  const listHtml = `
    <ul>
      <li class="item"><a href="/e/1"><span class="t">첫 번째 이벤트</span></a></li>
      <li class="item"><a href="/e/2"><span class="t">두 번째 이벤트</span></a></li>
    </ul>`;

  // 어댑터는 본문이 40자 미만이면 잡음으로 보고 버리므로 충분히 길게 만듭니다.
  const detail = (n: number) =>
    `<body><nav>메뉴</nav><article>이벤트 ${n} 상세 본문입니다. 참여 방법과 진행 기간, 대상 조건이 모두 여기에 자세히 적혀 있습니다.</article></body>`;

  it('목록에서 상세를 따라가 항목을 만든다', async () => {
    const ctx = makeContext({
      'https://x.com/events': listHtml,
      'https://x.com/e/1': detail(1),
      'https://x.com/e/2': detail(2),
    });

    const items = await htmlAdapter.collect(source, ctx);

    expect(items).toHaveLength(2);
    expect(items[0]?.url).toBe('https://x.com/e/1');
    expect(items[0]?.title).toBe('첫 번째 이벤트');
    expect(items[0]?.text).toContain('이벤트 1 상세 본문');
    expect(items[0]?.text).not.toContain('메뉴');
  });

  it('상대 경로를 절대 URL 로 바꾼다', async () => {
    const ctx = makeContext({
      'https://x.com/events': listHtml,
      'https://x.com/e/1': detail(1),
      'https://x.com/e/2': detail(2),
    });

    const items = await htmlAdapter.collect(source, ctx);
    expect(items.every((item) => item.url.startsWith('https://'))).toBe(true);
  });

  it('maxItems 를 넘기지 않는다', async () => {
    const ctx = makeContext({
      'https://x.com/events': listHtml,
      'https://x.com/e/1': detail(1),
      'https://x.com/e/2': detail(2),
    });

    const items = await htmlAdapter.collect({ ...source, maxItems: 1 }, ctx);
    expect(items).toHaveLength(1);
    // 상한을 넘긴 상세는 아예 가져오지 않아야 합니다 (불필요한 요청 방지).
    expect(ctx.fetched).not.toContain('https://x.com/e/2');
  });

  it('중복 링크를 한 번만 처리한다', async () => {
    const dupList = `<ul>
      <li class="item"><a href="/e/1"><span class="t">A</span></a></li>
      <li class="item"><a href="/e/1"><span class="t">A 다시</span></a></li>
    </ul>`;

    const ctx = makeContext({ 'https://x.com/events': dupList, 'https://x.com/e/1': detail(1) });
    const items = await htmlAdapter.collect(source, ctx);

    expect(items).toHaveLength(1);
  });

  it('상세 페이지 실패는 건너뛰고 나머지를 계속한다', async () => {
    const ctx = makeContext({
      'https://x.com/events': listHtml,
      'https://x.com/e/2': detail(2),
      // e/1 은 없음 → 404
    });

    const items = await htmlAdapter.collect(source, ctx);
    expect(items).toHaveLength(1);
    expect(items[0]?.url).toBe('https://x.com/e/2');
  });

  it('본문이 너무 짧으면 버린다', async () => {
    const ctx = makeContext({
      'https://x.com/events': '<ul><li class="item"><a href="/e/1">A</a></li></ul>',
      'https://x.com/e/1': '<body><article>짧음</article></body>', // 40자 미만
    });

    expect(await htmlAdapter.collect(source, ctx)).toHaveLength(0);
  });

  it('selectors.item 이 없으면 설정 오류를 알린다', async () => {
    const ctx = makeContext({});
    await expect(htmlAdapter.collect({ ...source, selectors: undefined }, ctx)).rejects.toThrow(
      /selectors.item/,
    );
  });
});

describe('rssAdapter', () => {
  const source: SourceConfig = {
    id: 'feed',
    name: '피드',
    kind: 'rss',
    url: 'https://x.com/feed.xml',
    enabled: true,
    maxItems: 10,
  };

  it('RSS item 을 읽는다', async () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item>
        <title>이벤트 A</title>
        <link>https://x.com/a</link>
        <description>${'참여 방법과 기간이 상세히 적힌 충분히 긴 요약문입니다. '.repeat(6)}</description>
      </item>
    </channel></rss>`;

    const items = await rssAdapter.collect(source, makeContext({ 'https://x.com/feed.xml': xml }));

    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('이벤트 A');
    expect(items[0]?.url).toBe('https://x.com/a');
    expect(items[0]?.text).toContain('참여 방법');
  });

  it('Atom entry 의 link href 를 읽는다', async () => {
    const xml = `<?xml version="1.0"?><feed>
      <entry>
        <title>이벤트 B</title>
        <link href="https://x.com/b"/>
        <summary>${'긴 요약문입니다. '.repeat(20)}</summary>
      </entry>
    </feed>`;

    const items = await rssAdapter.collect(source, makeContext({ 'https://x.com/feed.xml': xml }));
    expect(items[0]?.url).toBe('https://x.com/b');
  });

  it('요약이 짧으면 상세 페이지를 가져온다', async () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>C</title><link>https://x.com/c</link><description>짧음</description></item>
    </channel></rss>`;

    const ctx = makeContext({
      'https://x.com/feed.xml': xml,
      'https://x.com/c': `<body><article>${'상세 본문입니다. '.repeat(20)}</article></body>`,
    });

    const items = await rssAdapter.collect(source, ctx);

    expect(ctx.fetched).toContain('https://x.com/c');
    expect(items[0]?.text).toContain('상세 본문');
  });
});

describe('fixtureAdapter', () => {
  it('로컬 JSON 파일을 읽는다 (네트워크 접근 없음)', async () => {
    const source: SourceConfig = {
      id: 'fx',
      name: '픽스처',
      kind: 'fixture',
      url: 'scripts/pipeline/fixtures/sample.json',
      enabled: true,
      maxItems: 10,
    };

    const ctx = makeContext({});
    const items = await fixtureAdapter.collect(source, ctx);

    expect(items.length).toBeGreaterThan(0);
    expect(ctx.fetched).toHaveLength(0);
    expect(items[0]?.sourceId).toBe('fx');
  });

  it('maxItems 를 지킨다', async () => {
    const source: SourceConfig = {
      id: 'fx',
      name: '픽스처',
      kind: 'fixture',
      url: 'scripts/pipeline/fixtures/sample.json',
      enabled: true,
      maxItems: 1,
    };

    expect(await fixtureAdapter.collect(source, makeContext({}))).toHaveLength(1);
  });
});

describe('getAdapter', () => {
  it('알려진 종류를 돌려준다', () => {
    expect(getAdapter('html').kind).toBe('html');
    expect(getAdapter('rss').kind).toBe('rss');
    expect(getAdapter('fixture').kind).toBe('fixture');
  });

  it('모르는 종류는 사용 가능한 목록과 함께 알린다', () => {
    expect(() => getAdapter('graphql')).toThrow(/html, rss, fixture/);
  });
});
