// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToString } from 'react-dom/server';
import { THEME_STORAGE_KEY, ThemeToggle, resolveInitialTheme } from '@/components/ThemeToggle';

/** matchMedia 목. OS 테마 변경을 테스트에서 직접 발생시킬 수 있게 리스너를 보관합니다. */
function mockMatchMedia(prefersDark: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  const mql = {
    matches: prefersDark,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((_: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    }),
    dispatchEvent: vi.fn(),
  };

  window.matchMedia = vi.fn().mockReturnValue(mql);

  return {
    /** OS 테마가 바뀐 것처럼 이벤트를 발생시킵니다. */
    emit(matches: boolean) {
      mql.matches = matches;
      for (const listener of listeners) {
        listener({ matches } as MediaQueryListEvent);
      }
    },
    listenerCount: () => listeners.size,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  mockMatchMedia(false);
});

afterEach(() => {
  window.localStorage.clear();
});

describe('resolveInitialTheme', () => {
  it('저장된 값이 있으면 그대로 쓴다', () => {
    expect(resolveInitialTheme('dark', false)).toBe('dark');
    expect(resolveInitialTheme('light', true)).toBe('light');
  });

  it('저장된 값이 없으면 시스템 설정을 따른다', () => {
    expect(resolveInitialTheme(null, true)).toBe('dark');
    expect(resolveInitialTheme(null, false)).toBe('light');
  });

  it('알 수 없는 값은 시스템 설정으로 대체한다', () => {
    expect(resolveInitialTheme('purple', true)).toBe('dark');
  });
});

describe('ThemeToggle — 테마 적용', () => {
  it('시스템이 다크면 마운트 후 다크로 맞춘다', () => {
    mockMatchMedia(true);
    render(<ThemeToggle />);

    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('저장된 테마를 복원한다', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    render(<ThemeToggle />);

    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('클릭하면 테마가 바뀌고 localStorage 에 저장된다', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole('button', { name: '테마 전환' }));

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('다시 클릭하면 라이트로 돌아온다', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    const button = screen.getByRole('button', { name: '테마 전환' });
    await user.click(button);
    await user.click(button);

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });
});

describe('ThemeToggle — 사용자 선택만 저장한다', () => {
  it('마운트만으로는 localStorage 에 쓰지 않는다', () => {
    render(<ThemeToggle />);

    // 마운트가 시스템 테마를 "사용자 선택"으로 굳혀 버리면,
    // 나중에 OS 테마가 바뀌어도 사이트만 옛 테마에 묶입니다.
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('시스템이 다크여도 마운트만으로는 저장하지 않는다', () => {
    mockMatchMedia(true);
    render(<ThemeToggle />);

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('사용자가 고른 적이 없으면 OS 테마 변경을 따라간다', () => {
    const media = mockMatchMedia(false);
    render(<ThemeToggle />);
    expect(document.documentElement.dataset.theme).toBe('light');

    // React 상태 업데이트를 유발하므로 act 로 감싸 flush 합니다.
    act(() => media.emit(true));

    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('사용자가 직접 고른 뒤에는 OS 테마 변경을 무시한다', async () => {
    const user = userEvent.setup();
    const media = mockMatchMedia(false);
    render(<ThemeToggle />);

    await user.click(screen.getByRole('button', { name: '테마 전환' }));
    expect(document.documentElement.dataset.theme).toBe('dark');

    act(() => media.emit(false)); // OS 가 라이트로 바뀌어도

    expect(document.documentElement.dataset.theme).toBe('dark'); // 사용자 선택 유지
  });

  it('저장된 선택이 있으면 OS 변경 리스너를 붙이지 않는다', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    const media = mockMatchMedia(false);
    render(<ThemeToggle />);

    expect(media.listenerCount()).toBe(0);
  });

  it('localStorage 접근이 막혀도 렌더와 토글이 동작한다', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole('button', { name: '테마 전환' }));
    expect(document.documentElement.dataset.theme).toBe('dark');

    getItem.mockRestore();
    setItem.mockRestore();
  });
});

describe('ThemeToggle — 서버 렌더 출력', () => {
  it('접근성 라벨이 테마와 무관하게 고정이다', () => {
    render(<ThemeToggle />);

    // 라벨을 테마에 따라 바꾸면 SSR HTML 과 인라인 스크립트가 정한 실제 테마가 어긋납니다.
    const button = screen.getByRole('button', { name: '테마 전환' });
    expect(button).toHaveAttribute('title', '테마 전환');
  });

  it('서버 렌더 결과가 라이트·다크 두 상태를 모두 포함한다', () => {
    const html = renderToString(<ThemeToggle />);

    // 어느 테마로 열리든 CSS 가 맞는 쪽만 보여주므로, 마크업에는 둘 다 있어야 합니다.
    expect(html).toContain('☀️');
    expect(html).toContain('🌙');
    expect(html).toContain('현재 라이트 모드');
    expect(html).toContain('현재 다크 모드');
    expect(html).toContain('aria-label="테마 전환"');
  });

  it('서버 렌더 결과에 테마 의존 상태 속성이 없다', () => {
    const html = renderToString(<ThemeToggle />);

    // aria-pressed 같은 값은 HTML 에 박혀 실제 테마와 어긋나므로 쓰지 않습니다.
    expect(html).not.toContain('aria-pressed');
  });
});
