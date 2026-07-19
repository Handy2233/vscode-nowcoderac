const Module = require('module');
const path = require('path');
const esbuild = require('esbuild');

async function main() {
  const build = await esbuild.build({
    entryPoints: ['src/utils/submissionScore.ts'],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node'
  });
  const filename = path.join(process.cwd(), '.submission-score-check.cjs');
  const moduleUnderTest = new Module(filename);
  moduleUnderTest.filename = filename;
  moduleUnderTest.paths = Module._nodeModulePaths(process.cwd());
  moduleUnderTest._compile(build.outputFiles[0].text, filename);

  const { calculateSubmissionScore, formatSubmissionScore, isWeeklyContest } = moduleUnderTest.exports;
  const score = calculateSubmissionScore(37.5, 150);
  if (score !== 56.25 || formatSubmissionScore(score, 150) !== '56.25/150分') {
    throw new Error('周赛提交得分计算或格式化错误');
  }
  if (!isWeeklyContest({ rankType: 4 }) || isWeeklyContest({ rankType: 1 })) {
    throw new Error('周赛赛制识别错误');
  }
  console.log('周赛提交得分检查通过');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
