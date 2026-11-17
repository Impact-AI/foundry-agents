/**
 * A Mermaid diagram, drawn in the browser from the source the page's fence
 * held, and drawn again in the other theme when the reader switches it.
 * Before it is drawn, and if Mermaid refuses it, the source shows as code.
 *
 * In the page a diagram fits its column (`useMaxWidth`), as an overview whose
 * text may be small. Its "Expand diagram" button, or a click on it, opens a
 * copy in a dialog over the whole window, fitted to it, where `svg-pan-zoom`
 * zooms with the wheel, the buttons and `+`/`-`, and pans by dragging and with
 * the arrow keys; `0` and "Fit" fit it again, a pinch zooms on a touch screen.
 * Mermaid names a diagram's arrowheads by the diagram's id, so the copy is
 * given an id of its own and its arrowheads stay its own.
 */
import type SvgPanZoom from "svg-pan-zoom";
import { useData } from "vitepress";
import {
	defineComponent,
	h,
	onBeforeUnmount,
	onMounted,
	ref,
	watch,
} from "vue";

const FONT_SIZE = "14px";
/** The zoom range, as multiples of the zoom that fits the window. */
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;
/** How far an arrow key pans, in pixels. */
const PAN_STEP = 60;

let drawn = 0;

/**
 * Gives the ids Mermaid does not prefix with the diagram's (a sequence
 * diagram's actors) the copy's prefix, and every reference to them with it.
 */
function ownIds(svg: SVGSVGElement, prefix: string) {
	const renamed = new Map<string, string>();
	for (const element of svg.querySelectorAll("[id]")) {
		if (element.id.startsWith(prefix)) continue;
		renamed.set(element.id, `${prefix}-${element.id}`);
		element.id = `${prefix}-${element.id}`;
	}
	if (!renamed.size) return;
	for (const element of svg.querySelectorAll("*")) {
		for (const attribute of element.attributes) {
			if (!attribute.value.includes("#")) continue;
			// A reference is `url(#id)`, or a whole `href` of `#id`.
			const value = attribute.value.replace(
				/(url\(["']?#|^#)([^)"']+)(?=["']?\)|$)/g,
				(match, lead, name) => {
					const to = renamed.get(name);
					return to ? `${lead}${to}` : match;
				},
			);
			if (value !== attribute.value) attribute.value = value;
		}
	}
}

/** A two-finger pinch zooms about the fingers' midpoint. */
function pinch(svg: SVGSVGElement) {
	let instance: SvgPanZoom.Instance;
	let last = 0;
	const span = (e: TouchEvent) =>
		Math.hypot(
			e.touches[0].clientX - e.touches[1].clientX,
			e.touches[0].clientY - e.touches[1].clientY,
		);
	const start = (e: TouchEvent) => {
		if (e.touches.length !== 2) return;
		last = span(e);
		instance.disablePan();
	};
	const move = (e: TouchEvent) => {
		if (e.touches.length !== 2 || !last) return;
		const now = span(e);
		const point = svg.createSVGPoint();
		point.x = (e.touches[0].clientX + e.touches[1].clientX) / 2;
		point.y = (e.touches[0].clientY + e.touches[1].clientY) / 2;
		const at = point.matrixTransform(svg.getScreenCTM()?.inverse());
		instance.zoomAtPointBy(now / last, { x: at.x, y: at.y });
		last = now;
	};
	const end = (e: TouchEvent) => {
		if (e.touches.length >= 2 || !last) return;
		last = 0;
		instance.enablePan();
	};
	return {
		haltEventListeners: [],
		init(options: SvgPanZoom.CustomEventOptions) {
			instance = options.instance;
			svg.addEventListener("touchstart", start);
			svg.addEventListener("touchmove", move);
			svg.addEventListener("touchend", end);
			svg.addEventListener("touchcancel", end);
		},
		destroy() {
			svg.removeEventListener("touchstart", start);
			svg.removeEventListener("touchmove", move);
			svg.removeEventListener("touchend", end);
			svg.removeEventListener("touchcancel", end);
		},
	};
}

export const Mermaid = defineComponent({
	name: "Mermaid",
	props: { code: { type: String, required: true } },
	setup(props) {
		const { isDark } = useData();
		const svg = ref("");
		const source = decodeURIComponent(props.code);
		let id = "";
		const dialog = ref<HTMLDialogElement>();
		const stage = ref<HTMLDivElement>();
		const opener = ref<HTMLButtonElement>();
		let viewer: SvgPanZoom.Instance | undefined;

		async function draw() {
			const { default: mermaid } = await import("mermaid");
			mermaid.initialize({
				startOnLoad: false,
				securityLevel: "strict",
				theme: isDark.value ? "dark" : "default",
				themeVariables: { fontSize: FONT_SIZE },
			});
			drawn += 1;
			id = `mermaid-${drawn}`;
			try {
				svg.value = (await mermaid.render(id, source)).svg;
			} catch {
				svg.value = "";
			}
			if (dialog.value?.open) await show();
		}

		/** The diagram's copy in the dialog, fitted to the window. */
		async function show() {
			const into = stage.value;
			if (!into) return;
			viewer?.destroy();
			viewer = undefined;
			// The copy's id, and every reference to it, gets a suffix; the
			// lookahead keeps `mermaid-1` from matching `mermaid-12`.
			into.innerHTML = svg.value.replace(
				new RegExp(`${id}(?!\\d)`, "g"),
				`${id}-expanded`,
			);
			const copy = into.querySelector("svg");
			if (!copy) return;
			ownIds(copy, `${id}-expanded`);
			copy.removeAttribute("style");
			copy.setAttribute("width", "100%");
			copy.setAttribute("height", "100%");
			const { default: svgPanZoom } = await import("svg-pan-zoom");
			viewer = svgPanZoom(copy, {
				minZoom: MIN_ZOOM,
				maxZoom: MAX_ZOOM,
				zoomScaleSensitivity: 0.25,
				dblClickZoomEnabled: false,
				customEventsHandler: pinch(copy),
			});
		}

		function fit() {
			viewer?.resize();
			viewer?.reset();
		}

		async function open() {
			const box = dialog.value;
			if (!box || box.open) return;
			box.showModal();
			stage.value?.focus();
			await show();
		}

		function close() {
			dialog.value?.close();
		}

		function closed() {
			viewer?.destroy();
			viewer = undefined;
			if (stage.value) stage.value.innerHTML = "";
			opener.value?.focus();
		}

		function key(event: KeyboardEvent) {
			if (!viewer || event.altKey || event.ctrlKey || event.metaKey) return;
			const pan: Record<string, [number, number]> = {
				ArrowLeft: [PAN_STEP, 0],
				ArrowRight: [-PAN_STEP, 0],
				ArrowUp: [0, PAN_STEP],
				ArrowDown: [0, -PAN_STEP],
			};
			if (event.key === "+" || event.key === "=") viewer.zoomIn();
			else if (event.key === "-" || event.key === "_") viewer.zoomOut();
			else if (event.key === "0") fit();
			else if (event.key in pan) {
				const [x, y] = pan[event.key];
				viewer.panBy({ x, y });
			} else return;
			event.preventDefault();
		}

		onMounted(() => {
			draw();
			window.addEventListener("resize", fit);
		});
		onBeforeUnmount(() => {
			window.removeEventListener("resize", fit);
			viewer?.destroy();
		});
		watch(isDark, draw);

		const tool = (label: string, text: string, onClick: () => void) =>
			h(
				"button",
				{
					type: "button",
					class: "mermaid-tool",
					"aria-label": label,
					title: label,
					onClick,
				},
				text,
			);

		return () =>
			svg.value
				? h("div", { class: "mermaid-figure" }, [
						h("div", {
							class: "mermaid-diagram",
							innerHTML: svg.value,
							onClick: open,
						}),
						h(
							"button",
							{
								ref: opener,
								type: "button",
								class: "mermaid-expand",
								"aria-label": "Expand diagram",
								title: "Expand diagram",
								onClick: open,
							},
							"⤢",
						),
						h(
							"dialog",
							{
								ref: dialog,
								class: "mermaid-dialog",
								"aria-modal": "true",
								"aria-label": "Diagram",
								onClose: closed,
								onKeydown: key,
							},
							[
								h("div", { class: "mermaid-toolbar" }, [
									tool("Zoom in", "+", () => viewer?.zoomIn()),
									tool("Zoom out", "−", () => viewer?.zoomOut()),
									tool("Fit to window", "Fit", fit),
									tool("Close", "×", close),
								]),
								h("div", {
									ref: stage,
									class: "mermaid-stage",
									tabindex: 0,
									role: "group",
									"aria-label":
										"Diagram. Drag or use the arrow keys to pan, the wheel or + and - to zoom, 0 to fit.",
								}),
							],
						),
					])
				: h("pre", { class: "mermaid-source" }, h("code", source));
	},
});
