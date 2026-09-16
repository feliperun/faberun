#!/bin/sh
# Install faberun into the layout src/host/home.mjs and src/cli/update.mjs own:
#
#   $FABERUN_HOME/versions/<version>/        the extracted release
#   $FABERUN_HOME/current -> versions/<v>    the live version
#   $FABERUN_BIN_DIR/faberun -> $FABERUN_HOME/current/bin/faberun.mjs
#
# POSIX sh, no jq, idempotent: a re-run refreshes the requested version and
# repoints the links, exactly as `faberun update` would. The default is the
# newest GitHub release; `main` is the fallback while no release exists yet.
# FABERUN_INSTALL_SOURCE bypasses the network with a local tarball or directory.
set -eu

REPO="feliperun/faberun"
RELEASES_URL="https://api.github.com/repos/$REPO/releases/latest"
ARCHIVE_BASE="https://github.com/$REPO/archive/refs"

home="${FABERUN_HOME:-$HOME/.faberun}"
bin_dir="${FABERUN_BIN_DIR:-$HOME/.local/bin}"
install_source="${FABERUN_INSTALL_SOURCE:-}"
requested="${FABERUN_VERSION:-}"
no_setup="${FABERUN_NO_SETUP:-}"

# ---------------------------------------------------------------------------
# 1. Requirements
# ---------------------------------------------------------------------------

node_version=""
if command -v node >/dev/null 2>&1; then
  node_version=$(node -p 'process.versions.node' 2>/dev/null || true)
fi
if [ -z "$node_version" ]; then
  printf '[fail] node · node 22 or newer is required; install it from https://nodejs.org/\n' >&2
  exit 1
fi
node_major=${node_version%%.*}
case "$node_major" in
  ''|*[!0-9]*)
    printf '[fail] node · could not read the node version from %s; install node 22 or newer from https://nodejs.org/\n' "$(command -v node)" >&2
    exit 1
    ;;
esac
if [ "$node_major" -lt 22 ]; then
  printf '[fail] node · node 22 or newer is required, found %s; install it from https://nodejs.org/\n' "$node_version" >&2
  exit 1
fi
printf '[ok] node · %s\n' "$node_version"

if ! command -v tar >/dev/null 2>&1; then
  printf '[fail] tar · tar is required to unpack the release; install tar and retry\n' >&2
  exit 1
fi
printf '[ok] tar · %s\n' "$(command -v tar)"

# curl is needed to download the release (and to ask for the latest tag);
# an offline install provides both FABERUN_INSTALL_SOURCE and FABERUN_VERSION.
needs_curl=0
if [ -z "$install_source" ] || [ -z "$requested" ]; then
  needs_curl=1
fi
if [ "$needs_curl" -eq 1 ]; then
  if ! command -v curl >/dev/null 2>&1; then
    printf '[fail] curl · curl is required to download the release; install curl and retry\n' >&2
    exit 1
  fi
  printf '[ok] curl · %s\n' "$(command -v curl)"
fi

# ---------------------------------------------------------------------------
# 2. Resolve the version
# ---------------------------------------------------------------------------

version="$requested"
if [ -z "$version" ]; then
  release_json=$(curl -fsSL "$RELEASES_URL" 2>/dev/null || true)
  tag=$(printf '%s' "$release_json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  if [ -n "$tag" ]; then
    version="$tag"
  else
    printf '[warn] release · no release yet · installing main\n'
    version="main"
  fi
fi

# The directory is the bare version, matching src/cli/update.mjs; a release
# tag carries the leading `v`, a plain number does not.
case "$version" in
  v*) version_key=${version#v} ;;
  *) version_key="$version" ;;
esac

# ---------------------------------------------------------------------------
# 3. Fetch and extract
# ---------------------------------------------------------------------------

versions_dir="$home/versions"
target="$versions_dir/$version_key"
partial="$versions_dir/$version_key.partial"
tarball="$home/tmp/install.tar.gz"

mkdir -p "$versions_dir" "$bin_dir"
rm -rf "$partial"
mkdir -p "$partial"

if [ -n "$install_source" ]; then
  if [ -d "$install_source" ]; then
    if ! cp -R "$install_source"/. "$partial"/; then
      printf '[fail] source · cannot copy %s\n' "$install_source" >&2
      rm -rf "$partial"
      exit 1
    fi
  elif [ -f "$install_source" ]; then
    if ! tar -xzf "$install_source" --strip-components=1 -C "$partial"; then
      printf '[fail] source · cannot extract %s\n' "$install_source" >&2
      rm -rf "$partial"
      exit 1
    fi
  else
    printf '[fail] source · %s does not exist\n' "$install_source" >&2
    rm -rf "$partial"
    exit 1
  fi
else
  case "$version" in
    main) archive_url="$ARCHIVE_BASE/heads/main.tar.gz" ;;
    v*) archive_url="$ARCHIVE_BASE/tags/$version.tar.gz" ;;
    *) archive_url="$ARCHIVE_BASE/tags/v$version.tar.gz" ;;
  esac
  mkdir -p "$home/tmp"
  if ! curl -fsSL "$archive_url" -o "$tarball"; then
    printf '[fail] download · %s\n' "$archive_url" >&2
    rm -rf "$partial"
    exit 1
  fi
  if ! tar -xzf "$tarball" --strip-components=1 -C "$partial"; then
    printf '[fail] extract · %s\n' "$tarball" >&2
    rm -rf "$partial"
    exit 1
  fi
  rm -f "$tarball"
fi

# ---------------------------------------------------------------------------
# 4. Install the version, repoint current, link the binary
# ---------------------------------------------------------------------------

chmod +x "$partial/bin/faberun.mjs"
rm -rf "$target"
mv "$partial" "$target"

# `ln -sfn` replaces an existing symlink instead of following it: without the
# -n/-h flag, `ln -s` into an already-linked `current` would create the link
# inside the directory current points at and leave current on the old version.
ln -sfn "versions/$version_key" "$home/current"
ln -sfn "$home/current/bin/faberun.mjs" "$bin_dir/faberun"

# ---------------------------------------------------------------------------
# 5. Verify the installed binary runs and reports its own version
# ---------------------------------------------------------------------------

if ! version_output=$("$bin_dir/faberun" --version 2>/dev/null); then
  printf '[fail] verify · %s --version failed\n' "$bin_dir/faberun" >&2
  exit 1
fi
case "$version_output" in
  "faberun "*) printed=${version_output#faberun } ;;
  *) printed="$version_output" ;;
esac
printf '[ok] installed · faberun %s · %s\n' "$printed" "$bin_dir/faberun"

# ---------------------------------------------------------------------------
# 6. PATH advice
# ---------------------------------------------------------------------------

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    printf '[warn] path · add %s to PATH\n' "$bin_dir"
    printf '  export PATH="%s:$PATH"\n' "$bin_dir"
    ;;
esac

# ---------------------------------------------------------------------------
# 7. Hand off to setup
# ---------------------------------------------------------------------------

if [ -z "$no_setup" ]; then
  if [ -t 0 ] && [ -t 1 ]; then
    exec "$bin_dir/faberun" setup
  else
    printf 'next · faberun setup\n'
  fi
fi
