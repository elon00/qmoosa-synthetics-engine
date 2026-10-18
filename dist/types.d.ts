export * from "./math.js";
export interface SynthConfig {
    currencyKey: string;
    name: string;
    symbol: string;
    priceWad: bigint;
    totalSupply: bigint;
    updatedAt: number;
}
export interface OraclePriceFeed {
    priceWad: bigint;
    updatedAt: number;
}
export interface StakerPosition {
    user: string;
    stakedCollateral: bigint;
    debtShares: bigint;
    debtValueUsd: bigint;
    collateralValueUsd: bigint;
    collateralRatioBps: bigint;
    isSolvent: boolean;
    isLiquidatable: boolean;
}
export interface ExchangeQuote {
    sourceCurrencyKey: string;
    sourceAmount: bigint;
    destCurrencyKey: string;
    destAmount: bigint;
    feeUsd: bigint;
    effectiveRateWad: bigint;
}
export type AdminActionType = "SET_ORACLE_PRICE" | "OVERRIDE_ORACLE_PRICE" | "REGISTER_SYNTH" | "SET_MIN_COLLATERAL_RATIO" | "SET_EXCHANGE_FEE";
export interface SignedAdminIntent {
    action: AdminActionType;
    params: Record<string, any>;
    nonce: number;
    deadline: number;
    domain: string;
    signature: string;
}
export interface SyntheticsOperationResult {
    txId: string;
    operation: "STAKE" | "UNSTAKE" | "ISSUE" | "BURN" | "EXCHANGE" | "LIQUIDATE";
    actor: string;
    timestamp: number;
    success: boolean;
    details: Record<string, any>;
}
