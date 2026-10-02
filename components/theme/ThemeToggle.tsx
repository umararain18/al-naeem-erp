"use client";

import { Sun, Moon } from "lucide-react";
import { useTheme } from "./ThemeProvider";

/**
 * Single global Light/Dark toggle - lives in AppSidebar's own brand
 * header bar (the existing global navigation area), so it renders on
 * every page including the login screen (AppSidebar always renders,
 * authenticated or not - see app/layout.tsx).
 */
export default function ThemeToggle({ collapsed }: { collapsed?: boolean }) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? "Switch to Light Mode" : "Switch to Dark Mode"}
      title={isDark ? "Switch to Light Mode" : "Switch to Dark Mode"}
      className="flex items-center justify-center w-8 h-8 rounded-md hover:bg-gray-800 text-gray-400 hover:text-white flex-shrink-0"
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      {!collapsed && <span className="sr-only">{isDark ? "Light Mode" : "Dark Mode"}</span>}
    </button>
  );
}
