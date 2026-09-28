/** Makes sure the shared local Syntax Auth is running. Never throws. */
export declare function ensure_syntax_auth(): Promise<void>;

/** Vite plugin: ensures local Syntax Auth whenever the dev server starts, without delaying it. */
export declare function syntax_auth(): {
	name: string;
	apply: 'serve';
	configureServer: () => void;
};
