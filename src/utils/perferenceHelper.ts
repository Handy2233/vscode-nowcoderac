import { ConfigurationTarget, ExtensionContext, workspace } from "vscode";
import { COMPILER_CONFIG, NowcoderCompiler } from "../models/models";

const NOWCODER_CONFIGURATION_SECTION = 'nowcoderac';
const LAST_CPH_SAVE_LOCATION_STORAGE_KEY = 'nowcoderac.cph.lastSaveLocation';

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

export const getReuseLastCphSaveLocationPref = (): boolean => {
    return getNowcoderConfiguration().get<boolean>('cph.reuseLastSaveLocation', true);
};

export const getLastCphSaveLocation = (context: ExtensionContext): string | undefined => {
    const folderPath = context.globalState.get<string>(LAST_CPH_SAVE_LOCATION_STORAGE_KEY);
    return folderPath?.trim() ? folderPath : undefined;
};

export const updateLastCphSaveLocation = async (context: ExtensionContext, folderPath: string): Promise<void> => {
    await context.globalState.update(LAST_CPH_SAVE_LOCATION_STORAGE_KEY, folderPath);
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

export const getOpenProblemPreviewToSidePref = (): boolean => {
    return getNowcoderConfiguration().get<boolean>('problem.openPreviewToSide', true);
};

export const getAutoDetectContestConfigPref = (): boolean => {
    return getNowcoderConfiguration().get<boolean>('contest.autoDetectConfig', true);
};
