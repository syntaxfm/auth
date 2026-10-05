import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// SvelteKit's cross-site form check can't exempt a path, and it refused native OAuth
		// clients' token requests. hooks.server.ts runs the same check on every other path
		// (src/lib/server/cross_site_forms.ts), so this turns off only SvelteKit's copy.
		csrf: { trustedOrigins: ['*'] },
		adapter: adapter({
			// `vite dev` reads the committed `local` Wrangler env; deploys use the top-level config.
			platformProxy: { environment: 'local' }
		})
	}
};

export default config;
