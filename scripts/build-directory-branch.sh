#!/usr/bin/env bash
# Assemble the plugin-only tree published to the `directory` branch, which is
# what the Claude plugin directory submission tracks.
#
# The repo root is a pnpm monorepo, and the directory's validator blocks any
# plugin that ships pnpm-workspace.yaml. This tree carries only what the
# plugin reads at runtime: its markdown components, the two build-if-stale
# helpers, and the prebuilt CLI bundle plus dashboard assets taken from the
# published @oss-autopilot/core tarball (the bundle is self-contained, and
# build-cli-if-stale.sh treats a bundle with no package.json beside it as
# current).
#
# Usage: build-directory-branch.sh <core-version> <out-dir>
#   Run from the repo root. <out-dir> must not exist yet.

set -euo pipefail

VERSION="${1:?usage: build-directory-branch.sh <core-version> <out-dir>}"
OUT="${2:?usage: build-directory-branch.sh <core-version> <out-dir>}"

if [ -e "$OUT" ]; then
  echo "build-directory-branch.sh: $OUT already exists" >&2
  exit 1
fi

mkdir -p "$OUT/.claude-plugin" "$OUT/scripts" "$OUT/docs/diagrams" "$OUT/packages/core/dist"

cp .claude-plugin/plugin.json "$OUT/.claude-plugin/"
cp .mcp.json README.md LICENSE "$OUT/"
cp -R agents commands skills workflows assets "$OUT/"
# Docs the agents and README point at (rubrics, policy categories, diagrams).
cp -R docs/images "$OUT/docs/"
cp docs/repo-scores.md docs/anti-llm-policy.md "$OUT/docs/"
cp docs/diagrams/*.svg "$OUT/docs/diagrams/"
cp scripts/build-cli-if-stale.sh scripts/build-dashboard-if-stale.sh "$OUT/scripts/"
# Contributor notes, not an agent: the validator flags it for missing frontmatter.
rm -f "$OUT/agents/README.md"

# Prebuilt CLI and dashboard from the published tarball. npm can lag a fresh
# publish, so retry before giving up.
PKG_DIR=$(mktemp -d)
for attempt in 1 2 3 4 5; do
  if (cd "$PKG_DIR" && npm pack --silent "@oss-autopilot/core@${VERSION}" >/dev/null); then
    break
  fi
  if [ "$attempt" = 5 ]; then
    echo "build-directory-branch.sh: npm pack @oss-autopilot/core@${VERSION} failed" >&2
    exit 1
  fi
  sleep 30
done
tar -xzf "$PKG_DIR"/*.tgz -C "$PKG_DIR"
cp "$PKG_DIR/package/dist/cli.bundle.cjs" "$OUT/packages/core/dist/"
cp -R "$PKG_DIR/package/dist/dashboard" "$OUT/packages/core/dist/"
rm -rf "$PKG_DIR"

# Fail loudly if the tarball layout ever changes under us.
node "$OUT/packages/core/dist/cli.bundle.cjs" --version | grep -qx "$VERSION"
test -f "$OUT/packages/core/dist/dashboard/index.html"

echo "Assembled $(find "$OUT" -type f | wc -l | tr -d ' ') files in $OUT"
