// Files in public/ are served under the site's base path: "/" in local dev,
// "/fortfolio/" on GitHub Pages (set by `base` in astro.config.mjs). Building
// their URLs from BASE_URL lets the same code work in both places.
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
export const asset = (path: string) => `${BASE}/${path.replace(/^\//, '')}`;
