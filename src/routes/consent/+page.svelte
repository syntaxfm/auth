<script lang="ts">
	import { auth_client } from '$lib/auth_client';

	let { data }: import('./$types').PageProps = $props();
	let error_message = $state('');
	let is_submitting = $state(false);

	async function submit_consent(event: SubmitEvent) {
		event.preventDefault();
		is_submitting = true;
		error_message = '';

		const submitter = event.submitter as HTMLButtonElement | null;
		const accept = submitter?.value === 'accept';
		const { error } = await auth_client.oauth2.consent({
			accept,
			scope: data.scopes.join(' ')
		});

		if (error) {
			error_message = error.message ?? 'Unable to record consent.';
			is_submitting = false;
		}
	}
</script>

<svelte:head>
	<title>Authorize {data.client_name} · Syntax Auth</title>
</svelte:head>

<main>
	<h1>Authorize {data.client_name}</h1>
	<p>
		Signed in as <strong>{data.user.name}</strong>. {data.client_name} is requesting access to:
	</p>

	{#if data.scopes.length}
		<ul>
			{#each data.scopes as scope (scope)}
				<li>{scope}</li>
			{/each}
		</ul>
	{/if}

	<form onsubmit={submit_consent}>
		<button type="submit" name="decision" value="deny" disabled={is_submitting}>Deny</button>
		<button type="submit" name="decision" value="accept" disabled={is_submitting}> Allow </button>
	</form>

	{#if error_message}
		<p role="alert">{error_message}</p>
	{/if}
</main>
