<script lang="ts">
	import '../app.css';

	let { children }: import('./$types').LayoutProps = $props();
</script>

{@render children()}
