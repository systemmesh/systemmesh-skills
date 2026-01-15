# systemmesh-skills

English | [中文](./README.zh.md)

Skills shared by SystemMesh for improving daily work efficiency with Claude Code or Open AI Codex.

## Prerequisites

- Node.js environment installed
- Ability to run `npx bun` commands

## Available Skills

### post-to-weibo

Post content to Weibo (微博):

```bash
- `npx -y bun ./scripts/weibo-browser.ts "你的内容"`

- `npx -y bun ./scripts/weibo-browser.ts "你的内容" --image /path/a.png --image /path/b.jpg`

- `npx -y bun ./scripts/weibo-browser.ts "你的内容" --submit`
```

Prerequisites: Google Chrome installed. First run requires QR code login (session preserved).

## Disclaimer

### post-to-weibo

This skill uses the Weibo Web.

**Warning:** This project uses unofficial access via browser cookies. Use at your own risk.

- Cookies are cached for subsequent runs
- No guarantees on stability or availability

## License

MIT
