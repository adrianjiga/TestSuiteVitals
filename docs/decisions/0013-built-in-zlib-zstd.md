# 0013 — Use the built-in `node:zlib` zstd, not a native module

**Status**: Accepted

## Context

`compact` (0002) originally compressed with `@mongodb-js/zstd`, a native module
with prebuilt binaries. Native modules fetch or build those binaries in an
install script, and install scripts are increasingly blocked: pnpm 10 skips
dependency lifecycle scripts unless allow-listed, and many users and CI setups
run with `ignore-scripts`. Without its binary, the module fails at runtime, the
first time a user compacts or reads a `.zst` month. Node now ships zstd in
`node:zlib`.

## Decision

Replace `@mongodb-js/zstd` with `node:zlib`'s `zstdCompress`/`zstdDecompress`,
behind the existing chokepoint `src/store/compress.ts` (promisified, level 19
via `ZSTD_c_compressionLevel`). The package has no native dependency.

## Consequences

- Installs never need an install script or a compiler, under any package
  manager or `ignore-scripts` setting.
- Both write standard zstd frames, so `.ndjson.zst` files written by the old
  module still read, and new ones read with any zstd tool.
- It ties the runtime floor to a Node with built-in zstd, which the Node 24
  minimum (0014) already covers.
- One less dependency to audit and keep updated.
