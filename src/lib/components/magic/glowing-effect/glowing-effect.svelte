<script lang="ts">
	import { onMount } from "svelte";
	import { animate } from "svelte-motion";

	export let blur = 0;
	export let inactiveZone = 0.7;
	export let proximity = 0;
	export let spread = 20;
	export let variant = "default";
	export let glow = false;
	export let className = "";
	export let movementDuration = 2;
	export let borderWidth = 1;
	export let disabled = false;
	// "green" | "red" — the multicolor gradient was removed; pick one
	export let color: "green" | "red" = "green";

	let containerRef: HTMLDivElement;
	let lastPosition = { x: 0, y: 0 };
	let animationFrameRef: any;

	// Green-only glow
	const GREEN_GRADIENT = `radial-gradient(circle, #22c55e 10%, #22c55e00 20%),
      repeating-conic-gradient(
        from 236.84deg at 50% 50%, #22c55e 0%, #86efac calc(25% / var(--repeating-conic-gradient-times)),
        #22c55e calc(50% / var(--repeating-conic-gradient-times)), #16a34a calc(75% / var(--repeating-conic-gradient-times)),
        #22c55e calc(100% / var(--repeating-conic-gradient-times))
      )`;

	// Red-only glow
	const RED_GRADIENT = `radial-gradient(circle, #ef4444 10%, #ef444400 20%),
      repeating-conic-gradient(
        from 236.84deg at 50% 50%, #ef4444 0%, #fca5a5 calc(25% / var(--repeating-conic-gradient-times)),
        #ef4444 calc(50% / var(--repeating-conic-gradient-times)), #b91c1c calc(75% / var(--repeating-conic-gradient-times)),
        #ef4444 calc(100% / var(--repeating-conic-gradient-times))
      )`;

	function handleMove(e?: MouseEvent | { x: number; y: number }) {
		if (!containerRef) return;

		if (animationFrameRef) {
			cancelAnimationFrame(animationFrameRef);
		}

		animationFrameRef = requestAnimationFrame(() => {
			if (!containerRef) return;

			const { left, top, width, height } = containerRef.getBoundingClientRect();
			const mouseX = e?.x ?? lastPosition.x;
			const mouseY = e?.y ?? lastPosition.y;

			if (e) {
				lastPosition = { x: mouseX, y: mouseY };
			}

			const center = [left + width * 0.5, top + height * 0.5];
			const distanceFromCenter = Math.hypot(
				mouseX - center[0],
				mouseY - center[1]
			);
			const inactiveRadius = 0.5 * Math.min(width, height) * inactiveZone;

			if (distanceFromCenter < inactiveRadius) {
				containerRef.style.setProperty("--active", "0");
				return;
			}

			const isActive =
				mouseX > left - proximity &&
				mouseX < left + width + proximity &&
				mouseY > top - proximity &&
				mouseY < top + height + proximity;

			containerRef.style.setProperty("--active", isActive ? "1" : "0");

			if (!isActive) return;

			const currentAngle =
				parseFloat(containerRef.style.getPropertyValue("--start")) || 0;
			let targetAngle =
				(180 * Math.atan2(mouseY - center[1], mouseX - center[0])) / Math.PI +
				90;

			const angleDiff = ((targetAngle - currentAngle + 180) % 360) - 180;
			const newAngle = currentAngle + angleDiff;

			animate(currentAngle, newAngle, {
				duration: movementDuration,
				ease: [0.16, 1, 0.3, 1],
				onUpdate: (value) => {
					if (containerRef) {
						containerRef.style.setProperty("--start", String(value));
					}
				},
			});
		});
	}

	onMount(() => {
		if (disabled) return;

		const handleScroll = () => () => handleMove();
		const handlePointerMove = (e: PointerEvent) => handleMove(e);

		window.addEventListener("scroll", handleScroll);
		document.addEventListener("pointermove", handlePointerMove);

		return () => {
			if (animationFrameRef) {
				cancelAnimationFrame(animationFrameRef);
			}
			window.removeEventListener("scroll", handleScroll);
			document.removeEventListener("pointermove", handlePointerMove);
		};
	});
</script>

<div
	bind:this={containerRef}
	class="pointer-events-none absolute inset-0 rounded-[inherit] opacity-100 transition-opacity {glow
		? 'opacity-100'
		: ''} {blur > 0 ? 'blur-[var(--blur)]' : ''} {disabled
		? 'hidden'
		: ''} {className}"
	style="
    --blur: {blur}px;
    --spread: {spread};
    --start: 0;
    --active: 0;
    --glowingeffect-border-width: {borderWidth}px;
    --repeating-conic-gradient-times: 5;
    --gradient: {color === 'red' ? RED_GRADIENT : GREEN_GRADIENT}"
>
	<div
		class="glow rounded-[inherit] after:content-[''] after:rounded-[inherit] after:absolute after:inset-[calc(-1*var(--glowingeffect-border-width))] after:[border:var(--glowingeffect-border-width)_solid_transparent] after:[background:var(--gradient)] after:[background-attachment:fixed] after:opacity-[var(--active)] after:transition-opacity after:duration-300 after:[mask-clip:padding-box,border-box] after:[mask-composite:intersect] after:[mask-image:linear-gradient(#0000,#0000),conic-gradient(from_calc((var(--start)-var(--spread))*1deg),#00000000_0deg,#fff,#00000000_calc(var(--spread)*2deg))]"
	/>
</div>
