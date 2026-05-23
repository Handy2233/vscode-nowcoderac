import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ContestSpaceManager } from "./contestSpaceManager";
import { UserInteractiveHelper } from '../utils/userInteractiveHelper';
import { COMPILER_CONFIG, Problem } from '../models/models';
import { CodeHelper } from '../utils/codeHelper';
import { ContestService } from './contestService';
import { ProblemItem } from '../views/problemsProvider';
import { NowcoderAuthenticationProvider } from '../nowcoderAuthenticationProvider';
import {
    getAutoGenerateCphProblemPref,
    getContestWorkspaceRootPathPref,
    updateContestWorkspaceRootPathPref
} from '../utils/perferenceHelper';
import { getProblemMarkdownPath, writeProblemMarkdown } from '../utils/problemMarkdown';
import { ContestRecord, ContestRegistryService } from './contestRegistryService';
import { nowcoderService } from './nowcoderService';
import { loginPromptCoordinator } from './loginPromptCoordinator';

async function ensureInContest(callback: (currentContest: ContestService) => Promise<void>) {
    const contestManager = ContestSpaceManager.getInstance().getContestService();
    if (!contestManager) {
        vscode.window.showErrorMessage('请先打开比赛文件夹');
        return;
    }
    await callback(contestManager);
}

function getProblemSourceFileNames(currentContest: ContestService, problemIndex: string): string[] {
    return currentContest.cphService.getExistingSourceFileNames(problemIndex);
}

function parseContestId(input: string | undefined): number | undefined {
    const value = input?.trim();
    if (!value) {
        return undefined;
    }

    if (/^\d+$/.test(value)) {
        return Number(value);
    }

    const match = value.match(/\/acm\/contest\/(\d+)(?:\/|$|\?)/);
    if (match?.[1]) {
        return Number(match[1]);
    }

    return undefined;
}

async function selectProblemSourceFile(currentContest: ContestService, problemIndex: string): Promise<string | undefined> {
    const sourceFileNames = getProblemSourceFileNames(currentContest, problemIndex);
    if (sourceFileNames.length === 0) {
        vscode.window.showErrorMessage(`未找到题目 ${problemIndex} 对应的代码文件，请先创建代码文件。`);
        return undefined;
    }

    if (sourceFileNames.length === 1) {
        return sourceFileNames[0];
    }

    return vscode.window.showQuickPick(sourceFileNames, {
        placeHolder: `请选择题目 ${problemIndex} 要提交的代码文件`
    });
}

async function openSourceDocument(filePath: string): Promise<vscode.TextDocument> {
    const realPath = fs.realpathSync(filePath);
    const openedDocument = vscode.workspace.textDocuments.find(document => {
        return document.uri.scheme === 'file' && fs.existsSync(document.uri.fsPath) && fs.realpathSync(document.uri.fsPath) === realPath;
    });
    return openedDocument ?? vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
}

function isPathInContestRoot(currentContest: ContestService, filePath: string): boolean {
    const contestFolderPath = currentContest.getContestFolderPath();
    return fs.existsSync(filePath) && path.relative(contestFolderPath, path.dirname(filePath)) === '';
}

async function getProblemBySourceFilePath(currentContest: ContestService, filePath: string): Promise<Problem | undefined> {
    if (!isPathInContestRoot(currentContest, filePath)) {
        return undefined;
    }

    const fileName = path.basename(filePath);
    const problems = await currentContest.getProblems();
    return [...problems]
        .sort((a, b) => b.info.index.length - a.info.index.length)
        .find(problem => getProblemSourceFileNames(currentContest, problem.info.index).includes(fileName));
}

function findActiveProblemSourceFile(currentContest: ContestService, sourceFileNames: string[]): string | undefined {
    const activeFilePath = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!activeFilePath) {
        return undefined;
    }

    if (!isPathInContestRoot(currentContest, activeFilePath)) {
        return undefined;
    }

    const activeFileName = path.basename(activeFilePath);
    return sourceFileNames.includes(activeFileName) ? activeFileName : undefined;
}

function getProblemSourceFileForOpen(currentContest: ContestService, problemIndex: string): string | undefined {
    const sourceFileNames = getProblemSourceFileNames(currentContest, problemIndex);
    if (sourceFileNames.length === 0) {
        return undefined;
    }

    return findActiveProblemSourceFile(currentContest, sourceFileNames) ?? sourceFileNames[0];
}

async function createProblemSourceFile(
    currentContest: ContestService,
    problem: Problem,
    generateCphProb: boolean = true
): Promise<string | undefined> {
    const compiler = await UserInteractiveHelper.askCompiler();
    if (!compiler) {
        return undefined;
    }

    const contestFolderPath = currentContest.getContestFolderPath();
    const compilerInfo = COMPILER_CONFIG[compiler];
    const fileName = `${problem.info.index}.${compilerInfo.ext}`;
    const filePath = path.join(contestFolderPath, fileName);
    const compilerMarkText = COMPILER_CONFIG[compiler].commentToken + ' Nowcoder Compiler: ' + COMPILER_CONFIG[compiler].name + '\n';

    fs.mkdirSync(contestFolderPath, { recursive: true });
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, compilerMarkText, 'utf-8');
    }

    if (generateCphProb && getAutoGenerateCphProblemPref()) {
        console.info('Creating prob file...');
        try {
            const cphService = currentContest.cphService;
            const existingProb = cphService.readExistingProb(fileName);
            if (!existingProb || !existingProb.tests || existingProb.tests.length === 0) {
                if (!problem.extra) {
                    problem.extra = await currentContest.getProblemExtra(problem.info.index);
                }

                const prob = cphService.createProb(fileName, problem);
                if (prob) {
                    cphService.saveProb(fileName, prob);
                } else {
                    console.error('Failed to create prob file');
                }
            }
        } catch (error) {
            console.error('Failed to create prob file:', error);
            vscode.window.showWarningMessage(`生成 CPH 测试数据失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return fileName;
}

async function getOrCreateProblemSourceFile(
    currentContest: ContestService,
    problem: Problem
): Promise<string | undefined> {
    return getProblemSourceFileForOpen(currentContest, problem.info.index)
        ?? await createProblemSourceFile(currentContest, problem);
}

async function openProblemSourceFile(
    currentContest: ContestService,
    problem: Problem,
    viewColumn: vscode.ViewColumn
): Promise<boolean> {
    const sourceFileName = await getOrCreateProblemSourceFile(currentContest, problem);
    if (!sourceFileName) {
        return false;
    }

    const filePath = path.join(currentContest.getContestFolderPath(), sourceFileName);
    const document = await openSourceDocument(filePath);
    await vscode.window.showTextDocument(document, {
        viewColumn,
        preview: false,
        preserveFocus: false
    });
    return true;
}

async function openProblemPreviewToSide(uri: vscode.Uri): Promise<void> {
    await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
}

async function submitProblemSourceFile(currentContest: ContestService, problem: Problem, filePath: string): Promise<void> {
    const sourceFileName = path.basename(filePath);
    const document = await openSourceDocument(filePath);
    const code = document.getText();
    if (!code) {
        vscode.window.showErrorMessage(`代码文件 ${sourceFileName} 为空。`);
        return;
    }

    const compiler = CodeHelper.tryParseComplierInCode(code, document.languageId) ?? await UserInteractiveHelper.askCompiler();
    if (!compiler) {
        return;
    }

    const submissionId = await currentContest.submitSolution(code, problem.info.index, compiler);
    await UserInteractiveHelper.showJudgementProgress(submissionId, problem, status => {
        return currentContest.confirmSubmissionStatus(status);
    });
    await currentContest.getSubmissions(true);
    await currentContest.getRealtimeRank(true);
}

function getSubmitFilePath(resource?: vscode.Uri): string | undefined {
    if (resource?.scheme === 'file') {
        return resource.fsPath;
    }

    const activeDocument = vscode.window.activeTextEditor?.document;
    return activeDocument?.uri.scheme === 'file' ? activeDocument.uri.fsPath : undefined;
}

export const createContestSpace = async (contestRegistry?: ContestRegistryService) => {
    try {
        // 获取用户输入的contestId
        const contestInput = await vscode.window.showInputBox({
            prompt: '请输入比赛ID或比赛链接',
            placeHolder: '例如: 12345 或 https://ac.nowcoder.com/acm/contest/12345',
            ignoreFocusOut: true
        });

        if (!contestInput) {
            return;
        }
        const contestId = parseContestId(contestInput);
        if (!contestId) {
            vscode.window.showErrorMessage('比赛ID或比赛链接无效');
            return;
        }

        const defaultWorkspaceRootPath = getContestWorkspaceRootPathPref();

        // 让用户选择目标文件夹
        const folderUri = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            defaultUri: defaultWorkspaceRootPath ? vscode.Uri.file(defaultWorkspaceRootPath) : undefined,
            openLabel: '选择保存位置'
        });

        if (!folderUri || folderUri.length === 0) {
            return;
        }
        if (contestRegistry && !contestRegistry.hasWorkspaceRoot()) {
            vscode.window.showErrorMessage('请先打开一个 VS Code 工作区，再创建比赛工作空间');
            return;
        }

        await updateContestWorkspaceRootPathPref(folderUri[0].fsPath);

        // 创建比赛文件夹
        const contestIdStr = String(contestId);
        const contestFolderPath = path.join(folderUri[0].fsPath, contestIdStr);
        const contestTitleResult = await nowcoderService.getContestTitle(contestId);
        if (!contestTitleResult.success || !contestTitleResult.data) {
            vscode.window.showErrorMessage(`获取比赛标题失败: ${contestTitleResult.error || '未知错误'}`);
            return;
        }

        const contestService = ContestSpaceManager.getInstance().createContestSpace(contestId, contestFolderPath);
        contestRegistry?.upsertContest({
            contestId,
            title: contestTitleResult.data,
            folderPath: contestService.getContestFolderPath()
        });
        vscode.window.showInformationMessage(`成功创建比赛工作空间: ${contestIdStr}`);
    } catch (error) {
        console.error('创建比赛工作空间失败:', error);
        vscode.window.showErrorMessage(`创建比赛工作空间失败: ${error instanceof Error ? error.message : String(error)}`);
    }
};

export const openContestFromList = async (contest: ContestRecord | undefined): Promise<void> => {
    if (!contest) {
        return;
    }

    const configPath = path.join(contest.folderPath, 'nowcoderac.json');
    if (!fs.existsSync(configPath)) {
        vscode.window.showErrorMessage(`比赛配置文件不存在: ${configPath}`);
        return;
    }

    try {
        ContestSpaceManager.getInstance().openContestSpace(configPath);
        vscode.window.showInformationMessage(`已切换比赛工作空间: ${contest.title}`);
    } catch (error) {
        vscode.window.showErrorMessage(`打开比赛失败: ${error instanceof Error ? error.message : String(error)}`);
    }
};

export const refreshContestList = async (contestRegistry: ContestRegistryService): Promise<void> => {
    if (!contestRegistry.hasWorkspaceRoot()) {
        vscode.window.showErrorMessage('请先打开一个 VS Code 工作区，再刷新比赛列表');
        return;
    }

    try {
        const migratedCount = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在刷新比赛列表...',
            cancellable: false
        }, async () => {
            return contestRegistry.migrateLegacyContests(async (contestId) => {
                const result = await nowcoderService.getContestTitle(contestId);
                return result.success ? result.data ?? undefined : undefined;
            });
        });
        vscode.window.showInformationMessage(`比赛列表刷新完成，发现 ${migratedCount} 场比赛`);
    } catch (error) {
        vscode.window.showErrorMessage(`刷新比赛列表失败: ${error instanceof Error ? error.message : String(error)}`);
    }
};

export const refreshProblemList = async () => {
    ensureInContest(async (currentContest) => {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "正在刷新题目列表...",
            cancellable: false
        }, async () => {
            await currentContest.getProblems(true);
        });
    });
};

export const openProblem = async (problemItem: ProblemItem | undefined): Promise<void> => {
    if (!problemItem) {
        return;
    }
    const problem = problemItem.problem;
    ensureInContest(async (currentContest) => {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `正在打开题目 ${problem.info.index}...`,
            cancellable: false
        }, async () => {
            const extra = await currentContest.getProblemExtra(problem.info.index, true);
            if (!extra) {
                vscode.window.showErrorMessage(`获取题目${problem.info.index}详情失败`);
                return;
            }

            const contestFolderPath = currentContest.getContestFolderPath();
            const filePath = getProblemMarkdownPath(contestFolderPath, problem.info.index);
            writeProblemMarkdown(contestFolderPath, problem, extra);
            await openProblemSourceFile(currentContest, problem, vscode.ViewColumn.One);

            await openProblemPreviewToSide(vscode.Uri.file(filePath));
        });
    });
};

export const createCodeFile = async (problemItem: ProblemItem | undefined, generateCphProb: boolean = true): Promise<void> => {
    if (!problemItem) {
        return;
    }
    const problem = problemItem.problem;
    ensureInContest(async (currentContest) => {
        const fileName = await createProblemSourceFile(currentContest, problem, generateCphProb);
        if (!fileName) {
            return;
        }

        const filePath = path.join(currentContest.getContestFolderPath(), fileName);
        await vscode.window.showTextDocument(vscode.Uri.file(filePath), {
            preview: false
        });
    });
};

export const submitSolution = async (problemItem: ProblemItem | undefined): Promise<void> => {
    if (!problemItem) {
        return;
    }
    const problem = problemItem.problem;
    ensureInContest(async (currentContest) => {
        const sourceFileName = await selectProblemSourceFile(currentContest, problem.info.index);
        if (!sourceFileName) {
            return;
        }

        const filePath = path.join(currentContest.getContestFolderPath(), sourceFileName);
        await submitProblemSourceFile(currentContest, problem, filePath);
    });
};

export const submitCurrentFile = async (resource?: vscode.Uri): Promise<void> => {
    const filePath = getSubmitFilePath(resource);
    if (!filePath) {
        vscode.window.showErrorMessage('当前没有可提交的代码文件。');
        return;
    }

    ensureInContest(async (currentContest) => {
        const problem = await getProblemBySourceFilePath(currentContest, filePath);
        if (!problem) {
            vscode.window.showErrorMessage('当前文件不是比赛目录下可识别的题目代码文件。');
            return;
        }

        await submitProblemSourceFile(currentContest, problem, filePath);
    });
};

export const refreshSubmissionList = async () => {
    ensureInContest(async (currentContest) => {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "正在刷新提交记录...",
            cancellable: false
        }, async () => {
            await currentContest.getSubmissions(true);
        });
    });
};

export const refreshRealtimeRank = async () => {
    ensureInContest(async (currentContest) => {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "正在刷新实时排行榜...",
            cancellable: false
        }, async () => {
            await currentContest.getRealtimeRank(true);
        });
    });
};

export const login = async (authProvider: NowcoderAuthenticationProvider) => {
    await authProvider.clearSession();
    await loginPromptCoordinator.promptForManualLogin();
};

export const logout = async (authProvider: NowcoderAuthenticationProvider) => {
    await authProvider.clearSession();
    loginPromptCoordinator.reset();
};
