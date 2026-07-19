import * as vscode from "vscode";
import { IContestDataProvider } from "../services/contestDataProvider.interface";
import { ContestService } from "../services/contestService";
import { ContestSpaceManager } from "../services/contestSpaceManager";
import { ContestInfo, Problem, RealtimeRank, SubmissionListItem, SubmissionStatus, ProblemExtra, NowcoderCompiler, NowcoderTeam } from "../models/models";

export class ContestServiceEventWrapper implements IContestDataProvider {
    private readonly _onProblemsUpdated = new vscode.EventEmitter<Problem[]>();
    private readonly _onSubmissionStatusChanged = new vscode.EventEmitter<SubmissionStatus>();
    private readonly _onSubmissionsUpdated = new vscode.EventEmitter<SubmissionListItem[]>();
    private readonly _onRankUpdated = new vscode.EventEmitter<RealtimeRank | undefined>();

    readonly onProblemsUpdated = this._onProblemsUpdated.event;
    readonly onSubmissionStatusChanged = this._onSubmissionStatusChanged.event;
    readonly onSubmissionsUpdated = this._onSubmissionsUpdated.event;
    readonly onRankUpdated = this._onRankUpdated.event;

    private problemUpdatedDisposer: vscode.Disposable | undefined;
    private submissionStatusChangedDisposer: vscode.Disposable | undefined;
    private submissionsUpdatedDisposer: vscode.Disposable | undefined;
    private rankUpdatedDisposer: vscode.Disposable | undefined;

    private service: ContestService | undefined;
    private bindVersion = 0;

    constructor(contestSpaceManager: ContestSpaceManager) {
        contestSpaceManager.onContestSpaceChanged((contestService) => {
            this.rebind(contestService);
        });
        this.rebind(contestSpaceManager.getContestService());
    }

    private rebind(contestService: ContestService | undefined) {
        const version = ++this.bindVersion;
        this.service = contestService;
        this.problemUpdatedDisposer?.dispose();
        this.submissionStatusChangedDisposer?.dispose();
        this.submissionsUpdatedDisposer?.dispose();
        this.rankUpdatedDisposer?.dispose();

        if (contestService) {
            this.problemUpdatedDisposer = contestService.onProblemsUpdated((problems) => {
                this._onProblemsUpdated.fire(problems);
            });

            this.submissionStatusChangedDisposer = contestService.onSubmissionStatusChanged((status) => {
                this._onSubmissionStatusChanged.fire(status);
            });

            this.submissionsUpdatedDisposer = contestService.onSubmissionsUpdated((submissions) => {
                this._onSubmissionsUpdated.fire(submissions);
            });

            this.rankUpdatedDisposer = contestService.onRankUpdated((rank) => {
                this._onRankUpdated.fire(rank);
            });
        }
        this.refireAllEvents(version);
    }

    private async refireAllEvents(version: number) {
        const service = this.service;
        if (!service) {
            this._onProblemsUpdated.fire([]);
            this._onSubmissionsUpdated.fire([]);
            this._onRankUpdated.fire(undefined);
            return;
        }

        this._onProblemsUpdated.fire([]);
        this._onSubmissionsUpdated.fire([]);
        this._onRankUpdated.fire(undefined);

        try {
            const problems = await service.getProblems(true);
            if (this.isCurrentBinding(version, service)) {
                this._onProblemsUpdated.fire(problems);
            }
        } catch (error) {
            console.error('刷新题目列表失败:', error);
        }

        try {
            const submissions = await service.getSubmissions(true);
            if (this.isCurrentBinding(version, service)) {
                this._onSubmissionsUpdated.fire(submissions);
            }
        } catch (error) {
            console.error('刷新提交列表失败:', error);
        }

        try {
            const rank = await service.getRealtimeRank(true);
            if (this.isCurrentBinding(version, service)) {
                this._onRankUpdated.fire(rank);
            }
        } catch (error) {
            console.error('刷新排名失败:', error);
        }
    }

    private isCurrentBinding(version: number, service: ContestService): boolean {
        return this.bindVersion === version && this.service === service;
    }

    async getProblems(noCache: boolean = false): Promise<Problem[]> {
        return this.service ? await this.service.getProblems(noCache) : [];
    }

    async getProblem(index: string, noCache: boolean = false): Promise<Problem | null> {
        return this.service ? await this.service.getProblem(index, noCache) : null;
    }

    async getProblemExtra(index: string, noCache: boolean = false): Promise<ProblemExtra | undefined> {
        if (!this.service) {
            return Promise.resolve(undefined);

        }
        return await this.service.getProblemExtra(index, noCache);
    }

    async getSubmissions(noCache: boolean = false): Promise<SubmissionListItem[]> {
        return this.service ? await this.service.getSubmissions(noCache) : [];
    }

    async getRealtimeRank(noCache: boolean = false): Promise<RealtimeRank | undefined> {
        if (!this.service) {
            return Promise.resolve(undefined);
        }
        return await this.service.getRealtimeRank(noCache);
    }

    async getRealtimeRankPage(page: number, onlyMyFollow: boolean, searchUserName?: string, teamId?: number): Promise<RealtimeRank | undefined> {
        if (!this.service) {
            return Promise.resolve(undefined);
        }
        return await this.service.getRealtimeRankPage(page, onlyMyFollow, searchUserName, teamId);
    }

    async getMyTeams(): Promise<NowcoderTeam[]> {
        return this.service ? await this.service.getMyTeams() : [];
    }

    async getContestInfo(noCache: boolean = false): Promise<ContestInfo | undefined> {
        if (!this.service) {
            return Promise.resolve(undefined);
        }
        return await this.service.getContestInfo(noCache);
    }
}
