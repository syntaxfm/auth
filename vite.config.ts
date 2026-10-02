import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	// Consumer apps point at this exact port; keep it in sync with packages/auth-local.
	server: {
		// IPv4 like the Docker container, so the two can never both hold the port.
		host: '127.0.0.1',
		port: 37960,
		strictPort: true,
		// The local HTTPS proxy forwards this name to Syntax Auth.
		allowedHosts: ['auth.syntax.test']
	},
	preview: {
		// `vite preview` serves the Docker image. Its host check would refuse other names with advice
		// to edit this file, so let them reach src/hooks.server.ts, which refuses every host but
		// localhost and auth.syntax.test before any page or auth route and names the right address.
		allowedHosts: true
	},
	plugins: [sveltekit()]
});
