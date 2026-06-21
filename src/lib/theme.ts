const THEMES = [
  "mocha", "latte", "macchiato", "frappe",
  "kanagawa", "ayu", "rose-pine", "claude", "codex", "matcha",
] as const;

export type Theme = typeof THEMES[number];

const STORAGE_KEY = "tbox-theme";

export function initTheme(): void {
  const saved = localStorage.getItem(STORAGE_KEY) as Theme | null;
  const theme: Theme = saved && (THEMES as readonly string[]).includes(saved)
    ? (saved as Theme)
    : "mocha";
  document.documentElement.setAttribute("data-theme", theme);
}

export function getCurrentTheme(): Theme {
  const saved = localStorage.getItem(STORAGE_KEY) as Theme | null;
  return saved && (THEMES as readonly string[]).includes(saved)
    ? (saved as Theme)
    : "mocha";
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme);
  document.documentElement.setAttribute("data-theme", theme);
}

export function cycleTheme(): Theme {
  const current = getCurrentTheme();
  const idx = THEMES.indexOf(current);
  const next = THEMES[(idx + 1) % THEMES.length];
  setTheme(next);
  return next;
}

export { THEMES };
