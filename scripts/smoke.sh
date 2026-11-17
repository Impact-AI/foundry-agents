#!/usr/bin/env bash
# Is the deployment answering, and refusing what it should? After `azd up`:
#
#   ./scripts/smoke.sh
#
# Opt-in and never in CI: it talks to your deployment. It reads the azd
# environment, then checks that the frontend answers on /health and at the
# door, and that an API call without a session is refused with 401. With the
# demo's sign-in (AUTH_MODE=local) it goes on as a new person: signs in, lists
# the library (the sample's documents, unless SEED_SAMPLE_LIBRARY is false),
# sends one chat turn and reads the answer as it streams, then deletes the
# account it made, so the run leaves nothing behind. Under entra it stops
# after the unauthenticated checks: a sign-in there is a person at the
# identity provider's page, which a script is not.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

# The azd environment, as azd hands it to a hook.
while IFS= read -r line; do
	[ -n "$line" ] || continue
	value="${line#*=}"
	value="${value#\"}"
	export "${line%%=*}=${value%\"}"
done < <(cd "$here/.." && azd env get-values)
[ -n "${FRONTEND_URL:-}" ] || { echo "smoke: FRONTEND_URL is not in the azd environment; run azd up first" >&2; exit 1; }
origin="${FRONTEND_URL%/}"

pass() { echo "smoke: ok   $*"; }
fail() { echo "smoke: FAIL $*" >&2; exit 1; }
work="$(mktemp -d)"
jar="$work/cookies"
# The account the run signs in as is deleted however the run ends: a check
# that fails after the sign-in still leaves nothing behind. The mark is set
# before the sign-in is sent, since a sign-in whose answer never arrived may
# have made the account all the same; 401 is the answer of a run that holds
# no session, and so made none.
signed_in=""
on_exit() {
	if [ -n "$signed_in" ]; then
		case "$(curl -sS --max-time 120 -o /dev/null -w '%{http_code}' -b "$jar" -X DELETE "$origin/api/account" || true)" in
		204 | 401) ;;
		*) echo "smoke: the smoke test's account could not be deleted; it is the one named \"Smoke test\"" >&2 ;;
		esac
	fi
	rm -rf "$work"
}
trap on_exit EXIT

# GET or POST with the cookie jar; prints the status, leaves the body in $work/body.
call() {
	curl -sS --max-time 120 -o "$work/body" -w '%{http_code}' -b "$jar" -c "$jar" "$@"
}

status="$(call "$origin/health")"
[ "$status" = 200 ] || fail "$origin/health answered $status"
pass "$origin/health answers"

status="$(call "$origin/login")"
[ "$status" = 200 ] || fail "the door ($origin/login) answered $status"
pass "the door answers"

status="$(call "$origin/api/conversations")"
[ "$status" = 401 ] && grep -q '"unauthenticated"' "$work/body" ||
	fail "an API call without a session answered $status: $(head -c 200 "$work/body")"
pass "an API call without a session is refused (401)"

if [ "${AUTH_MODE:-}" != "local" ]; then
	echo "smoke: AUTH_MODE is ${AUTH_MODE:-unset}, not local: signing in takes a person at the identity provider, so the checks stop here"
	exit 0
fi

# Auth.js's own sign-in: a CSRF token, then the local provider's form.
status="$(call "$origin/api/auth/csrf")"
csrf="$(sed -n 's/.*"csrfToken":"\([^"]*\)".*/\1/p' "$work/body")"
[ "$status" = 200 ] && [ -n "$csrf" ] || fail "no CSRF token from $origin/api/auth/csrf ($status)"
signed_in=1
call -X POST "$origin/api/auth/callback/local" \
	--data-urlencode "csrfToken=$csrf" --data-urlencode "name=Smoke test" \
	--data-urlencode "callbackUrl=$origin/chat" >/dev/null
status="$(call "$origin/api/conversations")"
[ "$status" = 200 ] || fail "signed in, the conversations answered $status: $(head -c 200 "$work/body")"
pass "a local sign-in holds a session"

status="$(call "$origin/api/library?query=onboarding")"
[ "$status" = 200 ] || fail "the library answered $status: $(head -c 200 "$work/body")"
if [ "$(printf %s "${SEED_SAMPLE_LIBRARY:-true}" | tr '[:upper:]' '[:lower:]')" != "false" ]; then
	grep -q '"Onboarding handbook"' "$work/body" ||
		fail "the library does not list the sample's documents: $(head -c 300 "$work/body")"
	pass "the library lists the sample's documents"
else
	pass "the library answers (SEED_SAMPLE_LIBRARY is false, so no document is expected)"
fi

# One turn through the chat runtime, as the browser sends it.
uuid() {
	local h
	h="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
	printf '%s-%s-4%s-8%s-%s' "${h:0:8}" "${h:8:4}" "${h:13:3}" "${h:17:3}" "${h:20:12}"
}
status="$(call -X POST "$origin/api/copilotkit" -H 'content-type: application/json' \
	-H 'accept: text/event-stream' \
	--data "{\"method\":\"agent/run\",\"params\":{\"agentId\":\"assistant\"},\"body\":{\"threadId\":\"$(uuid)\",\"runId\":\"$(uuid)\",\"tools\":[],\"context\":[],\"forwardedProps\":{},\"state\":{},\"messages\":[{\"id\":\"$(uuid)\",\"role\":\"user\",\"content\":\"Hello\"}]}}")"
[ "$status" = 200 ] || fail "the chat turn answered $status: $(head -c 300 "$work/body")"
grep -q '"RUN_ERROR"' "$work/body" && fail "the chat turn failed: $(grep -m1 '"RUN_ERROR"' "$work/body" | head -c 300)"
grep -q '"TEXT_MESSAGE_CONTENT"' "$work/body" && grep -q '"RUN_FINISHED"' "$work/body" ||
	fail "the chat turn streamed no answer: $(head -c 300 "$work/body")"
pass "a chat turn streams an answer"

status="$(call -X DELETE "$origin/api/account")"
# Only a delete that landed is the end of the account: one that was refused is asked again on the way out, and named.
[ "$status" = 204 ] || fail "deleting the smoke test's account answered $status"
signed_in=""
pass "the smoke test's account is deleted"
