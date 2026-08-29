import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CSP 와 외부 리소스의 정합성
 * ---------------------------------------------------------------------------
 * 배포본에서 Pretendard 웹폰트가 CSP 에 막혀 시스템 폰트로 떨어진 적이 있습니다.
 * 로컬 개발 서버는 _headers 를 적용하지 않아 멀쩡히 보였고, 빌드도 통과했습니다.
 * **실제 배포 후 브라우저 콘솔에서만** 드러나는 종류의 결함이라 여기서 막습니다.
 *
 * 규칙은 하나입니다.
 * CSP 가 'self' 로 묶어 둔 종류의 리소스를 외부 주소로 불러오지 않는다.
 */

const ROOT = process.cwd();
const HEADERS = readFileSync(resolve(ROOT, 'public/_headers'), 'utf8');
const LAYOUT = readFileSync(resolve(ROOT, 'src/layouts/BaseLayout.astro'), 'utf8');

/** `_headers` 에서 CSP 지시문 하나를 꺼냅니다. */
function directive(name: string): string[] {
  const csp = /Content-Security-Policy:\s*(.+)/.exec(HEADERS)?.[1] ?? '';
  const found = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));

  return found ? found.slice(name.length).trim().split(/\s+/) : [];
}

describe('CSP', () => {
  it('_headers 에 CSP 가 있다', () => {
    expect(HEADERS).toContain('Content-Security-Policy:');
    expect(directive('default-src')).toContain("'self'");
  });

  it('스타일·폰트를 자기 출처로 묶어 둔다', () => {
    // 이 전제가 바뀌면 아래 검사들의 의미도 달라지므로 같이 확인합니다.
    expect(directive('style-src')).toContain("'self'");
    expect(directive('font-src')).toContain("'self'");
  });
});

describe('레이아웃이 CSP 를 어기지 않는지', () => {
  /** 문서에서 외부 호스트를 가리키는 링크/스크립트를 모두 뽑습니다. */
  function externalRefs(html: string): string[] {
    return (
      [...html.matchAll(/(?:href|src)=["'](https?:\/\/[^"']+)["']/g)]
        .map((m) => m[1] as string)
        // og:url·canonical 처럼 문서 주소를 가리키는 것은 리소스 로드가 아닙니다.
        .filter((url) => !/jubdeal\.pages\.dev/.test(url))
    );
  }

  it('스타일시트를 외부에서 불러오지 않는다', () => {
    /*
      CDN 스타일시트는 style-src 'self' 에 막힙니다.
      막히면 오류 없이 조용히 기본 폰트로 떨어지기 때문에 눈치채기 어렵습니다.
    */
    const stylesheets = [...LAYOUT.matchAll(/<link[^>]*rel=["']stylesheet["'][^>]*>/g)].map(
      (m) => m[0],
    );

    for (const tag of stylesheets) {
      expect(tag, `외부 스타일시트: ${tag}`).not.toMatch(/https?:\/\//);
    }
  });

  it('preconnect 로 외부 CDN 을 예열하지 않는다', () => {
    // 자체 호스팅으로 바꾼 뒤 남아 있으면 쓰지도 않는 연결을 미리 엽니다.
    expect(LAYOUT).not.toMatch(/rel=["']preconnect["']/);
  });

  it('레이아웃에 외부 리소스 참조가 없다', () => {
    const refs = externalRefs(LAYOUT);
    expect(refs, `외부 참조: ${refs.join(', ')}`).toEqual([]);
  });
});

describe('자체 호스팅 폰트', () => {
  const FONT_DIR = resolve(ROOT, 'public/fonts/pretendard');
  const CSS_PATH = resolve(FONT_DIR, 'pretendard.css');

  it('레이아웃이 참조하는 CSS 가 실제로 있다', () => {
    // 경로가 틀리면 404 가 나고 조용히 시스템 폰트로 떨어집니다.
    const href = /<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/.exec(LAYOUT)?.[1];
    expect(href).toBe('/fonts/pretendard/pretendard.css');
    expect(existsSync(CSS_PATH)).toBe(true);
  });

  it('CSS 가 외부 주소를 가리키지 않는다', () => {
    const css = readFileSync(CSS_PATH, 'utf8');
    const remote = [...css.matchAll(/url\(([^)]+)\)/g)]
      .map((m) => (m[1] ?? '').replace(/["']/g, ''))
      .filter((url) => /^https?:\/\//.test(url));

    expect(remote, `원격 참조: ${remote.slice(0, 3).join(', ')}`).toEqual([]);
  });

  it('CSS 가 가리키는 woff2 가 전부 존재한다', () => {
    /*
      한 조각만 빠져도 그 유니코드 범위의 글자만 다른 폰트로 렌더됩니다.
      한글 일부만 어긋나 보이는, 원인을 찾기 어려운 증상이 됩니다.
    */
    const css = readFileSync(CSS_PATH, 'utf8');
    const files = [...css.matchAll(/url\(\.\/([^)]+)\)/g)].map((m) => m[1] as string);

    expect(files.length).toBeGreaterThan(50);

    const present = new Set(readdirSync(FONT_DIR));
    const missing = files.filter((name) => !present.has(name));

    expect(missing, `없는 파일: ${missing.slice(0, 5).join(', ')}`).toEqual([]);
  });

  it('폰트에 장기 캐시 헤더를 준다', () => {
    // 파일명에 버전이 박혀 있어 내용이 바뀌지 않습니다.
    expect(HEADERS).toMatch(/\/fonts\/\*/);
  });
});
