"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { Button } from "./components/controls";

export default function AppError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		console.error(error);
	}, [error]);
	const t = useTranslations("error");
	return (
		<main className="page">
			<div className="page-head">
				<h1>{t("heading")}</h1>
				<p className="lede">{t("body")}</p>
			</div>
			<div className="row">
				<Button variant="primary" onClick={reset}>
					{t("retry")}
				</Button>
				{error.digest ? (
					<p className="note">{t("reference", { digest: error.digest })}</p>
				) : null}
			</div>
		</main>
	);
}
