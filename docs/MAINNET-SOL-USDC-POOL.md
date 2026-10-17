# Mainnet SOL/USDC pool

The first Solve3 mainnet pool: SOL/USDC, 0.05% swap fee (tick spacing 8), created by
[`scripts/mainnet-sol-usdc-pool.mjs`](../scripts/mainnet-sol-usdc-pool.mjs). Nothing here is on mainnet yet.

## Before the pool: the program

The Solve program is not on mainnet. The old mainnet program was closed, and the program that runs on devnet
(`HnosXNWPvKSFkY6xjUpCJ9nhbvTRhdfNTfWpgp3m4GK`, built from `solve3fi/contracts`) declares that address in
`declare_id!`. Deploying it to mainnet at the same address needs that program keypair; a different address needs
`declare_id!` changed and the SDK, frontend and bots pointed at it. Deploy from the release commit of
`solve3fi/contracts` with the upgrade authority Seth chooses, and record the deployed hash per the
[mainnet release gate](https://github.com/solve3fi/Knowledge/blob/main/wiki/operations/mainnet-release-gate.md).

## What the script creates

One atomic transaction (about 1,104 bytes, so a failure leaves nothing behind). It is signed by the deployer key
`4j3V…ySVPs`, a keypair file; the Dev account lives in a browser wallet, so the same transaction hands the fee and
reward-emissions authorities to it at the end. Signing with a Dev account keypair file also works and skips the handover.

| Account | Value |
| --- | --- |
| SolvesConfig | new keypair account, saved to `solve3-mainnet-beta-config.json` so reruns reuse it |
| Fee authority | Dev account `HGUP…sq6o`: creates fee tiers, sets fee rates, pauses trading |
| Collect-protocol-fees authority | Treasury `HRmz…NXNV`: the only key that can withdraw protocol fees |
| Reward emissions super authority | Dev account |
| Default protocol fee rate | 500 = 5% of each swap fee (95% to LPs) (`--protocol-fee-rate`, program cap 8,000) |
| Fee tier | tick spacing 8, fee rate 500 = 0.05% (the frontend's existing 0.05% tier) |
| Pool | wSOL (token A) / USDC (token B) at `--price` USDC per SOL |
| Tick arrays | the one holding the price and one each side, about ±7% (`--tick-arrays-each-side`) |

Rent is about 0.23 SOL, almost all of it the three tick arrays (about 0.07 SOL each).

## How fees reach the Treasury

Each swap pays 0.05%. The protocol share (5% by default) accrues in the pool as protocol fees owed; the other 95%
goes to in-range liquidity providers, which at launch is only the Dev account's position. The Treasury collects
protocol fees with `collect_protocol_fees`, signed by the Treasury, into its own SOL and USDC token accounts.
The fee authority (Dev) can change a pool's share later with `set_protocol_fee_rate`.

## Running it

```sh
cd sdk && bun install && bun run build
node scripts/mainnet-sol-usdc-pool.mjs --offline --price 180                  # build only, no RPC
SOLVE3_KEYPAIR=~/.solve3-devnet-keys/id.json node scripts/mainnet-sol-usdc-pool.mjs --price 180   # simulate on mainnet, sends nothing
SOLVE3_KEYPAIR=~/.solve3-devnet-keys/id.json SOLVE3_CONFIRM_MAINNET=create-sol-usdc-pool \
  node scripts/mainnet-sol-usdc-pool.mjs --price 180 --execute                 # create the pool
SOLVE3_KEYPAIR=~/.solve3-devnet-keys/id.json SOLVE3_CONFIRM_MAINNET=create-sol-usdc-pool \
  node scripts/mainnet-sol-usdc-pool.mjs --deposit-usdc 500 --range-pct 10 --execute   # first position
```

Use the current market price for `--price`; arbitrage moves any gap at the liquidity provider's expense.
On mainnet the script refuses any signer other than the deployer key or the Dev account, checks the RPC's genesis hash and that the
program is deployed, and simulates every transaction before sending. `--cluster devnet` runs the same steps
against devnet with Circle's devnet USDC. The keypair is read from a file and never printed.

After creation, set the pool address in the frontend, the arb bot and the volume bot.

## Changing the pool fee

The fee authority is the Dev account in Phantom, so fee changes are signed in the browser.
[`scripts/set-pool-fee-rate.mjs`](../scripts/set-pool-fee-rate.mjs) simulates `set_fee_rate`, then serves a page on
`http://localhost:8787` that asks Phantom to sign and send it, and prints the new fee once it is finalized:

```sh
SOLANA_RPC_URL=$(cat ~/.solve3-mainnet-rpc.txt) node scripts/set-pool-fee-rate.mjs --fee-rate 400   # 0.04%
```

The pool address stays the same; only the pool's own fee changes (the 0.05% fee tier remains the default for new pools).
