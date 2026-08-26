import { describe, expect, it } from 'vitest';
import { charsetFromContentType, createDecoder } from '@pipeline/fetch/http';
import { assembleDeal } from '@pipeline/assemble';
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
