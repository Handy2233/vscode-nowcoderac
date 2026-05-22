import crypto from 'crypto';
import { CphTest, ProblemExample, ProblemExtra, ProblemInfo } from '../models/models';

/**
 * 标准化用于签名比较的文本。
 *
 * @param value 原始文本，可以为空。
 * @returns 统一换行并去掉首尾空白后的文本。
 */
function normalizeText(value: string | null | undefined): string {
    return (value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

/**
 * 计算稳定的 SHA-256 摘要。
 *
 * @param value 需要签名的可 JSON 序列化值。
 * @returns 十六进制摘要字符串。
 */
function digest(value: unknown): string {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * 计算题目基础信息签名。
 *
 * @param info 题目列表接口返回的基础信息。
 * @returns 可用于判断题目标题、分值等关键字段是否变化的签名。
 */
export function getProblemInfoSignature(info: ProblemInfo): string {
    return digest({
        index: info.index,
        problemId: info.problemId,
        score: info.score,
        tagId: info.tagId,
        title: info.title
    });
}

/**
 * 计算完整题面详情签名。
 *
 * @param extra 题面正文、样例和提交参数。
 * @returns 可用于判断题面、样例或提交参数是否变化的签名。
 */
export function getProblemExtraSignature(extra: ProblemExtra): string {
    return digest({
        tagId: extra.tagId,
        questionId: extra.questionId,
        subTagId: extra.subTagId,
        doneQuestionId: extra.doneQuestionId,
        content: normalizeText(extra.content),
        examples: extra.examples.map(example => ({
            input: normalizeText(example.input),
            output: normalizeText(example.output),
            tips: normalizeText(example.tips)
        }))
    });
}

/**
 * 计算官方样例签名。
 *
 * @param example 牛客题面中的一个官方样例。
 * @returns 仅基于输入输出生成的签名。
 */
export function getProblemExampleSignature(example: ProblemExample): string {
    return digest({
        input: normalizeText(example.input),
        output: normalizeText(example.output)
    });
}

/**
 * 计算 CPH 测试项签名。
 *
 * @param test CPH prob 文件中的一个测试项。
 * @returns 仅基于输入输出生成的签名。
 */
export function getCphTestSignature(test: CphTest): string {
    return digest({
        input: normalizeText(test.input),
        output: normalizeText(test.output)
    });
}
