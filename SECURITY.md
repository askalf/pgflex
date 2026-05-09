# Security policy

## Supported versions

pgflex is in early development. Only the latest minor version receives security updates.

| Version | Supported |
|---------|-----------|
| latest  | Yes       |
| <latest | No        |

## Reporting a vulnerability

If you find a security issue, please **do not open a public GitHub issue**. Instead, email `security@askalf.org` (or open a private security advisory via GitHub's "Report a vulnerability" button on the [Security tab](https://github.com/askalf/pgflex/security/advisories)) with:

- A description of the issue
- Steps to reproduce
- The version of pgflex you tested against
- Your assessment of impact

You can expect:

- An acknowledgement within 48 hours
- An assessment within 1 week
- Credit in the eventual fix's release notes if you'd like (let us know)

## Scope

In scope:

- SQL-injection paths within pgflex's own code (parameter handling, transaction wrapper, etc.). Note that user SQL passed via `db.query(text, params)` is your responsibility — pgflex forwards it untouched.
- Anything that lets a downstream user bypass `statement_timeout` defaults.
- Anything that crashes the adapter in a way an untrusted-input client could trigger remotely.

Out of scope:

- Vulnerabilities in `pg` or `@electric-sql/pglite` themselves — please report those upstream.
- DoS via large query results — bound by your own application's memory budget.
- Filesystem permissions on the pglite `dataDir` — pgflex runs as a single-user-trust process; if an attacker has write access there, they have the same access pgflex does.
