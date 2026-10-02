// The page a dev server answers a localhost page load with when its https name's setup failed. It
// is self-contained (no requests), so it renders even when nothing else works.

/** @param {string} text */
export function escape_html(text) {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

// Escapes the text, then shows `command` spans as code; a long one on its own lines.
/** @param {string} text */
function format_text(text) {
	return escape_html(text).replace(/`([^`]+)`/g, (_, code) =>
		code.length > 60 ? `<code class="command">${code}</code>` : `<code>${code}</code>`
	);
}

const STYLE = `
:root {
	color-scheme: light dark;
	--background: #ffffff;
	--text: #1b1b1f;
	--muted: #4d4d57;
	--code: #f1f1f4;
	--link: #0b57d0;
	--failed: #b3261e;
}
@media (prefers-color-scheme: dark) {
	:root {
		--background: #121214;
		--text: #ececf1;
		--muted: #b4b4bf;
		--code: #24242a;
		--link: #9ec1ff;
		--failed: #ff8a80;
	}
}
body {
	margin: 0;
	background: var(--background);
	color: var(--text);
	font: 1rem/1.55 system-ui, -apple-system, 'Segoe UI', sans-serif;
}
main {
	max-width: 42rem;
	margin: 0 auto;
	padding: 3rem 1.25rem 4rem;
}
h1 {
	margin: 0 0 1rem;
	font-size: 1.625rem;
	line-height: 1.25;
	overflow-wrap: anywhere;
}
h2 {
	margin: 0 0 0.5rem;
	font-size: 1.125rem;
	line-height: 1.3;
}
p {
	margin: 0 0 0.75rem;
}
.lead,
.later {
	color: var(--muted);
}
section {
	margin: 2rem 0;
	padding: 0.25rem 0 0.25rem 1rem;
	border-left: 4px solid var(--failed);
}
.label {
	display: block;
	color: var(--failed);
	font-size: 0.8125rem;
	font-weight: 600;
	letter-spacing: 0.04em;
	text-transform: uppercase;
}
code {
	padding: 0.1em 0.35em;
	border-radius: 4px;
	background: var(--code);
	font: 0.875em/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
	overflow-wrap: anywhere;
}
code.command {
	display: block;
	margin: 0.5rem 0;
	padding: 0.625rem 0.75rem;
	white-space: pre-wrap;
}
a {
	color: var(--link);
	text-underline-offset: 0.15em;
}
.use-localhost {
	margin-top: 2.5rem;
	font-weight: 600;
}
`;

/**
 * @param {object} page
 * @param {string} page.site_label like "Lab"
 * @param {string} page.https_url like "https://lab.syntax.test"
 * @param {string} page.localhost_url this request's own origin, like "http://localhost:1337"
 * @param {string} page.use_localhost_href the link that keeps this browser on localhost
 * @param {{ step: string, problem: string, fix: string }[]} page.problems
 */
export function render_problem_page({
	site_label,
	https_url,
	localhost_url,
	use_localhost_href,
	problems
}) {
	const sections = problems
		.map(
			(item, index) => `
<section aria-labelledby="step-${index}">
<h2 id="step-${index}"><span class="label">Failed step</span>${escape_html(item.step)}</h2>
<p>${format_text(item.problem)}</p>
${item.fix ? `<p><strong>Fix:</strong> ${format_text(item.fix)}</p>` : ''}
</section>`
		)
		.join('');
	const title = `${https_url} isn't working yet`;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escape_html(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escape_html(title)}</h1>
<p class="lead">${escape_html(site_label.charAt(0).toUpperCase() + site_label.slice(1))}'s dev server is running, but setting up ${escape_html(https_url)} failed at the ${problems.length === 1 ? 'step' : 'steps'} below, so you weren't sent there.</p>
${sections}
<p class="use-localhost"><a href="${escape_html(use_localhost_href)}">Use ${escape_html(localhost_url)} for now</a></p>
<p class="later">This browser then stays on localhost until you quit it. After the fix, restart dev and open ${escape_html(https_url)}.</p>
</main>
</body>
</html>
`;
}
