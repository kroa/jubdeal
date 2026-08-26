import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 다크 팔레트 이중 정의 회귀 테스트
 * ---------------------------------------------------------------------------
 * global.css 는 다크 값을 두 곳에 씁니다.
 *
 *   1) @media (prefers-color-scheme: dark) :root:not([data-theme='light'])  ← JS 꺼짐
 *   2) :root[data-theme='dark']                                            ← 수동 토글
 *
 * 하나로 합칠 수 없는 이유는 (1)이 미디어쿼리 안이라서입니다.
 * 그래서 한쪽만 고치는 실수가 나기 쉽고, 그러면 토글로 바꾼 다크와
 * 시스템 다크의 색이 서로 달라집니다. 눈으로는 잘 안 보이는 종류의 버그라
 * 여기서 기계적으로 비교합니다.
 */

const CSS = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8');

/** `--이름: 값;` 을 모두 뽑아 Map 으로 */
function parseTokens(block: string): Map<string, string> {
  const tokens = new Map<string, string>();

  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    const [, name, value] = match;
    if (name && value) tokens.set(name, value.replace(/\s+/g, ' ').trim());
  }

  return tokens;
}

/** 셀렉터로 시작하는 규칙의 본문을 중괄호 균형으로 잘라 냅니다. */
function extractRule(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `셀렉터를 찾지 못했습니다: ${selector}`).toBeGreaterThan(-1);

  const open = css.indexOf('{', start);
  let depth = 0;

  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }

  throw new Error(`중괄호가 닫히지 않았습니다: ${selector}`);
}

const mediaDark = parseTokens(extractRule(CSS, ":root:not([data-theme='light'])"));
const toggleDark = parseTokens(extractRule(CSS, ":root[data-theme='dark']"));

describe('다크 팔레트 두 블록', () => {
  it('둘 다 토큰을 실제로 담고 있다', () => {
    // 파서가 헛돌아 빈 Map 두 개를 비교하며 통과하는 상황을 막습니다.
    expect(mediaDark.size).toBeGreaterThan(30);
    expect(toggleDark.size).toBeGreaterThan(30);
  });

  it('정의하는 토큰 목록이 같다', () => {
    expect([...toggleDark.keys()].sort()).toEqual([...mediaDark.keys()].sort());
  });

  it('모든 토큰 값이 같다', () => {
    for (const [name, value] of mediaDark) {
      expect(toggleDark.get(name), `${name} 값이 두 블록에서 다릅니다`).toBe(value);
    }
  });

  it('color-scheme 을 dark 로 선언한다', () => {
    expect(mediaDark.get('--bg')).toBeDefined();
    expect(extractRule(CSS, ":root:not([data-theme='light'])")).toContain('color-scheme: dark');
    expect(extractRule(CSS, ":root[data-theme='dark']")).toContain('color-scheme: dark');
  });
});

describe('라이트 팔레트', () => {
  it('다크에서 재정의하는 토큰을 빠짐없이 먼저 정의한다', () => {
    // 라이트에 없는 토큰을 다크에서만 정의하면 라이트 모드에서 값이 비어 버립니다.
    const light = parseTokens(CSS.slice(0, CSS.indexOf('@media (prefers-color-scheme: dark)')));

    const missing = [...mediaDark.keys()].filter((name) => !light.has(name));
    expect(missing, `라이트 팔레트에 없는 토큰: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('컴포넌트 스타일', () => {
  const COMPONENTS = readFileSync(resolve(process.cwd(), 'src/styles/components.css'), 'utf8');

  it('색을 하드코딩하지 않는다', () => {
    /*
      토큰을 우회해 hex 색을 직접 쓰면 다크모드에서 그대로 남아 깨집니다.
      예외는 #ffffff 뿐입니다. 어두운 그라디언트(--gradient-cta) 위의 글자색은
      테마와 무관하게 항상 흰색이어야 대비가 유지됩니다.
    */
    /*
      mask 선언은 제외합니다. 거기 쓰인 색은 화면에 보이지 않는 스텐실이고
      (알파만 의미가 있음) 관례적으로 #000 을 씁니다.
    */
    const scannable = COMPONENTS.replace(/(?:-webkit-)?mask(?:-composite)?\s*:[^;]+;/g, '');

    const hexes = [...scannable.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((match) => match[0]);
    const unexpected = hexes.filter((hex) => hex.toLowerCase() !== '#ffffff');

    expect(unexpected, `토큰 대신 하드코딩된 색: ${unexpected.join(', ')}`).toEqual([]);
  });

  it('모션을 최소화 설정에서 끌 수 있게 keyframes 로만 움직인다', () => {
    // 스크롤 연동 애니메이션은 prefers-reduced-motion 안에서만 켜져야 합니다.
    const scrollBlocks = [...COMPONENTS.matchAll(/animation-timeline:/g)];
    expect(scrollBlocks.length).toBeGreaterThan(0);

    const guard = COMPONENTS.indexOf('@media (prefers-reduced-motion: no-preference)');
    expect(guard).toBeGreaterThan(-1);

    for (const match of scrollBlocks) {
      expect(match.index, '스크롤 연동 애니메이션이 모션 가드 밖에 있습니다').toBeGreaterThan(
        guard,
      );
    }
  });
});
