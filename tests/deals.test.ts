import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetDealsCache,
  getAllDeals,
  getDealBySlug,
  getDealsFile,
  getDecoratedDeals,
  getGeneratedAt,
} from '@/lib/deals';
import { DEAL_SCHEMA_VERSION } from '@/types/deal';
import { NOW } from './fixtures';

afterEach(() => {
  __resetDealsCache();
});

describe('deals 로더', () => {
  it('검증된 데이터 파일을 반환한다', () => {
    const file = getDealsFile();

    expect(file.schemaVersion).toBe(DEAL_SCHEMA_VERSION);
    expect(file.deals.length).toBeGreaterThan(0);
  });

  it('데이터셋 갱신 시각을 노출한다', () => {
    expect(getGeneratedAt()).toBe(getDealsFile().generatedAt);
    expect(Number.isNaN(Date.parse(getGeneratedAt()))).toBe(false);
  });

  it('같은 객체를 캐시해 반복 파싱하지 않는다', () => {
    expect(getDealsFile()).toBe(getDealsFile());
  });

  it('캐시를 비우면 새로 파싱한다', () => {
    const before = getDealsFile();
    __resetDealsCache();

    const after = getDealsFile();
    expect(after).not.toBe(before);
    expect(after.deals).toHaveLength(before.deals.length);
  });

  it('기준 시각을 넘기면 그 시점 기준으로 상태를 계산한다', () => {
    /*
      기준 시각을 상수로 박으면 안 됩니다.
      이 로더는 파이프라인이 **매일 갱신하는 실제 데이터**를 읽습니다.
      고정 날짜를 쓰면 수집 결과에 따라 통과 여부가 달라져,
      수집 워크플로의 테스트 게이트가 무작위로 깨집니다.
      그래서 판정 시각을 데이터에서 유도합니다.
    */
    const deals = getAllDeals();
    expect(deals.length).toBeGreaterThan(0);

    const first = deals[0];
    if (!first) return;

    // 시작 직후라면 아직 살아 있어야 합니다.
    const justStarted = new Date(Date.parse(first.period.startAt) + 60_000);
    expect(getDecoratedDeals(justStarted).some((deal) => deal.isActionable)).toBe(true);

    // 캐시된 데이터를 쓰더라도 now 는 매번 반영되어야 합니다.
    const farFuture = getDecoratedDeals(new Date('2999-01-01T00:00:00+09:00'));
    for (const deal of farFuture) {
      // 먼 미래에는 마감일이 없는 혜택만 살아남습니다.
      if (deal.isActionable) expect(deal.period.endAt).toBeNull();
    }
  });

  it('기본 정렬이 적용된 상태로 돌려준다', () => {
    const decorated = getDecoratedDeals(NOW);
    const statuses = decorated.map((deal) => deal.status);

    const firstEnded = statuses.indexOf('ended');
    const lastOngoing = statuses.lastIndexOf('ongoing');

    // 종료된 혜택이 진행 중인 혜택보다 앞에 오면 안 됩니다.
    if (firstEnded !== -1 && lastOngoing !== -1) {
      expect(firstEnded).toBeGreaterThan(lastOngoing);
    }
  });

  it('슬러그로 조회한 결과가 전체 목록과 일치한다', () => {
    for (const deal of getAllDeals()) {
      expect(getDealBySlug(deal.slug, NOW)?.id).toBe(deal.id);
    }
  });
});
