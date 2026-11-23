#!/usr/bin/env bash
# Re-makes rust/vendor/wgpu-hal: wgpu-hal exactly as published on crates.io at <version>, plus
# rust/vendor/wgpu-hal.patch, the Metal fix of gfx-rs/wgpu#10875 and #10570 (any failed command buffer loses the
# device; a submission finishes with all its command buffers and every earlier one). Fails if the patch no longer
# applies, or (on macOS) its fence tests fail. Temporary: once a wgpu release has #10875, delete rust/vendor/, this script and the
# `[patch.crates-io]` entry and `exclude` in rust/Cargo.toml.
# Usage: rust/scripts/vendor-wgpu-hal.sh <version>   (the version rust/Cargo.lock has, e.g. 30.0.2)
set -euo pipefail
cd "$(dirname "$0")/.."
version="${1:?usage: rust/scripts/vendor-wgpu-hal.sh <version>}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://static.crates.io/crates/wgpu-hal/wgpu-hal-$version.crate" -o "$tmp/crate.tar.gz"
tar -xzf "$tmp/crate.tar.gz" -C "$tmp"
# `git apply` outside a repository applies exactly or not at all.
(cd "$tmp/wgpu-hal-$version" && git apply --whitespace=nowarn "$OLDPWD/vendor/wgpu-hal.patch")
rm -rf vendor/wgpu-hal
mv "$tmp/wgpu-hal-$version" vendor/wgpu-hal
echo "rust/vendor/wgpu-hal: wgpu-hal $version + rust/vendor/wgpu-hal.patch"
# The patch's fence tests, where the Metal backend builds (logic only: no GPU work). build-ios.sh runs them too.
if [ "$(uname)" = Darwin ]; then
  cargo test --manifest-path vendor/wgpu-hal/Cargo.toml --features metal --lib --target-dir target -- metal::fence_tests
fi
