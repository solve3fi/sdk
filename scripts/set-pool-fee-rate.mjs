// Changes a pool's swap fee with a signature from the fee authority's browser wallet (Phantom).
// Builds and simulates the set_fee_rate transaction, then serves a page on http://localhost:8787 that
// asks Phantom to sign and send it. Prints the new fee once it is confirmed on chain.
//
//   SOLANA_RPC_URL=<rpc> node scripts/set-pool-fee-rate.mjs --fee-rate 400              # 0.04%
//   ... --pool <address> --dry-run                                                       # simulate only
//
// fee_rate is in hundredths of a basis point: 400 = 0.04%, 500 = 0.05%. No keypair is read; the
// transaction is signed only in the browser wallet.
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const { Wallet } = require("../packages/sdk/node_modules/anchor-legacy");
const web3 = require("../packages/sdk/node_modules/@solana/web3.js");
const sdk = require("../packages/sdk");
const { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } = web3;
const { SolveContext, SolveIx, buildSolveClient, IGNORE_CACHE } = sdk;

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const PROGRAM = new PublicKey("HnosXNWPvKSFkY6xjUpCJ9nhbvTRhdfNTfWpgp3m4GK");
const PORT = 8787;

const args = parseArgs(process.argv.slice(2));
const POOL = new PublicKey(args.pool ?? "uy81yVcSadVN9jgFpESYuDqCSgtGZFHEjdECghB7UYW");
const FEE_RATE = Number(args["fee-rate"]);
if (!Number.isInteger(FEE_RATE) || FEE_RATE < 0 || FEE_RATE > 60000) fail("--fee-rate must be 0..60000 (400 = 0.04%)");
if (!process.env.SOLANA_RPC_URL) fail("set SOLANA_RPC_URL");

const connection = new Connection(process.env.SOLANA_RPC_URL, "confirmed");
if ((await connection.getGenesisHash()) !== MAINNET_GENESIS) fail("SOLANA_RPC_URL is not mainnet-beta");
const ctx = SolveContext.from(connection, new Wallet(Keypair.generate()), PROGRAM);
const client = buildSolveClient(ctx);
const pool = (await client.getPool(POOL, IGNORE_CACHE)).getData();
const config = await ctx.fetcher.getConfig(pool.solvesConfig, IGNORE_CACHE);
const feeAuthority = config.feeAuthority;
console.log(`pool ${POOL.toBase58()}: fee ${pool.feeRate} (${pool.feeRate / 10000}%) -> ${FEE_RATE} (${FEE_RATE / 10000}%)`);
console.log(`must be signed by the fee authority ${feeAuthority.toBase58()}`);
if (pool.feeRate === FEE_RATE) {
	console.log("already set; nothing to do");
	process.exit(0);
}

async function buildTx() {
	const ix = SolveIx.setFeeRateIx(ctx.program, { solve: POOL, solvesConfig: pool.solvesConfig, feeAuthority, feeRate: FEE_RATE });
	const { blockhash } = await connection.getLatestBlockhash("confirmed");
	const message = new TransactionMessage({ payerKey: feeAuthority, recentBlockhash: blockhash, instructions: ix.instructions }).compileToV0Message();
	return new VersionedTransaction(message);
}

const sim = await connection.simulateTransaction(await buildTx(), { sigVerify: false, replaceRecentBlockhash: true });
if (sim.value.err) {
	console.log(sim.value.logs?.join("\n"));
	fail(`simulation failed: ${JSON.stringify(sim.value.err)}`);
}
console.log(`simulation ok, ${sim.value.unitsConsumed} compute units`);
if (args["dry-run"]) {
	console.log("dry run passed; nothing was sent");
	process.exit(0);
}

const web3Bundle = fs.readFileSync(require.resolve("../packages/sdk/node_modules/@solana/web3.js/lib/index.iife.min.js"));
const page = `<!doctype html><meta charset="utf-8"><title>Solve3 pool fee</title>
<body style="font:16px system-ui;max-width:560px;margin:40px auto;padding:0 16px">
<h2>Change the SOL/USDC pool fee</h2>
<p>From <b>${pool.feeRate / 10000}%</b> to <b>${FEE_RATE / 10000}%</b>. Sign with the Phantom wallet <code>${feeAuthority.toBase58()}</code>.</p>
<button id="go" style="font-size:18px;padding:10px 20px">Sign with Phantom</button>
<p id="out"></p>
<script src="/web3.js"></script>
<script>
const out = document.getElementById("out");
document.getElementById("go").onclick = async () => {
	try {
		const phantom = window.phantom?.solana;
		if (!phantom) throw new Error("Phantom was not found in this browser.");
		const { publicKey } = await phantom.connect();
		if (publicKey.toString() !== "${feeAuthority.toBase58()}") throw new Error("Phantom is on " + publicKey + ". Switch to ${feeAuthority.toBase58()} and try again.");
		const b64 = await (await fetch("/tx")).text();
		const tx = solanaWeb3.VersionedTransaction.deserialize(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
		out.textContent = "Waiting for Phantom...";
		const { signature } = await phantom.signAndSendTransaction(tx);
		await fetch("/done?sig=" + signature);
		out.textContent = "Sent. Go back to Ubuntu to see the result.";
	} catch (e) { out.textContent = "Error: " + (e.message || e); }
};
</script>`;

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	if (url.pathname === "/web3.js") return res.end(web3Bundle);
	if (url.pathname === "/tx") return res.end(Buffer.from((await buildTx()).serialize()).toString("base64"));
	if (url.pathname === "/done") {
		res.end("ok");
		const sig = url.searchParams.get("sig");
		console.log(`sent: ${sig}; waiting for confirmation...`);
		await connection.confirmTransaction(sig, "finalized");
		const after = (await client.getPool(POOL, IGNORE_CACHE)).getData();
		console.log(`done: pool fee is now ${after.feeRate} (${after.feeRate / 10000}%)`);
		server.close();
		return process.exit(after.feeRate === FEE_RATE ? 0 : 1);
	}
	res.setHeader("content-type", "text/html");
	res.end(page);
});
server.listen(PORT, "127.0.0.1", () => console.log(`\nopen http://localhost:${PORT} in the browser that has Phantom`));

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const key = argv[i].replace(/^--/, "");
		if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) out[key] = true;
		else out[key] = argv[++i];
	}
	return out;
}

function fail(msg) {
	console.error(`error: ${msg}`);
	process.exit(1);
}
