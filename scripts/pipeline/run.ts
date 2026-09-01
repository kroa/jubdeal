import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import type { Deal, DealsFile } from '@/types/deal';
import { parseDealsFile } from '@/lib/deal-schema';
import { getAdapter } from '@pipeline/adapters/index';
import { assembleDeal, canonicalizeUrl, makeStableId } from '@pipeline/assemble';
import { DealExtractor } from '@pipeline/extract/extract';
import { PoliteFetcher, isValidHeaderValue } from '@pipeline/fetch/http';
import { mergeDeals } from '@pipeline/merge';
import type {
  PipelineReport,
  RawItem,
  ReviewItem,
  SourceConfig,
  SourcesFile,
} from '@pipeline/types';

/**
 * 파이프라인 오케스트레이터
 * ---------------------------------------------------------------------------
 * 수집 → 추출 → 조립 → 병합 → 기록.
 *
 * 안전 장치:
 *  - `dryRun` 이면 파일을 쓰지 않습니다 (기본값은 dry run 이 아니라 명시적으로 받습니다).
 *  - LLM 호출 상한(`maxItems`)을 넘기지 않습니다. 실수로 비용이 폭주하지 않게.
 *  - 저신뢰·스키마 위반 건은 버리지 않고 검수 큐 파일로 남깁니다.
 *  - 최종 결과는 반드시 `parseDealsFile` 로 재검증한 뒤에만 씁니다.
 */

export interface RunOptions {
  sourcesPath: string;
  dealsPath: string;
  reviewDir: string;
  /** 실제로 파일을 쓸지 여부 */
  write: boolean;
  /** 이번 실행에서 LLM 을 호출할 최대 항목 수 (비용 상한) */
  maxItems: number;
  now: Date;
  /** 특정 소스만 실행 */
  onlySource?: string;
  /** 종료 후 N일 지난 항목 제거 */
  pruneAfterDays?: number;
  extractor?: DealExtractor;
  fetcher?: Pick<PoliteFetcher, 'fetchText' | 'assertAllowed'>;
  log?: (message: string) => void;
}

export async function runPipeline(options: RunOptions): Promise<PipelineReport> {
  const log = options.log ?? ((message: string) => console.log(message));
  const startedAt = options.now.toISOString();

  const report: PipelineReport = {
    startedAt,
    finishedAt: startedAt,
    sourcesRun: 0,
    collected: 0,
    extracted: 0,
    rejected: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    reviewQueued: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: null,
      unpricedCalls: 0,
    },
    errors: [],
  };

  const sourcesFile = await loadSources(options.sourcesPath);
  const fetcher =
    options.fetcher ??
    new PoliteFetcher({
      userAgent: sourcesFile.userAgent,
      requestIntervalMs: sourcesFile.requestIntervalMs,
      timeoutMs: sourcesFile.timeoutMs,
      log,
    });

  const active = sourcesFile.sources.filter(
    (source) => source.enabled && (!options.onlySource || source.id === options.onlySource),
  );

  if (active.length === 0) {
    log('활성화된 소스가 없습니다. sources 설정의 enabled 를 확인하세요.');
    report.finishedAt = new Date().toISOString();
    return report;
  }

  /* ---------------------------------------------------------------- 1. 수집 */
  const rawItems: RawItem[] = [];

  for (const source of active) {
    report.sourcesRun += 1;
    try {
      const adapter = await getAdapter(source.kind);
      const collected = await adapter.collect(source, {
        fetchText: (url) => fetcher.fetchText(url),
        assertAllowed: (url) => fetcher.assertAllowed(url),
        userAgent: sourcesFile.userAgent,
        now: options.now,
        log,
      });
      log(`[${source.id}] ${collected.length}건 수집`);
      rawItems.push(...collected);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[${source.id}] 수집 실패: ${message}`);
      report.errors.push({ sourceId: source.id, message });
    }
  }

  report.collected = rawItems.length;

  // 비용 상한. 넘치면 조용히 자르지 않고 남은 건수를 로그로 알립니다.
  const targets = shareAcrossSources(rawItems, options.maxItems);
  if (rawItems.length > targets.length) {
    log(
      `주의: 수집 ${rawItems.length}건 중 ${targets.length}건만 처리합니다 ` +
        `(--max-items ${options.maxItems}). 나머지 ${rawItems.length - targets.length}건은 다음 실행으로 넘어갑니다.`,
    );
  }

  /* ------------------------------------------------- 2. 추출 + 3. 조립 */
  const existingFile = await loadDeals(options.dealsPath);
  const existingById = new Map(existingFile.deals.map((deal) => [deal.id, deal]));
  const existingByLink = new Map(
    existingFile.deals.map((deal) => [canonicalizeUrl(deal.link.url), deal]),
  );

  const extractor = options.extractor ?? new DealExtractor({ log });
  const assembled: Deal[] = [];
  const review: ReviewItem[] = [];

  for (const item of targets) {
    const outcome = await extractor.extract(item, options.now);

    report.usage.inputTokens += outcome.usage.inputTokens;
    report.usage.outputTokens += outcome.usage.outputTokens;
    report.usage.cachedInputTokens += outcome.usage.cachedInputTokens;
    if (outcome.usage.costUsd !== null) {
      report.usage.costUsd = (report.usage.costUsd ?? 0) + outcome.usage.costUsd;
    } else {
      report.usage.unpricedCalls += 1;
    }

    if (!outcome.ok) {
      report.rejected += 1;
      // '혜택 아님'은 정상적인 필터링이므로 검수 큐에 넣지 않습니다.
      if (outcome.reason !== 'not_a_deal') {
        review.push({
          reason: outcome.reason,
          detail: outcome.detail,
          sourceId: item.sourceId,
          url: item.url,
          title: item.title,
          candidate: outcome.candidate,
          collectedAt: item.collectedAt,
        });
      }
      log(`거절 [${outcome.reason}] ${item.url} — ${outcome.detail}`);
      continue;
    }

    // id 는 (소스 + 정규화 URL) 해시입니다. URL 로 id 맵을 뒤지면 항상 빗나갑니다.
    const existing =
      existingById.get(makeStableId(item.sourceId, item.url)) ??
      existingByLink.get(canonicalizeUrl(item.url));
    const result = assembleDeal(outcome.value, item, { now: options.now, existing });

    if (!result.ok) {
      report.rejected += 1;
      review.push({
        reason: 'schema_invalid',
        detail: result.detail,
        sourceId: item.sourceId,
        url: item.url,
        title: item.title,
        candidate: result.candidate,
        collectedAt: item.collectedAt,
      });
      log(`스키마 위반: ${item.url} — ${result.detail}`);
      continue;
    }

    report.extracted += 1;
    assembled.push(result.deal);
  }

  /* ---------------------------------------------------------------- 4. 병합 */
  const merged = mergeDeals(existingFile, assembled, {
    now: options.now,
    pruneAfterDays: options.pruneAfterDays,
  });

  report.added = merged.added.length;
  report.updated = merged.updated.length;
  report.unchanged = merged.unchanged.length;
  report.reviewQueued = review.length;

  if (merged.protectedFromOverwrite.length > 0) {
    log(`검수 완료 항목 ${merged.protectedFromOverwrite.length}건은 덮어쓰지 않았습니다.`);
  }
  if (merged.pruned.length > 0) {
    log(`오래 종료된 ${merged.pruned.length}건을 목록에서 제거했습니다.`);
  }

  /* ---------------------------------------------------------------- 5. 기록 */
  // 쓰기 전에 정식 스키마로 다시 검증합니다. 여기서 실패하면 파일을 건드리지 않습니다.
  parseDealsFile(merged.file);

  if (options.write) {
    // 임시 파일에 쓴 뒤 교체합니다. 도중에 죽으면 잘린 JSON 이 남아 빌드가 깨집니다.
    await writeFileAtomic(options.dealsPath, `${JSON.stringify(merged.file, null, 2)}\n`);
    log(`deals.json 갱신: ${merged.file.deals.length}건`);

    if (review.length > 0) {
      await mkdir(options.reviewDir, { recursive: true });
      const stamp = options.now.toISOString().replace(/[:.]/g, '-');
      const reviewPath = path.join(options.reviewDir, `review-${stamp}.json`);
      await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, 'utf8');
      log(`검수 큐 ${review.length}건 기록: ${reviewPath}`);
    }
  } else {
    log('dry run 이라 파일을 쓰지 않았습니다.');
  }

  report.finishedAt = new Date().toISOString();
  return report;
}

/**
 * 상한을 소스끼리 나눠 갖습니다.
 *
 * 앞에서부터 자르면(`slice(0, maxItems)`) 상한을 **먼저 수집된 소스가 다 씁니다.**
 * 실제로 카드고릴라(74~118만원짜리 카드 캐시백)를 붙였는데 한 건도 처리되지
 * 않았습니다. 설정 파일 맨 뒤에 있어서 앞의 네 소스가 30건을 다 채워 버린 탓입니다.
 * 한 번의 사고가 아니라 매 실행 반복되는 구조라, 뒤쪽 소스는 영원히 굶습니다.
 *
 * 소스 순서는 설정 파일에 적힌 순서일 뿐 우선순위가 아닙니다.
 * 번갈아 가며 한 건씩 골라 상한을 공평하게 나눕니다.
 * 항목이 적은 소스가 먼저 바닥나면 남은 몫은 나머지 소스가 이어받습니다.
 */
export function shareAcrossSources(items: RawItem[], limit: number): RawItem[] {
  if (limit <= 0) return [];

  const queues = new Map<string, RawItem[]>();
  for (const item of items) {
    const queue = queues.get(item.sourceId);
    if (queue) queue.push(item);
    else queues.set(item.sourceId, [item]);
  }

  const picked: RawItem[] = [];
  const lists = [...queues.values()];

  for (let round = 0; picked.length < limit; round += 1) {
    let progressed = false;

    for (const list of lists) {
      if (picked.length >= limit) break;

      const item = list[round];
      if (item === undefined) continue;

      picked.push(item);
      progressed = true;
    }

    // 모든 소스가 바닥나면 더 돌 필요가 없습니다.
    if (!progressed) break;
  }

  return picked;
}

/** 임시 파일 + rename 으로 원자적으로 씁니다. */
async function writeFileAtomic(target: string, contents: string): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, contents, 'utf8');
  await rename(temporary, target);
}

async function loadSources(sourcesPath: string): Promise<SourcesFile> {
  const body = await readFile(sourcesPath, 'utf8');
  const parsed = JSON.parse(body) as SourcesFile;

  if (!Array.isArray(parsed.sources)) {
    throw new Error(`${sourcesPath}: sources 배열이 없습니다.`);
  }
  if (!isValidHeaderValue(parsed.userAgent ?? '')) {
    // 비-ASCII 는 요청을 만드는 순간 TypeError 가 나서 모든 수집이 실패합니다.
    const bad = [...(parsed.userAgent ?? '')].find((char) => !isValidHeaderValue(char));
    throw new Error(
      `${sourcesPath}: userAgent 는 ASCII 만 사용할 수 있습니다 ` +
        `(HTTP 헤더 값은 ByteString). 문제 문자: ${JSON.stringify(bad)}`,
    );
  }
  if (!parsed.userAgent || !parsed.userAgent.includes('http')) {
    throw new Error(
      `${sourcesPath}: userAgent 에 연락 가능한 URL 을 포함하세요. ` +
        '수집 대상 서버 운영자가 문의할 수 있어야 합니다.',
    );
  }

  for (const source of parsed.sources) {
    assertSourceConfig(source, sourcesPath);
  }

  return parsed;
}

function assertSourceConfig(source: SourceConfig, sourcesPath: string): void {
  if (!source.id || !/^[a-z0-9][a-z0-9-]*$/.test(source.id)) {
    throw new Error(`${sourcesPath}: 소스 id 는 영소문자·숫자·하이픈이어야 합니다: ${source.id}`);
  }
  if (!Number.isInteger(source.maxItems) || source.maxItems < 1 || source.maxItems > 100) {
    throw new Error(`${sourcesPath}: [${source.id}] maxItems 는 1~100 이어야 합니다.`);
  }
}

async function loadDeals(dealsPath: string): Promise<DealsFile> {
  const body = await readFile(dealsPath, 'utf8');
  return parseDealsFile(JSON.parse(body));
}

/** 실행 결과를 사람이 읽을 수 있게 요약합니다. */
export function formatReport(report: PipelineReport): string {
  const durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
  const { inputTokens, outputTokens, cachedInputTokens, costUsd, unpricedCalls } = report.usage;

  /*
    비용은 **알려준 값만 적고, 모르는 건 모른다고 적습니다.**

    (1) 추정하지 않습니다.
        예전에는 Claude 단가($5/$25 per 1M)로 추정했는데, 프로바이더가 바뀌면
        남의 요금표로 값을 만들어 내는 셈입니다.
        실제로 Gemini(응답에 비용을 담지 않음) 실행에 "추정 비용 $0.1046" 이 찍혔습니다.
        무료 등급이라 0 인 실행에 요금이 있는 것처럼 보였습니다.

    (2) 일부만 알아도 전체인 척하지 않습니다.
        체인은 프로바이더를 섞어 씁니다. Gemini 로 40건, OpenRouter 로 10건을
        돌면 OpenRouter 가 알려준 0 만 더해져 "실제 비용 $0.0000" 이 찍힙니다.
        40건이 집계에서 빠진 값인데 전체처럼 보입니다.

    "유료로 돌리지 않는다"가 이 프로젝트의 전제라, 이 수치가 틀리면
    가장 확인하고 싶은 값을 못 믿게 됩니다.
  */
  const costLine = (() => {
    if (costUsd === null) {
      return '  비용        프로바이더가 알려주지 않음 (무료 등급이면 0)';
    }
    if (unpricedCalls > 0) {
      return `  실제 비용   $${costUsd.toFixed(4)} (+ ${unpricedCalls}건은 알려주지 않음)`;
    }
    return `  실제 비용   $${costUsd.toFixed(4)}`;
  })();

  const lines = [
    '',
    '─── 파이프라인 실행 결과 ───',
    `  소스        ${report.sourcesRun}개`,
    `  수집        ${report.collected}건`,
    `  추출 성공   ${report.extracted}건`,
    `  거절        ${report.rejected}건`,
    `  검수 대기   ${report.reviewQueued}건`,
    `  신규        ${report.added}건`,
    `  갱신        ${report.updated}건`,
    `  변화 없음   ${report.unchanged}건`,
    `  토큰        입력 ${inputTokens.toLocaleString()} (캐시 ${cachedInputTokens.toLocaleString()}) / 출력 ${outputTokens.toLocaleString()}`,
    costLine,
    `  소요        ${(durationMs / 1000).toFixed(1)}초`,
  ];

  if (report.errors.length > 0) {
    lines.push('  오류:');
    for (const error of report.errors) {
      lines.push(`    - [${error.sourceId}] ${error.message}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
