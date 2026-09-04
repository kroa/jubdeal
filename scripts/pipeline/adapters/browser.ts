import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  alignScheme,
  clampText,
  fetchBudgetFor,
  isSameSite,
  normalizeWhitespace,
  stripQueryParams,
} from '@pipeline/adapters/index';
import type { CollectContext, RawItem, SourceAdapter, SourceConfig } from '@pipeline/types';

/**
 * 브라우저 어댑터 — JS 로 그리는 목록을 읽습니다
 * ---------------------------------------------------------------------------
 * 진짜 값이 큰 혜택(카드 발급 캐시백 87~118만원, 체험단 무료 증정)은
 * 전부 SPA 에 있습니다. HTML 만 받아서는 빈 껍데기가 옵니다.
 * (레뷰는 6KB 에 캠페인 링크 0개, 카드고릴라는 8KB 에 이벤트 0개였습니다.)
 *
 * 그래서 이 어댑터만 실제 브라우저를 띄웁니다. 대가가 분명하므로
 * **꼭 필요한 소스에만** 씁니다. html·rss 로 되는 곳에 쓰지 마세요.
 *
 *   - 브라우저 기동이 느립니다. 소스당 한 번만 띄우고 재사용합니다.
 *   - 셀렉터가 개편에 잘 깨집니다. 목록이 0건이면 조용히 넘어가지 않고 알립니다.
 *   - 리소스를 많이 씁니다. 이미지·폰트·미디어는 아예 받지 않습니다.
 *
 * robots.txt·레이트리밋은 **우회하지 않습니다.**
 * Playwright 가 네트워크를 담당해 PoliteFetcher 를 거치지 않으므로,
 * 페이지를 열기 전에 `assertAllowed` 로 같은 검문을 통과시킵니다.
 */

/**
 * 본문과 무관하면서 무거운 리소스는 아예 받지 않습니다.
 *
 * **stylesheet 는 넣지 마세요.** 무거워 보이지만 SPA 가 부팅에 실패합니다.
 * 카드고릴라에서 실제로 확인했습니다 — 차단하면 이벤트 링크는커녕
 * 페이지 전체의 `<a>` 가 0개가 됩니다(차단 안 하면 106개).
 * 오류도 나지 않고 그냥 빈 페이지라, "요즘 이벤트가 없나 보다"로 오해하기 쉽습니다.
 */
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media']);

/** 목록이 그려질 때까지 기다리는 상한 */
const SELECTOR_TIMEOUT_MS = 20_000;

/** 렌더가 끝났는지 확인하는 간격 */
const SETTLE_INTERVAL_MS = 400;

export interface BrowserAdapterOptions {
  /** 테스트에서 갈아 끼우기 위한 진입점 */
  launch?: () => Promise<Browser>;
}

export function createBrowserAdapter(options: BrowserAdapterOptions = {}): SourceAdapter {
  const launch = options.launch ?? (() => chromium.launch());

  return {
    kind: 'browser',

    async collect(source: SourceConfig, ctx: CollectContext): Promise<RawItem[]> {
      const selectors = source.selectors;
      if (!selectors?.item) {
        throw new Error(`[${source.id}] browser 어댑터에는 selectors.item 이 필요합니다.`);
      }

      // 브라우저로 열기 전에도 검문은 똑같이 받습니다.
      await ctx.assertAllowed(source.url);

      const browser = await launch();
      try {
        const context = await browser.newContext({
          userAgent: ctx.userAgent,
          viewport: { width: 1400, height: 1200 },
          locale: 'ko-KR',
        });

        await blockHeavyResources(context);

        const page = await context.newPage();
        const listed = await readList(page, source, selectors.item, ctx);

        if (listed.length === 0) {
          /*
            SPA 는 개편되면 셀렉터가 조용히 죽습니다.
            0건을 정상으로 넘기면 "요즘 혜택이 없나 보다" 로 오해하게 되므로
            소스 오류로 올려 보고서에 남깁니다.
          */
          throw new Error(
            `목록에서 항목을 찾지 못했습니다. 선택자 '${selectors.item}' 가 유효한지 확인하세요.`,
          );
        }

        return await readDetails(page, source, listed, ctx);
      } finally {
        await browser.close();
      }
    },
  };
}

interface Listed {
  url: string;
  title: string;
  listText: string;
}

/**
 * 선택자의 텍스트가 **더 이상 늘지 않을 때까지** 기다립니다.
 *
 * `waitForSelector` 만으로는 부족합니다. 요소가 DOM 에 생기면 바로 반환하는데,
 * SPA 는 껍데기를 먼저 그리고 내용을 나중에 채웁니다.
 * 카드고릴라에서 실제로 그 사이에 읽어, 서로 다른 4개 이벤트가 전부
 * 똑같은 내비게이션 텍스트 111자로 수집됐습니다.
 * 오류가 아니라 "내용이 같은 것"으로 보여 알아채기 어렵습니다.
 *
 * 길이가 두 번 연속 같으면 렌더가 끝난 것으로 봅니다.
 * networkidle 로 기다리는 방법도 있지만, 광고를 계속 폴링하는 사이트에서는
 * 영원히 오지 않습니다(퀘이사존이 그랬습니다).
 */
async function waitForStableText(page: Page, selector: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous: number | null = null;

  while (Date.now() < deadline) {
    const length = await page
      .locator(selector)
      .first()
      .innerText()
      .then((text) => text.trim().length)
      .catch(() => -1);

    /*
      길이가 0 이어도 두 번 연속 같으면 끝난 것으로 봅니다.
      "0 이 아닐 때까지" 기다리면, 글자가 없는 요소(이미지만 있는 카드 등)에서
      타임아웃을 통째로 태웁니다. 항목마다 20초씩이면 실행이 하염없이 길어집니다.
      존재 여부는 앞서 waitForSelector 가 이미 확인했으므로,
      여기서는 "더 이상 변하지 않는다"만 보면 충분합니다.
    */
    if (previous !== null && length === previous) return;

    previous = length;
    await page.waitForTimeout(SETTLE_INTERVAL_MS);
  }
}

/** 목록 페이지에서 링크·제목·요약을 긁습니다. */
async function readList(
  page: Page,
  source: SourceConfig,
  itemSelector: string,
  ctx: CollectContext,
): Promise<Listed[]> {
  await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: SELECTOR_TIMEOUT_MS * 2 });

  try {
    await page.waitForSelector(itemSelector, { timeout: SELECTOR_TIMEOUT_MS });
    await waitForStableText(page, itemSelector, SELECTOR_TIMEOUT_MS);
  } catch {
    return [];
  }

  const linkSelector = source.selectors?.link;
  const titleSelector = source.selectors?.title;

  const raw = await page.locator(itemSelector).evaluateAll(
    (elements, config) => {
      const { link, title, limit } = config as { link?: string; title?: string; limit: number };

      return elements.slice(0, limit).map((element) => {
        const anchor = link
          ? element.querySelector(link)
          : element instanceof HTMLAnchorElement
            ? element
            : element.querySelector('a');

        const titleNode = title ? element.querySelector(title) : anchor;

        return {
          href: anchor?.getAttribute('href') ?? '',
          title: (titleNode?.textContent ?? '').replace(/\s+/g, ' ').trim(),
          listText: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
        };
      });
    },
    // 목록이 길어도 필요한 만큼만 훑습니다. 상세 방문 수는 아래에서 다시 제한합니다.
    { link: linkSelector, title: titleSelector, limit: source.maxItems * 3 },
  );

  const seen = new Set<string>();
  const listed: Listed[] = [];

  for (const entry of raw) {
    if (!entry.href) continue;

    let url: string;
    try {
      url = stripQueryParams(
        alignScheme(source.url, new URL(entry.href, source.url).href),
        source.stripParams,
      );
    } catch {
      continue;
    }

    if (seen.has(url)) continue;
    seen.add(url);

    if (!isSameSite(source.url, url)) {
      ctx.log(`[${source.id}] 외부 호스트 링크를 건너뜁니다: ${url}`);
      continue;
    }

    listed.push({ url, title: entry.title, listText: entry.listText });
  }

  ctx.log(`[${source.id}] 목록에서 ${listed.length}개 항목 발견`);
  return listed;
}

/**
 * 필요하면 상세 페이지를 열어 본문을 채웁니다.
 *
 * `selectors.detail` 이 없으면 목록에 적힌 텍스트만 씁니다.
 * 카드고릴라처럼 목록에 이미 금액이 나오는 곳은 그걸로 충분하고,
 * 상세를 여는 만큼 시간과 상대 서버 부담만 늘어납니다.
 */
async function readDetails(
  page: Page,
  source: SourceConfig,
  listed: Listed[],
  ctx: CollectContext,
): Promise<RawItem[]> {
  const detailSelector = source.selectors?.detail;
  const items: RawItem[] = [];
  let budget = fetchBudgetFor(source.maxItems);

  for (const entry of listed) {
    if (items.length >= source.maxItems) break;

    let text = entry.listText;

    if (detailSelector && budget > 0) {
      budget -= 1;
      try {
        await ctx.assertAllowed(entry.url);
        await page.goto(entry.url, {
          waitUntil: 'domcontentloaded',
          timeout: SELECTOR_TIMEOUT_MS * 2,
        });
        await page.waitForSelector(detailSelector, { timeout: SELECTOR_TIMEOUT_MS });
        await waitForStableText(page, detailSelector, SELECTOR_TIMEOUT_MS);

        const detail = await page.locator(detailSelector).first().innerText();
        const normalized = normalizeWhitespace(detail);

        // 상세가 목록보다 부실하면(로그인 벽 등) 목록 쪽을 남깁니다.
        if (normalized.length > text.length) text = normalized;
      } catch (error) {
        ctx.log(
          `[${source.id}] 상세 페이지 실패, 목록 텍스트만 사용: ${entry.url} — ${String(error)}`,
        );
      }
    }

    if (text.length < 40) {
      ctx.log(`[${source.id}] 본문이 너무 짧아 건너뜁니다: ${entry.url}`);
      continue;
    }

    items.push({
      sourceId: source.id,
      sourceName: source.name,
      url: entry.url,
      title: entry.title || undefined,
      text: clampText(text),
      collectedAt: ctx.now.toISOString(),
      ...(source.categoryHint ? { categoryHint: source.categoryHint } : {}),
    });
  }

  return items;
}

/** 이미지·폰트·미디어·스타일시트는 본문과 무관하니 받지 않습니다. */
async function blockHeavyResources(context: BrowserContext): Promise<void> {
  await context.route('**/*', (route) => {
    if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) return route.abort();
    return route.continue();
  });
}
