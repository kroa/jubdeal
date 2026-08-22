// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { DealBoard } from '@/components/DealBoard';
import { LIVE_NOW_INTERVAL_MS } from '@/hooks/use-live-now';
import { NOW, makeDeal } from './fixtures';

/**
 * DealBoard 는 마운트 후 `new Date()` 로 현재 시각을 읽습니다.
 * 테스트가 실제 달력에 의존하지 않도록 시스템 시각을 고정합니다.
 */
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const DEALS = [
  makeDeal({
    id: '1',
    slug: 'cafe-free',
    title: '카페 무료 음료',
    category: 'cafe',
    dealType: 'free',
    difficulty: 'easy',
  }),
  makeDeal({
    id: '2',
    slug: 'food-penny',
    title: '밀키트 100원 딜',
    category: 'food',
    dealType: 'penny',
    difficulty: 'normal',
    period: { startAt: '2026-08-14T10:00:00+09:00', endAt: '2026-08-20T23:59:59+09:00' },
  }),
  makeDeal({
    id: '3',
    slug: 'ended-deal',
    title: '이미 끝난 혜택',
    category: 'shopping',
    dealType: 'discount',
    period: { startAt: '2026-08-01T00:00:00+09:00', endAt: '2026-08-05T23:59:59+09:00' },
  }),
];

function renderBoard() {
  return render(<DealBoard deals={DEALS} buildTime={NOW.toISOString()} />);
}

function visibleTitles(): string[] {
  const grid = screen.queryByTestId('deal-grid');
  if (!grid) return [];

  return within(grid)
    .getAllByRole('heading', { level: 3 })
    .map((heading) => heading.textContent ?? '');
}

describe('DealBoard', () => {
  it('기본 상태에서 진행 중인 혜택만 보여준다', () => {
    renderBoard();

    const titles = visibleTitles();
    expect(titles).toContain('카페 무료 음료');
    expect(titles).toContain('밀키트 100원 딜');
    expect(titles).not.toContain('이미 끝난 혜택');
  });

  it('오늘 마감인 혜택을 맨 앞에 정렬한다', () => {
    renderBoard();
    expect(visibleTitles()[0]).toBe('밀키트 100원 딜');
  });

  it('카테고리 칩으로 목록을 좁힌다', () => {
    renderBoard();

    fireEvent.click(screen.getByRole('button', { name: /카페/ }));

    expect(visibleTitles()).toEqual(['카페 무료 음료']);
  });

  it('검색어로 목록을 좁힌다', () => {
    renderBoard();

    fireEvent.change(screen.getByRole('searchbox', { name: '혜택 검색' }), {
      target: { value: '밀키트' },
    });

    expect(visibleTitles()).toEqual(['밀키트 100원 딜']);
  });

  it('"종료·소진 숨기기"를 끄면 종료된 혜택도 보인다', () => {
    renderBoard();

    fireEvent.click(screen.getByRole('checkbox', { name: '종료·소진 숨기기' }));

    expect(visibleTitles()).toContain('이미 끝난 혜택');
  });

  it('조건에 맞는 혜택이 없으면 빈 상태를 보여준다', () => {
    renderBoard();

    fireEvent.change(screen.getByRole('searchbox', { name: '혜택 검색' }), {
      target: { value: '존재하지않는키워드' },
    });

    expect(screen.queryByTestId('deal-grid')).not.toBeInTheDocument();
    expect(screen.getByText('조건에 맞는 혜택이 없어요')).toBeInTheDocument();
  });

  it('빈 상태에서 초기화를 누르면 전체 목록으로 돌아온다', () => {
    renderBoard();

    fireEvent.change(screen.getByRole('searchbox', { name: '혜택 검색' }), {
      target: { value: '없는키워드' },
    });
    expect(screen.getByText('조건에 맞는 혜택이 없어요')).toBeInTheDocument();

    const emptyState = screen.getByTestId('empty-state');
    fireEvent.click(within(emptyState).getByRole('button', { name: '필터 초기화' }));

    expect(visibleTitles()).toHaveLength(2);
  });

  it('결과 개수를 실시간으로 갱신한다', () => {
    renderBoard();

    expect(screen.getByText(/개의 혜택/)).toHaveTextContent('2개의 혜택');

    fireEvent.click(screen.getByRole('button', { name: /카페/ }));
    expect(screen.getByText(/개의 혜택/)).toHaveTextContent('1개의 혜택');
  });

  it('빌드 시각이 아니라 현재 시각으로 상태를 다시 계산한다', () => {
    // 빌드 시각을 8/14로 넘기면 밀키트 딜은 그 시점 기준 "진행중"이지만,
    // 실제 현재 시각(NOW = 8/20)으로 재계산되어 "오늘마감"이 되어야 한다.
    render(<DealBoard deals={DEALS} buildTime="2026-08-14T12:00:00+09:00" />);

    expect(screen.getByText('오늘마감')).toBeInTheDocument();
  });

  it('빈 상태에서 초기화하면 복구된 목록으로 포커스를 넘긴다', () => {
    // 누른 버튼이 사라지므로, 포커스를 명시적으로 옮기지 않으면 body 로 떨어집니다.
    renderBoard();

    fireEvent.change(screen.getByRole('searchbox', { name: '혜택 검색' }), {
      target: { value: '없는키워드' },
    });

    const resetButton = within(screen.getByTestId('empty-state')).getByRole('button', {
      name: '필터 초기화',
    });
    resetButton.focus();
    fireEvent.click(resetButton);

    const grid = screen.getByTestId('deal-grid');
    expect(grid).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });

  it('결과 목록에 건수를 알려주는 접근성 라벨이 붙는다', () => {
    renderBoard();

    expect(screen.getByTestId('deal-grid')).toHaveAttribute('aria-label', '혜택 2건');
  });

  it('자정을 넘기면 주기 갱신으로 상태가 바뀐다', () => {
    // 사용자가 페이지를 열어 둔 채 마감 시각이 지나는 상황.
    renderBoard();
    expect(screen.getByText('오늘마감')).toBeInTheDocument();

    // NOW(8/20 12:00) 에서 마감(8/20 23:59:59) 이후로 시간을 넘깁니다.
    act(() => {
      vi.setSystemTime(new Date('2026-08-21T00:30:00+09:00'));
      vi.advanceTimersByTime(LIVE_NOW_INTERVAL_MS);
    });

    // 기본 필터가 종료 건을 숨기므로 목록에서 사라져야 합니다.
    expect(visibleTitles()).not.toContain('밀키트 100원 딜');
  });
});
