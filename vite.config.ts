import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Connect, type Plugin } from 'vite';

import { syntax_auth } from './packages/auth-local/index.js';

import {
	SYNTAX_TEST_AUTH_HOSTNAME,
	get_host_header_hostname,
	is_local_hostname,
	local_host_refusal
} from './src/lib/utils/local_hosts';

// `vite dev` and `vite preview` (the Docker image) serve local Syntax Auth. They answer health
// checks and built files before src/hooks.server.ts runs, and Vite's own host check lets through
// any IP address and *.localhost, so this refuses every other host first, with the hook's text.
// Deploys run on Cloudflare Workers without Vite; the hook still checks every other request.
function refuse_other_hosts(): Plugin {
	const refuse: Connect.NextHandleFunction = (request, response, next) => {
		const hostname = get_host_header_hostname(request.headers.host);
		if (is_local_hostname(hostname)) return next();

		response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
		response.end(local_host_refusal(hostname, `http://localhost:${request.socket.localPort}`));
	};
	// Vite adds its host check before any plugin's middleware, so this goes in front of it.
	const add_first = (middlewares: Connect.Server) =>
		middlewares.stack.unshift({ route: '', handle: refuse });

	return {
		name: 'syntax-auth-refuse-other-hosts',
		configureServer: (server) => void add_first(server.middlewares),
		configurePreviewServer: (server) => void add_first(server.middlewares)
	};
}

export default defineConfig({
	// Consumer apps point at this exact port; keep it in sync with packages/auth-local.
	server: {
		// IPv4 like the Docker container, so the two can never both hold the port.
		host: '127.0.0.1',
		port: 37960,
		strictPort: true,
		// The local HTTPS proxy forwards this name to Syntax Auth.
		allowedHosts: [SYNTAX_TEST_AUTH_HOSTNAME]
	},
	preview: {
		allowedHosts: [SYNTAX_TEST_AUTH_HOSTNAME]
	},
	// On `pnpm dev`, sets up https://auth.syntax.test (hosts file, Caddy route, certificate trust).
	// scripts/local_server.js already stands in for the container, so the plugin skips it.
	plugins: [refuse_other_hosts(), syntax_auth({ name: 'auth' }), sveltekit()]
});
