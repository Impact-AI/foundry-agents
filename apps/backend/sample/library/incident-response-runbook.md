---
title: Incident response runbook
summary: What to do when something is broken or unsafe, from the first report to the review afterwards.
tags: [security, operations]
---

## Declaring an incident

Anybody can declare an incident, and nobody is blamed for declaring one that turns out to be minor. Declare one when customers cannot do something they normally can, when data may have reached somebody it should not, or when you are not sure and it is outside working hours. Open it from the incident channel with one line saying what you see, not what you think caused it.

The on-call engineer for the affected system is paged automatically and acknowledges within fifteen minutes. If nobody acknowledges, the page goes to their lead and then to the head of operations. Do not wait for the cause before declaring: an incident that turns out to be nothing is closed in five minutes, while a real one found an hour late is an hour of customers left without an answer.

![The runbook's illustration: an abstract blend of signal red and near-black maroon with soft circles of light](pictures/incident-board.png)

## Roles

Every incident has one lead, who decides, and one scribe, who writes down what was decided and when. The lead is the first engineer to acknowledge until they hand the role on, out loud, in the channel. Everyone else works on what the lead asks for and reports back in the channel, not in private messages.

When customers are affected, the support lead joins and owns what customers are told: a first notice within thirty minutes, then an update at least every hour, even when there is nothing new to say. A suspected data exposure brings in the security team, who decide whether anybody outside the company must be told, and by when.

## After the incident

Within five working days, the lead writes a short review: what happened, how it was found, what was done, and what will change. Reviews look for causes in systems and habits, never in a person. Each change gets an owner and a date, and the actions are tracked until they are done.
