#!/usr/bin/env node
// For non-Vite dev scripts: `syntax-auth-local && next dev`.
// `syntax-auth-local setup <auth|lab|website> --port <port> [--route <path>=<port>]...` sets up the
// https://*.syntax.test names from a terminal, for example when dev runs where nobody can answer a
// dialog. See README.md.
import { USAGE, parse_setup_args } from './cli.js';
import { log, warn } from './container.js';
import { ensure_syntax_auth } from './index.js';
import { SITE_LABELS, site_url } from './names.js';
import { default_setup_deps, describe_result, run_setup } from './setup.js';

const [command, ...args] = process.argv.slice(2);

if (command === undefined) {
	await ensure_syntax_auth();
} else if (command === 'setup') {
	const parsed = parse_setup_args(args);
	if ('error' in parsed) {
		console.error(parsed.error);
		process.exit(1);
	}
	const { options } = parsed;
	const result = await run_setup(options, default_setup_deps());
	if (result.state === 'worked') {
		log(
			options.name === 'auth'
				? `${site_url('auth')} is ready.`
				: `Setup is done: ${site_url(options.name)} will reach ${SITE_LABELS[options.name]}'s dev server on port ${options.port} once it starts.`
		);
	} else {
		const [first, ...rest] = describe_result(options, result, options.port);
		(result.state === 'failed' ? warn : log)(
			[first, ...rest.map((line) => `  ${line}`)].join('\n')
		);
	}
	process.exit(result.state === 'failed' ? 1 : 0);
} else {
	console.error(USAGE);
	process.exit(1);
}
