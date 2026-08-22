import type { ChangeEvent } from 'react';
import type { DealCategory, DealDifficulty, DealType, DecoratedDeal } from '@/types/deal';
import {
  CATEGORY_EMOJI,
  CATEGORY_LABELS,
  DEAL_CATEGORIES,
  DEAL_DIFFICULTIES,
  DEAL_TYPES,
  DEAL_TYPE_LABELS,
  DIFFICULTY_DESCRIPTIONS,
  DIFFICULTY_LABELS,
} from '@/types/deal';
import {
  DEAL_SORT_KEYS,
  DEFAULT_FILTER,
  SORT_LABELS,
  countByCategory,
  countByDealType,
  countByDifficulty,
  hasActiveFilter,
  toggleValue,
  type DealFilterState,
  type DealSortKey,
} from '@/lib/deal-filter';

interface FilterBarProps {
  deals: DecoratedDeal[];
  filter: DealFilterState;
  onChange: (next: DealFilterState) => void;
  /** 현재 필터를 통과한 혜택 수 */
  resultCount: number;
}

/**
 * 필터 바 (제어 컴포넌트)
 * 자체 상태를 갖지 않으며 모든 변경을 onChange 로 위임합니다.
 * → 필터 로직(src/lib/deal-filter.ts)과 완전히 분리되어 테스트가 쉽습니다.
 */
export function FilterBar({ deals, filter, onChange, resultCount }: FilterBarProps) {
  const categoryCounts = countByCategory(deals, filter);
  const typeCounts = countByDealType(deals, filter);
  const difficultyCounts = countByDifficulty(deals, filter);
  const isFilterActive = hasActiveFilter(filter);

  const patch = (partial: Partial<DealFilterState>) => onChange({ ...filter, ...partial });

  return (
    <section className="filter-bar" aria-label="혜택 필터">
      <div className="filter-bar__row filter-bar__row--top">
        <div className="filter-bar__search">
          <span className="filter-bar__search-icon" aria-hidden="true">
            🔍
          </span>
          <input
            type="search"
            className="filter-bar__input"
            placeholder="브랜드, 혜택명, 태그로 검색"
            aria-label="혜택 검색"
            value={filter.query}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              patch({ query: event.target.value })
            }
          />
        </div>

        <label className="filter-bar__sort">
          <span className="sr-only">정렬 기준</span>
          <select
            className="filter-bar__select"
            aria-label="정렬 기준"
            value={filter.sort}
            onChange={(event: ChangeEvent<HTMLSelectElement>) =>
              patch({ sort: event.target.value as DealSortKey })
            }
          >
            {DEAL_SORT_KEYS.map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <FilterGroup label="카테고리">
        {DEAL_CATEGORIES.map((category: DealCategory) => (
          <Chip
            key={category}
            active={filter.categories.includes(category)}
            count={categoryCounts[category] ?? 0}
            onClick={() => patch({ categories: toggleValue(filter.categories, category) })}
          >
            <span aria-hidden="true">{CATEGORY_EMOJI[category]}</span> {CATEGORY_LABELS[category]}
          </Chip>
        ))}
      </FilterGroup>

      <FilterGroup label="혜택 유형">
        {DEAL_TYPES.map((dealType: DealType) => (
          <Chip
            key={dealType}
            active={filter.dealTypes.includes(dealType)}
            count={typeCounts[dealType] ?? 0}
            onClick={() => patch({ dealTypes: toggleValue(filter.dealTypes, dealType) })}
          >
            {DEAL_TYPE_LABELS[dealType]}
          </Chip>
        ))}
      </FilterGroup>

      <FilterGroup label="참여 난이도">
        {DEAL_DIFFICULTIES.map((difficulty: DealDifficulty) => (
          <Chip
            key={difficulty}
            active={filter.difficulties.includes(difficulty)}
            count={difficultyCounts[difficulty] ?? 0}
            title={DIFFICULTY_DESCRIPTIONS[difficulty]}
            onClick={() => patch({ difficulties: toggleValue(filter.difficulties, difficulty) })}
          >
            {DIFFICULTY_LABELS[difficulty]}
          </Chip>
        ))}
      </FilterGroup>

      <div className="filter-bar__row filter-bar__row--bottom">
        <div className="filter-bar__toggles">
          <label className="filter-bar__toggle">
            <input
              type="checkbox"
              checked={filter.onlyUrgent}
              onChange={(event) => patch({ onlyUrgent: event.target.checked })}
            />
            <span>마감 임박만</span>
          </label>

          <label className="filter-bar__toggle">
            <input
              type="checkbox"
              checked={filter.hideClosed}
              onChange={(event) => patch({ hideClosed: event.target.checked })}
            />
            <span>종료·소진 숨기기</span>
          </label>
        </div>

        <div className="filter-bar__actions">
          <output className="filter-bar__count" aria-live="polite">
            <strong>{resultCount}</strong>개의 혜택
          </output>

          {/*
            조건부 렌더링(&&)으로 감추면, 이 버튼을 눌러 필터가 초기화되는 순간
            버튼 자신이 언마운트되어 키보드 포커스가 body 로 떨어집니다.
            `disabled` 도 같은 문제를 일으키므로(브라우저가 포커스를 blur 시킴),
            항상 마운트해 두고 `aria-disabled` 로만 비활성을 알립니다.
          */}
          <button
            type="button"
            className={`btn btn--ghost${isFilterActive ? '' : ' btn--inactive'}`}
            aria-disabled={!isFilterActive}
            onClick={() => {
              // aria-disabled 버튼은 여전히 클릭·Enter 를 받으므로 가드가 필요합니다.
              if (isFilterActive) onChange(DEFAULT_FILTER);
            }}
          >
            필터 초기화
          </button>
        </div>
      </div>
    </section>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <fieldset className="filter-group">
      <legend className="filter-group__label">{label}</legend>
      <div className="filter-group__chips">{children}</div>
    </fieldset>
  );
}

interface ChipProps {
  active: boolean;
  count: number;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}

function Chip({ active, count, title, onClick, children }: ChipProps) {
  const unavailable = count === 0 && !active;

  return (
    <button
      type="button"
      // `disabled` 를 쓰면 60초 시계 틱으로 개수가 0이 되는 순간 브라우저가
      // 포커스된 칩을 blur 시켜 키보드 사용자의 위치가 사라집니다.
      // 초기화 버튼과 같은 이유로 aria-disabled 를 씁니다.
      className={`chip${active ? ' chip--active' : ''}${unavailable ? ' chip--unavailable' : ''}`}
      aria-pressed={active}
      aria-disabled={unavailable}
      title={title}
      onClick={() => {
        if (!unavailable) onClick();
      }}
    >
      {children}
      <span className="chip__count">{count}</span>
    </button>
  );
}

export default FilterBar;
