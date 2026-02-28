# Contributing to OSS Autopilot

Thanks for your interest in contributing! This project helps developers manage their open source contributions, and we welcome contributions of all kinds.

## Getting Started

### Prerequisites

- Node.js 20+
- GitHub CLI (`gh`) authenticated: `gh auth login`

### Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/oss-autopilot.git
cd oss-autopilot

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test
```

### Project Structure

```
oss-autopilot/
├── src/                    # TypeScript CLI source
│   ├── core/               # Core logic (state, PR monitoring, types)
│   ├── commands/           # CLI commands (daily, search, track, etc.)
│   └── formatters/         # Output formatters (JSON)
├── commands/               # Plugin slash commands (.md files)
├── agents/                 # Plugin agent definitions (.md files)
├── .claude-plugin/         # Plugin manifest
└── dist/                   # Built CLI (generated)
```

## Making Changes

### 1. Find an Issue

- Check [issues labeled "good first issue"](https://github.com/costajohnt/oss-autopilot/labels/good%20first%20issue)
- Or [issues labeled "help wanted"](https://github.com/costajohnt/oss-autopilot/labels/help%20wanted)

### 2. Create a Branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/your-bug-fix
```

### 3. Make Your Changes

- Write code
- Add tests if applicable
- Run `npm test` to ensure tests pass
- Run `npm run build` to ensure it compiles
- **Do NOT manually bump versions or edit CHANGELOG.md** — versioning is automated via [release-please](https://github.com/googleapis/release-please)

### 4. Commit

Use conventional commit format:

```bash
git commit -m "feat: add new feature"
git commit -m "fix: resolve bug in X"
git commit -m "docs: update README"
git commit -m "test: add tests for Y"
git commit -m "refactor: simplify Z"
```

### 5. Push and Create PR

```bash
git push origin feature/your-feature-name
```

Then open a Pull Request on GitHub.

## Code Style

- TypeScript with strict mode
- Use existing patterns in the codebase
- Keep functions small and focused
- Add types for function parameters and return values

## Running Tests

Tests use **co-location** — test files live alongside their source files as `*.test.ts` (e.g. `src/core/state.ts` → `src/core/state.test.ts`). There is no separate `tests/` directory.

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run specific test file
npx vitest src/core/state.test.ts
```

## Release Process

Releases are automated via [release-please](https://github.com/googleapis/release-please). Contributors do NOT need to bump versions, edit CHANGELOG.md, or create tags.

1. Use [conventional commits](https://www.conventionalcommits.org/): `feat:` (minor bump), `fix:` (patch bump), `chore:` (no release)
2. On merge to main, release-please opens or updates a release PR that bumps versions and generates the changelog
3. A maintainer merges the release-please PR to create a GitHub release

## Maintainer Guide

This section documents infrastructure settings that are not codified in the repo and would be lost if the repo were forked or transferred.

### Branch Protection Rules

The `main` branch should have these protection rules enabled (Settings → Branches → Branch protection rules):

- **Require a pull request before merging** — at least 1 approval
- **Require status checks to pass before merging** — the `test` CI job must pass
- **Require branches to be up to date before merging**
- **Do not allow bypassing the above settings** (optional, recommended for teams)

### RELEASE_TOKEN (Personal Access Token)

The release-please workflow (`.github/workflows/release-please.yml`) uses `secrets.RELEASE_TOKEN` instead of the default `GITHUB_TOKEN`. This is required because GitHub's security model prevents `GITHUB_TOKEN` events from triggering other workflows (to prevent infinite loops). A PAT's events do trigger downstream workflows like CI on the release branch.

**Required scopes:**
- `contents: write` — push commits and create releases
- `pull-requests: write` — create and update the release-please PR

**Creating the token:**
1. Go to GitHub → Settings → Developer Settings → Personal Access Tokens → Fine-grained tokens
2. Set repository access to "Only select repositories" → select `oss-autopilot`
3. Under "Repository permissions", grant: Contents (Read and write), Pull requests (Read and write)
4. Generate the token and add it as a repository secret: Settings → Secrets → Actions → `RELEASE_TOKEN`

**Rotation:** Recommended every 6-12 months. Fine-grained tokens have configurable expiration dates.

### Required Repository Settings

- **GitHub Discussions**: Enabled (Settings → General → Features → Discussions)
- **GitHub Actions**: Allow all actions and reusable workflows
- **Merge button**: "Allow squash merging" enabled (default merge strategy)

### Manual Release (if automation fails)

If release-please or the release workflow fails:

```bash
# 1. Bump version manually
npm version patch  # or minor/major

# 2. Update CHANGELOG.md with the new version section

# 3. Commit and push
git add -A && git commit -m "chore: release X.Y.Z"
git push origin main

# 4. Create a GitHub release
gh release create vX.Y.Z --generate-notes

# 5. GitHub release is created
```

## Questions?

Open an issue or start a discussion. We're happy to help!
