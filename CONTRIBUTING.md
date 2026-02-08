# Contributing to OSS Autopilot

Thanks for your interest in contributing! This project helps developers manage their open source contributions, and we welcome contributions of all kinds.

## Getting Started

### Prerequisites

- Node.js 18+
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

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run specific test file
npx vitest src/core/state.test.ts
```

## Release Process

When preparing a new release:

1. **Decide version number** following [semver](https://semver.org/): new feature = minor bump, bug fix = patch bump
2. **Update version** in both `.claude-plugin/plugin.json` and `package.json` (they must always match)
3. **Update CHANGELOG.md** with the new version section (Added, Changed, Fixed as appropriate)
4. **Update version badge** in `README.md` to reflect the new version
5. **Commit**: `git commit -m "chore: release vX.Y.Z"`
6. **Tag**: `git tag vX.Y.Z`
7. **Push with tags**: `git push origin main --tags`
8. **Optional**: Create a GitHub release with `gh release create vX.Y.Z --notes "See CHANGELOG.md"`

## Questions?

Open an issue or start a discussion. We're happy to help!
