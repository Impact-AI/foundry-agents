# Security

## Reporting a vulnerability

Do not open a public issue for a security problem. Use the repository's private vulnerability reporting (GitHub → **Security** → **Report a vulnerability**) so the report reaches the maintainers alone. Say which part is affected, how to reproduce it, and what it lets an attacker do. If private reporting is unavailable to you, email security@impact.ai, the maintainers' security contact, instead. You will get an acknowledgement within five working days, and a fix or a statement of why none is needed before anything is published.

## What is in scope

The template: the infrastructure under `infra/`, the hooks and scripts, the two apps and the packages they are built from. A weakness in an Azure service itself is reported to Microsoft through the [Microsoft Security Response Center](https://msrc.microsoft.com/report).

## Known gaps already documented

[docs/security.md](docs/security.md) describes each layer and lists the known gaps; a report about one of those is welcome, but it is not news. Demo mode is for trying it out: public endpoints and a sign-in anyone can use, never for real data.
