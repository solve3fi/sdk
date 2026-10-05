# Solve3 SDK

TypeScript SDK for the Solve3 DEX program ([solve3fi/contracts](https://github.com/solve3fi/contracts)), a fork of
Orca Whirlpools at its last Apache-2.0 version. Licensed under Apache-2.0; see `NOTICE` and `docs/PROVENANCE.md`.

| Package | What |
|---|---|
| `@solve3fi/sdk` | clients, instructions, quotes, router, PDAs |
| `@solve3fi/common` | math (`Percentage`, `DecimalUtil`) and web3 helpers (`TransactionBuilder`, `AddressUtil`) |

```sh
bun install
bun run build                 # builds common, then sdk
node scripts/convert-idl.mjs  # regenerate packages/sdk/src/artifacts from idl/solve.json
SOLVE3_KEYPAIR=... SOLVE3_DEX=... SOLVE3_CONFIG=... node scripts/devnet-smoke.mjs
```

Every pool belongs to a `SolvesConfig`; swaps and liquidity changes pass it to the program, so the instruction
builders take a `solvesConfig` parameter (the high-level `Solve`/`Position` helpers read it from the pool).
