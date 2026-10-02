// Anti-flash-of-wrong-theme script, run synchronously before paint
// (see app/layout.tsx, where this is inlined into <head> via
// dangerouslySetInnerHTML - it must stay a plain string of JS, no
// imports/bundling, so it can execute before React hydrates).
//
// Default is Light Mode (per spec: "Preserve the current Light Mode
// as the default behavior for existing users unless an existing
// theme preference exists") - this NEVER reads prefers-color-scheme;
// it only ever turns Dark Mode on when localStorage explicitly says
// so, exactly mirroring what ThemeProvider does after hydration.
export const THEME_STORAGE_KEY = "anc-erp-theme";

export const themeInitScript = `
(function () {
  try {
    var theme = localStorage.getItem('${THEME_STORAGE_KEY}');
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    }
  } catch (e) {}
})();
`;
