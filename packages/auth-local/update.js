// Runs detached from the dev server, so stopping the dev server never interrupts an update midway.
// Users and sessions live in the Docker volume, so replacing the container keeps them.
import {
	CONTAINER_NAME,
	IMAGE,
	create_container,
	docker,
	get_container_state,
	pull_image,
	with_container_lock
} from './container.js';

const pull_error = await pull_image();

if (!pull_error) {
	await with_container_lock(async () => {
		const latest = await docker(['image', 'inspect', '--format', '{{.Id}}', IMAGE]);
		const state = await get_container_state();
		if (latest.code !== 0 || !state?.is_running || state.image_id === latest.stdout) return;

		await docker(['rm', '--force', CONTAINER_NAME]);
		await create_container();
	});
}
