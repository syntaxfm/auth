// The development proxy's two pages, rendered on the server with every value escaped: the sign-in
// page with its one button, and the page that names a failure and offers a safe retry.
import { MOUNT_PATH } from './app_origin.js';

export const SIGN_IN_PATH = `${MOUNT_PATH}/sign-in`;
export const SIGN_OUT_PATH = `${MOUNT_PATH}/sign-out`;

/** Headers for every page: never cached, framed, sniffed, or allowed to load anything else. */
export const PAGE_HEADERS = {
	'content-type': 'text/html; charset=utf-8',
	'cache-control': 'no-store',
	'content-security-policy':
		"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
	'x-frame-options': 'DENY',
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'same-origin'
};

/** @param {string} text */
export function escape_html(text) {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

const STYLE = `
	:root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.5; }
	*, *::before, *::after { box-sizing: border-box; }
	body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
	main { width: min(28rem, calc(100vw - 2rem)); padding: clamp(1rem, 5vw, 2rem); border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 0.75rem; }
	.label { margin: 0 0 0.5rem; font-size: 0.8125rem; letter-spacing: 0.02em; opacity: 0.7; }
	h1 { margin: 0 0 1rem; font-size: 1.5rem; line-height: 1.25; overflow-wrap: anywhere; }
	p { margin: 0 0 1rem; overflow-wrap: anywhere; }
	code { font-size: 0.875em; }
	button { font: inherit; font-weight: 600; padding: 0.625rem 1rem; border: 0; border-radius: 0.5rem; background: #f7df1e; color: #121212; cursor: pointer; }
	button:focus-visible, a:focus-visible { outline: 3px solid color-mix(in srgb, CanvasText 60%, transparent); outline-offset: 2px; }
	.problem { padding: 0.75rem 1rem; border-left: 4px solid #d93a2b; background: color-mix(in srgb, #d93a2b 10%, transparent); }
	.quiet { font-size: 0.875rem; opacity: 0.75; }
`;

/** @param {string} title @param {string} content */
function layout(title, content) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape_html(title)} · Local Syntax Auth</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="label">Local Syntax Auth · development only</p>
${content}
</main>
</body>
</html>
`;
}

/** @param {string} return_path a path safe_return_path accepted */
function return_field(return_path) {
	return `<input type="hidden" name="return_to" value="${escape_html(return_path)}">`;
}

/**
 * @param {{ host: string, return_path: string }} options
 */
export function render_sign_in_page({ host, return_path }) {
	return layout(
		'Sign in',
		`<h1>Sign in to ${escape_html(host)}</h1>
<p>The Local Developer session stays on this address only.</p>
<form method="post" action="${SIGN_IN_PATH}">
${return_field(return_path)}
<button type="submit">Continue as Local Developer</button>
</form>
<p class="quiet">Then back to <code>${escape_html(return_path)}</code>.</p>`
	);
}

/**
 * @typedef {{ kind: 'sign-in' | 'sign-out', return_path: string }} Retry
 *   A sign-in retries by loading the sign-in page again; a sign-out by its own button, never by
 *   itself.
 */

/**
 * @param {{ title: string, problem: string, startup_problem?: string | null, retry?: Retry | null }} options
 */
export function render_problem_page({ title, problem, startup_problem = null, retry = null }) {
	const startup = startup_problem
		? `<p>When this dev server started: ${escape_html(startup_problem)}</p>`
		: '';
	let action = '';
	if (retry?.kind === 'sign-in') {
		const href = `${SIGN_IN_PATH}?${new URLSearchParams({ return_to: retry.return_path })}`;
		action = `<p><a href="${escape_html(href)}">Try again</a></p>`;
	} else if (retry?.kind === 'sign-out') {
		action = `<form method="post" action="${SIGN_OUT_PATH}">
${return_field(retry.return_path)}
<button type="submit">Try signing out again</button>
</form>`;
	}
	return layout(
		title,
		`<h1>${escape_html(title)}</h1>
<p class="problem" role="alert">${escape_html(problem)}</p>
<p>Stop this app's dev server, then run <code>pnpm dev</code> again to start or reconnect local Syntax Auth.</p>
${startup}${action}`
	);
}
