import { parseArgs } from 'node:util';
import path from 'node:path';
import { loadEnvFile } from '@pipeline/env';
import { formatReport, runPipeline } from '@pipeline/run';
import { createProvider } from '@pipeline/extract/providers/index';

/**
 * 파이프라인 CLI
 * ---------------------------------------------------------------------------
 *   npm run pipeline -- --dry-run
 *   npm run pipeline -- --write --max-items 10
 *   npm run pipeline -- --source my-source --write
 *
 * 기본은 **dry run** 입니다. 파일을 바꾸려면 --write 를 명시해야 합니다.
 * 실수로 deals.json 을 덮어쓰는 사고를 막기 위한 의도적 선택입니다.
 */

const USAGE = `
줍딜 수집 파이프라인

사용법:
  npm run pipeline -- [옵션]

옵션:
  --write               실제로 deals.json 을 갱신합니다 (기본: dry run)
  --dry-run             파일을 쓰지 않고 결과만 확인합니다 (기본 동작을 명시)
  --max-items <n>       LLM 을 호출할 최대 항목 수 (기본: 20) — 비용 상한
  --source <id>         특정 소스만 실행
  --sources <path>      소스 설정 파일 (기본: scripts/pipeline/sources.json)
  --deals <path>        데이터 파일 (기본: src/data/deals.json)
  --prune-after <days>  오래된 항목 제거 (기본: 0 = 제거 안 함)
                        · 종료된 지 N일 지난 항목
                        · 마감일을 모른 채 마지막 수집 후 N일 지난 항목
                        소스에 아직 올라와 있거나 검수 완료한 항목은 남습니다.
  --help                이 도움말

환경변수:
  LLM_PROVIDER          auto(기본) | claude-cli | openrouter
  CLAUDE_CLI_PATH       Claude Code 바이너리 경로 (비우면 자동 탐색)
  OPENROUTER_API_KEY    Claude 가 요금제 한도로 막혔을 때 쓰는 폴백 키

  기본 동작은 VSCode 에 연결된 Claude(구독 인증)를 먼저 쓰고,
  한도 등으로 막히면 OpenRouter 로 자동 폴백합니다.
  자세한 설정은 .env.example 을 참고하세요.
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // CLI 는 tsx 로 직접 실행되어 Astro 의 env 로딩을 타지 않습니다.
  // .env 를 직접 읽되, 이미 설정된 환경변수는 덮어쓰지 않습니다.
  loadEnvFile();

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        write: { type: 'boolean', default: false },
        // 기본이 dry run 이지만, 의도를 드러내기 위해 명시적으로 쓸 수 있게 둡니다.
        'dry-run': { type: 'boolean', default: false },
        'max-items': { type: 'string', default: '20' },
        source: { type: 'string' },
        sources: { type: 'string', default: 'scripts/pipeline/sources.json' },
        deals: { type: 'string', default: 'src/data/deals.json' },
        'prune-after': { type: 'string', default: '0' },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }

  const { values } = parsed;

  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const maxItems = Number.parseInt(values['max-items'] as string, 10);
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    console.error('--max-items 는 1 이상의 정수여야 합니다.');
    return 2;
  }

  const pruneAfterDays = Number.parseInt(values['prune-after'] as string, 10);
  if (!Number.isInteger(pruneAfterDays) || pruneAfterDays < 0) {
    console.error('--prune-after 는 0 이상의 정수여야 합니다.');
    return 2;
  }

  if (values.write && values['dry-run']) {
    console.error('--write 와 --dry-run 을 함께 쓸 수 없습니다.');
    return 2;
  }

  const write = (values.write as boolean) && !(values['dry-run'] as boolean);

  if (write) {
    // 쓰기 전에 프로바이더가 하나라도 쓸 수 있는지 확인합니다.
    // 여기서 막지 않으면 수집만 잔뜩 해 놓고 추출은 전부 실패합니다.
    const provider = createProvider();
    if (!(await provider.isConfigured())) {
      console.error(
        '사용 가능한 LLM 프로바이더가 없습니다.\n' +
          '  - VSCode 에서 Claude 에 로그인했는지 확인하거나\n' +
          '  - .env 에 OPENROUTER_API_KEY 를 설정하세요. (.env.example 참고)',
      );
      return 1;
    }
  }

  const cwd = process.cwd();

  try {
    const report = await runPipeline({
      sourcesPath: path.resolve(cwd, values.sources as string),
      dealsPath: path.resolve(cwd, values.deals as string),
      reviewDir: path.resolve(cwd, 'scripts/pipeline/review'),
      write,
      maxItems,
      now: new Date(),
      onlySource: values.source as string | undefined,
      pruneAfterDays,
    });

    console.log(formatReport(report));

    // 수집 자체가 전부 실패했으면 실패로 알립니다 (CI 에서 감지 가능).
    if (report.errors.length > 0 && report.sourcesRun === report.errors.length) {
      console.error('모든 소스에서 수집이 실패했습니다.');
      return 1;
    }

    // 수집은 됐는데 추출이 100% 실패한 경우(API 키 만료, 모델 오류 등).
    // 이걸 성공으로 처리하면 워크플로우가 매일 초록불로 끝나면서 아무것도 수집되지 않습니다.
    if (report.collected > 0 && report.extracted === 0) {
      console.error(
        `수집 ${report.collected}건 중 추출 성공이 0건입니다. ` +
          '검수 큐와 로그에서 원인을 확인하세요.',
      );
      return 1;
    }

    // 존재하지 않는 --source 를 넘겼는데 조용히 성공하지 않도록.
    if (values.source && report.sourcesRun === 0) {
      console.error(`--source ${String(values.source)} 에 해당하는 활성 소스가 없습니다.`);
      return 1;
    }

    return 0;
  } catch (error) {
    console.error(`파이프라인 실패: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// 직접 실행될 때만 동작합니다 (테스트에서 import 해도 실행되지 않도록).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
