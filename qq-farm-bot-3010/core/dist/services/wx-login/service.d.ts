export type ScanStatus = 'waiting' | 'scanned' | 'authorized' | 'cancelled' | 'expired';
export interface WxLoginSession {
    cookies: Map<string, string>;
    uuid: string;
    oauthCode?: string;
    openid?: string;
    loginBuffer?: string;
}
export declare class WxLoginService {
    createQrSession(): Promise<{
        session: WxLoginSession;
        qr: Buffer;
    }>;
    poll(session: WxLoginSession): Promise<ScanStatus>;
    confirm(session: WxLoginSession): Promise<{
        openid: string;
        loginBuffer: string;
    }>;
    issueCode(session: WxLoginSession, appId: string): Promise<string>;
    destroy(session: WxLoginSession): void;
}
//# sourceMappingURL=service.d.ts.map