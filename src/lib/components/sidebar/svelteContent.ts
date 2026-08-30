import { writable } from "svelte/store";

export let vopen = writable(false);
export let vanimate = writable(true);

// State: Single open section key (single-expansion accordion)
// Default open section is 'journal'
export let openSection = writable<string | null>('journal');

/**
 * Toggle handler: collapses all other sections and toggles the selected section
 */
export function toggleSection(sectionKey: string) {
  openSection.update(prev => (prev === sectionKey ? null : sectionKey));
}
