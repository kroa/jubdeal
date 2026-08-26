import { execFile } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EMPTY_USAGE,
  LlmRequestError,
  ProviderUnavailableError,
  looksLikeAuthError,
  looksLikeQuotaError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmUsage,
} from '@pipeline/extract/providers/types';

/**
 * Claude Code CLI 프로바이더
 * ---------------------------------------------------------------------------
 * VSCode 확장에 들어 있는 Claude Code 바이너리를 비대화형(`-p`)으로 실행합니다.
 * **API 키가 아니라 이미 로그인된 구독 인증을 그대로 씁니다.**
 *
 * 비용에 대해:
 *   Claude Code 는 자체 시스템 프롬프트와 도구 정의를 함께 실어 보냅니다(약 22k 토큰).
 *   첫 호출은 그 캐시 생성 비용을 내지만, 이후 동일한 호출은 캐시를 읽어
 *   실측 기준 약 1/10 로 떨어집니다 ($0.047 -> $0.0043).
 *   그래서 한 번에 여러 건을 연속 처리할수록 유리합니다.
 *
 * 안전:
 *   추출은 순수 텍스트 작업이라 도구가 필요 없습니다.
 *   도구·슬래시 명령·세션 저장을 모두 끄고, 호출당 예산 상한을 겁니다.
 */

const DEFAULT_MODEL = 'sonnet';
const DEFAULT_MAX_BUDGET_USD = 0.5;
const DEFAULT_TIMEOUT_MS = 180_000;

export interface ClaudeCliOptions {
  /** 바이너리 경로. 생략하면 자동 탐색 */
  binaryPath?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** 호출 1건당 최대 비용(USD) */
  maxBudgetUsd?: number;
  timeoutMs?: number;
  log?: (message: string) => void;
  /** 테스트 주입용 */
  runImpl?: (binary: string, args: string[], input: string) => Promise<CliRun>;
}

export interface CliRun {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Claude Code 바이너리를 찾습니다.
 * 우선순위: 명시 경로 → 환경변수 → PATH → VSCode 확장 디렉터리(최신 버전)
 *
 * 확장 디렉터리 이름에 버전이 들어 있어 업데이트마다 바뀌므로,
 * 경로를 하드코딩하지 않고 매번 최신 것을 고릅니다.
 */
export async function resolveClaudeBinary(explicit?: string): Promise<string | null> {
  // 경로를 명시했으면 그것만 씁니다.
  // 잘못된 경로일 때 조용히 다른 바이너리로 넘어가면,
  // 사용자가 지정한 것과 다른 게 실행되는 걸 알아채지 못합니다.
  const pinned = explicit ?? process.env.CLAUDE_CLI_PATH;
  if (pinned && pinned.trim() !== '') {
    return (await isExecutable(pinned)) ? pinned : null;
  }

  // PATH 에 있으면 그걸 씁니다.
  const onPath = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, onPath);
    if (await isExecutable(full)) return full;
  }

  return findInVscodeExtensions();
}

async function findInVscodeExtensions(): Promise<string | null> {
  const roots = [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-insiders', 'extensions'),
    path.join(os.homedir(), '.cursor', 'extensions'),
  ];

  const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude';

  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }

    // 버전이 이름에 들어 있으므로 사전순 역정렬로 최신을 먼저 봅니다.
    const matches = entries
      .filter((name) => name.startsWith('anthropic.claude-code-'))
      .sort()
      .reverse();

    for (const name of matches) {
      const full = path.join(root, name, 'resources', 'native-binary', binaryName);
      if (await isExecutable(full)) return full;
    }
  }

  return null;
}

async function isExecutable(target: string): Promise<boolean> {
  try {
    await access(target, constants.X_OK);
    return true;
  } catch {
    try {
      // Windows 는 X_OK 의미가 약해 존재 여부로 판단합니다.
      await access(target, constants.F_OK);
      return process.platform === 'win32';
    } catch {
      return false;
    }
  }
}

export class ClaudeCliProvider implements LlmProvider {
  readonly name = 'claude-cli';

  private readonly options: ClaudeCliOptions;
  private readonly log: (message: string) => void;
  private binary: string | null | undefined;

  constructor(options: ClaudeCliOptions = {}) {
    this.options = options;
    this.log = options.log ?? (() => {});
  }

  async isConfigured(): Promise<boolean> {
    return (await this.getBinary()) !== null;
  }

  private async getBinary(): Promise<string | null> {
    if (this.binary === undefined) {
      this.binary = await resolveClaudeBinary(this.options.binaryPath);
      if (this.binary) this.log(`Claude Code 바이너리: ${this.binary}`);
    }
    return this.binary;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const binary = await this.getBinary();
    if (!binary) {
      throw new ProviderUnavailableError(
        this.name,
        'not_configured',
        'Claude Code 바이너리를 찾지 못했습니다. CLAUDE_CLI_PATH 를 지정하거나 VSCode 확장을 설치하세요.',
      );
    }

    const args = [
      '-p',
      // 기본 시스템 프롬프트를 대체해 불필요한 컨텍스트를 줄입니다.
      '--system-prompt',
      request.system,
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(request.jsonSchema),
      '--model',
      this.options.model ?? DEFAULT_MODEL,
      '--effort',
      this.options.effort ?? 'medium',
      /*
        추출은 텍스트 작업이라 도구가 필요 없습니다.

        그래도 1 은 너무 빠듯합니다. 구조화 출력 전에 한 번 더 도는 경우가 있고,
        그러면 "Reached maximum number of turns (1)" 로 그 건이 통째로 버려집니다.
        실제 수집에서 관측된 실패라 여유를 둡니다.
        도구가 꺼져 있어 폭주할 여지는 없습니다.
      */
      '--max-turns',
      '3',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--max-budget-usd',
      String(this.options.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD),
    ];

    const run = this.options.runImpl ?? defaultRun;
    let result: CliRun;

    try {
      result = await run(binary, args, request.user);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderUnavailableError(this.name, 'unavailable', `실행 실패: ${message}`);
    }

    return this.parseResult(result);
  }

  private parseResult(run: CliRun): LlmResponse {
    const combined = `${run.stdout}\n${run.stderr}`;

    let parsed: CliResultJson;
    try {
      parsed = JSON.parse(run.stdout.trim()) as CliResultJson;
    } catch {
      // JSON 이 아니면 인증·한도 안내문이거나 잘못된 인자입니다.
      const firstLine = (run.stderr || run.stdout).trim().split(/\r?\n/)[0];
      const detail = firstLine || 'CLI 출력을 읽지 못했습니다.';
      throw this.classify(combined, detail);
    }

    if (parsed.is_error) {
      const detail = (parsed.errors ?? []).join('; ') || parsed.subtype || '알 수 없는 오류';

      // 우리가 건 예산 상한은 프로바이더 문제가 아니라 설정 문제입니다.
      if (parsed.subtype === 'error_max_budget_usd') {
        throw new LlmRequestError(
          this.name,
          `호출당 예산 상한을 넘었습니다: ${detail}. CLAUDE_CLI_MAX_BUDGET_USD 를 올리세요.`,
        );
      }

      throw this.classify(`${detail} ${combined}`, detail);
    }

    const text = parsed.result ?? '';
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new LlmRequestError(this.name, `응답이 JSON 이 아닙니다: ${text.slice(0, 200)}`);
    }

    return { data, usage: toUsage(parsed), provider: this.name };
  }

  /** 폴백해야 하는 오류인지, 이 요청만의 문제인지 구분합니다. */
  private classify(text: string, detail: string): Error {
    if (looksLikeQuotaError(text)) {
      return new ProviderUnavailableError(
        this.name,
        'quota',
        `요금제/한도 문제로 보입니다: ${detail}`,
      );
    }
    if (looksLikeAuthError(text)) {
      return new ProviderUnavailableError(this.name, 'auth', `인증 문제로 보입니다: ${detail}`);
    }
    return new LlmRequestError(this.name, detail);
  }
}

interface CliResultJson {
  is_error?: boolean;
  subtype?: string;
  errors?: string[];
  result?: string;
  total_cost_usd?: number;
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    }
  >;
}

function toUsage(parsed: CliResultJson): LlmUsage {
  const models = Object.values(parsed.modelUsage ?? {});
  if (models.length === 0) {
    return { ...EMPTY_USAGE, costUsd: parsed.total_cost_usd ?? null };
  }

  return {
    inputTokens: sum(models, (m) => m.inputTokens),
    outputTokens: sum(models, (m) => m.outputTokens),
    // 캐시 생성분도 "캐시로 다뤄진 입력"으로 함께 셉니다.
    cachedInputTokens:
      sum(models, (m) => m.cacheReadInputTokens) + sum(models, (m) => m.cacheCreationInputTokens),
    costUsd: parsed.total_cost_usd ?? null,
  };
}

function sum<T>(items: T[], pick: (item: T) => number | undefined): number {
  return items.reduce((total, item) => total + (pick(item) ?? 0), 0);
}

function defaultRun(binary: string, args: string[], input: string): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      { maxBuffer: 32 * 1024 * 1024, timeout: DEFAULT_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        // 프로세스가 실패해도 stderr 가 있으면 그대로 넘겨 분류에 씁니다.
        // 여기서 reject 하면 "잘못된 인자" 같은 우리 쪽 실수까지
        // '프로바이더 사용 불가'로 오분류되어 불필요한 폴백이 일어납니다.
        if (error && !stdout && !stderr) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr, code: error ? ((error as { code?: number }).code ?? 1) : 0 });
      },
    );

    child.stdin?.end(input);
  });
}
