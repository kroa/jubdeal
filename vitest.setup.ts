import { afterEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

/**
 * 공통 테스트 셋업.
 *
 * 순수 로직 테스트는 `node` 환경에서, 컴포넌트 테스트는 파일 상단의
 * `// @vitest-environment jsdom` 주석으로 jsdom 환경에서 실행됩니다.
 * (jsdom 초기화 비용이 커서 필요한 파일에만 붙입니다.)
 * 따라서 DOM 관련 셋업은 window 존재 여부를 확인한 뒤 수행합니다.
 */
const isDom = typeof window !== 'undefined';

if (isDom) {
  // jsdom에 없는 matchMedia 스텁 (다크모드 토글에서 사용)
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }

  // 각 테스트 후 DOM 정리 (테스트 간 오염 방지)
  afterEach(async () => {
    const { cleanup } = await import('@testing-library/react');
    cleanup();
  });
}
