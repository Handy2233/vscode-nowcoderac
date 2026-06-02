import * as vscode from 'vscode';
import { ContestRecord, ContestRegistryService } from '../services/contestRegistryService';
import { ContestSpaceManager } from '../services/contestSpaceManager';

export class ContestsProvider implements vscode.TreeDataProvider<ContestItem | MessageItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ContestItem | MessageItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(
        private readonly contestRegistry: ContestRegistryService,
        private readonly contestSpaceManager: ContestSpaceManager
    ) {
        contestRegistry.onDidChangeContests(() => {
            this.refresh();
        });
        contestSpaceManager.onContestSpaceChanged(() => {
            this.refresh();
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ContestItem | MessageItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ContestItem | MessageItem): vscode.ProviderResult<(ContestItem | MessageItem)[]> {
        if (element) {
            return [];
        }

        const contests = this.contestRegistry.getContests();
        if (contests.length === 0) {
            return [new MessageItem('暂无已创建比赛')];
        }

        const currentContestId = this.contestSpaceManager.getContestService()?.getConfig().contestId;
        return contests.map(contest => new ContestItem(contest, contest.contestId === currentContestId));
    }
}

export class ContestItem extends vscode.TreeItem {
    constructor(public readonly contest: ContestRecord, isCurrentContest: boolean = false) {
        super(contest.title, vscode.TreeItemCollapsibleState.None);
        this.id = String(contest.contestId);
        this.tooltip = `${contest.title}\n比赛ID: ${contest.contestId}`;
        this.contextValue = 'contest';
        if (isCurrentContest) {
            this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'));
        }
        this.command = {
            command: 'nowcoderac.openContestFromList',
            title: '打开比赛',
            arguments: [contest]
        };
    }
}

export class MessageItem extends vscode.TreeItem {
    constructor(title: string) {
        super(title, vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'message';
    }
}
