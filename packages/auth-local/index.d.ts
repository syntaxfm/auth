import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * Makes sure the shared local Syntax Auth is running, on macOS or Linux. Never throws. With
 * `can_start: false` it only checks, and prints the command that starts it. It opens Docker Desktop
 * or OrbStack only with a person at the Mac's screen: never from an agent shell, over SSH, in CI, or
 * under a test runner.
 */
export declare function ensure_syntax_auth(options?: { can_start?: boolean }): Promise<void>;

export interface SyntaxAuthOptions {
	/**
	 * Paths served by another server on this computer, proxied (HTTP and WebSocket) through the
	 * app's own address: an exact path, or a prefix ending in `/*`, such as
	 * `{ path: '/parties/*', port: 1348 }`.
	 */
	routes?: { path: string; port: number }[];
	/**
	 * Browser-facing origins the connection alone doesn't show, such as a TLS proxy's
	 * `https://lab.example.dev`. Usually set per developer in `SYNTAX_AUTH_PUBLIC_ORIGINS` instead.
	 * Their names also pass Vite's host check.
	 */
	public_origins?: string[];
	/**
	 * @deprecated Ignored, and accepted only so existing configs keep working. It once named the
	 * site's `https://*.syntax.test` name, which no longer exists. Remove it.
	 */
	name?: string;
	/**
	 * @deprecated Ignored, and accepted only so existing configs keep working. It once named the
	 * port that name forwarded to. Remove it.
	 */
	port?: number;
}

export interface SyntaxAuthDevServer {
	middlewares: {
		use(
			middleware: (
				request: IncomingMessage,
				response: ServerResponse,
				next: (error?: unknown) => void
			) => void
		): unknown;
	};
	httpServer: {
		on(
			event: 'upgrade',
			listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
		): unknown;
	} | null;
	config?: { server?: { allowedHosts?: string[] | true } };
}

export interface SyntaxAuthPlugin {
	name: string;
	apply: 'serve';
	config(config: {
		server?: { allowedHosts?: string[] | true };
	}): { server: { allowedHosts: string[] } } | undefined;
	configureServer(server: SyntaxAuthDevServer): void;
}

/**
 * Vite plugin: whenever the dev server starts, ensures local Syntax Auth without delaying it, and
 * serves `/__syntax_auth/sign-in`, `/__syntax_auth/sign-out`, and any `routes` through the app's own
 * address. It never changes the hosts file, certificates, or an HTTPS proxy, and never redirects.
 */
export declare function syntax_auth(options?: SyntaxAuthOptions): SyntaxAuthPlugin;
