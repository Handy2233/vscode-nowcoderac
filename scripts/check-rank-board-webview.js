const Module = require('module');
const path = require('path');
const vm = require('vm');
const esbuild = require('esbuild');

async function main() {
  const build = await esbuild.build({
    entryPoints: ['src/views/rankBoardPanel.ts'],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['vscode']
  });

  const originalLoad = Module._load;
  const disposable = { dispose() {} };
  const executedCommands = [];
  let registeredCustomEditor;
  const vscodeMock = {
    version: '1.110.0',
    ViewColumn: { Active: 1 },
    ConfigurationTarget: { Global: 1 },
    Uri: {
      from(value) { return value; },
      joinPath() { return {}; }
    },
    workspace: {
      getConfiguration() {
        return { get() { return 'all'; }, async update() {} };
      }
    },
    commands: {
      async executeCommand(command, ...args) { executedCommands.push({ command, args }); }
    },
    window: {
      registerCustomEditorProvider(viewType, provider) {
        registeredCustomEditor = { viewType, provider };
        return disposable;
      }
    }
  };

  try {
    Module._load = function load(request, parent, isMain) {
      if (request === 'vscode') {
        return vscodeMock;
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    const filename = path.join(process.cwd(), '.rank-board-webview-check.cjs');
    const moduleUnderTest = new Module(filename);
    moduleUnderTest.filename = filename;
    moduleUnderTest.paths = Module._nodeModulePaths(process.cwd());
    moduleUnderTest._compile(build.outputFiles[0].text, filename);

    const provider = { onRankUpdated() { return disposable; } };
    const panel = new moduleUnderTest.exports.RankBoardPanel(provider, {});
    if (registeredCustomEditor?.viewType !== 'nowcoderac.realtimeRankBoardEditor') {
      throw new Error('排行榜未注册自定义 Webview 编辑器');
    }
    await panel.show();
    if (executedCommands[0]?.command !== '_workbench.openWith'
      || executedCommands[0]?.args[2]?.[0] !== -4) {
      throw new Error('排行榜未定向打开到 VS Code 模态编辑器组');
    }
    const html = panel.getHtml({ cspSource: 'vscode-webview:' });
    const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1];
    if (!script) {
      throw new Error('排行榜 Webview 中没有找到脚本');
    }

    const compiledScript = new vm.Script(script, { filename: 'rank-board-webview.js' });
    if (!script.includes("vscode.postMessage({ type: 'ready' })")) {
      throw new Error('排行榜 Webview 未发送 ready 消息');
    }

    const windowListeners = new Map();
    class FakeElement {
      constructor() {
        this.attributes = new Map();
        this.classList = { add() {}, remove() {}, toggle() {} };
        this.innerHTML = '';
        this.textContent = '';
        this.value = '';
        this.disabled = false;
      }
      addEventListener() {}
      setAttribute(name, value) { this.attributes.set(name, value); }
    }
    const elementIds = [
      'app', 'contestTitle', 'contestStatus', 'updatedAt', 'myRank', 'myAccepted',
      'myPenaltyLabel', 'myPenalty', 'searchInput', 'teamSelect', 'followButton', 'autoRefreshButton',
      'rankCount', 'errorBanner', 'errorMessage', 'tableContent', 'previousButton',
      'nextButton', 'pageStatus', 'refreshButton', 'retryButton', 'locateButton'
    ];
    const elements = new Map(elementIds.map(id => [id, new FakeElement()]));
    const postedMessages = [];
    const context = vm.createContext({
      acquireVsCodeApi: () => ({ postMessage(message) { postedMessages.push(message); } }),
      document: {
        activeElement: undefined,
        visibilityState: 'visible',
        getElementById(id) { return elements.get(id); }
      },
      window: {
        addEventListener(type, listener) {
          const listeners = windowListeners.get(type) || [];
          listeners.push(listener);
          windowListeners.set(type, listeners);
        }
      },
      Element: FakeElement,
      console,
      setInterval,
      clearInterval,
      setTimeout,
      clearTimeout
    });
    compiledScript.runInContext(context);
    if (postedMessages[0]?.type !== 'ready') {
      throw new Error('排行榜 Webview 启动后未实际发送 ready 消息');
    }

    const weeklyRank = {
      myRankData: null,
      problemData: [{ name: 'A', acceptedCount: 12, submitCount: 20, score: 50 }],
      rankData: [{
        uid: 1,
        ranking: 1,
        userName: 'tester',
        school: '测试大学',
        acceptedCount: 1,
        totalScore: 37.5,
        penaltyTime: 65000,
        scoreList: [{
          submit: true,
          finishJudge: true,
          waitingJudgeCount: 0,
          score: 37.5,
          fullScore: 50,
          reachTime: 65000,
          firstBlood: false
        }]
      }],
      basicInfo: { basicUid: 0, rankCount: 1, pageCurrent: 1, pageCount: 1 },
      isContestFinished: false
    };
    const messageListener = windowListeners.get('message')?.[0];
    if (!messageListener) {
      throw new Error('排行榜 Webview 未注册消息监听器');
    }
    messageListener({
      data: {
        type: 'data',
        rank: weeklyRank,
        contestName: '测试周赛',
        rankingMode: 'weekly',
        teams: [{ id: 7, name: 'HUT奶龙组' }],
        updatedAt: 0
      }
    });
    const renderedTable = elements.get('tableContent').innerHTML;
    for (const expected of ['总分', '满分: 50分', '37.5', '00:01:05', '>AK<']) {
      if (!renderedTable.includes(expected)) {
        throw new Error(`周赛排行榜未渲染预期内容：${expected}`);
      }
    }
    if (!elements.get('teamSelect').innerHTML.includes('HUT奶龙组')) {
      throw new Error('排行榜未加载“我的团队”选项');
    }

    const acmPenaltyTime = 7_540_000;
    const acmMe = {
      ...weeklyRank.rankData[0],
      penaltyTime: acmPenaltyTime,
      totalScore: 0,
      scoreList: [{
        submit: true,
        accepted: true,
        finishJudge: true,
        waitingJudgeCount: 0,
        acceptedTime: 6_540_000,
        failedCount: 1,
        firstBlood: false
      }]
    };
    messageListener({
      data: {
        type: 'data',
        rank: {
          ...weeklyRank,
          myRankData: acmMe,
          problemData: [{ name: 'A', acceptedCount: 1, submitCount: 2 }],
          rankData: [],
          basicInfo: {
            basicUid: 1,
            rankCount: 1,
            pageCurrent: 1,
            pageCount: 1,
            contestBeginTime: 0
          }
        },
        contestName: '测试 ACM 赛',
        rankingMode: 'acm',
        teams: [],
        updatedAt: 0
      }
    });
    const acmTable = elements.get('tableContent').innerHTML;
    if (!acmTable.includes('<th class="summary-column penalty-column" scope="col">罚时</th>')
      || !acmTable.includes('<td class="summary-column penalty-column">126</td>')
      || !acmTable.includes('<span class="score-main">✓ 109</span>')) {
      throw new Error('ACM 排行榜罚时未固定以整数分钟显示');
    }
    if (elements.get('myPenaltyLabel').textContent !== '罚时'
      || elements.get('myPenalty').textContent !== '126') {
      throw new Error('ACM 个人排名摘要罚时未固定以整数分钟显示');
    }
    console.log('排行榜 Webview 脚本检查通过');
  } finally {
    Module._load = originalLoad;
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
