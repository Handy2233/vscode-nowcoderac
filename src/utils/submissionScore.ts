import { ContestInfo } from '../models/models';

/**
 * 判断比赛是否采用牛客周赛计分制。
 */
export function isWeeklyContest(contestInfo: ContestInfo | undefined): boolean {
    return contestInfo?.rankType === 4 || Boolean(contestInfo?.rankTypeInfo?.includes('周赛'));
}

/**
 * 将提交得分格式化为紧凑文本，最多保留两位小数。
 */
export function formatContestScore(score: number): string {
    if (!Number.isFinite(score)) {
        return '0';
    }
    return Number.isInteger(score)
        ? String(score)
        : score.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * 格式化一条周赛提交的“得分/满分”。
 */
export function formatSubmissionScore(score: number, fullScore?: number): string {
    const scoreText = formatContestScore(score);
    return Number.isFinite(fullScore)
        ? `${scoreText}/${formatContestScore(fullScore!)}分`
        : `${scoreText}分`;
}

/**
 * 根据判题接口返回的通过比例计算该次周赛提交得分。
 */
export function calculateSubmissionScore(rightHundredRate: number, fullScore: number): number {
    const rate = Number.isFinite(rightHundredRate) ? rightHundredRate : 0;
    const maximum = Number.isFinite(fullScore) ? fullScore : 0;
    return Number(((rate * maximum) / 100).toFixed(2));
}
