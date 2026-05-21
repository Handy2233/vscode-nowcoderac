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

type NowcoderWechatQrCodeConfig = {
    ticket?: string;
    imageUrl?: string;
    expireSecond?: number;
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

type NowcoderWechatQrCodeResult = {
    ticket: string;
    imageUrl: string;
    expireSecond: number;
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

    private getErrorMessage(error: unknown): string {
        const message = error instanceof Error ? error.message : String(error);
        return message || '牛客登录失败';
    }

    private showLoginError(message: string): void {
        void vscode.window.showErrorMessage(message);
    }

    private showLoginWarning(message: string): void {
        void vscode.window.showWarningMessage(message);
    }

    private cancelLogin(): never {
        throw new vscode.CancellationError();
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

    private async getNeteaseCaptcha(cookieHeader: string): Promise<NowcoderCaptchaResult | undefined> {
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
            this.showLoginError(captchaResponse.data.msg || captchaResponse.data.message || '获取牛客验证码配置失败');
            return undefined;
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

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
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
                    reject(new vscode.CancellationError());
                }
            }));
        });
    }

    private escapeHtml(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    private async getWechatQrCodeWebviewHtml(webview: vscode.Webview, imageUrl: string, expireSecond: number): Promise<string> {
        const iconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'icon.png'));
        const templateUri = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'nowcoderWechatLogin.html');
        const template = Buffer.from(await vscode.workspace.fs.readFile(templateUri)).toString('utf8');
        const replacements: { [key: string]: string } = {
            cspSource: webview.cspSource,
            iconUri: this.escapeHtml(iconUri.toString()),
            imageUrl: this.escapeHtml(imageUrl),
            expireSecond: this.escapeHtml(expireSecond.toString())
        };

        return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => replacements[key] ?? match);
    }

    private async getWechatQrCode(cookieHeader: string): Promise<NowcoderWechatQrCodeResult | undefined> {
        const response = await axios.get<NowcoderResponse<NowcoderWechatQrCodeConfig>>(
            'https://www.nowcoder.com/oauth2/login/wechat_qr_code',
            {
                headers: {
                    Cookie: cookieHeader,
                    Referer: 'https://www.nowcoder.com/login',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                validateStatus: () => true
            }
        );

        const setCookie = response.headers['set-cookie'];
        const nextCookieHeader = this.mergeCookieHeaders(
            cookieHeader,
            this.cookieHeaderFromSetCookie(setCookie)
        );
        const ticket = response.data.data?.ticket;
        const imageUrl = response.data.data?.imageUrl;
        const expireSecond = response.data.data?.expireSecond ?? 120;
        this.debugLogin('wechat qr code response', {
            status: response.status,
            code: response.data?.code,
            msg: response.data?.msg || response.data?.message,
            setCookieNames: this.cookieNamesFromSetCookie(setCookie),
            cookieNames: this.cookieNamesFromHeader(nextCookieHeader),
            hasTicket: Boolean(ticket),
            hasImageUrl: Boolean(imageUrl),
            expireSecond
        });

        if (response.data.code !== 0 || !ticket || !imageUrl) {
            this.showLoginError(response.data.msg || response.data.message || '获取微信登录二维码失败');
            return undefined;
        }

        return {
            ticket,
            imageUrl,
            expireSecond,
            cookieHeader: nextCookieHeader
        };
    }

    private async pollWechatLoginStatus(ticket: string, cookieHeader: string): Promise<NowcoderLoginResult> {
        const response = await axios.get<NowcoderResponse>(
            'https://www.nowcoder.com/oauth2/login/wechat_mp_status',
            {
                headers: {
                    Cookie: cookieHeader,
                    Referer: 'https://www.nowcoder.com/oauth2/login/wechat_mp_index',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                params: {
                    ticket
                },
                validateStatus: () => true
            }
        );

        const setCookie = response.headers['set-cookie'];
        const nextCookieHeader = this.mergeCookieHeaders(
            cookieHeader,
            this.cookieHeaderFromSetCookie(setCookie)
        );
        const token = this.getCookieValue(nextCookieHeader, 't');
        this.debugLogin('wechat login status response', {
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

    private async loginWithWechat(): Promise<string | undefined> {
        const initialCookieHeader = await this.initLoginCookie();
        const qrCode = await this.getWechatQrCode(initialCookieHeader);
        if (!qrCode) {
            return undefined;
        }
        const panel = vscode.window.createWebviewPanel(
            'nowcoderWechatLogin',
            '牛客微信扫码登录',
            vscode.ViewColumn.Active,
            {
                enableScripts: false,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.context.extensionUri, 'resources')
                ]
            }
        );

        panel.webview.html = await this.getWechatQrCodeWebviewHtml(
            panel.webview,
            qrCode.imageUrl,
            qrCode.expireSecond
        );

        let disposed = false;
        const disposeListener = panel.onDidDispose(() => {
            disposed = true;
        });

        try {
            let cookieHeader = qrCode.cookieHeader;
            const deadline = Date.now() + qrCode.expireSecond * 1000;
            while (!disposed && Date.now() < deadline) {
                await this.delay(3000);
                if (disposed) {
                    break;
                }

                const result = await this.pollWechatLoginStatus(qrCode.ticket, cookieHeader);
                cookieHeader = result.cookieHeader;
                if (result.token) {
                    panel.dispose();
                    return result.token;
                }
                if (result.response.data?.code !== 1) {
                    this.showLoginError(this.getLoginFailureMessage(result, '微信扫码登录失败'));
                    return undefined;
                }
            }

            if (disposed) {
                return this.cancelLogin();
            }
            this.showLoginWarning('微信登录二维码已过期，请重新登录');
            return undefined;
        } finally {
            disposeListener.dispose();
            if (!disposed) {
                panel.dispose();
            }
        }
    }

    private getLoginFailureMessage(result: NowcoderLoginResult, fallback = '牛客登录失败'): string {
        const message = result.response.data?.msg || result.response.data?.message;
        return message || `${fallback}，状态码 ${result.response.status}`;
    }

    private async loginWithPassword(account: string, password: string): Promise<string | undefined> {
        const configResponse = await axios.get<NowcoderResponse<NowcoderEnvironmentConfig>>(
            'https://www.nowcoder.com/environment/config'
        );
        const publicKey = configResponse.data.data?.rsaPublicKey;
        if (!publicKey) {
            this.showLoginError('获取牛客登录公钥失败');
            return undefined;
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
            this.showLoginError(this.getLoginFailureMessage(firstResult));
            return undefined;
        }

        const captcha = await this.getNeteaseCaptcha(firstResult.cookieHeader);
        if (!captcha) {
            return undefined;
        }
        const neteaseValidate = await this.showNeteaseCaptcha(captcha.captchaId);
        const retryResult = await this.postPasswordLogin(
            account,
            cipherPwd,
            captcha.cookieHeader,
            neteaseValidate
        );

        const token = retryResult.token;
        if (!token) {
            this.showLoginError(this.getLoginFailureMessage(retryResult));
            return undefined;
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

    private async sendSmsCode(account: string, cookieHeader: string): Promise<string | undefined> {
        const firstResult = await this.postSmsCodeRequest(account, cookieHeader);
        if (firstResult.response.data?.code === 0) {
            return firstResult.cookieHeader;
        }

        if (firstResult.response.data?.code !== 1125) {
            this.showLoginError(this.getLoginFailureMessage(firstResult, '发送手机验证码失败'));
            return undefined;
        }

        const captcha = await this.getNeteaseCaptcha(firstResult.cookieHeader);
        if (!captcha) {
            return undefined;
        }
        const neteaseValidate = await this.showNeteaseCaptcha(captcha.captchaId);
        const retryResult = await this.postSmsCodeRequest(
            account,
            captcha.cookieHeader,
            neteaseValidate
        );
        if (retryResult.response.data?.code !== 0) {
            this.showLoginError(this.getLoginFailureMessage(retryResult, '发送手机验证码失败'));
            return undefined;
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

    private async loginWithSms(phone: string): Promise<string | undefined> {
        const account = this.normalizeSmsAccount(phone);
        const initialCookieHeader = await this.initLoginCookie();
        this.debugLogin('sms login started', {
            accountPrefix: account.slice(0, 3),
            initialCookieNames: this.cookieNamesFromHeader(initialCookieHeader)
        });

        const smsCookieHeader = await this.sendSmsCode(account, initialCookieHeader);
        if (!smsCookieHeader) {
            return undefined;
        }
        vscode.window.showInformationMessage('手机验证码已发送，请查收短信。');
        while (true) {
            const smsCode = await vscode.window.showInputBox({
                prompt: '验证码已发送，请输入验证码',
                ignoreFocusOut: true,
                password: false
            });
            if (smsCode === undefined) {
                return this.cancelLogin();
            }
            if (!smsCode.trim()) {
                this.showLoginError('手机验证码不能为空');
                continue;
            }

            const loginResult = await this.postSmsLogin(account, smsCode.trim(), smsCookieHeader);
            const token = loginResult.token;
            if (!token) {
                this.showLoginError(this.getLoginFailureMessage(loginResult, '手机验证码登录失败'));
                continue;
            }
            return token;
        }
    }

    private async handleLoginAttemptError(error: unknown): Promise<void> {
        if (error instanceof vscode.CancellationError) {
            throw error;
        }
        this.outputChannel.show(true);
        this.showLoginError(this.getErrorMessage(error));
    }

    private async promptPasswordLogin(): Promise<string> {
        while (true) {
            const account = await vscode.window.showInputBox({
                prompt: '请输入牛客账号/手机号/邮箱',
                ignoreFocusOut: true
            });
            if (account === undefined) {
                return this.cancelLogin();
            }
            if (!account.trim()) {
                this.showLoginError('账号不能为空');
                continue;
            }

            while (true) {
                const password = await vscode.window.showInputBox({
                    prompt: '请输入牛客密码',
                    ignoreFocusOut: true,
                    password: true
                });
                if (password === undefined) {
                    return this.cancelLogin();
                }
                if (!password) {
                    this.showLoginError('密码不能为空');
                    continue;
                }

                try {
                    const token = await this.loginWithPassword(account.trim(), password);
                    if (token) {
                        return token;
                    }
                } catch (error) {
                    await this.handleLoginAttemptError(error);
                }
                break;
            }
        }
    }

    private async promptSmsLogin(): Promise<string> {
        while (true) {
            const phone = await vscode.window.showInputBox({
                prompt: '请输入牛客绑定手机号',
                ignoreFocusOut: true
            });
            if (phone === undefined) {
                return this.cancelLogin();
            }
            const normalizedPhone = phone.trim();
            if (!normalizedPhone) {
                this.showLoginError('手机号不能为空');
                continue;
            }
            if (normalizedPhone.length != 11 || normalizedPhone[0] != '1') {
                this.showLoginError('手机号码必须是11位中国大陆手机号');
                continue;
            }

            try {
                const token = await this.loginWithSms(normalizedPhone);
                if (token) {
                    return token;
                }
            } catch (error) {
                await this.handleLoginAttemptError(error);
            }
        }
    }

    private async promptWechatLogin(): Promise<string> {
        while (true) {
            try {
                const token = await this.loginWithWechat();
                if (token) {
                    return token;
                }
            } catch (error) {
                await this.handleLoginAttemptError(error);
            }
        }
    }

    private async promptCookieLogin(): Promise<string> {
        while (true) {
            const cookieStr = await vscode.window.showInputBox({
                prompt: "请输入Cookie,具体方法见插件详情",
                ignoreFocusOut: true,
                password: false
            });

            if (cookieStr === undefined) {
                return this.cancelLogin();
            }
            if (!cookieStr.trim()) {
                this.showLoginError('Cookie不能为空');
                continue;
            }

            let token: string | undefined;
            if (cookieStr.indexOf('=') === -1) {
                token = cookieStr.trim();
            } else {
                const cookieParts = cookieStr.split(';').map(part => part.split('='));
                const cookieObj: { [key: string]: string } = {};
                for (const [key, value] of cookieParts) {
                    if (key && value) {
                        cookieObj[key.trim()] = value.trim();
                    }
                }
                token = cookieObj['t'];
            }

            if (!token) {
                this.showLoginError('无效的cookie/token值');
                continue;
            }
            return token;
        }
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
            },
            {
                label: '微信扫码登录',
            }
        ], {
            placeHolder: '选择牛客登录方式'
        });

        if (!loginMode) {
            return this.cancelLogin();
        }

        let token: string;
        if (loginMode.label === '账号密码登录') {
            token = await this.promptPasswordLogin();
        } else if (loginMode.label === '手机验证码登录') {
            token = await this.promptSmsLogin();
        } else if (loginMode.label === '微信扫码登录') {
            token = await this.promptWechatLogin();
        } else {
            token = await this.promptCookieLogin();
        }
        token = token.trim().replaceAll('\'', '').replaceAll('"', '');
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
