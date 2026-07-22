<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { auth_client } from '$lib/auth_client';

	let { data }: import('./$types').PageProps = $props();
	let error_message = $state('');
	let is_submitting = $state(false);

	async function sign_in() {
		is_submitting = true;
		error_message = '';

		const { error } = await auth_client.signIn.social({
			provider: 'github'
		});

		if (error) {
			error_message = error.message ?? 'Unable to sign in.';
			is_submitting = false;
		}
	}

	async function sign_out() {
		is_submitting = true;
		error_message = '';

		const { error } = await auth_client.signOut();

		if (error) {
			error_message = error.message ?? 'Unable to sign out.';
			is_submitting = false;
			return;
		}

		await goto(resolve('/sign-in'));
	}
</script>

<svelte:head>
	<title>Sign in · Syntax Auth</title>
</svelte:head>

<main>
	<h1>Sign in</h1>

	{#if data.user}
		<p>Signed in as <strong>{data.user.name}</strong>.</p>
		<p><a href={resolve('/')}>Continue</a></p>
		<button type="button" onclick={sign_out} disabled={is_submitting}>Sign out</button>
	{:else}
		<button type="button" onclick={sign_in} disabled={is_submitting}> Continue with GitHub </button>
	{/if}

	{#if error_message}
		<p role="alert">{error_message}</p>
	{/if}
</main>
