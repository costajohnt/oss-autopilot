# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly by emailing the maintainer rather than opening a public issue.

**Contact:** Open a private security advisory via [GitHub Security Advisories](https://github.com/costajohnt/oss-autopilot/security/advisories/new).

## Threat Model

### Token Security

GitHub tokens are the most sensitive data the plugin handles.

- **Never persisted to disk.** Tokens are cached in module-scoped variables for the duration of the process only.
- **Dual-source with priority order:** `$GITHUB_TOKEN` environment variable is checked first; if unset, `gh auth token` is invoked as a subprocess.
- **No logging or printing.** Token values never appear in debug output, error messages, or state files. Error messages reference the variable name (`$GITHUB_TOKEN`), never its value.
- **Subprocess isolation.** The `gh auth token` call uses `execFileSync` with array arguments — no shell interpolation.

### Command Execution Safety

The plugin spawns subprocesses for `gh` CLI and `git` operations.

- **Array arguments only.** Every subprocess call uses `execFileSync` with explicit argument arrays. No shell strings, no `shell: true` option.
- **No dynamic code execution** anywhere in the codebase.
- **No template literal command construction.** Command arguments are always array literals or variables passed positionally.

### Input Validation

All GitHub URLs and identifiers are validated before use.

- **URL validation:** `parseGitHubUrl()` enforces `https://github.com/` prefix — no HTTP, no other hosts.
- **Owner validation:** `/^[a-zA-Z0-9_-]+$/` — alphanumeric, underscore, hyphen only.
- **Repo validation:** `/^[a-zA-Z0-9_.-]+$/` — alphanumeric, underscore, dot, hyphen only.
- **Message validation:** The `post` and `claim` commands validate comment bodies before submission.

### File System Security

All data lives under `~/.oss-autopilot/`.

- **Directory permissions:** `0o700` (owner-only) for the data directory, backup directory, and cache directory.
- **File permissions:** `0o600` (owner-only) for `state.json` and HTTP cache entries.
- **Atomic writes:** State files are written to a `.tmp` file first, then atomically renamed via `fs.renameSync`. This prevents corruption from crashes or concurrent access.
- **Advisory file locks:** State writes acquire an exclusive lock (`{ flag: 'wx' }`) with PID tracking. Stale locks (>30 seconds) are automatically cleaned up.
- **No credentials in state.** `state.json` contains only PR metadata (titles, URLs, status, labels). Dashboard HTML is generated locally and HTML-escaped to prevent XSS from untrusted GitHub API data.

### Network Security

- **HTTPS only.** All API calls go to `api.github.com` over HTTPS.
- **No third-party services contacted.** The plugin communicates exclusively with GitHub's API.
- **Rate limit handling.** The Octokit client uses `@octokit/plugin-throttling` to respect API rate limits rather than hammering endpoints on failure.

### Plugin Security

The plugin layer (agents, commands, skills) consumes untrusted data from GitHub.

- **Prompt injection awareness.** Agents that process GitHub content (PR titles, descriptions, comments, issue bodies) treat it as untrusted input. The `pr-responder` agent explicitly flags suspicious content to the user.
- **Human-in-the-loop enforcement.** The pre-commit review workflow requires explicit user approval before posting comments, with enumerated acceptance phrases and negation checking to prevent accidental posts.
- **AI attribution prevention.** CLAUDE.md rules prevent AI-identifying markers in commits, comments, and PRs submitted to external repositories.

### Dependency Security

The attack surface is intentionally minimal.

- **3 production dependencies:** `@octokit/rest`, `@octokit/plugin-throttling`, `commander`. All other packages are devDependencies only.
- **npm audit in CI:** The CI workflow runs `npm audit --audit-level=high` on every push and PR.
- **Dependabot:** Weekly automated dependency scanning for the npm ecosystem.
- **CodeQL:** GitHub's CodeQL security analysis runs on pushes to main and on pull requests.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.39.x  | Yes       |
| < 0.39  | No        |
