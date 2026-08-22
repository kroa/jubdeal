import rawDeals from '@/data/deals.json';
import { parseDealsFile } from '@/lib/deal-schema';
import { decorateDeals, sortDeals } from '@/lib/deal-status';
import type { Deal, DecoratedDeal, DealsFile } from '@/types/deal';

/**
 * 혜택 데이터 로더 (빌드 타임에 실행)
 * ---------------------------------------------------------------------------
 * deals.json 을 zod 스키마로 검증한 뒤 반환합니다.
 * 데이터가 스키마를 위반하면 여기서 예외가 발생해 **빌드가 실패**합니다.
 * → 깨진 데이터가 운영에 배포되는 것을 원천 차단합니다.
 *
 * 추후 자동 크롤러를 붙일 때는 이 모듈만 교체하면 되며,
 * 나머지 UI 코드는 그대로 재사용됩니다.
 */

let cached: DealsFile | null = null;

/** 검증된 데이터 파일 전체를 반환합니다. */
export function getDealsFile(): DealsFile {
  cached ??= parseDealsFile(rawDeals);
  return cached;
}

/** 검증된 원본 Deal 목록 */
export function getAllDeals(): Deal[] {
  return getDealsFile().deals;
}

/**
 * 파생 필드가 붙고 기본 정렬이 적용된 목록.
 * @param now 기준 시각. 생략하면 현재 시각(= 빌드 시각)
 */
export function getDecoratedDeals(now: Date = new Date()): DecoratedDeal[] {
  return sortDeals(decorateDeals(getAllDeals(), now));
}

/** 슬러그로 단건 조회 */
export function getDealBySlug(slug: string, now: Date = new Date()): DecoratedDeal | undefined {
  return getDecoratedDeals(now).find((deal) => deal.slug === slug);
}

/** 데이터셋 갱신 시각 */
export function getGeneratedAt(): string {
  return getDealsFile().generatedAt;
}

/** 테스트에서 캐시를 비우기 위한 헬퍼 */
export function __resetDealsCache(): void {
  cached = null;
}
