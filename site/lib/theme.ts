export type Theme = 'light' | 'dark';
export const THEME_KEY = 'deskfish.theme';
export const THEME_EVENT = 'deskfish:theme-change';
// Runs in <head> before the page paints. The server and no-JS default is dark.
export const THEME_BOOTSTRAP = `(()=>{try{const theme=localStorage.getItem('${THEME_KEY}');document.documentElement.dataset.theme=theme==='light'?'light':'dark'}catch{}})();`;
