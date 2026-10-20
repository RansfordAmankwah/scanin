import { useState } from 'react';
import { getTheme, setTheme, type Theme } from './theme';

const ORDER: Theme[] = ['system', 'light', 'dark'];
const LABEL: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };

function Icon({ theme }: { theme: Theme }) {
  const common = {
    viewBox: '0 0 24 24',
    width: 18,
    height: 18,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (theme === 'light') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  if (theme === 'dark') {
    return (
      <svg {...common}>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    );
  }
  // system: half sun / half moon
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Cycles the app theme: System → Light → Dark. The choice is remembered per browser. */
export function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(() => getTheme());
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]!;
  const cycle = () => {
    setTheme(next);
    setThemeState(next);
  };
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={cycle}
      aria-label={`Theme: ${LABEL[theme]}. Switch to ${LABEL[next]}.`}
      title={`Theme: ${LABEL[theme]}`}
    >
      <Icon theme={theme} />
      <span className="visually-hidden">Theme: {LABEL[theme]}</span>
    </button>
  );
}
