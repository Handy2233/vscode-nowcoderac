import * as vscode from 'vscode';
import axios from 'axios';
import { constants, publicEncrypt } from 'crypto';

type NowcoderResponse<T = unknown> = {
    code?: number;
    msg?: string;
    message?: string;
    data?: T;
};

type NowcoderEnvironmentConfig = {
    rsaPublicKey?: string;
};

type NowcoderCaptchaConfig = {
    captchaId?: string;
};

type NowcoderPasswordLoginResult = {
    token?: string;
    cookieHeader: string;
    response: {
        status: number;
        data: NowcoderResponse;
    };
};

type NowcoderCaptchaResult = {
    captchaId: string;
    cookieHeader: string;
};

export class NowcoderAuthenticationProvider implements vscode.AuthenticationProvider {
    private readonly sessionChangeEmitter = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
    private readonly outputChannel = vscode.window.createOutputChannel('NowCoderAC Login');
    static readonly id = 'nowcoderac-token';

    onDidChangeSessions = this.sessionChangeEmitter.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    async getSessions(scopes?: string[]): Promise<vscode.AuthenticationSession[]> {
        const token = await this.context.secrets.get(NowcoderAuthenticationProvider.id);
        if (!token) {
            return [];
        }
        return [this.token2Session(token)];
    }

    private async fetchCurrentUserName(token: string): Promise<string | undefined> {
        try {
            const response = await axios.get<string>('https://ac.nowcoder.com/acm/contest/vip-index', {
                headers: {
                    Cookie: `t=${token}`,
                    Accept: 'text/html'
                },
                responseType: 'text'
            });

            return response.data.match(/ownerName:\s*['"]([^'"]+)['"]/)?.[1];
        } catch (error) {
            console.error('Error fetching NowCoder user name:', error);
            return undefined;
        }
    }

    private cookieHeaderFromSetCookie(setCookie: string[] | undefined): string {
        if (!setCookie) {
            return '';
        }
        return setCookie
            .map(cookie => cookie.split(';')[0])
            .filter(Boolean)
            .join('; ');
    }

    private cookieNamesFromHeader(cookieHeader: string): string[] {
        if (!cookieHeader) {
            return [];
        }
        return cookieHeader
            .split(';')
            .map(cookie => cookie.trim().split('=')[0])
            .filter(Boolean);
    }

    private cookieNamesFromSetCookie(setCookie: string[] | undefined): string[] {
        return this.cookieNamesFromHeader(this.cookieHeaderFromSetCookie(setCookie));
    }

    private mergeCookieHeaders(...cookieHeaders: string[]): string {
        const cookieMap: { [key: string]: string } = {};
        for (const cookieHeader of cookieHeaders) {
            for (const cookie of cookieHeader.split(';')) {
                const [key, ...valueParts] = cookie.trim().split('=');
                if (key && valueParts.length > 0) {
                    cookieMap[key] = valueParts.join('=');
                }
            }
        }
        return Object.entries(cookieMap)
            .map(([key, value]) => `${key}=${value}`)
            .join('; ');
    }

    private debugLogin(message: string, details?: Record<string, unknown>): void {
        const suffix = details ? ` ${JSON.stringify(details)}` : '';
        this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}${suffix}`);
    }

    private getCookieValue(cookieHeader: string, key: string): string | undefined {
        return cookieHeader
            .split(';')
            .map(cookie => cookie.trim())
            .find(cookie => cookie.startsWith(`${key}=`))
            ?.slice(key.length + 1);
    }

    private normalizeRsaPublicKey(publicKey: string): string {
        const key = publicKey.replace(/\s+/g, '');
        const lines = key.match(/.{1,64}/g)?.join('\n') ?? key;
        return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
    }

    private encryptPassword(password: string, publicKey: string): string {
        return publicEncrypt(
            {
                key: this.normalizeRsaPublicKey(publicKey),
                padding: constants.RSA_PKCS1_PADDING
            },
            Buffer.from(password)
        ).toString('base64');
    }

    private async postPasswordLogin(
        account: string,
        cipherPwd: string,
        cookieHeader: string,
        neteaseValidate?: string
    ): Promise<NowcoderPasswordLoginResult> {
        const body = new URLSearchParams({
            account,
            cipherPwd,
            remember: 'true',
            source: '3'
        });
        if (neteaseValidate) {
            body.set('netease_validate', neteaseValidate);
        }

        const loginResponse = await axios.post<NowcoderResponse>(
            'https://www.nowcoder.com/login-or-register/do',
            body.toString(),
            {
                headers: {
                    Cookie: cookieHeader,
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest',
                    langType: 'Ch',
                    Referer: 'https://www.nowcoder.com/login'
                },
                validateStatus: () => true
            }
        );

        const setCookie = loginResponse.headers['set-cookie'];
        const nextCookieHeader = this.mergeCookieHeaders(
            cookieHeader,
            this.cookieHeaderFromSetCookie(setCookie)
        );
        const token = this.getCookieValue(nextCookieHeader, 't');
        this.debugLogin('password login response', {
            phase: neteaseValidate ? 'retry-with-captcha' : 'initial',
            bodyType: 'urlencoded',
            status: loginResponse.status,
            code: loginResponse.data?.code,
            msg: loginResponse.data?.msg || loginResponse.data?.message,
            setCookieNames: this.cookieNamesFromSetCookie(setCookie),
            cookieNames: this.cookieNamesFromHeader(nextCookieHeader),
            hasToken: Boolean(token)
        });
        return {
            token,
            cookieHeader: nextCookieHeader,
            response: {
                status: loginResponse.status,
                data: loginResponse.data
            }
        };
    }

    private async getNeteaseCaptcha(cookieHeader: string): Promise<NowcoderCaptchaResult> {
        const captchaResponse = await axios.get<NowcoderResponse<NowcoderCaptchaConfig>>(
            'https://www.nowcoder.com/captcha/geetest/login',
            {
                headers: {
                    Cookie: cookieHeader,
                    Referer: 'https://www.nowcoder.com/login',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                params: {
                    source: 'netease',
                    t: Date.now()
                },
                validateStatus: () => true
            }
        );

        const setCookie = captchaResponse.headers['set-cookie'];
        const nextCookieHeader = this.mergeCookieHeaders(
            cookieHeader,
            this.cookieHeaderFromSetCookie(setCookie)
        );
        const captchaId = captchaResponse.data.data?.captchaId;
        this.debugLogin('captcha config response', {
            status: captchaResponse.status,
            code: captchaResponse.data?.code,
            msg: captchaResponse.data?.msg || captchaResponse.data?.message,
            setCookieNames: this.cookieNamesFromSetCookie(setCookie),
            cookieNames: this.cookieNamesFromHeader(nextCookieHeader),
            hasCaptchaId: Boolean(captchaId)
        });
        if (!captchaId) {
            throw new Error(captchaResponse.data.msg || captchaResponse.data.message || '获取牛客验证码配置失败');
        }
        return {
            captchaId,
            cookieHeader: nextCookieHeader
        };
    }

    private createNonce(): string {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let nonce = '';
        for (let i = 0; i < 32; i++) {
            nonce += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return nonce;
    }

    private async getCaptchaWebviewHtml(webview: vscode.Webview, captchaId: string): Promise<string> {
        const nonce = this.createNonce();
        const captchaIdJson = JSON.stringify(captchaId).replace(/</g, '\\u003c');
        const iconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'icon.png'));
        const templateUri = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'nowcoderCaptcha.html');
        const template = Buffer.from(await vscode.workspace.fs.readFile(templateUri)).toString('utf8');
        const replacements: { [key: string]: string } = {
            captchaId: captchaIdJson,
            cspSource: webview.cspSource,
            iconUri: iconUri.toString(),
            nonce
        };

        return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => replacements[key] ?? match);
    }

    private async showNeteaseCaptcha(captchaId: string): Promise<string> {
        const panel = vscode.window.createWebviewPanel(
            'nowcoderCaptcha',
            '牛客验证码',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.context.extensionUri, 'resources')
                ]
            }
        );

        panel.webview.html = await this.getCaptchaWebviewHtml(panel.webview, captchaId);

        return new Promise<string>((resolve, reject) => {
            let settled = false;
            const disposables: vscode.Disposable[] = [];

            const finish = (callback: () => void) => {
                if (settled) {
                    return;
                }
                settled = true;
                for (const disposable of disposables) {
                    disposable.dispose();
                }
                callback();
                panel.dispose();
            };

            disposables.push(panel.webview.onDidReceiveMessage((message: { type?: string; validate?: string; message?: string }) => {
                if (message.type === 'captchaSuccess' && message.validate) {
                    this.debugLogin('captcha solved', {
                        validateLength: message.validate.length
                    });
                    finish(() => resolve(message.validate as string));
                } else if (message.type === 'captchaError') {
                    this.debugLogin('captcha webview error', {
                        message: message.message
                    });
                    vscode.window.showWarningMessage(message.message || '牛客验证码加载失败');
                }
            }));

            disposables.push(panel.onDidDispose(() => {
                if (!settled) {
                    settled = true;
                    for (const disposable of disposables) {
                        disposable.dispose();
                    }
                    reject(new Error('已取消验证码验证'));
                }
            }));
        });
    }

    private getLoginFailureMessage(result: NowcoderPasswordLoginResult): string {
        const message = result.response.data?.msg || result.response.data?.message;
        return message || `牛客密码登录失败，状态码 ${result.response.status}`;
    }

    private async loginWithPassword(account: string, password: string): Promise<string> {
        const configResponse = await axios.get<NowcoderResponse<NowcoderEnvironmentConfig>>(
            'https://www.nowcoder.com/environment/config'
        );
        const publicKey = configResponse.data.data?.rsaPublicKey;
        if (!publicKey) {
            throw new Error('获取牛客登录公钥失败');
        }

        const cipherPwd = this.encryptPassword(password, publicKey);
        const cookieHeader = this.cookieHeaderFromSetCookie(configResponse.headers['set-cookie']);
        this.debugLogin('password login started', {
            initialCookieNames: this.cookieNamesFromHeader(cookieHeader)
        });
        const firstResult = await this.postPasswordLogin(account, cipherPwd, cookieHeader);
        if (firstResult.token) {
            return firstResult.token;
        }

        if (firstResult.response.data?.code !== 1125) {
            throw new Error(this.getLoginFailureMessage(firstResult));
        }

        const captcha = await this.getNeteaseCaptcha(firstResult.cookieHeader);
        const neteaseValidate = await this.showNeteaseCaptcha(captcha.captchaId);
        const retryResult = await this.postPasswordLogin(
            account,
            cipherPwd,
            captcha.cookieHeader,
            neteaseValidate
        );

        const token = retryResult.token;
        if (!token) {
            throw new Error(this.getLoginFailureMessage(retryResult));
        }
        return token;
    }

    async createSession(scopes: string[]): Promise<vscode.AuthenticationSession> {
        const loginMode = await vscode.window.showQuickPick([
            {
                label: 'Cookie 登录',
                description: '稳定方式，粘贴 t 或完整 Cookie'
            },
            {
                label: '实验性账号密码登录',
                description: '模拟牛客网页登录接口，可能被验证码或风控拦截'
            }
        ], {
            placeHolder: '选择牛客登录方式'
        });

        if (!loginMode) {
            throw new Error('已取消登录');
        }

        var token;
        if (loginMode.label === '实验性账号密码登录') {
            const account = await vscode.window.showInputBox({
                prompt: '请输入牛客账号/手机号/邮箱',
                ignoreFocusOut: true
            });
            if (!account) {
                throw new Error('账号不能为空');
            }

            const password = await vscode.window.showInputBox({
                prompt: '请输入牛客密码',
                ignoreFocusOut: true,
                password: true
            });
            if (!password) {
                throw new Error('密码不能为空');
            }

            try {
                token = await this.loginWithPassword(account, password);
            } catch (error) {
                this.outputChannel.show(true);
                throw error;
            }
        } else {
            const cookieStr = await vscode.window.showInputBox({
                prompt: "请输入cookie,具体方法见插件详情",
                ignoreFocusOut: true,
                password: false
            });

            if (!cookieStr) {
                throw new Error('Cookie不能为空');
            }

            if (cookieStr.indexOf('=') === -1) {
                token = cookieStr;
            } else {
                const cookieParts = cookieStr.split(';').map(part => part.split('='));
                const cookieObj: { [key: string]: string } = {};
                for (const [key, value] of cookieParts) {
                    cookieObj[key.trim()] = value.trim();
                }
                token = cookieObj['t'];
            }
        }
        if (!token) {
            throw new Error('无效的cookie/token值');
        }
        token.replaceAll('\'', '');
        token.replaceAll('"', '');
        const userName = await this.fetchCurrentUserName(token);

        const session: vscode.AuthenticationSession = {
            id: Date.now().toString(),
            accessToken: token,
            account: {
                label: userName ?? 'NowCoder User',
                id: Date.now().toString()
            },
            scopes: []
        };

        this.sessionChangeEmitter.fire({
            added: [session],
            removed: [],
            changed: []
        });

        await this.context.secrets.store(NowcoderAuthenticationProvider.id, token);
        return session;
    }

    async removeSession(sessionId: string): Promise<void> {
        const token = await this.context.secrets.get(NowcoderAuthenticationProvider.id);
        if (!token) {
            return;
        }
        await this.context.secrets.delete(NowcoderAuthenticationProvider.id);
        const session = this.token2Session(token);
        this.sessionChangeEmitter.fire({
            added: [],
            removed: [session],
            changed: []
        });
    }

    private token2Session(token: string): vscode.AuthenticationSession {
        return {
            id: NowcoderAuthenticationProvider.id,
            accessToken: token,
            account: {
                label: NowcoderAuthenticationProvider.id,
                id: NowcoderAuthenticationProvider.id
            },
            scopes: []
        };
    }

    static async clearToken(context: vscode.ExtensionContext) {
        await context.secrets.delete(NowcoderAuthenticationProvider.id);
    };
}
