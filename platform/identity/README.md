# @platform/identity

This package decides who a person is and what they get: the sign-in rules, the account record and its erasure, the access tier from the identity provider's app roles, and the checks made each time something is spent.

- `claims` — the rules every sign-in goes through, with no database and no Azure SDK, so a web app's edge runtime can apply them. They cover the account id a token's claims resolve to, the email, the sign-in check (who may sign in at all), the access policy (the tier from the identity provider's app roles, and from nothing else), the groups a token names, the sign-in mode and what goes on a session. They also hold the one compact HMAC token (`signCompact` / `verifyCompact`, a key per label under one secret) that every signed thing in the platform is built from.
- `accounts` — the durable record of a sign-in, and the person behind it.
  - **The record.** It is upserted at each sign-in, with the roles and groups as of the last one and the one flag that deactivates it. It is one Cosmos DB document per account in the `accounts` container, partitioned by the account id, so every read is a point read. `identityContainers` declares it for an app's start to verify and a test to create.
  - **A sign-in's writes.** A sign-in inserts the document. If that is refused with 409 because the document exists, it refreshes it with a patch instead, and fills the name with a second patch conditional on the document holding none.
  - **The person.** One account is one person. Their display name, what they wrote about themselves (`about`) and how they want to be talked to (`preferences`) are fields of the document. They are edited through `updatePerson` and bounded by `PERSON_NAME_MAX` and `PERSON_TEXT_MAX`, because the agent reads them into every prompt. The name is the provider's until the person sets their own; a later sign-in does not overwrite it.
  - **The account id.** The account id is the agent's memory scope, and nothing else is. It is the provider's stable subject (`oid`) and nothing else: a provider token without one names no account, and the sign-in is refused `no_account`.
  - **Erasure.** The record's part of an erasure is two writes with the app's own sweep between them. `beginErase` empties the document of the person without deleting it, and shuts it (`erasing`), in one write that lands whole or not at all. From then on no session is admitted on the id, no sign-in makes an account of it (`EraseUnderWayError`, answered as `unavailable`) and no edit lands on it. So nothing can be made under the id while what the app holds for it is swept. `finishErase` turns the shut document into what the erase leaves.
  - **One erase at a time.** An erase belongs to one holder at a time:
    - A second `beginErase` while the first holds it answers `busy`. Two sweeps side by side would let the first to finish end the erase with the other still running.
    - A holder whose sweep fails lets go (`releaseErase`).
    - A holder sweeps under `underLease`, which renews its hold every `ERASE_RENEW_SECONDS` and hands the sweep a `stillHeld` it asks before each step. A sweep that is slow but alive is never taken over. One that lost its hold, its process frozen past the hold, stops at its next step.
    - An erase let go, or not renewed for `ERASE_STALLED_SECONDS` (five minutes), is taken up by whoever asks next. That is the person's erase again, or their next sign-in, which `resolveSignIn` finishes with the `sweep` the app gives it before it admits anyone.
  - **What an erase leaves.** `deleteAccount` is the two writes back to back, for where nothing else is held. A deactivated account's document becomes a tombstone: its id, the deactivation and when it was erased, kept for good. With no document a subject reads as a first sign-in, so deleting a deactivated one would be the way back in. An active account's document becomes a marker: its id and when it was erased, which removes itself once it is no longer needed (`standing` below).
  - **Conditional writes.** Every write names the document it read, by its etag: the erase, a sign-in's refresh and the name it fills, a deactivation. So whatever lands in between, the write is decided again on what is there:
    - a deactivation that lands while an erase runs is kept and never given a lifetime;
    - a refresh never lands on what an erase left;
    - with the asking session named, an account erased and signed in under again since that session began is left alone (`ErasedSessionError`).
  - **Tombstones and markers.** A tombstone takes no write but a re-activation, which makes an empty record of it, created then. A marker can be deactivated, which makes a tombstone of it. Neither is anybody's record, and nor is a document an erase has shut: `updatePerson` and `setVoiceTuning` answer as for an id with none.
  - **Requests that span an erase.** A request names the account it was admitted on (`AdmittedAccount`, told apart by when it was made). `updatePerson` and `setVoiceTuning` write only while the document is still that account. A request admitted before an erase, whose body arrives after it and after the sign-in that made a new account of the id, writes nothing to the new account. The backend holds every other write to the same rule before any route runs (`apps/backend`'s `judgedOnArrival`). A request that may write is read again once its body has arrived, and refused `401 account_erased` when the account is no longer the one it was admitted on.

  The document's states, and what each takes:

  | Document | Sign-in | A session from before the erase | A session begun since | Erase | Edit | Deactivate | Re-activate |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | none | creates the account | active | active | nothing to write | refused | no record | no record |
  | person | refreshes it | `erased` while the erase is kept, when the account was made after one | active | shut, then swept, then a marker | written | deactivated | no change |
  | deactivated | refused `deactivated` | `erased`, when the account was made after one | `deactivated`, with its rights over what is held | shut, then swept, then a tombstone | written | no change | person |
  | `erasing` (shut, unfinished) | `unavailable` while held; taken up, swept and finished once let go or stalled, then as for what it left | `erased`; may ask for the erase again, which takes it up once let go or stalled | `erased` | `busy` while held; otherwise taken up | refused | kept: the erase ends as a tombstone | kept: the erase ends as a marker |
  | marker | a new account, admission stamped | `erased` | `erased` until a sign-in | answered, nothing done | refused | tombstone | no record |
  | tombstone | refused `deactivated` | `erased` | `erased` | answered, nothing done | refused | no change | an empty person, created then |
  | marker past its time | a clean new account | active | active | nothing to write | refused | tombstone | no record |

  An erase whose sweep fails every time, because the store or a service it needs keeps refusing, leaves the document `erasing`. The id admits no session and no sign-in (`unavailable`) for as long as that lasts, and each sign-in or erase asked for sweeps again. That has no bound but the outage, and it is what keeps a new account from being handed what was not erased. A cached copy that cannot be dropped does not fail the sweep; it expires on its own.
- `assertions` — short-lived assertions one service presents to another, on the claims token under `AUTH_SECRET`: the caller assertion a web app mints from a verified session (subject, email, roles, groups, tier), and the scope assertion that names one memory scope. One construction, two purposes, never the same key.
- `standing` — whether an account may still spend. It is asked at the point of use and fails closed, on one read of the row that also says what the account gets (`readAccountStanding`).
  - **Sessions older than an erasure.** The same read refuses a session older than its account's erasure (`erased`, `401 account_erased`).
  - **How long a marker lasts.** `deleteAccount` empties an active account's document to its id and `erasedAt`, and gives it a lifetime of `ERASE_KEPT_SECONDS`. That is the session's longest age, plus the life of the last caller assertion it can mint, plus a minute for the clocks (`CLOCK_SKEW_SECONDS`). So no caller from before the erase outlives what refuses it.
  - **Documents that admit no one.** While the document is only what an erase left or is leaving (a marker, a tombstone, or one an erase has shut and not finished), no session is admitted on it. `reading.deactivated` and `reading.erasing` say which.
  - **Ownership before deactivation.** Whose the record is comes before its deactivation. A session from before an erase is `erased` on the account made since, even when that account has been deactivated. So it keeps none of a deactivated person's rights over a record that is not its own.
  - **A marker past its time.** One the service has not removed yet is ignored by every read. A sign-in on it makes a new account and stamps when, by this side's clock (`admittedAt`). The erase is kept on the new account for the same time.
  - **Clock skew.** A session is admitted when the `signedInAt` its caller assertion carries is at or after that stamp, less the minute. So a web app whose clock runs up to a minute behind is not refused its new session. A session that began within that minute, before a sign-in that followed the erase at once, is admitted with it. A clock further behind than that has its sign-ins after an erase refused until it passes the stamp less the minute. A later sign-in does not renew the stamp, because that would refuse the sessions opened on other devices since.
  - **Sessions with no sign-in time.** A session that names no sign-in time is refused for as long as the erase is kept, and no longer. `reading.remade` says whether somebody else's record is under the id by now.
- `sign-in` — the one call a backend makes when a web app reports a sign-in: the sign-in check, then standing, record and access.
- `deployment-rules` — what a production process (`@platform/config`'s `isProductionRuntime`) refuses to start with: no `AUTH_SECRET`, one shorter than 32 characters or the template's vault placeholder `unset`, a sign-in mode that does not exist, or, in hardened mode, the local sign-in or admission without a role.

`./claims`, `./assertions` and `./deployment-rules` are entries of their own because they reach no database and no Azure SDK: a web app on Node mints its caller assertion and checks its deployment from them alone, while the root entry pulls in `@platform/cosmos`. The `SignInOutcome` type is reachable from `./claims`.

## Granting access

Access is role-based from the identity provider, never from an environment variable. Two app roles on the Entra app registration are the whole policy, and an optional third lets a tester tune their own live voice:

| Role value | Grants |
| --- | --- |
| `user` | Admission alone, for a registration that requires a role (below). |
| `premium` | The premium tier, which three places read: `@platform/metering`'s `isUnmetered` (`src/tier.ts`) lifts every allowance, burst and per-second bound; `@platform/agent`'s `sessionVoiceEngine` (`src/foundry/voice-engine.ts`) answers the live session with the engine `voice.engineByTier.premium` names, spoken in the `voice` document's premium voice; and `@platform/metering`'s `sessionBounds` (`src/live/bounds.ts`) gives the session the longer ceiling, `premium.maxSessionSeconds` in the limits document. |
| `tester` (`VOICE_TESTER_ROLE`) | Settings → Voice tuning: `isVoiceTester`, read from the account's row at the point of use by the backend's `/voice/tuning` routes and by each live session's open, lets the person override how their own sessions run ([configuration](../../docs/configuration.md#who-tunes-voice)). It admits nobody on its own and is not among `KNOWN_ROLES`, so assign it beside `user` or `premium`. |

The template's `preprovision` hook makes the registration with all three ([deployment](../../docs/deployment.md#sign-in-with-microsoft-entra-id)). On a registration of your own, add them under its **App roles** (or in the manifest's `appRoles`):

```json
"appRoles": [
	{ "allowedMemberTypes": ["User"], "displayName": "Premium", "description": "The premium tier.", "id": "<new guid>", "isEnabled": true, "value": "premium" },
	{ "allowedMemberTypes": ["User"], "displayName": "User", "description": "May sign in.", "id": "<new guid>", "isEnabled": true, "value": "user" },
	{ "allowedMemberTypes": ["User"], "displayName": "Tester", "description": "Tunes live voice for their own sessions.", "id": "<new guid>", "isEnabled": true, "value": "tester" }
]
```

Who may sign in at all is the registration's own decision: switch **Assignment required** on under the enterprise application's **Properties**, and the provider refuses a token to anyone not assigned before this package runs. For a registration that cannot be locked that way, `AUTH_REQUIRE_ROLE=true` is the second line: a token carrying neither role is refused at sign-in. With neither, everyone the provider authenticates is admitted on the base tier. In hardened mode (`HARDENED=true`) a replica refuses to start without `AUTH_REQUIRE_ROLE`, since the assignment switch is in the tenant where this code cannot see it; the template sets both together.

### Assigning a role

In the Entra admin center, **Enterprise applications** → the application → **Users and groups** → **Add user/group**: pick the user or the group, pick the role, assign. The role reaches the token at the person's next sign-in, not the current session.

A role is read from the token's `roles` claim at sign-in, recorded on the account, baked onto the session as a snapshot, and re-resolved from the row wherever something is spent. Removing a role reaches the row at the person's next sign-in, and from there every later spend. A session is a stateless token and is not revoked, so what bounds the wait is the session's own lifetime: the reference frontend ends one eight hours after the sign-in that made it, however active (`SESSION_MAX_AGE_SECONDS`).

### Groups

The token's `groups` claim carries object ids, for access control at the level of a document. It is kept on the account's row at every sign-in. A backend decides who may read what from the row (`accountAccess`), never from the copy the session and the caller assertion carry, so a group removed at the provider reaches document access on the same terms as a role. Switch it on under the registration's **Token configuration** → *Add groups claim*, emitting group ids.

The provider stops listing at a bound of its own and marks the overage instead (`hasgroups`, or `groups` under `_claim_names`). Such a token records no groups, whatever list it also carries, and this package never calls Microsoft Graph to fetch them. Emit the ids of the groups assigned to the application only, or use app roles. `GROUPS_MAX` (200) caps what the row holds.

## The sign-in mode

`AUTH_MODE` is a bootstrap variable both apps read, decided once per deployment:

- `entra` — the identity provider, the default, and the only mode hardened mode allows: with `HARDENED=true`, the template's flag for hardened mode, a replica configured for `local` refuses to start.
- `local` — a sign-in with a name and no password, for trying a deployment that has no app registration yet. Every local account is `user`, a member on the base tier: access comes from the provider's roles, and a demo has no provider. The name is display only. A name proves nobody, so the account id is random, minted per sign-in and kept on the session. Every local sign-in is a new person. Once the session ends (signed out, expired, another browser), nobody can get back to that account, including whoever made it. What was said under it stays in the database. To keep people's history, sign them in with `entra`.

A value that names no mode reads as `entra` off a deployment and refuses to start on one.

Deliberately not here: several people under one account (one account is one person, so there is no second memory scope to choose), linking two sign-in identities into one account (one subject is one account), an allowlist of addresses or domains, a grants table, and any fetch against the provider's directory.

The container is the template's (`infra/modules/cosmos.bicep`), which leaves `about` and `preferences` out of the index: nothing queries a person's own words. The tests run on `@platform/cosmos/testing`: in memory, or on the emulator under `COSMOS_TESTS=1`.
