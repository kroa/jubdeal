// @vitest-environment jsdom
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FilterBar } from '@/components/FilterBar';
import { DEFAULT_FILTER, filterDeals, type DealFilterState } from '@/lib/deal-filter';
import type { DecoratedDeal } from '@/types/deal';
import { makeDecoratedDeal } from './fixtures';

const DEALS: DecoratedDeal[] = [
  makeDecoratedDeal({ id: '1', slug: 'a', category: 'cafe', dealType: 'free', difficulty: 'easy' }),
  makeDecoratedDeal({
    id: '2',
    slug: 'b',
    category: 'cafe',
    dealType: 'penny',
    difficulty: 'normal',
  }),
  makeDecoratedDeal({
    id: '3',
    slug: 'c',
    category: 'food',
    dealType: 'discount',
    difficulty: 'hard',
  }),
];

/** 필터 상태를 실제로 물고 도는 테스트용 래퍼 */
function Harness({ onChange }: { onChange?: (next: DealFilterState) => void }) {
  const [filter, setFilter] = useState<DealFilterState>(DEFAULT_FILTER);

  return (
    <FilterBar
      deals={DEALS}
      filter={filter}
      onChange={(next) => {
        setFilter(next);
        onChange?.(next);
      }}
      resultCount={filterDeals(DEALS, filter).length}
    />
  );
}

describe('FilterBar', () => {
  it('카테고리·유형·난이도 그룹을 모두 렌더한다', () => {
    render(<Harness />);

    expect(screen.getByRole('group', { name: '카테고리' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '혜택 유형' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '참여 난이도' })).toBeInTheDocument();
  });

  it('각 칩에 해당하는 혜택 개수를 보여준다', () => {
    render(<Harness />);

    const cafeChip = screen.getByRole('button', { name: /카페/ });
    expect(cafeChip).toHaveTextContent('2');
  });

  it('칩을 누르면 선택 상태(aria-pressed)가 토글된다', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const cafeChip = screen.getByRole('button', { name: /카페/ });
    expect(cafeChip).toHaveAttribute('aria-pressed', 'false');

    await user.click(cafeChip);
    expect(screen.getByRole('button', { name: /카페/ })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: /카페/ }));
    expect(screen.getByRole('button', { name: /카페/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('칩 클릭 시 해당 카테고리가 담긴 필터를 onChange 로 넘긴다', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /카페/ }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ categories: ['cafe'] }));
  });

  it('결과가 0건인 칩은 비활성으로 표시되고 눌러도 아무 일이 없다', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    // 픽스처에 뷰티 카테고리 혜택이 없으므로 선택 불가
    const chip = screen.getByRole('button', { name: /뷰티/ });
    expect(chip).toHaveAttribute('aria-disabled', 'true');

    await user.click(chip);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('비활성 칩도 포커스를 받을 수 있다', () => {
    // 실제 `disabled` 를 쓰면 60초 시계 틱으로 개수가 0이 되는 순간
    // 브라우저가 포커스된 칩을 blur 시켜 키보드 사용자의 위치가 사라집니다.
    render(<Harness />);

    const chip = screen.getByRole('button', { name: /뷰티/ });
    chip.focus();

    expect(chip).toHaveFocus();
  });

  it('검색어를 입력하면 onChange 로 전달된다', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.type(screen.getByRole('searchbox', { name: '혜택 검색' }), '커피');

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ query: '커피' }));
  });

  it('정렬 기준을 바꿀 수 있다', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.selectOptions(screen.getByRole('combobox', { name: '정렬 기준' }), 'deadline');

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ sort: 'deadline' }));
  });

  it('"마감 임박만" 체크박스를 켤 수 있다', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole('checkbox', { name: '마감 임박만' }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ onlyUrgent: true }));
  });

  it('기본 상태에서는 초기화 버튼이 비활성으로 표시된다', () => {
    render(<Harness />);

    // 언마운트하면 이 버튼을 눌러 초기화하는 순간 포커스가 body 로 날아갑니다.
    // 항상 마운트해 두고 aria-disabled 로만 비활성을 알립니다.
    const reset = screen.getByRole('button', { name: '필터 초기화' });
    expect(reset).toBeInTheDocument();
    expect(reset).toHaveAttribute('aria-disabled', 'true');
  });

  it('비활성 상태의 초기화 버튼을 눌러도 아무 일도 일어나지 않는다', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    // aria-disabled 버튼은 실제로 클릭을 받으므로 핸들러 가드가 동작해야 합니다.
    await user.click(screen.getByRole('button', { name: '필터 초기화' }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('필터를 걸면 초기화 버튼이 활성화되고, 누르면 기본값으로 돌아간다', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /카페/ }));

    const reset = screen.getByRole('button', { name: '필터 초기화' });
    expect(reset).toHaveAttribute('aria-disabled', 'false');

    await user.click(reset);

    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_FILTER);
    expect(screen.getByRole('button', { name: /카페/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('초기화 후에도 버튼이 DOM 에 남아 포커스를 잃지 않는다', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: /카페/ }));

    const reset = screen.getByRole('button', { name: '필터 초기화' });
    reset.focus();
    expect(reset).toHaveFocus();

    await user.click(reset);

    // 언마운트되지 않으므로 포커스가 body 로 떨어지지 않는다
    expect(screen.getByRole('button', { name: '필터 초기화' })).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });

  it('유형을 선택해도 다른 유형 칩은 계속 누를 수 있다', () => {
    // 카운트 함수가 자기 축을 해제하지 않으면, 한 유형을 고른 순간
    // 나머지 칩이 전부 0건이 되어 비활성화되고 사용자가 갇힙니다.
    render(
      <FilterBar
        deals={DEALS}
        filter={{ ...DEFAULT_FILTER, dealTypes: ['free'] }}
        onChange={() => {}}
        resultCount={1}
      />,
    );

    const group = screen.getByRole('group', { name: '혜택 유형' });
    const chips = Array.from(group.querySelectorAll('button'));
    // 칩은 aria-disabled 를 쓰므로 `.disabled` 로 세면 항상 통과해 버립니다.
    const selectable = chips.filter((chip) => chip.getAttribute('aria-disabled') !== 'true');

    expect(selectable.length).toBeGreaterThan(1);
  });

  it('결과 개수를 표시한다', () => {
    render(<Harness />);
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/개의 혜택/)).toBeInTheDocument();
  });
});
