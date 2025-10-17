import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://ntemposd.github.io', // your Pages domain
  base: '/myastro/',                   // repo subpath  ← IMPORTANT
  output: 'static',
  integrations: [tailwind()],
});
