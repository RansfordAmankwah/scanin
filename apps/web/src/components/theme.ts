/**
 * App theme: light, dark, or follow the system. The choice is stored per browser and applied by
 * setting data-theme on <html> (see styles/tokens.css). "system" removes the attribute and lets the
 * prefers-color-scheme media query decide. Storage is best-effort; a blocked localStorage just means
 * the choice is not remembered, and the app falls back to following the system.
 */
export type Theme = 'light' | 'dark' | 'system';

const KEY = 'scanin-theme';

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // ignore: storage unavailable
  }
  return 'system';
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
    root.style.removeProperty('color-scheme');
  } else {
    root.setAttribute('data-theme', theme);
    // Keep native controls (form fields, scrollbars) in step with the forced theme.
    root.style.colorScheme = theme;
  }
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // ignore: storage unavailable
  }
  applyTheme(theme);
}

/** Apply the saved choice as early as possible (called once from the app entry). */
export function initTheme(): void {
  applyTheme(getTheme());
}
