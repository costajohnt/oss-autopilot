#!/usr/bin/env bash
# Install packed npm tarballs into a clean prefix outside the workspace and
# run each package's bin, the way `npx` does on a user's machine (#1943).
#
#   scripts/verify-packed-tarballs.sh <tarball.tgz>...
#
# Catches what a workspace build cannot: a `files` or `bin` mistake, a
# `workspace:` dependency that `pnpm pack` did not rewrite to something npm
# can resolve, or a bundle that only starts next to the workspace's
# node_modules. Tarballs given together are installed together.
#
# `--ignore-scripts`: release-please.yml runs this in the publish jobs, which
# can mint an npm publish credential. The dependencies come from the registry
# by semver range, not from the lockfile, so none of their install scripts may
# run there. The bins are self-contained esbuild bundles and load nothing from
# node_modules, so no registry code executes at all.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <tarball.tgz>..." >&2
  exit 2
fi

TARBALLS=()
for tarball in "$@"; do
  if [ ! -f "$tarball" ]; then
    echo "::error::No such tarball: $tarball" >&2
    exit 2
  fi
  TARBALLS+=("$(cd "$(dirname "$tarball")" && pwd)/$(basename "$tarball")")
done

PREFIX=$(mktemp -d)
trap 'rm -rf "$PREFIX"' EXIT
cd "$PREFIX"
# Own package.json so npm cannot pick a parent directory as the install root.
echo '{"private":true}' > package.json

# Retry: core's runtime dependencies come from the registry, which can flake.
for attempt in 1 2 3 4 5 6; do
  if npm install --ignore-scripts --no-audit --no-fund "${TARBALLS[@]}"; then
    break
  fi
  if [ "$attempt" -eq 6 ]; then
    echo "::error::npm install of ${TARBALLS[*]} failed 6 times" >&2
    exit 1
  fi
  echo "npm install attempt $attempt failed; retrying in 30s" >&2
  sleep 30
done

# No token and an empty home: startup must not depend on the caller's setup.
run_bin() {
  env -u GITHUB_TOKEN -u GH_TOKEN HOME="$PREFIX/home" "$PREFIX/node_modules/.bin/$1" "${@:2}"
}

INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify-packed-tarballs","version":"0"}}}'

# npm records each tarball given on the command line as a root dependency.
for name in $(node -p 'Object.keys(require("./package.json").dependencies).join(" ")'); do
  case "$name" in
    @oss-autopilot/core) bin=oss-autopilot ;;
    @oss-autopilot/mcp) bin=oss-autopilot-mcp ;;
    *)
      echo "::error::No bin check defined for $name" >&2
      exit 1
      ;;
  esac
  expected=$(node -p 'require(process.argv[1]).version' "$PREFIX/node_modules/$name/package.json")
  actual=$(run_bin "$bin" --version)
  if [ "$actual" != "$expected" ]; then
    echo "::error::$bin --version printed '$actual', the $name tarball is $expected" >&2
    exit 1
  fi
  run_bin "$bin" --help > /dev/null
  if [ "$name" = "@oss-autopilot/mcp" ]; then
    # What .mcp.json does for every plugin user: start the stdio transport and
    # answer `initialize`. Stdin closes after the request, so the server exits.
    # No `grep -q`: it would exit at the first match and SIGPIPE the server.
    printf '%s\n' "$INIT" | run_bin "$bin" | grep '"serverInfo"' > /dev/null
  fi
  echo "Tarball verified: $name@$expected ($bin --version, --help$([ "$name" = "@oss-autopilot/mcp" ] && echo ', stdio initialize'))"
done
