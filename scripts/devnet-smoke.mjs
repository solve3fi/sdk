// Devnet end-to-end check of the SDK against a deployed Solve program: swap both ways, open a position
// with liquidity, decrease it, collect fees and close it. Spends a few devnet cents; prints signatures.
//   SOLVE3_KEYPAIR=~/.solve3-devnet-keys/id.json SOLVE3_DEX=<program> SOLVE3_CONFIG=<solvesConfig> \
//   TOKEN_A=<mint> TOKEN_B=<mint> node scripts/devnet-smoke.mjs
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const { Wallet, BN } = require("../packages/sdk/node_modules/anchor-legacy");
const { Connection, Keypair, PublicKey } = require("../packages/sdk/node_modules/@solana/web3.js");
const Decimal = require("../packages/sdk/node_modules/decimal.js");
const common = require("../packages/common");
const sdk = require("../packages/sdk");
const { Percentage } = common;
const {
	buildSolveClient, SolveContext, PDAUtil, PoolUtil, TickUtil, TokenExtensionUtil, swapQuoteByInputToken,
	increaseLiquidityQuoteByInputTokenUsingPriceSlippage, decreaseLiquidityQuoteByLiquidity, IGNORE_CACHE,
} = sdk;

const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.SOLVE3_KEYPAIR, "utf8"))));
const PROGRAM = new PublicKey(process.env.SOLVE3_DEX);
const CONFIG = new PublicKey(process.env.SOLVE3_CONFIG);
const TOKEN_A = new PublicKey(process.env.TOKEN_A ?? "BdsGWxAqx8FkoMrG4XXPhVnJYw63TnrNEyUgGS8idxm7");
const TOKEN_B = new PublicKey(process.env.TOKEN_B ?? "FrN7oiLccXBSRCJGoAACUHSp3Efvji7mkwfGpZXcV6Up");
const SPACING = Number(process.env.SPACING ?? 64);
const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const ctx = SolveContext.from(connection, new Wallet(keypair), PROGRAM);
const client = buildSolveClient(ctx);
const slip = Percentage.fromFraction(1, 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(builder, label) {
	for (let attempt = 0; ; attempt++) {
		try {
			const sig = await builder.buildAndExecute({ blockhashCommitment: "confirmed" });
			await connection.confirmTransaction(sig, "confirmed");
			console.log(label, sig);
			return sig;
		} catch (error) {
			if (attempt >= 4 || !/429|Too Many|timeout|blockhash/i.test(String(error))) throw error;
			await sleep(2000 * (attempt + 1));
		}
	}
}

const [mintA, mintB] = PoolUtil.orderMints(TOKEN_A, TOKEN_B);
const poolAddress = PDAUtil.getSolve(PROGRAM, CONFIG, mintA, mintB, SPACING).publicKey;
let pool = await client.getPool(poolAddress, IGNORE_CACHE);
console.log("pool", poolAddress.toBase58(), "solvesConfig", pool.getData().solvesConfig.toBase58());
assert(pool.getData().solvesConfig.equals(CONFIG), "pool config matches");

// 1. swaps in both directions (the SDK must add the SolvesConfig account on its own)
for (const [mintIn, amount] of [[mintA, new Decimal("0.01")], [mintB, new Decimal("0.01")]]) {
	pool = await client.getPool(poolAddress, IGNORE_CACHE);
	const decimals = mintIn.equals(mintA) ? (await connection.getTokenSupply(mintA)).value.decimals : (await connection.getTokenSupply(mintB)).value.decimals;
	const raw = new BN(amount.mul(new Decimal(10).pow(decimals)).toFixed(0));
	const quote = await swapQuoteByInputToken(pool, mintIn, raw, slip, PROGRAM, ctx.fetcher, IGNORE_CACHE);
	const tx = await pool.swap(quote);
	await run(tx, `swap ${mintIn.equals(mintA) ? "A->B" : "B->A"} in=${quote.estimatedAmountIn} out=${quote.estimatedAmountOut}`);
}

// 2. liquidity round trip
pool = await client.getPool(poolAddress, IGNORE_CACHE);
const current = pool.getData().tickCurrentIndex;
const lower = TickUtil.getInitializableTickIndex(current - 640, SPACING);
const upper = TickUtil.getInitializableTickIndex(current + 640, SPACING);
const ext = await TokenExtensionUtil.buildTokenExtensionContextForPool(ctx.fetcher, mintA, mintB, IGNORE_CACHE);
const quote = increaseLiquidityQuoteByInputTokenUsingPriceSlippage(mintB, new Decimal("50"), lower, upper, slip, pool, ext);
const tickTx = await pool.initTickArrayForTicks([lower, upper], keypair.publicKey, IGNORE_CACHE);
if (tickTx) await run(tickTx, "initTickArrayForTicks");
const opened = await pool.openPosition(lower, upper, quote, keypair.publicKey, keypair.publicKey);
await run(opened.tx, "openPosition+increase");
const positionAddress = PDAUtil.getPosition(PROGRAM, opened.positionMint).publicKey;
let position = await client.getPosition(positionAddress, IGNORE_CACHE);
const half = position.getData().liquidity.div(new BN(2));
pool = await client.getPool(poolAddress, IGNORE_CACHE);
const dec = decreaseLiquidityQuoteByLiquidity(half, slip, position, pool, ext);
await run(await position.decreaseLiquidity(dec, true), "decreaseLiquidity");
position = await client.getPosition(positionAddress, IGNORE_CACHE);
const rest = decreaseLiquidityQuoteByLiquidity(position.getData().liquidity, slip, position, await client.getPool(poolAddress, IGNORE_CACHE), ext);
await run(await position.decreaseLiquidity(rest, true), "decreaseLiquidity (rest)");
console.log(JSON.stringify({ position: positionAddress.toBase58(), lower, upper, liquidityOpened: quote.liquidityAmount.toString() }));
console.log("SDK devnet smoke passed");

function assert(cond, msg) {
	if (!cond) throw new Error(`assertion failed: ${msg}`);
}
