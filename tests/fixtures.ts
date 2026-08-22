import type { Deal, DecoratedDeal } from '@/types/deal';
import { decorateDeal } from '@/lib/deal-status';

/**
 * 테스트용 Deal 팩토리.
 * 모든 테스트가 고정된 기준 시각(NOW)을 사용하므로 결과가 항상 결정적입니다.
 */

/** 테스트 기준 시각: 2026-08-20 12:00 KST */
export const NOW = new Date('2026-08-20T12:00:00+09:00');

/** 스키마를 만족하는 최소 Deal. overrides 로 필요한 필드만 바꿔 씁니다. */
export function makeDeal(overrides: DeepPartial<Deal> = {}): Deal {
  const base: Deal = {
    id: 'dl_test_0001',
    slug: 'test-deal',
    title: '테스트 혜택',
    summary: '테스트용 혜택 요약입니다.',
    brand: { name: '테스트브랜드' },
    category: 'cafe',
    dealType: 'free',
    difficulty: 'easy',
    price: { original: 5000, final: 0, currency: 'KRW' },
    limit: { firstComeFirstServed: false },
    period: {
      startAt: '2026-08-01T00:00:00+09:00',
      endAt: '2026-08-31T23:59:59+09:00',
    },
    link: { url: 'https://example.com/deal' },
    tags: ['테스트'],
    source: {
      name: '테스트 출처',
      collectedAt: '2026-08-20T05:00:00+09:00',
      method: 'manual',
    },
    meta: { verified: true, updatedAt: '2026-08-20T05:00:00+09:00' },
  };

  return mergeDeep(base, overrides);
}

/** 파생 필드까지 계산된 Deal */
export function makeDecoratedDeal(
  overrides: DeepPartial<Deal> = {},
  now: Date = NOW,
): DecoratedDeal {
  return decorateDeal(makeDeal(overrides), now);
}

/* -------------------------------------------------------------------------- */

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object | undefined ? DeepPartial<NonNullable<T[K]>> : T[K];
};

function mergeDeep<T>(base: T, patch: DeepPartial<T>): T {
  const result = { ...base } as Record<string, unknown>;

  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const current = result[key];

    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      result[key] = mergeDeep(current, value as DeepPartial<typeof current>);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}
