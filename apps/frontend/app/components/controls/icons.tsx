import type { SVGProps } from "react";

/**
 * The glyphs the controls draw: one stroke weight, one box, hidden from
 * assistive technology because the control that holds them carries the
 * words.
 */
function Glyph({ children, ...props }: SVGProps<SVGSVGElement>) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
			{...props}
		>
			{children}
		</svg>
	);
}

export const IconClose = (p: SVGProps<SVGSVGElement>) => (
	<Glyph {...p}>
		<path d="M6 6l12 12M18 6L6 18" />
	</Glyph>
);

export const IconChevronLeft = (p: SVGProps<SVGSVGElement>) => (
	<Glyph {...p}>
		<path d="M14.5 6l-6 6 6 6" />
	</Glyph>
);

export const IconChevronRight = (p: SVGProps<SVGSVGElement>) => (
	<Glyph {...p}>
		<path d="M9.5 6l6 6-6 6" />
	</Glyph>
);

export const IconChevronDown = (p: SVGProps<SVGSVGElement>) => (
	<Glyph {...p}>
		<path d="M6 9.5l6 6 6-6" />
	</Glyph>
);

export const IconPlus = (p: SVGProps<SVGSVGElement>) => (
	<Glyph {...p}>
		<path d="M12 5v14M5 12h14" />
	</Glyph>
);

export const IconArrowUp = (p: SVGProps<SVGSVGElement>) => (
	<Glyph {...p}>
		<path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />
	</Glyph>
);

export const IconStop = (p: SVGProps<SVGSVGElement>) => (
	<Glyph {...p}>
		<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
	</Glyph>
);

export const IconMic = (p: SVGProps<SVGSVGElement>) => (
	<Glyph {...p}>
		<path d="M12 3.5a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0v-6a3 3 0 0 1 3-3zM6 11.5a6 6 0 0 0 12 0M12 17.5v3M9 20.5h6" />
	</Glyph>
);

export const IconMicOff = (p: SVGProps<SVGSVGElement>) => (
	<Glyph {...p}>
		<path d="M12 3.5a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0v-6a3 3 0 0 1 3-3zM6 11.5a6 6 0 0 0 12 0M12 17.5v3M9 20.5h6M4 4l16 16" />
	</Glyph>
);

export const IconQuestion = (p: SVGProps<SVGSVGElement>) => (
	<Glyph {...p}>
		<path d="M9 9.5a3 3 0 1 1 4.5 2.6c-1 .6-1.5 1.2-1.5 2.4M12 18h.01" />
	</Glyph>
);

export const IconCamera = (p: SVGProps<SVGSVGElement>) => (
	<Glyph {...p}>
		<path d="M4 8.5h3l1.5-2.5h7L17 8.5h3v10H4z" />
		<circle cx="12" cy="13.5" r="3" />
	</Glyph>
);

export const IconImage = (p: SVGProps<SVGSVGElement>) => (
	<Glyph {...p}>
		<rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
		<circle cx="9" cy="10" r="1.6" />
		<path d="M20.5 15.5l-5-4-8 7" />
	</Glyph>
);

export const IconBook = (p: SVGProps<SVGSVGElement>) => (
	<Glyph {...p}>
		<path d="M12 7.5a3 3 0 0 0-3-3H4v13h5.5a2.5 2.5 0 0 1 2.5 2.5M12 7.5a3 3 0 0 1 3-3h5v13h-5.5a2.5 2.5 0 0 0-2.5 2.5M12 7.5V20" />
	</Glyph>
);

/** The records' glyph, drawn by the top bar's mark and the pager's page alike. */
export const CARDS_GLYPH = (
	<>
		<rect x="3.5" y="4.5" width="17" height="6" rx="1.5" />
		<rect x="3.5" y="13.5" width="17" height="6" rx="1.5" />
	</>
);

export const IconCards = (p: SVGProps<SVGSVGElement>) => (
	<Glyph {...p}>{CARDS_GLYPH}</Glyph>
);

export const IconPencil = (p: SVGProps<SVGSVGElement>) => (
	<Glyph {...p}>
		<path d="M15.5 5.5l3 3M4.5 19.5l1-4L16 5a2.1 2.1 0 0 1 3 3L8.5 18.5z" />
	</Glyph>
);

export const IconTrash = (p: SVGProps<SVGSVGElement>) => (
	<Glyph {...p}>
		<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10.5 11v5M13.5 11v5" />
	</Glyph>
);

export const IconSettings = (p: SVGProps<SVGSVGElement>) => (
	<Glyph {...p}>
		<path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
		<circle cx="16" cy="7" r="2" />
		<circle cx="8" cy="17" r="2" />
	</Glyph>
);

export const IconSignOut = (p: SVGProps<SVGSVGElement>) => (
	<Glyph {...p}>
		<path d="M10 4.5H5.5v15H10M14.5 8l4 4-4 4M18.5 12H9" />
	</Glyph>
);
