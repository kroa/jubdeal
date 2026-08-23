import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCliProvider, type CliRun } from '@pipeline/extract/providers/claude-cli';
import { EXTRACTION_JSON_SCHEMA } from '@pipeline/extract/extract';
import { OpenRouterProvider } from '@pipeline/extract/providers/openrouter';
import {
  LlmRequestError,
  ProviderChain,
  ProviderUnavailableError,
  createProvider,
  looksLikeAuthError,
  looksLikeQuotaError,
  type LlmProvider,
  type LlmRequest,
} from '@pipeline/extract/providers/index';

/**
 * 존재하는 실행 파일 경로. runImpl 을 주입하므로 실제로 실행되지는 않지만,
 * 경로 검증을 통과해야 하므로 확실히 존재하는 파일을 씁니다.
 * (테스트가 실수로 진짜 Claude CLI 를 호출해 과금되는 것을 막습니다.)
 */
const FAKE_BINARY = process.execPath;

const REQUEST: LlmRequest = {
  system: '너는 추출기다.',
  user: '본문',
  jsonSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] },
  schemaName: 'probe',
};

/** 환경변수를 건드리는 테스트는 반드시 원복합니다. */
const SAVED = { ...process.env };

beforeEach(() => {
  for (const key of ['LLM_PROVIDER', 'OPENROUTER_API_KEY', 'CLAUDE_CLI_PATH', 'OPENROUTER_MODEL']) {
    delete process.env[key];
  }
});

afterEach(() => {
  process.env = { ...SAVED };
});

/* -------------------------------------------------------------------------- */
/* Claude Code CLI                                                             */
/* -------------------------------------------------------------------------- */

function cliRun(stdout: string, stderr = '', code = 0): CliRun {
  return { stdout, stderr, code };
}

function successJson(result: unknown, cost = 0.004) {
  return JSON.stringify({
    is_error: false,
    subtype: 'success',
    result: JSON.stringify(result),
    total_cost_usd: cost,
    modelUsage: {
      'claude-sonnet-5': {
        inputTokens: 120,
        outputTokens: 40,
        cacheReadInputTokens: 22056,
        cacheCreationInputTokens: 0,
      },
    },
  });
}

describe('ClaudeCliProvider', () => {
  it('구조화 출력을 파싱해 돌려준다', async () => {
    const provider = new ClaudeCliProvider({
      binaryPath: FAKE_BINARY,
      runImpl: async () => cliRun(successJson({ value: 7 })),
    });

    const response = await provider.complete(REQUEST);

    expect(response.data).toEqual({ value: 7 });
    expect(response.provider).toBe('claude-cli');
  });

  it('사용량과 비용을 보고한다', async () => {
    const provider = new ClaudeCliProvider({
      binaryPath: FAKE_BINARY,
      runImpl: async () => cliRun(successJson({ value: 1 }, 0.0043)),
    });

    const { usage } = await provider.complete(REQUEST);

    expect(usage.inputTokens).toBe(120);
    expect(usage.cachedInputTokens).toBe(22056);
    expect(usage.costUsd).toBeCloseTo(0.0043);
  });

  it('도구를 못 쓰게 하고 세션도 남기지 않는다', async () => {
    // 추출은 순수 텍스트 작업이라 도구가 필요 없습니다. 켜 두면 턴과 비용만 낭비합니다.
    let captured: string[] = [];
    const provider = new ClaudeCliProvider({
      binaryPath: FAKE_BINARY,
      runImpl: async (_binary, args) => {
        captured = args;
        return cliRun(successJson({ value: 1 }));
      },
    });

    await provider.complete(REQUEST);

    expect(captured).toContain('-p');
    expect(captured).toContain('--max-turns');
    expect(captured[captured.indexOf('--max-turns') + 1]).toBe('1');
    expect(captured).toContain('--disable-slash-commands');
    expect(captured).toContain('--no-session-persistence');
    expect(captured).toContain('--strict-mcp-config');
  });

  it('시스템 프롬프트를 append 가 아니라 replace 로 넘긴다', async () => {
    // append 면 Claude Code 기본 프롬프트가 그대로 실려 호출당 비용이 몇 배가 됩니다.
    let captured: string[] = [];
    const provider = new ClaudeCliProvider({
      binaryPath: FAKE_BINARY,
      runImpl: async (_binary, args) => {
        captured = args;
        return cliRun(successJson({ value: 1 }));
      },
    });

    await provider.complete(REQUEST);

    expect(captured).toContain('--system-prompt');
    expect(captured).not.toContain('--append-system-prompt');
    expect(captured[captured.indexOf('--system-prompt') + 1]).toBe(REQUEST.system);
  });

  it('호출당 예산 상한을 건다', async () => {
    let captured: string[] = [];
    const provider = new ClaudeCliProvider({
      binaryPath: FAKE_BINARY,
      maxBudgetUsd: 0.25,
      runImpl: async (_binary, args) => {
        captured = args;
        return cliRun(successJson({ value: 1 }));
      },
    });

    await provider.complete(REQUEST);

    expect(captured[captured.indexOf('--max-budget-usd') + 1]).toBe('0.25');
  });

  it('명시한 바이너리 경로가 없으면 폴백 대상 오류를 낸다', async () => {
    // 자동 탐색으로 흘러가면 사용자가 지정한 것과 다른 바이너리가 실행됩니다.
    // (테스트가 실제 CLI 를 호출해 과금되는 사고도 이 동작 때문에 생겼습니다.)
    const spawned = vi.fn();
    const provider = new ClaudeCliProvider({
      binaryPath: '/nonexistent/claude-xyz',
      runImpl: async () => {
        spawned();
        return cliRun('{}');
      },
    });

    await expect(provider.complete(REQUEST)).rejects.toMatchObject({
      name: 'ProviderUnavailableError',
      reason: 'not_configured',
    });
    expect(spawned).not.toHaveBeenCalled();
  });

  it('요금제 한도는 폴백 대상으로 분류한다', async () => {
    const provider = new ClaudeCliProvider({
      binaryPath: FAKE_BINARY,
      runImpl: async () =>
        cliRun(
          JSON.stringify({
            is_error: true,
            subtype: 'error',
            errors: ['You have reached your usage limit. Upgrade your plan to continue.'],
          }),
        ),
    });

    await expect(provider.complete(REQUEST)).rejects.toMatchObject({
      name: 'ProviderUnavailableError',
      reason: 'quota',
    });
  });

  it('인증 실패도 폴백 대상이다', async () => {
    const provider = new ClaudeCliProvider({
      binaryPath: FAKE_BINARY,
      runImpl: async () => cliRun('Invalid API key / not logged in', '', 1),
    });

    await expect(provider.complete(REQUEST)).rejects.toMatchObject({
      name: 'ProviderUnavailableError',
      reason: 'auth',
    });
  });

  it('우리가 건 예산 상한 초과는 폴백하지 않는다', async () => {
    // 이건 프로바이더 문제가 아니라 설정 문제입니다.
    // 폴백하면 같은 작업을 다른 곳에서 또 돌려 비용만 두 배가 됩니다.
    const provider = new ClaudeCliProvider({
      binaryPath: FAKE_BINARY,
      runImpl: async () =>
        cliRun(
          JSON.stringify({
            is_error: true,
            subtype: 'error_max_budget_usd',
            errors: ['Reached maximum budget ($0.1)'],
          }),
        ),
    });

    await expect(provider.complete(REQUEST)).rejects.toBeInstanceOf(LlmRequestError);
  });

  it('응답이 JSON 이 아니면 요청 오류로 본다', async () => {
    const provider = new ClaudeCliProvider({
      binaryPath: FAKE_BINARY,
      runImpl: async () => cliRun(JSON.stringify({ is_error: false, result: '그냥 텍스트' })),
    });

    await expect(provider.complete(REQUEST)).rejects.toBeInstanceOf(LlmRequestError);
  });
});

/* -------------------------------------------------------------------------- */
/* OpenRouter                                                                  */
/* -------------------------------------------------------------------------- */

function openRouterResponse(content: unknown, overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
      usage: { prompt_tokens: 100, completion_tokens: 30, cost: 0.002 },
      ...overrides,
    }),
    { status: 200 },
  );
}

describe('OpenRouterProvider', () => {
  it('키가 없으면 설정 안 됨으로 본다', async () => {
    const provider = new OpenRouterProvider({ apiKey: '' });

    expect(await provider.isConfigured()).toBe(false);
    await expect(provider.complete(REQUEST)).rejects.toMatchObject({ reason: 'not_configured' });
  });

  it('구조화 출력 요청을 보내고 결과를 파싱한다', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return openRouterResponse({ value: 42 });
    }) as unknown as typeof fetch;

    const provider = new OpenRouterProvider({ apiKey: 'sk-or-test', fetchImpl });
    const response = await provider.complete(REQUEST);

    expect(response.data).toEqual({ value: 42 });
    expect(response.provider).toBe('openrouter');

    const format = body.response_format as { type: string; json_schema: { strict: boolean } };
    expect(format.type).toBe('json_schema');
    expect(format.json_schema.strict).toBe(true);
  });

  it('Authorization 헤더에 키를 넣는다', async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return openRouterResponse({ value: 1 });
    }) as unknown as typeof fetch;

    await new OpenRouterProvider({ apiKey: 'sk-or-secret', fetchImpl }).complete(REQUEST);

    expect(headers.Authorization).toBe('Bearer sk-or-secret');
  });

  it('사용량을 보고한다', async () => {
    const fetchImpl = vi.fn(async () =>
      openRouterResponse({ value: 1 }),
    ) as unknown as typeof fetch;
    const { usage } = await new OpenRouterProvider({ apiKey: 'k', fetchImpl }).complete(REQUEST);

    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(30);
    expect(usage.costUsd).toBeCloseTo(0.002);
  });

  it('402/429 는 한도 문제로 분류한다', async () => {
    for (const status of [402, 429]) {
      const fetchImpl = vi.fn(
        async () => new Response('{"error":{"message":"no credits"}}', { status }),
      ) as unknown as typeof fetch;

      await expect(
        new OpenRouterProvider({ apiKey: 'k', fetchImpl }).complete(REQUEST),
      ).rejects.toMatchObject({ reason: 'quota' });
    }
  });

  it('401 은 인증 문제로 분류한다', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('unauthorized', { status: 401 }),
    ) as unknown as typeof fetch;

    await expect(
      new OpenRouterProvider({ apiKey: 'k', fetchImpl }).complete(REQUEST),
    ).rejects.toMatchObject({ reason: 'auth' });
  });

  it('200 으로 온 오류 객체도 잡아낸다', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } })),
    ) as unknown as typeof fetch;

    await expect(
      new OpenRouterProvider({ apiKey: 'k', fetchImpl }).complete(REQUEST),
    ).rejects.toMatchObject({ reason: 'quota' });
  });
});

/* -------------------------------------------------------------------------- */
/* 폴백 체인                                                                    */
/* -------------------------------------------------------------------------- */

function stubProvider(name: string, behavior: () => Promise<unknown>): LlmProvider {
  return {
    name,
    isConfigured: async () => true,
    complete: async () => {
      const data = await behavior();
      return {
        data,
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: null },
        provider: name,
      };
    },
  };
}

describe('ProviderChain', () => {
  it('첫 프로바이더가 되면 두 번째는 부르지 않는다', async () => {
    const second = vi.fn();
    const chain = new ProviderChain([
      stubProvider('first', async () => ({ ok: 1 })),
      stubProvider('second', async () => {
        second();
        return {};
      }),
    ]);

    const response = await chain.complete(REQUEST);

    expect(response.provider).toBe('first');
    expect(second).not.toHaveBeenCalled();
  });

  it('요금제 한도면 다음 프로바이더로 넘어간다', async () => {
    const chain = new ProviderChain([
      stubProvider('claude-cli', async () => {
        throw new ProviderUnavailableError('claude-cli', 'quota', '한도 초과');
      }),
      stubProvider('openrouter', async () => ({ ok: 2 })),
    ]);

    const response = await chain.complete(REQUEST);
    expect(response.provider).toBe('openrouter');
  });

  it('요청 자체의 문제는 폴백하지 않는다', async () => {
    // 스키마 위반은 프로바이더를 바꿔도 똑같이 실패합니다. 비용만 두 배가 됩니다.
    const second = vi.fn();
    const chain = new ProviderChain([
      stubProvider('first', async () => {
        throw new LlmRequestError('first', '스키마 위반');
      }),
      stubProvider('second', async () => {
        second();
        return {};
      }),
    ]);

    await expect(chain.complete(REQUEST)).rejects.toBeInstanceOf(LlmRequestError);
    expect(second).not.toHaveBeenCalled();
  });

  it('한 번 배제된 프로바이더는 다시 시도하지 않는다', async () => {
    const attempts = vi.fn();
    const chain = new ProviderChain([
      stubProvider('flaky', async () => {
        attempts();
        throw new ProviderUnavailableError('flaky', 'quota', '한도');
      }),
      stubProvider('backup', async () => ({ ok: true })),
    ]);

    await chain.complete(REQUEST);
    await chain.complete(REQUEST);

    expect(attempts).toHaveBeenCalledTimes(1);
    expect(chain.disabledProviders).toEqual(['flaky']);
  });

  it('전부 실패하면 이유를 모아 알려준다', async () => {
    const chain = new ProviderChain([
      stubProvider('a', async () => {
        throw new ProviderUnavailableError('a', 'quota', '한도 초과');
      }),
      stubProvider('b', async () => {
        throw new ProviderUnavailableError('b', 'not_configured', '키 없음');
      }),
    ]);

    await expect(chain.complete(REQUEST)).rejects.toThrow(/한도 초과[\s\S]*키 없음/);
  });
});

describe('createProvider', () => {
  it('기본은 claude-cli → openrouter 체인이다', () => {
    expect(createProvider().name).toBe('chain');
  });

  it('LLM_PROVIDER 로 하나만 고를 수 있다', () => {
    process.env.LLM_PROVIDER = 'openrouter';
    expect(createProvider().name).toBe('openrouter');

    process.env.LLM_PROVIDER = 'claude-cli';
    expect(createProvider().name).toBe('claude-cli');
  });

  it('명시 인자가 환경변수보다 우선한다', () => {
    process.env.LLM_PROVIDER = 'openrouter';
    expect(createProvider({ mode: 'claude-cli' }).name).toBe('claude-cli');
  });
});

describe('오류 분류 휴리스틱', () => {
  it('한도 관련 문구를 잡아낸다', () => {
    for (const text of [
      'You have reached your usage limit',
      'rate limit exceeded',
      'Insufficient credits',
      'HTTP 429 Too Many Requests',
      'upgrade your plan',
    ]) {
      expect(looksLikeQuotaError(text)).toBe(true);
    }
  });

  it('인증 관련 문구를 잡아낸다', () => {
    for (const text of ['Unauthorized', 'invalid api key', 'not logged in', '403 Forbidden']) {
      expect(looksLikeAuthError(text)).toBe(true);
    }
  });

  it('일반 오류는 어느 쪽도 아니다', () => {
    expect(looksLikeQuotaError('schema validation failed')).toBe(false);
    expect(looksLikeAuthError('schema validation failed')).toBe(false);
  });
});

describe('추출 JSON Schema', () => {
  it('$schema 키를 포함하지 않는다', () => {
    // Claude Code CLI 의 --json-schema 검증기가 draft-2020-12 메타스키마 참조를
    // 해석하지 못해 "no schema with key or ref" 로 요청 자체를 거부합니다.
    // 목 테스트로는 절대 잡히지 않고, 실제 실행에서만 드러난 결함입니다.
    expect(EXTRACTION_JSON_SCHEMA).not.toHaveProperty('$schema');
  });

  it('구조화 출력에 필요한 형태를 갖춘다', () => {
    expect(EXTRACTION_JSON_SCHEMA.type).toBe('object');
    expect(EXTRACTION_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(Array.isArray(EXTRACTION_JSON_SCHEMA.required)).toBe(true);
  });

  it('모델이 정해서는 안 되는 필드를 포함하지 않는다', () => {
    const properties = EXTRACTION_JSON_SCHEMA.properties as Record<string, unknown>;

    for (const forbidden of ['id', 'slug', 'verified', 'updatedAt', 'collectedAt']) {
      expect(properties).not.toHaveProperty(forbidden);
    }
  });

  it('모델이 판단해야 하는 필드는 포함한다', () => {
    const properties = EXTRACTION_JSON_SCHEMA.properties as Record<string, unknown>;

    for (const required of ['isDeal', 'confidence', 'endDateKind']) {
      expect(properties).toHaveProperty(required);
    }
  });
});
