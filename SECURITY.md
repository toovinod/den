# Security policy

## Supported versions

Swarm is pre-alpha.
Only the latest release and `main` receive security fixes.

## Reporting a vulnerability

Please do not open a public issue.
Report it privately through [GitHub's private vulnerability reporting](https://github.com/toovinod/swarm/security/advisories/new).

Include what you found, how to reproduce it and what an attacker could do with it.
We aim to acknowledge a report within 3 working days and to agree on a disclosure date with you once a fix is ready.

## Scope

These matter most to us:

- Anything that lets a repository, web page or agent run commands or skip an approval without the user's consent.
- Leaks of API keys, tokens or local workspace data.
- Access to the daemon from anything other than the Swarm window that started it.
- Access to another user's organization or cloud workspace.
