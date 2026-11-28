#!/usr/bin/env bash
# Assemble the plugin-only tree published to the `directory` branch, which is
# what the Claude plugin directory submission tracks.
#
# The repo root is a pnpm monorepo, and the directory's validator blocks any
# plugin that ships pnpm-workspace.yaml. This tree carries only what the
# plugin reads at runtime: its markdown components, the two build-if-stale
# helpers, and the prebuilt CLI bundle plus dashboard assets taken from the
# published @oss-autopilot/core tarball (the bundle is self-contained, and
# both helpers treat a packages/core with no package.json as prebuilt and
# current).
#
# The tree also ships the MCP server bundle, taken from an @oss-autopilot/mcp
# tarball packed from the same checkout, and its own .mcp.json launches that
# file instead of `npx @oss-autopilot/mcp@<pin>` (#2037). The pin in the
# repo's .mcp.json is whatever MCP release came last: on a core-only release
# that release still inlines the previous core, so the slash commands and the
# MCP tools ran two cores against one state file. Built from one checkout, the
# two bundles always carry the same core. The repo-root .mcp.json (and its
# pin) stays as it is for source checkouts, which have no built MCP bundle.
#
# This script only writes <out-dir>. It never touches git: the release
# workflow commits and pushes the tree in a separate step.
#
# Usage: build-directory-branch.sh <core-version> <out-dir> <mcp-tarball> [<core-tarball>]
#   Run from the repo root. <out-dir> must not exist yet.
#   <mcp-tarball> is a local .tgz from `pnpm pack` of packages/mcp-server,
#   built against core <core-version>; scripts/check-plugin-tree.mjs checks it.
#   With <core-tarball> (a local .tgz from `pnpm pack`), the CLI comes from
#   that file and nothing is fetched; PR CI uses this. Without it, the
#   published @oss-autopilot/core@<core-version> is fetched from npm.

set -euo pipefail

USAGE="usage: build-directory-branch.sh <core-version> <out-dir> <mcp-tarball> [<core-tarball>]"
VERSION="${1:?$USAGE}"
OUT="${2:?$USAGE}"
MCP_TARBALL="${3:?$USAGE}"
TARBALL="${4:-}"

for file in "$MCP_TARBALL" ${TARBALL:+"$TARBALL"}; do
  if [ ! -f "$file" ]; then
    echo "build-directory-branch.sh: no such tarball: $file" >&2
    exit 1
  fi
done

if [ -e "$OUT" ]; then
  echo "build-directory-branch.sh: $OUT already exists" >&2
  exit 1
fi

mkdir -p "$OUT/.claude-plugin" "$OUT/scripts" "$OUT/docs/diagrams" "$OUT/packages/core/dist" \
  "$OUT/packages/mcp-server/dist"

cp .claude-plugin/plugin.json "$OUT/.claude-plugin/"
cp README.md LICENSE "$OUT/"
cp -R agents commands skills workflows assets "$OUT/"
# Docs the agents and README point at (rubrics, policy categories, diagrams).
cp -R docs/images "$OUT/docs/"
cp docs/repo-scores.md docs/anti-llm-policy.md "$OUT/docs/"
cp docs/diagrams/*.svg "$OUT/docs/diagrams/"
cp scripts/build-cli-if-stale.sh scripts/build-dashboard-if-stale.sh "$OUT/scripts/"

# Prebuilt CLI and dashboard from the core tarball.
PKG_DIR=$(mktemp -d)
if [ -n "$TARBALL" ]; then
  tar -xzf "$TARBALL" -C "$PKG_DIR"
else
  # The published tarball. npm can take minutes to serve a fresh publish, so
  # retry for up to 10 minutes.
  for attempt in $(seq 1 20); do
    if (cd "$PKG_DIR" && npm pack --silent "@oss-autopilot/core@${VERSION}" >/dev/null); then
      break
    fi
    if [ "$attempt" = 20 ]; then
      echo "build-directory-branch.sh: npm pack @oss-autopilot/core@${VERSION} failed" >&2
      exit 1
    fi
    sleep 30
  done
  tar -xzf "$PKG_DIR"/*.tgz -C "$PKG_DIR"
fi
cp "$PKG_DIR/package/dist/cli.bundle.cjs" "$OUT/packages/core/dist/"
cp -R "$PKG_DIR/package/dist/dashboard" "$OUT/packages/core/dist/"
rm -rf "$PKG_DIR"

# The MCP server from its tarball. The bundle reads ../package.json for the
# version it reports, so that comes too.
PKG_DIR=$(mktemp -d)
tar -xzf "$MCP_TARBALL" -C "$PKG_DIR"
cp "$PKG_DIR/package/dist/mcp-server.bundle.cjs" "$OUT/packages/mcp-server/dist/"
cp "$PKG_DIR/package/package.json" "$OUT/packages/mcp-server/"
rm -rf "$PKG_DIR"
cat >"$OUT/.mcp.json" <<'EOF'
{
  "mcpServers": {
    "oss-autopilot": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/packages/mcp-server/dist/mcp-server.bundle.cjs"]
    }
  }
}
EOF

# Fail loudly if the tarball layout ever changes under us.
node "$OUT/packages/core/dist/cli.bundle.cjs" --version | grep -qx "$VERSION"
test -f "$OUT/packages/core/dist/dashboard/index.html"

echo "Assembled $(find "$OUT" -type f | wc -l | tr -d ' ') files in $OUT"
