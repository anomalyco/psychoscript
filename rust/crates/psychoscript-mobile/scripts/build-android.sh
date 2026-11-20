#!/usr/bin/env bash
# Builds the PsychoScript Android libraries and Kotlin bindings:
#
#   rust/crates/psychoscript-mobile/scripts/build-android.sh [out-dir]   (default: rust/target/mobile/android)
#
# Needs ANDROID_NDK_HOME (NDK r28 or later: 16 KB page-aligned), `cargo install cargo-ndk`, and
# `rustup target add aarch64-linux-android x86_64-linux-android` for the toolchain in
# rust/rust-toolchain.toml. FEATURES=--no-default-features leaves out `translateWgsl`. Writes
#   <out>/jniLibs/{arm64-v8a,x86_64}/libpsychoscript_mobile.so      stripped, for src/main/jniLibs
#   <out>/kotlin/com/anomalyco/psychoscript/psychoscript_mobile.kt   JNA bindings
#   <out>/REVISION                                                    the commit it was built from
set -euo pipefail

crate="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$crate/../.." && pwd)"
out="${1:-$root/target/mobile/android}"
profile="${PROFILE:-release}"
api="${ANDROID_API:-21}"
features="${FEATURES:-}"
: "${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME to an Android NDK}"

strip="$(ls "$ANDROID_NDK_HOME"/toolchains/llvm/prebuilt/*/bin/llvm-strip | head -n 1)"
cd "$root"
rm -rf "$out"
mkdir -p "$out/kotlin"

for abi in arm64-v8a:aarch64-linux-android x86_64:x86_64-linux-android; do
  name="${abi%%:*}"
  triple="${abi#*:}"
  # shellcheck disable=SC2086
  cargo ndk -t "$name" -P "$api" rustc -p psychoscript-mobile --lib --profile "$profile" --crate-type cdylib $features
  mkdir -p "$out/jniLibs/$name"
  cp "target/$triple/$profile/libpsychoscript_mobile.so" "$out/jniLibs/$name/"
done

# Bindings from the unstripped library (its UniFFI metadata), then strip.
cargo run -q -p psychoscript-mobile --features cli --bin uniffi-bindgen -- generate \
  --library "target/aarch64-linux-android/$profile/libpsychoscript_mobile.so" \
  --language kotlin --out-dir "$out/kotlin" --no-format
for so in "$out"/jniLibs/*/libpsychoscript_mobile.so; do
  "$strip" --strip-unneeded "$so"
done
cp "$crate/README.md" "$out/"
echo "anomalyco/psychoscript $(git -C "$root" rev-parse HEAD)$(git -C "$root" diff --quiet HEAD || echo " (modified)")" > "$out/REVISION"
ls -l "$out"/jniLibs/*/
