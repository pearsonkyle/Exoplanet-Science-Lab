#!/bin/sh
# Builds public/wasm/mix.wasm from tools/wasm/mix.rs. Needs rustc with the wasm32-unknown-unknown target
# (rustup target add wasm32-unknown-unknown). The binary is committed, so the app and the tests need no Rust.
set -e
cd "$(dirname "$0")/../.."
mkdir -p public/wasm
rustc --target wasm32-unknown-unknown -C opt-level=3 -C panic=abort -C strip=symbols --crate-type cdylib -o public/wasm/mix.wasm tools/wasm/mix.rs
ls -l public/wasm/mix.wasm
