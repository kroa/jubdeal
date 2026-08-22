import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'jubdeal-theme';

/** 저장된 선택이 없으면 시스템 설정을 따릅니다. */
export function resolveInitialTheme(stored: string | null, prefersDark: boolean): Theme {
  if (stored === 'light' || stored === 'dark') return stored;
  return prefersDark ? 'dark' : 'light';
}

/** 프라이빗 모드 등에서 localStorage 접근이 막혀도 앱이 죽지 않도록 감쌉니다. */
function readStoredTheme(): string | null {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* 저장 실패는 무시 — 이번 세션 동안만 적용됩니다 */
  }
}

/**
 * 다크모드 토글 (React 아일랜드)
 *
 * 설계상 중요한 두 가지:
 *
 * 1. **아이콘·상태 문구를 React state 가 아니라 CSS 로 결정합니다.**
 *    서버 HTML은 항상 같은 마크업이어야 하는데, 실제 테마는 `<head>` 인라인
 *    스크립트가 페인트 전에 정해 버립니다. 아이콘을 state 로 그리면 다크 사용자에게
 *    ☀️ 가 뜨고 스크린리더가 "다크 모드로 전환"이라 잘못 읽습니다.
 *    두 상태를 모두 렌더해 두고 `[data-theme]` 로 하나만 보이게 하면
 *    JS 도착 전에도 표시가 정확합니다. (스타일은 components.css 참고)
 *
 * 2. **사용자가 직접 누른 경우에만 localStorage 에 씁니다.**
 *    마운트만으로 시스템 테마를 저장해 버리면, 나중에 OS 테마가 바뀌어도
 *    저장값이 "사용자 선택"으로 취급되어 사이트만 옛 테마에 묶입니다.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light');
  const [mounted, setMounted] = useState(false);
  /** 사용자가 명시적으로 고른 적이 있는지 (저장값을 신뢰할지 판단) */
  const [hasExplicitChoice, setHasExplicitChoice] = useState(false);

  useEffect(() => {
    const stored = readStoredTheme();
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    setTheme(resolveInitialTheme(stored, prefersDark));
    setHasExplicitChoice(stored === 'light' || stored === 'dark');
    setMounted(true);
  }, []);

  // DOM 반영만 담당합니다. 저장은 클릭 핸들러에서만 합니다.
  useEffect(() => {
    if (!mounted) return;
    document.documentElement.dataset.theme = theme;
  }, [theme, mounted]);

  // 사용자가 고른 적이 없다면 OS 테마 변경을 그대로 따라갑니다.
  useEffect(() => {
    if (!mounted || hasExplicitChoice) return;

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setTheme(event.matches ? 'dark' : 'light');

    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, [mounted, hasExplicitChoice]);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      writeStoredTheme(next);
      return next;
    });
    setHasExplicitChoice(true);
  }, []);

  return (
    <button
      type="button"
      className="theme-toggle"
      // 라벨을 테마에 따라 바꾸면 SSR HTML 과 실제 테마가 어긋납니다.
      // 상태와 무관한 고정 문구를 쓰고, 현재 상태는 아래 sr-only 문구가 알려 줍니다.
      aria-label="테마 전환"
      title="테마 전환"
      onClick={toggle}
    >
      <span className="theme-toggle__face theme-toggle__face--light" aria-hidden="true">
        ☀️
      </span>
      <span className="theme-toggle__face theme-toggle__face--dark" aria-hidden="true">
        🌙
      </span>
      <span className="sr-only theme-toggle__face theme-toggle__face--light">현재 라이트 모드</span>
      <span className="sr-only theme-toggle__face theme-toggle__face--dark">현재 다크 모드</span>
    </button>
  );
}

export default ThemeToggle;
