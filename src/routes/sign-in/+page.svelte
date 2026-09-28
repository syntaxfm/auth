<script lang="ts">
	import { resolve } from '$app/paths';
	import { auth_client } from '$lib/auth_client';

	let { data }: import('./$types').PageProps = $props();
	let error_message = $state('');
	let is_submitting = $state(false);

	async function sign_in() {
		is_submitting = true;
		error_message = '';

		const { error } = await auth_client.signIn.social({
			provider: 'github',
			callbackURL: data.return_to ?? resolve('/')
		});

		if (error) {
			error_message = error.message ?? 'Unable to sign in.';
			is_submitting = false;
		}
	}

	async function sign_in_local_developer() {
		if (!data.local_developer) return;

		is_submitting = true;
		error_message = '';

		const { email, password, name } = data.local_developer;
		const sign_in_result = await auth_client.signIn.email({ email, password });
		// The first sign-in on a fresh local database creates the account.
		const { error } =
			sign_in_result.error?.status === 401
				? await auth_client.signUp.email({ email, password, name })
				: sign_in_result;

		if (error) {
			error_message = error.message ?? 'Unable to sign in.';
			is_submitting = false;
			return;
		}

		window.location.assign(data.return_to ?? resolve('/'));
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

		window.location.assign(data.return_to ?? resolve('/sign-in'));
	}
</script>

<svelte:head>
	<title>Sign in · Syntax Auth</title>
</svelte:head>

<main>
	<h1>Sign in</h1>

	{#if data.user}
		<p>Signed in as <strong>{data.user.name}</strong>.</p>
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- validated absolute URL from server load -->
		<p><a href={data.return_to ?? resolve('/')}>Continue</a></p>
		<button type="button" onclick={sign_out} disabled={is_submitting}>Sign out</button>
	{:else if data.local_developer}
		<button type="button" onclick={sign_in_local_developer} disabled={is_submitting}>
			Continue as {data.local_developer.name}
		</button>
	{:else}
		<button type="button" onclick={sign_in} disabled={is_submitting}> Continue with GitHub </button>
	{/if}

	{#if error_message}
		<p role="alert">{error_message}</p>
	{/if}
</main>
