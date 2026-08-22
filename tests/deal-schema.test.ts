import { describe, expect, it } from 'vitest';
import rawDeals from '@/data/deals.json';
import { parseDealsFile, safeParseDeal } from '@/lib/deal-schema';
import { getAllDeals, getDealBySlug, getDecoratedDeals } from '@/lib/deals';
import { DEAL_SCHEMA_VERSION } from '@/types/deal';
import { makeDeal } from './fixtures';

describe('dealSchema', () => {
  it('유효한 Deal 을 통과시킨다', () => {
    expect(safeParseDeal(makeDeal()).success).toBe(true);
  });

  it('슬러그에 대문자나 공백이 있으면 거부한다', () => {
    expect(safeParseDeal(makeDeal({ slug: 'Bad Slug' })).success).toBe(false);
    expect(safeParseDeal(makeDeal({ slug: '한글슬러그' })).success).toBe(false);
  });

  it('알 수 없는 카테고리를 거부한다', () => {
    // @ts-expect-error 존재하지 않는 카테고리를 일부러 넣습니다.
    expect(safeParseDeal(makeDeal({ category: 'unknown' })).success).toBe(false);
  });

  it('링크가 http/https 가 아니면 거부한다', () => {
    expect(safeParseDeal(makeDeal({ link: { url: 'javascript:alert(1)' } })).success).toBe(false);
    expect(safeParseDeal(makeDeal({ link: { url: 'not-a-url' } })).success).toBe(false);
  });

  it('정가가 실지불액보다 작으면 거부한다', () => {
    const result = safeParseDeal(
      makeDeal({ price: { original: 1000, final: 5000, currency: 'KRW' } }),
    );
    expect(result.success).toBe(false);
  });

  it('종료 시각이 시작 시각보다 앞서면 거부한다', () => {
    const result = safeParseDeal(
      makeDeal({
        period: { startAt: '2026-08-20T00:00:00+09:00', endAt: '2026-08-10T00:00:00+09:00' },
      }),
    );
    expect(result.success).toBe(false);
  });

  it('남은 수량이 총 수량보다 크면 거부한다', () => {
    const result = safeParseDeal(
      makeDeal({ limit: { firstComeFirstServed: true, quantity: 10, remaining: 20 } }),
    );
    expect(result.success).toBe(false);
  });

  it('날짜 형식이 아니면 거부한다', () => {
    expect(safeParseDeal(makeDeal({ period: { startAt: '어제' } })).success).toBe(false);
  });

  it('타임존 오프셋이 없는 날짜/시간을 거부한다', () => {
    // 오프셋이 없으면 빌드 머신 타임존으로 해석돼 KST 기준 계산이 하루씩 어긋납니다.
    expect(safeParseDeal(makeDeal({ period: { endAt: '2026-08-31' } })).success).toBe(false);
    expect(safeParseDeal(makeDeal({ period: { endAt: '2026-08-31T23:59:59' } })).success).toBe(
      false,
    );
    expect(
      safeParseDeal(makeDeal({ meta: { verified: true, updatedAt: '12/31/2026' } })).success,
    ).toBe(false);
  });

  it('오프셋이나 Z 가 붙은 값은 허용한다', () => {
    expect(
      safeParseDeal(makeDeal({ period: { endAt: '2026-08-31T23:59:59+09:00' } })).success,
    ).toBe(true);
    expect(safeParseDeal(makeDeal({ period: { endAt: '2026-08-31T14:59:59Z' } })).success).toBe(
      true,
    );
  });

  it('존재하지 않는 달력 날짜를 거부한다', () => {
    // Date.parse 는 2월 30일을 3월 2일로 롤오버시켜 조용히 통과시킵니다.
    expect(
      safeParseDeal(makeDeal({ period: { endAt: '2026-02-30T00:00:00+09:00' } })).success,
    ).toBe(false);
    expect(
      safeParseDeal(makeDeal({ period: { endAt: '2026-13-01T00:00:00+09:00' } })).success,
    ).toBe(false);
  });

  it('명시된 할인율이 정가·실지불액과 모순되면 거부한다', () => {
    const result = safeParseDeal(
      makeDeal({ price: { original: 10000, final: 9000, currency: 'KRW', discountRate: 90 } }),
    );
    expect(result.success).toBe(false);
  });

  it('반올림 오차 범위의 할인율은 허용한다', () => {
    // 3000 -> 1000 은 66.67%. 관행적으로 67% 로 표기하는 경우를 막지 않습니다.
    const result = safeParseDeal(
      makeDeal({ price: { original: 3000, final: 1000, currency: 'KRW', discountRate: 67 } }),
    );
    expect(result.success).toBe(true);
  });

  it('상시 혜택(endAt: null)을 허용한다', () => {
    expect(safeParseDeal(makeDeal({ period: { endAt: null } })).success).toBe(true);
  });

  it('LLM 신뢰도가 0~1 범위를 벗어나면 거부한다', () => {
    const result = safeParseDeal(
      makeDeal({
        source: {
          name: 'x',
          collectedAt: '2026-08-20T00:00:00+09:00',
          method: 'llm',
          confidence: 1.5,
        },
      }),
    );
    expect(result.success).toBe(false);
  });
});

describe('parseDealsFile', () => {
  const validFile = {
    schemaVersion: DEAL_SCHEMA_VERSION,
    generatedAt: '2026-08-20T06:00:00+09:00',
    deals: [makeDeal()],
  };

  it('유효한 파일을 파싱한다', () => {
    expect(parseDealsFile(validFile).deals).toHaveLength(1);
  });

  it('중복된 id 를 잡아낸다', () => {
    const file = {
      ...validFile,
      deals: [makeDeal({ id: 'dup', slug: 'a' }), makeDeal({ id: 'dup', slug: 'b' })],
    };
    expect(() => parseDealsFile(file)).toThrow(/중복된 id/);
  });

  it('중복된 slug 를 잡아낸다', () => {
    const file = {
      ...validFile,
      deals: [makeDeal({ id: 'a', slug: 'dup' }), makeDeal({ id: 'b', slug: 'dup' })],
    };
    expect(() => parseDealsFile(file)).toThrow(/중복된 slug/);
  });

  it('스키마 버전이 다르면 거부한다', () => {
    expect(() => parseDealsFile({ ...validFile, schemaVersion: 999 })).toThrow(/버전 불일치/);
  });

  it('검증 실패 메시지에 필드 경로가 포함된다', () => {
    const file = { ...validFile, deals: [makeDeal({ slug: 'BAD' })] };
    expect(() => parseDealsFile(file)).toThrow(/deals\.0\.slug/);
  });
});

describe('실제 deals.json 데이터', () => {
  it('스키마 검증을 통과한다', () => {
    expect(() => parseDealsFile(rawDeals)).not.toThrow();
  });

  it('비어 있지 않다', () => {
    expect(getAllDeals().length).toBeGreaterThan(0);
  });

  it('모든 혜택의 슬러그가 고유하다', () => {
    const slugs = getAllDeals().map((deal) => deal.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('슬러그로 단건을 찾을 수 있다', () => {
    const first = getAllDeals()[0];
    expect(first).toBeDefined();
    expect(getDealBySlug(first!.slug)?.id).toBe(first!.id);
  });

  it('없는 슬러그는 undefined 를 반환한다', () => {
    expect(getDealBySlug('존재하지-않는-슬러그')).toBeUndefined();
  });

  it('모든 혜택에 파생 필드가 계산된다', () => {
    for (const deal of getDecoratedDeals()) {
      expect(deal.status).toBeDefined();
      expect(typeof deal.isActionable).toBe('boolean');
      expect(typeof deal.isUrgent).toBe('boolean');
    }
  });

  it('외부 링크가 모두 https 다', () => {
    for (const deal of getAllDeals()) {
      expect(deal.link.url.startsWith('https://')).toBe(true);
    }
  });
});
