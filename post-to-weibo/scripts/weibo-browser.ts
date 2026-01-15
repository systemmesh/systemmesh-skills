import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const WEIBO_URL = 'https://weibo.com/';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to allocate a free TCP port.')));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function findChromeExecutable(): string | undefined {
  const override = process.env.WEIBO_BROWSER_CHROME_PATH?.trim() || process.env.X_BROWSER_CHROME_PATH?.trim();
  if (override && fs.existsSync(override)) return override;

  const candidates: string[] = [];
  switch (process.platform) {
    case 'darwin':
      candidates.push(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      );
      break;
    case 'win32':
      candidates.push(
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      );
      break;
    default:
      candidates.push(
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
        '/usr/bin/microsoft-edge',
      );
      break;
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function getDefaultProfileDir(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'weibo-browser-profile');
}

async function fetchJson<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Request failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function waitForChromeDebugPort(port: number, timeoutMs: number): Promise<string> {
  const start = Date.now();
  let lastError: unknown = null;

  while (Date.now() - start < timeoutMs) {
    try {
      const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(`http://127.0.0.1:${port}/json/version`);
      if (version.webSocketDebuggerUrl) return version.webSocketDebuggerUrl;
      lastError = new Error('Missing webSocketDebuggerUrl');
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }

  throw new Error(`Chrome debug port not ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

class CdpConnection {
  private ws: WebSocket;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | null }>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.addEventListener('message', (event) => {
      try {
        const data = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
        const msg = JSON.parse(data) as { id?: number; result?: unknown; error?: { message?: string } };

        if (msg.id) {
          const pending = this.pending.get(msg.id);
          if (pending) {
            this.pending.delete(msg.id);
            if (pending.timer) clearTimeout(pending.timer);
            if (msg.error?.message) pending.reject(new Error(msg.error.message));
            else pending.resolve(msg.result);
          }
        }
      } catch {}
    });

    this.ws.addEventListener('close', () => {
      for (const [id, pending] of this.pending.entries()) {
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new Error('CDP connection closed.'));
      }
    });
  }

  static async connect(url: string, timeoutMs: number): Promise<CdpConnection> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timeout.')), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP connection failed.'));
      });
    });
    return new CdpConnection(ws);
  }

  async send<T = unknown>(method: string, params?: Record<string, unknown>, options?: { sessionId?: string; timeoutMs?: number }): Promise<T> {
    const id = ++this.nextId;
    const message: Record<string, unknown> = { id, method };
    if (params) message.params = params;
    if (options?.sessionId) message.sessionId = options.sessionId;

    const timeoutMs = options?.timeoutMs ?? 15_000;

    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(message));
    });

    return result as T;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {}
  }
}

interface WeiboPostOptions {
  text?: string;
  images?: string[];
  submit?: boolean;
  timeoutMs?: number;
  profileDir?: string;
  chromePath?: string;
}

async function waitForEditor(cdp: CdpConnection, sessionId: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await cdp.send<{ result: { value: boolean } }>(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const root = document.querySelector('#homeWrap') || document.body;

          const isVisible = (el) => {
            if (!(el instanceof Element)) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            const rects = el.getClientRects();
            if (!rects || rects.length === 0) return false;
            return true;
          };

          const candidates = Array.from(root.querySelectorAll('textarea, [contenteditable="true"]'))
            .filter((el) => el instanceof HTMLElement && isVisible(el));

          const scoreFor = (el) => {
            let score = 0;
            let node = el;
            for (let depth = 0; depth < 12 && node; depth++) {
              const text = (node.textContent || '').replace(/\s+/g, '');
              if (text.includes('发送')) score += 6;
              if (text.includes('图片')) score += 4;
              node = node.parentElement;
              if (node === root) break;
            }

            const rect = el.getBoundingClientRect();
            const area = Math.max(0, rect.width) * Math.max(0, rect.height);
            if (area > 0) score += Math.min(4, Math.floor(area / 50_000));

            return score;
          };

          let best = null;
          let bestScore = -1;
          for (const el of candidates) {
            const score = scoreFor(el);
            if (score > bestScore) {
              bestScore = score;
              best = el;
            }
          }

          if (!best || bestScore <= 0) return false;

          for (const el of candidates) {
            try {
              el.removeAttribute('data-opencode-weibo-editor');
            } catch {}
          }

          try {
            best.setAttribute('data-opencode-weibo-editor', 'true');
          } catch {}

          return true;
        })()`,
        returnByValue: true,
      },
      { sessionId },
    );
    if (result.result.value) return true;
    await sleep(500);
  }
  return false;
}

async function setText(cdp: CdpConnection, sessionId: string, text: string): Promise<boolean> {
  const result = await cdp.send<{ result: { value: boolean } }>(
    'Runtime.evaluate',
    {
      expression: `(() => {
        const targetText = ${JSON.stringify(text)};

        const isVisible = (el) => {
          if (!(el instanceof Element)) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          return el.getClientRects().length > 0;
        };

        const isEditor = (el) => {
          if (!el) return false;
          const tag = (el.tagName || '').toLowerCase();
          if (tag === 'textarea') return true;
          if (el.getAttribute && el.getAttribute('contenteditable') === 'true') return true;
          return !!el.isContentEditable;
        };

        const pickWithin = (root) => {
          const candidates = Array.from(root.querySelectorAll('textarea, [contenteditable="true"]'));
          for (const candidate of candidates) {
            if (isEditor(candidate) && isVisible(candidate)) return candidate;
          }
          return null;
        };

        let el = document.querySelector('[data-opencode-weibo-editor="true"]');
        if (el && (!isEditor(el) || !isVisible(el))) el = null;

        if (!el) {
          const root = document.querySelector('#homeWrap') || document.body;
          el = pickWithin(root);
        }

        if (!el) return false;

        try {
          if (typeof el.scrollIntoView === 'function') {
            el.scrollIntoView({ block: 'center', inline: 'center' });
          }
        } catch {}

        try {
          if (typeof el.focus === 'function') el.focus();
        } catch {}

        const tag = (el.tagName || '').toLowerCase();

        const dispatchInputAndChange = (node) => {
          try {
            node.dispatchEvent(new InputEvent('input', { bubbles: true, data: targetText, inputType: 'insertText' }));
          } catch {
            try {
              node.dispatchEvent(new Event('input', { bubbles: true }));
            } catch {}
          }
          try {
            node.dispatchEvent(new Event('change', { bubbles: true }));
          } catch {}
        };

        if (tag === 'textarea') {
          try {
            const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
            if (desc && typeof desc.set === 'function') {
              desc.set.call(el, targetText);
            } else {
              el.value = targetText;
            }
          } catch {
            try {
              el.value = targetText;
            } catch {}
          }

          dispatchInputAndChange(el);
          return true;
        }

        let inserted = false;
        try {
          if (typeof document.execCommand === 'function') {
            try {
              document.execCommand('selectAll', false, null);
            } catch {}
            inserted = document.execCommand('insertText', false, targetText);
          }
        } catch {}

        if (!inserted) {
          try {
            el.textContent = targetText;
          } catch {
            return false;
          }
        }

        dispatchInputAndChange(el);
        return true;
      })()`,
      returnByValue: true,
    },
    { sessionId },
  );
  return result.result.value;
}

async function clickTextButton(cdp: CdpConnection, sessionId: string, label: string): Promise<boolean> {
  const result = await cdp.send<{ result: { value: boolean } }>(
    'Runtime.evaluate',
    {
      expression: `(() => {
        const rawLabel = ${JSON.stringify(label)};

        const normalize = (value) => {
          return String(value ?? '')
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .replace(/[\s\u00A0]+/g, ' ')
            .trim();
        };

        const target = normalize(rawLabel);
        if (!target) return false;

        const isVisible = (el) => {
          if (!(el instanceof Element)) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          return el.getClientRects().length > 0;
        };

        const isDisabled = (el) => {
          if (!(el instanceof Element)) return false;
          if (el.getAttribute && el.getAttribute('disabled') !== null) return true;
          const ariaDisabled = el.getAttribute ? el.getAttribute('aria-disabled') : null;
          if (ariaDisabled && normalize(ariaDisabled).toLowerCase() === 'true') return true;
          return false;
        };

        const safeClick = (el) => {
          try {
            if (!el || !(el instanceof Element)) return false;
            if (isDisabled(el)) return false;
            if (typeof el.scrollIntoView === 'function') {
              try {
                el.scrollIntoView({ block: 'center', inline: 'center' });
              } catch {}
            }
            if (el instanceof HTMLElement && typeof el.focus === 'function') {
              try {
                el.focus();
              } catch {}
            }
            el.click();
            return true;
          } catch {
            return false;
          }
        };

        const preferredSelector = 'button, [role="button"], a';
        const matches = (el) => {
          const ariaLabel = el.getAttribute ? el.getAttribute('aria-label') : null;
          const title = el.getAttribute ? el.getAttribute('title') : null;
          const text = el.textContent;

          const normalizedAriaLabel = normalize(ariaLabel);
          const normalizedTitle = normalize(title);
          const normalizedText = normalize(text);

          return (normalizedAriaLabel === target || normalizedAriaLabel.includes(target))
            || (normalizedTitle === target || normalizedTitle.includes(target))
            || (normalizedText === target || normalizedText.includes(target));
        };

        const base = document.querySelector('#homeWrap') || document.body;
        let scope = base;

        const hasMatchingClickable = (root) => {
          try {
            return Array.from(root.querySelectorAll(preferredSelector))
              .filter((el) => isVisible(el))
              .some((el) => matches(el));
          } catch {
            return false;
          }
        };

        const editor = document.querySelector('[data-opencode-weibo-editor="true"]');
        if (editor && editor instanceof Element) {
          let node = editor;
          for (let depth = 0; depth < 10 && node; depth++) {
            if (node === base) break;
            if (hasMatchingClickable(node)) {
              scope = node;
              break;
            }
            node = node.parentElement;
          }
        }

        const preferredCandidates = Array.from(scope.querySelectorAll(preferredSelector)).filter((el) => isVisible(el));

        for (const el of preferredCandidates) {
          if (!matches(el)) continue;
          if (safeClick(el)) return true;
        }

        const textCandidates = Array.from(
          scope.querySelectorAll('span, div, p, label, strong, em, button, [role="button"], a'),
        ).filter((el) => isVisible(el));

        for (const el of textCandidates) {
          if (!normalize(el.textContent).includes(target)) continue;
          const container = typeof el.closest === 'function' ? el.closest(preferredSelector) : null;
          if (container && isVisible(container) && safeClick(container)) return true;
          if (safeClick(el)) return true;
        }

        return false;
      })()`,
      returnByValue: true,
    },
    { sessionId },
  );
  return result.result.value;
}

async function uploadImages(cdp: CdpConnection, sessionId: string, images: string[]): Promise<number> {
  const existing = images.filter((p) => fs.existsSync(p));
  if (existing.length === 0) return 0;

  await clickTextButton(cdp, sessionId, '图片');
  await sleep(500);

  const { root } = await cdp.send<{ root: { nodeId: number } }>('DOM.getDocument', {}, { sessionId });
  const { nodeIds } = await cdp.send<{ nodeIds: number[] }>(
    'DOM.querySelectorAll',
    { nodeId: root.nodeId, selector: 'input[type="file"]' },
    { sessionId },
  );

  if (!nodeIds || nodeIds.length === 0) {
    return 0;
  }

  const targetNodeId = nodeIds[nodeIds.length - 1]!;
  await cdp.send('DOM.setFileInputFiles', { nodeId: targetNodeId, files: existing }, { sessionId });
  await sleep(2000);
  return existing.length;
}

export async function postToWeibo(options: WeiboPostOptions): Promise<void> {
  const { text, images = [], submit = false, timeoutMs = 120_000, profileDir = getDefaultProfileDir() } = options;

  const chromePath = options.chromePath ?? findChromeExecutable();
  if (!chromePath) throw new Error('Chrome not found. Set WEIBO_BROWSER_CHROME_PATH env var.');

  await mkdir(profileDir, { recursive: true });

  const port = await getFreePort();
  console.log(`[weibo] Launching Chrome (profile: ${profileDir})`);

  const chrome = spawn(
    chromePath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
      WEIBO_URL,
    ],
    { stdio: 'ignore' },
  );

  let cdp: CdpConnection | null = null;

  try {
    const wsUrl = await waitForChromeDebugPort(port, 30_000);
    cdp = await CdpConnection.connect(wsUrl, 30_000);

    const targets = await cdp.send<{ targetInfos: Array<{ targetId: string; url: string; type: string }> }>('Target.getTargets');
    let pageTarget = targets.targetInfos.find((t) => t.type === 'page' && t.url.includes('weibo.com'));

    if (!pageTarget) {
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: WEIBO_URL });
      pageTarget = { targetId, url: WEIBO_URL, type: 'page' };
    }

    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });

    await cdp.send('Page.enable', {}, { sessionId });
    await cdp.send('Runtime.enable', {}, { sessionId });
    await cdp.send('DOM.enable', {}, { sessionId });

    console.log('[weibo] Waiting for editor...');
    await sleep(1500);

    const editorFound = await waitForEditor(cdp, sessionId, timeoutMs);
    if (!editorFound) {
      console.log('[weibo] Editor not found. Please log in to Weibo in the browser window, then retry.');
      await sleep(30_000);
      const afterLogin = await waitForEditor(cdp, sessionId, timeoutMs);
      if (!afterLogin) throw new Error('Timed out waiting for editor.');
    }

    if (text) {
      console.log('[weibo] Setting text...');
      const ok = await setText(cdp, sessionId, text);
      if (!ok) throw new Error('Failed to set text.');
      await sleep(500);
    }

    const uploaded = await uploadImages(cdp, sessionId, images);
    if (uploaded > 0) console.log(`[weibo] Selected ${uploaded} image(s).`);

    if (submit) {
      console.log('[weibo] Submitting...');
      const clicked = await clickTextButton(cdp, sessionId, '发送');
      if (!clicked) throw new Error('Submit button (发送) not found.');
      await sleep(2000);
      console.log('[weibo] Submitted.');
    } else {
      console.log('[weibo] Draft composed (preview mode). Add --submit to post.');
      console.log('[weibo] Browser will stay open for 30 seconds for preview...');
      await sleep(30_000);
    }
  } finally {
    if (cdp) {
      try {
        await cdp.send('Browser.close', {}, { timeoutMs: 5_000 });
      } catch {}
      cdp.close();
    }

    setTimeout(() => {
      if (!chrome.killed) {
        try {
          chrome.kill('SIGKILL');
        } catch {}
      }
    }, 2_000).unref?.();

    try {
      chrome.kill('SIGTERM');
    } catch {}
  }
}

function printUsage(exitCode: number): never {
  console.log(`Post to Weibo using real Chrome browser

Usage:
  npx -y bun weibo-browser.ts [options] [text]

Options:
  --image <path>   Add image (repeatable)
  --submit         Actually post (default: preview only)
  --profile <dir>  Chrome profile directory
  --help           Show this help

Examples:
  npx -y bun weibo-browser.ts "Hello 微博!"
  npx -y bun weibo-browser.ts "Hello" --image ./a.png --image ./b.jpg
  npx -y bun weibo-browser.ts "Post it" --submit
`);
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) printUsage(0);

  const images: string[] = [];
  let submit = false;
  let profileDir: string | undefined;
  const textParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--image' && args[i + 1]) {
      images.push(args[++i]!);
    } else if (arg === '--submit') {
      submit = true;
    } else if (arg === '--profile' && args[i + 1]) {
      profileDir = args[++i];
    } else if (!arg.startsWith('-')) {
      textParts.push(arg);
    }
  }

  const text = textParts.join(' ').trim() || undefined;

  if (!text && images.length === 0) {
    printUsage(1);
  }

  await postToWeibo({ text, images, submit, profileDir });
}

await main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
