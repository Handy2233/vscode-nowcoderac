import * as vscode from 'vscode';
import { NowcoderAuthenticationProvider } from './nowcoderAuthenticationProvider';
import { ProblemsProvider } from './views/problemsProvider';
import { SubmissionsProvider } from './views/submissionsProvider';
import { RankingsProvider } from './views/rankingsProvider';
import { ContestsProvider } from './views/contestsProvider';
import { ContestSpaceManager } from './services/contestSpaceManager';
import { createCodeFile, openProblem, createContestSpace, refreshProblemList, submitSolution, submitCurrentFile, refreshSubmissionList, refreshRealtimeRank, login, logout, openContestFromList, refreshContestList, deleteContestFromList } from './services/commands';
import { ContestServiceEventWrapper } from './utils/contestServiceEventWrapper';
import { ContestCountdownTimer } from './utils/contestCountdownTimer';
import { ContestAnnouncementWatcher } from './services/contestAnnouncementWatcher';
import { ContestProblemUpdateWatcher } from './services/contestProblemUpdateWatcher';
import { ContestRegistryService } from './services/contestRegistryService';
import { nowcoderService } from './services/nowcoderService';
import { loginPromptCoordinator } from './services/loginPromptCoordinator';

function registerLoginPromptOnPluginOpen(context: vscode.ExtensionContext, ...treeViews: vscode.TreeView<unknown>[]): void {
    const promptIfVisible = (treeView: vscode.TreeView<unknown>) => {
        if (treeView.visible) {
            void loginPromptCoordinator.promptAfterPluginOpen();
        }
    };

    for (const treeView of treeViews) {
        context.subscriptions.push(treeView.onDidChangeVisibility(event => {
            if (event.visible) {
                void loginPromptCoordinator.promptAfterPluginOpen();
            }
        }));
        promptIfVisible(treeView);
    }
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    console.log('牛客竞赛扩展已激活');

    // 注册身份验证提供者
    const authProvider = new NowcoderAuthenticationProvider(context);
    context.subscriptions.push(
        vscode.authentication.registerAuthenticationProvider(
            "nowcoderac",
            "NowcoderAC",
            authProvider
        )
    );

    const contestSpaceManager = ContestSpaceManager.createInstance(context);
    const contestRegistry = new ContestRegistryService(context);
    contestRegistry.pruneMissingContests();
    contestRegistry.migrateLegacyContests(async (contestId) => {
        const result = await nowcoderService.getContestTitle(contestId);
        return result.success ? result.data ?? undefined : undefined;
    }).catch(error => {
        console.error('迁移旧比赛列表失败:', error);
    });

    // 初始化视图提供者
    const contestServiceEventWrapper = new ContestServiceEventWrapper(contestSpaceManager);
    const contestsProvider = new ContestsProvider(contestRegistry, contestSpaceManager);
    const problemsProvider = new ProblemsProvider(contestServiceEventWrapper);
    const submissionsProvider = new SubmissionsProvider(contestServiceEventWrapper);
    const rankingsProvider = new RankingsProvider(contestServiceEventWrapper);
    
    // 初始化倒计时
    const countdownTimer = new ContestCountdownTimer();
    context.subscriptions.push(countdownTimer);

    // 初始化比赛公告监听
    const announcementWatcher = new ContestAnnouncementWatcher(context, contestSpaceManager);
    context.subscriptions.push(announcementWatcher);

    // 初始化比赛题面和 CPH 更新监听
    const problemUpdateWatcher = new ContestProblemUpdateWatcher(contestSpaceManager);
    context.subscriptions.push(problemUpdateWatcher);

    context.subscriptions.push(contestSpaceManager);
    context.subscriptions.push(contestRegistry);
    
    // 注册视图
    const contestsTreeView = vscode.window.createTreeView('nowcoderac-contests', {
        treeDataProvider: contestsProvider
    });
    context.subscriptions.push(contestsTreeView);

    const problemsTreeView = vscode.window.createTreeView('nowcoderac-problems', {
        treeDataProvider: problemsProvider
    });
    context.subscriptions.push(problemsTreeView);
    
    const submissionsTreeView = vscode.window.createTreeView('nowcoderac-submissions', {
        treeDataProvider: submissionsProvider
    });
    context.subscriptions.push(submissionsTreeView);
    
    const rankingsTreeView = vscode.window.createTreeView('nowcoderac-rankings', {
        treeDataProvider: rankingsProvider
    });
    context.subscriptions.push(rankingsTreeView);
    registerLoginPromptOnPluginOpen(
        context,
        contestsTreeView,
        problemsTreeView,
        submissionsTreeView,
        rankingsTreeView
    );
    
    // 注册创建比赛工作空间命令
    const createWorkspaceDisposable = vscode.commands.registerCommand('nowcoderac.createContestSpace', () => createContestSpace(contestRegistry));
    context.subscriptions.push(createWorkspaceDisposable);

    // 从比赛列表打开比赛命令
    const openContestFromListDisposable = vscode.commands.registerCommand('nowcoderac.openContestFromList', contest => openContestFromList(contest, contestRegistry));
    context.subscriptions.push(openContestFromListDisposable);

    // 从比赛列表删除比赛命令
    const deleteContestFromListDisposable = vscode.commands.registerCommand('nowcoderac.deleteContestFromList', contest => deleteContestFromList(contest, contestRegistry));
    context.subscriptions.push(deleteContestFromListDisposable);

    // 刷新比赛列表命令
    const refreshContestListDisposable = vscode.commands.registerCommand('nowcoderac.refreshContestList', () => refreshContestList(contestRegistry));
    context.subscriptions.push(refreshContestListDisposable);

    // 刷新题目列表命令
    const refreshProblemListDisposable = vscode.commands.registerCommand('nowcoderac.refreshProblemList', refreshProblemList);
    context.subscriptions.push(refreshProblemListDisposable);

    // 打开题目命令
    const openProblemDisposable = vscode.commands.registerCommand('nowcoderac.openProblem', openProblem);
    context.subscriptions.push(openProblemDisposable);

    // 创建代码文件命令
    const createCodeFileDisposable = vscode.commands.registerCommand('nowcoderac.createCodeFile', createCodeFile);
    context.subscriptions.push(createCodeFileDisposable);
    
    // 提交解答命令
    const submitSolutionDisposable = vscode.commands.registerCommand('nowcoderac.submitSolution', submitSolution);
    context.subscriptions.push(submitSolutionDisposable);

    // 提交当前代码文件命令
    const submitCurrentFileDisposable = vscode.commands.registerCommand('nowcoderac.submitCurrentFile', submitCurrentFile);
    context.subscriptions.push(submitCurrentFileDisposable);
    
    // 刷新提交记录命令
    const refreshSubmissionListDisposable = vscode.commands.registerCommand('nowcoderac.refreshSubmissionList', refreshSubmissionList);
    context.subscriptions.push(refreshSubmissionListDisposable);

    // 刷新排名命令
    const refreshRankingsDisposable = vscode.commands.registerCommand('nowcoderac.refreshRealtimeRank', refreshRealtimeRank);
    context.subscriptions.push(refreshRankingsDisposable);

    // 登录命令
    const loginDisposable = vscode.commands.registerCommand('nowcoderac.login', () => login(authProvider));
    context.subscriptions.push(loginDisposable);

    // 登出命令
    const logoutDisposable = vscode.commands.registerCommand('nowcoderac.logout', () => logout(authProvider));
    context.subscriptions.push(logoutDisposable);
}

// This method is called when your extension is deactivated
export function deactivate() {
    console.log('NowCoder AC Extension has been deactivated.');
}
