# Security policy

Security fixes target the latest released version. Upgrade before checking whether a report still reproduces.

## Reporting a vulnerability

Email leeguoooo@gmail.com with the affected version, platform, reproduction steps and expected impact. Do not publish credentials, personal data or exploit details in a public issue. Prefer a minimal reproduction using synthetic data. We will assess the report and coordinate fixes and disclosure; there is no guaranteed response time or bounty program.

## Boundaries

ocs delivers messages into other agent sessions and can wake them. Anything a peer session sends is untrusted input for the receiving agent, which still applies its own permission prompts. Pair only computers you control: paired machines can message every session you expose to them. Pairing keys under the ocs state directory are credentials; do not copy them into issues or source control.
