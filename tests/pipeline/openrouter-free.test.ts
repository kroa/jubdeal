import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OpenRouterProvider,
  isFreeModel,
  isTextOnlyModel,
  jsonOnlyInstruction,
  looksLikeUnsupportedSchema,
  parseJsonLoosely,
  parseModelList,
} from '@pipeline/extract/providers/openrouter';
import {
  findCjkIdeographs,
  modelFromProviderLabel,
  titleGroundingRatio,
} from '@pipeline/extract/extract';
import type { LlmRequest } from '@pipeline/extract/providers/types';

const REQUEST: LlmRequest = {
  system: '너는 추출기다.',
  user: '본문',
  jsonSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] },
  schemaName: 'probe',
};

const SAVED = { ...process.env };

beforeEach(() => {
  for (const key of [
    'OPENROUTER_API_KEY',
    'OPENROUTER_FREE_MODELS',
    'OPENROUTER_FALLBACK_MODELS',
    'OPENROUTER_BASE_URL',
  ]) {
    delete process.env[key];
  }
});

afterEach(() => {
  process.env = { ...SAVED };
});

function chatOk(content: unknown) {
  return new Response(
    JSON.stringify({
      choices: [
        { message: { content: typeof content === 'string' ? content : JSON.stringify(content) } },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200 },
  );
}

/** 경로별로 응답을 정하는 fetch 목. 호출 이력을 남깁니다. */
function makeFetch(handler: (url: string, body: Record<string, unknown> | null) => Response) {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];

  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, body });
    return handler(url, body);
  }) as unknown as typeof fetch;

  return { impl, calls };
}

/** 카탈로그 조회(/models)를 빼고 실제 채팅 호출만 남깁니다. */
function chatCalls(calls: Array<{ url: string; body: Record<string, unknown> | null }>) {
  return calls.filter((call) => call.body?.model !== undefined);
}

function chatModels(calls: Array<{ url: string; body: Record<string, unknown> | null }>) {
  return chatCalls(calls).map((call) => String(call.body?.model));
}

/* -------------------------------------------------------------------------- */
/* 설정 파싱                                                                    */
/* -------------------------------------------------------------------------- */

describe('parseModelList', () => {
  it('쉼표로 나누고 공백을 정리한다', () => {
    expect(parseModelList('a/b:free, c/d:free ,e/f')).toEqual(['a/b:free', 'c/d:free', 'e/f']);
  });

  it('빈 값은 빈 배열', () => {
    expect(parseModelList('')).toEqual([]);
    expect(parseModelList(undefined)).toEqual([]);
    expect(parseModelList(' , , ')).toEqual([]);
  });
});

describe('isFreeModel', () => {
  it(':free 접미사를 무료로 본다', () => {
    expect(isFreeModel({ id: 'z-ai/glm-5.2:free' })).toBe(true);
  });

  it('단가가 0이면 무료로 본다', () => {
    expect(isFreeModel({ id: 'x/y', pricing: { prompt: '0', completion: '0' } })).toBe(true);
  });

  it('유료 모델은 제외한다', () => {
    expect(
      isFreeModel({
        id: 'anthropic/claude',
        pricing: { prompt: '0.000003', completion: '0.000015' },
      }),
    ).toBe(false);
    expect(isFreeModel({ id: 'anthropic/claude' })).toBe(false);
  });
});

describe('isTextOnlyModel', () => {
  it('텍스트만 출력하는 모델을 허용한다', () => {
    expect(
      isTextOnlyModel({
        id: 'z-ai/glm:free',
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      }),
    ).toBe(true);
  });

  it('이미지 입력을 받아도 텍스트만 내면 허용한다', () => {
    expect(
      isTextOnlyModel({
        id: 'vision/model:free',
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      }),
    ).toBe(true);
  });

  it('오디오·이미지를 생성하는 모델은 배제한다', () => {
    // 무료 목록에는 음악 생성 모델이 섞여 있습니다
    // (google/lyria-3-pro-preview 는 출력이 text+audio).
    // 프로모션 본문을 보내면 슬롯만 낭비합니다.
    expect(
      isTextOnlyModel({
        id: 'google/lyria:free',
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['text', 'audio'] },
      }),
    ).toBe(false);
  });

  it('모달리티 정보가 없으면 배제하지 않는다', () => {
    expect(isTextOnlyModel({ id: 'legacy/model:free' })).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 모델 순환                                                                    */
/* -------------------------------------------------------------------------- */

describe('무료 모델 순환', () => {
  it('설정된 순서대로 시도한다', async () => {
    const { impl, calls } = makeFetch((_url, body) =>
      body?.model === 'a:free'
        ? new Response('{"error":{"message":"rate limit exceeded"}}', { status: 429 })
        : chatOk({ value: 1 }),
    );

    const provider = new OpenRouterProvider({
      apiKey: 'k',
      freeModels: ['a:free', 'b:free'],
      fetchImpl: impl,
    });

    const response = await provider.complete(REQUEST);

    expect(chatModels(calls)).toEqual(['a:free', 'b:free']);
    expect(response.provider).toBe('openrouter:b:free');
  });

  it('한 모델이 한도에 걸려도 프로바이더 전체를 포기하지 않는다', async () => {
    // 무료 모델은 레이트 리밋이 빡빡해서, 하나 막혔다고 폴백을 포기하면
    // OpenRouter 를 쓰는 의미가 없어집니다.
    const { impl } = makeFetch((_url, body) =>
      body?.model === 'a:free'
        ? new Response('rate limited', { status: 429 })
        : chatOk({ value: 2 }),
    );

    const provider = new OpenRouterProvider({
      apiKey: 'k',
      freeModels: ['a:free', 'b:free'],
      fetchImpl: impl,
    });

    await expect(provider.complete(REQUEST)).resolves.toMatchObject({ data: { value: 2 } });
  });

  it('한도에 걸린 모델은 이번 실행에서 다시 시도하지 않는다', async () => {
    const { impl, calls } = makeFetch((_url, body) =>
      body?.model === 'a:free'
        ? new Response('rate limited', { status: 429 })
        : chatOk({ value: 1 }),
    );

    const provider = new OpenRouterProvider({
      apiKey: 'k',
      freeModels: ['a:free', 'b:free'],
      fetchImpl: impl,
    });

    await provider.complete(REQUEST);
    await provider.complete(REQUEST);

    expect(chatModels(calls).filter((m) => m === 'a:free')).toHaveLength(1);
  });

  it('마지막에 성공한 모델을 다음 요청에서 먼저 쓴다', async () => {
    const { impl, calls } = makeFetch((_url, body) =>
      body?.model === 'a:free'
        ? new Response('rate limited', { status: 429 })
        : chatOk({ value: 1 }),
    );

    const provider = new OpenRouterProvider({
      apiKey: 'k',
      freeModels: ['a:free', 'b:free', 'c:free'],
      fetchImpl: impl,
    });

    await provider.complete(REQUEST);
    calls.length = 0;
    await provider.complete(REQUEST);

    expect(chatModels(calls)[0]).toBe('b:free');
  });

  it('주 목록이 모두 실패하면 예비 목록으로 넘어간다', async () => {
    const { impl, calls } = makeFetch((_url, body) =>
      String(body?.model).startsWith('free')
        ? new Response('rate limited', { status: 429 })
        : chatOk({ value: 9 }),
    );

    const provider = new OpenRouterProvider({
      apiKey: 'k',
      freeModels: ['free1:free', 'free2:free'],
      fallbackModels: ['backup:free'],
      fetchImpl: impl,
    });

    const response = await provider.complete(REQUEST);

    expect(chatModels(calls)).toEqual(['free1:free', 'free2:free', 'backup:free']);
    expect(response.data).toEqual({ value: 9 });
  });

  it('전부 실패하면 시도한 모델을 모두 알려준다', async () => {
    const { impl } = makeFetch(() => new Response('rate limited', { status: 429 }));

    const provider = new OpenRouterProvider({
      apiKey: 'k',
      freeModels: ['a:free', 'b:free'],
      fetchImpl: impl,
    });

    await expect(provider.complete(REQUEST)).rejects.toThrow(/a:free[\s\S]*b:free/);
  });

  it('인증 실패는 모델을 바꿔도 같으므로 즉시 포기한다', async () => {
    const { impl, calls } = makeFetch(() => new Response('unauthorized', { status: 401 }));

    const provider = new OpenRouterProvider({
      apiKey: 'bad',
      freeModels: ['a:free', 'b:free', 'c:free'],
      fetchImpl: impl,
    });

    await expect(provider.complete(REQUEST)).rejects.toMatchObject({ reason: 'auth' });
    expect(chatCalls(calls)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* 자동 탐색                                                                    */
/* -------------------------------------------------------------------------- */

describe('무료 모델 자동 탐색', () => {
  const catalogue = {
    data: [
      { id: 'paid/model', pricing: { prompt: '0.001', completion: '0.002' } },
      { id: 'small/free:free', context_length: 8000, supported_parameters: [] },
      {
        id: 'big-nostruct/free:free',
        context_length: 1_000_000,
        supported_parameters: ['response_format'],
      },
      {
        id: 'struct/free:free',
        context_length: 200_000,
        supported_parameters: ['structured_outputs'],
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      },
      {
        id: 'music/free:free',
        context_length: 900_000,
        supported_parameters: ['structured_outputs'],
        architecture: { input_modalities: ['text'], output_modalities: ['text', 'audio'] },
      },
    ],
  };

  it('목록이 비면 /models 를 조회해 무료 모델만 고른다', async () => {
    const { impl, calls } = makeFetch((url) =>
      url.endsWith('/models') ? new Response(JSON.stringify(catalogue)) : chatOk({ value: 1 }),
    );

    const provider = new OpenRouterProvider({ apiKey: 'k', freeModels: [], fetchImpl: impl });
    await provider.complete(REQUEST);

    expect(calls[0]?.url).toContain('/models');
    expect(chatModels(calls)[0]).toContain(':free');
  });

  it('구조화 출력을 지원하는 모델을 먼저 쓴다', async () => {
    // 스키마를 강제할 수 있는 모델이 훨씬 안정적입니다.
    // 컨텍스트가 더 큰 미지원 모델보다 우선해야 합니다.
    const { impl, calls } = makeFetch((url) =>
      url.endsWith('/models') ? new Response(JSON.stringify(catalogue)) : chatOk({ value: 1 }),
    );

    const provider = new OpenRouterProvider({ apiKey: 'k', freeModels: [], fetchImpl: impl });
    await provider.complete(REQUEST);

    expect(chatModels(calls)[0]).toBe('struct/free:free');
  });

  it('유료 모델은 탐색 결과에 넣지 않는다', async () => {
    const { impl, calls } = makeFetch((url) =>
      url.endsWith('/models')
        ? new Response(JSON.stringify(catalogue))
        : new Response('rate limited', { status: 429 }),
    );

    const provider = new OpenRouterProvider({ apiKey: 'k', freeModels: [], fetchImpl: impl });
    await expect(provider.complete(REQUEST)).rejects.toThrow();

    const tried = chatModels(calls);
    expect(tried).not.toContain('paid/model');
    expect(tried.every((model) => model.endsWith(':free'))).toBe(true);
  });

  it('음악·이미지 생성 모델은 탐색 결과에서 제외한다', async () => {
    const { impl, calls } = makeFetch((url) =>
      url.endsWith('/models')
        ? new Response(JSON.stringify(catalogue))
        : new Response('rate limited', { status: 429 }),
    );

    const provider = new OpenRouterProvider({ apiKey: 'k', freeModels: [], fetchImpl: impl });
    await expect(provider.complete(REQUEST)).rejects.toThrow();

    const tried = chatModels(calls);
    expect(tried).not.toContain('music/free:free');
  });

  it('탐색은 한 번만 한다', async () => {
    const { impl, calls } = makeFetch((url) =>
      url.endsWith('/models') ? new Response(JSON.stringify(catalogue)) : chatOk({ value: 1 }),
    );

    const provider = new OpenRouterProvider({ apiKey: 'k', freeModels: [], fetchImpl: impl });
    await provider.complete(REQUEST);
    await provider.complete(REQUEST);

    expect(calls.filter((c) => c.url.endsWith('/models'))).toHaveLength(1);
  });

  it('탐색이 실패해도 예비 목록으로 넘어간다', async () => {
    const { impl } = makeFetch((url) =>
      url.endsWith('/models') ? new Response('boom', { status: 500 }) : chatOk({ value: 5 }),
    );

    const provider = new OpenRouterProvider({
      apiKey: 'k',
      freeModels: [],
      fallbackModels: ['backup:free'],
      fetchImpl: impl,
    });

    await expect(provider.complete(REQUEST)).resolves.toMatchObject({ data: { value: 5 } });
  });

  it('환경변수에서 목록을 읽는다', async () => {
    process.env.OPENROUTER_API_KEY = 'k';
    process.env.OPENROUTER_FREE_MODELS = 'env-a:free, env-b:free';

    const { impl, calls } = makeFetch(() => chatOk({ value: 1 }));
    await new OpenRouterProvider({ fetchImpl: impl }).complete(REQUEST);

    expect(chatModels(calls)[0]).toBe('env-a:free');
  });
});

/* -------------------------------------------------------------------------- */
/* 구조화 출력 미지원 모델                                                       */
/* -------------------------------------------------------------------------- */

describe('구조화 출력 미지원 대응', () => {
  it('지원 모델에는 response_format 을 붙인다', async () => {
    const { impl, calls } = makeFetch(() => chatOk({ value: 1 }));

    await new OpenRouterProvider({ apiKey: 'k', freeModels: ['a:free'], fetchImpl: impl }).complete(
      REQUEST,
    );

    expect(chatCalls(calls)[0]?.body?.response_format).toBeDefined();
  });

  it('거부하면 프롬프트 방식으로 같은 모델을 재시도한다', async () => {
    let attempt = 0;
    const { impl, calls } = makeFetch((_url, body) => {
      // 카탈로그 조회(body 없음)는 세지 않습니다.
      if (body) attempt += 1;
      if (body?.response_format) {
        return new Response(
          '{"error":{"message":"Model does not support response_format json_schema"}}',
          { status: 400 },
        );
      }
      return chatOk({ value: 3 });
    });

    const provider = new OpenRouterProvider({
      apiKey: 'k',
      freeModels: ['nostruct:free'],
      fetchImpl: impl,
    });

    const response = await provider.complete(REQUEST);

    expect(attempt).toBe(2);
    expect(chatModels(calls)[1]).toBe('nostruct:free');
    expect(chatCalls(calls)[1]?.body?.response_format).toBeUndefined();
    expect(response.data).toEqual({ value: 3 });
  });

  it('프롬프트 방식에서는 시스템 메시지에 스키마를 넣는다', async () => {
    const { impl, calls } = makeFetch((_url, body) =>
      body?.response_format
        ? new Response('{"error":{"message":"json_schema not supported"}}', { status: 400 })
        : chatOk({ value: 1 }),
    );

    await new OpenRouterProvider({
      apiKey: 'k',
      freeModels: ['nostruct:free'],
      fetchImpl: impl,
    }).complete(REQUEST);

    const messages = chatCalls(calls)[1]?.body?.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages[0]?.content).toContain('JSON Schema');
    expect(messages[0]?.content).toContain('"value"');
  });

  it('한 번 거부한 모델은 다음부터 바로 프롬프트 방식으로 부른다', async () => {
    const { impl, calls } = makeFetch((_url, body) =>
      body?.response_format
        ? new Response('{"error":{"message":"response_format is not supported"}}', { status: 400 })
        : chatOk({ value: 1 }),
    );

    const provider = new OpenRouterProvider({
      apiKey: 'k',
      freeModels: ['nostruct:free'],
      fetchImpl: impl,
    });

    await provider.complete(REQUEST);
    calls.length = 0;
    await provider.complete(REQUEST);

    // 두 번째 요청은 실패 시도 없이 곧바로 프롬프트 방식
    expect(chatCalls(calls)).toHaveLength(1);
    expect(chatCalls(calls)[0]?.body?.response_format).toBeUndefined();
  });
});

describe('looksLikeUnsupportedSchema', () => {
  it('구조화 출력 미지원 메시지를 잡아낸다', () => {
    for (const text of [
      'Model does not support response_format',
      'json_schema is not supported by this model',
      'No endpoints found that support structured outputs',
    ]) {
      expect(looksLikeUnsupportedSchema(text)).toBe(true);
    }
  });

  it('한도 오류를 오인하지 않는다', () => {
    expect(looksLikeUnsupportedSchema('rate limit exceeded')).toBe(false);
    expect(looksLikeUnsupportedSchema('insufficient credits')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 느슨한 JSON 파싱                                                             */
/* -------------------------------------------------------------------------- */

describe('parseJsonLoosely', () => {
  it('순수 JSON 을 읽는다', () => {
    expect(parseJsonLoosely('{"a":1}')).toEqual({ a: 1 });
  });

  it('코드펜스로 감싼 JSON 을 읽는다', () => {
    // 구조화 출력을 못 쓰는 모델이 가장 흔히 하는 형태입니다.
    expect(parseJsonLoosely('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoosely('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('앞뒤 설명이 붙어도 읽는다', () => {
    expect(parseJsonLoosely('결과는 다음과 같습니다:\n{"a":1}\n도움이 되었길 바랍니다.')).toEqual({
      a: 1,
    });
  });

  it('중첩 객체를 온전히 읽는다', () => {
    expect(parseJsonLoosely('설명\n{"a":{"b":[1,2]}}\n끝')).toEqual({ a: { b: [1, 2] } });
  });

  it('JSON 이 없으면 undefined', () => {
    expect(parseJsonLoosely('죄송하지만 도와드릴 수 없습니다.')).toBeUndefined();
    expect(parseJsonLoosely('')).toBeUndefined();
  });

  it('깨진 JSON 은 undefined', () => {
    expect(parseJsonLoosely('{"a": }')).toBeUndefined();
  });
});

describe('jsonOnlyInstruction', () => {
  it('스키마와 형식 지시를 함께 담는다', () => {
    const text = jsonOnlyInstruction({ type: 'object' });

    expect(text).toContain('JSON Schema');
    expect(text).toContain('"type":"object"');
    expect(text).toContain('코드펜스');
  });
});

/* -------------------------------------------------------------------------- */
/* 일시적 붐빔 vs 확정 한도                                                      */
/* -------------------------------------------------------------------------- */

describe('일시적 붐빔 처리', () => {
  it('"잠깐 붐빔" 429 는 같은 모델을 재시도한다', async () => {
    // OpenRouter 무료 모델의 429 는 대개 사용자 한도가 아니라
    // 공용 풀이 일시적으로 붐비는 것입니다(limit_source: upstream_provider_shared_pool).
    // 영구 배제하면 잠시 뒤면 쓸 수 있는 모델을 통째로 버립니다.
    let attempts = 0;
    const { impl } = makeFetch(() => {
      attempts += 1;
      if (attempts < 2) {
        return new Response(
          JSON.stringify({
            error: {
              message: 'Provider returned error',
              metadata: { raw: 'temporarily rate-limited upstream. Please retry shortly' },
            },
          }),
          { status: 429 },
        );
      }
      return chatOk({ value: 7 });
    });

    const provider = new OpenRouterProvider({
      apiKey: 'k',
      freeModels: ['busy:free'],
      fetchImpl: impl,
    });

    await expect(provider.complete(REQUEST)).resolves.toMatchObject({ data: { value: 7 } });
    expect(attempts).toBe(2);
  });

  it('붐빔이 계속되면 다음 모델로 넘어가되 영구 배제하지는 않는다', async () => {
    const { impl, calls } = makeFetch((_url, body) =>
      body?.model === 'busy:free'
        ? new Response('{"error":{"message":"temporarily rate-limited upstream"}}', { status: 429 })
        : chatOk({ value: 1 }),
    );

    const provider = new OpenRouterProvider({
      apiKey: 'k',
      freeModels: ['busy:free', 'ok:free'],
      fetchImpl: impl,
    });

    await provider.complete(REQUEST);

    // 재시도까지 했으므로 여러 번 불립니다 (영구 배제였다면 1회로 끝납니다).
    expect(chatModels(calls).filter((m) => m === 'busy:free').length).toBeGreaterThan(1);
  });

  it('확정 한도(402)는 그 모델을 영구 배제한다', async () => {
    const { impl, calls } = makeFetch((_url, body) =>
      body?.model === 'dead:free'
        ? new Response('{"error":{"message":"insufficient credits"}}', { status: 402 })
        : chatOk({ value: 1 }),
    );

    const provider = new OpenRouterProvider({
      apiKey: 'k',
      freeModels: ['dead:free', 'ok:free'],
      fetchImpl: impl,
    });

    await provider.complete(REQUEST);
    await provider.complete(REQUEST);

    expect(chatModels(calls).filter((m) => m === 'dead:free')).toHaveLength(1);
  });

  it('무료로 제공되지 않는 모델을 명확히 알린다', async () => {
    // 설정에 적힌 모델이 유료로 전환되면, 고치지 않는 한 매 실행마다 같은 자리에서 낭비합니다.
    const logs: string[] = [];
    const { impl } = makeFetch((_url, body) =>
      body?.model === 'gone:free'
        ? new Response(
            '{"error":{"message":"This model is unavailable for free. The paid version is available now","code":404}}',
            { status: 404 },
          )
        : chatOk({ value: 1 }),
    );

    const provider = new OpenRouterProvider({
      apiKey: 'k',
      freeModels: ['gone:free', 'ok:free'],
      fetchImpl: impl,
      log: (message) => logs.push(message),
    });

    await provider.complete(REQUEST);

    expect(logs.some((line) => line.includes('더 이상 무료로 제공되지 않습니다'))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 유료 모델 차단                                                                */
/* -------------------------------------------------------------------------- */

describe('유료 모델 차단', () => {
  const catalogueWithPaid = {
    data: [
      {
        id: 'expensive/model',
        pricing: { prompt: '0.000003', completion: '0.000015' },
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      },
      {
        id: 'ok/model:free',
        pricing: { prompt: '0', completion: '0' },
        supported_parameters: ['structured_outputs'],
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      },
    ],
  };

  it('설정에 유료 모델이 있어도 호출하지 않는다', async () => {
    // 오타 하나로 요금이 나가는 상황을 코드에서 막습니다.
    const { impl, calls } = makeFetch((url) =>
      url.endsWith('/models')
        ? new Response(JSON.stringify(catalogueWithPaid))
        : chatOk({ value: 1 }),
    );

    const provider = new OpenRouterProvider({
      apiKey: 'k',
      freeModels: ['expensive/model', 'ok/model:free'],
      fetchImpl: impl,
    });

    const response = await provider.complete(REQUEST);

    const called = chatModels(calls);
    expect(called).not.toContain('expensive/model');
    expect(response.provider).toBe('openrouter:ok/model:free');
  });

  it('차단 이유를 로그로 알린다', async () => {
    const logs: string[] = [];
    const { impl } = makeFetch((url) =>
      url.endsWith('/models')
        ? new Response(JSON.stringify(catalogueWithPaid))
        : chatOk({ value: 1 }),
    );

    await new OpenRouterProvider({
      apiKey: 'k',
      freeModels: ['expensive/model', 'ok/model:free'],
      fetchImpl: impl,
      log: (message) => logs.push(message),
    }).complete(REQUEST);

    expect(logs.some((line) => line.includes('유료 모델입니다'))).toBe(true);
    expect(logs.some((line) => line.includes('OPENROUTER_ALLOW_PAID'))).toBe(true);
  });

  it('명시적으로 허용하면 유료 모델도 부른다', async () => {
    // 기본은 차단이지만, 사용자가 의도적으로 켤 수 있어야 합니다.
    const { impl, calls } = makeFetch((url) =>
      url.endsWith('/models')
        ? new Response(JSON.stringify(catalogueWithPaid))
        : chatOk({ value: 1 }),
    );

    await new OpenRouterProvider({
      apiKey: 'k',
      freeModels: ['expensive/model'],
      allowPaid: true,
      fetchImpl: impl,
    }).complete(REQUEST);

    expect(chatModels(calls)).toContain('expensive/model');
  });

  it('목록에 없는 모델도 부르지 않는다', async () => {
    const { impl, calls } = makeFetch((url) =>
      url.endsWith('/models')
        ? new Response(JSON.stringify(catalogueWithPaid))
        : chatOk({ value: 1 }),
    );

    const provider = new OpenRouterProvider({
      apiKey: 'k',
      freeModels: ['unknown/model:free', 'ok/model:free'],
      fetchImpl: impl,
    });

    await provider.complete(REQUEST);

    const called = chatModels(calls);
    expect(called).not.toContain('unknown/model:free');
  });

  it('카탈로그를 못 읽으면 :free 모델만 허용한다', async () => {
    // 검증할 방법이 없을 때는 보수적으로 판단합니다.
    const { impl, calls } = makeFetch((url) =>
      url.endsWith('/models') ? new Response('boom', { status: 500 }) : chatOk({ value: 1 }),
    );

    const provider = new OpenRouterProvider({
      apiKey: 'k',
      freeModels: ['maybe-paid/model', 'safe/model:free'],
      fetchImpl: impl,
    });

    const response = await provider.complete(REQUEST);

    const called = chatModels(calls);
    expect(called).not.toContain('maybe-paid/model');
    expect(response.provider).toBe('openrouter:safe/model:free');
  });

  it('예비 목록의 유료 모델도 막는다', async () => {
    const { impl, calls } = makeFetch((url) =>
      url.endsWith('/models')
        ? new Response(JSON.stringify(catalogueWithPaid))
        : new Response('rate limited', { status: 429 }),
    );

    const provider = new OpenRouterProvider({
      apiKey: 'k',
      freeModels: ['ok/model:free'],
      fallbackModels: ['expensive/model'],
      fetchImpl: impl,
    });

    await expect(provider.complete(REQUEST)).rejects.toThrow();

    const called = chatModels(calls);
    expect(called).not.toContain('expensive/model');
  });
});

/* -------------------------------------------------------------------------- */
/* 한국어 결과에 다른 언어가 섞이는 문제                                          */
/* -------------------------------------------------------------------------- */

describe('findCjkIdeographs', () => {
  it('한국어에 섞인 중국어를 잡아낸다', () => {
    // 실제로 관찰된 무료 모델 출력: "아메리카노 톨 사이즈 1잔免费 쿠폰"
    // 스키마도 통과하고 confidence 0.95 라 기존 방어선으로는 안 걸립니다.
    expect(findCjkIdeographs('아메리카노 톨 사이즈 1잔免费 쿠폰')).toEqual(['免', '费']);
  });

  it('정상적인 한국어는 통과시킨다', () => {
    expect(findCjkIdeographs('온더카페 아메리카노 1잔 무료 쿠폰')).toEqual([]);
    expect(findCjkIdeographs('스타벅스 e-Gift 50% 할인 (선착순)')).toEqual([]);
  });

  it('중복 문자는 한 번만 보고한다', () => {
    expect(findCjkIdeographs('免费免费')).toEqual(['免', '费']);
  });

  it('빈 문자열은 빈 배열', () => {
    expect(findCjkIdeographs('')).toEqual([]);
  });
});

describe('제목 근거 검사', () => {
  /*
    문화포털의 전시 안내(645자, "코웨이"라는 말이 한 번도 없음)를 읽히자
    모델이 "코웨이 렌탈료 자동이체 시 포인트 적립"을 내놨습니다.
    스키마도 통과하고 신뢰도 0.95 였습니다.

    링크는 pickLinkUrl 이 원문 대조로 막고 있었지만 제목은 아무도 보지
    않아, 링크가 멀쩡한 채 없는 혜택이 그대로 노출될 수 있었습니다.
  */
  const 문화포털본문 =
    '한눈에 보는 문화정보 전시 갤러리 원 전체연령 [원주 갤러리 원] ' +
    '유미숙 초대개인전 "어울다-소통" 기간 2026-08-25~2026-09-07 (진행중) 가격 무료';

  it('원문에 없는 내용을 지어내면 0 에 가깝다', () => {
    expect(titleGroundingRatio('코웨이 렌탈료 자동이체 시 포인트 적립', 문화포털본문)).toBeLessThan(
      0.3,
    );
  });

  it('원문에서 나온 제목은 높게 나온다', () => {
    expect(
      titleGroundingRatio('[원주 갤러리 원] 유미숙 초대개인전', 문화포털본문),
    ).toBeGreaterThanOrEqual(0.3);
  });

  it('표기 언어가 갈려도 통과한다', () => {
    /*
      브랜드 한 단어만 대조했을 때 실제로 났던 오탐들입니다.
      원문은 "질레트"인데 모델은 "Gillette" 로 적고, 스팀 상품 페이지는
      로고가 이미지라 본문에 "Steam" 이라는 글자가 아예 없습니다.
      제목 전체를 보면 나머지 낱말이 다 걸려 통과합니다.
    */
    const 루리웹 = '[카카오톡]질레트 프로쉴드 면도날8입+핸들+미니젤 (34,110원/무료)';
    expect(
      titleGroundingRatio('Gillette 프로쉴드 면도날 8입 핸들 미니젤 34,110원', 루리웹),
    ).toBeGreaterThanOrEqual(0.3);

    const 스팀 = 'Warhammer 40,000: Space Marine 2 2024년 9월 9일 -75% ₩ 69,800 ₩ 17,450';
    expect(
      titleGroundingRatio('Steam Warhammer 40,000: Space Marine 2 75% 할인', 스팀),
    ).toBeGreaterThanOrEqual(0.3);
  });

  it('상품명이 목록 제목에만 있어도 통과해야 한다', () => {
    // 상세 본문만 대조했더니 딜바다 핫딜이 전멸했습니다.
    // 그쪽은 본문이 84자짜리 한 줄입니다.
    const 제목 = '[지마켓라이브] 1++등급 소고기 구이용 한우 다온 선물 세트 (116,100원/무료)';
    const 본문 = '한가위빅세일 쿠폰 적용 시 최종가 116,100원입니다';
    const 모델제목 = '지마켓라이브 1++등급 한우 다온 선물세트 116,100원';

    expect(titleGroundingRatio(모델제목, 본문)).toBeLessThan(0.3);
    expect(
      titleGroundingRatio(
        모델제목,
        `${제목}
${본문}`,
      ),
    ).toBeGreaterThanOrEqual(0.3);
  });

  it('제목에 쓸 만한 낱말이 없으면 판단하지 않는다', () => {
    expect(titleGroundingRatio('', '아무 내용')).toBe(1);
    expect(titleGroundingRatio('A B', '아무 내용')).toBe(1);
  });
});

describe('한자를 섞는 모델 배제', () => {
  it('프로바이더 라벨에서 모델 이름을 뽑는다', () => {
    /*
      모델 이름 자체에 콜론이 들어갑니다(:free 접미사).
      마지막 콜론에서 자르면 ":free" 만 남아 배제가 빗나갑니다.
    */
    expect(modelFromProviderLabel('openrouter:dots-studio/dots-3-note-preview:free')).toBe(
      'dots-studio/dots-3-note-preview:free',
    );
    expect(modelFromProviderLabel('gemini:gemini-3.7-flash')).toBe('gemini-3.7-flash');
    expect(modelFromProviderLabel('claude-cli')).toBeNull();
    expect(modelFromProviderLabel('openrouter:')).toBeNull();
  });

  it('배제한 모델은 다음 시도에서 빠진다', async () => {
    /*
      한자를 섞는 모델은 호출이 성공하므로 한도·오류 경로로는 안 빠집니다.
      게다가 성공한 모델은 "마지막 성공 모델"로 캐시되어 다음 항목에서도
      다시 뽑힙니다. 실제로 한 소스에서 3건 중 2건이 이렇게 날아갔습니다.
    */
    const { impl, calls } = makeFetch(() => chatOk({ value: 1 }));
    const provider = new OpenRouterProvider({
      apiKey: 'k',
      freeModels: ['bad:free', 'good:free'],
      fetchImpl: impl,
    });

    const first = await provider.complete(REQUEST);
    expect(first.provider).toBe('openrouter:bad:free');

    provider.banModel('bad:free');
    calls.length = 0;

    const second = await provider.complete(REQUEST);
    expect(chatModels(calls)).not.toContain('bad:free');
    expect(second.provider).toBe('openrouter:good:free');
  });
});
