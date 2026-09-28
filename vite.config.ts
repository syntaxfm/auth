import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	// Consumer apps point at this exact port; keep it in sync with packages/auth-local.
	server: {
		// IPv4 like the Docker container, so the two can never both hold the port.
		host: '127.0.0.1',
		port: 37960,
		strictPort: true
	},
	plugins: [sveltekit()]
});
