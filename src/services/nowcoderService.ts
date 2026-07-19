import * as vscode from 'vscode';
import { httpClient } from './httpClient';
import { parseContestPage, parseProblemPage } from '../utils/htmlParser';
import { SubmissionResponse, SubmissionStatus, NowcoderCompiler, COMPILER_CONFIG, ProblemExtra, ContestProblemList, Response, SubmissionList, ApiResult, RealtimeRank, ContestInfo, AcmCurrentUser, ContestMessageList, ContestMessagePing, NowcoderTeam } from '../models/models';

/**
 * NowCoder服务，封装与NowCoder平台的API交互
 */
export class NowcoderService {
    private static readonly BASE_URL = 'https://ac.nowcoder.com';

    private tokenExpired<T>(): ApiResult<T> {
        vscode.commands.executeCommand('nowcoderac.logout');
        return ApiResult.failure('登录信息已过期，请重新登录');
    }

    /**
     * 获取当前登录的牛客竞赛用户。
     */
    async getCurrentAcmUser(): Promise<ApiResult<AcmCurrentUser>> {
        try {
            const url = `${NowcoderService.BASE_URL}/`;
            const { status, html } = await httpClient.getHtml(url);
            if (status === 301) {
                return this.tokenExpired();
            }

            const uid = html.match(/ownerId:\s*['"](\d+)['"]/)?.[1];
            const name = html.match(/ownerName:\s*['"]([^'"]+)['"]/)?.[1];
            if (!uid) {
                return ApiResult.failure('解析当前牛客用户失败，请确认已登录');
            }

            return ApiResult.success({
                uid: Number(uid),
                name: name || 'NowCoder User'
            });
        } catch (error) {
            console.error('Error fetching current ACM user:', error);
            return ApiResult.failure('网络错误: ' + (error instanceof Error ? error.message : String(error)));
        }
    }

    /**
     * 获取比赛信息
     * @param contestId 比赛ID
     * @returns 比赛信息
     */
    async getContestInfo(contestId: number) : Promise<ApiResult<ContestInfo>> {
        try {
            const url = `${NowcoderService.BASE_URL}/acm/contest/${contestId}`;
            const { status, html } = await httpClient.getHtml(url);
            if (status === 301) {
                return this.tokenExpired();
            }
            const contestInfo = parseContestPage(html);
            if (contestInfo) {
                return ApiResult.success(contestInfo);
            } else {
                return ApiResult.failure('解析比赛信息失败，可能是没登录？');
            }
        } catch (error) {
            console.error(`Error fetching contest info for ${contestId}:`, error);
            return ApiResult.failure('网络错误: ' + (error instanceof Error ? error.message : String(error)));
        }
    }

    /**
     * 获取比赛标题
     * @param contestId 比赛ID
     * @returns 比赛标题
     */
    async getContestTitle(contestId: number): Promise<ApiResult<string>> {
        try {
            const url = `${NowcoderService.BASE_URL}/acm/contest/contest-info?id=${contestId}`;
            const response = await httpClient.get<Response<Partial<ContestInfo>>>(url);
            if (response && response.code === 0 && response.data) {
                const title = response.data.name || response.data.competitionName_var;
                if (title) {
                    return ApiResult.success(title);
                }
                return ApiResult.failure('比赛标题为空');
            }
            console.error('Failed to get contest title:', response?.msg);
            return ApiResult.failure(response?.msg || '未知错误');
        } catch (error) {
            console.error(`Error fetching contest title for ${contestId}:`, error);
            return ApiResult.failure('网络错误: ' + (error instanceof Error ? error.message : String(error)));
        }
    }
    
    /**
     * 获取比赛的题目列表
     * @param contestId 比赛ID
     * @returns 题目列表响应
     */
    async getProblemList(contestId: number): Promise<ApiResult<ContestProblemList>> {
        try {
            const url = `${NowcoderService.BASE_URL}/acm/contest/problem-list?id=${contestId}`;
            const response = await httpClient.get<Response<ContestProblemList>>(url);
            if (response && response.code === 0 && response.data) {
                return ApiResult.success(response.data);
            }
            console.error('Failed to get problem list:', response?.msg);
            return ApiResult.failure(response?.msg || '未知错误');
        } catch (error) {
            console.error('Error fetching problem list:', error);
            return ApiResult.failure('网络错误: ' + (error instanceof Error ? error.message : String(error)));
        }
    }
    
    /**
     * 获取题目详情
     * @param contestId 比赛ID
     * @param questionIndex 题目索引（例如: 'A', 'B'）
     * @returns 题目详情
     */
    async getProblemExtra(contestId: number, questionIndex: string): Promise<ApiResult<ProblemExtra>> {
        try {
            const url = `${NowcoderService.BASE_URL}/acm/contest/${contestId}/${questionIndex}`;
            const { status, html } = await httpClient.getHtml(url);
            if (status === 301) {
                return this.tokenExpired();
            }
            
            const parsedData = parseProblemPage(html);
            
            return ApiResult.success(parsedData);
        } catch (error) {
            console.error(`Error fetching problem detail for ${contestId}/${questionIndex}:`, error);
            return ApiResult.failure('网络错误: ' + (error instanceof Error ? error.message : String(error)));
        }
    }
    
    /**
     * 提交代码
     * @param questionId 题目ID
     * @param tagId 标签ID
     * @param subTagId 子标签ID
     * @param doneQuestionId 完成的题目ID
     * @param content 代码内容
     * @param compiler 编译器
     * @returns 提交响应
     */
    async submitSolution(
        questionId: string, 
        tagId: string, 
        subTagId: string, 
        doneQuestionId: string, 
        content: string, 
        compiler: NowcoderCompiler
    ): Promise<ApiResult<SubmissionResponse>> {
        try {
            const url = `${NowcoderService.BASE_URL}/nccommon/submit_cd`;
            const languageConfig = COMPILER_CONFIG[compiler];
            
            const formData = {
                questionId,
                tagId,
                subTagId,
                content,
                language: languageConfig.id,
                languageName: languageConfig.name,
                doneQuestionId
            };
            
            const response = await httpClient.postForm<SubmissionResponse>(url, formData);
            if (response.code === 1 && response.msg === '请先登录') {
                return this.tokenExpired();
            }
            if (response.code !== 0) {
                return ApiResult.failure(response.msg || `提交失败，错误码: ${response.code}`);
            }
            if (!Number.isFinite(response.data)) {
                return ApiResult.failure('提交失败：牛客未返回提交ID');
            }
            return ApiResult.success(response);
        } catch (error) {
            console.error(`Error submitting solution for ${questionId}:`, error);
            return ApiResult.failure('网络错误: ' + (error instanceof Error ? error.message : String(error)));
        }
    }
    
    /**
     * 获取提交状态
     * @param submissionId 提交ID
     * @param tagId 标签ID
     * @param subTagId 子标签ID
     * @returns 提交状态
     */
    async getSubmissionStatus(submissionId: number, tagId: string, subTagId: string): Promise<ApiResult<SubmissionStatus>> {
        try {
            const url = `${NowcoderService.BASE_URL}/nccommon/status?submissionId=${submissionId}&tagId=${tagId}&subTagId=${subTagId}`;
            const status = await httpClient.get<SubmissionStatus>(url);
            return ApiResult.success(status);
        } catch (error) {
            console.error(`Error fetching submission status for ${submissionId}:`, error);
            return ApiResult.failure('网络错误: ' + (error instanceof Error ? error.message : String(error)));
        }
    }

    /**
     * 获取指定比赛ID的提交记录。
     * @param contestId 比赛ID。
     * @returns 提交记录列表。
     */
    async getSubmissions(contestId: number): Promise<ApiResult<SubmissionList>> {
        try {
            const url = `${NowcoderService.BASE_URL}/acm-heavy/acm/contest/status-list?id=${contestId}&pageSize=50&onlyMyStatusFilter=true`;
            const response = await httpClient.get<Response<SubmissionList>>(url);

            if (response && response.code === 0 && response.data) {
                return ApiResult.success(response.data);
            } else {
                console.error('Failed to get submissions:', response?.msg);
                return ApiResult.failure(response?.msg || '未知错误');
            }
        } catch (error) {
            console.error('Error fetching submissions:', error);
            return ApiResult.failure('网络错误: ' + (error instanceof Error ? error.message : String(error)));
        }
    }

    async getRealtimeRank(contestId: number, page: number = 1, onlyMyFollow: boolean = false, searchUserName: string | undefined = undefined, teamId: number | undefined = undefined): Promise<ApiResult<RealtimeRank>> {
        try {
            var url = `${NowcoderService.BASE_URL}/acm-heavy/acm/contest/real-time-rank-data?id=${contestId}&page=${page}&onlyMyFollow=${onlyMyFollow}&limit=0`;
            if (searchUserName) {
                url += `&searchUserName=${encodeURIComponent(searchUserName)}`;
            }
            if (teamId) {
                url += `&teamId=${encodeURIComponent(teamId)}`;
            }
            const response = await httpClient.get<Response<RealtimeRank>>(url);
            if (response && response.code === 0 && response.data) {
                return ApiResult.success(response.data);
            }
            console.error('Failed to get realtime rank:', response?.msg);
            return ApiResult.failure(response?.msg || '未知错误');
        } catch (error) {
            console.error('Error fetching realtime rank:', error);
            return ApiResult.failure('网络错误: ' + (error instanceof Error ? error.message : String(error)));
        }
    }

    /**
     * 获取当前登录用户加入的竞赛团队。
     */
    async getMyTeams(): Promise<ApiResult<NowcoderTeam[]>> {
        try {
            const url = `${NowcoderService.BASE_URL}/acm/team/my-team-list?teamType=1`;
            const response = await httpClient.get<Response<NowcoderTeam[]>>(url);
            if (response && response.code === 0 && Array.isArray(response.data)) {
                return ApiResult.success(response.data);
            }
            console.error('Failed to get my teams:', response?.msg);
            return ApiResult.failure(response?.msg || '未知错误');
        } catch (error) {
            console.error('Error fetching my teams:', error);
            return ApiResult.failure('网络错误: ' + (error instanceof Error ? error.message : String(error)));
        }
    }

    async pingContestMessages(contestId: number, uid: number, previousMessageId: number): Promise<ApiResult<ContestMessagePing>> {
        try {
            const url = `${NowcoderService.BASE_URL}/acm/contest/ping-to-nc`;
            const response = await httpClient.postForm<Response<ContestMessagePing>>(url, {
                contestId,
                uid,
                previousMessageId
            });
            if (response && response.code === 0 && response.data) {
                return ApiResult.success(response.data);
            }
            if (response?.code === 999) {
                return this.tokenExpired();
            }
            console.error('Failed to ping contest messages:', response?.msg);
            return ApiResult.failure(response?.msg || '轮询竞赛消息失败');
        } catch (error) {
            console.error(`Error pinging contest messages for ${contestId}/${uid}:`, error);
            return ApiResult.failure('网络错误: ' + (error instanceof Error ? error.message : String(error)));
        }
    }

    async getContestMessages(contestId: number, uid: number, previousMessageId: number = -1, page: number = 1, pageSize: number = 50): Promise<ApiResult<ContestMessageList>> {
        try {
            const url = `${NowcoderService.BASE_URL}/acm/contest/messages?contestId=${contestId}&uid=${uid}&previousMessageId=${previousMessageId}&page=${page}&pageSize=${pageSize}`;
            const response = await httpClient.get<Response<ContestMessageList>>(url);
            if (response && response.code === 0 && response.data) {
                return ApiResult.success(response.data);
            }
            if (response?.code === 999) {
                return this.tokenExpired();
            }
            console.error('Failed to get contest messages:', response?.msg);
            return ApiResult.failure(response?.msg || '获取竞赛消息失败');
        } catch (error) {
            console.error(`Error fetching contest messages for ${contestId}/${uid}:`, error);
            return ApiResult.failure('网络错误: ' + (error instanceof Error ? error.message : String(error)));
        }
    }

    async isSessionValid(): Promise<boolean | undefined> {
        try {
            const url = `${NowcoderService.BASE_URL}/nccommon/token/login-other-place`;
            const response = await httpClient.get<Response<void>>(url);
            return response && response.code === 0;
        } catch (error) {
            console.error('Error checking session validity:', error);
            return undefined;
        }
    }
}

// 导出单例
export const nowcoderService = new NowcoderService();
