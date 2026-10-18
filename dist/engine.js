import crypto from "node:crypto";
import { calculateDebtSharesToMint, calculateDebtSharesToBurn, calculateUserDebtValue, calculateExchangeAmount, calculateCollateralRatio, calculateLiquidation, BPS_DIVISOR, WAD } from "./types.js";
import { AdminAuthManager } from "./auth.js";
export class SyntheticsEngine {
    synths = new Map();
    oracleFeeds = new Map();
    stakedCollateral = new Map();
    userDebtShares = new Map();
    userSynthBalances = new Map(); // user -> (currencyKey -> balance)
    userCollateralBalances = new Map();
    totalDebtShares = 0n;
    minCollateralRatioBps = 20000n; // 200%
    liquidationPenaltyBps = 1000n; // 10%
    exchangeFeeBps = 30n; // 0.30%
    maxOracleStaleness = 3600; // 1 hour
    maxPriceDeviationBps = 5000n; // 50%
    protocolBadDebt = 0n;
    collateralDecimals = 18;
    authManager;
    chainId;
    constructor(adminPublicKey, chainId = 31337) {
        this.authManager = new AdminAuthManager(adminPublicKey, chainId);
        this.chainId = chainId;
    }
    registerSynthDirect(currencyKey, name, symbol) {
        const now = Math.floor(Date.now() / 1000);
        this.synths.set(currencyKey, {
            currencyKey,
            name,
            symbol,
            priceWad: 0n,
            totalSupply: 0n,
            updatedAt: now
        });
    }
    setOraclePriceDirect(currencyKey, priceWad, updatedAt, bypassDeviationCheck = false) {
        if (priceWad <= 0n)
            throw new RangeError("INVALID_ORACLE_PRICE: Price must be strictly positive");
        const now = Math.floor(Date.now() / 1000);
        const timestamp = updatedAt ?? now;
        if (timestamp > now)
            throw new Error("FUTURE_TIMESTAMP: Price timestamp cannot be in the future");
        if (now - timestamp > this.maxOracleStaleness)
            throw new Error("ORACLE_PRICE_STALE");
        const existing = this.oracleFeeds.get(currencyKey);
        if (!bypassDeviationCheck && existing && existing.priceWad > 0n) {
            const prev = existing.priceWad;
            const diff = priceWad > prev ? priceWad - prev : prev - priceWad;
            const devBps = (diff * BPS_DIVISOR) / prev;
            if (devBps > this.maxPriceDeviationBps) {
                throw new Error("PRICE_DEVIATION_EXCEEDED");
            }
        }
        this.oracleFeeds.set(currencyKey, { priceWad, updatedAt: timestamp });
        const s = this.synths.get(currencyKey);
        if (s) {
            s.priceWad = priceWad;
            s.updatedAt = timestamp;
        }
    }
    overrideOraclePriceDirect(currencyKey, priceWad) {
        this.setOraclePriceDirect(currencyKey, priceWad, undefined, true);
    }
    getOraclePrice(currencyKey) {
        const feed = this.oracleFeeds.get(currencyKey);
        if (!feed || feed.priceWad <= 0n)
            throw new Error("ORACLE_PRICE_NOT_SET");
        const now = Math.floor(Date.now() / 1000);
        if (now - feed.updatedAt > this.maxOracleStaleness)
            throw new Error("ORACLE_PRICE_STALE");
        return feed.priceWad;
    }
    setUserCollateralBalance(user, balance) {
        this.userCollateralBalances.set(user, balance);
    }
    getUserCollateralBalance(user) {
        return this.userCollateralBalances.get(user) ?? 0n;
    }
    getUserSynthBalance(user, currencyKey) {
        const userMap = this.userSynthBalances.get(user);
        return userMap ? (userMap.get(currencyKey) ?? 0n) : 0n;
    }
    setUserSynthBalance(user, currencyKey, balance) {
        let userMap = this.userSynthBalances.get(user);
        if (!userMap) {
            userMap = new Map();
            this.userSynthBalances.set(user, userMap);
        }
        userMap.set(currencyKey, balance);
    }
    executeAdminIntent(intent) {
        this.authManager.verifyAndConsume(intent);
        switch (intent.action) {
            case "SET_ORACLE_PRICE": {
                const { currencyKey, priceWad, updatedAt } = intent.params;
                this.setOraclePriceDirect(currencyKey, BigInt(priceWad), updatedAt ? Number(updatedAt) : undefined, false);
                break;
            }
            case "OVERRIDE_ORACLE_PRICE": {
                const { currencyKey, priceWad } = intent.params;
                this.overrideOraclePriceDirect(currencyKey, BigInt(priceWad));
                break;
            }
            case "REGISTER_SYNTH": {
                const { currencyKey, name, symbol } = intent.params;
                this.registerSynthDirect(currencyKey, name, symbol);
                break;
            }
            case "SET_MIN_COLLATERAL_RATIO": {
                const { minRatioBps } = intent.params;
                this.minCollateralRatioBps = BigInt(minRatioBps);
                break;
            }
            case "SET_EXCHANGE_FEE": {
                const { feeBps } = intent.params;
                this.exchangeFeeBps = BigInt(feeBps);
                break;
            }
            default:
                throw new Error(`UNKNOWN_ADMIN_ACTION: ${intent.action}`);
        }
    }
    stakeCollateral(user, amount) {
        if (amount <= 0n)
            throw new RangeError("STAKE_AMOUNT_MUST_BE_POSITIVE");
        const balance = this.getUserCollateralBalance(user);
        if (balance < amount)
            throw new Error("INSUFFICIENT_COLLATERAL_BALANCE");
        this.setUserCollateralBalance(user, balance - amount);
        const staked = (this.stakedCollateral.get(user) ?? 0n) + amount;
        this.stakedCollateral.set(user, staked);
        return {
            txId: `tx_stk_${crypto.randomBytes(8).toString("hex")}`,
            operation: "STAKE",
            actor: user,
            timestamp: Math.floor(Date.now() / 1000),
            success: true,
            details: { amount: amount.toString(), totalStaked: staked.toString() }
        };
    }
    unstakeCollateral(user, amount) {
        if (amount <= 0n)
            throw new RangeError("UNSTAKE_AMOUNT_MUST_BE_POSITIVE");
        const staked = this.stakedCollateral.get(user) ?? 0n;
        if (staked < amount)
            throw new Error("INSUFFICIENT_STAKED_COLLATERAL");
        // Tentatively deduct
        this.stakedCollateral.set(user, staked - amount);
        const pos = this.getStakerPosition(user);
        if (pos.debtShares > 0n && !pos.isSolvent) {
            this.stakedCollateral.set(user, staked);
            throw new Error("UNSTAKE_BREAKS_SOLVENCY");
        }
        const cur = this.getUserCollateralBalance(user);
        this.setUserCollateralBalance(user, cur + amount);
        return {
            txId: `tx_unstk_${crypto.randomBytes(8).toString("hex")}`,
            operation: "UNSTAKE",
            actor: user,
            timestamp: Math.floor(Date.now() / 1000),
            success: true,
            details: { amount: amount.toString(), remainingStaked: (staked - amount).toString() }
        };
    }
    issueSynths(user, susdAmount) {
        if (susdAmount <= 0n)
            throw new RangeError("ISSUE_AMOUNT_MUST_BE_POSITIVE");
        const susd = this.synths.get("sUSD");
        if (!susd)
            throw new Error("SUSD_NOT_REGISTERED");
        const currentTotalDebt = this.totalGlobalDebtValue();
        const sharesToMint = calculateDebtSharesToMint(susdAmount, this.totalDebtShares, currentTotalDebt);
        // Apply mint state
        this.totalDebtShares += sharesToMint;
        const userShares = (this.userDebtShares.get(user) ?? 0n) + sharesToMint;
        this.userDebtShares.set(user, userShares);
        susd.totalSupply += susdAmount;
        this.setUserSynthBalance(user, "sUSD", this.getUserSynthBalance(user, "sUSD") + susdAmount);
        const pos = this.getStakerPosition(user);
        if (!pos.isSolvent) {
            // Rollback
            this.totalDebtShares -= sharesToMint;
            this.userDebtShares.set(user, userShares - sharesToMint);
            susd.totalSupply -= susdAmount;
            this.setUserSynthBalance(user, "sUSD", this.getUserSynthBalance(user, "sUSD") - susdAmount);
            throw new Error("MINT_BREAKS_SOLVENCY: Staker position is undercollateralized");
        }
        return {
            txId: `tx_iss_${crypto.randomBytes(8).toString("hex")}`,
            operation: "ISSUE",
            actor: user,
            timestamp: Math.floor(Date.now() / 1000),
            success: true,
            details: { susdAmount: susdAmount.toString(), sharesMinted: sharesToMint.toString() }
        };
    }
    burnSynths(user, susdAmount) {
        if (susdAmount <= 0n)
            throw new RangeError("BURN_AMOUNT_MUST_BE_POSITIVE");
        const susd = this.synths.get("sUSD");
        if (!susd)
            throw new Error("SUSD_NOT_REGISTERED");
        const userBalance = this.getUserSynthBalance(user, "sUSD");
        if (userBalance < susdAmount)
            throw new Error("INSUFFICIENT_SUSD_BALANCE");
        const userShares = this.userDebtShares.get(user) ?? 0n;
        const userDebt = this.calculateUserDebtValue(user);
        if (userDebt <= 0n)
            throw new Error("ZERO_DEBT");
        const burnAmount = susdAmount > userDebt ? userDebt : susdAmount;
        const sharesToBurn = calculateDebtSharesToBurn(burnAmount, userShares, userDebt);
        this.userDebtShares.set(user, userShares - sharesToBurn);
        this.totalDebtShares -= sharesToBurn;
        susd.totalSupply -= burnAmount;
        this.setUserSynthBalance(user, "sUSD", userBalance - burnAmount);
        return {
            txId: `tx_brn_${crypto.randomBytes(8).toString("hex")}`,
            operation: "BURN",
            actor: user,
            timestamp: Math.floor(Date.now() / 1000),
            success: true,
            details: { susdBurned: burnAmount.toString(), sharesBurned: sharesToBurn.toString() }
        };
    }
    exchange(user, sourceKey, sourceAmount, destKey) {
        if (sourceKey === destKey)
            throw new Error("CANNOT_EXCHANGE_SAME_CURRENCY");
        if (sourceAmount <= 0n)
            throw new RangeError("INVALID_SOURCE_AMOUNT");
        const sourceSynth = this.synths.get(sourceKey);
        const destSynth = this.synths.get(destKey);
        if (!sourceSynth || !destSynth)
            throw new Error("UNREGISTERED_SYNTH");
        const userSourceBal = this.getUserSynthBalance(user, sourceKey);
        if (userSourceBal < sourceAmount)
            throw new Error("INSUFFICIENT_SYNTH_BALANCE");
        const sourcePrice = this.getOraclePrice(sourceKey);
        const destPrice = this.getOraclePrice(destKey);
        const { destAmount, feeUsd } = calculateExchangeAmount(sourceAmount, sourcePrice, destPrice, this.exchangeFeeBps);
        // Burn source synth
        this.setUserSynthBalance(user, sourceKey, userSourceBal - sourceAmount);
        sourceSynth.totalSupply -= sourceAmount;
        // Mint destination synth
        const userDestBal = this.getUserSynthBalance(user, destKey);
        this.setUserSynthBalance(user, destKey, userDestBal + destAmount);
        destSynth.totalSupply += destAmount;
        return {
            txId: `tx_exc_${crypto.randomBytes(8).toString("hex")}`,
            operation: "EXCHANGE",
            actor: user,
            timestamp: Math.floor(Date.now() / 1000),
            success: true,
            details: {
                sourceKey,
                sourceAmount: sourceAmount.toString(),
                destKey,
                destAmount: destAmount.toString(),
                feeUsd: feeUsd.toString()
            }
        };
    }
    liquidate(liquidator, user, debtToCover) {
        const pos = this.getStakerPosition(user);
        if (pos.isSolvent)
            throw new Error("POSITION_SOLVENT: Cannot liquidate a healthy staker");
        if (debtToCover <= 0n)
            throw new RangeError("DEBT_TO_COVER_MUST_BE_POSITIVE");
        const liquidatorBalance = this.getUserSynthBalance(liquidator, "sUSD");
        if (liquidatorBalance < debtToCover)
            throw new Error("INSUFFICIENT_LIQUIDATOR_SUSD_BALANCE");
        const collPrice = this.getOraclePrice("COLLATERAL");
        const { actualCover, collateralToSeize, badDebtShortfall } = calculateLiquidation(debtToCover, pos.debtValueUsd, pos.stakedCollateral, collPrice, this.collateralDecimals, this.liquidationPenaltyBps);
        if (badDebtShortfall > 0n) {
            this.protocolBadDebt += badDebtShortfall;
        }
        // Burn liquidator sUSD
        this.setUserSynthBalance(liquidator, "sUSD", liquidatorBalance - actualCover);
        const susd = this.synths.get("sUSD");
        susd.totalSupply -= actualCover;
        // Burn user debt shares
        const userShares = this.userDebtShares.get(user) ?? 0n;
        const sharesToBurn = (actualCover * userShares) / pos.debtValueUsd;
        this.userDebtShares.set(user, userShares - sharesToBurn);
        this.totalDebtShares -= sharesToBurn;
        // Deduct user collateral & transfer to liquidator
        this.stakedCollateral.set(user, pos.stakedCollateral - collateralToSeize);
        const liqColl = this.getUserCollateralBalance(liquidator);
        this.setUserCollateralBalance(liquidator, liqColl + collateralToSeize);
        return {
            txId: `tx_liq_${crypto.randomBytes(8).toString("hex")}`,
            operation: "LIQUIDATE",
            actor: liquidator,
            timestamp: Math.floor(Date.now() / 1000),
            success: true,
            details: {
                targetUser: user,
                debtCovered: actualCover.toString(),
                collateralSeized: collateralToSeize.toString(),
                badDebtShortfall: badDebtShortfall.toString()
            }
        };
    }
    totalGlobalDebtValue() {
        let total = 0n;
        for (const [key, synth] of this.synths.entries()) {
            if (synth.totalSupply > 0n) {
                const price = this.getOraclePrice(key);
                total += (synth.totalSupply * price) / WAD;
            }
        }
        return total;
    }
    calculateUserDebtValue(user) {
        const userShares = this.userDebtShares.get(user) ?? 0n;
        return calculateUserDebtValue(userShares, this.totalDebtShares, this.totalGlobalDebtValue());
    }
    getStakerPosition(user) {
        const staked = this.stakedCollateral.get(user) ?? 0n;
        const userShares = this.userDebtShares.get(user) ?? 0n;
        const debtValue = this.calculateUserDebtValue(user);
        let collValue = 0n;
        let ratioBps = 100000000n;
        if (staked > 0n) {
            const collPrice = this.getOraclePrice("COLLATERAL");
            collValue = (staked * collPrice) / (10n ** BigInt(this.collateralDecimals));
            ratioBps = calculateCollateralRatio(staked, collPrice, debtValue, this.collateralDecimals);
        }
        else if (debtValue > 0n) {
            ratioBps = 0n;
        }
        const isSolvent = ratioBps >= this.minCollateralRatioBps;
        return {
            user,
            stakedCollateral: staked,
            debtShares: userShares,
            debtValueUsd: debtValue,
            collateralValueUsd: collValue,
            collateralRatioBps: ratioBps,
            isSolvent,
            isLiquidatable: !isSolvent && debtValue > 0n
        };
    }
}
