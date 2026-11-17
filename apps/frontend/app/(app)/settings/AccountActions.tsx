"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { ACCOUNT_ERASED } from "@/src/errors";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Button, StatusLine } from "../../components/controls";
import { signOutHere } from "../../components/sign-out";

type Busy = "export" | "delete" | null;

/** Leave after an erase: signed out here, or failing that, sent to the door by the browser. */
export async function leaveErased(
	leave: () => Promise<void> = () => signOutHere("erased"),
	go: (url: string) => void = (url) => window.location.assign(url),
): Promise<void> {
	try {
		await leave();
	} catch {
		go("/login?left=erased");
	}
}

/**
 * What a DELETE's answer means. A 401 is "erased" only when it names the
 * erase (`account_erased`: this session's account is gone, the session with
 * it); any other 401 is a session that is not signed in, which erased
 * nothing and is sent to sign in.
 */
export async function eraseAnswer(
	res: Response,
): Promise<"erased" | "sign-in" | "failed"> {
	if (res.ok) return "erased";
	if (res.status !== 401) return "failed";
	const body = (await res.json().catch(() => null)) as {
		code?: unknown;
	} | null;
	return body?.code === ACCOUNT_ERASED ? "erased" : "sign-in";
}

/** Download a copy, delete everything, sign out — the three things a person may do to their own data. */
export function AccountActions() {
	const t = useTranslations("settings");
	const common = useTranslations("common");
	const [busy, setBusy] = useState<Busy>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [confirming, setConfirming] = useState(false);

	const exportData = async () => {
		setBusy("export");
		setProblem(null);
		try {
			const res = await fetch("/api/account/export");
			if (!res.ok) throw new Error(String(res.status));
			const url = URL.createObjectURL(await res.blob());
			const a = document.createElement("a");
			a.href = url;
			a.download = "account-export.json";
			a.click();
			URL.revokeObjectURL(url);
		} catch {
			setProblem(t("exportFailed"));
		} finally {
			setBusy(null);
		}
	};

	const deleteAccount = async () => {
		setBusy("delete");
		setProblem(null);
		let answer: Awaited<ReturnType<typeof eraseAnswer>>;
		try {
			answer = await eraseAnswer(
				await fetch("/api/account", { method: "DELETE" }),
			);
		} catch {
			answer = "failed";
		}
		if (answer === "sign-in") {
			window.location.assign("/login");
			return;
		}
		if (answer === "failed") {
			setProblem(t("deleteFailed"));
			setBusy(null);
			setConfirming(false);
			return;
		}
		// The account is gone whatever happens next: a sign-out that fails
		// still ends at the door, which says so, never at "deletion failed".
		await leaveErased();
	};

	return (
		<>
			{problem ? <StatusLine tone="danger">{problem}</StatusLine> : null}
			<div className="action-line">
				<Button disabled={busy !== null} onClick={() => void exportData()}>
					{busy === "export" ? t("exportWorking") : t("exportData")}
				</Button>
				<span className="hint">{t("exportHint")}</span>
				<Button
					variant="danger"
					disabled={busy !== null}
					onClick={() => setConfirming(true)}
				>
					{t("deleteAccount")}
				</Button>
				<span className="hint">{t("deleteHint")}</span>
				<Button
					disabled={busy !== null}
					onClick={() => void signOutHere("out")}
				>
					{common("signOut")}
				</Button>
				<span className="hint" />
			</div>
			{confirming ? (
				<ConfirmDialog
					heading={t("deleteConfirmHeading")}
					body={
						<>
							<p>{t("deleteConfirmBody")}</p>
							<p className="hint">{t("deleteConfirmAdvice")}</p>
						</>
					}
					confirmLabel={
						busy === "delete" ? t("deleteWorking") : t("deleteConfirm")
					}
					cancelLabel={t("deleteCancel")}
					busy={busy === "delete"}
					onCancel={() => setConfirming(false)}
					onConfirm={() => void deleteAccount()}
				/>
			) : null}
		</>
	);
}
