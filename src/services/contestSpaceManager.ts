import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ContestService } from './contestService';
import { Problem } from '../models/models';
import { getProblemMarkdownPath, writeProblemMarkdown } from '../utils/problemMarkdown';

export class ContestSpaceManager extends vscode.Disposable {
    private static instance: ContestSpaceManager | undefined = undefined;
    private readonly _onContestSpaceChanged = new vscode.EventEmitter<ContestService | undefined>();
    private readonly _textEditorChangedListener: vscode.Disposable;
    private currentContest: ContestService | undefined = undefined;
    private activeEditorChangeVersion = 0;
    private lastProblemPreviewSourceFilePath: string | undefined = undefined;

    readonly onContestSpaceChanged = this._onContestSpaceChanged.event;

    private constructor(context: vscode.ExtensionContext) {
        super(() => {
            this._textEditorChangedListener.dispose();
            ContestSpaceManager.instance = undefined;
        });
        
        this.currentContest = undefined;

        this._textEditorChangedListener = vscode.window.onDidChangeActiveTextEditor(this.handleActiveEditorChange, this);
        this.openWorkspaceRootContestSpace();
        this.handleActiveEditorChange(vscode.window.activeTextEditor);  // 以当前打开的编辑器触发一次事件
    }

    private openWorkspaceRootContestSpace(): void {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder || workspaceFolder.uri.scheme !== 'file') {
            return;
        }

        const configPath = path.join(workspaceFolder.uri.fsPath, 'nowcoderac.json');
        if (!fs.existsSync(configPath)) {
            return;
        }

        try {
            this.openContestSpace(configPath);
        } catch (error) {
            vscode.window.showErrorMessage(`打开比赛空间失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async handleActiveEditorChange(editor: vscode.TextEditor | undefined): Promise<void> {
        const version = ++this.activeEditorChangeVersion;
        if (!editor || editor.document.uri.scheme !== 'file') {
            return;
        }

        const sourceFilePath = editor.document.uri.fsPath;
        // 查找配置文件
        const documentDir = path.dirname(sourceFilePath);
        const potentialConfigPath = path.join(documentDir, 'nowcoderac.json');

        // 已经是当前配置文件了，或者不存在配置文件
        if (!fs.existsSync(potentialConfigPath)) {
            return;
        }

        const contestDir = fs.realpathSync(documentDir);
        let contestService = this.currentContest;
        try {
            if (contestService?.getContestFolderPath() !== contestDir) {
                contestService = this.openContestSpace(potentialConfigPath);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`打开比赛空间失败: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }

        try {
            await this.openProblemPreviewForSourceFile(contestService, sourceFilePath, version);
        } catch (error) {
            vscode.window.showErrorMessage(`打开题面失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async openProblemPreviewForSourceFile(
        contestService: ContestService,
        sourceFilePath: string,
        version: number
    ): Promise<void> {
        const problem = await this.getProblemBySourceFilePath(contestService, sourceFilePath);
        if (!problem || !this.isCurrentActiveSourceFile(sourceFilePath, version)) {
            return;
        }
        if (!this.hasProblemPreviewSourceFileChanged(sourceFilePath)) {
            return;
        }

        const extra = await contestService.getProblemExtra(problem.info.index);
        if (!this.isCurrentActiveSourceFile(sourceFilePath, version)) {
            return;
        }

        const contestFolderPath = contestService.getContestFolderPath();
        const markdownPath = getProblemMarkdownPath(contestFolderPath, problem.info.index);
        writeProblemMarkdown(contestFolderPath, problem, extra);
        this.lastProblemPreviewSourceFilePath = fs.realpathSync(sourceFilePath);
        await vscode.commands.executeCommand('markdown.showPreviewToSide', vscode.Uri.file(markdownPath));
    }

    private async getProblemBySourceFilePath(
        contestService: ContestService,
        sourceFilePath: string
    ): Promise<Problem | undefined> {
        if (!this.isPathInContestRoot(contestService, sourceFilePath)) {
            return undefined;
        }

        const sourceFileName = path.basename(sourceFilePath);
        const problems = await contestService.getProblems();
        return [...problems]
            .sort((a, b) => b.info.index.length - a.info.index.length)
            .find(problem => contestService.cphService.getExistingSourceFileNames(problem.info.index).includes(sourceFileName));
    }

    private isPathInContestRoot(contestService: ContestService, filePath: string): boolean {
        return fs.existsSync(filePath) && path.relative(contestService.getContestFolderPath(), path.dirname(filePath)) === '';
    }

    private isCurrentActiveSourceFile(sourceFilePath: string, version: number): boolean {
        const activeFilePath = vscode.window.activeTextEditor?.document.uri.fsPath;
        if (!activeFilePath || !fs.existsSync(activeFilePath) || !fs.existsSync(sourceFilePath)) {
            return false;
        }

        return this.activeEditorChangeVersion === version
            && fs.realpathSync(activeFilePath) === fs.realpathSync(sourceFilePath);
    }

    private hasProblemPreviewSourceFileChanged(sourceFilePath: string): boolean {
        if (!this.lastProblemPreviewSourceFilePath) {
            return true;
        }

        return fs.realpathSync(sourceFilePath) !== this.lastProblemPreviewSourceFilePath;
    }

    /**
     * 打开比赛空间，此举会更新当前打开的比赛配置文件
     * @param contestConfigPath 比赛配置文件路径
     */
    openContestSpace(contestConfigPath: string): ContestService {
        if (!fs.existsSync(contestConfigPath)) {
            throw new Error(`比赛配置文件不存在: ${contestConfigPath}`);
        }

        contestConfigPath = fs.realpathSync(contestConfigPath);
        const contestDir = path.dirname(contestConfigPath);
        this.currentContest = ContestService.open(contestDir, contestConfigPath);
        this._onContestSpaceChanged.fire(this.currentContest);
        return this.currentContest;
    }

    /**
     * 创建比赛空间，如果已经存在，则覆盖，此举会更新当前打开的比赛配置文件
     * @param contestId 比赛ID
     * @param contestFolderPath 比赛文件夹路径
     * @returns ContestService实例
     */
    createContestSpace(contestId: number, contestFolderPath: string): ContestService {
        if (!fs.existsSync(contestFolderPath)) {
            fs.mkdirSync(contestFolderPath, { recursive: true });
        }
        contestFolderPath = fs.realpathSync(contestFolderPath);
        const configPath = path.join(contestFolderPath, 'nowcoderac.json');

        this.currentContest = ContestService.create(contestFolderPath, configPath, contestId);
        this._onContestSpaceChanged.fire(this.currentContest);
        return this.currentContest;
    }

    /**
     * 获取当前比赛的ContestManager示例
     * @returns 当前的ContestManager实例
     */
    getContestService() : ContestService | undefined {
        return this.currentContest;
    }

    /**
     * 创建ContestSpaceManager实例，如果已经存在，则返回现有实例
     * @param context 插件上下文
     * @returns ContestSpaceManager实例
     */
    static createInstance(context: vscode.ExtensionContext) : ContestSpaceManager {
        if (!ContestSpaceManager.instance) {
            ContestSpaceManager.instance = new ContestSpaceManager(context);
        }
        return ContestSpaceManager.instance;
    }

    /**
     * 获取ContestSpaceManager实例
     * @throws Error 如果在createInstance之前调用了getInstance，则会抛出错误
     * @returns ContestSpaceManager实例
     */
    static getInstance() : ContestSpaceManager {
        if (!ContestSpaceManager.instance) {
            throw new Error("ContestSpaceManager instance not created. Call createInstance() first.");
        }
        return ContestSpaceManager.instance;
    }
}
