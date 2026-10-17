// Creates the Solve3 SOL/USDC pool in one atomic transaction: SolvesConfig, the 0.05% fee tier
// (tick spacing 8), the pool at a given price, and the tick arrays around it. Optionally opens the
// first liquidity position in a second transaction.
//
// Nothing is sent unless --execute is passed. Without it the script builds and simulates every
// transaction against the RPC (or, with --offline, only builds them and prints the plan).
//
//   node scripts/mainnet-sol-usdc-pool.mjs --offline --price 180
//   SOLANA_RPC_URL=<rpc> SOLVE3_KEYPAIR=<dev keypair path> \
//     node scripts/mainnet-sol-usdc-pool.mjs --cluster devnet --price 180            # simulate only
//   ... --cluster mainnet-beta --price 180 --execute                                  # sends
//   ... --cluster mainnet-beta --deposit-usdc 500 --range-pct 10 --execute           # first position
//
// The signer keypair is read from SOLVE3_KEYPAIR and never printed. On mainnet-beta it must be the
// Dev account or the deployer key; --execute also needs SOLVE3_CONFIRM_MAINNET=create-sol-usdc-pool.
// When the deployer key signs, the same transaction hands the fee and reward-emissions authorities to
// the Dev account, so the Dev account (a browser wallet) ends up in control without signing here.
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const { Wallet, BN } = require("../packages/sdk/node_modules/anchor-legacy");
const web3 = require("../packages/sdk/node_modules/@solana/web3.js");
const Decimal = require("../packages/sdk/node_modules/decimal.js");
const common = require("../packages/common");
const sdk = require("../packages/sdk");
const { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } = web3;
const { SolveContext, SolveIx, PDAUtil, PoolUtil, PriceMath, TickUtil, buildSolveClient, IGNORE_CACHE } = sdk;

const DEV = new PublicKey("HGUPXpPUhD6PiTSWexebRSsgCT1uDAgiKk2DvdRHsq6o");
const DEPLOYER = new PublicKey("4j3VFftvWC4R2KxbF4R8bJKz2Mxk3m6a2RjkEu8ySVPs");
const TREASURY = new PublicKey("HRmz8NhLJDXYiSyR6STzBkofJZGb9ZMbbEh3rMHRVXNV");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const CLUSTERS = {
	"mainnet-beta": {
		genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
		rpc: "https://api.mainnet-beta.solana.com",
		usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
	},
	devnet: {
		genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
		rpc: "https://api.devnet.solana.com",
		usdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // Circle's devnet USDC
	},
};
const DECIMALS = { sol: 9, usdc: 6 };

const args = parseArgs(process.argv.slice(2));
const cluster = args.cluster ?? "mainnet-beta";
const net = CLUSTERS[cluster];
if (!net) fail(`unknown --cluster ${cluster}`);
const PROGRAM = new PublicKey(args.program ?? process.env.SOLVE3_DEX ?? "HnosXNWPvKSFkY6xjUpCJ9nhbvTRhdfNTfWpgp3m4GK");
const USDC = new PublicKey(args.usdc ?? net.usdc);
const TICK_SPACING = Number(args["tick-spacing"] ?? 8);
const FEE_RATE = Number(args["fee-rate"] ?? 500); // hundredths of a basis point: 500 = 0.05%
const PROTOCOL_FEE_RATE = Number(args["protocol-fee-rate"] ?? 500); // basis points of the fee: 500 = 5% to Treasury, 95% to LPs
const TICK_ARRAYS_EACH_SIDE = Number(args["tick-arrays-each-side"] ?? 1);
const offline = Boolean(args.offline);
const execute = Boolean(args.execute);
if (offline && execute) fail("--offline and --execute cannot be combined");
if (PROTOCOL_FEE_RATE > 8000) fail("the program caps the default protocol fee rate at 8000");

const signer = offline ? null : loadKeypair(process.env.SOLVE3_KEYPAIR);
const payer = signer?.publicKey ?? DEPLOYER;
const connection = new Connection(process.env.SOLANA_RPC_URL ?? net.rpc, "confirmed");
const ctx = SolveContext.from(connection, new Wallet(signer ?? Keypair.generate()), PROGRAM);

if (!offline) {
	const genesis = await connection.getGenesisHash();
	if (genesis !== net.genesis) fail(`RPC genesis ${genesis} is not ${cluster}`);
	if (cluster === "mainnet-beta" && !payer.equals(DEV) && !payer.equals(DEPLOYER)) {
		fail(`signer ${payer.toBase58()} is neither the Dev account nor the deployer key`);
	}
	if (execute && cluster === "mainnet-beta" && process.env.SOLVE3_CONFIRM_MAINNET !== "create-sol-usdc-pool") {
		fail("set SOLVE3_CONFIRM_MAINNET=create-sol-usdc-pool to send on mainnet-beta");
	}
	const programInfo = await connection.getAccountInfo(PROGRAM);
	if (!programInfo?.executable) fail(`program ${PROGRAM.toBase58()} is not deployed on ${cluster}`);
}

// The config is a plain keypair account. Its keypair is only needed to create it; keep the file so a
// rerun reuses the same address instead of creating a second config.
const configPath = args["config-keypair"] ?? `solve3-${cluster}-config.json`;
const configKeypair = offline && !fs.existsSync(configPath) ? Keypair.generate() : loadOrCreateKeypair(configPath);
const CONFIG = configKeypair.publicKey;

const [mintA, mintB] = PoolUtil.orderMints(WSOL, USDC).map((m) => new PublicKey(m));
const solIsA = mintA.equals(WSOL);
const [decimalsA, decimalsB] = solIsA ? [DECIMALS.sol, DECIMALS.usdc] : [DECIMALS.usdc, DECIMALS.sol];
const feeTier = PDAUtil.getFeeTier(PROGRAM, CONFIG, TICK_SPACING);
const solvePda = PDAUtil.getSolve(PROGRAM, CONFIG, mintA, mintB, TICK_SPACING);

const plan = {
	cluster,
	program: PROGRAM.toBase58(),
	payer: payer.toBase58(),
	solvesConfig: CONFIG.toBase58(),
	feeAuthority: DEV.toBase58(),
	collectProtocolFeesAuthority: TREASURY.toBase58(),
	rewardEmissionsSuperAuthority: DEV.toBase58(),
	defaultProtocolFeeRate: `${PROTOCOL_FEE_RATE} (${PROTOCOL_FEE_RATE / 100}% of each swap fee to the protocol)`,
	feeTier: { address: feeTier.publicKey.toBase58(), tickSpacing: TICK_SPACING, feeRate: `${FEE_RATE} (${FEE_RATE / 10000}%)` },
	pool: solvePda.publicKey.toBase58(),
	tokenA: `${mintA.toBase58()} (${solIsA ? "SOL" : "USDC"})`,
	tokenB: `${mintB.toBase58()} (${solIsA ? "USDC" : "SOL"})`,
};

const existing = offline ? new Map() : await accountsExist([CONFIG, feeTier.publicKey, solvePda.publicKey]);
const steps = [];

// 1. config + fee tier + pool + tick arrays, all in one transaction so a failure leaves nothing behind
if (!existing.get(solvePda.publicKey.toBase58())) {
	if (args.price === undefined) fail("--price <USDC per SOL> is required to create the pool");
	const usdcPerSol = new Decimal(args.price);
	const priceBperA = solIsA ? usdcPerSol : new Decimal(1).div(usdcPerSol);
	const initSqrtPrice = PriceMath.priceToSqrtPriceX64(priceBperA, decimalsA, decimalsB);
	const currentTick = PriceMath.sqrtPriceX64ToTickIndex(initSqrtPrice);
	plan.initialPrice = `${usdcPerSol} USDC per SOL (tick ${currentTick}, sqrtPriceX64 ${initSqrtPrice.toString()})`;

	const ixs = [];
	const signers = [];
	if (!existing.get(CONFIG.toBase58())) {
		const ix = SolveIx.initializeConfigIx(ctx.program, {
			solvesConfigKeypair: configKeypair,
			feeAuthority: payer,
			collectProtocolFeesAuthority: TREASURY,
			rewardEmissionsSuperAuthority: payer,
			defaultProtocolFeeRate: PROTOCOL_FEE_RATE,
			funder: payer,
		});
		ixs.push(...ix.instructions);
		signers.push(...ix.signers);
	}
	if (!existing.get(feeTier.publicKey.toBase58())) {
		// The fee tier must be signed by the config's fee authority, which is the payer until the handover below.
		const ix = SolveIx.initializeFeeTierIx(ctx.program, {
			solvesConfig: CONFIG,
			feeTierPda: feeTier,
			tickSpacing: TICK_SPACING,
			defaultFeeRate: FEE_RATE,
			feeAuthority: payer,
			funder: payer,
		});
		ixs.push(...ix.instructions);
	}
	const tokenVaultAKeypair = Keypair.generate();
	const tokenVaultBKeypair = Keypair.generate();
	const poolIx = SolveIx.initializePoolIx(ctx.program, {
		initSqrtPrice,
		solvesConfig: CONFIG,
		solvePda,
		tokenMintA: mintA,
		tokenMintB: mintB,
		tokenVaultAKeypair,
		tokenVaultBKeypair,
		feeTierKey: feeTier.publicKey,
		tickSpacing: TICK_SPACING,
		funder: payer,
	});
	ixs.push(...poolIx.instructions);
	signers.push(...poolIx.signers);
	plan.tickArrays = [];
	for (let offset = -TICK_ARRAYS_EACH_SIDE; offset <= TICK_ARRAYS_EACH_SIDE; offset++) {
		const startTick = TickUtil.getStartTickIndex(currentTick, TICK_SPACING, offset);
		const tickArrayPda = PDAUtil.getTickArray(PROGRAM, solvePda.publicKey, startTick);
		const ix = SolveIx.initTickArrayIx(ctx.program, { startTick, tickArrayPda, solve: solvePda.publicKey, funder: payer });
		ixs.push(...ix.instructions);
		plan.tickArrays.push({ startTick, address: tickArrayPda.publicKey.toBase58() });
	}
	if (!existing.get(CONFIG.toBase58()) && !payer.equals(DEV)) {
		ixs.push(
			...SolveIx.setFeeAuthorityIx(ctx.program, { solvesConfig: CONFIG, feeAuthority: payer, newFeeAuthority: DEV }).instructions,
			...SolveIx.setRewardEmissionsSuperAuthorityIx(ctx.program, {
				solvesConfig: CONFIG,
				rewardEmissionsSuperAuthority: payer,
				newRewardEmissionsSuperAuthority: DEV,
			}).instructions,
		);
		plan.handover = `fee and reward-emissions authorities move from ${payer.toBase58()} to the Dev account`;
	}
	steps.push({ label: "create config, fee tier, pool and tick arrays", ixs, signers });
} else {
	plan.note = "pool already exists; skipping creation";
}

// 2. optional first position (needs live pool state, so it cannot be built offline)
if (args["deposit-usdc"] !== undefined) {
	if (offline) fail("--deposit-usdc needs RPC; run without --offline");
	if (!existing.get(solvePda.publicKey.toBase58())) fail("create the pool first, then rerun with --deposit-usdc");
	const client = buildSolveClient(ctx);
	const pool = await client.getPool(solvePda.publicKey, IGNORE_CACHE);
	const rangePct = new Decimal(args["range-pct"] ?? 10).div(100);
	const price = PriceMath.sqrtPriceX64ToPrice(pool.getData().sqrtPrice, decimalsA, decimalsB);
	const lower = PriceMath.priceToInitializableTickIndex(price.mul(new Decimal(1).minus(rangePct)), decimalsA, decimalsB, TICK_SPACING);
	const upper = PriceMath.priceToInitializableTickIndex(price.mul(new Decimal(1).plus(rangePct)), decimalsA, decimalsB, TICK_SPACING);
	const ext = await sdk.TokenExtensionUtil.buildTokenExtensionContextForPool(ctx.fetcher, mintA, mintB, IGNORE_CACHE);
	const quote = sdk.increaseLiquidityQuoteByInputTokenUsingPriceSlippage(
		USDC, new Decimal(args["deposit-usdc"]), lower, upper, common.Percentage.fromFraction(1, 100), pool, ext,
	);
	plan.position = {
		range: `±${rangePct.mul(100)}% (ticks ${lower}..${upper})`,
		maxTokenA: quote.tokenMaxA.toString(),
		maxTokenB: quote.tokenMaxB.toString(),
	};
	const tickTx = await pool.initTickArrayForTicks([lower, upper], payer, IGNORE_CACHE);
	if (tickTx) steps.push({ label: "initialize tick arrays for the position", builder: tickTx });
	const opened = await pool.openPositionWithMetadata(lower, upper, quote, payer, payer);
	plan.position.mint = opened.positionMint.toBase58();
	steps.push({ label: "open position and add liquidity", builder: opened.tx });
}

console.log(JSON.stringify(plan, null, 2));

for (const step of steps) {
	const tx = step.builder ? (await step.builder.build()).transaction : await legacyTx(step.ixs, step.signers);
	const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
	console.log(`\n${step.label}: ${bytes} bytes (limit 1232)`);
	if (bytes > 1232) fail("transaction too large");
	if (offline) continue;
	const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
	if (sim.value.err) {
		console.log(sim.value.logs?.join("\n"));
		fail(`simulation failed: ${JSON.stringify(sim.value.err)}`);
	}
	console.log(`simulation ok, ${sim.value.unitsConsumed} compute units`);
	if (!execute) continue;
	const sig = step.builder
		? await step.builder.buildAndExecute({ blockhashCommitment: "confirmed" })
		: await sendLegacy(step.ixs, step.signers);
	await connection.confirmTransaction(sig, "finalized");
	console.log(`sent and finalized: ${sig}`);
}
console.log(execute ? "\ndone" : `\n${offline ? "offline build" : "dry run"} passed; nothing was sent`);

async function legacyTx(ixs, extraSigners) {
	const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs);
	tx.feePayer = payer;
	tx.recentBlockhash = offline ? Keypair.generate().publicKey.toBase58() : (await connection.getLatestBlockhash()).blockhash;
	tx.partialSign(...extraSigners);
	if (signer) tx.partialSign(signer);
	return tx;
}

async function sendLegacy(ixs, extraSigners) {
	const tx = await legacyTx(ixs, extraSigners);
	return connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
}

async function accountsExist(keys) {
	const infos = await connection.getMultipleAccountsInfo(keys);
	return new Map(keys.map((k, i) => [k.toBase58(), infos[i] !== null]));
}

function loadKeypair(path) {
	if (!path) fail("SOLVE3_KEYPAIR must point at the signer keypair file");
	return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.replace(/^~/, process.env.HOME), "utf8"))));
}

function loadOrCreateKeypair(path) {
	if (fs.existsSync(path)) return loadKeypair(path);
	const kp = Keypair.generate();
	fs.writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
	return kp;
}

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
