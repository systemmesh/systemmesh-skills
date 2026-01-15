---
name: post-to-weibo
description: Use when a user asks to publish or draft a Weibo (微博) post with text and optional images via weibo.com.
---

# Post to Weibo (微博)

Draft and publish content to Weibo via `weibo.com` using a real Chrome profile.

## Safety Rules (mandatory)
- Default to **preview-only**. Do not submit unless the user explicitly says **“post now”**.
- Repeat back the exact final text and the exact image paths before any submit run.
- Never ask for passwords/tokens. Authentication is via an existing Chrome login session.

## Prerequisites
- Google Chrome / Chromium installed
- Ability to run `npx` (Node)
- First run: manually log into Weibo in the opened Chrome window

Optional:
- `WEIBO_BROWSER_CHROME_PATH` to point to the Chrome executable

## Quick Reference

**Text only (preview)**
- `npx -y bun ./scripts/weibo-browser.ts "你的内容"`

**Text + images (preview)**
- `npx -y bun ./scripts/weibo-browser.ts "你的内容" --image /path/a.png --image /path/b.jpg`

**Submit (only after explicit confirmation)**
- `npx -y bun ./scripts/weibo-browser.ts "你的内容" --submit`

## Expected UI
- Page: `https://weibo.com/`
- Compose textbox present after load
- Submit button text: `发送`
- Image upload button text: `图片`

## Workflow
1. Confirm: single Weibo post, text, optional image paths.
2. Run preview command (no `--submit`).
3. User verifies in the browser window.
4. Only if the user says **“post now”**, rerun with `--submit`.

**Debug mode:** Add `--inspect-ui` flag to keep Chrome open and log all discovered selectors (text box, image/submit buttons) so you can update skills after Weibo UI changes.
- **Fallback timeouts:** Initial page load wait → 15s; image upload wait → 10s; post-upload wait → 5s before submit.
- **Log output:** Print each discovered selector with `[weibo] Found: <selector>` and its attributes.
- Default profile directory is `~/.local/share/weibo-browser-profile`.
- UI selectors on Weibo may change; if the script can’t find the editor or buttons, log in manually and retry.
