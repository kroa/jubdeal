import { describe, expect, it } from 'vitest';
import { charsetFromContentType, createDecoder } from '@pipeline/fetch/http';
import { assembleDeal } from '@pipeline/assemble';
import {
  DETAIL_FAILURE_LIMIT,
  alignScheme,
  htmlToText,
  rssAdapter,
  stripQueryParams,
} from '@pipeline/adapters/index';
import { formatDeadline } from '@/lib/format';
import { dealPeriodSchema } from '@/lib/deal-schema';
import type { ExtractedDeal } from '@pipeline/extract/schema';
import type { RawItem } from '@pipeline/types';

/**
 * 실제 소스에 붙이면서 드러난 결함들의 회귀 테스트
 * ---------------------------------------------------------------------------
 * 셋 다 모의 객체로는 보이지 않았습니다.
 * 픽스처는 UTF-8 이고, 모의 모델은 원문에 있는 URL만 돌려주며,
 * 샘플 데이터는 마감일이 늘 적혀 있었기 때문입니다.
 */

const NOW = new Date('2026-08-26T10:00:00+09:00');

const RAW: RawItem = {
  sourceId: 'test-source',
  sourceName: '테스트 소스',
  url: 'https://bbs.example-board.com/market/read/123',
  title: '테스트 글',
  text: '본문입니다. 구매는 https://shop.example.com/products/9999 에서 하세요.',
  collectedAt: NOW.toISOString(),
};

function makeExtracted(overrides: Partial<ExtractedDeal> = {}): ExtractedDeal {
  return {
    isDeal: true,
    confidence: 0.9,
    notes: '',
    title: '테스트 혜택',
    summary: '테스트 요약입니다.',
    description: '',
    brandName: '테스트브랜드',
    category: 'shopping',
    dealType: 'discount',
    difficulty: 'easy',
    originalPrice: 10000,
    finalPrice: 8000,
    startDate: null,
    endDate: null,
    endDateKind: 'unknown',
    firstComeFirstServed: false,
    quantity: null,
    perPersonLimit: null,
    linkUrl: null,
    linkLabel: null,
    howTo: [],
    caution: [],
    tags: ['테스트'],
    ...overrides,
  } as ExtractedDeal;
}

/* -------------------------------------------------------------------------- */
/* 1. 응답 인코딩                                                              */
/* -------------------------------------------------------------------------- */

describe('응답 인코딩', () => {
  it('Content-Type 에서 charset 을 뽑는다', () => {
    expect(charsetFromContentType('text/html; charset=euc-kr')).toBe('euc-kr');
    expect(charsetFromContentType('text/html;charset=UTF-8')).toBe('utf-8');
    expect(charsetFromContentType('text/html; charset="EUC-KR"')).toBe('euc-kr');
    expect(charsetFromContentType('text/html')).toBeNull();
    expect(charsetFromContentType(null)).toBeNull();
  });

  it('EUC-KR 응답을 EUC-KR 로 읽는다', () => {
    /*
      UTF-8 을 하드코딩하면 한국 사이트 본문이 통째로 깨집니다.
      HTTP 오류가 아니라 조용히 쓰레기 텍스트가 되기 때문에,
      "혜택 정보가 아님" 판정만 쌓이고 원인을 찾기 어렵습니다.
    */
    const decoder = createDecoder('text/html; charset=euc-kr', 'https://x.test');
    expect(decoder.encoding).toBe('euc-kr');

    // EUC-KR 로 인코딩된 "무료" (b9 ab b7 e1)
    const bytes = new Uint8Array([0xb9, 0xab, 0xb7, 0xe1]);
    expect(decoder.decode(bytes)).toBe('무료');

    // 같은 바이트를 UTF-8 로 읽으면 복구 불가능한 문자가 됩니다.
    expect(new TextDecoder('utf-8').decode(bytes)).not.toBe('무료');
  });

  it('charset 이 없거나 모르면 UTF-8 로 물러선다', () => {
    expect(createDecoder('text/html', 'https://x.test').encoding).toBe('utf-8');
    expect(createDecoder(null, 'https://x.test').encoding).toBe('utf-8');

    const messages: string[] = [];
    const decoder = createDecoder('text/html; charset=nonsense-999', 'https://x.test', (m) =>
      messages.push(m),
    );
    expect(decoder.encoding).toBe('utf-8');
    // 조용히 넘어가면 왜 깨졌는지 알 수 없으므로 남깁니다.
    expect(messages.join(' ')).toContain('nonsense-999');
  });
});

/* -------------------------------------------------------------------------- */
/* 2. 링크 환각 방어                                                            */
/* -------------------------------------------------------------------------- */

describe('CTA 링크', () => {
  it('원문에 있는 URL 은 그대로 쓴다', () => {
    const result = assembleDeal(
      makeExtracted({ linkUrl: 'https://shop.example.com/products/9999' }),
      RAW,
      { now: NOW },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deal.link.url).toBe('https://shop.example.com/products/9999');
  });

  it('원문에 없는 URL 은 쓰지 않고 원문 글 주소로 돌아간다', () => {
    /*
      링크는 사용자가 눌러서 다른 사이트로 이동하는 값입니다.
      지어낸 주소가 끼면 죽은 링크로 보내게 되는데, 형식이 유효하면
      스키마 검증은 통과하므로 여기서 막아야 합니다.
    */
    const result = assembleDeal(
      makeExtracted({ linkUrl: 'https://totally-made-up.example.org/deal/1' }),
      RAW,
      { now: NOW },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deal.link.url).toBe(RAW.url);
  });

  it('추적 파라미터가 붙어도 호스트·경로가 같으면 인정한다', () => {
    const result = assembleDeal(
      makeExtracted({ linkUrl: 'https://shop.example.com/products/9999?utm_source=x' }),
      RAW,
      { now: NOW },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deal.link.url).toBe('https://shop.example.com/products/9999?utm_source=x');
  });

  it('http/https 가 아니면 거부한다', () => {
    const result = assembleDeal(makeExtracted({ linkUrl: 'javascript:alert(1)' as string }), RAW, {
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deal.link.url).toBe(RAW.url);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. 마감일 미상                                                              */
/* -------------------------------------------------------------------------- */

describe('마감일 미상', () => {
  it('스키마가 미상 표시를 받아들인다', () => {
    const parsed = dealPeriodSchema.safeParse({
      startAt: '2026-08-26T00:00:00+09:00',
      endAt: null,
      deadlineUnknown: true,
    });

    expect(parsed.success).toBe(true);
  });

  it('마감일을 알면서 미상이라고 하면 거절한다', () => {
    // 둘 다 참이면 화면이 어느 쪽을 믿을지 알 수 없습니다.
    const parsed = dealPeriodSchema.safeParse({
      startAt: '2026-08-26T00:00:00+09:00',
      endAt: '2026-08-31T23:59:59+09:00',
      deadlineUnknown: true,
    });

    expect(parsed.success).toBe(false);
  });

  it('화면에 "상시 진행" 대신 "마감일 미상"을 보여준다', () => {
    // 모르는 것을 상시라고 표기하면 사용자에게 거짓말이 됩니다.
    expect(
      formatDeadline({
        daysLeft: null,
        status: 'ongoing',
        period: { startAt: '2026-08-26T00:00:00+09:00', deadlineUnknown: true },
      }),
    ).toBe('마감일 미상');

    expect(
      formatDeadline({
        daysLeft: null,
        status: 'ongoing',
        period: { startAt: '2026-08-26T00:00:00+09:00' },
      }),
    ).toBe('상시 진행');
  });

  it('종료·소진 표기가 미상보다 우선한다', () => {
    const period = { startAt: '2026-08-26T00:00:00+09:00', deadlineUnknown: true };

    expect(formatDeadline({ daysLeft: null, status: 'ended', period })).toBe('종료됨');
    expect(formatDeadline({ daysLeft: null, status: 'sold_out', period })).toBe('소진됨');
  });
});

/* -------------------------------------------------------------------------- */
/* 4. 링크 정규화 (뽐뿌·클리앙에서 관측)                                        */
/* -------------------------------------------------------------------------- */

describe('링크 정규화', () => {
  it('같은 사이트의 http 링크를 https 로 올린다', () => {
    /*
      뽐뿌는 http 로 요청하면 3xx 가 아니라
      <script>location.href='https://...'</script> 한 줄(104바이트)을 줍니다.
      크롤러는 JS 를 실행하지 않으니 본문 대신 그 한 줄을 받고 끝나는데,
      상태는 200 이고 리다이렉트도 아니라 실패한 티가 안 납니다.
    */
    expect(
      alignScheme(
        'https://www.ppomppu.co.kr/rss.php?id=coupon',
        'http://www.ppomppu.co.kr/zboard/view.php?id=coupon&no=1',
      ),
    ).toBe('https://www.ppomppu.co.kr/zboard/view.php?id=coupon&no=1');
  });

  it('https 를 http 로 내리지는 않는다', () => {
    // 암호화를 벗기는 방향은 어떤 경우에도 하지 않습니다.
    expect(alignScheme('http://example.com/feed', 'https://example.com/article/1')).toBe(
      'https://example.com/article/1',
    );
  });

  it('다른 사이트의 링크는 건드리지 않는다', () => {
    expect(alignScheme('https://example.com/feed', 'http://other.test/a')).toBe(
      'http://other.test/a',
    );
  });

  it('목록 정렬 파라미터를 지운다', () => {
    /*
      클리앙 목록은 정렬 상태를 링크에 실어 보냅니다.
      그대로 두면 같은 글이 두 URL 로 보여 중복 수집되고,
      URL 로 만드는 안정 ID 까지 흔들려 정렬이 바뀔 때마다 다시 쌓입니다.
    */
    expect(
      stripQueryParams(
        'https://www.clien.net/service/board/jirum/19253940?od=T31&po=0&category=0&groupCd=',
        ['od', 'po', 'category', 'groupCd'],
      ),
    ).toBe('https://www.clien.net/service/board/jirum/19253940');
  });

  it('지정하지 않은 파라미터는 남긴다', () => {
    // 뽐뿌의 id·no 처럼 글을 특정하는 값을 지우면 안 됩니다.
    expect(
      stripQueryParams('https://www.ppomppu.co.kr/zboard/view.php?id=coupon&no=1&po=0', ['po']),
    ).toBe('https://www.ppomppu.co.kr/zboard/view.php?id=coupon&no=1');
  });

  it('설정이 없으면 URL 을 그대로 둔다', () => {
    const url = 'https://example.com/a?x=1';
    expect(stripQueryParams(url, undefined)).toBe(url);
    expect(stripQueryParams(url, [])).toBe(url);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. 본문과 댓글 분리 (어미새에서 관측)                                        */
/* -------------------------------------------------------------------------- */

describe('본문 추출', () => {
  /*
    게시판 소프트웨어는 본문과 댓글에 같은 클래스를 붙이는 일이 흔합니다.
    (XE/라이믹스의 .xe_content, 뽐뿌의 .board-contents)
    매칭을 전부 합치면 댓글이 본문으로 흘러들어, 실제로 어미새에서
    "100원에 구매했습니다" 라는 댓글 한 줄이 본문 행세를 했습니다.
    그대로 두면 100원딜로 둔갑해 사용자에게 노출됩니다.
  */
  const HTML = `
    <html><body>
      <div class="xe_content">헤인즈 기본아이템 공홈 시즌오프 최대 40% 할인합니다.</div>
      <ul class="comments">
        <li><div class="xe_content">100원에구매했습니다</div></li>
        <li><div class="xe_content">맛있겠다</div></li>
      </ul>
    </body></html>`;

  it('선택자가 여러 개 매칭돼도 첫 번째(본문)만 쓴다', () => {
    const text = htmlToText(HTML, '.xe_content');

    expect(text).toContain('헤인즈');
    expect(text).not.toContain('100원에구매했습니다');
    expect(text).not.toContain('맛있겠다');
  });

  it('선택자가 없으면 body 전체를 쓴다', () => {
    expect(htmlToText(HTML)).toContain('헤인즈');
  });

  it('선택자가 아무것도 못 맞히면 body 로 물러선다', () => {
    // 사이트 구조가 바뀌어 선택자가 죽었을 때 빈 문자열을 돌려주면
    // 원인 모를 "본문이 너무 짧음" 만 쌓입니다.
    const text = htmlToText(HTML, '.does-not-exist');
    expect(text).toContain('헤인즈');
  });

  it('script·style 은 본문에서 제외한다', () => {
    const withScript = `
      <html><body><div class="c">
        본문입니다<script>var x = "스크립트";</script><style>.a{color:red}</style>
      </div></body></html>`;

    const text = htmlToText(withScript, '.c');
    expect(text).toContain('본문입니다');
    expect(text).not.toContain('스크립트');
    expect(text).not.toContain('color:red');
  });
});

/* -------------------------------------------------------------------------- */
/* 6. 상세 요청 차단기 (CI 실행에서 관측)                                       */
/* -------------------------------------------------------------------------- */

describe('상세 페이지 차단기', () => {
  /*
    뽐뿌는 GitHub Actions 의 데이터센터 IP 를 봇으로 보고
    `ppck=1` 챌린지로 리다이렉트한 뒤 403 을 돌려줍니다.
    같은 요청이 가정용 회선에서는 200 이라 로컬에서는 드러나지 않았습니다.

    그때 항목마다 계속 두드리면 실패가 뻔한 요청에 레이트리밋 대기(3~5초)를
    그대로 태웁니다. 실제 실행에서 29번을 헛되이 두드리며 90초를 버렸습니다.
  */
  const FEED = `<?xml version="1.0"?><rss><channel>
    ${Array.from({ length: 10 }, (_, i) => `<item><title>항목 ${i}</title><link>https://board.test/read/${i}</link><description>피드 요약입니다. 상세 페이지에는 더 자세한 조건과 참여 방법이 적혀 있습니다. 항목 번호 ${i} 입니다.</description></item>`).join('')}
  </channel></rss>`;

  function makeCtx(onDetail: (url: string) => string) {
    const detailCalls: string[] = [];

    return {
      detailCalls,
      ctx: {
        now: new Date('2026-08-29T00:00:00+09:00'),
        log: () => {},
        fetchText: async (url: string) => {
          if (url.includes('/feed')) return FEED;
          detailCalls.push(url);
          return onDetail(url);
        },
      },
    };
  }

  const SOURCE = {
    id: 'board',
    name: '테스트 게시판',
    kind: 'rss',
    url: 'https://board.test/feed',
    enabled: true,
    maxItems: 10,
  };

  it('상세가 계속 실패하면 두드리기를 멈춘다', async () => {
    const { ctx, detailCalls } = makeCtx(() => {
      throw new Error('HTTP 403');
    });

    const items = await rssAdapter.collect(SOURCE, ctx);

    // 한도까지만 시도하고 나머지는 요약으로 처리합니다.
    expect(detailCalls).toHaveLength(DETAIL_FAILURE_LIMIT);
    // 포기했다고 항목까지 버리지는 않습니다. 요약이 충분하면 그걸로 남깁니다.
    // (실제 뽐뿌 RSS 요약이 49~135자라 이 경로로 11건이 살아남았습니다.)
    expect(items.length).toBe(10);
  });

  it('중간에 성공하면 실패 횟수를 초기화한다', async () => {
    // 일시적인 오류 두어 번으로 성급히 포기하면 안 됩니다.
    let call = 0;
    const { ctx, detailCalls } = makeCtx(() => {
      call += 1;
      // 2번 실패 → 1번 성공 → 다시 반복
      if (call % 3 === 0) return '<html><body>' + '본문입니다. '.repeat(30) + '</body></html>';
      throw new Error('HTTP 503');
    });

    await rssAdapter.collect(SOURCE, ctx);

    // 연속 3회에 도달하지 않으므로 끝까지 시도합니다.
    expect(detailCalls.length).toBeGreaterThan(DETAIL_FAILURE_LIMIT);
  });

  it('상세가 잘 되면 전부 가져온다', async () => {
    const { ctx, detailCalls } = makeCtx(
      () => '<html><body>' + '충분히 긴 본문입니다. '.repeat(20) + '</body></html>',
    );

    const items = await rssAdapter.collect(SOURCE, ctx);

    expect(detailCalls).toHaveLength(10);
    expect(items).toHaveLength(10);
  });
});
