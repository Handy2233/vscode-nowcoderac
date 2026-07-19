import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { NowcoderTeam, RealtimeRank } from '../models/models';
import { IContestDataProvider } from '../services/contestDataProvider.interface';

interface RankBoardQuery {
    page: number;
    onlyMyFollow: boolean;
    searchUserName?: string;
    teamId?: number;
}

type RankBoardMessage =
    | { type: 'ready' }
    | { type: 'refresh' }
    | { type: 'search'; value: string }
    | { type: 'setFollow'; value: boolean }
    | { type: 'setTeam'; teamId?: number }
    | { type: 'changePage'; page: number }
    | { type: 'locateMe' };

class RankBoardDocument implements vscode.CustomDocument {
    constructor(readonly uri: vscode.Uri) { }
    dispose(): void { }
}

/**
 * 在模态自定义 Webview 编辑器中展示完整的牛客实时排名表格。
 *
 * Panel 保持单例，并通过消息传递维护搜索、关注筛选和分页状态。
 * 排名查询使用独立数据通道，不会覆盖侧栏排行榜的第一页缓存。
 */
export class RankBoardPanel implements vscode.Disposable, vscode.CustomReadonlyEditorProvider<RankBoardDocument> {
    private static readonly VIEW_TYPE = 'nowcoderac.realtimeRankBoardEditor';
    /** VS Code 内部 IEditorService.MODAL_GROUP；1.110 起用于定向打开模态编辑器。 */
    private static readonly MODAL_GROUP = -4;
    private panel: vscode.WebviewPanel | undefined;
    private panelDisposables: vscode.Disposable[] = [];
    private readonly rankUpdatedDisposable: vscode.Disposable;
    private readonly customEditorRegistration: vscode.Disposable;
    private readonly documentUri = vscode.Uri.from({
        scheme: 'nowcoderac-rank',
        path: '/realtime.nowcoder-rankboard'
    });
    private query: RankBoardQuery = {
        page: 1,
        onlyMyFollow: false
    };
    private lastRank: RealtimeRank | undefined;
    private myTeams: NowcoderTeam[] | undefined;
    private requestVersion = 0;

    constructor(
        private readonly dataProvider: IContestDataProvider,
        private readonly extensionUri: vscode.Uri
    ) {
        this.customEditorRegistration = vscode.window.registerCustomEditorProvider(
            RankBoardPanel.VIEW_TYPE,
            this,
            { webviewOptions: { retainContextWhenHidden: true } }
        );
        this.rankUpdatedDisposable = dataProvider.onRankUpdated((rank) => {
            if (!rank) {
                this.lastRank = undefined;
                this.query = { page: 1, onlyMyFollow: false };
            }
            if (this.panel?.visible) {
                void this.loadRank();
            }
        });
    }

    /**
     * 打开排行榜；若窗口已经存在，则聚焦原窗口并刷新数据。
     */
    async show(): Promise<void> {
        if (this.panel) {
            this.panel.reveal(undefined, false);
            void this.loadRank();
            return;
        }

        try {
            // createWebviewPanel 的公开 ViewColumn 会把未知负数归一化为 Active，无法指定
            // 模态组。1.110 的内部 openWith 命令会原样接收 -4，让这个自定义编辑器在
            // 默认 useModal=some 下进入模态层，同时不影响其他编辑器。
            await vscode.commands.executeCommand(
                '_workbench.openWith',
                this.documentUri,
                RankBoardPanel.VIEW_TYPE,
                [RankBoardPanel.MODAL_GROUP, { preserveFocus: false }]
            );
        } catch (error) {
            console.warn('Failed to open rank board in the modal editor:', error);
            await vscode.commands.executeCommand(
                'vscode.openWith',
                this.documentUri,
                RankBoardPanel.VIEW_TYPE,
                { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }
            );
        }
    }

    /**
     * 创建排行榜使用的只读虚拟文档。
     */
    openCustomDocument(uri: vscode.Uri): RankBoardDocument {
        return new RankBoardDocument(uri);
    }

    /**
     * 将自定义编辑器解析为排行榜 Webview。
     */
    resolveCustomEditor(_document: RankBoardDocument, panel: vscode.WebviewPanel): void {
        this.disposePanel();
        this.panel = panel;
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: []
        };
        panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'icon.png');

        // 必须先监听消息再写入 HTML。模态编辑器创建速度很快，若 HTML 中的脚本先执行，
        // ready 消息可能在监听器注册前发出并永久丢失，界面就会一直停在初始加载状态。
        this.panelDisposables.push(
            panel.onDidDispose(() => this.disposePanel()),
            panel.webview.onDidReceiveMessage((message: RankBoardMessage) => {
                void this.handleMessage(message);
            })
        );
        panel.webview.html = this.getHtml(panel.webview);
    }

    dispose(): void {
        this.customEditorRegistration.dispose();
        this.rankUpdatedDisposable.dispose();
        this.panel?.dispose();
        this.disposePanel();
    }

    private disposePanel(): void {
        this.panel = undefined;
        for (const disposable of this.panelDisposables.splice(0)) {
            disposable.dispose();
        }
    }

    private async handleMessage(message: RankBoardMessage): Promise<void> {
        switch (message.type) {
            case 'ready':
            case 'refresh':
                await this.loadRank();
                return;
            case 'search':
                this.query.searchUserName = String(message.value ?? '').trim().slice(0, 100) || undefined;
                this.query.page = 1;
                await this.loadRank();
                return;
            case 'setFollow':
                this.query.onlyMyFollow = Boolean(message.value);
                this.query.page = 1;
                await this.loadRank();
                return;
            case 'setTeam':
                this.query.teamId = Number.isFinite(message.teamId) && Number(message.teamId) > 0
                    ? Math.floor(Number(message.teamId))
                    : undefined;
                this.query.page = 1;
                await this.loadRank();
                return;
            case 'changePage':
                this.query.page = Number.isFinite(message.page) ? Math.max(1, Math.floor(message.page)) : 1;
                await this.loadRank();
                return;
            case 'locateMe':
                this.query.onlyMyFollow = false;
                this.query.searchUserName = undefined;
                this.query.teamId = undefined;
                this.query.page = this.getMyRankPage();
                await this.loadRank();
                return;
            default:
                return;
        }
    }

    private getMyRankPage(): number {
        const myRank = this.lastRank?.myRankData?.ranking;
        const pageSize = this.lastRank?.basicInfo.pageSize;
        if (!myRank || !pageSize) {
            return 1;
        }
        return Math.max(1, Math.ceil(myRank / pageSize));
    }

    /**
     * 按当前窗口查询状态加载数据，并丢弃较早请求的过期结果。
     */
    private async loadRank(): Promise<void> {
        const panel = this.panel;
        if (!panel) {
            return;
        }

        const currentRequest = ++this.requestVersion;
        await panel.webview.postMessage({ type: 'loading', query: this.query });

        try {
            const teamsPromise = this.myTeams
                ? Promise.resolve(this.myTeams)
                : this.dataProvider.getMyTeams().catch((error) => {
                    console.warn('Failed to load my teams for rank board:', error);
                    return [];
                });
            const [rank, contestInfo, teams] = await Promise.all([
                this.dataProvider.getRealtimeRankPage(
                    this.query.page,
                    this.query.onlyMyFollow,
                    this.query.searchUserName,
                    this.query.teamId
                ),
                this.dataProvider.getContestInfo(false).catch(() => undefined),
                teamsPromise
            ]);
            if (!this.panel || currentRequest !== this.requestVersion) {
                return;
            }
            if (!rank) {
                throw new Error('当前未打开比赛工作空间');
            }

            this.lastRank = rank;
            this.myTeams = teams;
            this.query.page = rank.basicInfo.pageCurrent || this.query.page;
            const contestName = contestInfo?.name?.trim()
                || contestInfo?.competitionName_var?.trim()
                || `比赛 ${rank.basicInfo.contestId}`;
            const rankingMode = contestInfo?.rankType === 4
                || contestInfo?.rankTypeInfo?.includes('周赛')
                || /weekly|ioi|score/i.test(rank.basicInfo.rankType || '')
                ? 'weekly'
                : 'acm';
            this.panel.title = contestName;
            await this.panel.webview.postMessage({
                type: 'data',
                rank,
                contestName,
                rankingMode,
                teams,
                query: this.query,
                updatedAt: Date.now()
            });
        } catch (error) {
            if (!this.panel || currentRequest !== this.requestVersion) {
                return;
            }
            await this.panel.webview.postMessage({
                type: 'error',
                message: error instanceof Error ? error.message : String(error),
                query: this.query
            });
        }
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce = randomBytes(16).toString('base64');
        return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <title>牛客实时排名</title>
    <style nonce="${nonce}">
        :root {
            color-scheme: light dark;
            --nc-green: #00b578;
            --nc-green-soft: color-mix(in srgb, var(--nc-green) 17%, transparent);
            --nc-green-border: color-mix(in srgb, var(--nc-green) 55%, transparent);
            --rank-failed: var(--vscode-testing-iconFailed, #f14c4c);
            --rank-failed-soft: color-mix(in srgb, var(--rank-failed) 14%, transparent);
            --rank-pending: var(--vscode-charts-yellow, #cca700);
            --rank-first: var(--vscode-charts-orange, #d18616);
            --rank-first-blood-background: color-mix(in srgb, #006b46 58%, var(--vscode-editor-background));
            --rank-first-blood-border: color-mix(in srgb, #00a86b 72%, transparent);
            --rank-border: var(--vscode-panel-border, rgba(127, 127, 127, 0.28));
            --rank-muted: var(--vscode-descriptionForeground);
            --rank-header: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
            --rank-hover: var(--vscode-list-hoverBackground);
            --rank-selected: var(--vscode-list-inactiveSelectionBackground);
            --rank-focus: var(--vscode-focusBorder);
            --sticky-rank-width: 68px;
            --sticky-user-width: 180px;
            --sticky-school-width: 180px;
            --sticky-accepted-width: 72px;
            --sticky-penalty-width: 76px;
        }

        * { box-sizing: border-box; }

        html, body {
            margin: 0;
            min-width: 420px;
            height: 100%;
            color: var(--vscode-editor-foreground);
            background: var(--vscode-editor-background);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
        }

        button, input { font: inherit; }

        button:focus-visible, input:focus-visible {
            outline: 1px solid var(--rank-focus);
            outline-offset: 1px;
        }

        .app {
            min-height: 100%;
            display: grid;
            grid-template-rows: auto auto auto minmax(220px, 1fr) auto;
        }

        .masthead {
            min-height: 64px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 24px;
            padding: 12px 18px;
            border-bottom: 1px solid var(--rank-border);
            background: var(--rank-header);
        }

        .title-group { min-width: 0; }

        .eyebrow {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 4px;
            color: var(--rank-muted);
            font-size: 11px;
            font-weight: 600;
            letter-spacing: .08em;
            text-transform: uppercase;
        }

        .brand-mark {
            width: 8px;
            height: 8px;
            border-radius: 2px;
            background: var(--nc-green);
            box-shadow: 0 0 0 3px var(--nc-green-soft);
        }

        h1 {
            margin: 0;
            overflow: hidden;
            font-size: 17px;
            font-weight: 600;
            line-height: 1.3;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .masthead-meta {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 10px;
            flex: none;
            color: var(--rank-muted);
            font-size: 12px;
        }

        .status {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 3px 7px;
            border: 1px solid var(--nc-green-border);
            border-radius: 3px;
            color: var(--nc-green);
            background: var(--nc-green-soft);
            font-weight: 600;
        }

        .status.finished {
            color: var(--rank-muted);
            border-color: var(--rank-border);
            background: transparent;
        }

        .status-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: currentColor;
        }

        .icon-button, .text-button, .toggle-button, .page-button {
            min-height: 28px;
            border: 1px solid transparent;
            border-radius: 3px;
            color: var(--vscode-button-secondaryForeground);
            background: var(--vscode-button-secondaryBackground);
            cursor: pointer;
        }

        .icon-button:hover, .text-button:hover, .toggle-button:hover, .page-button:hover:not(:disabled) {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .icon-button {
            width: 30px;
            padding: 0;
            font-size: 16px;
        }

        .summary {
            display: grid;
            grid-template-columns: minmax(170px, 1fr) auto auto auto;
            align-items: center;
            gap: 22px;
            min-height: 58px;
            padding: 9px 18px;
            border-bottom: 1px solid var(--rank-border);
        }

        .summary-lead {
            display: flex;
            align-items: baseline;
            gap: 10px;
            min-width: 0;
        }

        .summary-label, .metric-label {
            color: var(--rank-muted);
            font-size: 11px;
        }

        .my-rank {
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-editor-font-family);
            font-size: 22px;
            font-weight: 650;
            letter-spacing: -.04em;
        }

        .metric {
            display: grid;
            gap: 2px;
            min-width: 56px;
        }

        .metric-value {
            font-family: var(--vscode-editor-font-family);
            font-variant-numeric: tabular-nums;
            font-weight: 600;
        }

        .text-button { padding: 4px 10px; }

        .toolbar {
            display: flex;
            align-items: center;
            gap: 8px;
            min-height: 48px;
            padding: 8px 18px;
            border-bottom: 1px solid var(--rank-border);
        }

        .search {
            width: min(360px, 45vw);
            height: 30px;
            padding: 4px 9px;
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 3px;
            color: var(--vscode-input-foreground);
            background: var(--vscode-input-background);
        }

        .search::placeholder { color: var(--vscode-input-placeholderForeground); }

        .team-select {
            width: min(190px, 24vw);
            height: 30px;
            padding: 4px 8px;
            overflow: hidden;
            border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
            border-radius: 3px;
            color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
            background: var(--vscode-dropdown-background, var(--vscode-input-background));
            font: inherit;
            text-overflow: ellipsis;
            white-space: nowrap;
            cursor: pointer;
        }

        .team-select:focus {
            border-color: var(--rank-focus);
            outline: 1px solid var(--rank-focus);
            outline-offset: -1px;
        }

        .toggle-button {
            display: inline-flex;
            align-items: center;
            gap: 7px;
            padding: 4px 9px;
            white-space: nowrap;
        }

        .toggle-button[aria-pressed="true"] {
            color: var(--vscode-button-foreground);
            border-color: color-mix(in srgb, var(--rank-focus) 65%, transparent);
            background: var(--vscode-button-background);
        }

        .toolbar-spacer { flex: 1; }
        .rank-count { color: var(--rank-muted); white-space: nowrap; }

        .error-banner {
            display: none;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 7px 18px;
            color: var(--vscode-inputValidation-errorForeground, var(--vscode-editor-foreground));
            border-bottom: 1px solid var(--vscode-inputValidation-errorBorder, var(--rank-failed));
            background: var(--vscode-inputValidation-errorBackground, var(--rank-failed-soft));
        }

        .error-banner.visible { display: flex; }

        .table-region {
            position: relative;
            min-height: 220px;
            overflow: auto;
            scrollbar-color: var(--vscode-scrollbarSlider-background) transparent;
        }

        .loading-bar {
            position: sticky;
            z-index: 20;
            top: 0;
            width: 100%;
            height: 2px;
            overflow: hidden;
            opacity: 0;
            pointer-events: none;
        }

        .loading .loading-bar { opacity: 1; }

        .loading-bar::after {
            content: '';
            position: absolute;
            inset: 0;
            width: 38%;
            background: var(--nc-green);
            animation: loading 1s ease-in-out infinite;
        }

        @keyframes loading {
            from { transform: translateX(-110%); }
            to { transform: translateX(300%); }
        }

        @media (prefers-reduced-motion: reduce) {
            .loading-bar::after { animation: none; width: 100%; opacity: .65; }
        }

        table {
            width: max-content;
            min-width: 100%;
            border-collapse: separate;
            border-spacing: 0;
            font-size: 13px;
            font-variant-numeric: tabular-nums;
        }

        th, td {
            height: 48px;
            padding: 7px 10px;
            border-right: 1px solid var(--rank-border);
            border-bottom: 1px solid var(--rank-border);
            text-align: center;
            white-space: nowrap;
        }

        th {
            position: sticky;
            z-index: 5;
            top: 0;
            height: 50px;
            color: var(--rank-muted);
            background: var(--rank-header);
            font-size: 12px;
            font-weight: 600;
            letter-spacing: .03em;
        }

        tr:hover td { background-color: var(--rank-hover); }

        .rank-column {
            position: sticky;
            z-index: 4;
            left: 0;
            width: var(--sticky-rank-width);
            min-width: var(--sticky-rank-width);
            background: var(--vscode-editor-background);
            font-family: var(--vscode-editor-font-family);
            font-weight: 600;
        }

        th.rank-column { z-index: 8; background: var(--rank-header); }

        .user-column {
            position: sticky;
            z-index: 4;
            left: var(--sticky-rank-width);
            width: var(--sticky-user-width);
            min-width: var(--sticky-user-width);
            max-width: var(--sticky-user-width);
            background: var(--vscode-editor-background);
            text-align: left;
        }

        th.user-column { z-index: 8; background: var(--rank-header); }

        .school-column {
            position: sticky;
            z-index: 4;
            left: calc(var(--sticky-rank-width) + var(--sticky-user-width));
            width: var(--sticky-school-width);
            min-width: var(--sticky-school-width);
            max-width: var(--sticky-school-width);
            overflow: hidden;
            background: var(--vscode-editor-background);
            text-align: left;
            text-overflow: ellipsis;
        }

        th.school-column { z-index: 8; background: var(--rank-header); }

        .summary-column { min-width: 76px; }

        .accepted-column,
        .penalty-column {
            position: sticky;
            z-index: 4;
            background: var(--vscode-editor-background);
        }

        .accepted-column {
            left: calc(var(--sticky-rank-width) + var(--sticky-user-width) + var(--sticky-school-width));
            width: var(--sticky-accepted-width);
            min-width: var(--sticky-accepted-width);
        }

        .penalty-column {
            left: calc(var(--sticky-rank-width) + var(--sticky-user-width) + var(--sticky-school-width) + var(--sticky-accepted-width));
            width: var(--sticky-penalty-width);
            min-width: var(--sticky-penalty-width);
            box-shadow: 1px 0 0 var(--rank-border);
        }

        th.accepted-column,
        th.penalty-column { z-index: 8; background: var(--rank-header); }

        .problem-column { width: 76px; min-width: 76px; padding-inline: 5px; }
        .weekly-table .problem-column { width: 96px; min-width: 96px; }

        .problem-stat {
            display: block;
            margin-top: 3px;
            color: var(--rank-muted);
            font-size: 11px;
            font-weight: 400;
            letter-spacing: 0;
        }

        .user-name {
            overflow: hidden;
            color: var(--vscode-editor-foreground);
            font-weight: 600;
            text-overflow: ellipsis;
        }

        .school-filter {
            max-width: 100%;
            overflow: hidden;
            padding: 2px 0;
            border: 0;
            color: var(--vscode-textLink-foreground, var(--nc-green));
            background: transparent;
            cursor: pointer;
            font: inherit;
            text-align: left;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .school-filter:hover { color: var(--vscode-textLink-activeForeground, var(--nc-green)); text-decoration: underline; }
        .school-filter:focus-visible { outline: 1px solid var(--rank-focus); outline-offset: 2px; }
        .no-school { color: var(--rank-muted); }

        .ak-badge {
            display: block;
            width: max-content;
            margin: 3px auto 0;
            padding: 0 4px;
            border-radius: 2px;
            color: #fff;
            background: var(--rank-first);
            font-size: 10px;
            font-weight: 700;
            line-height: 1.35;
        }

        .me-badge {
            display: inline-block;
            margin-left: 6px;
            padding: 0 4px;
            color: var(--vscode-badge-foreground);
            border-radius: 2px;
            background: var(--vscode-badge-background);
            font-size: 10px;
            font-weight: 600;
            vertical-align: 1px;
        }

        tr.current-user td {
            background-color: var(--rank-selected);
            box-shadow: inset 0 1px 0 color-mix(in srgb, var(--rank-focus) 55%, transparent),
                        inset 0 -1px 0 color-mix(in srgb, var(--rank-focus) 55%, transparent);
        }

        tr.current-user .rank-column { border-left: 3px solid var(--rank-focus); }

        .medal-1 { color: #d6a72e; }
        .medal-2 { color: #a4acb8; }
        .medal-3 { color: #b87545; }

        .score-cell {
            position: relative;
            font-family: var(--vscode-editor-font-family);
            font-size: 13px;
            line-height: 1.3;
        }

        .score-cell.accepted {
            color: var(--nc-green);
            background-color: var(--nc-green-soft);
        }

        .score-cell.failed {
            color: var(--rank-failed);
            background-color: var(--rank-failed-soft);
        }

        .score-cell.pending { color: var(--rank-pending); }

        .score-cell.partial {
            color: var(--rank-pending);
            background-color: color-mix(in srgb, var(--rank-pending) 12%, transparent);
        }

        .score-cell.first-blood {
            color: var(--vscode-editor-foreground);
            background-color: var(--rank-first-blood-background);
            box-shadow: inset 0 0 0 1px var(--rank-first-blood-border);
        }

        .score-main { display: block; font-weight: 700; }
        .score-detail { display: block; margin-top: 2px; font-size: 11px; opacity: .86; }
        .empty-score { color: color-mix(in srgb, var(--rank-muted) 40%, transparent); }

        .empty-state {
            display: grid;
            place-items: center;
            min-height: 230px;
            padding: 30px;
            color: var(--rank-muted);
            text-align: center;
        }

        .footer {
            min-height: 46px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 12px;
            padding: 8px 18px;
            border-top: 1px solid var(--rank-border);
            background: var(--rank-header);
        }

        .page-button { min-width: 76px; padding: 4px 10px; }
        .page-button:disabled { opacity: .45; cursor: default; }
        .page-status { min-width: 66px; color: var(--rank-muted); text-align: center; }

        @media (max-width: 720px) {
            :root {
                --sticky-user-width: 154px;
                --sticky-school-width: 154px;
            }
            .masthead { align-items: flex-start; gap: 10px; padding-inline: 12px; }
            .masthead-meta { flex-wrap: wrap; gap: 6px; }
            .updated-label { display: none; }
            .summary { grid-template-columns: 1fr auto auto; gap: 12px; padding-inline: 12px; }
            .summary .metric:nth-of-type(3) { display: none; }
            .toolbar { padding-inline: 12px; flex-wrap: wrap; }
            .search { width: 100%; flex: 1 0 100%; }
            .rank-count { display: none; }
        }
    </style>
</head>
<body>
    <main class="app loading" id="app">
        <header class="masthead">
            <div class="title-group">
                <div class="eyebrow"><span class="brand-mark"></span>NowCoder Contest</div>
                <h1 id="contestTitle">实时排名</h1>
            </div>
            <div class="masthead-meta">
                <span class="status" id="contestStatus"><span class="status-dot"></span><span>加载中</span></span>
                <span class="updated-label" id="updatedAt">正在获取排名…</span>
                <button class="icon-button" id="refreshButton" type="button" title="刷新排名" aria-label="刷新排名">↻</button>
            </div>
        </header>

        <section class="summary" aria-label="我的排名摘要">
            <div class="summary-lead">
                <span class="summary-label">我的排名</span>
                <strong class="my-rank" id="myRank">—</strong>
            </div>
            <div class="metric"><span class="metric-label">通过</span><span class="metric-value" id="myAccepted">—</span></div>
            <div class="metric"><span class="metric-label" id="myPenaltyLabel">罚时</span><span class="metric-value" id="myPenalty">—</span></div>
            <button class="text-button" id="locateButton" type="button">定位到我</button>
        </section>

        <section>
            <div class="toolbar" role="search">
                <input class="search" id="searchInput" type="search" maxlength="100" placeholder="搜索用户名或学校" aria-label="搜索用户名或学校">
                <select class="team-select" id="teamSelect" aria-label="查看我的团队" title="查看我的团队">
                    <option value="">查看我的团队</option>
                </select>
                <button class="toggle-button" id="followButton" type="button" role="switch" aria-pressed="false"><span>只看关注</span></button>
                <button class="toggle-button" id="autoRefreshButton" type="button" role="switch" aria-pressed="false"><span>自动刷新</span><small>30s</small></button>
                <span class="toolbar-spacer"></span>
                <span class="rank-count" id="rankCount"></span>
            </div>
            <div class="error-banner" id="errorBanner" role="alert">
                <span id="errorMessage"></span>
                <button class="text-button" id="retryButton" type="button">重试</button>
            </div>
        </section>

        <section class="table-region" id="tableRegion" aria-live="polite">
            <div class="loading-bar"></div>
            <div id="tableContent"><div class="empty-state">正在加载实时排名…</div></div>
        </section>

        <footer class="footer">
            <button class="page-button" id="previousButton" type="button">‹ 上一页</button>
            <span class="page-status" id="pageStatus">— / —</span>
            <button class="page-button" id="nextButton" type="button">下一页 ›</button>
        </footer>
    </main>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const elements = {
            app: document.getElementById('app'),
            contestTitle: document.getElementById('contestTitle'),
            contestStatus: document.getElementById('contestStatus'),
            updatedAt: document.getElementById('updatedAt'),
            myRank: document.getElementById('myRank'),
            myAccepted: document.getElementById('myAccepted'),
            myPenaltyLabel: document.getElementById('myPenaltyLabel'),
            myPenalty: document.getElementById('myPenalty'),
            searchInput: document.getElementById('searchInput'),
            teamSelect: document.getElementById('teamSelect'),
            followButton: document.getElementById('followButton'),
            autoRefreshButton: document.getElementById('autoRefreshButton'),
            rankCount: document.getElementById('rankCount'),
            errorBanner: document.getElementById('errorBanner'),
            errorMessage: document.getElementById('errorMessage'),
            tableContent: document.getElementById('tableContent'),
            previousButton: document.getElementById('previousButton'),
            nextButton: document.getElementById('nextButton'),
            pageStatus: document.getElementById('pageStatus')
        };

        let currentRank;
        let currentQuery = { page: 1, onlyMyFollow: false };
        let searchTimer;
        let autoRefreshTimer;

        const escapeHtml = (value) => String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');

        const formatPenaltyMinutes = (milliseconds) => Math.round((milliseconds || 0) / 60000);

        const formatDuration = (milliseconds) => {
            const totalSeconds = Math.max(0, Math.floor(safeNumber(milliseconds) / 1000));
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
        };

        const formatScore = (value) => {
            const score = safeNumber(value);
            return Number.isInteger(score) ? String(score) : score.toFixed(2).replace(/0+$/, '').replace(/\\.$/, '');
        };

        const safeNumber = (value) => {
            const number = Number(value);
            return Number.isFinite(number) ? number : 0;
        };

        const formatElapsed = (acceptedTime, beginTime) => {
            const totalSeconds = Math.max(0, Math.floor((acceptedTime - beginTime) / 1000));
            return String(Math.floor(totalSeconds / 60));
        };

        const setLoading = (loading) => elements.app.classList.toggle('loading', loading);

        const hideError = () => elements.errorBanner.classList.remove('visible');

        const showError = (message) => {
            elements.errorMessage.textContent = message;
            elements.errorBanner.classList.add('visible');
        };

        const updateQueryControls = () => {
            const expectedSearch = currentQuery.searchUserName || '';
            if (document.activeElement !== elements.searchInput && elements.searchInput.value !== expectedSearch) {
                elements.searchInput.value = expectedSearch;
            }
            elements.followButton.setAttribute('aria-pressed', String(Boolean(currentQuery.onlyMyFollow)));
            elements.teamSelect.value = currentQuery.teamId ? String(currentQuery.teamId) : '';
        };

        const updateTeamOptions = (teams) => {
            const availableTeams = Array.isArray(teams) ? teams : [];
            const placeholder = availableTeams.length ? '查看我的团队' : '暂无团队';
            elements.teamSelect.innerHTML = '<option value="">' + placeholder + '</option>' +
                availableTeams.map((team) => '<option value="' + safeNumber(team.id) + '">' +
                    escapeHtml(team.name) + '</option>').join('');
            elements.teamSelect.title = availableTeams.length ? '查看我的团队' : '当前账号暂无竞赛团队';
            elements.teamSelect.value = currentQuery.teamId ? String(currentQuery.teamId) : '';
        };

        const getScoreTooltip = (problem, score, rank) => {
            const parts = ['题目 ' + problem.name];
            if (score.accepted) {
                parts.push('已通过');
                parts.push('通过时间：' + formatElapsed(score.acceptedTime, rank.basicInfo.contestBeginTime) + ' 分钟');
            } else if (score.submit && (score.waitingJudgeCount > 0 || !score.finishJudge)) {
                parts.push('等待评测：' + Math.max(1, score.waitingJudgeCount));
            } else if (score.submit) {
                parts.push('尚未通过');
            } else {
                parts.push('未提交');
            }
            if (score.failedCount > 0) parts.push('失败提交：' + score.failedCount);
            if (score.firstBlood) parts.push('本题首杀');
            return parts.join('\\n');
        };

        const renderWeeklyScoreCell = (problem, score) => {
            if (!score.submit) {
                return '<td class="problem-column score-cell empty-score">·</td>';
            }
            if (score.waitingJudgeCount > 0 || !score.finishJudge) {
                return '<td class="problem-column score-cell pending"><span class="score-main">…</span>' +
                    '<span class="score-detail">评测中</span></td>';
            }

            const scoreValue = safeNumber(score.score);
            const fullScore = safeNumber(score.fullScore || problem.score);
            const statusClass = fullScore > 0 && scoreValue >= fullScore
                ? 'accepted'
                : scoreValue > 0 ? 'partial' : 'failed';
            const time = formatDuration(score.reachTime);
            const title = escapeHtml('题目 ' + problem.name + '\\n得分：' + formatScore(scoreValue) +
                ' / ' + formatScore(fullScore) + '\\n达到时间：' + time);
            return '<td class="problem-column score-cell ' + statusClass + ' ' +
                (score.firstBlood ? 'first-blood' : '') + '" title="' + title + '">' +
                '<span class="score-main">' + formatScore(scoreValue) + '</span>' +
                '<span class="score-detail">' + time + '</span></td>';
        };

        const renderScoreCell = (problem, score, rank, rankingMode) => {
            if (rankingMode === 'weekly') {
                return renderWeeklyScoreCell(problem, score);
            }
            const title = escapeHtml(getScoreTooltip(problem, score, rank));
            if (score.accepted) {
                const elapsed = formatElapsed(score.acceptedTime, rank.basicInfo.contestBeginTime);
                const failedCount = safeNumber(score.failedCount);
                const failed = failedCount > 0 ? '<span class="score-detail">+' + failedCount + '</span>' : '';
                return '<td class="problem-column score-cell accepted ' + (score.firstBlood ? 'first-blood' : '') + '" title="' + title + '">' +
                    '<span class="score-main">✓ ' + elapsed + '</span>' + failed + '</td>';
            }
            if (score.waitingJudgeCount > 0 || (score.submit && !score.finishJudge)) {
                return '<td class="problem-column score-cell pending" title="' + title + '"><span class="score-main">…</span>' +
                    '<span class="score-detail">评测中</span></td>';
            }
            if (score.submit) {
                return '<td class="problem-column score-cell failed" title="' + title + '"><span class="score-main">−' +
                    Math.max(1, safeNumber(score.failedCount)) + '</span></td>';
            }
            return '<td class="problem-column score-cell empty-score" title="' + title + '">·</td>';
        };

        const renderTable = (rank, rankingMode) => {
            const isUnfiltered = !currentQuery.onlyMyFollow && !currentQuery.searchUserName && !currentQuery.teamId;
            const rowsToRender = isUnfiltered && rank.myRankData
                ? [rank.myRankData, ...rank.rankData]
                : rank.rankData;

            if (!rowsToRender.length) {
                elements.tableContent.innerHTML = '<div class="empty-state">没有找到符合当前条件的参赛者</div>';
                return;
            }

            const problemHeaders = rank.problemData.map((problem) => {
                const submissions = safeNumber(problem.acceptedCount) + '/' + safeNumber(problem.submitCount);
                return rankingMode === 'weekly'
                    ? '<th class="problem-column" scope="col">' + escapeHtml(problem.name) + ' (' + submissions + ')' +
                        '<span class="problem-stat">满分: ' + formatScore(problem.score) + '分</span></th>'
                    : '<th class="problem-column" scope="col">' + escapeHtml(problem.name) +
                        '<span class="problem-stat">' + submissions + '</span></th>';
            }).join('');

            const currentUid = rank.basicInfo.basicUid || rank.myRankData?.uid;
            const rows = rowsToRender.map((user) => {
                const isMe = Boolean(currentUid && user.uid === currentUid);
                const ranking = safeNumber(user.ranking);
                const medalClass = ranking >= 1 && ranking <= 3 ? ' medal-' + ranking : '';
                const school = String(user.school || '').trim();
                const acceptedCount = safeNumber(user.acceptedCount);
                const isAk = rank.problemData.length > 0 && acceptedCount >= rank.problemData.length;
                const scores = rank.problemData.map((problem, index) => {
                    const score = user.scoreList[index];
                    return score ? renderScoreCell(problem, score, rank, rankingMode) : '<td class="problem-column empty-score">·</td>';
                }).join('');
                const rankSummary = rankingMode === 'weekly'
                    ? '<span class="score-main">' + formatScore(user.totalScore) + '</span>' +
                        '<span class="score-detail">' + formatDuration(user.penaltyTime) + '</span>'
                    : String(formatPenaltyMinutes(user.penaltyTime));
                return '<tr class="' + (isMe ? 'current-user' : '') + '">' +
                    '<td class="rank-column' + medalClass + '">' + ranking + '</td>' +
                    '<td class="user-column"><div class="user-name" title="' + escapeHtml(user.userName) + '">' +
                    escapeHtml(user.userName) + (isMe ? '<span class="me-badge">我</span>' : '') + '</div></td>' +
                    '<td class="school-column">' + (school
                        ? '<button class="school-filter" type="button" data-school="' + escapeHtml(school) +
                            '" title="筛选学校：' + escapeHtml(school) + '">' + escapeHtml(school) + '</button>'
                        : '<span class="no-school">—</span>') + '</td>' +
                    '<td class="summary-column accepted-column"><strong>' + acceptedCount + '</strong>' +
                        (isAk ? '<span class="ak-badge" title="全部题目已通过">AK</span>' : '') + '</td>' +
                    '<td class="summary-column penalty-column">' + rankSummary + '</td>' + scores + '</tr>';
            }).join('');

            elements.tableContent.innerHTML = '<table class="' + (rankingMode === 'weekly' ? 'weekly-table' : '') +
                '" aria-label="实时排名表"><thead><tr>' +
                '<th class="rank-column" scope="col">排名</th>' +
                '<th class="user-column" scope="col">参赛者</th>' +
                '<th class="school-column" scope="col">学校</th>' +
                '<th class="summary-column accepted-column" scope="col">通过</th>' +
                '<th class="summary-column penalty-column" scope="col">' + (rankingMode === 'weekly' ? '总分' : '罚时') + '</th>' + problemHeaders +
                '</tr></thead><tbody>' + rows + '</tbody></table>';
        };

        const render = (rank, contestName, rankingMode, updatedAt) => {
            currentRank = rank;
            elements.contestTitle.textContent = contestName;
            elements.contestStatus.classList.toggle('finished', rank.isContestFinished);
            elements.contestStatus.innerHTML = '<span class="status-dot"></span><span>' +
                (rank.isContestFinished ? '最终排名' : '进行中') + '</span>';
            elements.updatedAt.textContent = new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' 更新';

            const me = rank.myRankData;
            elements.myRank.textContent = me ? '#' + me.ranking : '—';
            elements.myAccepted.textContent = me ? String(me.acceptedCount) : '—';
            elements.myPenaltyLabel.textContent = rankingMode === 'weekly' ? '总分' : '罚时';
            elements.myPenalty.textContent = me
                ? rankingMode === 'weekly' ? formatScore(me.totalScore) : String(formatPenaltyMinutes(me.penaltyTime))
                : '—';
            elements.rankCount.textContent = '共 ' + rank.basicInfo.rankCount + ' 人';
            elements.pageStatus.textContent = rank.basicInfo.pageCurrent + ' / ' + Math.max(1, rank.basicInfo.pageCount);
            elements.previousButton.disabled = rank.basicInfo.pageCurrent <= 1;
            elements.nextButton.disabled = rank.basicInfo.pageCurrent >= rank.basicInfo.pageCount;
            renderTable(rank, rankingMode);
        };

        const setAutoRefresh = (enabled) => {
            elements.autoRefreshButton.setAttribute('aria-pressed', String(enabled));
            if (autoRefreshTimer) clearInterval(autoRefreshTimer);
            autoRefreshTimer = enabled ? setInterval(() => {
                if (document.visibilityState === 'visible') vscode.postMessage({ type: 'refresh' });
            }, 30000) : undefined;
        };

        window.addEventListener('message', (event) => {
            const message = event.data;
            if (message.teams) {
                updateTeamOptions(message.teams);
            }
            if (message.query) {
                currentQuery = message.query;
                updateQueryControls();
            }
            if (message.type === 'loading') {
                setLoading(true);
                hideError();
            } else if (message.type === 'data') {
                setLoading(false);
                hideError();
                render(message.rank, message.contestName, message.rankingMode, message.updatedAt);
            } else if (message.type === 'error') {
                setLoading(false);
                showError(message.message);
                if (!currentRank) elements.tableContent.innerHTML = '<div class="empty-state">暂时无法加载排名，请重试</div>';
            }
        });

        document.getElementById('refreshButton').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
        document.getElementById('retryButton').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
        document.getElementById('locateButton').addEventListener('click', () => vscode.postMessage({ type: 'locateMe' }));
        elements.previousButton.addEventListener('click', () => vscode.postMessage({ type: 'changePage', page: currentQuery.page - 1 }));
        elements.nextButton.addEventListener('click', () => vscode.postMessage({ type: 'changePage', page: currentQuery.page + 1 }));
        elements.followButton.addEventListener('click', () => vscode.postMessage({
            type: 'setFollow',
            value: elements.followButton.getAttribute('aria-pressed') !== 'true'
        }));
        elements.teamSelect.addEventListener('change', () => {
            const teamId = Number.parseInt(elements.teamSelect.value, 10);
            vscode.postMessage({ type: 'setTeam', teamId: Number.isFinite(teamId) ? teamId : undefined });
        });
        elements.autoRefreshButton.addEventListener('click', () => {
            setAutoRefresh(elements.autoRefreshButton.getAttribute('aria-pressed') !== 'true');
        });
        elements.searchInput.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => vscode.postMessage({ type: 'search', value: elements.searchInput.value }), 350);
        });
        elements.searchInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                clearTimeout(searchTimer);
                vscode.postMessage({ type: 'search', value: elements.searchInput.value });
            }
        });
        elements.tableContent.addEventListener('click', (event) => {
            if (!(event.target instanceof Element)) return;
            const schoolButton = event.target.closest('.school-filter');
            if (!schoolButton) return;
            const school = schoolButton.dataset.school || '';
            elements.searchInput.value = school;
            vscode.postMessage({ type: 'search', value: school });
        });
        window.addEventListener('keydown', (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
                event.preventDefault();
                elements.searchInput.focus();
                elements.searchInput.select();
            }
        });

        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }
}
