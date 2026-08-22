import { describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { DealExtractor, describeApiError } from '@pipeline/extract/extract';
import {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionUserMessage,
  toReferenceDate,
} from '@pipeline/extract/prompt';
import { extractedDealSchema } from '@pipeline/extract/schema';
import type { ExtractedDeal } from '@pipeline/extract/schema';
import type { RawItem } from '@pipeline/types';

const NOW = new Date('2026-08-23T12:00:00+09:00');

const RAW: RawItem = {
  sourceId: 'demo',
  sourceName: '데모 소스',
  url: 'https://example.com/a',
  title: '무료 커피',
  text: '아메리카노 무료 쿠폰을 드립니다. 9월 1일부터 9월 30일까지.',
  collectedAt: '2026-08-23T03:00:00.000Z',
};

function makeParsed(overrides: Partial<ExtractedDeal> = {}): ExtractedDeal {
  return {
    isDeal: true,
    confidence: 0.9,
    notes: '',
    title: '아메리카노 무료 쿠폰',
    summary: '앱 가입 시 1잔 무료',
    description: '',
    brandName: '온더카페',
    category: 'cafe',
    dealType: 'free',
    difficulty: 'easy',
    originalPrice: 4500,
    finalPrice: 0,
    firstComeFirstServed: false,
    quantity: null,
    perPersonLimit: 1,
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    endDateKind: 'dated' as const,
    linkUrl: null,
    linkLabel: null,
    howTo: [],
    caution: [],
    tags: ['무료'],
    ...overrides,
  };
}

/** messages.parse 만 흉내내는 최소 클라이언트 목 */
function makeClient(response: unknown) {
  const parse = vi.fn().mockResolvedValue(response);
  return { client: { messages: { parse } } as unknown as Anthropic, parse };
}

function makeResponse(parsedOutput: unknown, overrides: Record<string, unknown> = {}) {
  return {
    stop_reason: 'end_turn',
    parsed_output: parsedOutput,
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 800,
    },
    ...overrides,
  };
}

describe('DealExtractor — 성공 경로', () => {
  it('스키마를 통과한 결과를 돌려준다', async () => {
    const { client } = makeClient(makeResponse(makeParsed()));
    const extractor = new DealExtractor({ client });

    const outcome = await extractor.extract(RAW, NOW);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.title).toBe('아메리카노 무료 쿠폰');
  });

  it('토큰 사용량을 보고한다', async () => {
    const { client } = makeClient(makeResponse(makeParsed()));
    const outcome = await new DealExtractor({ client }).extract(RAW, NOW);

    expect(outcome.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 800,
    });
  });

  it('시스템 프롬프트를 캐시 대상으로 표시한다', async () => {
    // 캐시가 안 걸리면 페이지마다 시스템 프롬프트 비용을 전액 냅니다.
    const { client, parse } = makeClient(makeResponse(makeParsed()));
    await new DealExtractor({ client }).extract(RAW, NOW);

    const request = parse.mock.calls[0]?.[0];
    expect(request.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(request.system[0].text).toBe(EXTRACTION_SYSTEM_PROMPT);
  });

  it('기본 모델로 claude-opus-5 를 쓴다', async () => {
    const { client, parse } = makeClient(makeResponse(makeParsed()));
    await new DealExtractor({ client }).extract(RAW, NOW);

    expect(parse.mock.calls[0]?.[0].model).toBe('claude-opus-5');
  });

  it('adaptive thinking 을 켠다', async () => {
    const { client, parse } = makeClient(makeResponse(makeParsed()));
    await new DealExtractor({ client }).extract(RAW, NOW);

    expect(parse.mock.calls[0]?.[0].thinking).toEqual({ type: 'adaptive' });
  });
});

describe('DealExtractor — 거절 경로', () => {
  it('혜택이 아니면 not_a_deal 로 거절한다', async () => {
    const { client } = makeClient(
      makeResponse(makeParsed({ isDeal: false, notes: '실적 발표 공시입니다.' })),
    );

    const outcome = await new DealExtractor({ client }).extract(RAW, NOW);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('not_a_deal');
  });

  it('신뢰도가 임계값 미만이면 검수로 넘긴다', async () => {
    const { client } = makeClient(
      makeResponse(makeParsed({ confidence: 0.4, notes: '종료일이 불명확' })),
    );

    const outcome = await new DealExtractor({ client, confidenceThreshold: 0.75 }).extract(
      RAW,
      NOW,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('low_confidence');
    expect(outcome.detail).toContain('종료일이 불명확');
    // 검수자가 볼 수 있도록 후보를 남겨야 합니다.
    expect(outcome.candidate).toBeDefined();
  });

  it('임계값을 낮추면 통과시킬 수 있다', async () => {
    const { client } = makeClient(makeResponse(makeParsed({ confidence: 0.4 })));
    const outcome = await new DealExtractor({ client, confidenceThreshold: 0.3 }).extract(RAW, NOW);

    expect(outcome.ok).toBe(true);
  });

  it('parsed_output 이 없으면 schema_invalid', async () => {
    const { client } = makeClient(makeResponse(null));
    const outcome = await new DealExtractor({ client }).extract(RAW, NOW);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('schema_invalid');
  });

  it('모델이 거절하면(content 를 읽기 전에) api_error 로 처리한다', async () => {
    const { client } = makeClient(
      makeResponse(null, {
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber' },
      }),
    );

    const outcome = await new DealExtractor({ client }).extract(RAW, NOW);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('api_error');
    expect(outcome.detail).toContain('cyber');
  });

  it('API 호출이 실패해도 예외를 던지지 않고 결과로 돌려준다', async () => {
    const parse = vi.fn().mockRejectedValue(new Error('network down'));
    const client = { messages: { parse } } as unknown as Anthropic;

    const outcome = await new DealExtractor({ client }).extract(RAW, NOW);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('api_error');
    expect(outcome.detail).toContain('network down');
  });
});

describe('추출 프롬프트', () => {
  it('시스템 프롬프트에 가변 값이 없다 (캐시 안정성)', () => {
    // 날짜나 UUID 가 섞이면 캐시가 매번 무효화됩니다.
    expect(EXTRACTION_SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(EXTRACTION_SYSTEM_PROMPT).toBe(EXTRACTION_SYSTEM_PROMPT);
  });

  it('시스템 프롬프트가 캐시 최소 길이를 넘긴다', () => {
    // 1024 토큰 미만이면 캐시가 조용히 걸리지 않습니다. 한글은 대략 1자↔1토큰 이상.
    expect(EXTRACTION_SYSTEM_PROMPT.length).toBeGreaterThan(1200);
  });

  it('사용자 메시지에 기준 날짜와 본문이 들어간다', () => {
    const message = buildExtractionUserMessage(RAW, '2026-08-23');

    expect(message).toContain('기준 날짜(KST): 2026-08-23');
    expect(message).toContain(RAW.url);
    expect(message).toContain(RAW.text);
  });

  it('기준 날짜는 KST 기준이다', () => {
    // 2026-08-22T20:00Z = KST 2026-08-23 05:00
    expect(toReferenceDate(new Date('2026-08-22T20:00:00Z'))).toBe('2026-08-23');
  });
});

describe('추출 스키마', () => {
  it('유효한 결과를 통과시킨다', () => {
    expect(extractedDealSchema.safeParse(makeParsed()).success).toBe(true);
  });

  it('신뢰도가 0~1 을 벗어나면 거부한다', () => {
    expect(extractedDealSchema.safeParse(makeParsed({ confidence: 1.5 })).success).toBe(false);
  });

  it('잘못된 날짜 형식을 거부한다', () => {
    expect(extractedDealSchema.safeParse(makeParsed({ endDate: '2026년 9월' })).success).toBe(
      false,
    );
    expect(extractedDealSchema.safeParse(makeParsed({ endDate: '2026-09-30' })).success).toBe(true);
  });

  it('알 수 없는 카테고리를 거부한다', () => {
    const invalid = { ...makeParsed(), category: 'unknown' };
    expect(extractedDealSchema.safeParse(invalid).success).toBe(false);
  });

  it('id 나 slug 를 받지 않는다 (파이프라인이 만드는 값)', () => {
    const shape = Object.keys(extractedDealSchema.shape);
    expect(shape).not.toContain('id');
    expect(shape).not.toContain('slug');
    expect(shape).not.toContain('verified');
  });
});

describe('describeApiError', () => {
  it('인증 오류를 안내 문구로 바꾼다', () => {
    const error = new Anthropic.AuthenticationError(401, {}, 'unauthorized', new Headers());
    expect(describeApiError(error)).toContain('ANTHROPIC_API_KEY');
  });

  it('레이트 리밋을 안내 문구로 바꾼다', () => {
    const error = new Anthropic.RateLimitError(429, {}, 'rate limited', new Headers());
    expect(describeApiError(error)).toContain('한도');
  });

  it('일반 오류는 메시지를 그대로 쓴다', () => {
    expect(describeApiError(new Error('boom'))).toBe('boom');
  });
});
