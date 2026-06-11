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

#### Agent input threat model (#1192)

PR titles, PR bodies, issue bodies, review comments, discussion comments, and CI logs returned to agents are attacker-controllable. The known threats are: making the agent post a comment on the user's behalf without their consent (`post`/`claim` paths), make false claims in a PR response, raise an issue's vetting score, dismiss notifications, or exfiltrate session context.

Controls in priority order:

1. **Human-in-the-loop on every state-changing GitHub call.** `post` and `claim` require explicit user approval before sending (#1053). This is the primary control — every other layer is defense-in-depth.
2. **Input fencing, wired at runtime (#1372).** The `wrapUntrustedContent(text, label, meta?)` helper in `@oss-autopilot/core` wraps GitHub content in a `<github-content>` fence with escape-proof handling (open- and close-tag escaping, lossless round-trip). Comment and review body fields are fenced at the agent-facing serialization boundary: `comments` output (`runComments`), `guidelines fetch-corpus` bundles (`fetchPRCommentBundle`), and `daily`/`startup` `commentedIssues` excerpts (`toDailyOutput`). Agents are instructed in `workflows/reference.md` to treat anything inside that fence as data, not instructions, and to fence the remaining unfenced fields (titles, search/vet output) themselves.
3. **Agent guidance.** `pr-responder`, `issue-scout`, `pr-compliance-checker`, `pr-health-checker`, `repo-evaluator`, and `contribution-strategist` carry pointer text directing them to treat fenced content as data, fence unfenced GitHub content themselves, and flag close-tag escape attempts via AskUserQuestion.
4. **Regression corpus.** `packages/core/src/core/prompt-injection-corpus.test.ts` runs a CI-resident corpus of known injection shapes (classic, fake-system-tag, markdown, delimiter-collision, unicode, long) against the fencing helper and pins the structural contract: exactly one open and one close tag, lossless round-trip, payload contained. An end-to-end layer additionally runs the corpus through the real producers (`runComments`, `fetchPRCommentBundle`, `toDailyOutput`) and fails CI if any emitted body field is not fenced — unwiring the fence is a test failure, not a silent regression.

Explicit non-goals: no automated detection of injection content (false-positive prone, weakens the human-review signal); no server-side filtering (we don't control GitHub); no LLM-side trust assumptions (model behavior under adversarial input is not part of the contract).

### Dependency Security

The attack surface is intentionally minimal.

- **3 production dependencies:** `@octokit/rest`, `@octokit/plugin-throttling`, `commander`. All other packages are devDependencies only.
- **pnpm audit in CI:** The CI workflow runs `pnpm audit --audit-level=high` on every push and PR.
- **Dependabot:** Weekly automated dependency scanning for the npm ecosystem.
- **CodeQL:** GitHub's CodeQL security analysis runs on pushes to main and on pull requests.

## Stability Policy

All public APIs follow [semantic versioning](https://semver.org/) from 1.0 forward:

- **CLI commands** — All 26 commands, their flags, and `--json` output structure
- **Library exports** — The programmatic API from `@oss-autopilot/core`
- **Plugin interface** — Commands, agents, and skills
- **MCP server** — Tools, resources, and prompts (separately versioned as `@oss-autopilot/mcp`)

Breaking changes will only occur in major version bumps with migration guidance.

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 1.x     | Yes                |
| 0.60.x  | Security fixes only |
| < 0.60  | No                 |
