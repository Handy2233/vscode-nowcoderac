import * as fs from 'fs';
import * as path from 'path';
import { Problem, ProblemExtra } from '../models/models';

/**
 * 将题目详情渲染为插件写入本地的 Markdown 文本。
 *
 * @param problem 题目基础信息。
 * @param extra 题面正文和样例数据。
 * @returns 可写入 .md 文件的 Markdown 内容。
 */
export function renderProblemMarkdown(problem: Problem, extra: ProblemExtra): string {
    let content = `# ${problem.info.index}. ${problem.info.title}\n\n`;
    content += extra.content;

    if (extra.examples && extra.examples.length > 0) {
        content += '## 样例\n\n';

        extra.examples.forEach((example, index) => {
            content += `### 样例 ${index + 1}\n`;
            content += `**输入**:\n\`\`\`\n${example.input}\n\`\`\`\n\n`;
            content += `**输出**:\n\`\`\`\n${example.output}\n\`\`\`\n\n`;
            if (example.tips) {
                content += `**说明**:  \n\n${example.tips}\n\n`;
            }
        });
    }

    return content;
}

/**
 * 获取题目 Markdown 文件的本地路径。
 *
 * @param contestFolderPath 比赛工作区目录。
 * @param problemIndex 题目编号，例如 A、B、C。
 * @returns 题目 Markdown 文件的绝对路径。
 */
export function getProblemMarkdownPath(contestFolderPath: string, problemIndex: string): string {
    return path.join(contestFolderPath, `${problemIndex}.md`);
}

/**
 * 写入题目 Markdown 文件，必要时创建比赛目录。
 *
 * @param contestFolderPath 比赛工作区目录。
 * @param problem 题目基础信息。
 * @param extra 题面正文和样例数据。
 * @returns 写入成功时返回 true。
 */
export function writeProblemMarkdown(contestFolderPath: string, problem: Problem, extra: ProblemExtra): boolean {
    const filePath = getProblemMarkdownPath(contestFolderPath, problem.info.index);
    fs.mkdirSync(contestFolderPath, { recursive: true });
    fs.writeFileSync(filePath, renderProblemMarkdown(problem, extra), 'utf-8');
    return true;
}

/**
 * 仅更新已经存在的题目 Markdown 文件。
 *
 * 自动刷新流程使用该函数避免为用户尚未打开的题目批量创建 Markdown 文件。
 *
 * @param contestFolderPath 比赛工作区目录。
 * @param problem 题目基础信息。
 * @param extra 最新题面正文和样例数据。
 * @returns 文件存在且内容发生变化并成功写入时返回 true。
 */
export function updateExistingProblemMarkdown(contestFolderPath: string, problem: Problem, extra: ProblemExtra): boolean {
    const filePath = getProblemMarkdownPath(contestFolderPath, problem.info.index);
    if (!fs.existsSync(filePath)) {
        return false;
    }

    const nextContent = renderProblemMarkdown(problem, extra);
    const previousContent = fs.readFileSync(filePath, 'utf-8');
    if (previousContent === nextContent) {
        return false;
    }

    fs.writeFileSync(filePath, nextContent, 'utf-8');
    return true;
}
