// Trusts the proven Caddy's local root certificate in the macOS login keychain, once. It trusts only
// the root that Caddy's own API gives, and only after checking that root issued the certificate
// Caddy serves for the .syntax.test names.
import { X509Certificate } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';

import { caddy_api } from './caddy.js';
import { first_line, sleep } from './container.js';

const SERVED_CERTIFICATE_TIMEOUT_MS = 15_000;
const TLS_TIMEOUT_MS = 5_000;
const DIALOG_TIMEOUT_MS = 300_000;

/**
 * @typedef {{ problem: string, fix: string }} Problem
 * @typedef {{ root: X509Certificate, intermediate: X509Certificate | null }} CaddyAuthority
 * @typedef {object} TrustDeps
 * @property {import('./container.js').Run} run
 * @property {string} admin_origin
 * @property {number} admin_port
 * @property {number} https_port
 * @property {string} keychain the login keychain's path
 * @property {string} setup_command
 * @property {number} [dialog_timeout_ms]
 * @property {number} [served_certificate_timeout_ms]
 */

/** @param {string} pem @returns {X509Certificate | null} */
function parse_certificate(pem) {
	try {
		return new X509Certificate(pem);
	} catch {
		return null;
	}
}

/**
 * The root (and current intermediate) of the proven Caddy's local certificate authority.
 * @param {TrustDeps} deps
 * @returns {Promise<CaddyAuthority | Problem>}
 */
export async function get_caddy_authority(deps) {
	const response = await caddy_api(deps, 'GET', '/pki/ca/local');
	const json =
		/** @type {{ root_certificate?: unknown, intermediate_certificate?: unknown } | null} */ (
			response.json
		);
	const root =
		typeof json?.root_certificate === 'string' ? parse_certificate(json.root_certificate) : null;
	if (response.status !== 200 || !root) {
		return {
			problem: `Caddy's API didn't give its local root certificate (GET /pki/ca/local answered ${response.status}: ${first_line(response.text)}).`,
			fix: 'Restart dev to try again.'
		};
	}
	const intermediate =
		typeof json?.intermediate_certificate === 'string'
			? parse_certificate(json.intermediate_certificate)
			: null;
	return { root, intermediate };
}

/**
 * The certificates Caddy serves for `hostname` on 127.0.0.1, leaf first.
 * @param {number} port
 * @param {string} hostname
 * @returns {Promise<X509Certificate[]>}
 */
export function get_served_chain(port, hostname) {
	return new Promise((resolve, reject) => {
		const socket = connect({
			host: '127.0.0.1',
			port,
			servername: hostname,
			// Read the chain whatever its trust; check_issuer decides.
			rejectUnauthorized: false,
			timeout: TLS_TIMEOUT_MS
		});
		socket.once('secureConnect', () => {
			/** @type {X509Certificate[]} */
			const chain = [];
			let certificate = socket.getPeerCertificate(true);
			while (certificate?.raw && chain.length < 5) {
				chain.push(new X509Certificate(certificate.raw));
				if (certificate.issuerCertificate === certificate) break;
				certificate = certificate.issuerCertificate;
			}
			socket.end();
			resolve(chain);
		});
		socket.once('timeout', () => {
			socket.destroy();
			reject(new Error('no answer within 5 seconds'));
		});
		socket.once('error', reject);
	});
}

/**
 * Why `root` didn't issue the certificate served for `hostname`, or null when it did.
 * @param {string} hostname
 * @param {X509Certificate[]} chain
 * @param {CaddyAuthority} authority
 * @returns {string | null}
 */
export function check_issuer(hostname, chain, { root, intermediate }) {
	const [leaf, ...served_intermediates] = chain;
	if (!leaf) return `Caddy served no certificate for ${hostname}`;
	if (!leaf.checkHost(hostname)) return `the certificate Caddy serves isn't for ${hostname}`;
	if (!root.ca || !root.checkIssued(root) || !root.verify(root.publicKey)) {
		return "the root certificate Caddy's API gave isn't a self-signed certificate authority";
	}
	const candidates = [...served_intermediates, ...(intermediate ? [intermediate] : [])];
	const issued = candidates.some(
		(candidate) =>
			candidate.ca &&
			leaf.checkIssued(candidate) &&
			leaf.verify(candidate.publicKey) &&
			candidate.checkIssued(root) &&
			candidate.verify(root.publicKey)
	);
	return issued
		? null
		: `the certificate Caddy serves for ${hostname} wasn't issued by the root its API gave (${root.subject.replace(/\n/g, ', ')})`;
}

/**
 * Waits for Caddy to serve a certificate for each name (it issues them right after a route is
 * added), then checks that its root issued each.
 * @param {TrustDeps} deps
 * @param {string[]} hostnames
 * @param {CaddyAuthority} authority
 * @returns {Promise<{ chain: X509Certificate[] } | Problem>} the first name's chain
 */
export async function check_served_certificates(deps, hostnames, authority) {
	/** @type {X509Certificate[] | null} */
	let first_chain = null;
	for (const hostname of hostnames) {
		const deadline =
			Date.now() + (deps.served_certificate_timeout_ms ?? SERVED_CERTIFICATE_TIMEOUT_MS);
		/** @type {string} */
		let reason;
		for (;;) {
			try {
				const chain = await get_served_chain(deps.https_port, hostname);
				const problem = check_issuer(hostname, chain, authority);
				if (!problem) {
					first_chain ??= chain;
					break;
				}
				reason = problem;
			} catch (error) {
				reason = `127.0.0.1:${deps.https_port} didn't complete a TLS handshake for ${hostname} (${error instanceof Error ? error.message : String(error)})`;
			}
			if (Date.now() > deadline) {
				return {
					problem: `Setup won't trust Caddy's root: ${reason}.`,
					fix: `Check which program serves port ${deps.https_port} and Caddy's tls settings for ${hostname}, then restart dev.`
				};
			}
			await sleep(500);
		}
	}
	return { chain: /** @type {X509Certificate[]} */ (first_chain) };
}

/** @param {X509Certificate} certificate */
function sha1(certificate) {
	return certificate.fingerprint.replaceAll(':', '');
}

/** @param {X509Certificate} certificate */
function common_name(certificate) {
	return certificate.subject.match(/^CN=(.*)$/m)?.[1] ?? '';
}

/**
 * @param {TrustDeps} deps
 * @param {X509Certificate} root
 */
async function is_in_keychain(deps, root) {
	const result = await deps.run('security', [
		'find-certificate',
		'-a',
		'-Z',
		'-c',
		common_name(root),
		deps.keychain
	]);
	return result.code === 0 && result.stdout.toUpperCase().includes(sha1(root));
}

/**
 * @param {TrustDeps} deps
 * @param {string} directory
 * @param {string} hostname
 * @param {X509Certificate[]} chain
 * @param {X509Certificate} root
 */
async function verify(deps, directory, hostname, chain, root) {
	const files = [];
	for (const [index, certificate] of [...chain.slice(0, 2), root].entries()) {
		const file = join(directory, `chain-${index}.pem`);
		await writeFile(file, certificate.toString());
		files.push('-c', file);
	}
	return deps.run('security', ['verify-cert', ...files, '-p', 'ssl', '-s', hostname]);
}

/**
 * Makes sure macOS trusts the root for `hostname`, asking for one approval when it doesn't yet. If
 * the approval is declined or fails, removes the certificate macOS added without trust.
 * @param {TrustDeps} deps
 * @param {{ hostname: string, chain: X509Certificate[], root: X509Certificate, can_ask: boolean }} options
 * @returns {Promise<{ changed: boolean } | Problem>}
 */
export async function ensure_trusted(deps, { hostname, chain, root, can_ask }) {
	const directory = await mkdtemp(join(tmpdir(), 'syntax-test-trust-'));
	try {
		if ((await verify(deps, directory, hostname, chain, root)).code === 0)
			return { changed: false };

		const name = common_name(root);
		if (!can_ask) {
			return {
				problem: `macOS doesn't trust Caddy's local certificate authority ("${name}") yet, and trusting it needs your approval in a dialog on this computer's screen, which nobody can answer from here.`,
				fix: `Run \`${deps.setup_command}\` in Terminal at this computer's own screen (or over Screen Sharing), then restart dev.`
			};
		}

		const was_in_keychain = await is_in_keychain(deps, root);
		const root_file = join(directory, 'root.pem');
		await writeFile(root_file, root.toString());
		const added = await deps.run(
			'security',
			['add-trusted-cert', '-r', 'trustRoot', '-k', deps.keychain, root_file],
			{ timeout_ms: deps.dialog_timeout_ms ?? DIALOG_TIMEOUT_MS }
		);

		if (added.code === 0) {
			const check = await verify(deps, directory, hostname, chain, root);
			if (check.code === 0) return { changed: true };
			return {
				problem: `macOS trusted Caddy's root ("${name}"), but still doesn't accept the certificate for ${hostname}: ${first_line(`${check.stdout}\n${check.stderr}`)}`,
				fix: `Open Keychain Access, find "${name}" in the login keychain, set "When using this certificate" to Always Trust, then restart dev.`
			};
		}

		// macOS adds the certificate before asking, so a declined or failed approval leaves it
		// in the keychain without trust.
		let cleanup = '';
		if (!was_in_keychain && (await is_in_keychain(deps, root))) {
			const removed = await deps.run('security', [
				'delete-certificate',
				'-Z',
				sha1(root),
				deps.keychain
			]);
			cleanup =
				removed.code === 0
					? ' The certificate it had added to your login keychain was removed.'
					: ` The certificate it had added to your login keychain couldn't be removed (${first_line(removed.stderr)}).`;
			if (removed.code !== 0) {
				return {
					problem: `Trusting Caddy's root ("${name}") didn't finish, so nothing was trusted.${cleanup}`,
					fix: `Remove it with \`security delete-certificate -Z ${sha1(root)} ${deps.keychain}\`, then restart dev.`
				};
			}
		}
		if (added.timed_out) {
			return {
				problem: `The approval dialog for trusting Caddy's root ("${name}") was open for 5 minutes without an answer, so setup closed it and trusted nothing.${cleanup}`,
				fix: 'Restart dev and approve the dialog.'
			};
		}
		if (/canceled/i.test(added.stderr)) {
			return {
				problem: `You canceled the approval to trust Caddy's root ("${name}"), so nothing was trusted.${cleanup}`,
				fix: `Restart dev and approve the dialog (your password or Touch ID) to use https://${hostname}.`
			};
		}
		return {
			problem: `macOS refused to trust Caddy's root ("${name}"): ${first_line(added.stderr) || `security exited with code ${added.code}`}.${cleanup}`,
			fix: 'Restart dev to try again.'
		};
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
