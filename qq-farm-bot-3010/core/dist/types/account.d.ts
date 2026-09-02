export {};
export interface Account {
    id: string;
    name: string;
    code: string;
    platform: string;
    uin: string;
    qq: string;
    avatar: string;
    nick?: string;
    openID?: string;
    openid?: string;
    loginType?: string;
    yybOpenid?: string;
    wxid?: string;
    createdAt: number;
    updatedAt: number;
}
export interface AccountsData {
    accounts: Account[];
    nextId: number;
}
//# sourceMappingURL=account.d.ts.map