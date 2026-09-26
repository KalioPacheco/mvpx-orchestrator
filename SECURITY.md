# Security Policy

## Supported version

The current public-beta line is `0.4.x`. Security fixes are expected to target the latest 0.4.x release unless a newer supported line is documented.

## Reporting a vulnerability

Please do **not** publish exploit details, credentials, private repository contents, or sensitive logs in a public issue.

When the GitHub repository has private vulnerability reporting enabled, use GitHub's **Report a vulnerability** / private security advisory flow. If private reporting is not available yet, contact the repository maintainer through a private channel before disclosing technical details publicly.

A useful report includes:

- affected MVPX version;
- operating system and Node version;
- minimal reproduction steps;
- security impact;
- whether the issue can expose secrets, modify files outside the target workspace, bypass intended safety restrictions, or corrupt Git/state recovery;
- a sanitized log or proof of concept when safe to share.

## Sensitive areas

Please treat issues in these areas as security-sensitive until reviewed:

- command execution and argument construction;
- filesystem scope / path traversal;
- Git checkpoint and rollback behavior;
- credential or environment-variable handling;
- prompt construction that may copy secrets into model context;
- sandbox/network restrictions;
- state files under `.mvpx/`;
- external dependency installation or preparation flows.

## Secret handling

MVPX is designed not to modify secrets automatically. Target repositories can still contain secrets in their working tree or environment, so users should follow normal secret-management practices and review agent-visible files before unattended runs.
