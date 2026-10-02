"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { THEME_STORAGE_KEY } from "./theme-script";

export type Theme = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// Reads the CURRENT state of the <html> element's class (already set,
// synchronously, by the inline theme-script.ts before this component
// ever mounts - see app/layout.tsx) rather than re-reading
// localStorage itself, so there is exactly ONE source of truth for
// "what theme is active right now" and no possibility of this
// component's initial state disagreeing with what's already painted.
function readInitialTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Lazy initializer runs on the client during the first render -
  // matches what the inline script already applied, so there is no
  // hydration mismatch (the server-rendered HTML never contains a
  // theme-dependent class in the first place; only this provider's
  // OWN re-renders after mount ever change `document.documentElement`
  // further, via toggleTheme()).
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // localStorage can throw (private browsing, blocked storage) -
      // the theme still applies for this page view via the class
      // above, it just won't persist across a reload.
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
