import type { DealCategory, DealDifficulty, DealType, DecoratedDeal } from '@/types/deal';
import { sortDeals } from '@/lib/deal-status';

/**
 * 혜택 목록 필터/정렬 로직 (순수 함수)
 * ---------------------------------------------------------------------------
 * UI(React 아일랜드)와 완전히 분리되어 있어 단독으로 테스트할 수 있습니다.
 */

export const DEAL_SORT_KEYS = ['recommended', 'benefit', 'deadline', 'discount', 'latest'] as const;
export type DealSortKey = (typeof DEAL_SORT_KEYS)[number];

export const SORT_LABELS: Record<DealSortKey, string> = {
  recommended: '추천순',
  benefit: '혜택 큰 순',
  deadline: '마감임박순',
  discount: '할인율순',
  latest: '최신등록순',
};

export interface DealFilterState {
  /** 선택된 카테고리. 빈 배열이면 전체 */
  categories: DealCategory[];
  /** 선택된 혜택 유형. 빈 배열이면 전체 */
  dealTypes: DealType[];
  /** 선택된 참여 난이도. 빈 배열이면 전체 */
  difficulties: DealDifficulty[];
  /** 검색어 */
  query: string;
  /** 종료·소진된 혜택 숨기기 */
  hideClosed: boolean;
  /** 마감 임박만 보기 */
  onlyUrgent: boolean;
  sort: DealSortKey;
}

export const DEFAULT_FILTER: DealFilterState = {
  categories: [],
  dealTypes: [],
  difficulties: [],
  query: '',
  hideClosed: true,
  onlyUrgent: false,
  sort: 'recommended',
};

/** 배열에서 값을 토글합니다(있으면 제거, 없으면 추가). 원본은 유지됩니다. */
export function toggleValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

/** 검색어 매칭용 정규화: 소문자 + 공백 제거 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

/**
 * 검색어가 제목/요약/브랜드/태그 중 **하나의 필드 안에서** 이어지는지 확인합니다.
 *
 * 필드를 이어 붙인 뒤 공백을 지우면 필드 경계가 사라져,
 * 브랜드명 끝과 태그 시작이 우연히 붙은 문자열에도 매칭됩니다.
 * (예: brand "온더카페" + tag "온음료" → "카페온" 이 매칭되어 버림)
 * 필드별로 따로 검사해 그런 유령 매칭을 막습니다.
 */
export function matchesQuery(deal: DecoratedDeal, rawQuery: string): boolean {
  const query = normalize(rawQuery);
  if (query === '') return true;

  const fields = [deal.title, deal.summary, deal.brand.name, ...deal.tags];

  return fields.some((field) => normalize(field).includes(query));
}

/** 단일 혜택이 필터 조건을 만족하는지 */
export function matchesFilter(deal: DecoratedDeal, filter: DealFilterState): boolean {
  if (filter.hideClosed && (deal.status === 'ended' || deal.status === 'sold_out')) return false;
  if (filter.onlyUrgent && !deal.isUrgent) return false;
  if (filter.categories.length > 0 && !filter.categories.includes(deal.category)) return false;
  if (filter.dealTypes.length > 0 && !filter.dealTypes.includes(deal.dealType)) return false;
  if (filter.difficulties.length > 0 && !filter.difficulties.includes(deal.difficulty))
    return false;
  if (!matchesQuery(deal, filter.query)) return false;

  return true;
}

/** 종료·소진된 혜택인지 (정렬에서 항상 뒤로 보낼 대상) */
function isClosed(deal: DecoratedDeal): boolean {
  return deal.status === 'ended' || deal.status === 'sold_out';
}

/** 정렬만 적용합니다. 원본 배열은 변경되지 않습니다. */
export function applySort(deals: DecoratedDeal[], sort: DealSortKey): DecoratedDeal[] {
  switch (sort) {
    case 'deadline':
      // 종료된 혜택은 daysLeft 가 음수라, 그냥 오름차순으로 두면 최상단을 차지합니다.
      // 따라서 (1) 종료·소진을 항상 뒤로 보내고,
      //        (2) 살아있는 것끼리는 마감 임박 순(상시는 맨 뒤),
      //        (3) 종료된 것끼리는 최근에 끝난 순,
      //        (4) 동점이면 최근 갱신 순으로 안정화합니다.
      return [...deals].sort((a, b) => {
        const byClosed = Number(isClosed(a)) - Number(isClosed(b));
        if (byClosed !== 0) return byClosed;

        const left = a.daysLeft ?? Number.MAX_SAFE_INTEGER;
        const right = b.daysLeft ?? Number.MAX_SAFE_INTEGER;
        const byDeadline = isClosed(a) ? right - left : left - right;
        if (byDeadline !== 0) return byDeadline;

        return Date.parse(b.meta.updatedAt) - Date.parse(a.meta.updatedAt);
      });

    case 'benefit':
      /*
        혜택의 크기 순. 종류가 달라도 하나의 축으로 비교합니다.
        (캐시백 87만원과 할인 8,300원을 나란히 놓을 수 있어야
         "줍딜할 만한 게 없다"는 인상을 바로잡을 수 있습니다.)

        "최대 N원"은 조건에 따라 실제로는 훨씬 적을 수 있으므로,
        금액이 같으면 확정 금액을 앞에 둡니다.
      */
      return [...deals].sort((a, b) => {
        const byAmount = (b.benefit?.amount ?? -1) - (a.benefit?.amount ?? -1);
        if (byAmount !== 0) return byAmount;

        const byCertainty = Number(a.benefit?.isMax ?? false) - Number(b.benefit?.isMax ?? false);
        if (byCertainty !== 0) return byCertainty;

        return Date.parse(b.meta.updatedAt) - Date.parse(a.meta.updatedAt);
      });

    case 'discount':
      return [...deals].sort((a, b) => {
        const byDiscount = (b.discountRate ?? -1) - (a.discountRate ?? -1);
        if (byDiscount !== 0) return byDiscount;

        return Date.parse(b.meta.updatedAt) - Date.parse(a.meta.updatedAt);
      });

    case 'latest':
      return [...deals].sort((a, b) => Date.parse(b.meta.updatedAt) - Date.parse(a.meta.updatedAt));

    case 'recommended':
    default:
      return sortDeals(deals);
  }
}

/** 필터 + 정렬을 한 번에 적용합니다. */
export function filterDeals(deals: DecoratedDeal[], filter: DealFilterState): DecoratedDeal[] {
  return applySort(
    deals.filter((deal) => matchesFilter(deal, filter)),
    filter.sort,
  );
}

/**
 * 필터 칩에 표시할 개수를 셉니다.
 * "해당 축(카테고리 등)만 해제한 상태"에서의 개수라서,
 * 다른 필터를 건 채로도 각 칩의 결과 수를 미리 볼 수 있습니다.
 */
export function countByCategory(
  deals: DecoratedDeal[],
  filter: DealFilterState,
): Record<string, number> {
  const base = deals.filter((deal) => matchesFilter(deal, { ...filter, categories: [] }));
  return tally(base, (deal) => deal.category);
}

export function countByDealType(
  deals: DecoratedDeal[],
  filter: DealFilterState,
): Record<string, number> {
  const base = deals.filter((deal) => matchesFilter(deal, { ...filter, dealTypes: [] }));
  return tally(base, (deal) => deal.dealType);
}

export function countByDifficulty(
  deals: DecoratedDeal[],
  filter: DealFilterState,
): Record<string, number> {
  const base = deals.filter((deal) => matchesFilter(deal, { ...filter, difficulties: [] }));
  return tally(base, (deal) => deal.difficulty);
}

/** 기본값과 달라진 필터가 하나라도 있는지 (초기화 버튼 노출 판단) */
export function hasActiveFilter(filter: DealFilterState): boolean {
  return (
    filter.categories.length > 0 ||
    filter.dealTypes.length > 0 ||
    filter.difficulties.length > 0 ||
    filter.query.trim() !== '' ||
    filter.onlyUrgent ||
    filter.hideClosed !== DEFAULT_FILTER.hideClosed ||
    filter.sort !== DEFAULT_FILTER.sort
  );
}

function tally<T>(items: T[], pick: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = pick(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
