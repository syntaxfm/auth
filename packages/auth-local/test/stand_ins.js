// Stand-ins shared by the package's tests.
import { createServer } from 'node:net';

/** @returns {Promise<number>} a port nothing listens on */
export function free_port() {
	return new Promise((resolve) => {
		const server = createServer();
		server.listen(0, '127.0.0.1', () => {
			const address = /** @type {import('node:net').AddressInfo} */ (server.address());
			server.close(() => resolve(address.port));
		});
	});
}
