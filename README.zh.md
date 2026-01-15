# systemmesh-skills

[English](./README.md) | 中文

SystemMesh 共享的技能，用于通过 Claude Code 提升日常工作效率。

## 前置条件

- 已安装 Node.js 运行环境
- 能够运行 `npx bun` 命令

## 可用技能

### post-to-weibo

将内容发布到微博：

```bash
- `npx -y bun ./scripts/weibo-browser.ts "你的内容"`

- `npx -y bun ./scripts/weibo-browser.ts "你的内容" --image /path/a.png --image /path/b.jpg`

- `npx -y bun ./scripts/weibo-browser.ts "你的内容" --submit`

前置条件：已安装 Google Chrome。首次运行需要扫码登录（会话将被保留）。

##免责声明

###post-to-weibo

该技能使用微博 Web 版。

***警告:*** 本项目通过浏览器 Cookie 进行非官方访问，使用风险自负。

Cookie 会被缓存以供后续运行使用

不保证稳定性或可用性

##许可证

MIT
