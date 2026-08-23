import { ClaudeCliProvider } from '@pipeline/extract/providers/claude-cli';
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

export type ProviderMode = 'auto' | 'claude-cli' | 'openrouter';

export interface CreateProviderOptions {
  mode?: ProviderMode;
  log?: (message: string) => void;
}

/**
 * 환경변수에 따라 프로바이더를 구성합니다.
 *
 *   LLM_PROVIDER=auto        (기본) claude-cli 를 먼저, 막히면 openrouter
 *   LLM_PROVIDER=claude-cli  구독 인증만 사용 (폴백 없음)
 *   LLM_PROVIDER=openrouter  OpenRouter 만 사용
 */
export function createProvider(options: CreateProviderOptions = {}): LlmProvider {
  const log = options.log ?? (() => {});
  const mode = (options.mode ?? process.env.LLM_PROVIDER ?? 'auto') as ProviderMode;

  const claude = () =>
    new ClaudeCliProvider({
      binaryPath: process.env.CLAUDE_CLI_PATH,
      model: process.env.CLAUDE_CLI_MODEL,
      effort: (process.env.CLAUDE_CLI_EFFORT as 'low' | 'medium' | 'high') || undefined,
      maxBudgetUsd: numberFromEnv('CLAUDE_CLI_MAX_BUDGET_USD'),
      log,
    });

  const openrouter = () => new OpenRouterProvider({ log });

  switch (mode) {
    case 'claude-cli':
      return claude();
    case 'openrouter':
      return openrouter();
    case 'auto':
    default:
      return new ProviderChain([claude(), openrouter()], log);
  }
}

function numberFromEnv(key: string): number | undefined {
  const raw = process.env[key];
  if (!raw) return undefined;

  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export { ClaudeCliProvider, OpenRouterProvider };
export * from '@pipeline/extract/providers/types';
