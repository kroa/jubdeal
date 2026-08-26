import { ClaudeCliProvider } from '@pipeline/extract/providers/claude-cli';
import { GeminiProvider } from '@pipeline/extract/providers/gemini';
import { OpenRouterProvider } from '@pipeline/extract/providers/openrouter';
import {
  ProviderUnavailableError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from '@pipeline/extract/providers/types';

/**
 * 프로바이더 체인
 * ---------------------------------------------------------------------------
 * 앞에서부터 시도하고, `ProviderUnavailableError` 가 나면 다음으로 넘어갑니다.
 *
 * 폴백 조건을 좁게 잡은 이유:
 *   스키마 위반이나 잘못된 입력은 프로바이더를 바꿔도 똑같이 실패합니다.
 *   그런 것까지 폴백하면 같은 실패를 두 번 하며 비용만 두 배가 됩니다.
 *   요금제 한도·인증·연결 문제일 때만 넘어갑니다.
 *
 * 한 번 "쓸 수 없다"고 판정된 프로바이더는 그 실행 동안 다시 시도하지 않습니다.
 * 매 건마다 한도 초과를 다시 확인하는 것은 시간 낭비입니다.
 */
export class ProviderChain implements LlmProvider {
  readonly name = 'chain';

  private readonly disabled = new Set<string>();

  constructor(
    private readonly providers: LlmProvider[],
    private readonly log: (message: string) => void = () => {},
  ) {
    if (providers.length === 0) throw new Error('프로바이더가 하나도 없습니다.');
  }

  async isConfigured(): Promise<boolean> {
    for (const provider of this.providers) {
      if (await provider.isConfigured()) return true;
    }
    return false;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const failures: string[] = [];

    for (const provider of this.providers) {
      if (this.disabled.has(provider.name)) continue;

      try {
        return await provider.complete(request);
      } catch (error) {
        if (!(error instanceof ProviderUnavailableError)) throw error;

        this.disabled.add(provider.name);
        failures.push(error.message);
        this.log(`${provider.name} 사용 불가 (${error.reason}) — 다음 프로바이더로 넘어갑니다.`);
      }
    }

    throw new ProviderUnavailableError(
      'chain',
      'not_configured',
      `사용 가능한 프로바이더가 없습니다.\n${failures.map((f) => `  - ${f}`).join('\n')}`,
    );
  }

  /** 보고용: 이번 실행에서 배제된 프로바이더 */
  get disabledProviders(): string[] {
    return [...this.disabled];
  }
}

export type ProviderName = 'claude-cli' | 'gemini' | 'openrouter';
export type ProviderMode = 'auto' | ProviderName;

const PROVIDER_NAMES: readonly ProviderName[] = ['claude-cli', 'gemini', 'openrouter'];

/** `auto` 가 펼쳐지는 순서 */
const AUTO_ORDER: readonly ProviderName[] = ['claude-cli', 'gemini', 'openrouter'];

export interface CreateProviderOptions {
  mode?: string;
  log?: (message: string) => void;
}

/**
 * LLM_PROVIDER 값을 프로바이더 순서로 해석합니다.
 *
 * 쉼표로 여러 개를 적을 수 있습니다. 적은 순서대로 시도합니다.
 * 하나만 적으면 폴백 없이 그것만 씁니다.
 *
 *   auto                (기본) claude-cli → gemini → openrouter
 *   gemini,openrouter   Gemini 를 쓰고 막히면 OpenRouter
 *   gemini              Gemini 만 (폴백 없음)
 *
 * 오타를 조용히 무시하면 의도와 다른 프로바이더가 돌면서 요금이 나갑니다.
 * 모르는 이름은 그 자리에서 실패시킵니다.
 */
export function parseProviderModes(raw: string | undefined): ProviderName[] {
  const value = (raw ?? '').trim();
  if (value === '' || value === 'auto') return [...AUTO_ORDER];

  const names = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  const unknown = names.filter((name) => !PROVIDER_NAMES.includes(name as ProviderName));
  if (unknown.length > 0) {
    throw new Error(
      `LLM_PROVIDER 에 알 수 없는 값이 있습니다: ${unknown.join(', ')}\n` +
        `  사용 가능: auto, ${PROVIDER_NAMES.join(', ')} (쉼표로 여러 개 지정 가능)`,
    );
  }

  // 같은 프로바이더를 두 번 적어도 한 번만 시도합니다.
  return [...new Set(names)] as ProviderName[];
}

/**
 * 환경변수에 따라 프로바이더를 구성합니다.
 *
 * 폴백은 **요금제 한도·인증·연결 문제일 때만** 일어납니다.
 * 스키마 위반처럼 프로바이더를 바꿔도 똑같이 실패할 오류는 폴백하지 않습니다.
 */
export function createProvider(options: CreateProviderOptions = {}): LlmProvider {
  const log = options.log ?? (() => {});
  const names = parseProviderModes(options.mode ?? process.env.LLM_PROVIDER);

  const build = (name: ProviderName): LlmProvider => {
    switch (name) {
      case 'claude-cli':
        return new ClaudeCliProvider({
          binaryPath: process.env.CLAUDE_CLI_PATH,
          model: process.env.CLAUDE_CLI_MODEL,
          effort: (process.env.CLAUDE_CLI_EFFORT as 'low' | 'medium' | 'high') || undefined,
          maxBudgetUsd: numberFromEnv('CLAUDE_CLI_MAX_BUDGET_USD'),
          log,
        });
      case 'gemini':
        return new GeminiProvider({ log });
      case 'openrouter':
        return new OpenRouterProvider({ log });
    }
  };

  // 하나만 지정했으면 체인으로 감싸지 않습니다. 폴백이 없다는 뜻이니까요.
  const providers = names.map(build);
  return providers.length === 1 ? providers[0]! : new ProviderChain(providers, log);
}

function numberFromEnv(key: string): number | undefined {
  const raw = process.env[key];
  if (!raw) return undefined;

  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export { ClaudeCliProvider, GeminiProvider, OpenRouterProvider };
export * from '@pipeline/extract/providers/types';
