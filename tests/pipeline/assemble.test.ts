import { describe, expect, it } from 'vitest';
import {
  assembleDeal,
  canonicalizeUrl,
  makeSlug,
  makeStableId,
  toKstIso,
} from '@pipeline/assemble';
import type { ExtractedDeal } from '@pipeline/extract/schema';
import type { RawItem } from '@pipeline/types';

const NOW = new Date('2026-08-23T12:00:00+09:00');

const RAW: RawItem = {
  sourceId: 'demo',
  sourceName: '데모 소스',
  url: 'https://example.com/events/free-coffee',
  title: '무료 커피',
  text: '본문',
  collectedAt: '2026-08-23T03:00:00.000Z',
};

function makeExtracted(overrides: Partial<ExtractedDeal> = {}): ExtractedDeal {
  return {
    isDeal: true,
    confidence: 0.9,
    notes: '',
    title: '아메리카노 무료 쿠폰',
    summary: '앱 가입 시 아메리카노 1잔 무료',
    description: '',
    brandName: '온더카페',
    category: 'cafe',
    dealType: 'free',
    difficulty: 'easy',
    originalPrice: 4500,
    finalPrice: 0,
    firstComeFirstServed: false,
    quantity: null,
    perPersonLimit: 1,
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    endDateKind: 'dated' as const,
    linkUrl: null,
    linkLabel: '쿠폰 받기',
    howTo: ['앱 설치', '회원가입'],
    caution: ['1인 1회'],
    tags: ['무료', '카페'],
    ...overrides,
  };
}

describe('canonicalizeUrl', () => {
  it('추적 파라미터를 제거한다', () => {
    expect(canonicalizeUrl('https://x.com/a?utm_source=kakao&id=3')).toBe('https://x.com/a?id=3');
    expect(canonicalizeUrl('https://x.com/a?fbclid=zzz')).toBe('https://x.com/a');
  });

  it('프래그먼트를 제거한다', () => {
    expect(canonicalizeUrl('https://x.com/a#section')).toBe('https://x.com/a');
  });

  it('쿼리 순서가 달라도 같은 결과를 낸다', () => {
    expect(canonicalizeUrl('https://x.com/a?b=2&a=1')).toBe(
      canonicalizeUrl('https://x.com/a?a=1&b=2'),
    );
  });

  it('끝의 슬래시를 무시한다', () => {
    expect(canonicalizeUrl('https://x.com/a/')).toBe(canonicalizeUrl('https://x.com/a'));
  });

  it('잘못된 URL 은 그대로 돌려준다', () => {
    expect(canonicalizeUrl('not a url')).toBe('not a url');
  });
});

describe('makeStableId', () => {
  it('같은 소스·URL 이면 항상 같은 id 를 만든다', () => {
    // 이게 깨지면 매 실행마다 같은 혜택이 중복 등록됩니다.
    expect(makeStableId('demo', RAW.url)).toBe(makeStableId('demo', RAW.url));
  });

  it('추적 파라미터가 달라도 같은 id 를 만든다', () => {
    expect(makeStableId('demo', 'https://x.com/a')).toBe(
      makeStableId('demo', 'https://x.com/a?utm_medium=sns'),
    );
  });

  it('소스가 다르면 다른 id 를 만든다', () => {
    expect(makeStableId('a', RAW.url)).not.toBe(makeStableId('b', RAW.url));
  });

  it('URL 이 다르면 다른 id 를 만든다', () => {
    expect(makeStableId('demo', 'https://x.com/a')).not.toBe(
      makeStableId('demo', 'https://x.com/b'),
    );
  });
});

describe('makeSlug', () => {
  it('스키마가 허용하는 문자만 쓴다', () => {
    const slug = makeSlug('demo', RAW.url, 'seed');
    expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it('한글 URL 에서도 유효한 슬러그를 만든다', () => {
    const slug = makeSlug('demo', 'https://x.com/이벤트/무료커피', 'seed');
    expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it('결정적이다', () => {
    expect(makeSlug('demo', RAW.url, 'seed')).toBe(makeSlug('demo', RAW.url, 'seed'));
  });

  it('길이 상한을 지킨다', () => {
    const long = `https://x.com/${'가나다'.repeat(50)}/${'abcdefghij'.repeat(20)}`;
    expect(makeSlug('demo', long, 'seed').length).toBeLessThanOrEqual(80);
  });
});

describe('toKstIso', () => {
  it('날짜만 있으면 KST 자정으로 만든다', () => {
    expect(toKstIso('2026-09-01')).toBe('2026-09-01T00:00:00+09:00');
  });

  it('종료일은 그날 끝으로 만든다', () => {
    expect(toKstIso('2026-09-30', true)).toBe('2026-09-30T23:59:59+09:00');
  });

  it('시각이 있으면 그대로 쓴다', () => {
    expect(toKstIso('2026-09-01T10:30')).toBe('2026-09-01T10:30:00+09:00');
  });

  it('null 은 null', () => {
    expect(toKstIso(null)).toBeNull();
  });
});

describe('assembleDeal', () => {
  it('정식 스키마를 통과하는 Deal 을 만든다', () => {
    const result = assembleDeal(makeExtracted(), RAW, { now: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.deal.title).toBe('아메리카노 무료 쿠폰');
    expect(result.deal.period.startAt).toBe('2026-09-01T00:00:00+09:00');
    expect(result.deal.period.endAt).toBe('2026-09-30T23:59:59+09:00');
    expect(result.deal.price).toEqual({ original: 4500, final: 0, currency: 'KRW' });
  });

  it('자동 수집분은 verified 가 false 이고 method 가 llm 이다', () => {
    const result = assembleDeal(makeExtracted(), RAW, { now: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.deal.meta.verified).toBe(false);
    expect(result.deal.source.method).toBe('llm');
    expect(result.deal.source.confidence).toBe(0.9);
  });

  it('모델이 링크를 안 주면 원문 URL 을 쓴다', () => {
    const result = assembleDeal(makeExtracted({ linkUrl: null }), RAW, { now: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deal.link.url).toBe(RAW.url);
  });

  it('모델이 준 링크가 http(s) 가 아니면 원문 URL 로 대체한다', () => {
    const result = assembleDeal(makeExtracted({ linkUrl: 'javascript:alert(1)' }), RAW, {
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deal.link.url).toBe(RAW.url);
  });

  it('상시 진행(always)이면 종료일 없이 통과시킨다', () => {
    const result = assembleDeal(makeExtracted({ endDate: null, endDateKind: 'always' }), RAW, {
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deal.period.endAt).toBeNull();
  });

  it('시작일이 없으면 오늘(KST)로 채운다', () => {
    const result = assembleDeal(makeExtracted({ startDate: null }), RAW, { now: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deal.period.startAt).toBe('2026-08-23T00:00:00+09:00');
  });

  it('기존 항목이 있으면 id 와 slug 를 물려받는다', () => {
    // 이게 깨지면 이미 공유된 상세 페이지 URL 이 죽습니다.
    const result = assembleDeal(makeExtracted(), RAW, {
      now: NOW,
      existing: { id: 'dl_old_id', slug: 'old-slug' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deal.id).toBe('dl_old_id');
    expect(result.deal.slug).toBe('old-slug');
  });

  it('정가가 실지불액보다 작으면 스키마 위반으로 걸러낸다', () => {
    const result = assembleDeal(makeExtracted({ originalPrice: 100, finalPrice: 5000 }), RAW, {
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('original');
  });

  it('종료일이 시작일보다 앞서면 걸러낸다', () => {
    const result = assembleDeal(
      makeExtracted({ startDate: '2026-09-30', endDate: '2026-09-01' }),
      RAW,
      { now: NOW },
    );

    expect(result.ok).toBe(false);
  });

  it('빈 값은 선택 필드에서 아예 제외한다', () => {
    const result = assembleDeal(
      makeExtracted({ description: '', howTo: [], caution: [], linkLabel: null }),
      RAW,
      { now: NOW },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deal.description).toBeUndefined();
    expect(result.deal.howTo).toBeUndefined();
    expect(result.deal.caution).toBeUndefined();
    expect(result.deal.link.label).toBeUndefined();
  });

  it('종료일을 모르면 상시 진행이라 단언하지 않고 미상으로 표시한다', () => {
    /*
      커뮤니티 핫딜 글은 마감일을 적지 않는 것이 보통입니다.
      그렇다고 endAt 을 그냥 null 로 두면 "상시 진행"과 구분되지 않아,
      언제 끝날지 모르는 특가를 상시라고 단언하게 됩니다.
      날짜를 지어내지도, 버리지도 않고 모른다고 표시합니다.
    */
    const result = assembleDeal(makeExtracted({ endDate: null, endDateKind: 'unknown' }), RAW, {
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deal.period.endAt).toBeNull();
    expect(result.deal.period.deadlineUnknown).toBe(true);
  });

  it('상시 진행(always)에는 미상 표시를 붙이지 않는다', () => {
    const result = assembleDeal(makeExtracted({ endDate: null, endDateKind: 'always' }), RAW, {
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deal.period.endAt).toBeNull();
    expect(result.deal.period.deadlineUnknown).toBeUndefined();
  });

  it('가격을 모르면 지어내지 않고 검수로 보낸다', () => {
    const result = assembleDeal(makeExtracted({ finalPrice: null }), RAW, { now: NOW });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('금액');
  });

  it('endDateKind 가 dated 인데 날짜가 없으면 거절한다', () => {
    const result = assembleDeal(makeExtracted({ endDate: null, endDateKind: 'dated' }), RAW, {
      now: NOW,
    });

    expect(result.ok).toBe(false);
  });

  it('중복 태그를 제거한다', () => {
    const result = assembleDeal(makeExtracted({ tags: ['무료', '무료', ' 무료 ', '카페'] }), RAW, {
      now: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deal.tags).toEqual(['무료', '카페']);
  });
});
