import * as vscode from 'vscode';

const AUTH_PROVIDER_ID = 'nowcoderac';

function isCancellationError(error: unknown): boolean {
    if (error instanceof vscode.CancellationError) {
        return true;
    }
    if (!(error instanceof Error)) {
        return false;
    }
    return error.name === 'Canceled' || error.message === 'Canceled';
}

class LoginPromptCoordinator {
    private missingLoginPromptUsed = false;
    private promptInFlight: Promise<vscode.AuthenticationSession | undefined> | undefined;

    /**
     * 获取请求可用的登录态；未登录时只允许被动检测触发一次登录提示。
     *
     * @returns 已登录会话；用户取消或已经提示过时返回 undefined。
     */
    async getSessionForRequest(): Promise<vscode.AuthenticationSession | undefined> {
        const session = await this.getExistingSession();
        if (session) {
            return session;
        }

        if (this.missingLoginPromptUsed) {
            return undefined;
        }

        this.missingLoginPromptUsed = true;
        return this.showLoginPrompt();
    }

    /**
     * 用户主动打开插件视图时，重新给一次未登录提示机会。
     *
     * @returns 登录提示完成后 resolve；用户取消时静默返回。
     */
    async promptAfterPluginOpen(): Promise<void> {
        const session = await this.getExistingSession();
        if (session) {
            return;
        }

        this.missingLoginPromptUsed = false;
        await this.getSessionForRequest();
    }

    /**
     * 显式登录命令始终直接打开登录流程。
     *
     * @returns 登录成功后的会话；用户取消时返回 undefined。
     */
    async promptForManualLogin(): Promise<vscode.AuthenticationSession | undefined> {
        this.missingLoginPromptUsed = false;
        return this.showLoginPrompt();
    }

    reset(): void {
        this.missingLoginPromptUsed = false;
    }

    private async getExistingSession(): Promise<vscode.AuthenticationSession | undefined> {
        return vscode.authentication.getSession(AUTH_PROVIDER_ID, [], { silent: true });
    }

    private async showLoginPrompt(): Promise<vscode.AuthenticationSession | undefined> {
        if (!this.promptInFlight) {
            this.promptInFlight = this.createLoginPrompt();
        }

        try {
            return await this.promptInFlight;
        } finally {
            this.promptInFlight = undefined;
        }
    }

    private async createLoginPrompt(): Promise<vscode.AuthenticationSession | undefined> {
        try {
            return await vscode.authentication.getSession(AUTH_PROVIDER_ID, [], {
                createIfNone: true,
                clearSessionPreference: true
            });
        } catch (error) {
            if (isCancellationError(error)) {
                return undefined;
            }
            throw error;
        }
    }
}

export const loginPromptCoordinator = new LoginPromptCoordinator();
