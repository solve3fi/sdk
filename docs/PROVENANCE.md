# Provenance and licensing record

This is an engineering record, not legal advice. Counsel should confirm the conclusions.

## Why this repository exists

The Solve3 app used `@solve33/sdk` and `@phongjimmy/svm-utilities`, third-party npm packages that carry no license and
are renamed copies of Orca's TypeScript SDK and common library. They include Orca code first committed after Orca
changed its license (adaptive fees, dynamic tick arrays, locked positions, reset-position-range and others). Orca
published its Whirlpools repository under Apache 2.0 until 26 February 2025; from 27 February 2025 it is under the
"Orca License" (non-commercial; use that benefits a competitor, explicitly DEXs and AMMs, needs Orca's consent).

This repository replaces those packages with code taken only from the last Apache-2.0 commit, the same base as the
Solve3 program in https://github.com/solve3fi/contracts (see its `docs/PROVENANCE.md`).

## Base

| | |
|---|---|
| Orca repository | https://github.com/orca-so/whirlpools |
| Commit | `e528dd23bb41571f92cfdb49a2f15d4fa0b01bec` (2025-02-26, last whole-repository commit under Apache 2.0) |
| `packages/sdk` from | `legacy-sdk/whirlpool` (`@orca-so/whirlpools-sdk` 0.13.16, `license: Apache-2.0`) |
| `packages/common` from | `legacy-sdk/common` (`@orca-so/common-sdk` 0.6.10; package.json says MIT, the repository license is Apache-2.0, both permissive) |

## What was changed

1. Copied the `src` trees verbatim from that commit.
2. Renamed identifiers and files: Whirlpool -> Solve, WhirlpoolsConfig -> SolvesConfig, whirlpool -> solve, and the
   import of `@orca-so/common-sdk` -> `@solve3fi/common`.
3. Removed Orca-deployment specifics: the `ORCA_*` program/config address constants and the `prices` module that used them.
4. Replaced the IDL artifact with one generated from the Solve3 program (`scripts/convert-idl.mjs`, from `idl/solve.json`,
   converting the current Anchor IDL into the legacy format this SDK's Anchor 0.29 `Program` expects).
5. Solve3's own additions: the program's `solves_config` account is passed by `swap`, `two_hop_swap`,
   `increase_liquidity`, `decrease_liquidity` and their v2 forms. `solvesConfig` is a parameter of those instruction
   builders; the pool and position helpers read it from pool data; `SwapUtils.getSwapParamsFromQuoteKeys` gained a
   `solvesConfig` argument; the route builder reads it from the pool through the fetcher.

## What is not included

Everything Orca added after the cutoff: dynamic tick arrays, adaptive fees, position locking and transfer,
reset-position-range, the events/`Traded` decoding helpers and later quote changes. The Solve3 program does not have them.

## How the result was checked

- Contamination audit: every line of 28 or more characters in `packages/*/src` (5,864 distinct lines, renamed back to
  Orca's spelling) was compared against the 920 distinct lines that Orca added to `legacy-sdk/whirlpool/src` and
  `legacy-sdk/common/src` after the cutoff and that do not exist in the Apache snapshot (22 commits up to
  `f4b99e79e7140f3917e4ce81a2e8ad06ccdf8ce4`). Result: 0 matches.
- 189 distinct long lines differ from the Apache snapshot after renaming; they are the changes listed above.
- `scripts/devnet-smoke.mjs` runs swaps in both directions and a position open, increase and decrease against the
  deployed Solve3 program on Devnet.

## Known limits

- The audit compares source text only (threshold 28 characters). It cannot show that no idea was influenced by later Orca code.
- Orca's integration tests were not ported; they need a local validator and Orca's program build.
