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

    expect(calls.map((c) => c.body?.model)).toEqual(['a:free', 'b:free']);
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

    expect(calls.filter((c) => c.body?.model === 'a:free')).toHaveLength(1);
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

    expect(calls[0]?.body?.model).toBe('b:free');
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

    expect(calls.map((c) => c.body?.model)).toEqual(['free1:free', 'free2:free', 'backup:free']);
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
    expect(calls).toHaveLength(1);
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
    expect(String(calls.find((c) => c.body?.model)?.body?.model)).toContain(':free');
  });

  it('구조화 출력을 지원하는 모델을 먼저 쓴다', async () => {
    // 스키마를 강제할 수 있는 모델이 훨씬 안정적입니다.
    // 컨텍스트가 더 큰 미지원 모델보다 우선해야 합니다.
    const { impl, calls } = makeFetch((url) =>
      url.endsWith('/models') ? new Response(JSON.stringify(catalogue)) : chatOk({ value: 1 }),
    );

    const provider = new OpenRouterProvider({ apiKey: 'k', freeModels: [], fetchImpl: impl });
    await provider.complete(REQUEST);

    expect(calls.find((c) => c.body?.model)?.body?.model).toBe('struct/free:free');
  });

  it('유료 모델은 탐색 결과에 넣지 않는다', async () => {
    const { impl, calls } = makeFetch((url) =>
      url.endsWith('/models')
        ? new Response(JSON.stringify(catalogue))
        : new Response('rate limited', { status: 429 }),
    );

    const provider = new OpenRouterProvider({ apiKey: 'k', freeModels: [], fetchImpl: impl });
    await expect(provider.complete(REQUEST)).rejects.toThrow();

    const tried = calls.filter((c) => c.body?.model).map((c) => String(c.body?.model));
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

    const tried = calls.filter((c) => c.body?.model).map((c) => String(c.body?.model));
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

    expect(calls[0]?.body?.model).toBe('env-a:free');
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

    expect(calls[0]?.body?.response_format).toBeDefined();
  });

  it('거부하면 프롬프트 방식으로 같은 모델을 재시도한다', async () => {
    let attempt = 0;
    const { impl, calls } = makeFetch((_url, body) => {
      attempt += 1;
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
    expect(calls[1]?.body?.model).toBe('nostruct:free');
    expect(calls[1]?.body?.response_format).toBeUndefined();
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

    const messages = calls[1]?.body?.messages as Array<{ role: string; content: string }>;
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
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body?.response_format).toBeUndefined();
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
