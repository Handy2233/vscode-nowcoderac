import path from "path";
import crypto from 'crypto';
import fs from 'fs';
import { COMPILER_CONFIG, CphProb, CphTest, Problem, ProblemExtra } from "../models/models";
import { ContestService } from "./contestService";
import { getCphTestSignature, getProblemExampleSignature, getProblemExtraSignature } from "../utils/problemSignature";

export interface CphSampleSyncResult {
    updated: boolean;
    skipped: boolean;
    reason?: string;
}

export class CphService {
    private contestManager: ContestService;

    constructor(contestManager: ContestService) {
        this.contestManager = contestManager;
    }

    /**
     * 获取prob文件路径
     * @param srcFileName 源文件名
     * @returns prob文件路径
     */
    private getProbPath(srcFileName: string, cphSaveLocation?: string) : string | null {
        const contestPath = this.contestManager.getContestFolderPath();
        if (!contestPath) {
            return null;
        }

        const srcPath = path.join(contestPath, srcFileName);
        const hash = crypto
            .createHash('md5')
            .update(srcPath)
            .digest('hex')
            .substr(0);
        const baseProbName = `.${srcFileName}_${hash}.prob`;
        const cphFolder = cphSaveLocation ?? path.join(contestPath, '.cph');
        return path.join(cphFolder, baseProbName);
    }

    /**
     * 读取现有的prob文件
     * @param srcFileName 源文件名
     * @returns prob模型
     */
    readExistingProb(srcFileName: string, cphSaveLocation?: string) : CphProb | undefined {
        const probPath = this.getProbPath(srcFileName, cphSaveLocation);
        if (!probPath) {
            return undefined;
        }
        try {
            const prob = fs.readFileSync(probPath, 'utf-8');
            const probObj = JSON.parse(prob) as CphProb;
            return probObj;
        } catch (error) {
            console.error(`Error reading prob file: ${error}`);
            return undefined;
        }
    }

    /**
     * 保存prob文件
     * @param srcFileName 源文件名
     * @param prob prob模型
     * @returns 是否成功保存
     */
    saveProb(srcFileName: string, prob: CphProb, cphSaveLocation?: string) : boolean {
        const probPath = this.getProbPath(srcFileName, cphSaveLocation);
        if (!probPath) {
            return false;
        }
        try {
            const probDir = path.dirname(probPath);
            if (!fs.existsSync(probDir)) {
                fs.mkdirSync(probDir, { recursive: true });
            }
            fs.writeFileSync(probPath, JSON.stringify(prob), 'utf-8');
            return true;
        } catch (error) {
            console.error(`Error saving prob file: ${error}`);
            return false;
        }
    }

    /**
     * 创建新的prob文件
     * @param srcFileName 源文件名
     * @param problem 题目模型
     * @returns prob模型
     */
    createProb(srcFileName: string, problem: Problem) : CphProb | null {
        const basePath = this.contestManager.getContestFolderPath();
        if (!basePath) {
            return null;
        }
        const srcPath = path.join(basePath, srcFileName);
        const prob: CphProb = {
            name: problem.info.index + '. ' + problem.info.title,
            url: srcPath,
            tests: [],
            interactive: false,
            timeLimit: 3000,
            memoryLimit: 1024,
            srcPath: srcPath,
            group: "local",
            local: true
        };
        
        if (!problem.extra) {
            return prob;
        }

        prob.tests = this.createOfficialTests(problem.extra);
        prob.nowcoderac = this.createMetadata(problem);

        return prob;
    }
    /**
     * 查找当前比赛目录下某道题已经创建过的代码文件。
     *
     * @param problemIndex 题目编号，例如 A、B、C。
     * @returns 已存在的源文件名列表，不包含路径。
     */
    getExistingSourceFileNames(problemIndex: string): string[] {
        const contestPath = this.contestManager.getContestFolderPath();
        const fileNames = new Set(Object.values(COMPILER_CONFIG).map(config => `${problemIndex}.${config.ext}`));
        return [...fileNames].filter(fileName => fs.existsSync(path.join(contestPath, fileName)));
    }

    /**
     * 将题目的最新官方样例同步到指定源文件对应的 CPH prob 文件。
     *
     * 同步逻辑是保守的：如果 prob 文件已有 nowcoderac metadata，则只替换能确认属于旧官方样例
     * 的测试；如果没有 metadata，则只转换可识别的旧插件文件，其他来源的 prob 文件直接忽略。
     *
     * @param srcFileName 源文件名，例如 A.cpp。
     * @param problem 包含最新 ProblemExtra 的题目模型。
     * @param previousExtra 更新前的题面详情，用于兼容没有 metadata 的旧 prob 文件。
     * @returns 同步结果，说明是否写入文件、是否因风险跳过。
     */
    syncProblemSampleTests(
        srcFileName: string,
        problem: Problem,
        previousExtra?: ProblemExtra,
        cphSaveLocation?: string
    ): CphSampleSyncResult {
        if (!problem.extra) {
            return { updated: false, skipped: true, reason: 'missing problem extra' };
        }

        const probPath = this.getProbPath(srcFileName, cphSaveLocation);
        if (!probPath) {
            return { updated: false, skipped: true, reason: 'missing prob path' };
        }

        if (!fs.existsSync(probPath)) {
            const createdProb = this.createProb(srcFileName, problem);
            return { updated: createdProb ? this.saveProb(srcFileName, createdProb, cphSaveLocation) : false, skipped: false };
        }

        const existingProb = this.readExistingProb(srcFileName, cphSaveLocation);
        if (!existingProb) {
            return { updated: false, skipped: true, reason: 'unreadable prob file' };
        }

        const nextTests = this.createOfficialTests(problem.extra, existingProb.tests);
        const nextSampleSignatures = problem.extra.examples.map(getProblemExampleSignature);
        const previousSampleSignatures = existingProb.nowcoderac?.sampleSignatures;

        if (previousSampleSignatures && previousSampleSignatures.length > 0) {
            const syncResult = this.syncKnownOfficialSamples(existingProb, problem, nextTests, previousSampleSignatures);
            if (syncResult.skipped) {
                return syncResult;
            }
            return this.saveIfChanged(srcFileName, existingProb, syncResult.prob!, cphSaveLocation);
        }

        if (existingProb.tests.length === 0) {
            return this.overwriteProbWithOfficialSamples(srcFileName, existingProb, problem, nextTests, nextSampleSignatures, cphSaveLocation);
        }

        if (previousExtra && this.testsMatchExamples(existingProb.tests, previousExtra.examples)) {
            return this.convertLegacyProb(srcFileName, existingProb, problem, nextTests, nextSampleSignatures, cphSaveLocation);
        }

        return { updated: false, skipped: false, reason: 'ignored prob without nowcoderac metadata' };
    }

    /**
     * 根据官方样例创建 CPH 测试项。
     *
     * @param extra 最新题面详情。
     * @param previousTests 旧测试列表，用于尽量复用原有测试 id。
     * @returns 与官方样例一一对应的 CPH 测试列表。
     */
    private createOfficialTests(extra: ProblemExtra, previousTests: CphTest[] = []): CphTest[] {
        const now = Date.now();
        return extra.examples.map((example, index) => ({
            id: previousTests[index]?.id ?? now + index,
            input: example.input,
            output: example.output
        }));
    }

    /**
     * 创建写入 CPH prob 的 NowcoderAC 样例来源 metadata。
     *
     * @param problem 包含题号和最新题面详情的题目模型。
     * @returns 可序列化到 prob 文件中的 metadata。
     */
    private createMetadata(problem: Problem) {
        return {
            problemIndex: problem.info.index,
            problemExtraSignature: getProblemExtraSignature(problem.extra!),
            sampleSignatures: problem.extra!.examples.map(getProblemExampleSignature),
            updatedAt: Date.now()
        };
    }

    /**
     * 覆写没有样例的空 prob 文件。
     *
     * 空测试通常来自生成 prob 时题面详情尚未拉取成功；这种情况下没有用户测试需要保留，
     * 可以直接写入最新官方样例和 metadata。
     *
     * @param srcFileName 源文件名，用于定位 prob 文件。
     * @param existingProb 当前磁盘上的 prob 内容。
     * @param problem 包含最新题面详情的题目模型。
     * @param nextOfficialTests 最新官方样例转换出的 CPH 测试项。
     * @param nextSampleSignatures 最新官方样例签名。
     * @returns 写入结果。
     */
    private overwriteProbWithOfficialSamples(
        srcFileName: string,
        existingProb: CphProb,
        problem: Problem,
        nextOfficialTests: CphTest[],
        nextSampleSignatures: string[],
        cphSaveLocation?: string
    ): CphSampleSyncResult {
        const nextProb = this.createSyncedProb(existingProb, problem, nextOfficialTests, nextSampleSignatures);
        return this.saveIfChanged(srcFileName, existingProb, nextProb, cphSaveLocation);
    }

    /**
     * 将旧版本插件生成的无 metadata prob 文件转换为新版格式。
     *
     * 只有测试项完全匹配更新前官方样例时才会调用该方法；无法证明来源的无 metadata 文件会被忽略。
     *
     * @param srcFileName 源文件名，用于定位 prob 文件。
     * @param existingProb 当前磁盘上的旧格式 prob 内容。
     * @param problem 包含最新题面详情的题目模型。
     * @param nextOfficialTests 最新官方样例转换出的 CPH 测试项。
     * @param nextSampleSignatures 最新官方样例签名。
     * @returns 转换写入结果。
     */
    private convertLegacyProb(
        srcFileName: string,
        existingProb: CphProb,
        problem: Problem,
        nextOfficialTests: CphTest[],
        nextSampleSignatures: string[],
        cphSaveLocation?: string
    ): CphSampleSyncResult {
        const nextProb = this.createSyncedProb(existingProb, problem, nextOfficialTests, nextSampleSignatures);
        return this.saveIfChanged(srcFileName, existingProb, nextProb, cphSaveLocation);
    }

    /**
     * 基于旧 prob 创建带新版 metadata 的同步后 prob。
     *
     * @param existingProb 当前磁盘上的 prob 内容。
     * @param problem 包含最新题面详情的题目模型。
     * @param tests 应写入的 CPH 测试项。
     * @param sampleSignatures 与 tests 对应的官方样例签名。
     * @returns 尚未写入磁盘的新 prob 内容。
     */
    private createSyncedProb(
        existingProb: CphProb,
        problem: Problem,
        tests: CphTest[],
        sampleSignatures: string[]
    ): CphProb {
        return {
            ...existingProb,
            name: problem.info.index + '. ' + problem.info.title,
            tests,
            nowcoderac: {
                problemIndex: problem.info.index,
                problemExtraSignature: getProblemExtraSignature(problem.extra!),
                sampleSignatures,
                updatedAt: Date.now()
            }
        };
    }

    /**
     * 基于 metadata 中记录的旧官方样例签名更新 prob 文件。
     *
     * @param existingProb 当前磁盘上的 prob 内容。
     * @param problem 包含最新题面详情的题目模型。
     * @param nextOfficialTests 最新官方样例转换出的 CPH 测试项。
     * @param previousSampleSignatures 上次同步时记录的官方样例签名。
     * @returns 同步结果；成功时携带尚未写入磁盘的 next prob。
     */
    private syncKnownOfficialSamples(
        existingProb: CphProb,
        problem: Problem,
        nextOfficialTests: CphTest[],
        previousSampleSignatures: string[]
    ): CphSampleSyncResult & { prob?: CphProb } {
        const officialTestIndexes = new Set<number>();
        for (const signature of previousSampleSignatures) {
            const index = existingProb.tests.findIndex((test, testIndex) => {
                return !officialTestIndexes.has(testIndex) && getCphTestSignature(test) === signature;
            });
            if (index >= 0) {
                officialTestIndexes.add(index);
            }
        }

        if (officialTestIndexes.size === 0 && existingProb.tests.length > 0) {
            return { updated: false, skipped: true, reason: 'official samples were modified manually' };
        }

        const manualTests = existingProb.tests.filter((_, index) => !officialTestIndexes.has(index));
        const nextProb: CphProb = {
            ...existingProb,
            name: problem.info.index + '. ' + problem.info.title,
            tests: [...nextOfficialTests, ...manualTests],
            nowcoderac: this.createMetadata(problem)
        };
        return { updated: false, skipped: false, prob: nextProb };
    }

    /**
     * 判断 CPH 测试列表是否与一组官方样例完全一致。
     *
     * @param tests CPH 测试列表。
     * @param examples 官方样例列表。
     * @returns 数量和每个输入输出签名都一致时返回 true。
     */
    private testsMatchExamples(tests: CphTest[], examples: ProblemExtra['examples']): boolean {
        if (tests.length !== examples.length) {
            return false;
        }
        return tests.every((test, index) => getCphTestSignature(test) === getProblemExampleSignature(examples[index]));
    }

    /**
     * 仅在 prob 内容变化时写入磁盘。
     *
     * @param srcFileName 源文件名，用于定位 prob 文件。
     * @param previousProb 写入前的 prob 内容。
     * @param nextProb 准备写入的 prob 内容。
     * @returns 写入结果；内容无变化时 updated 为 false。
     */
    private saveIfChanged(
        srcFileName: string,
        previousProb: CphProb,
        nextProb: CphProb,
        cphSaveLocation?: string
    ): CphSampleSyncResult {
        if (JSON.stringify(previousProb) === JSON.stringify(nextProb)) {
            return { updated: false, skipped: false };
        }
        return { updated: this.saveProb(srcFileName, nextProb, cphSaveLocation), skipped: false };
    }
}
