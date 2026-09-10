'use client';
import { useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { THEME_KEY, THEME_EVENT, type Theme } from '@/lib/theme';

function getTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}
function getServerTheme(): Theme {
  return 'dark';
}
function subscribe(onChange: () => void) {
  function syncOtherTab(event: StorageEvent) {
    if (event.key !== THEME_KEY && event.key !== null) return;
    document.documentElement.dataset.theme =
      event.newValue === 'light' ? 'light' : 'dark';
    onChange();
  }
  window.addEventListener(THEME_EVENT, onChange);
  window.addEventListener('storage', syncOtherTab);
  return () => {
    window.removeEventListener(THEME_EVENT, onChange);
    window.removeEventListener('storage', syncOtherTab);
  };
}
function selectTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* The switch still works when storage is unavailable. */
  }
  window.dispatchEvent(new Event(THEME_EVENT));
}
export function ThemeSwitch() {
  const theme = useSyncExternalStore(subscribe, getTheme, getServerTheme);
  return (
    <fieldset className="theme-switch">
      <legend className="sr-only">Website appearance</legend>
      <Button
        variant="ghost"
        className="theme-choice"
        aria-pressed={theme === 'light'}
        onClick={() => selectTheme('light')}
        title="Use a lighter background"
      >
        <Sun size={14} />
        <span>Light</span>
      </Button>
      <Button
        variant="ghost"
        className="theme-choice"
        aria-pressed={theme === 'dark'}
        onClick={() => selectTheme('dark')}
        title="Use a darker background"
      >
        <Moon size={14} />
        <span>Dark</span>
      </Button>
    </fieldset>
  );
}
