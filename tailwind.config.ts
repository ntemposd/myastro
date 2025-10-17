import type { Config } from 'tailwindcss';
import typography from '@tailwindcss/typography';

const config: Config = {
  content: [
    './src/**/*.{astro,html,js,jsx,ts,tsx,vue,svelte,md,mdx}', // ⬅️ required
  ],
  darkMode: 'class', // ⬅️ you're already using this correctly
  theme: {
    extend: {
      // You can customize here if needed later
    },
  },
  plugins: [
    typography, // ⬅️ this loads @tailwindcss/typography correctly
  ],
};

export default config;
