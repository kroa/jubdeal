import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEAL_SCHEMA_VERSION, type DealsFile } from '@/types/deal';
import { parseDealsFile } from '@/lib/deal-schema';
import {
  formatReport,
  guessAmount,
  guessDiscountRate,
  looksFree,
  runPipeline,
  shareAcrossSources,
} from '@pipeline/run';
import type { ExtractOutcome } from '@pipeline/extract/extract';
import type { DealExtractor } from '@pipeline/extract/extract';
import type { ExtractedDeal } from '@pipeline/extract/schema';
import type { RawItem } from '@pipeline/types';

const NOW = new Date('2026-08-23T12:00:00+09:00');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'jubdeal-pipeline-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeExtracted(overrides: Partial<ExtractedDeal> = {}): ExtractedDeal {
  return {
    isDeal: true,
    confidence: 0.9,
    notes: '',
    title: '아메리카노 무료 쿠폰',
    summary: '앱 가입 시 1잔 무료',
    description: '',
    brandName: '온더카페',
    category: 'cafe',
    dealType: 'free',
    difficulty: 'easy',
    originalPrice: 4500,
    finalPrice: 0,
    firstComeFirstServed: false,
    quantity: null,
    perPersonLimit: 1,
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    benefitAmount: null,
    benefitIsMax: false,
    benefitBaseAmount: null,
    endDateKind: 'dated' as const,
    linkUrl: null,
    linkLabel: null,
    howTo: [],
    caution: [],
    tags: ['무료'],
    ...overrides,
  };
}

const USAGE = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80, costUsd: 0.004 };

/** 항목마다 결과를 지정할 수 있는 추출기 목 */
function makeExtractor(
  handler: (item: RawItem) => ExtractOutcome | Promise<ExtractOutcome>,
): DealExtractor {
  return { extract: vi.fn(async (item: RawItem) => handler(item)) } as unknown as DealExtractor;
}

async function writeSources(sources: unknown[]): Promise<string> {
  const file = path.join(dir, 'sources.json');
  await writeFile(
    file,
    JSON.stringify({
      userAgent: 'JubDealBot/1.0 (+https://jubdeal.pages.dev)',
      requestIntervalMs: 0,
      timeoutMs: 1000,
      sources,
    }),
  );
  return file;
}

async function writeDeals(deals: DealsFile['deals'] = []): Promise<string> {
  const file = path.join(dir, 'deals.json');
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: DEAL_SCHEMA_VERSION,
      generatedAt: '2026-08-22T00:00:00+09:00',
      deals,
    }),
  );
  return file;
}

async function writeFixture(items: unknown[]): Promise<string> {
  const file = path.join(dir, 'fixture.json');
  await writeFile(file, JSON.stringify(items));
  return file;
}

async function baseOptions(items: unknown[], overrides: Record<string, unknown> = {}) {
  const fixturePath = await writeFixture(items);

  return {
    sourcesPath: await writeSources([
      {
        id: 'demo',
        name: '데모 소스',
        kind: 'fixture',
        url: fixturePath,
        enabled: true,
        maxItems: 10,
      },
    ]),
    dealsPath: await writeDeals(),
    reviewDir: path.join(dir, 'review'),
    write: true,
    maxItems: 10,
    now: NOW,
    log: () => {},
    ...overrides,
  };
}

const SAMPLE_ITEM = {
  url: 'https://example.com/e/1',
  title: '무료 커피',
  text: '아메리카노 무료 쿠폰 이벤트입니다. 9월 한 달간 진행되며 앱 신규 가입자가 대상입니다.',
};

describe('runPipeline — 정상 흐름', () => {
  it('수집 → 추출 → 조립 → 병합 후 deals.json 을 갱신한다', async () => {
    const options = await baseOptions([SAMPLE_ITEM]);
    const extractor = makeExtractor(() => ({ ok: true, value: makeExtracted(), usage: USAGE }));

    const report = await runPipeline({ ...options, extractor });

    expect(report.collected).toBe(1);
    expect(report.extracted).toBe(1);
    expect(report.added).toBe(1);

    const written = parseDealsFile(JSON.parse(await readFile(options.dealsPath, 'utf8')));
    expect(written.deals).toHaveLength(1);
    expect(written.deals[0]?.title).toBe('아메리카노 무료 쿠폰');
    expect(written.deals[0]?.meta.verified).toBe(false);
  });

  it('쓴 결과가 정식 스키마를 통과한다', async () => {
    const options = await baseOptions([SAMPLE_ITEM]);
    const extractor = makeExtractor(() => ({ ok: true, value: makeExtracted(), usage: USAGE }));

    await runPipeline({ ...options, extractor });

    const body = JSON.parse(await readFile(options.dealsPath, 'utf8'));
    expect(() => parseDealsFile(body)).not.toThrow();
  });

  it('두 번 실행해도 중복이 생기지 않는다', async () => {
    // id 가 안정적이지 않으면 매일 같은 혜택이 쌓입니다.
    const options = await baseOptions([SAMPLE_ITEM]);
    const extractor = makeExtractor(() => ({ ok: true, value: makeExtracted(), usage: USAGE }));

    await runPipeline({ ...options, extractor });
    const second = await runPipeline({ ...options, extractor });

    expect(second.added).toBe(0);
    expect(second.unchanged).toBe(1);

    const written = parseDealsFile(JSON.parse(await readFile(options.dealsPath, 'utf8')));
    expect(written.deals).toHaveLength(1);
  });

  it('토큰 사용량을 합산한다', async () => {
    const options = await baseOptions([
      SAMPLE_ITEM,
      { ...SAMPLE_ITEM, url: 'https://example.com/e/2' },
    ]);
    const extractor = makeExtractor(() => ({ ok: true, value: makeExtracted(), usage: USAGE }));

    const report = await runPipeline({ ...options, extractor });

    expect(report.usage.inputTokens).toBe(200);
    expect(report.usage.cachedInputTokens).toBe(160);
  });
});

describe('runPipeline — 안전 장치', () => {
  it('dry run 이면 파일을 쓰지 않는다', async () => {
    const options = await baseOptions([SAMPLE_ITEM], { write: false });
    const before = await readFile(options.dealsPath, 'utf8');
    const extractor = makeExtractor(() => ({ ok: true, value: makeExtracted(), usage: USAGE }));

    const report = await runPipeline({ ...options, extractor });

    expect(report.added).toBe(1);
    expect(await readFile(options.dealsPath, 'utf8')).toBe(before);
  });

  it('maxItems 를 넘겨 LLM 을 호출하지 않는다', async () => {
    // 비용 폭주 방지. 이 상한이 새면 수집량만큼 그대로 과금됩니다.
    const items = Array.from({ length: 10 }, (_, i) => ({
      ...SAMPLE_ITEM,
      url: `https://example.com/e/${i}`,
    }));
    const options = await baseOptions(items, { maxItems: 3 });

    const calls: string[] = [];
    const extractor = makeExtractor((item) => {
      calls.push(item.url);
      return { ok: true, value: makeExtracted(), usage: USAGE };
    });

    const report = await runPipeline({ ...options, extractor });

    expect(calls).toHaveLength(3);
    expect(report.collected).toBe(10);
    expect(report.extracted).toBe(3);
  });

  it('스키마 위반 결과는 파일에 쓰지 않고 검수 큐로 보낸다', async () => {
    const options = await baseOptions([SAMPLE_ITEM]);
    // 정가 < 실지불액 → 조립 단계에서 스키마 위반
    const extractor = makeExtractor(() => ({
      ok: true,
      value: makeExtracted({ originalPrice: 100, finalPrice: 9000 }),
      usage: USAGE,
    }));

    const report = await runPipeline({ ...options, extractor });

    expect(report.extracted).toBe(0);
    expect(report.rejected).toBe(1);
    expect(report.reviewQueued).toBe(1);

    const written = parseDealsFile(JSON.parse(await readFile(options.dealsPath, 'utf8')));
    expect(written.deals).toHaveLength(0);
  });

  it('저신뢰 건은 검수 큐 파일로 남긴다', async () => {
    const options = await baseOptions([SAMPLE_ITEM]);
    const extractor = makeExtractor(() => ({
      ok: false,
      reason: 'low_confidence',
      detail: '종료일 불명확',
      candidate: { title: '후보' },
      usage: USAGE,
    }));

    const report = await runPipeline({ ...options, extractor });

    expect(report.reviewQueued).toBe(1);

    const files = await readdir(options.reviewDir);
    expect(files).toHaveLength(1);

    const queue = JSON.parse(await readFile(path.join(options.reviewDir, files[0]!), 'utf8'));
    expect(queue[0].reason).toBe('low_confidence');
    expect(queue[0].detail).toBe('종료일 불명확');
    expect(queue[0].candidate).toEqual({ title: '후보' });
  });

  it("'혜택 아님'은 검수 큐에 넣지 않는다", async () => {
    // 정상적인 필터링이라 검수자에게 보낼 필요가 없습니다.
    const options = await baseOptions([SAMPLE_ITEM]);
    const extractor = makeExtractor(() => ({
      ok: false,
      reason: 'not_a_deal',
      detail: '보도자료',
      usage: USAGE,
    }));

    const report = await runPipeline({ ...options, extractor });

    expect(report.rejected).toBe(1);
    expect(report.reviewQueued).toBe(0);
  });

  it('검수 완료 항목을 덮어쓰지 않는다', async () => {
    const options = await baseOptions([SAMPLE_ITEM]);

    // 1회차: 자동 수집
    const extractor = makeExtractor(() => ({ ok: true, value: makeExtracted(), usage: USAGE }));
    await runPipeline({ ...options, extractor });

    // 사람이 검수하고 제목을 다듬은 상황을 재현
    const file = parseDealsFile(JSON.parse(await readFile(options.dealsPath, 'utf8')));
    file.deals[0]!.title = '사람이 다듬은 제목';
    file.deals[0]!.meta.verified = true;
    await writeFile(options.dealsPath, JSON.stringify(file));

    // 2회차: 모델이 다른 제목을 제안해도 유지되어야 합니다.
    const second = makeExtractor(() => ({
      ok: true,
      value: makeExtracted({ title: '모델이 새로 만든 제목' }),
      usage: USAGE,
    }));
    await runPipeline({ ...options, extractor: second });

    const after = parseDealsFile(JSON.parse(await readFile(options.dealsPath, 'utf8')));
    expect(after.deals[0]?.title).toBe('사람이 다듬은 제목');
  });
});

describe('runPipeline — 오류 처리', () => {
  it('소스 수집 실패를 보고하고 계속 진행한다', async () => {
    const good = await writeFixture([SAMPLE_ITEM]);
    const options = {
      sourcesPath: await writeSources([
        {
          id: 'broken',
          name: '깨진 소스',
          kind: 'fixture',
          url: path.join(dir, 'nope.json'),
          enabled: true,
          maxItems: 5,
        },
        { id: 'demo', name: '데모', kind: 'fixture', url: good, enabled: true, maxItems: 5 },
      ]),
      dealsPath: await writeDeals(),
      reviewDir: path.join(dir, 'review'),
      write: true,
      maxItems: 10,
      now: NOW,
      log: () => {},
    };

    const extractor = makeExtractor(() => ({ ok: true, value: makeExtracted(), usage: USAGE }));
    const report = await runPipeline({ ...options, extractor });

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.sourceId).toBe('broken');
    expect(report.extracted).toBe(1);
  });

  it('비활성 소스는 실행하지 않는다', async () => {
    const fixturePath = await writeFixture([SAMPLE_ITEM]);
    const options = {
      sourcesPath: await writeSources([
        {
          id: 'demo',
          name: '데모',
          kind: 'fixture',
          url: fixturePath,
          enabled: false,
          maxItems: 5,
        },
      ]),
      dealsPath: await writeDeals(),
      reviewDir: path.join(dir, 'review'),
      write: true,
      maxItems: 10,
      now: NOW,
      log: () => {},
    };

    const report = await runPipeline({
      ...options,
      extractor: makeExtractor(() => {
        throw new Error('호출되면 안 됩니다');
      }),
    });

    expect(report.sourcesRun).toBe(0);
    expect(report.collected).toBe(0);
  });

  it('연락처 없는 User-Agent 설정을 거부한다', async () => {
    const badSources = path.join(dir, 'bad.json');
    await writeFile(
      badSources,
      JSON.stringify({ userAgent: 'bot', requestIntervalMs: 0, timeoutMs: 1000, sources: [] }),
    );

    await expect(
      runPipeline({
        sourcesPath: badSources,
        dealsPath: await writeDeals(),
        reviewDir: path.join(dir, 'review'),
        write: false,
        maxItems: 10,
        now: NOW,
        log: () => {},
      }),
    ).rejects.toThrow(/userAgent/);
  });

  it('maxItems 범위를 벗어난 소스 설정을 거부한다', async () => {
    await expect(
      runPipeline({
        sourcesPath: await writeSources([
          { id: 'demo', name: 'x', kind: 'fixture', url: 'x', enabled: true, maxItems: 999 },
        ]),
        dealsPath: await writeDeals(),
        reviewDir: path.join(dir, 'review'),
        write: false,
        maxItems: 10,
        now: NOW,
        log: () => {},
      }),
    ).rejects.toThrow(/maxItems/);
  });
});

describe('formatReport', () => {
  it('실행 요약과 추정 비용을 만든다', () => {
    const text = formatReport({
      startedAt: '2026-08-23T00:00:00.000Z',
      finishedAt: '2026-08-23T00:00:10.000Z',
      sourcesRun: 2,
      collected: 5,
      extracted: 3,
      rejected: 2,
      added: 1,
      updated: 2,
      unchanged: 0,
      reviewQueued: 1,
      usage: {
        inputTokens: 100_000,
        outputTokens: 10_000,
        cachedInputTokens: 80_000,
        costUsd: null,
        unpricedCalls: 0,
      },
      errors: [],
    });

    expect(text).toContain('수집        5건');
    expect(text).toContain('추출 성공   3건');
    expect(text).toContain('10.0초');

    /*
      프로바이더가 비용을 알려주지 않았으면 **금액을 만들어 내지 않습니다.**
      예전에는 Claude 단가로 추정했는데, Gemini 실행에 "추정 비용 $0.1046" 이
      찍혔습니다. 무료 등급이라 0 인 실행에 요금이 있는 것처럼 보였습니다.
      "유료로 돌리지 않는다"가 전제인 프로젝트라 이 오표기는 그냥 넘길 수 없습니다.
    */
    expect(text).toContain('알려주지 않음');
    expect(text).not.toContain('$');
  });

  it('프로바이더가 알려준 비용은 그대로 적는다', () => {
    const text = formatReport({
      startedAt: '2026-08-23T00:00:00.000Z',
      finishedAt: '2026-08-23T00:00:10.000Z',
      sourcesRun: 1,
      collected: 1,
      extracted: 1,
      rejected: 0,
      added: 1,
      updated: 0,
      unchanged: 0,
      reviewQueued: 0,
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 0,
        costUsd: 0.1234,
        unpricedCalls: 0,
      },
      errors: [],
    });

    expect(text).toContain('실제 비용   $0.1234');
  });

  it('무료 모델의 0 을 "알 수 없음"으로 뭉개지 않는다', () => {
    // 0 은 "모른다"가 아니라 "정말로 0" 입니다. null 과 구분해야 합니다.
    const text = formatReport({
      startedAt: '2026-08-23T00:00:00.000Z',
      finishedAt: '2026-08-23T00:00:01.000Z',
      sourcesRun: 1,
      collected: 1,
      extracted: 1,
      rejected: 0,
      added: 1,
      updated: 0,
      unchanged: 0,
      reviewQueued: 0,
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 0,
        costUsd: 0,
        unpricedCalls: 0,
      },
      errors: [],
    });

    expect(text).toContain('실제 비용   $0.0000');
    expect(text).not.toContain('알려주지 않음');
  });

  it('오류를 함께 표시한다', () => {
    const text = formatReport({
      startedAt: '2026-08-23T00:00:00.000Z',
      finishedAt: '2026-08-23T00:00:01.000Z',
      sourcesRun: 1,
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
      errors: [{ sourceId: 'broken', message: '연결 실패' }],
    });

    expect(text).toContain('broken');
    expect(text).toContain('연결 실패');
  });
});

describe('여러 프로바이더를 섞어 쓴 실행의 비용 표기', () => {
  const base = {
    startedAt: '2026-08-27T00:00:00.000Z',
    finishedAt: '2026-08-27T00:00:10.000Z',
    sourcesRun: 1,
    collected: 50,
    extracted: 27,
    rejected: 23,
    added: 21,
    updated: 6,
    unchanged: 0,
    reviewQueued: 14,
    errors: [],
  };

  it('일부만 비용을 알려줬으면 전체인 척하지 않는다', () => {
    /*
      체인은 프로바이더를 섞어 씁니다.
      Gemini(비용 미보고) 40건 + OpenRouter(0 보고) 10건이면
      합계는 0 이지만 그건 10건만의 값입니다.
      "실제 비용 $0.0000" 이라고만 적으면 40건이 빠진 걸 알 수 없습니다.
    */
    const text = formatReport({
      ...base,
      usage: {
        inputTokens: 79_774,
        outputTokens: 62_516,
        cachedInputTokens: 7_680,
        costUsd: 0,
        unpricedCalls: 40,
      },
    });

    expect(text).toContain('$0.0000');
    expect(text).toContain('40건은 알려주지 않음');
  });

  it('전부 알려줬으면 단서를 붙이지 않는다', () => {
    const text = formatReport({
      ...base,
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 0,
        costUsd: 1.2682,
        unpricedCalls: 0,
      },
    });

    expect(text).toContain('실제 비용   $1.2682');
    expect(text).not.toContain('알려주지 않음');
  });
});

describe('상한을 소스끼리 나눠 갖기', () => {
  function items(sourceId: string, count: number): RawItem[] {
    return Array.from({ length: count }, (_, i) => ({
      sourceId,
      sourceName: sourceId,
      url: `https://${sourceId}.test/${i}`,
      text: '본문',
      collectedAt: '2026-09-02T00:00:00+09:00',
    }));
  }

  function countBySource(picked: RawItem[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const item of picked) counts[item.sourceId] = (counts[item.sourceId] ?? 0) + 1;
    return counts;
  }

  it('뒤쪽 소스가 굶지 않는다', () => {
    /*
      앞에서부터 자르면 상한을 먼저 수집된 소스가 다 씁니다.
      실제로 카드고릴라(74~118만원 카드 캐시백)를 붙였는데 한 건도 처리되지
      않았습니다. 설정 맨 뒤라 앞의 네 소스가 30건을 다 채운 탓입니다.
      한 번의 사고가 아니라 매 실행 반복되는 구조입니다.
    */
    const collected = [
      ...items('a', 15),
      ...items('b', 10),
      ...items('c', 10),
      ...items('d', 10),
      ...items('valuable', 6),
    ];

    const picked = shareAcrossSources(collected, 30);
    const counts = countBySource(picked);

    expect(picked).toHaveLength(30);
    expect(counts.valuable ?? 0).toBeGreaterThan(0);
    // 항목 수가 적은 소스는 가진 만큼 전부 들어갑니다.
    expect(counts.valuable).toBe(6);
  });

  it('항목이 적은 소스가 바닥나면 남은 몫을 나머지가 이어받는다', () => {
    const collected = [...items('few', 2), ...items('many', 20)];

    const picked = shareAcrossSources(collected, 10);
    const counts = countBySource(picked);

    expect(picked).toHaveLength(10);
    expect(counts.few).toBe(2);
    expect(counts.many).toBe(8);
  });

  it('상한이 전체보다 크면 전부 담는다', () => {
    const collected = [...items('a', 3), ...items('b', 2)];

    expect(shareAcrossSources(collected, 100)).toHaveLength(5);
  });

  it('상한이 0 이하면 아무것도 담지 않는다', () => {
    expect(shareAcrossSources(items('a', 5), 0)).toEqual([]);
    expect(shareAcrossSources(items('a', 5), -1)).toEqual([]);
  });

  it('소스가 하나면 순서를 그대로 유지한다', () => {
    const collected = items('only', 5);
    const picked = shareAcrossSources(collected, 3);

    expect(picked.map((i) => i.url)).toEqual(collected.slice(0, 3).map((i) => i.url));
  });
});

describe('제목에서 금액 어림잡기', () => {
  it('한국식 단위를 읽는다', () => {
    expect(guessAmount('최대 85만원 캐시백 이벤트 KB국민카드 5종')).toBe(850_000);
    expect(guessAmount('최대 2.6만원 할인')).toBe(26_000);
    expect(guessAmount('총 상금 5,000만원')).toBe(50_000_000);
    expect(guessAmount('네이버페이 23,340원 적립')).toBe(23_340);
    expect(guessAmount('1억원 상당')).toBe(100_000_000);
  });

  it('여러 금액이 있으면 가장 큰 값을 쓴다', () => {
    // "월 최대 할인한도 2만 5천 + 프로모션 1천" 처럼 조각이 섞여 나옵니다.
    expect(guessAmount('아정당 우리카드 월납 최대 2.6만원 할인 월 최대 할인한도 2만 5천')).toBe(
      26_000,
    );
  });

  it('금액이 없으면 0', () => {
    expect(guessAmount('연회비 100% 캐시백 우리카드 11종')).toBe(0);
    expect(guessAmount(undefined)).toBe(0);
    expect(guessAmount('')).toBe(0);
  });

  it('1억을 넘는 값은 무시한다', () => {
    /*
      개인이 받는 혜택일 리 없습니다. 대개 "예산 149조" 같은 기사 제목인데,
      그대로 두면 진짜 혜택을 밀어내고 목록 맨 앞을 차지합니다.
    */
    expect(guessAmount('복지부 내년 예산 149조 원')).toBe(0);
    expect(guessAmount('문체부 예산 첫 9조 원 돌파')).toBe(0);
  });
});

describe('값이 큰 것부터 처리하기', () => {
  function item(sourceId: string, title: string, i: number): RawItem {
    return {
      sourceId,
      sourceName: sourceId,
      url: `https://${sourceId}.test/${i}`,
      title,
      text: '본문',
      collectedAt: '2026-09-05T00:00:00+09:00',
    };
  }

  it('목록 순서가 아니라 금액 순으로 예산을 쓴다', () => {
    /*
      실제 아정당 카드 이벤트 목록 순서입니다.
      앞 세 건이 저액이고 85만원짜리는 네 번째라, 소스가 여럿이고
      상한이 빠듯하면 그 85만원 건은 매 실행 한 번도 처리되지 않았습니다.
    */
    const collected = [
      item('ajd', '아정당 우리카드 월납 최대 2.6만원 할인', 0),
      item('ajd', '월 최대 4만원 혜택 NH농협 렌탈 제휴카드 2종', 1),
      item('ajd', '월 최대 2.9만원 혜택 NH농협 통신 제휴카드 3종', 2),
      item('ajd', '최대 85만원 캐시백 이벤트 KB국민카드 5종', 3),
      item('ajd', '최대 80만원 캐시백 에너지플러스 현대카드', 4),
    ];

    const picked = shareAcrossSources(collected, 2);

    expect(picked.map((i) => i.title)).toEqual([
      '최대 85만원 캐시백 이벤트 KB국민카드 5종',
      '최대 80만원 캐시백 에너지플러스 현대카드',
    ]);
  });

  it('소스별 몫은 그대로 지킨다', () => {
    // 금액 우선순위가 소스 간 공평 배분을 무너뜨리면 안 됩니다.
    const collected = [
      item('big', '최대 85만원 캐시백', 0),
      item('big', '최대 80만원 캐시백', 1),
      item('big', '최대 76만원 캐시백', 2),
      item('small', '3,000원 할인', 0),
      item('small', '2,000원 할인', 1),
    ];

    const picked = shareAcrossSources(collected, 4);
    const bySource = picked.reduce<Record<string, number>>((acc, i) => {
      acc[i.sourceId] = (acc[i.sourceId] ?? 0) + 1;
      return acc;
    }, {});

    expect(bySource.big).toBe(2);
    expect(bySource.small).toBe(2);
  });
});

describe('할인율 어림잡기', () => {
  it('퍼센트를 읽는다', () => {
    expect(guessDiscountRate('무신사 LEE 패딩 머플러 82% 할인 (쿠폰 적용)')).toBe(82);
    expect(guessDiscountRate('스팀 메가맨 컴플리트 팩 69% 할인')).toBe(69);
    expect(guessDiscountRate('토스 25%할인+6.1%적립')).toBe(25);
  });

  it('숫자로 적히지 않는 관용 표현도 읽는다', () => {
    expect(guessDiscountRate('버거킹 와퍼 반값 행사')).toBe(50);
    expect(guessDiscountRate('카스 제로 1+1')).toBe(50);
    expect(guessDiscountRate('편의점 2+1 행사')).toBe(33);
  });

  it('100%는 할인이 아니라 증정으로 본다', () => {
    // 금액 쪽(guessAmount)에서 다룹니다. 여기서 잡으면 무료 항목이
    // 전부 최고 할인율로 올라가 진짜 "반값" 상품을 밀어냅니다.
    expect(guessDiscountRate('[iOS] Widgetik 100% 무료')).toBe(0);
  });

  it('할인 표현이 없으면 0', () => {
    expect(guessDiscountRate('KB국민카드 최대 85만원 캐시백')).toBe(0);
    expect(guessDiscountRate(undefined)).toBe(0);
  });
});

describe('반값 상품을 먼저 처리한다', () => {
  function item(title: string, i: number): RawItem {
    return {
      sourceId: 'board',
      sourceName: '게시판',
      url: `https://board.test/${i}`,
      title,
      text: '본문',
      collectedAt: '2026-09-05T00:00:00+09:00',
    };
  }

  it('금액이 없어도 고할인이면 앞에 온다', () => {
    /*
      할인 상품은 제목에 절약액이 아니라 판매가가 적히거나 아예 금액이 없습니다.
      금액만으로 줄 세우면 guessAmount 가 0 을 돌려줘,
      상한만 큰 카드 이벤트에 자리를 뺏기고 한 번도 처리되지 않습니다.
      사용자가 원한 것이 바로 이 항목들입니다.
    */
    const picked = shareAcrossSources(
      [
        item('KB국민카드 5종 최대 85만원 캐시백 이벤트', 0),
        item('무신사 LEE 패딩 머플러 82% 할인', 1),
      ],
      1,
    );

    expect(picked[0]?.title).toBe('무신사 LEE 패딩 머플러 82% 할인');
  });

  it('고할인끼리는 금액이 큰 것부터', () => {
    const picked = shareAcrossSources(
      [
        item('의류 70% 할인 3만원', 0),
        item('가전 65% 할인 40만원', 1),
        item('간식 55% 할인 5천원', 2),
      ],
      3,
    );

    expect(picked.map((i) => i.title?.slice(0, 2))).toEqual(['가전', '의류', '간식']);
  });

  it('반값 미만끼리는 금액 순서를 유지한다', () => {
    const picked = shareAcrossSources(
      [item('30% 할인 1만원', 0), item('최대 85만원 캐시백', 1)],
      2,
    );

    expect(picked[0]?.title).toBe('최대 85만원 캐시백');
  });
});

describe('완전 무료 판정', () => {
  it('무료 표현을 잡는다', () => {
    expect(looksFree('[iOS] Widgetik 홈 화면 위젯 일시 무료')).toBe(true);
    expect(looksFree('에픽게임즈 이번주 무료게임')).toBe(true);
    expect(looksFree('스타벅스 아메리카노 공짜 쿠폰')).toBe(true);
    expect(looksFree('Free Game of the Week')).toBe(true);
    expect(looksFree('100% 무료 배포')).toBe(true);
  });

  it('"100% 당첨" 같은 표현은 무료가 아니다', () => {
    // 100% 는 신호로 쓰지 않습니다. "100% 무료"는 이미 "무료"가 잡고,
    // 당첨 룰렛까지 끌어와 진짜 무료를 밀어냅니다.
    expect(looksFree('신한 슈퍼SOL 100% 당첨 룰렛 이벤트')).toBe(false);
    expect(looksFree('100% 페이백 이벤트')).toBe(false);
  });

  it('"무료배송"은 상품이 공짜라는 뜻이 아니다', () => {
    /*
      핫딜 제목에 "무배"·"무료배송"이 매우 흔합니다.
      이걸 무료로 세면 목록의 절반이 최우선 층으로 올라가 진짜 무료가 묻힙니다.
    */
    expect(looksFree('네이버 국내산 닭발 300g 3팩 (14,500원/무료배송)')).toBe(false);
    expect(looksFree('대원샵 균일가 10,000원 무배')).toBe(false);
    expect(looksFree('배송비 무료 이벤트')).toBe(false);
  });

  it('무료 표현이 없으면 false', () => {
    expect(looksFree('KB국민카드 최대 85만원 캐시백')).toBe(false);
    expect(looksFree('삼성 75인치 TV 64% 할인')).toBe(false);
    expect(looksFree(undefined)).toBe(false);
  });
});

describe('무료가 우선순위에서 밀리지 않는다', () => {
  function item(title: string, i: number): RawItem {
    return {
      sourceId: 'board',
      sourceName: '게시판',
      url: `https://board.test/${i}`,
      title,
      text: '본문',
      collectedAt: '2026-09-06T00:00:00+09:00',
    };
  }

  it('금액이 큰 항목보다 무료를 먼저 태운다', () => {
    /*
      무료는 금액이 0 이고 할인율도 안 잡혀 우선순위 최하위였습니다.
      그래서 82건을 모으고도 dealType 이 free 인 것이 0건이었습니다.
      "줍딜"의 핵심 컨셉인데 한 건도 못 담았습니다.
    */
    const picked = shareAcrossSources(
      [item('KB국민카드 5종 최대 85만원 캐시백', 0), item('[iOS] Widgetik 위젯 앱 일시 무료', 1)],
      1,
    );

    expect(picked[0]?.title).toContain('무료');
  });

  it('반값 상품보다도 무료가 먼저다', () => {
    const picked = shareAcrossSources(
      [item('무신사 패딩 82% 할인', 0), item('에픽게임즈 무료게임 배포', 1)],
      1,
    );

    expect(picked[0]?.title).toContain('무료게임');
  });

  it('무료끼리는 금액이 큰 것부터', () => {
    const picked = shareAcrossSources(
      [item('앱 무료 배포', 0), item('30만원 상당 무료 증정', 1)],
      2,
    );

    expect(picked[0]?.title).toContain('30만원');
  });
});
