/**
 * A measure's key as words: `billableHours` is "billable hours",
 * `running_cost` is "running cost", an acronym stays one ("supportSLA" is
 * "support SLA"). The chart's title says it, and the frontend falls back on
 * it for a measure its catalogues give no name, so a system's new measure
 * still reads as words. It imports nothing, because the frontend's image
 * copies this file alone out of the backend.
 */
export function humanizeMeasure(key: string): string {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[\s_-]+/)
		.filter(Boolean)
		.map((word) => (/^[A-Z0-9]{2,}$/.test(word) ? word : word.toLowerCase()))
		.join(" ");
}
