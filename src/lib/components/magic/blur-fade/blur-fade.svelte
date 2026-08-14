<script lang="ts">
	import { onMount } from "svelte";
	import type { Snippet } from "svelte";

	interface BlurFadeProps {
		children?: Snippet;
		blur?: string;
		delay?: number;
		duration?: number;
		yOffset?: number;
		class?: string;
	}

	let {
		children,
		blur = "6px",
		delay = 0,
		duration = 0.6,
		yOffset = 18,
		class: className = "",
	}: BlurFadeProps = $props();

	let visible = $state(false);

	onMount(() => {
		const timeout = setTimeout(() => {
			visible = true;
		}, delay * 1000);

		return () => clearTimeout(timeout);
	});
</script>

<div
	class={className}
	style="
		transition: opacity {duration}s cubic-bezier(0.16, 1, 0.3, 1), filter {duration}s cubic-bezier(0.16, 1, 0.3, 1), transform {duration}s cubic-bezier(0.16, 1, 0.3, 1);
		opacity: {visible ? 1 : 0};
		filter: blur({visible ? '0px' : blur});
		transform: translateY({visible ? 0 : yOffset}px);
		will-change: opacity, filter, transform;
	"
>
	{#if children}
		{@render children()}
	{/if}
</div>
