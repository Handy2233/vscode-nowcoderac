import * as vscode from 'vscode';
import { ContestService } from './contestService';
import { ContestSpaceManager } from './contestSpaceManager';
import { updateExistingProblemMarkdown } from '../utils/problemMarkdown';

const POLL_INTERVAL_MS = 10000;
const FAILURE_BACKOFF_MS = 30000;

/**
 * 轮询当前比赛题面和 CPH 样例更新。
 *
 * 该监听器绑定当前比赛工作区，只在比赛进行中每 10 秒检查一次。
 * 检测到变化后会更新缓存、已存在的题面 Markdown 文件和可安全同步的 CPH 样例。
 */
export class ContestProblemUpdateWatcher implements vscode.Disposable {
    private readonly contestSpaceChangedDisposable: vscode.Disposable;
    private timer: NodeJS.Timeout | undefined;
    private currentService: ContestService | undefined;
    private inFlight = false;
    private disposed = false;
    private bindVersion = 0;
    private nextPollAfter = 0;

    /**
     * 创建题面更新监听器。
     *
     * @param contestSpaceManager 当前比赛工作区管理器，用于在切换比赛时重新绑定轮询目标。
     */
    constructor(contestSpaceManager: ContestSpaceManager) {
        this.contestSpaceChangedDisposable = contestSpaceManager.onContestSpaceChanged((contestService) => {
            this.rebind(contestService);
        });
        this.rebind(contestSpaceManager.getContestService());
    }

    /**
     * 释放轮询定时器和比赛切换监听器。
     *
     * @returns 无返回值。
     */
    dispose(): void {
        this.disposed = true;
        this.stop();
        this.contestSpaceChangedDisposable.dispose();
    }

    /**
     * 重新绑定当前比赛服务，并重启轮询定时器。
     *
     * @param contestService 新的比赛服务；为空时停止轮询。
     * @returns 无返回值。
     */
    private rebind(contestService: ContestService | undefined): void {
        const version = ++this.bindVersion;
        this.stop();
        this.currentService = contestService;
        this.nextPollAfter = 0;

        if (!contestService) {
            return;
        }

        void this.poll(version);
        this.timer = setInterval(() => {
            void this.poll(version);
        }, POLL_INTERVAL_MS);
    }

    /**
     * 停止当前轮询定时器。
     *
     * @returns 无返回值。
     */
    private stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.inFlight = false;
    }

    /**
     * 执行一次题面更新检查。
     *
     * @param version 当前绑定版本，用于丢弃比赛切换前启动的过期异步任务。
     * @returns 检查完成后 resolve；没有当前比赛、比赛未进行或无变化时直接 resolve。
     */
    private async poll(version: number): Promise<void> {
        if (this.disposed || this.inFlight || version !== this.bindVersion || Date.now() < this.nextPollAfter) {
            return;
        }

        const contestService = this.currentService;
        if (!contestService) {
            return;
        }

        this.inFlight = true;
        try {
            const contestInfo = await contestService.getContestInfo(false);
            if (this.disposed || version !== this.bindVersion || this.currentService !== contestService) {
                return;
            }
            if (!contestInfo || !this.isContestActive(contestInfo.startTime, contestInfo.endTime)) {
                return;
            }

            const result = await contestService.checkProblemUpdates();
            if (this.disposed || version !== this.bindVersion || this.currentService !== contestService) {
                return;
            }
            if (result.updatedProblems.length === 0) {
                return;
            }

            const markdownUpdatedProblems: string[] = [];
            const cphUpdatedProblems = new Set<string>();
            const cphSkippedProblems = new Set<string>();
            const contestFolderPath = contestService.getContestFolderPath();

            for (const update of result.updatedProblems) {
                if (updateExistingProblemMarkdown(contestFolderPath, update.problem, update.nextExtra)) {
                    markdownUpdatedProblems.push(update.problem.info.index);
                }

                const sourceFileNames = contestService.cphService.getExistingSourceFileNames(update.problem.info.index);
                for (const sourceFileName of sourceFileNames) {
                    const syncResult = contestService.cphService.syncProblemSampleTests(
                        sourceFileName,
                        update.problem,
                        update.previousExtra
                    );
                    if (syncResult.updated) {
                        cphUpdatedProblems.add(update.problem.info.index);
                    } else if (syncResult.skipped) {
                        cphSkippedProblems.add(update.problem.info.index);
                    }
                }
            }

            this.showUpdateMessage(
                result.updatedProblems.map(update => update.problem.info.index),
                markdownUpdatedProblems,
                [...cphUpdatedProblems],
                [...cphSkippedProblems]
            );
        } catch (error) {
            this.nextPollAfter = Date.now() + FAILURE_BACKOFF_MS;
            console.error('Error checking contest problem updates:', error);
        } finally {
            this.inFlight = false;
        }
    }

    /**
     * 判断当前时间是否处于比赛进行区间。
     *
     * @param startTime 比赛开始时间戳，单位为毫秒。
     * @param endTime 比赛结束时间戳，单位为毫秒。
     * @returns 当前时间在开始和结束时间之间时返回 true。
     */
    private isContestActive(startTime: number, endTime: number): boolean {
        const now = Date.now();
        return now >= startTime && now <= endTime;
    }

    /**
     * 合并本轮更新结果并向用户展示一条提示。
     *
     * @param updatedProblems 检测到题面或题目信息变化的题号列表。
     * @param markdownUpdatedProblems 已写回 Markdown 文件的题号列表。
     * @param cphUpdatedProblems 已安全同步 CPH 官方样例的题号列表。
     * @param cphSkippedProblems 因存在手动测试等原因跳过 CPH 覆盖的题号列表。
     * @returns 无返回值。
     */
    private showUpdateMessage(
        updatedProblems: string[],
        markdownUpdatedProblems: string[],
        cphUpdatedProblems: string[],
        cphSkippedProblems: string[]
    ): void {
        const parts = [`检测到比赛题面更新：${updatedProblems.join('、')}`];
        if (markdownUpdatedProblems.length > 0) {
            parts.push(`已更新题面文件：${markdownUpdatedProblems.join('、')}`);
        }
        if (cphUpdatedProblems.length > 0) {
            parts.push(`已同步 CPH 样例：${cphUpdatedProblems.join('、')}`);
        }
        if (cphSkippedProblems.length > 0) {
            parts.push(`部分 CPH 文件包含手动测试，未自动覆盖：${cphSkippedProblems.join('、')}`);
        }

        void vscode.window.showInformationMessage(parts.join('；'));
    }
}
