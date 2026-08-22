// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DealStats } from '@/components/DealStats';
import { DEFAULT_FILTER, filterDeals } from '@/lib/deal-filter';
import { decorateDeals, toPulse } from '@/lib/deal-status';
import { NOW, makeDeal } from './fixtures';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const DEALS = [
  // 진행중 · 무료
  makeDeal({ id: '1', slug: 'free-ongoing', dealType: 'free' }),
  // 오늘 마감 · 100원딜 (마감 임박)
  makeDeal({
    id: '2',
    slug: 'penny-today',
    dealType: 'penny',
    period: { startAt: '2026-08-14T10:00:00+09:00', endAt: '2026-08-20T23:59:59+09:00' },
  }),
  // 종료됨
  makeDeal({
    id: '3',
    slug: 'ended',
    dealType: 'discount',
    period: { startAt: '2026-08-01T00:00:00+09:00', endAt: '2026-08-05T23:59:59+09:00' },
  }),
  // 지불액 0원이지만 무료 증정이 아님
  makeDeal({
    id: '4',
    slug: 'cashback',
    dealType: 'cashback',
    price: { final: 0, currency: 'KRW' },
  }),
  // 아직 시작 전 — 목록에는 보이지만 "지금 참여 가능"에는 들어가지 않는다
  makeDeal({
    id: '5',
    slug: 'upcoming',
    dealType: 'free',
    period: { startAt: '2026-08-25T10:00:00+09:00', endAt: '2026-09-05T23:59:59+09:00' },
  }),
];

const PULSES = DEALS.map(toPulse);

function statValue(testId: string): string {
  return screen.getByTestId(testId).querySelector('.stat__value')?.textContent ?? '';
}

describe('DealStats', () => {
  it('참여 가능·마감 임박·완전 무료 건수를 보여준다', () => {
    render(<DealStats pulses={PULSES} buildTime={NOW.toISOString()} />);

    expect(statValue('stat-live')).toBe('3');
    expect(statValue('stat-urgent')).toBe('1');
    expect(statValue('stat-free')).toBe('1');
  });

  it('캐시백은 지불액이 0원이어도 "완전 무료"로 세지 않는다', () => {
    render(<DealStats pulses={PULSES} buildTime={NOW.toISOString()} />);

    // 금액으로 세면 2가 되어 사용자에게 무료 혜택이 부풀려 보입니다.
    expect(statValue('stat-free')).toBe('1');
  });

  it('빌드 시각이 아니라 현재 시각으로 계산한다', () => {
    // 8/14 기준이면 penny-today 는 아직 진행중이고 마감 임박이 아닙니다.
    render(<DealStats pulses={PULSES} buildTime="2026-08-14T12:00:00+09:00" />);

    expect(statValue('stat-urgent')).toBe('1');
  });

  it('"마감 임박" 수치가 목록의 마감임박 필터 결과와 정확히 일치한다', () => {
    render(<DealStats pulses={PULSES} buildTime={NOW.toISOString()} />);

    const decorated = decorateDeals(DEALS, NOW);
    const urgentFromBoard = filterDeals(decorated, { ...DEFAULT_FILTER, onlyUrgent: true }).length;

    // 사용자가 "마감 임박만" 체크박스를 켰을 때 히어로가 약속한 수만큼 나와야 합니다.
    expect(statValue('stat-urgent')).toBe(String(urgentFromBoard));
  });

  it('"지금 참여 가능"은 참여 가능한 것만 세고, 오픈 예정은 제외한다', () => {
    render(<DealStats pulses={PULSES} buildTime={NOW.toISOString()} />);

    const decorated = decorateDeals(DEALS, NOW);
    const actionable = decorated.filter((deal) => deal.isActionable).length;
    const listed = filterDeals(decorated, DEFAULT_FILTER).length;

    expect(statValue('stat-live')).toBe(String(actionable));

    // 목록은 오픈 예정 카드도 함께 보여주므로 통계보다 많을 수 있습니다.
    // 이 관계가 뒤집히면(통계가 목록보다 큼) 사용자에게 없는 혜택을 약속하는 셈입니다.
    expect(listed).toBeGreaterThanOrEqual(Number(statValue('stat-live')));
  });
});
