import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEAL_SCHEMA_VERSION, type DealsFile } from '@/types/deal';
import { parseDealsFile } from '@/lib/deal-schema';
import { formatReport, runPipeline } from '@pipeline/run';
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
    endDateKind: 'dated' as const,
    linkUrl: null,
    linkLabel: null,
    howTo: [],
    caution: [],
    tags: ['무료'],
    ...overrides,
  };
}

const USAGE = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 };

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
      usage: { inputTokens: 100_000, outputTokens: 10_000, cachedInputTokens: 80_000 },
      errors: [],
    });

    expect(text).toContain('수집        5건');
    expect(text).toContain('추출 성공   3건');
    expect(text).toContain('$');
    expect(text).toContain('10.0초');
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
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      errors: [{ sourceId: 'broken', message: '연결 실패' }],
    });

    expect(text).toContain('broken');
    expect(text).toContain('연결 실패');
  });
});
