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

type NowcoderLoginResult = {
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
    ): Promise<NowcoderLoginResult> {
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
            '牛客安全验证',
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

    private getLoginFailureMessage(result: NowcoderLoginResult, fallback = '牛客登录失败'): string {
        const message = result.response.data?.msg || result.response.data?.message;
        return message || `${fallback}，状态码 ${result.response.status}`;
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

    private normalizeSmsAccount(phone: string): string {
        const normalized = phone.trim().replace(/\s+/g, '');
        if (normalized.startsWith('+')) {
            return normalized;
        }
        return `+86${normalized}`;
    }

    private async initLoginCookie(): Promise<string> {
        const response = await axios.get<string>('https://www.nowcoder.com/login', {
            headers: {
                Accept: 'text/html'
            },
            responseType: 'text',
            validateStatus: () => true
        });
        const cookieHeader = this.cookieHeaderFromSetCookie(response.headers['set-cookie']);
        this.debugLogin('login page initialized', {
            status: response.status,
            cookieNames: this.cookieNamesFromHeader(cookieHeader)
        });
        return cookieHeader;
    }

    private getRequestParams(cookieHeader: string): Record<string, string> {
        const params: Record<string, string> = {
            lang: 'Ch'
        };
        const csrfToken = this.getCookieValue(cookieHeader, 'csrf_token');
        if (csrfToken) {
            params.token = csrfToken;
        }
        return params;
    }

    private async postSmsCodeRequest(
        account: string,
        cookieHeader: string,
        neteaseValidate?: string
    ): Promise<NowcoderLoginResult> {
        const body = new URLSearchParams({
            phone: account
        });
        if (neteaseValidate) {
            body.set('netease_validate', neteaseValidate);
        }

        const response = await axios.post<NowcoderResponse>(
            'https://www.nowcoder.com/nccommon/register/validate-phone-v2',
            body.toString(),
            {
                headers: {
                    Cookie: cookieHeader,
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest',
                    langType: 'Ch',
                    Referer: 'https://www.nowcoder.com/login'
                },
                params: this.getRequestParams(cookieHeader),
                validateStatus: () => true
            }
        );

        const setCookie = response.headers['set-cookie'];
        const nextCookieHeader = this.mergeCookieHeaders(
            cookieHeader,
            this.cookieHeaderFromSetCookie(setCookie)
        );
        this.debugLogin('sms code request response', {
            phase: neteaseValidate ? 'retry-with-captcha' : 'initial',
            status: response.status,
            code: response.data?.code,
            msg: response.data?.msg || response.data?.message,
            setCookieNames: this.cookieNamesFromSetCookie(setCookie),
            cookieNames: this.cookieNamesFromHeader(nextCookieHeader)
        });

        return {
            cookieHeader: nextCookieHeader,
            response: {
                status: response.status,
                data: response.data
            }
        };
    }

    private async sendSmsCode(account: string, cookieHeader: string): Promise<string> {
        const firstResult = await this.postSmsCodeRequest(account, cookieHeader);
        if (firstResult.response.data?.code === 0) {
            return firstResult.cookieHeader;
        }

        if (firstResult.response.data?.code !== 1125) {
            throw new Error(this.getLoginFailureMessage(firstResult, '发送手机验证码失败'));
        }

        const captcha = await this.getNeteaseCaptcha(firstResult.cookieHeader);
        const neteaseValidate = await this.showNeteaseCaptcha(captcha.captchaId);
        const retryResult = await this.postSmsCodeRequest(
            account,
            captcha.cookieHeader,
            neteaseValidate
        );
        if (retryResult.response.data?.code !== 0) {
            throw new Error(this.getLoginFailureMessage(retryResult, '发送手机验证码失败'));
        }
        return retryResult.cookieHeader;
    }

    private async postSmsLogin(
        account: string,
        code: string,
        cookieHeader: string
    ): Promise<NowcoderLoginResult> {
        const body = new URLSearchParams({
            account,
            code,
            remember: 'true'
        });

        const response = await axios.post<NowcoderResponse>(
            'https://www.nowcoder.com/nccommon/login-or-register/do',
            body.toString(),
            {
                headers: {
                    Cookie: cookieHeader,
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest',
                    langType: 'Ch',
                    Referer: 'https://www.nowcoder.com/login'
                },
                params: this.getRequestParams(cookieHeader),
                validateStatus: () => true
            }
        );

        const setCookie = response.headers['set-cookie'];
        const nextCookieHeader = this.mergeCookieHeaders(
            cookieHeader,
            this.cookieHeaderFromSetCookie(setCookie)
        );
        const token = this.getCookieValue(nextCookieHeader, 't');
        this.debugLogin('sms login response', {
            status: response.status,
            code: response.data?.code,
            msg: response.data?.msg || response.data?.message,
            setCookieNames: this.cookieNamesFromSetCookie(setCookie),
            cookieNames: this.cookieNamesFromHeader(nextCookieHeader),
            hasToken: Boolean(token)
        });

        return {
            token,
            cookieHeader: nextCookieHeader,
            response: {
                status: response.status,
                data: response.data
            }
        };
    }

    private async loginWithSms(phone: string): Promise<string> {
        const account = this.normalizeSmsAccount(phone);
        const initialCookieHeader = await this.initLoginCookie();
        this.debugLogin('sms login started', {
            accountPrefix: account.slice(0, 3),
            initialCookieNames: this.cookieNamesFromHeader(initialCookieHeader)
        });

        const smsCookieHeader = await this.sendSmsCode(account, initialCookieHeader);
        vscode.window.showInformationMessage('手机验证码已发送，请查收短信。');
        const smsCode = await vscode.window.showInputBox({
            prompt: '验证码已发送，请输入验证码',
            ignoreFocusOut: true,
            password: false
        });
        if (!smsCode) {
            throw new Error('手机验证码不能为空');
        }

        const loginResult = await this.postSmsLogin(account, smsCode.trim(), smsCookieHeader);
        const token = loginResult.token;
        if (!token) {
            throw new Error(this.getLoginFailureMessage(loginResult, '手机验证码登录失败'));
        }
        return token;
    }

    async createSession(scopes: string[]): Promise<vscode.AuthenticationSession> {
        const loginMode = await vscode.window.showQuickPick([
            {
                label: 'Cookie 登录',
            },
            {
                label: '账号密码登录',
            },
            {
                label: '手机验证码登录',
            }
        ], {
            placeHolder: '选择牛客登录方式'
        });

        if (!loginMode) {
            throw new Error('已取消登录');
        }

        var token;
        if (loginMode.label === '账号密码登录') {
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
        } else if (loginMode.label === '手机验证码登录') {
            const phone = await vscode.window.showInputBox({
                prompt: '请输入牛客绑定手机号',
                ignoreFocusOut: true
            });
            if (!phone) {
                throw new Error('手机号不能为空');
            }
            if (phone.length != 11 || phone[0] != '1') {
                throw new Error('手机号码必须是11位中国大陆手机号');
            }

            try {
                token = await this.loginWithSms(phone);
            } catch (error) {
                this.outputChannel.show(true);
                throw error;
            }
        } else {
            const cookieStr = await vscode.window.showInputBox({
                prompt: "请输入Cookie,具体方法见插件详情",
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
        token = token.replaceAll('\'', '').replaceAll('"', '');
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
