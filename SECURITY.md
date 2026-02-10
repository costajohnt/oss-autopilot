# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly by emailing the maintainer rather than opening a public issue.

**Contact:** Open a private security advisory via [GitHub Security Advisories](https://github.com/costajohnt/oss-autopilot/security/advisories/new).

## Scope

Security considerations for this project include:

- **GitHub token handling**: Tokens are retrieved via `gh auth token` (user-managed) or `$GITHUB_TOKEN` environment variable. Tokens are never stored by the plugin.
- **State file permissions**: `~/.oss-autopilot/state.json` contains PR metadata (titles, URLs, status). No credentials are stored in state.
- **Dashboard HTML**: Generated locally at `~/.oss-autopilot/dashboard.html`. Content is HTML-escaped to prevent XSS from untrusted GitHub API data (PR titles, comment bodies, author names, URLs, repo names).
- **Network requests**: All API calls go to `api.github.com` via HTTPS. No third-party services are contacted.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.12.x  | Yes       |
| < 0.12  | No        |
