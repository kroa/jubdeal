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

describe('스키마를 어기는 모델을 내린다', () => {
  it('스키마를 통째로 지어내면 곧바로 제외한다', async () => {
    /*
      한 모델이 우리 스키마를 무시하고 `price`·`shippingCost`·`benefitType`
      처럼 그럴듯한 이름을 지어내 다섯 건을 연달아 날렸습니다.
      필수 필드가 통째로 없으므로 한 번으로 내립니다.
    */
    const 지어낸스키마 = { title: 'x', price: 1000, shippingCost: 0, benefitType: 'discount' };
    const { provider, banned } = fakeProvider([지어낸스키마]);
    const extractor = new DealExtractor({ provider, log: () => {} });

    const outcome = await extractor.extract(item(), NOW);
    expect(outcome.ok).toBe(false);
    expect(banned).toEqual(['bad/model:free']);
  });

  it('같은 모델을 몇 번이고 내리지는 않는다', async () => {
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

describe('모델이 필드를 빼먹어도 혜택을 버리지 않는다', () => {
  /*
    "없으면 빈 문자열"이라고 적어 둬도 모델은 필드를 통째로 뺍니다.
    필수로 두면 그때마다 멀쩡한 혜택이 거절됐습니다 — 한 실행에서
    description 때문에 5건, brandName 때문에 여러 건이 날아갔습니다.
  */
  function withoutFields(...omit: string[]) {
    const data = goodResponse() as Record<string, unknown>;
    for (const key of omit) delete data[key];
    return data;
  }

  it('description 이 없어도 통과한다', async () => {
    const { provider } = fakeProvider([withoutFields('description')]);
    const extractor = new DealExtractor({ provider, log: () => {} });

    await expect(extractor.extract(item(), NOW)).resolves.toMatchObject({ ok: true });
  });

  it('brandName 이 없어도 통과한다', async () => {
    // 공공·문화 행사는 주최를 따로 밝히지 않는 글이 흔합니다.
    const { provider } = fakeProvider([withoutFields('brandName')]);
    const extractor = new DealExtractor({ provider, log: () => {} });

    await expect(extractor.extract(item(), NOW)).resolves.toMatchObject({ ok: true });
  });
});

describe('필수 항목을 빠뜨리는 모델은 내리고 다시 시도한다', () => {
  /*
    한 모델이 dealType·brandName·description 을 차례로 빼먹으며 소스마다
    몇 건씩 날렸습니다. 필드마다 옵셔널로 바꾸는 것은 끝이 없고,
    dealType 처럼 정말 필수인 것도 있습니다.

    내리기만 하면 그 항목은 이미 잃은 뒤라, 같은 항목을 한 번 더 돌립니다.
  */
  function twoModelProvider(first: unknown, second: unknown) {
    const banned: string[] = [];
    let call = 0;

    const provider: LlmProvider = {
      name: 'chain',
      isConfigured: async () => true,
      complete: async (): Promise<LlmResponse> => {
        const bad = banned.includes('bad/model:free');
        call += 1;
        return {
          data: bad ? second : first,
          provider: bad ? 'openrouter:good/model:free' : 'openrouter:bad/model:free',
          usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, costUsd: null },
        } as LlmResponse;
      },
      banModel: (model: string) => banned.push(model),
    };

    return { provider, banned, calls: () => call };
  }

  it('필수 항목 누락은 한 번으로 내리고 재시도해 살린다', async () => {
    const 누락 = { ...goodResponse() } as Record<string, unknown>;
    delete 누락.dealType;

    const { provider, banned, calls } = twoModelProvider(누락, goodResponse());
    const extractor = new DealExtractor({ provider, log: () => {} });

    const outcome = await extractor.extract(item(), NOW);

    expect(banned).toEqual(['bad/model:free']);
    expect(calls()).toBe(2);
    expect(outcome.ok).toBe(true);
  });

  it('재시도분의 사용량도 합친다', async () => {
    // 빠뜨리면 비용 보고가 실제보다 적게 나옵니다.
    const 누락 = { ...goodResponse() } as Record<string, unknown>;
    delete 누락.dealType;

    const { provider } = twoModelProvider(누락, goodResponse());
    const extractor = new DealExtractor({ provider, log: () => {} });

    const outcome = await extractor.extract(item(), NOW);

    expect(outcome.usage.inputTokens).toBe(20);
    expect(outcome.usage.outputTokens).toBe(10);
  });

  it('재시도는 한 번뿐이다', async () => {
    // 모든 모델이 같은 결함이면 무한히 돌 수 있습니다.
    const 누락 = { ...goodResponse() } as Record<string, unknown>;
    delete 누락.dealType;

    const { provider, calls } = twoModelProvider(누락, 누락);
    const extractor = new DealExtractor({ provider, log: () => {} });

    const outcome = await extractor.extract(item(), NOW);

    expect(outcome.ok).toBe(false);
    expect(calls()).toBe(2);
  });

  it('값이 틀린 정도는 한 번 봐준다', async () => {
    // 신뢰도 범위를 벗어난 정도는 우연일 수 있습니다.
    const 범위밖 = { ...goodResponse(), confidence: 1.5 };
    const { provider, banned } = fakeProvider([범위밖]);
    const extractor = new DealExtractor({ provider, log: () => {} });

    await extractor.extract(item(), NOW);
    expect(banned).toEqual([]);

    await extractor.extract(item(), NOW);
    expect(banned).toEqual(['bad/model:free']);
  });
});

describe('한자는 노출되는 모든 필드에서 잡는다', () => {
  /*
    제목과 요약만 보다가 일곱 건을 놓쳤습니다. 배포된 사이트의 CTA 버튼에
    "原帖链接" 이 그대로 떠 있었습니다. 노출되는 곳을 하나라도 빠뜨리면
    정확히 그 자리로 새어나갑니다.
  */
  const 노출필드 = [
    ['linkLabel', '原帖链接'],
    ['description', '할인率为 26.5%'],
    ['brandName', '清洁나라'],
  ] as const;

  for (const [field, bad] of 노출필드) {
    it(`${field} 에 한자가 있으면 잡는다`, async () => {
      const { provider, banned } = fakeProvider([{ ...goodResponse(), [field]: bad }]);
      const extractor = new DealExtractor({ provider, log: () => {} });

      const outcome = await extractor.extract(item(), NOW);

      expect(outcome.ok).toBe(false);
      expect(banned).toEqual(['bad/model:free']);
    });
  }

  it('배열 필드(tags·caution·howTo)도 본다', async () => {
    for (const field of ['tags', 'caution', 'howTo'] as const) {
      const { provider } = fakeProvider([{ ...goodResponse(), [field]: ['정상', '大米'] }]);
      const extractor = new DealExtractor({ provider, log: () => {} });

      const outcome = await extractor.extract(item(), NOW);
      expect(outcome.ok, `${field} 를 놓쳤습니다`).toBe(false);
    }
  });

  it('한국어만 있으면 통과한다', async () => {
    const { provider } = fakeProvider([
      {
        ...goodResponse(),
        linkLabel: '원문 보기',
        description: '9월 30일까지',
        tags: ['스타벅스', '무료'],
        caution: ['1인 1회'],
        howTo: ['앱 설치'],
      },
    ]);
    const extractor = new DealExtractor({ provider, log: () => {} });

    await expect(extractor.extract(item(), NOW)).resolves.toMatchObject({ ok: true });
  });
});
