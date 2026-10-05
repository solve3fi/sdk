// Devnet check of the router path the app uses: find routes over every pool of a SolvesConfig, then execute
// the best direct route and the best two-hop route (the SDK must add the SolvesConfig account to each hop).
//   SOLVE3_KEYPAIR=... SOLVE3_DEX=... SOLVE3_CONFIG=... node scripts/devnet-router-smoke.mjs
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Wallet, BN } = require("../packages/sdk/node_modules/anchor-legacy");
const { Connection, Keypair, PublicKey } = require("../packages/sdk/node_modules/@solana/web3.js");
const { Percentage } = require("../packages/common");
const { buildSolveClient, SolveContext, RouterUtils, getAllSolveAccountsForConfig } = require("../packages/sdk");

const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.SOLVE3_KEYPAIR, "utf8"))));
const PROGRAM = new PublicKey(process.env.SOLVE3_DEX);
const CONFIG = new PublicKey(process.env.SOLVE3_CONFIG);
const connection = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const ctx = SolveContext.from(connection, new Wallet(keypair), PROGRAM);
const client = buildSolveClient(ctx);
const slip = Percentage.fromFraction(1, 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const retry = async (fn) => {
	for (let i = 0; ; i++) {
		try { return await fn(); } catch (e) { if (i >= 5 || !/429|Too Many|MintInfo|timeout/i.test(String(e))) throw e; await sleep(2500 * (i + 1)); }
	}
};

const accounts = await retry(() => getAllSolveAccountsForConfig({ connection, programId: PROGRAM, configId: CONFIG }));
const pools = [...accounts].filter(([, d]) => d && d.liquidity && !d.liquidity.isZero());
console.log(`${pools.length} pools with liquidity`);
const edges = pools.map(([address, d]) => ({ address, a: d.tokenMintA.toBase58(), b: d.tokenMintB.toBase58() }));
// a mint that appears in two pools gives a two-hop path between their other mints
let two = null;
for (const x of edges) for (const y of edges) {
	if (x.address === y.address) continue;
	for (const shared of [x.a, x.b]) if (shared === y.a || shared === y.b) {
		const from = shared === x.a ? x.b : x.a, to = shared === y.a ? y.b : y.a;
		if (from !== to && !edges.some((e) => [e.a, e.b].includes(from) && [e.a, e.b].includes(to))) two ??= { from, to };
	}
}
const router = await retry(() => client.getRouter(pools.map(([address]) => address)));
const decimalsOf = async (mint) => (await connection.getTokenSupply(new PublicKey(mint))).value.decimals;
async function exec(tokenIn, tokenOut, label, wantHops) {
	const amount = new BN(10).pow(new BN(Math.max(0, (await retry(() => decimalsOf(tokenIn))) - 2)));
	const trade = { tokenIn, tokenOut, tradeAmount: amount, amountSpecifiedIsInput: true };
	const routes = await retry(() => router.findAllRoutes(trade));
	const wanted = routes.filter((r) => r.subRoutes.every((s) => s.hopQuotes.length === wantHops));
	if (!wanted.length) { console.log(`${label}: no ${wantHops}-hop route`); return false; }
	const best = await RouterUtils.selectFirstExecutableRoute(ctx, wanted, { maxSupportedTransactionVersion: 0, maxTransactionSize: 1232 });
	if (!best) { console.log(`${label}: no executable route`); return false; }
	const tx = await router.swap(best[0], slip, null);
	const sig = await retry(() => tx.buildAndExecute({ maxSupportedTransactionVersion: 0 }));
	await connection.confirmTransaction(sig, "confirmed");
	console.log(label, `${wantHops}-hop`, sig);
	return true;
}
// direct: any pool, both mints
const direct = edges[0];
const okDirect = await exec(direct.a, direct.b, "routed direct", 1);
const okTwo = two ? await exec(two.from, two.to, "routed two-hop", 2) : (console.log("no two-hop pair in this config"), false);
if (!okDirect) throw new Error("direct route failed");
console.log(okTwo ? "router smoke passed (direct and two-hop)" : "router smoke passed (direct only)");
