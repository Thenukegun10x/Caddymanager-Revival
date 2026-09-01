# Security Policy

## Supported Versions
| Version | Supported |
|---------|-----------|
| `main` (hardened revival) | ✅ |
| upstream `52f69b64` | ❌ unmaintained |

## Reporting a Vulnerability
Please **do not** file public issues for security bugs.

- Email: via GitHub Security Advisories (preferred) — `Security` tab -> `Report a vulnerability`
- Or open a private security advisory on this repo
- Expect response within 72h, fix within 14 days for Critical.

## Hardening Status
See `PLAN.md` §4-5 for verified findings (JWT fallback, SSRF, SQLi, IDOR, XSS, etc.) and remediation phases. Until Phase 1 tag `v0.1-hardened.1` is cut, do not expose this manager to the Internet — bind to `127.0.0.1` or tailnet and set strong `JWT_SECRET`.
