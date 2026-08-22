import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTER,
  applySort,
  countByCategory,
  countByDealType,
  countByDifficulty,
  filterDeals,
  hasActiveFilter,
  matchesFilter,
  matchesQuery,
  toggleValue,
  type DealFilterState,
} from '@/lib/deal-filter';
import { makeDecoratedDeal } from './fixtures';

function withFilter(overrides: Partial<DealFilterState> = {}): DealFilterState {
  return { ...DEFAULT_FILTER, ...overrides };
}

describe('toggleValue', () => {
  it('없던 값을 추가한다', () => {
    expect(toggleValue(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('있던 값을 제거한다', () => {
    expect(toggleValue(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('원본 배열을 변경하지 않는다', () => {
    const original = ['a'];
    toggleValue(original, 'b');
    expect(original).toEqual(['a']);
  });
});

describe('matchesQuery', () => {
  const deal = makeDecoratedDeal({
    title: '온더카페 아메리카노 무료',
    summary: '앱 가입만 하면 됩니다',
    brand: { name: '온더카페' },
    tags: ['신규가입', '무료음료'],
  });

  it('빈 검색어는 모두 통과시킨다', () => {
    expect(matchesQuery(deal, '')).toBe(true);
    expect(matchesQuery(deal, '   ')).toBe(true);
  });

  it('제목으로 검색된다', () => {
    expect(matchesQuery(deal, '아메리카노')).toBe(true);
  });

  it('브랜드명으로 검색된다', () => {
    expect(matchesQuery(deal, '온더카페')).toBe(true);
  });

  it('태그로 검색된다', () => {
    expect(matchesQuery(deal, '신규가입')).toBe(true);
  });

  it('검색어 안의 공백은 무시한다', () => {
    expect(matchesQuery(deal, '아메리 카노')).toBe(true);
  });

  it('대소문자를 구분하지 않는다', () => {
    const english = makeDecoratedDeal({ title: 'FREE Coffee Event' });
    expect(matchesQuery(english, 'free coffee')).toBe(true);
  });

  it('없는 단어는 걸러진다', () => {
    expect(matchesQuery(deal, '라떼')).toBe(false);
  });
});

describe('matchesFilter', () => {
  const ongoing = makeDecoratedDeal();
  const ended = makeDecoratedDeal({ period: { endAt: '2026-08-01T00:00:00+09:00' } });
  const soldOut = makeDecoratedDeal({
    limit: { firstComeFirstServed: true, quantity: 10, remaining: 0 },
  });
  const urgent = makeDecoratedDeal({ period: { endAt: '2026-08-21T23:59:59+09:00' } });

  it('기본 필터는 종료·소진을 숨긴다', () => {
    expect(matchesFilter(ongoing, DEFAULT_FILTER)).toBe(true);
    expect(matchesFilter(ended, DEFAULT_FILTER)).toBe(false);
    expect(matchesFilter(soldOut, DEFAULT_FILTER)).toBe(false);
  });

  it('hideClosed 를 끄면 종료된 혜택도 통과한다', () => {
    expect(matchesFilter(ended, withFilter({ hideClosed: false }))).toBe(true);
  });

  it('onlyUrgent 는 마감 임박만 남긴다', () => {
    const filter = withFilter({ onlyUrgent: true });
    expect(matchesFilter(urgent, filter)).toBe(true);
    expect(matchesFilter(ongoing, filter)).toBe(false);
  });

  it('카테고리는 OR 조건으로 동작한다', () => {
    const cafe = makeDecoratedDeal({ category: 'cafe' });
    const food = makeDecoratedDeal({ category: 'food' });
    const filter = withFilter({ categories: ['cafe', 'beauty'] });

    expect(matchesFilter(cafe, filter)).toBe(true);
    expect(matchesFilter(food, filter)).toBe(false);
  });

  it('빈 카테고리 배열은 전체를 의미한다', () => {
    expect(matchesFilter(makeDecoratedDeal({ category: 'finance' }), DEFAULT_FILTER)).toBe(true);
  });

  it('서로 다른 축은 AND 로 결합된다', () => {
    const deal = makeDecoratedDeal({ category: 'cafe', dealType: 'free', difficulty: 'easy' });

    expect(matchesFilter(deal, withFilter({ categories: ['cafe'], dealTypes: ['free'] }))).toBe(
      true,
    );
    expect(matchesFilter(deal, withFilter({ categories: ['cafe'], dealTypes: ['coupon'] }))).toBe(
      false,
    );
  });

  it('난이도로 거를 수 있다', () => {
    const hard = makeDecoratedDeal({ difficulty: 'hard' });
    expect(matchesFilter(hard, withFilter({ difficulties: ['easy'] }))).toBe(false);
    expect(matchesFilter(hard, withFilter({ difficulties: ['hard'] }))).toBe(true);
  });
});

describe('applySort', () => {
  const soon = makeDecoratedDeal({
    id: 'soon',
    slug: 'soon',
    period: { endAt: '2026-08-21T23:59:59+09:00' },
  });
  const later = makeDecoratedDeal({
    id: 'later',
    slug: 'later',
    period: { endAt: '2026-08-30T23:59:59+09:00' },
  });
  const always = makeDecoratedDeal({ id: 'always', slug: 'always', period: { endAt: null } });

  it('마감임박순은 남은 일수가 적은 순이며 상시는 맨 뒤로 간다', () => {
    const sorted = applySort([always, later, soon], 'deadline');
    expect(sorted.map((deal) => deal.id)).toEqual(['soon', 'later', 'always']);
  });

  it('할인율순은 높은 순으로 정렬한다', () => {
    const low = makeDecoratedDeal({
      id: 'low',
      slug: 'low',
      price: { original: 10000, final: 8000, currency: 'KRW' },
    });
    const high = makeDecoratedDeal({
      id: 'high',
      slug: 'high',
      price: { original: 10000, final: 0, currency: 'KRW' },
    });

    expect(applySort([low, high], 'discount').map((deal) => deal.id)).toEqual(['high', 'low']);
  });

  it('최신등록순은 updatedAt 이 최근인 순이다', () => {
    const older = makeDecoratedDeal({
      id: 'older',
      slug: 'older',
      meta: { verified: true, updatedAt: '2026-08-10T00:00:00+09:00' },
    });
    const newer = makeDecoratedDeal({
      id: 'newer',
      slug: 'newer',
      meta: { verified: true, updatedAt: '2026-08-19T00:00:00+09:00' },
    });

    expect(applySort([older, newer], 'latest').map((deal) => deal.id)).toEqual(['newer', 'older']);
  });

  it('원본 배열을 변경하지 않는다', () => {
    const input = [always, soon];
    applySort(input, 'deadline');
    expect(input.map((deal) => deal.id)).toEqual(['always', 'soon']);
  });
});

describe('filterDeals', () => {
  it('필터와 정렬을 함께 적용한다', () => {
    const deals = [
      makeDecoratedDeal({
        id: 'ended',
        slug: 'ended',
        period: { endAt: '2026-08-01T00:00:00+09:00' },
      }),
      makeDecoratedDeal({
        id: 'late',
        slug: 'late',
        period: { endAt: '2026-08-30T23:59:59+09:00' },
      }),
      makeDecoratedDeal({
        id: 'soon',
        slug: 'soon',
        period: { endAt: '2026-08-21T23:59:59+09:00' },
      }),
    ];

    const result = filterDeals(deals, withFilter({ sort: 'deadline' }));
    expect(result.map((deal) => deal.id)).toEqual(['soon', 'late']);
  });

  it('조건에 맞는 게 없으면 빈 배열을 반환한다', () => {
    const deals = [makeDecoratedDeal({ category: 'cafe' })];
    expect(filterDeals(deals, withFilter({ categories: ['finance'] }))).toEqual([]);
  });
});

describe('countByCategory', () => {
  it('해당 축을 해제한 상태의 개수를 센다', () => {
    const deals = [
      makeDecoratedDeal({ id: '1', slug: 'a', category: 'cafe' }),
      makeDecoratedDeal({ id: '2', slug: 'b', category: 'cafe' }),
      makeDecoratedDeal({ id: '3', slug: 'c', category: 'food' }),
    ];

    // 이미 cafe 를 선택한 상태여도 food 개수를 볼 수 있어야 한다
    const counts = countByCategory(deals, withFilter({ categories: ['cafe'] }));
    expect(counts.cafe).toBe(2);
    expect(counts.food).toBe(1);
  });

  it('다른 축의 필터는 개수에 반영된다', () => {
    const deals = [
      makeDecoratedDeal({ id: '1', slug: 'a', category: 'cafe', dealType: 'free' }),
      makeDecoratedDeal({ id: '2', slug: 'b', category: 'cafe', dealType: 'coupon' }),
    ];

    const counts = countByCategory(deals, withFilter({ dealTypes: ['free'] }));
    expect(counts.cafe).toBe(1);
  });
});

describe('hasActiveFilter', () => {
  it('기본 상태면 false', () => {
    expect(hasActiveFilter(DEFAULT_FILTER)).toBe(false);
  });

  it('카테고리를 고르면 true', () => {
    expect(hasActiveFilter(withFilter({ categories: ['cafe'] }))).toBe(true);
  });

  it('검색어를 넣으면 true', () => {
    expect(hasActiveFilter(withFilter({ query: '커피' }))).toBe(true);
  });

  it('공백만 있는 검색어는 활성으로 보지 않는다', () => {
    expect(hasActiveFilter(withFilter({ query: '   ' }))).toBe(false);
  });

  it('정렬을 바꾸면 true', () => {
    expect(hasActiveFilter(withFilter({ sort: 'discount' }))).toBe(true);
  });
});

describe('countByDealType', () => {
  const deals = [
    makeDecoratedDeal({ id: '1', slug: 'a', category: 'cafe', dealType: 'free' }),
    makeDecoratedDeal({ id: '2', slug: 'b', category: 'cafe', dealType: 'coupon' }),
    makeDecoratedDeal({ id: '3', slug: 'c', category: 'food', dealType: 'discount' }),
  ];

  it('dealTypes 가 이미 선택돼 있어도 다른 유형 개수를 센다', () => {
    // 자기 축을 해제하지 않으면 한 유형을 고른 순간 나머지 칩이 전부 0건이 되어
    // 비활성화되고, 사용자가 다른 유형으로 전환할 수 없게 갇힙니다.
    const counts = countByDealType(deals, withFilter({ dealTypes: ['free'] }));

    expect(counts.free).toBe(1);
    expect(counts.coupon).toBe(1);
    expect(counts.discount).toBe(1);
  });

  it('다른 축(categories)의 필터는 개수에 반영된다', () => {
    const counts = countByDealType(deals, withFilter({ categories: ['cafe'] }));

    expect(counts.free).toBe(1);
    expect(counts.coupon).toBe(1);
    expect(counts.discount).toBeUndefined();
  });
});

describe('countByDifficulty', () => {
  const deals = [
    makeDecoratedDeal({ id: '1', slug: 'a', category: 'cafe', difficulty: 'easy' }),
    makeDecoratedDeal({ id: '2', slug: 'b', category: 'cafe', difficulty: 'hard' }),
    makeDecoratedDeal({ id: '3', slug: 'c', category: 'food', difficulty: 'hard' }),
  ];

  it('difficulties 가 이미 선택돼 있어도 다른 난이도 개수를 센다', () => {
    const counts = countByDifficulty(deals, withFilter({ difficulties: ['easy'] }));

    expect(counts.easy).toBe(1);
    expect(counts.hard).toBe(2);
  });

  it('다른 축(categories)의 필터는 개수에 반영된다', () => {
    const counts = countByDifficulty(deals, withFilter({ categories: ['cafe'] }));

    expect(counts.easy).toBe(1);
    expect(counts.hard).toBe(1);
  });
});

describe('matchesQuery — 필드 경계', () => {
  it('서로 다른 필드에 걸친 문자열은 매칭되지 않는다', () => {
    const deal = makeDecoratedDeal({
      title: '아메리카노 증정',
      summary: '요약',
      brand: { name: '온더카페' },
      tags: ['온음료'],
    });

    // 필드를 이어 붙인 뒤 공백을 지우면 "카페"+"온음료" 가 붙어 "카페온" 이 매칭됩니다.
    expect(matchesQuery(deal, '카페온')).toBe(false);
    // 각 필드 안에서는 정상 매칭
    expect(matchesQuery(deal, '온더카페')).toBe(true);
    expect(matchesQuery(deal, '온음료')).toBe(true);
  });

  it('요약(summary)으로도 검색된다', () => {
    const deal = makeDecoratedDeal({ summary: '배송비까지 무료입니다' });
    expect(matchesQuery(deal, '배송비')).toBe(true);
  });
});

describe('applySort — 마감임박순의 종료 처리', () => {
  const ended = makeDecoratedDeal({
    id: 'ended',
    slug: 'ended',
    period: { endAt: '2026-08-10T23:59:59+09:00' },
  });
  const endedLongAgo = makeDecoratedDeal({
    id: 'endedLongAgo',
    slug: 'ended-long-ago',
    period: { startAt: '2026-07-01T00:00:00+09:00', endAt: '2026-07-10T23:59:59+09:00' },
  });
  const soldOut = makeDecoratedDeal({
    id: 'soldOut',
    slug: 'sold-out',
    limit: { firstComeFirstServed: true, quantity: 10, remaining: 0 },
  });
  const endingToday = makeDecoratedDeal({
    id: 'today',
    slug: 'today',
    period: { endAt: '2026-08-20T23:59:59+09:00' },
  });

  it('종료된 혜택을 살아있는 혜택보다 위로 올리지 않는다', () => {
    // daysLeft 가 음수라, 단순 오름차순이면 종료된 혜택이 최상단을 차지합니다.
    const sorted = applySort([endedLongAgo, ended, endingToday], 'deadline');

    expect(sorted[0]?.id).toBe('today');
  });

  it('소진된 혜택도 뒤로 보낸다', () => {
    const sorted = applySort([soldOut, endingToday], 'deadline');

    expect(sorted.map((deal) => deal.id)).toEqual(['today', 'soldOut']);
  });

  it('종료된 것끼리는 최근에 끝난 순으로 정렬한다', () => {
    const sorted = applySort([endedLongAgo, ended], 'deadline');

    expect(sorted.map((deal) => deal.id)).toEqual(['ended', 'endedLongAgo']);
  });
});

describe('hasActiveFilter — 나머지 축', () => {
  it('혜택 유형을 고르면 true', () => {
    expect(hasActiveFilter(withFilter({ dealTypes: ['free'] }))).toBe(true);
  });

  it('난이도를 고르면 true', () => {
    expect(hasActiveFilter(withFilter({ difficulties: ['easy'] }))).toBe(true);
  });

  it('종료·소진 숨기기를 끄면 true', () => {
    expect(hasActiveFilter(withFilter({ hideClosed: false }))).toBe(true);
  });

  it('마감 임박만 켜면 true', () => {
    expect(hasActiveFilter(withFilter({ onlyUrgent: true }))).toBe(true);
  });
});
