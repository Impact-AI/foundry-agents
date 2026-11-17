/**
 * On a phone a table of three or four prose columns is too narrow to read,
 * so under 640px each row stacks into a card (`custom.css`), and each cell
 * shows its column's heading above it. This copies every heading's text into
 * the `data-label` of the cells under it, once the page is drawn and again
 * after each move to another page.
 */
import { useRoute } from "vitepress";
import { nextTick, onMounted, watch } from "vue";

function label() {
	for (const table of document.querySelectorAll<HTMLTableElement>(
		".vp-doc table",
	)) {
		const headings = [...table.querySelectorAll("thead th")].map(
			(th) => th.textContent?.trim() ?? "",
		);
		if (headings.length === 0) continue;
		table.classList.add("stacks");
		for (const row of table.querySelectorAll("tbody tr"))
			[...row.children].forEach((cell, i) => {
				cell.setAttribute("data-label", headings[i] ?? "");
			});
	}
}

/** Labels the cells of every table on the page, from a component's setup. */
export function useTableLabels() {
	const route = useRoute();
	onMounted(label);
	watch(
		() => route.path,
		() => nextTick(label),
	);
}
