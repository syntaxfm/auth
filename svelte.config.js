import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({
			// `vite dev` reads the committed `local` Wrangler env; deploys use the top-level config.
			platformProxy: { environment: 'local' }
		})
	}
};

export default config;
