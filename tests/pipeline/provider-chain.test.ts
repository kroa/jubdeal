import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderChain,
  createProvider,
  parseProviderModes,
} from '@pipeline/extract/providers/index';
import { GeminiProvider } from '@pipeline/extract/providers/gemini';
import { OpenRouterProvider } from '@pipeline/extract/providers/openrouter';
import {
  ProviderUnavailableError,
  type LlmProvider,
  type LlmRequest,
} from '@pipeline/extract/providers/types';

/**
 * 프로바이더 체인 구성과 일시 오류 분류
 * ---------------------------------------------------------------------------
 * 실제 키로 돌려 보며 드러난 것들입니다.
 */

const REQUEST: LlmRequest = {
  system: '추출기',
  user: '본문',
  jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
  schemaName: 'probe',
};

const SAVED = { ...process.env };

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (/^(LLM_PROVIDER|GEMINI_|OPENROUTER_|CLAUDE_CLI_)/.test(key)) delete process.env[key];
  }
});

afterEach(() => {
  process.env = { ...SAVED };
});

/* -------------------------------------------------------------------------- */
/* LLM_PROVIDER 해석                                                           */
/* -------------------------------------------------------------------------- */

describe('parseProviderModes', () => {
  it('비어 있거나 auto 면 전체 순서로 편다', () => {
    for (const value of [undefined, '', '  ', 'auto']) {
      expect(parseProviderModes(value)).toEqual(['claude-cli', 'gemini', 'openrouter']);
    }
  });

  it('쉼표로 적은 순서를 그대로 따른다', () => {
    /*
      "gemini 를 쓰고 막히면 openrouter" 를 표현할 방법이 없었습니다.
      auto 는 claude-cli 가 먼저 오고, gemini 단독은 폴백이 없었습니다.
    */
    expect(parseProviderModes('gemini,openrouter')).toEqual(['gemini', 'openrouter']);
    expect(parseProviderModes('openrouter, gemini')).toEqual(['openrouter', 'gemini']);
  });

  it('중복은 한 번만 시도한다', () => {
    expect(parseProviderModes('gemini,openrouter,gemini')).toEqual(['gemini', 'openrouter']);
  });

  it('모르는 이름은 조용히 넘기지 않고 실패시킨다', () => {
    // 오타를 무시하면 의도와 다른 프로바이더가 돌면서 요금이 나갑니다.
    expect(() => parseProviderModes('gemni,openrouter')).toThrow(/gemni/);
    expect(() => parseProviderModes('claude')).toThrow(/알 수 없는/);
  });
});

describe('createProvider', () => {
  it('하나만 지정하면 체인으로 감싸지 않는다', () => {
    // 체인으로 감싸면 폴백이 없다는 뜻이 흐려집니다.
    expect(createProvider({ mode: 'gemini' }).name).toBe('gemini');
    expect(createProvider({ mode: 'openrouter' }).name).toBe('openrouter');
  });

  it('여러 개면 지정한 순서대로 체인을 만든다', () => {
    const chain = createProvider({ mode: 'gemini,openrouter' }) as unknown as {
      name: string;
      providers: Array<{ name: string }>;
    };

    expect(chain.name).toBe('chain');
    expect(chain.providers.map((p) => p.name)).toEqual(['gemini', 'openrouter']);
  });

  it('환경변수에서 읽는다', () => {
    process.env.LLM_PROVIDER = 'gemini,openrouter';

    const chain = createProvider() as unknown as { providers: Array<{ name: string }> };
    expect(chain.providers.map((p) => p.name)).toEqual(['gemini', 'openrouter']);
  });
});

/* -------------------------------------------------------------------------- */
/* Gemini 일시 오류                                                            */
/* -------------------------------------------------------------------------- */

function jsonOk(value: unknown) {
  return new Response(
    JSON.stringify({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }],
    }),
    { status: 200 },
  );
}

function modelOf(url: string): string {
  return /models\/([^:]+):generateContent/.exec(url)?.[1] ?? '';
}

describe('Gemini 일시 오류', () => {
  it('503 은 붐빔으로 보고 그 모델을 영구 배제하지 않는다', async () => {
    /*
      최신 모델은 503 "This model is currently experiencing high demand" 를
      자주 돌려줍니다 (gemini-3.7-flash 에서 실제로 관측).
      영구 배제하면 잠시 뒤면 쓸 수 있는 모델을 그 실행 내내 못 씁니다.
    */
    let overloaded = true;
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/models')) return new Response('{"models":[]}');
      return overloaded
        ? new Response('{"error":{"message":"experiencing high demand"}}', { status: 503 })
        : jsonOk({ ok: true });
    }) as unknown as typeof fetch;

    const provider = new GeminiProvider({ apiKey: 'k', models: ['m'], fetchImpl: impl });
    await expect(provider.complete(REQUEST)).rejects.toThrow();

    overloaded = false;
    await expect(provider.complete(REQUEST)).resolves.toMatchObject({ provider: 'gemini:m' });
  });

  it('연결이 끊겨도 그 모델을 영구 배제하지 않는다', async () => {
    // ECONNRESET 은 대개 일시적입니다. 한 번 튄 것으로 모델을 버리면 안 됩니다.
    let broken = true;
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/models')) return new Response('{"models":[]}');
      if (broken) throw new TypeError('fetch failed');
      return jsonOk({ ok: true });
    }) as unknown as typeof fetch;

    const provider = new GeminiProvider({ apiKey: 'k', models: ['m'], fetchImpl: impl });
    await expect(provider.complete(REQUEST)).rejects.toThrow();

    broken = false;
    await expect(provider.complete(REQUEST)).resolves.toMatchObject({ provider: 'gemini:m' });
  });

  it('503 이면 다음 모델로 넘어간다', async () => {
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/models')) return new Response('{"models":[]}');
      return modelOf(url) === 'busy'
        ? new Response('{"error":{"message":"high demand"}}', { status: 503 })
        : jsonOk({ ok: true });
    }) as unknown as typeof fetch;

    const provider = new GeminiProvider({ apiKey: 'k', models: ['busy', 'ok'], fetchImpl: impl });
    await expect(provider.complete(REQUEST)).resolves.toMatchObject({ provider: 'gemini:ok' });
  });
});

/* -------------------------------------------------------------------------- */
/* OpenRouter — 설정 모델이 전부 막혔을 때                                      */
/* -------------------------------------------------------------------------- */

describe('OpenRouter 모델 선택', () => {
  const catalogue = {
    data: [
      {
        id: 'busy/one:free',
        pricing: { prompt: '0', completion: '0' },
        context_length: 32000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        supported_parameters: ['structured_outputs'],
      },
      {
        id: 'alive/two:free',
        pricing: { prompt: '0', completion: '0' },
        context_length: 32000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        supported_parameters: ['structured_outputs'],
      },
    ],
  };

  it('설정한 모델이 전부 붐비면 탐색한 무료 모델로 넘어간다', async () => {
    /*
      무료 공용 풀은 특정 모델이 며칠씩 붐빕니다.
      목록에 없다는 이유로 통째로 실패하면, 쓸 수 있는 모델이 남아 있는데도
      수집이 0건으로 끝납니다. 설정 목록은 "선호"이지 상한이 아닙니다.
    */
    const tried: string[] = [];
    const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/models')) return new Response(JSON.stringify(catalogue));

      const body = JSON.parse(String(init?.body)) as { model: string };
      tried.push(body.model);

      return body.model === 'busy/one:free'
        ? new Response('{"error":{"message":"rate limited"}}', { status: 429 })
        : new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"ok":true}' } }],
              usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 },
            }),
          );
    }) as unknown as typeof fetch;

    const provider = new OpenRouterProvider({
      apiKey: 'k',
      freeModels: ['busy/one:free'],
      fetchImpl: impl,
    });

    const out = await provider.complete(REQUEST);

    expect(tried[0]).toBe('busy/one:free');
    expect(out.provider).toContain('alive/two:free');
  });
});

describe('쿨다운 — 한도는 기다리면 풀린다', () => {
  /*
    한 번 막힌 프로바이더를 실행 내내 배제했더니, 실측에서 107건을 수집하고
    5건만 추출했습니다. Gemini 가 분당 한도로 빠진 뒤 8초 만에 회복됐는데도
    남은 100건을 전부 api_error 로 버렸습니다.
  */
  const REQUEST = { system: 's', user: 'u' } as unknown as LlmRequest;

  function stub(name: string, behavior: () => Promise<unknown>): LlmProvider {
    return {
      name,
      isConfigured: async () => true,
      complete: behavior as LlmProvider['complete'],
    } as LlmProvider;
  }

  /** 가짜 시계 — 대기 요청이 오면 그만큼 시각을 앞당깁니다. */
  function fakeClock() {
    let t = 1_000;
    const waits: number[] = [];
    return {
      waits,
      now: () => t,
      sleep: async (ms: number) => {
        waits.push(ms);
        t += ms;
      },
    };
  }

  it('한도로 막혀도 쿨다운 뒤 같은 프로바이더를 다시 쓴다', async () => {
    const clock = fakeClock();
    let calls = 0;
    const gemini = stub('gemini', async () => {
      calls += 1;
      if (calls === 1) throw new ProviderUnavailableError('gemini', 'quota', '분당 한도');
      return { text: '{}', usage: null };
    });

    const chain = new ProviderChain([gemini], () => {}, clock.now, clock.sleep);

    await expect(chain.complete(REQUEST)).resolves.toMatchObject({ text: '{}' });
    expect(calls).toBe(2);
    expect(clock.waits).toEqual([60_000]);
  });

  it('인증 실패는 기다려도 안 고쳐지니 곧바로 포기한다', async () => {
    const clock = fakeClock();
    let calls = 0;
    const openrouter = stub('openrouter', async () => {
      calls += 1;
      throw new ProviderUnavailableError('openrouter', 'auth', '인증 실패 (403)');
    });

    const chain = new ProviderChain([openrouter], () => {}, clock.now, clock.sleep);

    await expect(chain.complete(REQUEST)).rejects.toThrow('사용 가능한 프로바이더가 없습니다');
    expect(calls).toBe(1);
    expect(clock.waits).toEqual([]);
  });

  it('영구 배제와 한도가 섞이면 한도 쪽만 기다린다', async () => {
    const clock = fakeClock();
    let geminiCalls = 0;
    const openrouter = stub('openrouter', async () => {
      throw new ProviderUnavailableError('openrouter', 'auth', '인증 실패');
    });
    const gemini = stub('gemini', async () => {
      geminiCalls += 1;
      if (geminiCalls === 1) throw new ProviderUnavailableError('gemini', 'busy', '503');
      return { text: 'ok', usage: null };
    });

    const chain = new ProviderChain([openrouter, gemini], () => {}, clock.now, clock.sleep);

    await expect(chain.complete(REQUEST)).resolves.toMatchObject({ text: 'ok' });
    // busy 는 20초, auth 는 영구. 20초만 기다려야 합니다.
    expect(clock.waits).toEqual([20_000]);
  });

  it('끝없이 기다리지는 않는다', async () => {
    const clock = fakeClock();
    const gemini = stub('gemini', async () => {
      throw new ProviderUnavailableError('gemini', 'quota', '한도');
    });

    const chain = new ProviderChain([gemini], () => {}, clock.now, clock.sleep);

    await expect(chain.complete(REQUEST)).rejects.toThrow('사용 가능한 프로바이더가 없습니다');
    expect(clock.waits.length).toBeLessThanOrEqual(2);
  });

  it('쿨다운이 끝난 프로바이더는 보고에서 빠진다', async () => {
    const clock = fakeClock();
    const gemini = stub('gemini', async () => {
      throw new ProviderUnavailableError('gemini', 'quota', '한도');
    });
    const chain = new ProviderChain([gemini], () => {}, clock.now, clock.sleep);

    await expect(chain.complete(REQUEST)).rejects.toThrow();
    expect(chain.disabledProviders).toEqual(['gemini']);

    await clock.sleep(61_000);
    expect(chain.disabledProviders).toEqual([]);
  });
});
