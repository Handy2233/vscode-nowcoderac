import * as vscode from 'vscode';
import * as fs from 'fs';
import { nowcoderService } from './nowcoderService';
import { Problem, SubmissionStatus, NowcoderCompiler, ProblemInfo, ProblemExtra, SubmissionListItem, RealtimeRank, NowcoderConfig, ContestInfo, NowcoderTeam } from '../models/models';
import { CphService } from './cphService';
import { IContestDataProvider } from './contestDataProvider.interface';
import { getProblemExtraSignature, getProblemInfoSignature } from '../utils/problemSignature';

function hasSubmitMetadata(extra: ProblemExtra | undefined): extra is ProblemExtra {
    return !!extra?.questionId && !!extra.tagId && !!extra.subTagId && !!extra.doneQuestionId;
}

export interface ContestProblemUpdate {
    /** 当前缓存中的题目对象，extra 已指向最新题面。 */
    problem: Problem;
    /** 更新前的题面详情，用于对比和兼容旧 CPH 文件。 */
    previousExtra: ProblemExtra;
    /** 更新后的题面详情。 */
    nextExtra: ProblemExtra;
    /** 题面正文、样例或提交参数是否变化。 */
    extraChanged: boolean;
    /** 题目标题、分值等基础信息是否变化。 */
    infoChanged: boolean;
}

export interface ContestProblemUpdateCheckResult {
    /** 本轮检测到变化的题目列表。 */
    updatedProblems: ContestProblemUpdate[];
    /** 首次补齐 extra 缓存但不向用户提示变化的题目列表。 */
    initializedProblems: Problem[];
    /** 拉取失败的题目和错误信息。 */
    failedProblems: { index: string; error: string }[];
}

/**
 * 深拷贝题面详情，避免后续写回缓存时污染变化前的对比基准。
 *
 * @param extra 需要复制的题面详情。
 * @returns 与传入对象内容相同、引用独立的题面详情。
 */
function cloneProblemExtra(extra: ProblemExtra): ProblemExtra {
    return JSON.parse(JSON.stringify(extra)) as ProblemExtra;
}

/**
 * 使用固定并发数执行异步任务。
 *
 * @param items 待处理项目列表。
 * @param limit 最大并发数。
 * @param task 单个项目的异步处理函数。
 * @returns 所有任务完成后 resolve。
 */
async function runWithConcurrency<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (nextIndex < items.length) {
            const item = items[nextIndex++];
            await task(item);
        }
    });
    await Promise.all(workers);
}

/**
 * 管理NowCoder比赛、题目和提交
 */
export class ContestService implements IContestDataProvider {
    private readonly _onProblemsUpdated = new vscode.EventEmitter<Problem[]>();
    private readonly _onSubmissionStatusChanged = new vscode.EventEmitter<SubmissionStatus>();
    private readonly _onSubmissionsUpdated = new vscode.EventEmitter<SubmissionListItem[]>();
    private readonly _onRankUpdated = new vscode.EventEmitter<RealtimeRank | undefined>();

    // 公开事件
    readonly onProblemsUpdated = this._onProblemsUpdated.event;
    readonly onSubmissionStatusChanged = this._onSubmissionStatusChanged.event;
    readonly onSubmissionsUpdated = this._onSubmissionsUpdated.event;
    readonly onRankUpdated = this._onRankUpdated.event;

    readonly cphService: CphService;

    private submissionsCache: SubmissionListItem[] = [];
    private realtimeRankCache: RealtimeRank | undefined = undefined;
    private contestInfoCache: ContestInfo | undefined = undefined;

    private constructor(private readonly contestFolderPath: string, private readonly configPath: string, private readonly config: NowcoderConfig) {
        this.cphService = new CphService(this);
    }

    /**
     * 打开比赛config文件
     * @param contestFolderPath 比赛文件夹路径
     * @param configPath 配置文件路径
     * @returns ContestService实例
     */
    static open(contestFolderPath: string, configPath: string): ContestService {
        contestFolderPath = fs.realpathSync(contestFolderPath);
        configPath = fs.realpathSync(configPath);

        const configData = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(configData) as NowcoderConfig;
        if (!config.contestId) {
            throw new Error('无效的配置文件：配置文件中缺少contestId');
        }
        return new ContestService(contestFolderPath, configPath, config);
    }

    /**
     * 创建比赛config文件（存在覆盖）
     * @param contestFolderPath 比赛文件夹路径
     * @param configPath 配置文件路径
     * @param contestId 比赛ID
     * @returns ContestService实例
     */
    static create(contestFolderPath: string, configPath: string, contestId: number): ContestService {
        if (!fs.existsSync(configPath)) {
            fs.mkdirSync(contestFolderPath, { recursive: true });
        }
        const config: NowcoderConfig = {
            contestId: contestId,
            problems: []
        };
        const configData = JSON.stringify(config, null, 4);
        fs.writeFileSync(configPath, configData, 'utf-8');
        contestFolderPath = fs.realpathSync(contestFolderPath);
        configPath = fs.realpathSync(configPath);
        return new ContestService(contestFolderPath, configPath, config);
    }

    getContestFolderPath(): string {
        return this.contestFolderPath;
    }

    getConfig(): NowcoderConfig {
        return this.config;
    }

    saveConfig(): void {
        const configData = JSON.stringify(this.config, null, 4);
        fs.writeFileSync(this.configPath, configData, 'utf-8');
    }

    /**
     * 获取题目列表，如果没有缓存则刷新（可能不包含extra信息）
     * @param noCache 是否不使用缓存
     * @returns 题目列表，如果失败则是null
     */
    async getProblems(noCache: boolean = false) : Promise<Problem[]> {
        if (noCache || !this.config.problems || this.config.problems.length === 0) {
            // 如果没有题目缓存，尝试刷新题目列表
            const problemListResult = await nowcoderService.getProblemList(this.config.contestId);
            if (!problemListResult.success) {
                throw new Error(`获取题目列表失败: ${problemListResult.error}`);
            }
            const problemList = problemListResult.data!;

            this.config.problems = problemList.data.map((info: ProblemInfo) => {
                const problem: Problem = {
                    info: info,
                    extra: this.config.problems?.find(p => p.info.index === info.index)?.extra
                };
                return problem;
            });
            this.saveConfig();
            this._onProblemsUpdated.fire(this.config.problems);
        }
        
        return this.config.problems;
    }

    /**
     * 获取题目列表信息
     * @param index 题目索引
     * @param noCache 是否不使用缓存
     * @returns 题目详情，如果失败则是null
     */
    async getProblem(index: string, noCache: boolean = false): Promise<Problem | null> {
        const problems = await this.getProblems(noCache);
        const problem = problems.find(p => p.info.index === index);
        if (!problem) {
            return null;
        }
        return problem;
    }

    /**
     * 获取题目的Extra信息
     * @param index 题目索引
     * @param noCache 是否不使用缓存
     * @returns 题目详情，如果失败则是null
     */
    async getProblemExtra(index: string, noCache: boolean = false) : Promise<ProblemExtra> {
        const problem = this.config.problems?.find(p => p.info.index === index);
        if (!problem) {
            throw new Error(`题目"${index}"不存在`);
        }
        if (!problem.extra || noCache) {
            const extraResult = await nowcoderService.getProblemExtra(this.config.contestId, index);
            if (!extraResult.success) {
                throw new Error(`获取题目"${index}"详情失败: ${extraResult.error}`);
            }
            problem.extra = extraResult.data!;
            this.saveConfig();
            this._onProblemsUpdated.fire(this.config.problems!);
        }

        return problem.extra;
    }

    /**
     * 检查当前比赛所有题目的题面和基础信息是否发生变化。
     *
     * 该方法会拉取最新题目列表和每道题的详情，只有题目信息或 ProblemExtra 签名变化时
     * 才记录为 updatedProblems；首次补齐缺失 extra 的题目会放入 initializedProblems。
     *
     * @returns 本轮检查结果，包含发生变化、首次初始化以及拉取失败的题目。
     */
    async checkProblemUpdates(): Promise<ContestProblemUpdateCheckResult> {
        const problemListResult = await nowcoderService.getProblemList(this.config.contestId);
        if (!problemListResult.success || !problemListResult.data) {
            throw new Error(`获取题目列表失败: ${problemListResult.error}`);
        }

        const previousProblems = this.config.problems ?? [];
        const previousByIndex = new Map(previousProblems.map(problem => [problem.info.index, problem]));
        const changeRecords = new Map<string, ContestProblemUpdate>();
        const initializedProblems: Problem[] = [];
        const failedProblems: { index: string; error: string }[] = [];
        let dirty = false;

        const latestProblems = problemListResult.data.data.map((info: ProblemInfo) => {
            const previous = previousByIndex.get(info.index);
            const previousInfoChanged = previous ? getProblemInfoSignature(previous.info) !== getProblemInfoSignature(info) : false;
            const problem: Problem = {
                info: previousInfoChanged || !previous ? info : previous.info,
                extra: previous?.extra
            };

            if (previous && previousInfoChanged) {
                dirty = true;
                if (previous.extra) {
                    changeRecords.set(info.index, {
                        problem,
                        previousExtra: cloneProblemExtra(previous.extra),
                        nextExtra: previous.extra,
                        extraChanged: false,
                        infoChanged: true
                    });
                }
            }

            if (!previous) {
                dirty = true;
            }

            return problem;
        });

        if (latestProblems.length !== previousProblems.length ||
            latestProblems.some((problem, index) => problem.info.index !== previousProblems[index]?.info.index)) {
            dirty = true;
        }

        this.config.problems = latestProblems;

        await runWithConcurrency(latestProblems, 2, async (problem) => {
            try {
                const previousExtra = problem.extra ? cloneProblemExtra(problem.extra) : undefined;
                const extraResult = await nowcoderService.getProblemExtra(this.config.contestId, problem.info.index);
                if (!extraResult.success || !extraResult.data) {
                    failedProblems.push({ index: problem.info.index, error: extraResult.error || '未知错误' });
                    return;
                }

                const nextExtra = extraResult.data;
                if (!previousExtra) {
                    problem.extra = nextExtra;
                    initializedProblems.push(problem);
                    dirty = true;
                    return;
                }

                const extraChanged = getProblemExtraSignature(previousExtra) !== getProblemExtraSignature(nextExtra);
                if (extraChanged) {
                    problem.extra = nextExtra;
                    dirty = true;
                }

                const existingRecord = changeRecords.get(problem.info.index);
                if (extraChanged || existingRecord?.infoChanged) {
                    changeRecords.set(problem.info.index, {
                        problem,
                        previousExtra: existingRecord?.previousExtra ?? previousExtra,
                        nextExtra,
                        extraChanged,
                        infoChanged: existingRecord?.infoChanged ?? false
                    });
                }
            } catch (error) {
                failedProblems.push({
                    index: problem.info.index,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        });

        if (dirty) {
            this.saveConfig();
            this._onProblemsUpdated.fire(this.config.problems);
        }

        return {
            updatedProblems: [...changeRecords.values()],
            initializedProblems,
            failedProblems
        };
    }

    /**
     * 提交解答
     * @param code 代码
     * @param problemIndex 题目索引
     * @param compiler 编程语言
     * @returns 提交的Id，如果失败则是null
     */
    async submitSolution(code: string, problemIndex: string, compiler: NowcoderCompiler): Promise<number> {
        const problem = await this.getProblem(problemIndex);
        if (!problem) {
            throw new Error(`题目"${problemIndex}"不存在`);
        }
        if (!hasSubmitMetadata(problem.extra)) {
            problem.extra = await this.getProblemExtra(problemIndex, true) ?? undefined;
        }
        if (!hasSubmitMetadata(problem.extra)) {
            throw new Error(`题目"${problemIndex}"提交参数解析失败，请重新打开题目或刷新题目内容`);
        }

        const responseResult = await nowcoderService.submitSolution(
            problem.extra.questionId,
            problem.extra.tagId,
            problem.extra.subTagId,
            problem.extra.doneQuestionId,
            code,
            compiler
        );

        if (!responseResult.success) {
            throw new Error(`${responseResult.error}`);
        }

        return responseResult.data!.data;
    }

    /**
     * 确认提交状态，用来触发提交状态更新事件
     * @param status 提交状态
     */
    async confirmSubmissionStatus(status: SubmissionStatus) {
        await this.getSubmissions(true);
        await this.getProblems(true);
        await this.getRealtimeRank(true);
        this._onSubmissionStatusChanged.fire(status);
    }

    /**
     * 获取提交记录
     * @param noCache 是否不使用缓存
     * @returns 提交记录列表，如果失败则是null
     */
    async getSubmissions(noCache: boolean = false): Promise<SubmissionListItem[]> {
        if (noCache || !this.submissionsCache) {
            const submissionsResult = await nowcoderService.getSubmissions(this.config.contestId);
            if (!submissionsResult.success) {
                throw new Error(`获取提交记录失败: ${submissionsResult.error}`);
            }
            this.submissionsCache = submissionsResult.data!.data;
            this._onSubmissionsUpdated.fire(this.submissionsCache);
        }

        return this.submissionsCache;
    }

    /**
     * 获取实时排名数据
     * @param noCache 是否不使用缓存
     * @returns 实时排名数据，如果失败则是null
     */
    async getRealtimeRank(noCache: boolean = false): Promise<RealtimeRank> {
        if (noCache || !this.realtimeRankCache) {
            const rankResult = await nowcoderService.getRealtimeRank(this.config.contestId);
            if (!rankResult.success) {
                throw new Error(`获取实时排名失败: ${rankResult.error}`);
            }
            this.realtimeRankCache = rankResult.data!;
            this._onRankUpdated.fire(this.realtimeRankCache);
        }

        return this.realtimeRankCache;
    }

    /**
     * 获取排行榜窗口所需的指定页数据。
     *
     * 弹窗拥有独立的页码和筛选状态，因此这里不读写侧栏使用的第一页缓存，
     * 避免搜索或翻页后让 TreeView 展示错误的数据集。
     *
     * @param page 页码，从 1 开始。
     * @param onlyMyFollow 是否只显示当前用户关注的参赛者。
     * @param searchUserName 可选的用户名搜索关键字。
     * @param teamId 可选的“我的团队”ID。
     * @returns 指定查询条件下的实时排名数据。
     */
    async getRealtimeRankPage(page: number, onlyMyFollow: boolean, searchUserName?: string, teamId?: number): Promise<RealtimeRank> {
        const rankResult = await nowcoderService.getRealtimeRank(
            this.config.contestId,
            page,
            onlyMyFollow,
            searchUserName,
            teamId
        );
        if (!rankResult.success) {
            throw new Error(`获取实时排名失败: ${rankResult.error}`);
        }

        return rankResult.data!;
    }

    /**
     * 获取当前登录用户加入的竞赛团队。
     */
    async getMyTeams(): Promise<NowcoderTeam[]> {
        const teamResult = await nowcoderService.getMyTeams();
        if (!teamResult.success) {
            throw new Error(`获取我的团队失败: ${teamResult.error}`);
        }
        return teamResult.data!;
    }

    async getContestInfo(noCache: boolean = false): Promise<ContestInfo | undefined> {
        if (noCache || !this.contestInfoCache) {
            const contestInfoResult = await nowcoderService.getContestInfo(this.config.contestId);
            if (!contestInfoResult.success) {
                throw new Error(`获取比赛信息失败: ${contestInfoResult.error}`);
            }
            this.contestInfoCache = contestInfoResult.data!;
        }
        
        return this.contestInfoCache;
    }
}
