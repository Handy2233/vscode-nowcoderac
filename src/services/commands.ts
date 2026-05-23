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
    getLastCphSaveLocation,
    getOpenProblemPreviewToSidePref,
    getReuseLastCphSaveLocationPref,
    updateLastCphSaveLocation,
    updateContestWorkspaceRootPathPref
} from '../utils/perferenceHelper';
import { getProblemMarkdownPath, writeProblemMarkdown } from '../utils/problemMarkdown';
import { ContestRecord, ContestRegistryService } from './contestRegistryService';
import { nowcoderService } from './nowcoderService';

async function ensureInContest(callback: (currentContest: ContestService) => Promise<void>) {
    const contestManager = ContestSpaceManager.getInstance().getContestService();
    if (!contestManager) {
        vscode.window.showErrorMessage('请先打开比赛文件夹');
        return;
    }
    await callback(contestManager);
}

async function selectCphSaveLocation(context: vscode.ExtensionContext, contestFolderPath: string): Promise<string | undefined> {
    const reuseLastSaveLocation = getReuseLastCphSaveLocationPref();
    const lastSaveLocation = getLastCphSaveLocation(context);
    if (reuseLastSaveLocation && lastSaveLocation) {
        return lastSaveLocation;
    }

    const cphFolderUri = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(contestFolderPath),
        openLabel: '选择 CPH 测试数据保存位置'
    });

    if (!cphFolderUri || cphFolderUri.length === 0) {
        return undefined;
    }

    const selectedPath = cphFolderUri[0].fsPath;
    if (!reuseLastSaveLocation) {
        return selectedPath;
    }

    const confirm = await vscode.window.showInformationMessage(
        `是否将 ${selectedPath} 保存为后续 CPH 测试数据目录？`,
        { modal: true },
        '保存并使用',
        '仅本次使用'
    );

    if (confirm === '保存并使用') {
        await updateLastCphSaveLocation(context, selectedPath);
    }

    return selectedPath;
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
    const sourceFileNames = currentContest.cphService.getExistingSourceFileNames(problemIndex);
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
            
            const document = await vscode.workspace.openTextDocument(filePath);
            if (getOpenProblemPreviewToSidePref()) {
                vscode.commands.executeCommand('markdown.showPreviewToSide', document.uri);
            } else {
                await vscode.window.showTextDocument(document, { preview: false });
            }
        });
    });
};

export const createCodeFile = async (context: vscode.ExtensionContext, problemItem: ProblemItem | undefined, generateCphProb: boolean = true): Promise<void> => {
    if (!problemItem) {
        return;
    }
    const problem = problemItem.problem;
    ensureInContest(async (currentContest) => {
        const compiler = await UserInteractiveHelper.askCompiler();
        if (!compiler) {
            return;
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
                const cphSaveLocation = await selectCphSaveLocation(context, contestFolderPath);
                if (!cphSaveLocation) {
                    vscode.window.showWarningMessage('未选择 CPH 测试数据保存位置，已跳过生成 .prob 文件');
                } else {
                    const cphService = currentContest.cphService;
                    const existingProb = cphService.readExistingProb(fileName, cphSaveLocation);
                    if (!existingProb || !existingProb.tests || existingProb.tests.length === 0) {
                        if (!problem.extra) {
                            problem.extra = await currentContest.getProblemExtra(problem.info.index);
                        }

                        const prob = cphService.createProb(fileName, problem);
                        if (prob) {
                            cphService.saveProb(fileName, prob, cphSaveLocation);
                        } else {
                            console.error('Failed to create prob file');
                        }
                    }
                }
            } catch (error) {
                console.error('Failed to create prob file:', error);
                vscode.window.showWarningMessage(`生成 CPH 测试数据失败: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

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
        await currentContest.getSubmissions(true);  // 刷新提交记录
        await currentContest.getRealtimeRank(true);  // 刷新实时排行榜
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

function isCancellationError(error: unknown): boolean {
    if (error instanceof vscode.CancellationError) {
        return true;
    }
    if (!(error instanceof Error)) {
        return false;
    }
    return error.name === 'Canceled' || error.message === 'Canceled';
}

export const login = async (context: vscode.ExtensionContext) => {
    await NowcoderAuthenticationProvider.clearToken(context);
    try {
        await vscode.authentication.getSession('nowcoderac', [], { createIfNone: true });
    } catch (error) {
        if (isCancellationError(error)) {
            return;
        }
        throw error;
    }
};

export const logout = async (context: vscode.ExtensionContext) => {
    await NowcoderAuthenticationProvider.clearToken(context);
};
