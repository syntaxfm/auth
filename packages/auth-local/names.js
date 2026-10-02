// The local HTTPS names every Syntax site uses in development, and the addresses allowed to use them.

/** @typedef {'auth' | 'lab' | 'website'} SiteName */

/** @type {Record<SiteName, string>} */
export const SITE_HOSTNAMES = {
	auth: 'auth.syntax.test',
	lab: 'lab.syntax.test',
	website: 'syntax.test'
};

/** @type {Record<SiteName, string>} */
export const SITE_LABELS = {
	auth: 'Syntax Auth',
	lab: 'Lab',
	website: 'the Syntax website'
};

export const SYNTAX_TEST_HOSTNAMES = Object.values(SITE_HOSTNAMES);
// Vite's allowedHosts pattern for syntax.test and every name under it.
export const SYNTAX_TEST_ALLOWED_HOST = '.syntax.test';
export const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1'];
// Clients allowed through the proxy: this computer and the tailnet (Tailscale's CGNAT range).
export const ALLOWED_CLIENT_RANGES = ['127.0.0.1/32', '::1/128', '100.64.0.0/10'];

/** @param {unknown} name @returns {name is SiteName} */
export function is_site_name(name) {
	return typeof name === 'string' && Object.hasOwn(SITE_HOSTNAMES, name);
}

/** @param {SiteName} name */
export function site_url(name) {
	return `https://${SITE_HOSTNAMES[name]}`;
}

/** @param {string} hostname a URL hostname, so IPv6 comes in brackets */
export function is_loopback_hostname(hostname) {
	const host = hostname.toLowerCase();
	return (
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host === '[::1]' ||
		/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
	);
}

/** @param {string} address an IP address as DNS lookups return it */
export function is_loopback_address(address) {
	return address === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address);
}

// The hostname a Host header names, lowercased, without its port.
/** @param {string | undefined} host_header */
export function get_hostname(host_header) {
	if (!host_header) return '';
	try {
		return new URL(`http://${host_header}`).hostname;
	} catch {
		return host_header.toLowerCase();
	}
}

/**
 * Whether text has a space or a control character (C0, DEL, or C1), which browsers strip from URLs
 * and shells split on.
 * @param {string} text
 */
export function has_space_or_control(text) {
	return [...text].some((char) => {
		const code = char.codePointAt(0) ?? 0;
		return code <= 0x20 || (code >= 0x7f && code <= 0x9f);
	});
}

// A route path the setup command can print inside single quotes: no quotes, backslashes, spaces, or
// control characters.
/** @param {unknown} path @returns {path is string} */
export function is_route_path(path) {
	return typeof path === 'string' && /^\/[^\s'"\\]*$/.test(path) && !has_space_or_control(path);
}
