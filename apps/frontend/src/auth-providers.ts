/**
 * The ids the door signs in with, apart from the providers they name: the
 * login page is a client component, and importing them from the Auth.js
 * config would put the providers and the claim rules in its chunk.
 */
export { LOCAL_PROVIDER_ID } from "@platform/identity/claims/provider";

export const ENTRA_PROVIDER_ID = "microsoft-entra-id";
