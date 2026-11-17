"use client";

import type { ReactNode } from "react";
import type { Section } from "@/src/stage/stage";
import { IconButton, IconClose } from "../../components/controls";

/**
 * One tile: a quiet head with the section's word and the way out on one
 * line, and the instrument filling the rest. The inner box is what the
 * move counter-scales (`stage-motion`); a leaving tile is inert.
 */
export function StageTile({
	section,
	label,
	closeLabel,
	leaving,
	onClose,
	children,
}: {
	section: Section;
	label: string;
	closeLabel: string;
	leaving: boolean;
	onClose: () => void;
	children: ReactNode;
}) {
	return (
		<section
			className={`panel stage-tile stage-tile--${section}${leaving ? " is-leaving" : ""}`}
			data-key={section}
			aria-label={label}
			inert={leaving || undefined}
		>
			<div className="stage-tile-inner card-frame">
				<header className="stage-tile-head card-head card-head--bar">
					<span className="stage-tile-label eyebrow">{label}</span>
					<IconButton
						label={closeLabel}
						variant="ghost"
						size="sm"
						className="stage-tile-close"
						onClick={onClose}
					>
						<IconClose />
					</IconButton>
				</header>
				<div className="stage-tile-body">{children}</div>
			</div>
		</section>
	);
}
