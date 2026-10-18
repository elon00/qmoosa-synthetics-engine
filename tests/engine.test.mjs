import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SyntheticsEngine,
  AdminAuthManager,
  WAD
} from "../dist/index.js";

function setupEngine() {
  const { publicKey, privateKey } = AdminAuthManager.generateKeyPair();
  const engine = new SyntheticsEngine(publicKey, 31337);

  engine.registerSynthDirect("sUSD", "Synthetic USD", "sUSD");
  engine.registerSynthDirect("sETH", "Synthetic Ether", "sETH");
  engine.registerSynthDirect("sBTC", "Synthetic Bitcoin", "sBTC");

  engine.setOraclePriceDirect("COLLATERAL", 10n * WAD); // $10 SNX
  engine.setOraclePriceDirect("sUSD", 1n * WAD);
  engine.setOraclePriceDirect("sETH", 2000n * WAD);
  engine.setOraclePriceDirect("sBTC", 50000n * WAD);

  const alice = "0xAlice1111111111111111111111111111111111";
  const bob = "0xBob2222222222222222222222222222222222";
  const liquidator = "0xLiquidator333333333333333333333333333333";

  engine.setUserCollateralBalance(alice, 10000n * WAD);
  engine.setUserCollateralBalance(bob, 10000n * WAD);
  engine.setUserCollateralBalance(liquidator, 50000n * WAD);

  return { engine, publicKey, privateKey, alice, bob, liquidator };
}

test("1. Staking collateral and issuing sUSD within 200% min ratio", () => {
  const { engine, alice } = setupEngine();

  engine.stakeCollateral(alice, 1000n * WAD); // $10,000 value
  const issueRes = engine.issueSynths(alice, 2000n * WAD); // $2000 sUSD (500% ratio)
  assert.equal(issueRes.success, true);

  const pos = engine.getStakerPosition(alice);
  assert.equal(pos.isSolvent, true);
  assert.equal(pos.debtValueUsd, 2000n * WAD);
  assert.equal(pos.collateralRatioBps, 50000n);
  assert.equal(engine.getUserSynthBalance(alice, "sUSD"), 2000n * WAD);
});

test("2. Undercollateralized synth issuance strictly fails closed with atomic rollback", () => {
  const { engine, alice } = setupEngine();

  engine.stakeCollateral(alice, 1000n * WAD); // $10k value, max debt = 5k at 200%
  assert.throws(
    () => engine.issueSynths(alice, 6000n * WAD),
    /MINT_BREAKS_SOLVENCY/
  );

  const pos = engine.getStakerPosition(alice);
  assert.equal(pos.debtShares, 0n);
  assert.equal(engine.getUserSynthBalance(alice, "sUSD"), 0n);
});

test("3. Zero-slippage synthetic exchange execution", () => {
  const { engine, alice } = setupEngine();

  engine.stakeCollateral(alice, 1000n * WAD);
  engine.issueSynths(alice, 2000n * WAD);

  // Exchange 2000 sUSD for sETH ($2000/ETH, 30 bps fee)
  const excRes = engine.exchange(alice, "sUSD", 2000n * WAD, "sETH");
  assert.equal(excRes.success, true);

  assert.equal(engine.getUserSynthBalance(alice, "sUSD"), 0n);
  // Net USD = 1994 -> 0.997 sETH
  const expectedSeth = (1994n * WAD) / 2000n;
  assert.equal(engine.getUserSynthBalance(alice, "sETH"), expectedSeth);
});

test("4. Dynamic pooled debt tracking under asset price movements", () => {
  const { engine, alice, bob } = setupEngine();

  engine.stakeCollateral(alice, 5000n * WAD);
  engine.issueSynths(alice, 2000n * WAD);

  engine.stakeCollateral(bob, 5000n * WAD);
  engine.issueSynths(bob, 2000n * WAD);

  // Alice exchanges 2000 sUSD to sETH
  engine.exchange(alice, "sUSD", 2000n * WAD, "sETH");

  // ETH price surges to $4000
  engine.overrideOraclePriceDirect("sETH", 4000n * WAD);

  // Global debt increased from 4000 to ~5988
  const totalDebt = engine.totalGlobalDebtValue();
  assert.ok(totalDebt > 5900n * WAD);

  // Both Alice and Bob share the debt pool proportionally
  const aliceDebt = engine.calculateUserDebtValue(alice);
  const bobDebt = engine.calculateUserDebtValue(bob);
  assert.equal(aliceDebt, bobDebt);
  assert.ok(aliceDebt > 2900n * WAD);
});

test("5. Liquidation of underwater staker and bad debt deficit logging", () => {
  const { engine, alice, liquidator } = setupEngine();

  engine.stakeCollateral(alice, 1000n * WAD);
  engine.issueSynths(alice, 4000n * WAD); // 250% ratio

  // Crash collateral price from $10 to $2 -> $2000 collateral against $4000 debt (50% ratio < 200%)
  engine.overrideOraclePriceDirect("COLLATERAL", 2n * WAD);

  // Fund liquidator with sUSD
  engine.stakeCollateral(liquidator, 50000n * WAD);
  engine.issueSynths(liquidator, 10000n * WAD);

  // Liquidate Alice for 3000 sUSD
  const liqRes = engine.liquidate(liquidator, alice, 3000n * WAD);
  assert.equal(liqRes.success, true);

  // Since Alice had 1000 SNX at $2 ($2000 value), covering 3000 requires > $3300 collateral,
  // all 1000 SNX is seized and protocolBadDebt records the deficit!
  assert.equal(engine.getUserCollateralBalance(liquidator), 50000n * WAD - 50000n * WAD + 1000n * WAD);
  assert.ok(engine.protocolBadDebt > 0n);
});

test("6. Oracle staleness and deviation circuit breaker guards", () => {
  const { engine } = setupEngine();

  const staleTime = Math.floor(Date.now() / 1000) - 4000;
  assert.throws(
    () => engine.setOraclePriceDirect("sUSD", 1n * WAD, staleTime),
    /ORACLE_PRICE_STALE/
  );

  assert.throws(
    () => engine.setOraclePriceDirect("sETH", 4000n * WAD), // 100% jump from 2000 > 50% max deviation
    /PRICE_DEVIATION_EXCEEDED/
  );
});

test("7. Ed25519 administrative signatures and replay prevention", () => {
  const { engine, privateKey } = setupEngine();

  const now = Math.floor(Date.now() / 1000);
  const intent = AdminAuthManager.signAdminIntent(
    "SET_EXCHANGE_FEE",
    { feeBps: 20 },
    1,
    now + 3600,
    "QMOOSA:SYNTHETICS_ENGINE:31337",
    privateKey
  );

  engine.executeAdminIntent(intent);
  assert.equal(engine.exchangeFeeBps, 20n);

  // Nonce replay must fail closed
  assert.throws(
    () => engine.executeAdminIntent(intent),
    /Nonce replay rejected/
  );
});
