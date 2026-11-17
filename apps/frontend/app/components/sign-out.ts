"use client";

import { signOut } from "next-auth/react";
import { forgetHeldImages } from "@/src/chat/image-store";

/**
 * Leave this browser: what it kept of the pictures sent from it is
 * forgotten first, so whoever uses the device next finds none of them, then
 * the session ends and the door says why — signed out, or the account erased.
 */
export async function signOutHere(
	left: "out" | "erased",
	end: (options: { callbackUrl: string }) => Promise<unknown> = signOut,
): Promise<void> {
	await forgetHeldImages();
	await end({ callbackUrl: `/login?left=${left}` });
}
