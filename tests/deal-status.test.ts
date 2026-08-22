import { describe, expect, it } from 'vitest';
import {
  URGENT_THRESHOLD_DAYS,
  decorateDeal,
  getDaysLeft,
  getDealStatus,
  getDiscountRate,
  getRemainingRatio,
  isActionableStatus,
  kstDayDiff,
  sortDeals,
  summarizeDeals,
  toKstDayKey,
} from '@/lib/deal-status';
import { NOW, makeDeal, makeDecoratedDeal } from './fixtures';

describe('toKstDayKey', () => {
  it('UTC 시각을 KST 달력 날짜로 변환한다', () => {
    expect(toKstDayKey('2026-08-20T03:00:00Z')).toBe('2026-08-20');
  });

  it('UTC 기준 늦은 밤은 KST 다음 날로 넘어간다', () => {
    // 2026-08-20 23:30 UTC = 2026-08-21 08:30 KST
    expect(toKstDayKey('2026-08-20T23:30:00Z')).toBe('2026-08-21');
  });

  it('KST 오프셋이 붙은 문자열도 동일한 날짜를 반환한다', () => {
    expect(toKstDayKey('2026-08-20T00:30:00+09:00')).toBe('2026-08-20');
  });
});

describe('kstDayDiff', () => {
  it('같은 날이면 0을 반환한다', () => {
    expect(kstDayDiff('2026-08-20T01:00:00+09:00', '2026-08-20T23:00:00+09:00')).toBe(0);
  });

  it('다음 날이면 1을 반환한다', () => {
    expect(kstDayDiff('2026-08-20T23:00:00+09:00', '2026-08-21T01:00:00+09:00')).toBe(1);
  });

  it('과거면 음수를 반환한다', () => {
    expect(kstDayDiff('2026-08-20T12:00:00+09:00', '2026-08-18T12:00:00+09:00')).toBe(-2);
  });
});

describe('getDealStatus', () => {
  it('종료 시각이 지났으면 ended', () => {
    const deal = makeDeal({ period: { endAt: '2026-08-10T23:59:59+09:00' } });
    expect(getDealStatus(deal, NOW)).toBe('ended');
  });

  it('남은 수량이 0이면 sold_out', () => {
    const deal = makeDeal({
      limit: { firstComeFirstServed: true, quantity: 100, remaining: 0 },
    });
    expect(getDealStatus(deal, NOW)).toBe('sold_out');
  });

  it('종료가 소진보다 우선한다', () => {
    const deal = makeDeal({
      period: { endAt: '2026-08-10T23:59:59+09:00' },
      limit: { firstComeFirstServed: true, quantity: 100, remaining: 0 },
    });
    expect(getDealStatus(deal, NOW)).toBe('ended');
  });

  it('아직 시작 전이면 upcoming', () => {
    const deal = makeDeal({
      period: { startAt: '2026-08-25T10:00:00+09:00', endAt: '2026-09-05T23:59:59+09:00' },
    });
    expect(getDealStatus(deal, NOW)).toBe('upcoming');
  });

  it('종료일이 오늘(KST)이면 ending_today', () => {
    const deal = makeDeal({ period: { endAt: '2026-08-20T23:59:59+09:00' } });
    expect(getDealStatus(deal, NOW)).toBe('ending_today');
  });

  it('진행 중이고 마감이 남았으면 ongoing', () => {
    expect(getDealStatus(makeDeal(), NOW)).toBe('ongoing');
  });

  it('종료 시각이 없으면(상시) ongoing', () => {
    const deal = makeDeal({ period: { endAt: null } });
    expect(getDealStatus(deal, NOW)).toBe('ongoing');
  });

  it('종료 시각과 정확히 같은 순간이면 ended로 본다', () => {
    const deal = makeDeal({ period: { endAt: '2026-08-20T12:00:00+09:00' } });
    expect(getDealStatus(deal, NOW)).toBe('ended');
  });
});

describe('getDaysLeft', () => {
  it('상시 혜택이면 null', () => {
    expect(getDaysLeft(makeDeal({ period: { endAt: null } }), NOW)).toBeNull();
  });

  it('오늘 마감이면 0', () => {
    expect(getDaysLeft(makeDeal({ period: { endAt: '2026-08-20T23:59:59+09:00' } }), NOW)).toBe(0);
  });

  it('이틀 뒤 마감이면 2', () => {
    expect(getDaysLeft(makeDeal({ period: { endAt: '2026-08-22T21:00:00+09:00' } }), NOW)).toBe(2);
  });
});

describe('getDiscountRate', () => {
  it('정가와 실지불액으로 할인율을 계산한다', () => {
    expect(getDiscountRate({ original: 10000, final: 2500, currency: 'KRW' })).toBe(75);
  });

  it('무료면 100%', () => {
    expect(getDiscountRate({ original: 4500, final: 0, currency: 'KRW' })).toBe(100);
  });

  it('명시된 discountRate 를 우선한다', () => {
    expect(
      getDiscountRate({ original: 49000, final: 14700, currency: 'KRW', discountRate: 70 }),
    ).toBe(70);
  });

  it('정가가 없으면 null', () => {
    expect(getDiscountRate({ final: 0, currency: 'KRW' })).toBeNull();
  });

  it('정가가 0이면 나눗셈을 피하고 null', () => {
    expect(getDiscountRate({ original: 0, final: 0, currency: 'KRW' })).toBeNull();
  });

  it('소수점은 반올림한다', () => {
    expect(getDiscountRate({ original: 3000, final: 1000, currency: 'KRW' })).toBe(67);
  });
});

describe('getRemainingRatio', () => {
  it('수량 정보가 있으면 비율을 반환한다', () => {
    const deal = makeDeal({ limit: { firstComeFirstServed: true, quantity: 200, remaining: 50 } });
    expect(getRemainingRatio(deal)).toBe(0.25);
  });

  it('수량 정보가 없으면 null', () => {
    expect(getRemainingRatio(makeDeal())).toBeNull();
  });

  it('소진되면 0', () => {
    const deal = makeDeal({ limit: { firstComeFirstServed: true, quantity: 200, remaining: 0 } });
    expect(getRemainingRatio(deal)).toBe(0);
  });
});

describe('isActionableStatus', () => {
  it('진행중과 오늘마감만 참여 가능하다', () => {
    expect(isActionableStatus('ongoing')).toBe(true);
    expect(isActionableStatus('ending_today')).toBe(true);
    expect(isActionableStatus('upcoming')).toBe(false);
    expect(isActionableStatus('ended')).toBe(false);
    expect(isActionableStatus('sold_out')).toBe(false);
  });
});

describe('decorateDeal', () => {
  it('마감 임박 임계값 이내면 isUrgent 가 true', () => {
    const deal = decorateDeal(makeDeal({ period: { endAt: '2026-08-23T23:59:59+09:00' } }), NOW);
    expect(deal.daysLeft).toBe(URGENT_THRESHOLD_DAYS);
    expect(deal.isUrgent).toBe(true);
  });

  it('임계값을 넘으면 isUrgent 가 false', () => {
    const deal = decorateDeal(makeDeal({ period: { endAt: '2026-08-24T23:59:59+09:00' } }), NOW);
    expect(deal.isUrgent).toBe(false);
  });

  it('상시 혜택은 마감 임박이 아니다', () => {
    expect(decorateDeal(makeDeal({ period: { endAt: null } }), NOW).isUrgent).toBe(false);
  });

  it('이미 종료된 혜택은 마감 임박으로 표시하지 않는다', () => {
    const deal = decorateDeal(makeDeal({ period: { endAt: '2026-08-19T23:59:59+09:00' } }), NOW);
    expect(deal.status).toBe('ended');
    expect(deal.isUrgent).toBe(false);
    expect(deal.isActionable).toBe(false);
  });

  it('원본 필드를 그대로 유지한다', () => {
    const deal = decorateDeal(makeDeal({ title: '보존 확인' }), NOW);
    expect(deal.title).toBe('보존 확인');
    expect(deal.brand.name).toBe('테스트브랜드');
  });
});

describe('sortDeals', () => {
  it('참여 가능한 혜택을 종료된 혜택보다 앞에 둔다', () => {
    const ended = makeDecoratedDeal({
      id: 'ended',
      slug: 'ended',
      period: { endAt: '2026-08-01T00:00:00+09:00' },
    });
    const ongoing = makeDecoratedDeal({ id: 'ongoing', slug: 'ongoing' });
    const endingToday = makeDecoratedDeal({
      id: 'today',
      slug: 'today',
      period: { endAt: '2026-08-20T23:59:59+09:00' },
    });

    const sorted = sortDeals([ended, ongoing, endingToday]);
    expect(sorted.map((deal) => deal.id)).toEqual(['today', 'ongoing', 'ended']);
  });

  it('같은 상태면 featured 를 앞에 둔다', () => {
    const plain = makeDecoratedDeal({ id: 'plain', slug: 'plain' });
    const featured = makeDecoratedDeal({
      id: 'featured',
      slug: 'featured',
      meta: { featured: true, verified: true, updatedAt: '2026-08-20T05:00:00+09:00' },
    });

    expect(sortDeals([plain, featured]).map((deal) => deal.id)).toEqual(['featured', 'plain']);
  });

  it('원본 배열을 변경하지 않는다', () => {
    const first = makeDecoratedDeal({ id: 'a', slug: 'a', period: { endAt: null } });
    const second = makeDecoratedDeal({
      id: 'b',
      slug: 'b',
      period: { endAt: '2026-08-20T23:59:59+09:00' },
    });
    const input = [first, second];

    sortDeals(input);
    expect(input.map((deal) => deal.id)).toEqual(['a', 'b']);
  });
});

describe('sortDeals — 우선순위 단계별 검증', () => {
  it('같은 상태·같은 featured 면 마감이 임박한 순이고 상시는 맨 뒤로 간다', () => {
    const soon = makeDecoratedDeal({
      id: 'soon',
      slug: 'soon',
      period: { endAt: '2026-08-21T23:59:59+09:00' },
    });
    const later = makeDecoratedDeal({
      id: 'later',
      slug: 'later',
      period: { endAt: '2026-09-09T23:59:59+09:00' },
    });
    const always = makeDecoratedDeal({ id: 'always', slug: 'always', period: { endAt: null } });

    expect(sortDeals([always, later, soon]).map((deal) => deal.id)).toEqual([
      'soon',
      'later',
      'always',
    ]);
  });

  it('마감일까지 같으면 최근 갱신된 혜택을 앞에 둔다', () => {
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

    // 입력 순서가 우연히 맞아 통과하는 일이 없도록 양방향으로 확인합니다.
    expect(sortDeals([older, newer]).map((deal) => deal.id)).toEqual(['newer', 'older']);
    expect(sortDeals([newer, older]).map((deal) => deal.id)).toEqual(['newer', 'older']);
  });

  it('featured 가 마감임박·최신갱신보다 우선한다', () => {
    const featuredLate = makeDecoratedDeal({
      id: 'featuredLate',
      slug: 'featured-late',
      period: { endAt: '2026-09-19T23:59:59+09:00' },
      meta: { featured: true, verified: true, updatedAt: '2026-08-01T00:00:00+09:00' },
    });
    const plainSoon = makeDecoratedDeal({
      id: 'plainSoon',
      slug: 'plain-soon',
      period: { endAt: '2026-08-21T23:59:59+09:00' },
      meta: { verified: true, updatedAt: '2026-08-20T05:00:00+09:00' },
    });

    expect(sortDeals([plainSoon, featuredLate]).map((deal) => deal.id)).toEqual([
      'featuredLate',
      'plainSoon',
    ]);
  });

  it('featured 라도 종료된 혜택은 진행 중인 혜택보다 뒤로 간다', () => {
    const featuredEnded = makeDecoratedDeal({
      id: 'featuredEnded',
      slug: 'featured-ended',
      period: { endAt: '2026-08-01T00:00:00+09:00' },
      meta: { featured: true, verified: true, updatedAt: '2026-08-20T05:00:00+09:00' },
    });
    const plainOngoing = makeDecoratedDeal({ id: 'plainOngoing', slug: 'plain-ongoing' });

    expect(sortDeals([featuredEnded, plainOngoing]).map((deal) => deal.id)).toEqual([
      'plainOngoing',
      'featuredEnded',
    ]);
  });

  it('소진과 종료의 순서가 고정돼 있다', () => {
    const soldOut = makeDecoratedDeal({
      id: 'soldOut',
      slug: 'sold-out',
      limit: { firstComeFirstServed: true, quantity: 10, remaining: 0 },
    });
    const ended = makeDecoratedDeal({
      id: 'ended',
      slug: 'ended',
      period: { endAt: '2026-08-01T00:00:00+09:00' },
    });

    expect(sortDeals([ended, soldOut]).map((deal) => deal.id)).toEqual(['soldOut', 'ended']);
  });
});

describe('summarizeDeals', () => {
  it('참여 가능·마감 임박·완전 무료 건수를 센다', () => {
    const deals = [
      makeDecoratedDeal({ id: '1', slug: 'a', dealType: 'free' }),
      makeDecoratedDeal({
        id: '2',
        slug: 'b',
        dealType: 'penny',
        period: { endAt: '2026-08-21T23:59:59+09:00' },
      }),
      makeDecoratedDeal({
        id: '3',
        slug: 'c',
        dealType: 'discount',
        period: { endAt: '2026-08-01T00:00:00+09:00' },
      }),
    ];

    expect(summarizeDeals(deals, NOW)).toEqual({ live: 2, urgent: 1, free: 1 });
  });

  it('지불액이 0원이어도 캐시백·포인트는 "완전 무료"로 세지 않는다', () => {
    const deals = [
      makeDecoratedDeal({
        id: '1',
        slug: 'a',
        dealType: 'cashback',
        price: { final: 0, currency: 'KRW' },
      }),
      makeDecoratedDeal({
        id: '2',
        slug: 'b',
        dealType: 'point',
        price: { final: 0, currency: 'KRW' },
      }),
      makeDecoratedDeal({
        id: '3',
        slug: 'c',
        dealType: 'giveaway',
        price: { final: 0, currency: 'KRW' },
      }),
    ];

    expect(summarizeDeals(deals, NOW).free).toBe(0);
    expect(summarizeDeals(deals, NOW).live).toBe(3);
  });

  it('종료된 혜택은 참여 가능·무료 어느 쪽에도 세지 않는다', () => {
    const ended = makeDecoratedDeal({
      dealType: 'free',
      period: { endAt: '2026-08-01T00:00:00+09:00' },
    });

    expect(summarizeDeals([ended], NOW)).toEqual({ live: 0, urgent: 0, free: 0 });
  });

  it('빈 목록이면 모두 0', () => {
    expect(summarizeDeals([], NOW)).toEqual({ live: 0, urgent: 0, free: 0 });
  });
});
