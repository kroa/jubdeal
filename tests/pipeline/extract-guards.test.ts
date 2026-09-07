import { describe, expect, it, vi } from 'vitest';
import { DealExtractor } from '@pipeline/extract/extract';
import type { LlmProvider, LlmRequest, LlmResponse } from '@pipeline/extract/providers/types';
import type { RawItem } from '@pipeline/types';

/**
 * 품질을 이유로 모델을 내리는 경로
 * ---------------------------------------------------------------------------
 * 한도나 오류가 아니라 **응답 내용**이 못 쓸 때 씁니다.
 * 호출은 성공하고 스키마도(때로는) 통과하므로 기존 폴백으로는 안 걸립니다.
 */

const NOW = new Date('2026-09-07T12:00:00+09:00');

function item(overrides: Partial<RawItem> = {}): RawItem {
  return {
    sourceId: 'test',
    sourceName: '테스트',
    url: 'https://example.com/1',
    title: '스타벅스 아메리카노 1잔 무료 쿠폰',
    text: '스타벅스 아메리카노 톨 사이즈 1잔을 무료로 드립니다. 9월 30일까지.',
    collectedAt: '2026-09-07T00:00:00+09:00',
    ...overrides,
  };
}

/** 정해진 응답을 순서대로 돌려주는 가짜 프로바이더 */
function fakeProvider(responses: unknown[], label = 'openrouter:bad/model:free') {
  const banned: string[] = [];
  let index = 0;

  const provider: LlmProvider = {
    name: 'chain',
    isConfigured: async () => true,
    complete: async (_request: LlmRequest): Promise<LlmResponse> => {
      const data = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return {
        data,
        provider: label,
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: null },
      } as LlmResponse;
    },
    banModel: (model: string) => banned.push(model),
  };

  return { provider, banned };
}

/** 모든 검사를 통과하는 정상 응답 */
function goodResponse() {
  return {
    isDeal: true,
    title: '스타벅스 아메리카노 1잔 무료',
    summary: '스타벅스 아메리카노 톨 1잔 무료 증정',
    description: '9월 30일까지',
    brandName: '스타벅스',
    category: 'cafe',
    dealType: 'free',
    difficulty: 'easy',
    originalPrice: 4500,
    finalPrice: 0,
    firstComeFirstServed: false,
    quantity: null,
    perPersonLimit: null,
    benefitAmount: null,
    benefitIsMax: false,
    benefitBaseAmount: null,
    startDate: null,
    endDate: '2026-09-30',
    endDateKind: 'dated',
    linkUrl: null,
    linkLabel: null,
    howTo: [],
    caution: [],
    tags: ['스타벅스'],
    confidence: 0.95,
    notes: '',
  };
}

describe('한자를 섞는 모델은 곧바로 내린다', () => {
  it('한 번이라도 섞으면 제외한다', async () => {
    /*
      프롬프트에 "한국어로만 쓰세요"를 예시까지 넣었는데도 같은 모델이
      계속 섞었습니다. 성공한 모델은 "마지막 성공 모델"로 캐시되어
      다음 항목에서도 다시 뽑히므로, 한 소스에서 3건 중 2건이 날아갔습니다.
    */
    const bad = { ...goodResponse(), title: '스타벅스 아메리카노 1잔免费 쿠폰' };
    const { provider, banned } = fakeProvider([bad]);
    const extractor = new DealExtractor({ provider, log: () => {} });

    const outcome = await extractor.extract(item(), NOW);

    expect(outcome.ok).toBe(false);
    expect(banned).toEqual(['bad/model:free']);
  });
});

describe('스키마를 반복해 어기는 모델을 내린다', () => {
  it('한 번은 봐주고 두 번째에 제외한다', async () => {
    /*
      한 모델이 우리 스키마를 통째로 무시하고 `price`·`shippingCost`·
      `benefitType` 처럼 그럴듯한 이름을 지어내 다섯 건을 연달아 날렸습니다.
      다만 긴 본문에서 필드 하나를 흘리는 일은 어느 모델에나 있으므로
      한 번은 봐줍니다.
    */
    const 지어낸스키마 = { title: 'x', price: 1000, shippingCost: 0, benefitType: 'discount' };
    const { provider, banned } = fakeProvider([지어낸스키마]);
    const extractor = new DealExtractor({ provider, log: () => {} });

    const first = await extractor.extract(item(), NOW);
    expect(first.ok).toBe(false);
    expect(banned).toEqual([]);

    const second = await extractor.extract(item(), NOW);
    expect(second.ok).toBe(false);
    expect(banned).toEqual(['bad/model:free']);
  });

  it('세 번째부터는 다시 제외하지 않는다', async () => {
    // 같은 모델을 몇 번이고 내리면 로그만 시끄러워집니다.
    const { provider, banned } = fakeProvider([{ title: 'x' }]);
    const extractor = new DealExtractor({ provider, log: () => {} });

    for (let i = 0; i < 4; i += 1) await extractor.extract(item(), NOW);

    expect(banned).toEqual(['bad/model:free']);
  });
});

describe('정상 응답은 통과시킨다', () => {
  it('아무 모델도 내리지 않는다', async () => {
    const { provider, banned } = fakeProvider([goodResponse()]);
    const extractor = new DealExtractor({ provider, log: () => {} });

    const outcome = await extractor.extract(item(), NOW);

    expect(outcome.ok).toBe(true);
    expect(banned).toEqual([]);
  });

  it('banModel 을 구현하지 않은 프로바이더에서도 죽지 않는다', async () => {
    // 인터페이스에서 선택적 메서드입니다. 모델을 하나만 쓰는 프로바이더는
    // 구현할 이유가 없습니다.
    const provider: LlmProvider = {
      name: 'claude-cli',
      isConfigured: async () => true,
      complete: async () =>
        ({
          data: { ...goodResponse(), title: '아메리카노 1잔免费' },
          provider: 'claude-cli:sonnet',
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: null },
        }) as LlmResponse,
    };
    const extractor = new DealExtractor({ provider, log: vi.fn() });

    await expect(extractor.extract(item(), NOW)).resolves.toMatchObject({ ok: false });
  });
});
