import { AdminActionType, SignedAdminIntent } from "./types.js";
export declare class AdminAuthManager {
    private readonly adminPublicKey;
    private readonly chainId;
    private lastNonce;
    constructor(adminPublicKey: string, chainId?: number);
    getExpectedDomain(): string;
    static generateKeyPair(): {
        publicKey: string;
        privateKey: string;
    };
    static canonicalize(obj: any): any;
    static computeParamsHash(params: Record<string, any>): string;
    static computeChallenge(action: AdminActionType, paramsHash: string, nonce: number, deadline: number, domain: string): string;
    static signAdminIntent(action: AdminActionType, params: Record<string, any>, nonce: number, deadline: number, domain: string, privateKeyPem: string): SignedAdminIntent;
    verifyAndConsume(intent: SignedAdminIntent): void;
}
