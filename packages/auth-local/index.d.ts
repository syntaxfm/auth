import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Makes sure the shared local Syntax Auth is running. Never throws. With `can_start: false` it only
 * checks, and prints the command that starts it. It opens Docker Desktop or OrbStack only with a
 * person at the Mac's screen: never from an agent shell, over SSH, in CI, or under a test runner.
 */
export declare function ensure_syntax_auth(options?: { can_start?: boolean }): Promise<void>;

export interface SyntaxAuthOptions {
	/**
	 * The Syntax site this dev server runs: 'auth' (https://auth.syntax.test), 'lab'
	 * (https://lab.syntax.test), or 'website' (https://syntax.test). Without it, the plugin only
	 * keeps local Syntax Auth running.
	 */
	name?: 'auth' | 'lab' | 'website';
	/** The port the https name forwards to. Default: the port Vite listens on. */
	port?: number;
	/** Paths served by another local server, such as `{ path: '/parties/*', port: 1999 }`. */
	routes?: { path: string; port: number }[];
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
		listening: boolean;
		address(): unknown;
		once(event: 'listening' | 'close', listener: () => void): unknown;
	} | null;
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
 * Vite plugin: whenever the dev server starts, ensures local Syntax Auth without delaying it, and,
 * given a site name, sets up that site's https://*.syntax.test name on macOS.
 */
export declare function syntax_auth(options?: SyntaxAuthOptions): SyntaxAuthPlugin;
