# Change Log

All notable changes to the extension will be documented in this file.

## Version 1.1.0

- 强烈推荐罗森安格斯黑椒牛肉粒饭团，oishi desuwa~

### 新增功能
- 新增“比赛列表”视图：可展示已创建比赛、从列表打开比赛、刷新比赛列表 desuwa~
- 新增赛时公告弹窗 desuwa~
- 新增赛时题面更新监听，比赛进行中自动检测题面/样例变化 desuwa~
- 新增 CPH 官方样例同步机制：题面变化后同步官方样例，并尽量保留用户手动测试 desuwa~
- 新增 VS Code 原生插件设置：默认编译器、是否自动生成 CPH、比赛工作目录、题面打开方式、是否自动检测比赛配置 desuwa~
- 新增代码文件右上角提交代码按钮 desuwa~

### 功能升级
- 创建比赛工作空间支持输入比赛链接，不再只能输入纯数字 ID desuwa~
- 创建比赛时会拉取比赛标题，并写入比赛列表 desuwa~
- 创建比赛目录时会记住上次选择的工作目录 desuwa~
- 提交代码时不再依赖当前激活文件，而是按题号查找对应源文件，多个文件时让用户选择desuwa~
- 默认编译器可从设置读取，减少每次创建/提交都询问 desuwa~
- 点击题目后可以直接打开题面和代码文件 desuwa~
- README 增加插件设置说明，功能清单把赛时公告标为已完成 desuwa~

### Bug 修复
- 修复提交时题目提交参数不完整导致提交失败的问题 desuwa~
- 修复“当前编辑器不是该题代码文件”可能导致提交错题/错文件的问题 desuwa~
- 修复登录取消被当作错误抛出的问题：取消登录静默返回 desuwa~

## Version 0.3.3

### Bug Fixes

- 修复牛客题面中公式图片 alt 为 latex 时 Markdown 公式解析错误

## Version 0.3.2

### Enhancements

无

### Bug Fixes

 - 打开牛客竞赛界面后会不断请求提交列表

## Version 0.3.1

### Enhancements

 - 提交后刷新题目列表，通过率

### Bug Fixes

 - 提交代码后提交列表一直显示判题中直到手动刷新
 - 加粗、斜体转换成markdown时错误

## Version 0.3.0

### Enhancements

 - 赛时计时器
 - 持久化token
 - token失效检测
 - 改进了题目解析
 - 打开题目时添加进度条
 - 打开题目时在侧边栏显示markdown的预览
 - 切换比赛空间询问
 - 点击赛时计时器可以创建比赛空间

### Bug Fixes

 - 禁用插件时禁用不干净

## Version 0.2.0

### Enhancements

 - 可以查看比赛排行榜了

### Bug Fixes

无

## Version 0.1.1

### Enhancements

 - 如果cph设置了SaveLocation，现在会把prob文件存到指定位置了

### Bug Fixes

无

## Version 0.1.0

### Enhancements

### Bug Fixes

 - 修复插件加载失败

## Version 0.0.4

### Enhancements

 - 创建代码文件
 - 联动Cph创建Prob文件

### Bug Fixes



## Version 0.0.3

### Enhancements

 - 添加了插件图标
 - 补充了描述

### Bug Fixes



## Version 0.0.2

### Enhancements

 - 创建比赛工作空间
 - 查看本场比赛题目
 - 查看题目提交状态
 - 提交代码
 - 显示判题结果
 - 查看个人在本场比赛中的所有提交

### Bug Fixes
