import { describe, expect, it } from 'vitest';
import type { Deal, DealsFile } from '@/types/deal';
import { DEAL_SCHEMA_VERSION } from '@/types/deal';
import { isSameContent, mergeDeals } from '@pipeline/merge';

const NOW = new Date('2026-08-23T12:00:00+09:00');

function makeDeal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: 'dl_demo_aaa',
    slug: 'demo-aaa',
    title: '테스트 혜택',
    summary: '요약',
    brand: { name: '브랜드' },
    category: 'cafe',
    dealType: 'free',
    difficulty: 'easy',
    price: { original: 5000, final: 0, currency: 'KRW' },
    limit: { firstComeFirstServed: false },
    period: { startAt: '2026-08-01T00:00:00+09:00', endAt: '2026-09-30T23:59:59+09:00' },
    link: { url: 'https://example.com/a' },
    tags: ['태그'],
    source: {
      name: '소스',
      url: 'https://example.com/a',
      collectedAt: '2026-08-23T03:00:00.000Z',
      method: 'llm',
      confidence: 0.9,
    },
    meta: { verified: false, updatedAt: '2026-08-23T03:00:00.000Z' },
    ...overrides,
  };
}

function makeFile(deals: Deal[]): DealsFile {
  return {
    schemaVersion: DEAL_SCHEMA_VERSION,
    generatedAt: '2026-08-22T00:00:00+09:00',
    deals,
  };
}

describe('mergeDeals — 신규/갱신/유지', () => {
  it('없던 항목을 추가한다', () => {
    const result = mergeDeals(makeFile([]), [makeDeal()], { now: NOW });

    expect(result.added).toHaveLength(1);
    expect(result.file.deals).toHaveLength(1);
  });

  it('내용이 같으면 변화 없음으로 본다', () => {
    const existing = makeDeal();
    const result = mergeDeals(makeFile([existing]), [makeDeal()], { now: NOW });

    expect(result.added).toHaveLength(0);
    expect(result.updated).toHaveLength(0);
    expect(result.unchanged).toHaveLength(1);
  });

  it('수집 시각·신뢰도만 달라진 것은 변화로 보지 않는다', () => {
    // 이게 깨지면 내용이 그대로여도 매일 커밋이 생깁니다.
    const existing = makeDeal();
    const incoming = makeDeal({
      source: { ...existing.source, collectedAt: '2026-08-24T03:00:00.000Z', confidence: 0.85 },
      meta: { verified: false, updatedAt: '2026-08-24T03:00:00.000Z' },
    });

    const result = mergeDeals(makeFile([existing]), [incoming], { now: NOW });
    expect(result.unchanged).toHaveLength(1);
    expect(result.updated).toHaveLength(0);
  });

  it('제목이 바뀌면 갱신한다', () => {
    const result = mergeDeals(makeFile([makeDeal()]), [makeDeal({ title: '바뀐 제목' })], {
      now: NOW,
    });

    expect(result.updated).toHaveLength(1);
    expect(result.file.deals[0]?.title).toBe('바뀐 제목');
  });

  it('갱신해도 기존 id 와 slug 를 유지한다', () => {
    const existing = makeDeal({ id: 'dl_original', slug: 'original-slug' });
    const incoming = makeDeal({ id: 'dl_new', slug: 'new-slug', title: '바뀐 제목' });

    const result = mergeDeals(makeFile([existing]), [incoming], { now: NOW });

    // id 가 달라도 링크가 같으므로 같은 혜택으로 인식되어야 합니다.
    expect(result.file.deals).toHaveLength(1);
    expect(result.file.deals[0]?.id).toBe('dl_original');
    expect(result.file.deals[0]?.slug).toBe('original-slug');
  });

  it('추적 파라미터만 다른 링크를 같은 혜택으로 본다', () => {
    const existing = makeDeal({ link: { url: 'https://example.com/a' } });
    const incoming = makeDeal({
      id: 'dl_other',
      slug: 'other',
      link: { url: 'https://example.com/a?utm_source=x' },
    });

    const result = mergeDeals(makeFile([existing]), [incoming], { now: NOW });
    expect(result.file.deals).toHaveLength(1);
  });
});

describe('mergeDeals — 검수 완료 항목 보호', () => {
  it('verified 항목은 자동 수집이 덮어쓰지 않는다', () => {
    // 큐레이터가 고쳐 놓은 값을 크롤러가 매일 되돌리면 아무도 손대지 않게 됩니다.
    const curated = makeDeal({
      title: '사람이 다듬은 제목',
      meta: { verified: true, updatedAt: '2026-08-20T00:00:00+09:00' },
    });
    const incoming = makeDeal({ title: '모델이 만든 제목' });

    const result = mergeDeals(makeFile([curated]), [incoming], { now: NOW });

    expect(result.file.deals[0]?.title).toBe('사람이 다듬은 제목');
    expect(result.protectedFromOverwrite).toHaveLength(1);
  });

  it('verified 항목이라도 남은 수량은 갱신한다', () => {
    const curated = makeDeal({
      title: '사람이 다듬은 제목',
      limit: { firstComeFirstServed: true, quantity: 100, remaining: 50 },
      meta: { verified: true, updatedAt: '2026-08-20T00:00:00+09:00' },
    });
    const incoming = makeDeal({
      title: '모델이 만든 제목',
      limit: { firstComeFirstServed: true, quantity: 100, remaining: 12 },
    });

    const result = mergeDeals(makeFile([curated]), [incoming], { now: NOW });

    expect(result.file.deals[0]?.limit.remaining).toBe(12);
    expect(result.file.deals[0]?.title).toBe('사람이 다듬은 제목');
    expect(result.updated).toHaveLength(1);
  });

  it('수량 변화가 없으면 verified 항목은 그대로 둔다', () => {
    const curated = makeDeal({
      limit: { firstComeFirstServed: true, quantity: 100, remaining: 50 },
      meta: { verified: true, updatedAt: '2026-08-20T00:00:00+09:00' },
    });

    const result = mergeDeals(makeFile([curated]), [makeDeal({ ...curated, title: '다른 제목' })], {
      now: NOW,
    });

    expect(result.unchanged).toHaveLength(1);
    expect(result.updated).toHaveLength(0);
  });
});

describe('mergeDeals — 정리와 정렬', () => {
  it('오래 종료된 항목을 제거한다', () => {
    const old = makeDeal({
      id: 'dl_old',
      slug: 'old',
      link: { url: 'https://example.com/old' },
      period: { startAt: '2026-01-01T00:00:00+09:00', endAt: '2026-06-01T00:00:00+09:00' },
    });
    const live = makeDeal({
      id: 'dl_live',
      slug: 'live',
      link: { url: 'https://example.com/live' },
    });

    const result = mergeDeals(makeFile([old, live]), [], { now: NOW, pruneAfterDays: 30 });

    expect(result.pruned.map((deal) => deal.id)).toEqual(['dl_old']);
    expect(result.file.deals.map((deal) => deal.id)).toEqual(['dl_live']);
  });

  it('상시 혜택은 제거하지 않는다', () => {
    const always = makeDeal({ period: { startAt: '2026-01-01T00:00:00+09:00', endAt: null } });
    const result = mergeDeals(makeFile([always]), [], { now: NOW, pruneAfterDays: 30 });

    expect(result.pruned).toHaveLength(0);
  });

  it('pruneAfterDays 가 0 이면 아무것도 제거하지 않는다', () => {
    const old = makeDeal({
      period: { startAt: '2020-01-01T00:00:00+09:00', endAt: '2020-02-01T00:00:00+09:00' },
    });
    const result = mergeDeals(makeFile([old]), [], { now: NOW, pruneAfterDays: 0 });

    expect(result.pruned).toHaveLength(0);
    expect(result.file.deals).toHaveLength(1);
  });

  it('결과를 id 순으로 정렬해 diff 를 안정적으로 만든다', () => {
    const b = makeDeal({ id: 'dl_b', slug: 'b', link: { url: 'https://example.com/b' } });
    const a = makeDeal({ id: 'dl_a', slug: 'a', link: { url: 'https://example.com/a2' } });

    const result = mergeDeals(makeFile([]), [b, a], { now: NOW });
    expect(result.file.deals.map((deal) => deal.id)).toEqual(['dl_a', 'dl_b']);
  });

  it('변경이 있을 때만 generatedAt 을 갱신한다', () => {
    // 무조건 갱신하면 CI 의 '변경 여부' 게이트가 항상 참이 되어 매일 빈 PR 이 생깁니다.
    const unchanged = mergeDeals(makeFile([]), [], { now: NOW });
    expect(unchanged.file.generatedAt).toBe('2026-08-22T00:00:00+09:00');

    const changed = mergeDeals(makeFile([]), [makeDeal()], { now: NOW });
    expect(changed.file.generatedAt).toBe(NOW.toISOString());
  });

  it('스키마 버전을 그대로 유지한다', () => {
    const result = mergeDeals(makeFile([]), [], { now: NOW });
    expect(result.file.schemaVersion).toBe(DEAL_SCHEMA_VERSION);
  });
});

describe('isSameContent', () => {
  it('실행마다 바뀌는 필드는 비교에서 제외한다', () => {
    const a = makeDeal();
    const b = makeDeal({
      meta: { verified: false, updatedAt: '2099-01-01T00:00:00+09:00' },
      source: { ...a.source, collectedAt: '2099-01-01T00:00:00+09:00', confidence: 0.1 },
    });

    expect(isSameContent(a, b)).toBe(true);
  });

  it('내용이 다르면 다르다고 본다', () => {
    expect(isSameContent(makeDeal(), makeDeal({ summary: '다른 요약' }))).toBe(false);
  });

  it('출처 이름이 바뀌면 다르다고 본다', () => {
    const a = makeDeal();
    const b = makeDeal({ source: { ...a.source, name: '다른 소스' } });

    expect(isSameContent(a, b)).toBe(false);
  });
});
