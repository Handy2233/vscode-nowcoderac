import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface ContestRecord {
    contestId: number;
    title: string;
    folderPath: string;
}

interface ContestRegistryData {
    contests: ContestRecord[];
}

export class ContestRegistryService implements vscode.Disposable {
    private static readonly REGISTRY_DIR_NAME = '.nowcoderac';
    private static readonly REGISTRY_FILE_NAME = 'contests.json';
    private static readonly CONTEST_CONFIG_FILE_NAME = 'nowcoderac.json';

    private readonly _onDidChangeContests = new vscode.EventEmitter<void>();
    readonly onDidChangeContests = this._onDidChangeContests.event;
    private readonly disposables: vscode.Disposable[] = [];
    private contestConfigWatchers: vscode.Disposable[] = [];

    constructor(private readonly context: vscode.ExtensionContext) {
        this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this.syncContestConfigWatchers();
            this._onDidChangeContests.fire();
        }));

        const configWatcher = vscode.workspace.createFileSystemWatcher(`**/${ContestRegistryService.CONTEST_CONFIG_FILE_NAME}`);
        this.disposables.push(configWatcher);
        this.disposables.push(configWatcher.onDidDelete(uri => {
            this.removeContestByConfigPath(uri.fsPath);
        }));
        this.syncContestConfigWatchers();
    }

    dispose(): void {
        this.disposeContestConfigWatchers();
        this.disposables.forEach(disposable => disposable.dispose());
        this._onDidChangeContests.dispose();
    }

    getContests(): ContestRecord[] {
        return this.sortContests(this.readData().contests);
    }

    hasWorkspaceRoot(): boolean {
        return !!this.getWorkspaceRootPath();
    }

    async migrateLegacyContests(resolveTitle: (contestId: number) => Promise<string | undefined>): Promise<number> {
        const rootPath = this.getWorkspaceRootPath();
        if (!rootPath) {
            return 0;
        }

        const existingRecords = this.readData(rootPath).contests;
        const existingRecordsByContestId = new Map(existingRecords.map(record => [record.contestId, record]));
        const records = await this.findLegacyContestRecords(rootPath, async (contestId) => {
            return await resolveTitle(contestId) ?? existingRecordsByContestId.get(contestId)?.title;
        });
        if (records.length === 0) {
            return 0;
        }

        const mergedRecordsByContestId = new Map(existingRecords.map(record => [record.contestId, record]));
        records.forEach(record => mergedRecordsByContestId.set(record.contestId, record));

        this.writeData(rootPath, {
            contests: this.sortContests([...mergedRecordsByContestId.values()])
        });
        this._onDidChangeContests.fire();
        return records.length;
    }

    upsertContest(record: ContestRecord): void {
        const normalizedRootPath = this.getWorkspaceRootPath();
        if (!normalizedRootPath) {
            throw new Error('请先打开一个 VS Code 工作区，再创建比赛工作空间');
        }
        const data = this.readData(normalizedRootPath);
        const contests = data.contests.filter(contest => contest.contestId !== record.contestId);
        contests.push({
            contestId: record.contestId,
            title: record.title,
            folderPath: fs.realpathSync(record.folderPath)
        });

        this.writeData(normalizedRootPath, {
            contests: this.sortContests(contests)
        });
        this._onDidChangeContests.fire();
    }

    removeContest(contestId: number): boolean {
        const rootPath = this.getWorkspaceRootPath();
        if (!rootPath) {
            return false;
        }

        const data = this.readData(rootPath);
        const contests = data.contests.filter(contest => contest.contestId !== contestId);
        if (contests.length === data.contests.length) {
            return false;
        }

        this.writeData(rootPath, { contests: this.sortContests(contests) });
        this._onDidChangeContests.fire();
        return true;
    }

    pruneMissingContests(): number {
        const rootPath = this.getWorkspaceRootPath();
        if (!rootPath) {
            return 0;
        }

        const data = this.readData(rootPath);
        const contests = data.contests.filter(contest => {
            return fs.existsSync(this.getContestConfigPath(contest.folderPath));
        });
        const removedCount = data.contests.length - contests.length;
        if (removedCount === 0) {
            return 0;
        }

        this.writeData(rootPath, { contests: this.sortContests(contests) });
        this._onDidChangeContests.fire();
        return removedCount;
    }

    removeContestByConfigPath(configPath: string): boolean {
        const rootPath = this.getWorkspaceRootPath();
        if (!rootPath) {
            return false;
        }

        const normalizedConfigPath = this.normalizePath(configPath);
        const data = this.readData(rootPath);
        const contests = data.contests.filter(contest => {
            return this.normalizePath(this.getContestConfigPath(contest.folderPath)) !== normalizedConfigPath;
        });
        if (contests.length === data.contests.length) {
            return false;
        }

        this.writeData(rootPath, { contests: this.sortContests(contests) });
        this._onDidChangeContests.fire();
        return true;
    }

    private readData(rootPath: string | undefined = this.getWorkspaceRootPath()): ContestRegistryData {
        if (!rootPath) {
            return { contests: [] };
        }

        const registryFilePath = this.getRegistryFilePath(rootPath);
        if (!fs.existsSync(registryFilePath)) {
            return { contests: [] };
        }

        const data = JSON.parse(fs.readFileSync(registryFilePath, 'utf-8')) as Partial<ContestRegistryData>;
        return {
            contests: Array.isArray(data.contests) ? data.contests : []
        };
    }

    private writeData(rootPath: string, data: ContestRegistryData): void {
        const registryDirPath = path.join(rootPath, ContestRegistryService.REGISTRY_DIR_NAME);
        fs.mkdirSync(registryDirPath, { recursive: true });
        fs.writeFileSync(
            path.join(registryDirPath, ContestRegistryService.REGISTRY_FILE_NAME),
            JSON.stringify(data, null, 4),
            'utf-8'
        );
        this.syncContestConfigWatchers(rootPath, data.contests);
    }

    private getRegistryFilePath(rootPath: string): string {
        return path.join(rootPath, ContestRegistryService.REGISTRY_DIR_NAME, ContestRegistryService.REGISTRY_FILE_NAME);
    }

    private getContestConfigPath(folderPath: string): string {
        return path.join(folderPath, ContestRegistryService.CONTEST_CONFIG_FILE_NAME);
    }

    private async findLegacyContestRecords(
        rootPath: string,
        resolveTitle: (contestId: number) => Promise<string | undefined>
    ): Promise<ContestRecord[]> {
        const configUris = await this.findLegacyConfigUris();
        const recordsByContestId = new Map<number, ContestRecord>();

        for (const configUri of configUris) {
            const configPath = configUri.fsPath;
            const contestId = this.readContestId(configPath);
            if (!contestId || recordsByContestId.has(contestId)) {
                continue;
            }

            const folderPath = fs.realpathSync(path.dirname(configPath));
            if (!this.isPathInside(rootPath, folderPath)) {
                continue;
            }

            const existingRecord = recordsByContestId.get(contestId);
            recordsByContestId.set(contestId, {
                contestId,
                title: await resolveTitle(contestId) ?? existingRecord?.title ?? `比赛 ${contestId}`,
                folderPath
            });
        }

        return [...recordsByContestId.values()];
    }

    private async findLegacyConfigUris(): Promise<vscode.Uri[]> {
        const exclude = '{**/.git/**,**/node_modules/**,**/.nowcoderac/**,**/dist/**,**/out/**}';
        return vscode.workspace.findFiles(`**/${ContestRegistryService.CONTEST_CONFIG_FILE_NAME}`, exclude);
    }

    private readContestId(configPath: string): number | undefined {
        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { contestId?: unknown };
            const contestId = Number(config.contestId);
            return Number.isInteger(contestId) && contestId > 0 ? contestId : undefined;
        } catch (error) {
            console.warn(`Failed to read contest config: ${configPath}`, error);
            return undefined;
        }
    }

    private isPathInside(parentPath: string, childPath: string): boolean {
        const relativePath = path.relative(parentPath, childPath);
        return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
    }

    private normalizePath(filePath: string): string {
        return path.resolve(filePath);
    }

    private syncContestConfigWatchers(
        rootPath: string | undefined = this.getWorkspaceRootPath(),
        contests: ContestRecord[] = this.readData(rootPath).contests
    ): void {
        this.disposeContestConfigWatchers();
        if (!rootPath) {
            return;
        }

        const watchedConfigPaths = new Set<string>();
        for (const contest of contests) {
            const configPath = this.normalizePath(this.getContestConfigPath(contest.folderPath));
            if (watchedConfigPaths.has(configPath)) {
                continue;
            }
            watchedConfigPaths.add(configPath);

            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(contest.folderPath, ContestRegistryService.CONTEST_CONFIG_FILE_NAME)
            );
            this.contestConfigWatchers.push(watcher);
            this.contestConfigWatchers.push(watcher.onDidDelete(uri => {
                this.removeContestByConfigPath(uri.fsPath);
            }));
        }
    }

    private disposeContestConfigWatchers(): void {
        this.contestConfigWatchers.forEach(disposable => disposable.dispose());
        this.contestConfigWatchers = [];
    }

    private sortContests(contests: ContestRecord[]): ContestRecord[] {
        return contests.sort((a, b) => b.contestId - a.contestId);
    }

    private getWorkspaceRootPath(): string | undefined {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return undefined;
        }
        return fs.realpathSync(workspaceFolder.uri.fsPath);
    }
}
