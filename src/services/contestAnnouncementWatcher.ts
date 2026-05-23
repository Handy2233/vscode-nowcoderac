import * as vscode from 'vscode';
import { ContestMessage } from '../models/models';
import { nowcoderService } from './nowcoderService';
import { ContestService } from './contestService';
import { ContestSpaceManager } from './contestSpaceManager';

const ANNOUNCEMENT_TYPE = '3';
const POLL_INTERVAL_MS = 8000;
const MESSAGE_PAGE_SIZE = 50;
const ANNOUNCEMENT_TITLE = '赛时公告';

export class ContestAnnouncementWatcher implements vscode.Disposable {
    private readonly contestSpaceChangedDisposable: vscode.Disposable;
    private readonly seenMessageIds = new Set<number>();

    private timer: NodeJS.Timeout | undefined;
    private currentService: ContestService | undefined;
    private currentContestId: number | undefined;
    private currentUid: number | undefined;
    private lastMessageId = -1;
    private pollInFlightVersion: number | undefined;
    private disposed = false;
    private bindVersion = 0;

    constructor(
        private readonly context: vscode.ExtensionContext,
        contestSpaceManager: ContestSpaceManager
    ) {
        this.contestSpaceChangedDisposable = contestSpaceManager.onContestSpaceChanged((contestService) => {
            this.rebind(contestService);
        });
        this.rebind(contestSpaceManager.getContestService());
    }

    dispose(): void {
        this.disposed = true;
        this.stop();
        this.contestSpaceChangedDisposable.dispose();
    }

    private async rebind(contestService: ContestService | undefined): Promise<void> {
        const version = ++this.bindVersion;
        this.stop();
        this.currentService = contestService;
        this.seenMessageIds.clear();

        if (!contestService) {
            return;
        }

        const contestId = contestService.getConfig().contestId;
        const userResult = await nowcoderService.getCurrentAcmUser();
        if (this.disposed || version !== this.bindVersion || this.currentService !== contestService) {
            return;
        }

        if (!userResult.success || !userResult.data) {
            return;
        }

        this.currentContestId = contestId;
        this.currentUid = userResult.data.uid;
        const initialMessageId = await this.loadInitialMessageId(contestId, userResult.data.uid);
        if (this.disposed || version !== this.bindVersion || this.currentService !== contestService) {
            return;
        }
        if (initialMessageId === undefined) {
            return;
        }
        this.lastMessageId = initialMessageId;

        await this.poll(version);
        this.timer = setInterval(() => {
            void this.poll(version);
        }, POLL_INTERVAL_MS);
    }

    private stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.pollInFlightVersion = undefined;
        this.currentContestId = undefined;
        this.currentUid = undefined;
        this.lastMessageId = -1;
    }

    private async loadInitialMessageId(contestId: number, uid: number): Promise<number | undefined> {
        const stateKey = this.stateKey(contestId, uid);
        const persistedMessageId = this.context.workspaceState.get<number>(stateKey);
        if (typeof persistedMessageId === 'number') {
            return persistedMessageId;
        }

        const messagesResult = await nowcoderService.getContestMessages(contestId, uid, -1, 1, MESSAGE_PAGE_SIZE);
        if (!messagesResult.success || !messagesResult.data) {
            return undefined;
        }

        const newestMessageId = this.getNewestMessageId(messagesResult.data.messages);
        await this.persistLastMessageId(contestId, uid, newestMessageId);
        return newestMessageId;
    }

    private async poll(version: number): Promise<void> {
        if (this.pollInFlightVersion === version || !this.currentContestId || !this.currentUid) {
            return;
        }

        this.pollInFlightVersion = version;
        try {
            const contestId = this.currentContestId;
            const uid = this.currentUid;
            const pingResult = await nowcoderService.pingContestMessages(contestId, uid, this.lastMessageId);
            if (this.disposed || version !== this.bindVersion) {
                return;
            }
            if (!pingResult.success || !pingResult.data) {
                return;
            }
            if (pingResult.data.stopPing) {
                this.stop();
                return;
            }
            if (pingResult.data.newMsgCount <= 0) {
                return;
            }

            await this.syncMessages(contestId, uid, version);
        } finally {
            if (this.pollInFlightVersion === version) {
                this.pollInFlightVersion = undefined;
            }
        }
    }

    private async syncMessages(contestId: number, uid: number, version: number): Promise<void> {
        const messagesResult = await nowcoderService.getContestMessages(contestId, uid, -1, 1, MESSAGE_PAGE_SIZE);
        if (this.disposed || version !== this.bindVersion) {
            return;
        }
        if (!messagesResult.success || !messagesResult.data) {
            return;
        }

        const messages = [...messagesResult.data.messages].sort((a, b) => Number(a.id) - Number(b.id));
        for (const message of messages) {
            const messageId = Number(message.id);
            if (!Number.isFinite(messageId) || messageId <= this.lastMessageId) {
                continue;
            }

            this.lastMessageId = Math.max(this.lastMessageId, messageId);
            await this.persistLastMessageId(contestId, uid, this.lastMessageId);

            if (String(message.type) !== ANNOUNCEMENT_TYPE || this.seenMessageIds.has(messageId)) {
                continue;
            }

            this.seenMessageIds.add(messageId);
            await this.showAnnouncement(message, version);
        }
    }

    private async showAnnouncement(message: ContestMessage, version: number): Promise<void> {
        const content = this.normalizeMessageContent(message.content);
        if (!this.disposed && version === this.bindVersion) {
            await vscode.window.showInformationMessage(ANNOUNCEMENT_TITLE + "：" + content);
        }
    }

    private getNewestMessageId(messages: ContestMessage[]): number {
        return messages.reduce((maxId, message) => {
            const id = Number(message.id);
            return Number.isFinite(id) ? Math.max(maxId, id) : maxId;
        }, -1);
    }

    private async persistLastMessageId(contestId: number, uid: number, messageId: number): Promise<void> {
        await this.context.workspaceState.update(this.stateKey(contestId, uid), messageId);
    }

    private stateKey(contestId: number, uid: number): string {
        return `nowcoderac.announcements.lastMessageId.${contestId}.${uid}`;
    }

    private normalizeMessageContent(content: string): string {
        return content
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/\s+/g, ' ')
            .trim();
    }

}
