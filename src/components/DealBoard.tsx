import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Deal } from '@/types/deal';
import { decorateDeals } from '@/lib/deal-status';
import { DEFAULT_FILTER, filterDeals, type DealFilterState } from '@/lib/deal-filter';
import { useLiveNow } from '@/hooks/use-live-now';
import { DealCard } from '@/components/DealCard';
import { FilterBar } from '@/components/FilterBar';

interface DealBoardProps {
  /** 빌드 타임에 검증된 원본 혜택 목록 */
  deals: Deal[];
  /**
   * 서버(빌드) 시각 ISO 문자열.
   * 첫 렌더는 이 값을 사용해 서버 HTML과 동일하게 그리고(하이드레이션 불일치 방지),
   * 마운트 직후 실제 현재 시각으로 교체해 상태 뱃지를 최신화합니다.
   */
  buildTime: string;
}

/**
 * 혜택 보드 (React 아일랜드)
 * 필터 상태를 소유하고, 계산은 전부 순수 함수(src/lib)에 위임합니다.
 */
export function DealBoard({ deals, buildTime }: DealBoardProps) {
  const [filter, setFilter] = useState<DealFilterState>(DEFAULT_FILTER);
  const now = useLiveNow(buildTime);

  const decorated = useMemo(() => decorateDeals(deals, now), [deals, now]);
  const visible = useMemo(() => filterDeals(decorated, filter), [decorated, filter]);

  const resultsRef = useRef<HTMLUListElement>(null);
  const shouldRefocus = useRef(false);

  /**
   * 빈 상태의 초기화 버튼은 누르는 순간 자기 자신이 사라집니다.
   * 그대로 두면 포커스가 body 로 떨어져 키보드 사용자가 문서 맨 위로 돌아가므로,
   * 복구된 목록으로 포커스를 명시적으로 넘깁니다.
   */
  const resetFromEmptyState = useCallback(() => {
    setFilter((current) => {
      // 이미 기본 필터면 React 가 리렌더를 건너뛰어 아래 effect 가 실행되지 않습니다.
      // 그때 플래그를 세워 두면 한참 뒤 시계 틱에서 엉뚱하게 포커스를 가로챕니다.
      if (current === DEFAULT_FILTER) return current;

      shouldRefocus.current = true;
      return DEFAULT_FILTER;
    });
  }, []);

  useEffect(() => {
    if (!shouldRefocus.current) return;

    // 결과가 여전히 0건이어도 플래그가 남지 않도록 무조건 해제합니다.
    shouldRefocus.current = false;
    if (visible.length > 0) resultsRef.current?.focus();
  }, [visible]);

  return (
    <div className="deal-board">
      <FilterBar
        deals={decorated}
        filter={filter}
        onChange={setFilter}
        resultCount={visible.length}
      />

      {visible.length > 0 ? (
        <ul
          ref={resultsRef}
          tabIndex={-1}
          aria-label={`혜택 ${visible.length}건`}
          className="deal-grid"
          data-testid="deal-grid"
        >
          {visible.map((deal) => (
            <li key={deal.id} className="deal-grid__item">
              <DealCard deal={deal} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-state" role="status" data-testid="empty-state">
          <p className="empty-state__emoji" aria-hidden="true">
            🧺
          </p>
          <p className="empty-state__title">조건에 맞는 혜택이 없어요</p>
          <p className="empty-state__desc">필터를 조금 풀어 보면 주울 게 더 보일 거예요.</p>
          <button type="button" className="btn btn--primary" onClick={resetFromEmptyState}>
            필터 초기화
          </button>
        </div>
      )}
    </div>
  );
}

export default DealBoard;
