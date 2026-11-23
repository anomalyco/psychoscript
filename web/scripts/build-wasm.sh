#!/usr/bin/env bash
# Builds the WebAssembly module into web/wasm/: psychoscript_web (the language: Program, LiveRun). Needs the
# wasm32-unknown-unknown target, wasm-bindgen-cli at the version in rust/Cargo.lock, and wasm-opt (binaryen).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
rust="$here/../rust"
out="$here/wasm"
target="${CARGO_TARGET_DIR:-$rust/target}"
mkdir -p "$out"
# Source paths in panic messages, made the same on every machine: the build is reproducible, and no build machine's
# directories end up in the module.
registry="${CARGO_HOME:-$HOME/.cargo}/registry/src"
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$registry=/cargo/registry/src --remap-path-prefix=$(cd "$here/.." && pwd)=/psychoscript"

build() { # features out-name
  (cd "$rust" && cargo build --locked --release -p psychoscript-web --target wasm32-unknown-unknown $1)
  wasm-bindgen --target web --out-dir "$out" --out-name "$2" \
    "$target/wasm32-unknown-unknown/release/psychoscript_web.wasm"
  if command -v wasm-opt >/dev/null; then
    wasm-opt "$out/$2_bg.wasm" -O3 --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
      --enable-mutable-globals --strip-debug --strip-producers -o "$out/$2_bg.wasm"
  else
    echo "wasm-opt not found: $2_bg.wasm is unoptimized" >&2
  fi
}

build "" psychoscript_web
ls -l "$out"
