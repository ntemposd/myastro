# myastro/astro.config.mjs
import { defineConfig } from 'astro/config'
import tailwind from '@astrojs/tailwind'
export default defineConfig({
  site: 'https://ntemposd.github.io',
  base: '/',            // root
  output: 'static',
  integrations: [tailwind()],
})
