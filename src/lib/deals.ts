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

/** 검증된 원본 Deal 목록. 같은 곳으로 보내는 항목은 하나로 합칩니다. */
export function getAllDeals(): Deal[] {
  return dedupeByDestination(getDealsFile().deals);
}

/**
 * 링크가 같은 항목을 하나만 남깁니다.
 *
 * 여러 소스가 같은 혜택을 각자 올립니다. 실제로 뽐뿌 쿠폰게시판과
 * 루리웹이 같은 네이버페이 이벤트를 각각 수집해, 완전히 동일한 URL 을 가진
 * 카드가 두 장 떴습니다.
 *
 * 이걸 `merge.ts` 에서 합치지 않는 이유가 있습니다. 거기서는 서로 다른 소스가
 * 같은 링크를 쓴다고 덮어쓰면 기존 항목의 id·slug 아래 전혀 다른 혜택이
 * 들어앉을 수 있어, 일부러 소스가 같을 때만 동일하다고 봅니다.
 * 그 판단은 **저장**에 대해서는 맞습니다 — 소스가 하나 죽어도 다른 소스의
 * 기록이 남습니다. 다만 **화면**에는 같은 것이 두 번 보이면 안 되므로
 * 읽는 쪽에서 겹칩니다.
 *
 * 무엇을 남길지: 정보가 더 많은 쪽입니다.
 * 값어치를 아는 항목 > 모르는 항목, 그다음 신뢰도가 높은 쪽.
 */
export function dedupeByDestination(deals: Deal[]): Deal[] {
  const best = new Map<string, Deal>();

  for (const deal of deals) {
    const key = normalizeDestination(deal.link.url);
    const kept = best.get(key);

    if (!kept || isRicher(deal, kept)) best.set(key, deal);
  }

  // 원본 순서를 유지합니다. 정렬은 뒤에서 따로 합니다.
  const survivors = new Set(best.values());
  return deals.filter((deal) => survivors.has(deal));
}

/** 추적 파라미터를 뺀 목적지. 같은 곳이면 같은 키가 나와야 합니다. */
function normalizeDestination(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|ref$|from$)/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    return parsed.href.replace(/\/$/, '');
  } catch {
    return url;
  }
}

function isRicher(candidate: Deal, kept: Deal): boolean {
  const byBenefit = Number(Boolean(candidate.benefit)) - Number(Boolean(kept.benefit));
  if (byBenefit !== 0) return byBenefit > 0;

  return (candidate.source.confidence ?? 0) > (kept.source.confidence ?? 0);
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
