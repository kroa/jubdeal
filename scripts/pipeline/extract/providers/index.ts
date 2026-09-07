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
 * 배제는 **사유에 따라 기한이 다릅니다.**
 *
 * 처음에는 한 번 막힌 프로바이더를 그 실행 내내 배제했습니다.
 * "매 건마다 한도를 다시 확인하는 건 시간 낭비"라고 봤는데, 분당 한도에서는
 * 이 판단이 틀렸습니다. 실측에서 107건을 수집하고 5건만 추출했습니다 —
 * Gemini 가 분당 한도에 걸려 배제된 뒤 8초 만에 회복됐는데도
 * 남은 100건을 전부 `api_error` 로 버렸습니다.
 *
 * 키가 없거나 인증이 틀린 것은 기다려도 안 고쳐지니 영구 배제입니다.
 * 한도·붐빔은 기다리면 풀리니 쿨다운만 겁니다.
 */
/**
 * 사유별 쿨다운.
 *
 * 한도는 분 단위로 리셋되는 경우가 많아 1분이면 대개 풀립니다.
 * 붐빔·연결 문제는 더 짧게 잡아도 됩니다.
 */
const COOLDOWN_MS: Record<string, number> = {
  not_configured: Infinity,
  auth: Infinity,
  quota: 60_000,
  unavailable: 20_000,
  busy: 20_000,
};

/** 한 요청에서 쿨다운을 기다리는 최대 횟수 */
const MAX_COOLDOWN_WAITS = 1;

/**
 * 한 번에 기다릴 수 있는 최대 시간.
 *
 * 짧게 잡은 이유: 이 대기는 **항목마다** 일어납니다. 60초까지 기다리게 두면
 * 한도가 계속 차 있을 때 100건이 100분이 됩니다.
 *
 * 대신 기다리지 않고 넘어가도 손해가 크지 않습니다. 파이프라인은 항목을
 * 하나씩 처리하므로 그동안 시간이 흐르고, 쿨다운이 끝나면 다음 항목부터
 * 저절로 다시 씁니다. 잃는 것은 쿨다운이 도는 동안의 몇 건뿐입니다.
 */
const MAX_WAIT_MS = 25_000;

export class ProviderChain implements LlmProvider {
  readonly name = 'chain';

  /** 프로바이더 이름 → 다시 시도해도 되는 시각(ms). `Infinity` 는 영구 배제 */
  private readonly retryAt = new Map<string, number>();

  constructor(
    private readonly providers: LlmProvider[],
    private readonly log: (message: string) => void = () => {},
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
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

    /*
      한 바퀴를 다 돌아 아무도 못 쓰면, 쿨다운이 가장 먼저 끝나는 프로바이더를
      기다렸다가 한 번 더 돕니다. 기다려서 될 일이 아니면(전부 영구 배제)
      즉시 포기합니다.
    */
    for (let attempt = 0; ; attempt += 1) {
      for (const provider of this.providers) {
        if (this.blockedUntil(provider.name) > this.now()) continue;

        try {
          return await provider.complete(request);
        } catch (error) {
          if (!(error instanceof ProviderUnavailableError)) throw error;

          const cooldown = COOLDOWN_MS[error.reason] ?? Infinity;
          this.retryAt.set(provider.name, this.now() + cooldown);
          failures.push(error.message);
          this.log(
            cooldown === Infinity
              ? `${provider.name} 사용 불가 (${error.reason}) — 이번 실행에서 제외합니다.`
              : `${provider.name} 사용 불가 (${error.reason}) — ${cooldown / 1000}초 뒤 다시 시도합니다.`,
          );
        }
      }

      const waitMs = this.msUntilAnyFree();
      if (attempt >= MAX_COOLDOWN_WAITS || waitMs === null || waitMs > MAX_WAIT_MS) break;

      this.log(`모든 프로바이더가 쉬는 중입니다. ${Math.ceil(waitMs / 1000)}초 기다립니다.`);
      await this.sleep(waitMs);
    }

    throw new ProviderUnavailableError(
      'chain',
      'not_configured',
      `사용 가능한 프로바이더가 없습니다.\n${failures.map((f) => `  - ${f}`).join('\n')}`,
    );
  }

  /** 하위 프로바이더 중 이 모델을 다룰 수 있는 쪽에 전달합니다. */
  banModel(model: string): void {
    for (const provider of this.providers) provider.banModel?.(model);
  }

  private blockedUntil(name: string): number {
    return this.retryAt.get(name) ?? 0;
  }

  /** 가장 이른 쿨다운이 풀릴 때까지 남은 시간. 전부 영구 배제면 null */
  private msUntilAnyFree(): number | null {
    let earliest = Infinity;
    for (const provider of this.providers) {
      const at = this.blockedUntil(provider.name);
      if (at < earliest) earliest = at;
    }
    if (earliest === Infinity) return null;
    return Math.max(0, earliest - this.now());
  }

  /** 보고용: 지금 쓸 수 없는 프로바이더 */
  get disabledProviders(): string[] {
    const now = this.now();
    return this.providers.map((p) => p.name).filter((name) => this.blockedUntil(name) > now);
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
