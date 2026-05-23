import { ConfigurationTarget, workspace } from "vscode";
import { COMPILER_CONFIG, NowcoderCompiler } from "../models/models";

const NOWCODER_CONFIGURATION_SECTION = 'nowcoderac';

const getNowcoderConfiguration = () => workspace.getConfiguration(NOWCODER_CONFIGURATION_SECTION);

export const getDefaultCompilerPref = (): NowcoderCompiler | undefined => {
    const compiler = getNowcoderConfiguration().get<string>('compiler.default', '每次询问');
    if (!compiler || compiler === '每次询问') {
        return undefined;
    }

    if (Object.values(NowcoderCompiler).includes(compiler as NowcoderCompiler)) {
        return compiler as NowcoderCompiler;
    }

    const compilerEntry = Object.entries(COMPILER_CONFIG).find(([, config]) => config.name === compiler);
    return compilerEntry ? compilerEntry[0] as NowcoderCompiler : undefined;
};

export const getAutoGenerateCphProblemPref = (): boolean => {
    return getNowcoderConfiguration().get<boolean>('cph.autoGenerateProblem', true);
};

export const getContestWorkspaceRootPathPref = (): string | undefined => {
    const pref = getNowcoderConfiguration().get<string>('contest.workspaceRootPath', '').trim();
    return pref || undefined;
};

export const updateContestWorkspaceRootPathPref = async (folderPath: string): Promise<void> => {
    await getNowcoderConfiguration().update(
        'contest.workspaceRootPath',
        folderPath,
        ConfigurationTarget.Global
    );
};

export const getAutoDetectContestConfigPref = (): boolean => {
    return getNowcoderConfiguration().get<boolean>('contest.autoDetectConfig', true);
};
