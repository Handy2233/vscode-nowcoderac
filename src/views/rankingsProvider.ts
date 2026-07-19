import * as vscode from 'vscode';
import { ProblemRankData, RankBasicInfo, RankData } from '../models/models';
import { IContestDataProvider } from '../services/contestDataProvider.interface';

export class RankingsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    
    constructor(private dataProvider: IContestDataProvider) {
        dataProvider.onRankUpdated(() => {
            this.refresh();
        });
        dataProvider.onSubmissionStatusChanged(() => {
            this.refresh();
        });
    }
    
    refresh(): void {
        this._onDidChangeTreeData.fire();
    }
    
    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }
    
    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (element) {
            return [];
        }

        const rankings = await this.dataProvider.getRealtimeRank();
        if (!rankings) {
            return [
                new OpenRankBoardItem(),
                new vscode.TreeItem('暂无排名信息', vscode.TreeItemCollapsibleState.None)
            ];
        }

        const myRankItem = rankings.myRankData
            ? new RankItem(rankings.myRankData, rankings.problemData, rankings.basicInfo, true)
            : null;
        const topRankItems = rankings.rankData
            .filter(rankData => rankData.uid !== rankings.myRankData?.uid)
            .slice(0, 5)
            .map(rankData => new RankItem(rankData, rankings.problemData, rankings.basicInfo));

        const items: vscode.TreeItem[] = [
            new OpenRankBoardItem(rankings.basicInfo.rankCount),
            ...[myRankItem, ...topRankItems].filter((item): item is RankItem => item !== null)
        ];
        return items;
    }
}

class OpenRankBoardItem extends vscode.TreeItem {
    constructor(rankCount?: number) {
        super('打开完整实时排名', vscode.TreeItemCollapsibleState.None);
        this.description = rankCount === undefined ? undefined : `共 ${rankCount} 人`;
        this.iconPath = new vscode.ThemeIcon('table');
        this.command = {
            command: 'nowcoderac.openRealtimeRankBoard',
            title: '打开完整实时排名'
        };
    }
}

export class RankItem extends vscode.TreeItem {
    constructor(
        public readonly rankData: RankData,
        public readonly problems: ProblemRankData[],
        public readonly basicInfo: RankBasicInfo,
        isCurrentUser: boolean = false
    ) {
        super(
            `${rankData.ranking}. ${rankData.userName}`,
            vscode.TreeItemCollapsibleState.None
        );
        this.contextValue = "rankItem";
        this.command = {
            command: 'nowcoderac.openRealtimeRankBoard',
            title: '打开完整排名'
        };
        
        var problemStatus = "";
        var tooltip = `过题数: ${rankData.acceptedCount}\n罚时: ${(rankData.penaltyTime / 60000).toFixed(0)}分钟`;
        for (var i = 0; i < problems.length; i++) {
            const problem = problems[i];
            const score = rankData.scoreList[i];

            problemStatus += score.accepted ? "✓" : (score.submit ? "×" : "·");

            tooltip += `\n题${problem.name}: ${score.submit ? (score.accepted ? "通过" : "未通过") : "未提交"}`;
            if (score.failedCount > 0) {
                tooltip += ` -${score.failedCount}`;
            }

            const acceptedAfter = (score.acceptedTime - basicInfo.contestBeginTime) / 1000;
            if (acceptedAfter > 0) {
                const minutes = Math.floor(acceptedAfter / 60);
                const seconds = Math.floor(acceptedAfter % 60);
                tooltip += ` ${minutes.toString().padStart(2, '0')}分${seconds.toString().padStart(2, '0')}秒`;
            }
            if (score.firstBlood) {
                tooltip += " (首杀)";
            }
        }

        this.tooltip = tooltip;
        this.description = `${isCurrentUser ? '我 · ' : ''}✓ ${rankData.acceptedCount} · ${(rankData.penaltyTime / 60000).toFixed(0)}分 · ${problemStatus}`;
        this.iconPath = new vscode.ThemeIcon(isCurrentUser ? 'account' : 'person');
    }
}
