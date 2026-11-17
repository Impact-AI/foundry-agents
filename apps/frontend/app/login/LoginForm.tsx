"use client";

import type { AuthMode } from "@platform/identity/claims";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { ENTRA_PROVIDER_ID, LOCAL_PROVIDER_ID } from "@/src/auth-providers";
import { BrandLogo } from "../components/BrandLogo";
import { Button, StatusLine, TextField } from "../components/controls";
import { returnPath } from "./return-path";

/** The error codes the door can be sent to with, Auth.js's and the backend's alike. */
const KNOWN_ERRORS = [
	"not_allowed",
	"no_account",
	"deactivated",
	"unavailable",
	"AccessDenied",
	"Configuration",
	"OAuthCallbackError",
	"OAuthAccountNotLinked",
	"CredentialsSignin",
] as const;

function errorKey(
	code: string | null,
): (typeof KNOWN_ERRORS)[number] | "generic" | null {
	if (!code) return null;
	return (KNOWN_ERRORS as readonly string[]).includes(code)
		? (code as (typeof KNOWN_ERRORS)[number])
		: "generic";
}

export function LoginForm({
	mode,
	logoSrc = "",
}: {
	mode: AuthMode;
	/** The deployment's logo, above the heading; empty for none. */
	logoSrc?: string;
}) {
	const t = useTranslations("login");
	const tAi = useTranslations("ai");
	const locale = useLocale();
	const params = useSearchParams();
	const callbackUrl = returnPath(params.get("callbackUrl"));
	const error = errorKey(params.get("error"));
	const left = params.get("left");
	const [pending, setPending] = useState(false);
	const [name, setName] = useState("");

	function signInLocally(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		void signIn(LOCAL_PROVIDER_ID, { name, callbackUrl });
	}

	function signInWithEntra() {
		setPending(true);
		// The identity provider draws its own screen; asking for it in this
		// page's language is the one hand-off where the choice is lost.
		void signIn(ENTRA_PROVIDER_ID, { callbackUrl }, { ui_locales: locale });
	}

	return (
		<section className="card door-card" aria-labelledby="door-heading">
			<header className="card-head">
				<BrandLogo src={logoSrc} className="brand-logo door-logo" />
				<h1 id="door-heading">{t("heading")}</h1>
				<p className="lede">{t(mode === "local" ? "localLede" : "lede")}</p>
			</header>
			{error ? (
				<StatusLine tone="danger">{t(`errors.${error}`)}</StatusLine>
			) : left === "erased" ? (
				<StatusLine tone="info">{t("leftErased")}</StatusLine>
			) : left ? (
				<StatusLine tone="info">
					{t(mode === "local" ? "localLeftOut" : "leftOut")}
				</StatusLine>
			) : null}
			{mode === "local" ? (
				<form className="card-body" onSubmit={signInLocally}>
					<TextField
						label={t("localName")}
						name="name"
						type="text"
						value={name}
						onChange={(event) => setName(event.target.value)}
						autoComplete="username"
						maxLength={60}
						required
						hint={t("localHint")}
					/>
					<Button
						type="submit"
						variant="primary"
						disabled={pending || name.trim() === ""}
					>
						{pending ? t("redirecting") : t("localSignIn")}
					</Button>
				</form>
			) : (
				<Button variant="primary" disabled={pending} onClick={signInWithEntra}>
					{pending ? t("redirecting") : t("signIn")}
				</Button>
			)}
			<footer className="card-foot">
				<p className="note">{tAi("door")}</p>
				<a href="/privacy">{t("privacy")}</a>
			</footer>
		</section>
	);
}
