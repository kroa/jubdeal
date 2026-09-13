import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GeminiProvider,
  looksLikeSchemaRejection,
  parseGeminiModels,
  rankGeminiModel,
  toGeminiSchema,
} from '@pipeline/extract/providers/gemini';
import { createProvider } from '@pipeline/extract/providers/index';
import type { LlmRequest } from '@pipeline/extract/providers/types';

const REQUEST: LlmRequest = {
  system: '너는 추출기다.',
  user: '본문',
  jsonSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: 120 },
      price: { anyOf: [{ type: 'integer', exclusiveMinimum: 0 }, { type: 'null' }] },
    },
    required: ['title', 'price'],
    additionalProperties: false,
  },
  schemaName: 'probe',
};

const SAVED = { ...process.env };

beforeEach(() => {
  for (const key of ['GEMINI_API_KEY', 'GEMINI_MODELS', 'GEMINI_BASE_URL', 'LLM_PROVIDER']) {
    delete process.env[key];
  }
});

afterEach(() => {
  process.env = { ...SAVED };
});

function geminiOk(content: unknown) {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          finishReason: 'STOP',
          content: { parts: [{ text: JSON.stringify(content) }] },
        },
      ],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30 },
    }),
    { status: 200 },
  );
}

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

/** 모델 목록 조회(GET)를 빼고 실제 생성 호출만 */
function genCalls(calls: Array<{ url: string; body: Record<string, unknown> | null }>) {
  return calls.filter((call) => call.url.includes(':generateContent'));
}

/* -------------------------------------------------------------------------- */
/* 스키마 변환                                                                  */
/* -------------------------------------------------------------------------- */

describe('toGeminiSchema', () => {
  it('Gemini 가 모르는 키워드를 걷어낸다', () => {
    // 그대로 보내면 400 이 납니다.
    const converted = toGeminiSchema(REQUEST.jsonSchema) as Record<string, unknown>;

    expect(converted).not.toHaveProperty('additionalProperties');
    const properties = converted.properties as Record<string, Record<string, unknown>>;
    expect(properties.title).not.toHaveProperty('maxLength');
  });

  it('anyOf 로 표현된 null 을 nullable 로 바꾼다', () => {
    const converted = toGeminiSchema(REQUEST.jsonSchema) as Record<string, unknown>;
    const properties = converted.properties as Record<string, Record<string, unknown>>;

    expect(properties.price).toMatchObject({ type: 'integer', nullable: true });
    expect(properties.price).not.toHaveProperty('anyOf');
  });

  it('$schema 를 제거한다', () => {
    const converted = toGeminiSchema({ $schema: 'https://x', type: 'object' }) as Record<
      string,
      unknown
    >;
    expect(converted).not.toHaveProperty('$schema');
  });

  it('설명은 유지한다', () => {
    const converted = toGeminiSchema({
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: '설명',
    }) as Record<string, unknown>;

    expect(converted.description).toBe('설명');
    expect(converted.nullable).toBe(true);
  });

  it('중첩 객체와 배열도 변환한다', () => {
    const converted = toGeminiSchema({
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: { a: { type: 'string' } },
          additionalProperties: false,
        },
        list: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      },
    }) as Record<string, unknown>;

    const properties = converted.properties as Record<string, Record<string, unknown>>;
    expect(properties.nested).not.toHaveProperty('additionalProperties');
    expect(properties.list).not.toHaveProperty('maxItems');
    expect((properties.list as { items: unknown }).items).toEqual({ type: 'string' });
  });

  it('enum 과 required 는 그대로 둔다', () => {
    const converted = toGeminiSchema({
      type: 'object',
      properties: { kind: { type: 'string', enum: ['a', 'b'] } },
      required: ['kind'],
    }) as Record<string, unknown>;

    expect(converted.required).toEqual(['kind']);
    const properties = converted.properties as Record<string, Record<string, unknown>>;
    expect(properties.kind?.enum).toEqual(['a', 'b']);
  });
});

describe('parseGeminiModels', () => {
  it('쉼표로 나누고 models/ 접두사를 벗긴다', () => {
    expect(parseGeminiModels('models/gemini-2.5-flash, gemini-2.5-flash-lite')).toEqual([
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ]);
  });

  it('빈 값은 빈 배열', () => {
    expect(parseGeminiModels('')).toEqual([]);
    expect(parseGeminiModels(undefined)).toEqual([]);
  });
});

describe('rankGeminiModel', () => {
  it('flash 를 pro 보다 앞에 둔다', () => {
    expect(rankGeminiModel('gemini-2.5-flash')).toBeLessThan(rankGeminiModel('gemini-2.5-pro'));
  });

  it('실험·프리뷰 채널은 뒤로 미룬다', () => {
    expect(rankGeminiModel('gemini-2.5-flash')).toBeLessThan(
      rankGeminiModel('gemini-2.5-flash-preview'),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 호출                                                                        */
/* -------------------------------------------------------------------------- */

describe('GeminiProvider', () => {
  it('키가 없으면 설정 안 됨으로 본다', async () => {
    const provider = new GeminiProvider({ apiKey: '' });

    expect(await provider.isConfigured()).toBe(false);
    await expect(provider.complete(REQUEST)).rejects.toMatchObject({ reason: 'not_configured' });
  });

  it('구조화 출력을 요청하고 결과를 파싱한다', async () => {
    const { impl, calls } = makeFetch(() => geminiOk({ title: '무료 커피', price: null }));

    const provider = new GeminiProvider({
      apiKey: 'k',
      models: ['gemini-2.5-flash'],
      fetchImpl: impl,
    });
    const response = await provider.complete(REQUEST);

    expect(response.data).toEqual({ title: '무료 커피', price: null });
    expect(response.provider).toBe('gemini:gemini-2.5-flash');

    const config = genCalls(calls)[0]?.body?.generationConfig as Record<string, unknown>;
    expect(config.responseMimeType).toBe('application/json');
    expect(config.responseSchema).toBeDefined();
  });

  it('x-goog-api-key 헤더로 인증한다', async () => {
    let headers: Record<string, string> = {};
    const impl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return geminiOk({ title: 'x', price: null });
    }) as unknown as typeof fetch;

    await new GeminiProvider({ apiKey: 'secret', models: ['m'], fetchImpl: impl }).complete(
      REQUEST,
    );

    expect(headers['x-goog-api-key']).toBe('secret');
  });

  it('시스템 프롬프트를 systemInstruction 으로 보낸다', async () => {
    const { impl, calls } = makeFetch(() => geminiOk({ title: 'x', price: null }));

    await new GeminiProvider({ apiKey: 'k', models: ['m'], fetchImpl: impl }).complete(REQUEST);

    const body = genCalls(calls)[0]?.body as Record<string, unknown>;
    const instruction = body.systemInstruction as { parts: Array<{ text: string }> };
    expect(instruction.parts[0]?.text).toBe(REQUEST.system);
  });

  it('사용량을 보고한다', async () => {
    const { impl } = makeFetch(() => geminiOk({ title: 'x', price: null }));

    const { usage } = await new GeminiProvider({
      apiKey: 'k',
      models: ['m'],
      fetchImpl: impl,
    }).complete(REQUEST);

    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(30);
    // Gemini 는 응답에 비용을 담지 않습니다.
    expect(usage.costUsd).toBeNull();
  });

  it('스키마를 거부하면 프롬프트 방식으로 재시도한다', async () => {
    let attempt = 0;
    const { impl, calls } = makeFetch((_url, body) => {
      attempt += 1;
      const config = body?.generationConfig as Record<string, unknown> | undefined;
      if (config?.responseSchema) {
        return new Response(
          '{"error":{"message":"Invalid JSON payload received. Unknown name \\"responseSchema\\""}}',
          { status: 400 },
        );
      }
      return geminiOk({ title: '재시도 성공', price: 100 });
    });

    const provider = new GeminiProvider({ apiKey: 'k', models: ['m'], fetchImpl: impl });
    const response = await provider.complete(REQUEST);

    expect(attempt).toBe(2);
    expect(response.data).toEqual({ title: '재시도 성공', price: 100 });

    const second = genCalls(calls)[1]?.body?.generationConfig as Record<string, unknown>;
    expect(second.responseSchema).toBeUndefined();
    expect(second.responseMimeType).toBe('application/json');
  });

  it('한 번 거부한 모델은 다음부터 바로 프롬프트 방식으로 부른다', async () => {
    const { impl, calls } = makeFetch((_url, body) => {
      const config = body?.generationConfig as Record<string, unknown> | undefined;
      return config?.responseSchema
        ? new Response('{"error":{"message":"Unknown name responseSchema"}}', { status: 400 })
        : geminiOk({ title: 'x', price: null });
    });

    const provider = new GeminiProvider({ apiKey: 'k', models: ['m'], fetchImpl: impl });
    await provider.complete(REQUEST);
    calls.length = 0;
    await provider.complete(REQUEST);

    expect(genCalls(calls)).toHaveLength(1);
  });

  it('429 가 나면 다음 모델로 넘어간다', async () => {
    const { impl } = makeFetch((url) =>
      genCallModel(url) === 'busy'
        ? new Response('{"error":{"message":"RESOURCE_EXHAUSTED"}}', { status: 429 })
        : geminiOk({ title: 'x', price: null }),
    );

    const provider = new GeminiProvider({ apiKey: 'k', models: ['busy', 'ok'], fetchImpl: impl });

    await expect(provider.complete(REQUEST)).resolves.toMatchObject({
      provider: 'gemini:ok',
    });
  });

  it('붐빈 모델은 영구 배제하지 않는다', async () => {
    // 무료 등급의 429 는 분당 한도인 경우가 많아 다음 실행에서 풀립니다.
    let busy = true;
    const { impl } = makeFetch(() =>
      busy
        ? new Response('{"error":{"message":"RESOURCE_EXHAUSTED"}}', { status: 429 })
        : geminiOk({ title: 'x', price: null }),
    );

    const provider = new GeminiProvider({ apiKey: 'k', models: ['only'], fetchImpl: impl });
    await expect(provider.complete(REQUEST)).rejects.toThrow();

    busy = false;
    await expect(provider.complete(REQUEST)).resolves.toMatchObject({ provider: 'gemini:only' });
  });

  it('인증 실패는 즉시 포기한다', async () => {
    const { impl, calls } = makeFetch(() => new Response('unauthorized', { status: 401 }));

    const provider = new GeminiProvider({
      apiKey: 'bad',
      models: ['a', 'b', 'c'],
      fetchImpl: impl,
    });

    await expect(provider.complete(REQUEST)).rejects.toMatchObject({ reason: 'auth' });
    expect(genCalls(calls)).toHaveLength(1);
  });

  it('안전 필터로 중단되면 실패로 처리한다', async () => {
    // 본문이 비어 오는데 성공으로 처리하면 빈 결과가 흘러갑니다.
    const { impl } = makeFetch(
      () =>
        new Response(JSON.stringify({ candidates: [{ finishReason: 'SAFETY', content: {} }] }), {
          status: 200,
        }),
    );

    await expect(
      new GeminiProvider({ apiKey: 'k', models: ['m'], fetchImpl: impl }).complete(REQUEST),
    ).rejects.toThrow(/SAFETY/);
  });

  it('코드펜스가 섞인 응답도 파싱한다', async () => {
    const { impl } = makeFetch(
      () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: 'STOP',
                content: { parts: [{ text: '```json\n{"title":"x","price":null}\n```' }] },
              },
            ],
          }),
          { status: 200 },
        ),
    );

    const response = await new GeminiProvider({
      apiKey: 'k',
      models: ['m'],
      fetchImpl: impl,
    }).complete(REQUEST);

    expect(response.data).toEqual({ title: 'x', price: null });
  });
});

function genCallModel(url: string): string {
  const match = /models\/([^:]+):generateContent/.exec(url);
  return match?.[1] ?? '';
}

/* -------------------------------------------------------------------------- */
/* 모델 탐색                                                                    */
/* -------------------------------------------------------------------------- */

describe('Gemini 모델 자동 탐색', () => {
  const catalogue = {
    models: [
      { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/imagen-4', supportedGenerationMethods: ['generateContent'] },
    ],
  };

  it('generateContent 를 지원하는 모델만 고른다', async () => {
    const { impl, calls } = makeFetch((url) =>
      url.endsWith('/models')
        ? new Response(JSON.stringify(catalogue))
        : geminiOk({ title: 'x', price: null }),
    );

    await new GeminiProvider({ apiKey: 'k', models: [], fetchImpl: impl }).complete(REQUEST);

    const used = genCallModel(genCalls(calls)[0]?.url ?? '');
    expect(used).not.toContain('embedding');
    expect(used).not.toContain('imagen');
  });

  it('flash 계열을 먼저 쓴다', async () => {
    const { impl, calls } = makeFetch((url) =>
      url.endsWith('/models')
        ? new Response(JSON.stringify(catalogue))
        : geminiOk({ title: 'x', price: null }),
    );

    await new GeminiProvider({ apiKey: 'k', models: [], fetchImpl: impl }).complete(REQUEST);

    expect(genCallModel(genCalls(calls)[0]?.url ?? '')).toBe('gemini-2.5-flash');
  });

  it('탐색은 한 번만 한다', async () => {
    const { impl, calls } = makeFetch((url) =>
      url.endsWith('/models')
        ? new Response(JSON.stringify(catalogue))
        : geminiOk({ title: 'x', price: null }),
    );

    const provider = new GeminiProvider({ apiKey: 'k', models: [], fetchImpl: impl });
    await provider.complete(REQUEST);
    await provider.complete(REQUEST);

    expect(calls.filter((c) => c.url.endsWith('/models'))).toHaveLength(1);
  });

  it('환경변수에서 목록을 읽는다', async () => {
    process.env.GEMINI_API_KEY = 'k';
    process.env.GEMINI_MODELS = 'env-model';

    const { impl, calls } = makeFetch(() => geminiOk({ title: 'x', price: null }));
    await new GeminiProvider({ fetchImpl: impl }).complete(REQUEST);

    expect(genCallModel(genCalls(calls)[0]?.url ?? '')).toBe('env-model');
  });
});

describe('looksLikeSchemaRejection', () => {
  it('스키마 거부 메시지를 잡아낸다', () => {
    expect(looksLikeSchemaRejection('Unknown name "responseSchema"')).toBe(true);
    expect(looksLikeSchemaRejection('Invalid JSON payload received')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 프로바이더 체인 순서                                                          */
/* -------------------------------------------------------------------------- */

describe('createProvider — gemini 포함', () => {
  it('LLM_PROVIDER=gemini 로 Gemini 만 쓸 수 있다', () => {
    process.env.LLM_PROVIDER = 'gemini';
    expect(createProvider().name).toBe('gemini');
  });

  it('기본 체인은 claude-cli → gemini → openrouter 순이다', () => {
    const chain = createProvider() as unknown as { providers: Array<{ name: string }> };
    expect(chain.providers.map((p) => p.name)).toEqual(['claude-cli', 'gemini', 'openrouter']);
  });
});

describe('붐빔 쿨다운', () => {
  /*
    붐빈 모델을 건너뛰기만 하고 쿨다운을 걸지 않아, **항목마다** 같은 모델을
    다시 두들기고 있었습니다. 실측 로그에서 gemini-3.8-flash 와 3.7-flash 가
    종일 붐비는데도 매번 앞에서부터 재시도해 건당 몇 초씩 버렸습니다.
  */
  function geminiBusy() {
    return new Response(
      JSON.stringify({
        error: { code: 503, message: 'This model is currently experiencing high demand.' },
      }),
      { status: 503 },
    );
  }

  /** 호출 URL 에서 모델 이름만 뽑습니다. Gemini 는 모델이 경로에 있습니다. */
  function modelsFrom(calls: Array<{ url: string }>): string[] {
    return calls
      .map((call) => /\/models\/([^:]+):generateContent/.exec(call.url)?.[1])
      .filter((model): model is string => Boolean(model));
  }

  it('붐빈 모델은 다음 항목에서 건너뛴다', async () => {
    let goodCalls = 0;
    const { impl, calls } = makeFetch((url) => {
      if (!url.includes('/models/good')) return geminiBusy();
      goodCalls += 1;
      // 첫 항목만 성공시켜 두 번째 항목에서 목록을 다시 훑게 만듭니다.
      return goodCalls === 1 ? geminiOk({ title: 'x', price: 1 }) : geminiBusy();
    });

    const provider = new GeminiProvider({
      apiKey: 'k',
      models: ['busy-a', 'busy-b', 'good'],
      fetchImpl: impl,
    });

    await provider.complete(REQUEST);
    expect(modelsFrom(calls)).toEqual(['busy-a', 'busy-b', 'good']);

    calls.length = 0;
    await expect(provider.complete(REQUEST)).rejects.toMatchObject({ reason: 'quota' });

    // 쿨다운이 없으면 busy-a·busy-b 를 또 두들깁니다.
    expect(modelsFrom(calls)).toEqual(['good']);
  });

  it('쿨다운이 지나면 다시 시도한다', async () => {
    vi.useFakeTimers();
    try {
      let goodCalls = 0;
      const { impl, calls } = makeFetch((url) => {
        if (!url.includes('/models/good')) return geminiBusy();
        goodCalls += 1;
        return goodCalls === 1 ? geminiOk({ title: 'x', price: 1 }) : geminiBusy();
      });

      const provider = new GeminiProvider({
        apiKey: 'k',
        models: ['busy-a', 'good'],
        fetchImpl: impl,
      });

      await provider.complete(REQUEST);
      calls.length = 0;

      vi.advanceTimersByTime(21_000);
      await expect(provider.complete(REQUEST)).rejects.toMatchObject({ reason: 'quota' });

      // 20초가 지났으니 busy-a 도 다시 후보가 됩니다.
      expect(modelsFrom(calls)).toContain('busy-a');
    } finally {
      vi.useRealTimers();
    }
  });

  it('한도 초과는 쿨다운이 아니라 영구 배제다', async () => {
    // 붐빔과 달리 한도는 그 실행 안에서 풀리지 않습니다.
    const { impl, calls } = makeFetch((url) =>
      url.includes('/models/over')
        ? new Response(JSON.stringify({ error: { code: 429, message: 'quota exceeded' } }), {
            status: 429,
          })
        : geminiOk({ title: 'x', price: 1 }),
    );

    const provider = new GeminiProvider({
      apiKey: 'k',
      models: ['over', 'good'],
      fetchImpl: impl,
    });

    await provider.complete(REQUEST);
    calls.length = 0;
    await provider.complete(REQUEST);

    expect(modelsFrom(calls)).toEqual(['good']);
  });
});

describe('쿨다운은 대안이 있을 때만 적용한다', () => {
  /*
    쿨다운을 넣자 기존 테스트 셋이 깨졌습니다. 모두 모델이 하나뿐인 구성에서
    "일시 오류 뒤엔 다시 쓸 수 있어야 한다"를 확인하는 것들이었습니다.

    쿨다운의 목적은 붐비는 모델을 건너뛰고 **다른 모델로 가는 것**이지
    시도를 줄이는 게 아닙니다. 대안이 없으면 쉬는 중이라도 쳐야 합니다.
  */
  function busy503() {
    return new Response(JSON.stringify({ error: { message: 'experiencing high demand' } }), {
      status: 503,
    });
  }

  it('모델이 하나뿐이면 쿨다운 중이라도 다시 시도한다', async () => {
    let overloaded = true;
    const { impl } = makeFetch(() => (overloaded ? busy503() : geminiOk({ title: 'x', price: 1 })));

    const provider = new GeminiProvider({ apiKey: 'k', models: ['only'], fetchImpl: impl });

    await expect(provider.complete(REQUEST)).rejects.toThrow();

    overloaded = false;
    await expect(provider.complete(REQUEST)).resolves.toMatchObject({ provider: 'gemini:only' });
  });

  it('모두 쉬는 중이면 그중 하나라도 친다', async () => {
    // 둘 다 붐벼서 쉬는 상태여도, 다음 항목에서 아예 포기하면 안 됩니다.
    let overloaded = true;
    const { impl, calls } = makeFetch(() =>
      overloaded ? busy503() : geminiOk({ title: 'x', price: 1 }),
    );

    const provider = new GeminiProvider({ apiKey: 'k', models: ['a', 'b'], fetchImpl: impl });

    await expect(provider.complete(REQUEST)).rejects.toThrow();

    overloaded = false;
    calls.length = 0;
    await expect(provider.complete(REQUEST)).resolves.toBeTruthy();
    expect(calls.length).toBeGreaterThan(0);
  });
});
