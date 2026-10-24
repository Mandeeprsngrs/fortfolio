// @ts-check
import { defineConfig } from 'astro/config';

// Fully static output (the default). `astro build` writes plain HTML/JS/CSS
// into dist/, which any static host can serve — no Node process needed.
//
// GitHub Pages serves this repo at https://mandeeprsngrs.github.io/fortfolio/,
// so every URL needs the /fortfolio prefix. `base` adds it to Astro's own
// output; src/scripts/asset.ts adds it to the files our scripts load.
// If the repo is renamed, or the site moves to its own domain, change these two.
export default defineConfig({
  site: 'https://mandeeprsngrs.github.io',
  base: '/fortfolio',
});
