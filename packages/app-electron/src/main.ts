import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, protocol, shell } from 'electron';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { request as httpRequest } from 'node:http';

const PORT = 57312;

let serverProcess: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let logPath: string | null = null;

// Must be set before app.whenReady() — controls Task Manager display name
app.setName('Loamium');
if (process.platform === 'win32') app.setAppUserModelId('com.loamium.app');

// ── custom protocol ──────────────────────────────────────────────────────────
// Must be called BEFORE app.whenReady()
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'loamium',
    privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

// ── logging ───────────────────────────────────────────────────────────────────
function initLog(): void {
  const dir = join(app.getPath('userData'), 'logs');
  mkdirSync(dir, { recursive: true });
  logPath = join(dir, 'loamium.log');
  // Truncate old log on each launch
  writeFileSync(logPath, `=== Loamium launched ===\n`, 'utf-8');
}

function log(line: string): void {
  const msg = `[${new Date().toISOString()}] ${line}\n`;
  process.stdout.write(msg);
  if (logPath) {
    try { appendFileSync(logPath, msg, 'utf-8'); } catch { /* ignore */ }
  }
}

// ── config ────────────────────────────────────────────────────────────────────
const configPath = join(app.getPath('userData'), 'loamium-config.json');

interface Config {
  vaultPath?: string;
}

function readConfig(): Config {
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as Config;
  } catch {
    return {};
  }
}

function writeConfig(config: Config): void {
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

// ── paths ─────────────────────────────────────────────────────────────────────
function findServerEntry(): { runner: string; args: string[] } {
  if (app.isPackaged) {
    const binName = process.platform === 'win32' ? 'loamium-server.exe' : 'loamium-server';
    return { runner: join(process.resourcesPath, binName), args: [] };
  }
  return {
    runner: resolve(__dirname, '../../../node_modules/.bin/tsx'),
    args: [resolve(__dirname, '../../server/src/index.ts')],
  };
}

function findUiDist(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'ui-dist');
  return resolve(__dirname, '../../ui/dist');
}

function findIconPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'icon.ico');
  return resolve(__dirname, '../resources/icon.ico');
}

function findPreloadPath(): string {
  return join(__dirname, 'preload.js');
}

// ── MIME ──────────────────────────────────────────────────────────────────────
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
};

// ── API proxy ─────────────────────────────────────────────────────────────────
// Uses Node.js http.request instead of net.fetch — net.fetch is restricted inside
// protocol.handle callbacks on some Electron builds.
function proxyToHono(
  pathname: string,
  search: string,
  method: string,
  reqHeaders: Headers,
  body?: ArrayBuffer,
): Promise<Response> {
  return new Promise((resolve) => {
    // Build headers: strip origin/host; recalculate content-length from actual body
    const headers: Record<string, string> = {};
    reqHeaders.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === 'origin' || lower === 'host' || lower === 'content-length') return;
      headers[key] = value;
    });
    const bodyBuf = body && body.byteLength > 0 ? Buffer.from(body) : undefined;
    if (bodyBuf) headers['content-length'] = String(bodyBuf.byteLength);

    log(`[proxy] ${method} ${pathname}${search} body=${bodyBuf?.byteLength ?? 0}B`);

    const req = httpRequest(
      { hostname: '127.0.0.1', port: PORT, path: `${pathname}${search}`, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const resHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined && k.toLowerCase() !== 'transfer-encoding') {
              resHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
            }
          }
          const status = res.statusCode ?? 200;
          const body = Buffer.concat(chunks);
          log(`[proxy] → ${status} ${body.length}B`);
          resolve(new Response(body, { status, headers: resHeaders }));
        });
        res.on('error', (e) => {
          log(`[proxy] res error: ${e.message}`);
          resolve(new Response('upstream error', { status: 502 }));
        });
      },
    );

    req.on('error', (e) => {
      log(`[proxy] req error: ${e.message}`);
      resolve(new Response('upstream error', { status: 502 }));
    });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ── protocol handler ──────────────────────────────────────────────────────────
function setupProtocol(uiDist: string): void {
  protocol.handle('loamium', async (request) => {
    const url = new URL(request.url);
    const { pathname, search } = url;

    if (pathname.startsWith('/api')) {
      const hasBody = !['GET', 'HEAD'].includes(request.method);
      const body = hasBody ? await request.arrayBuffer() : undefined;
      return proxyToHono(pathname, search, request.method, request.headers, body);
    }

    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const filePath = join(uiDist, rel);
    const toServe = existsSync(filePath) ? filePath : join(uiDist, 'index.html');
    return new Response(readFileSync(toServe), {
      headers: { 'Content-Type': MIME[extname(toServe)] ?? 'application/octet-stream' },
    });
  });
}

// ── server lifecycle ──────────────────────────────────────────────────────────
async function waitForServer(): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return true;
    } catch { /* not yet */ }
    await new Promise<void>((r) => setTimeout(r, 300));
  }
  return false;
}

function startServer(vaultPath: string): void {
  serverProcess?.kill();
  const { runner, args } = findServerEntry();

  log(`[main] server: ${runner}`);
  log(`[main] vault: ${vaultPath}`);

  serverProcess = spawn(runner, args, {
    env: { ...process.env, LOAMIUM_VAULT: vaultPath, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout?.on('data', (b: Buffer) => log(`[srv] ${b.toString().trimEnd()}`));
  serverProcess.stderr?.on('data', (b: Buffer) => log(`[srv!] ${b.toString().trimEnd()}`));
  serverProcess.on('exit', (code) => log(`[srv] exit ${code}`));

  void waitForServer().then((ok) => {
    if (ok) {
      log('[main] server ready — loading loamium://loamium/');
      mainWindow?.loadURL('loamium://loamium/');
    } else {
      const msg = `<meta charset="UTF-8"><body style="font-family:sans-serif;padding:2em"><h2>&#12469;&#12540;&#12496;&#12540;&#12364;&#36215;&#21205;&#12391;&#12365;&#12414;&#12379;&#12435;&#12391;&#12375;&#12383;</h2><p>PORT ${PORT} &#12391;&#24540;&#31572;&#12364;&#12354;&#12426;&#12414;&#12379;&#12435;&#12290;&#12450;&#12503;&#12522;&#12434;&#20877;&#36215;&#21205;&#12375;&#12390;&#12367;&#12384;&#12373;&#12356;&#12290;</p><p><a href="loamium://loamium/debug/log">&#12525;&#12464;&#12434;&#35211;&#12427;</a></p></body>`;
      mainWindow?.loadURL(`data:text/html;charset=UTF-8;base64,${Buffer.from(msg).toString('base64')}`);
    }
  });
}

// ── vault selection ───────────────────────────────────────────────────────────
async function pickVault(): Promise<string | undefined> {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Loamium vault フォルダを選択',
    buttonLabel: 'この場所を vault にする',
  });
  return canceled ? undefined : filePaths[0];
}

// ── menu ──────────────────────────────────────────────────────────────────────
// No persistent menu bar — it's hidden. The app menu is shown on vault-badge click via IPC.
function setupMenu(): void {
  Menu.setApplicationMenu(null);

  ipcMain.on('show-app-menu', (_event, x: number, y: number) => {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'Vault を変更...',
        accelerator: 'CmdOrCtrl+Shift+O',
        click: async () => {
          const vaultPath = await pickVault();
          if (!vaultPath) return;
          writeConfig({ vaultPath });
          mainWindow?.loadURL('about:blank');
          startServer(vaultPath);
        },
      },
      { type: 'separator' },
      {
        label: 'ログファイルを開く',
        click: () => { if (logPath) void shell.openPath(logPath); },
      },
      { type: 'separator' },
      { label: '再読み込み', role: 'reload' },
      { label: '開発者ツール', role: 'toggleDevTools' },
      { type: 'separator' },
      {
        label: '最小化',
        click: () => mainWindow?.minimize(),
      },
      {
        label: '最大化 / 元に戻す',
        click: () => {
          if (mainWindow?.isMaximized()) mainWindow.restore();
          else mainWindow?.maximize();
        },
      },
      { type: 'separator' },
      { label: '終了', role: 'quit' },
    ];
    Menu.buildFromTemplate(template).popup({ window: mainWindow!, x, y });
  });
}

// ── loading screen (HTML entities = ASCII-only, no encoding issues) ────────────
// を=&#12434; 起=&#36215; 動=&#21205; 中=&#20013;
const LOADING_HTML =
  '<meta charset="UTF-8">' +
  '<style>body{background:#1a1a1a;color:#ccc;font-family:sans-serif;display:flex;' +
  'align-items:center;justify-content:center;height:100vh;margin:0;font-size:1.2em}</style>' +
  '<body>Loamium &#12434;&#36215;&#21205;&#20013;...</body>';

// ── app lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  initLog();
  log('[main] app ready');

  nativeTheme.themeSource = 'system';

  const uiDist = findUiDist();
  log(`[main] uiDist: ${uiDist}`);
  setupProtocol(uiDist);
  setupMenu();

  const iconPath = findIconPath();
  const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: 'Loamium',
    icon,
    // Obsidian-like: hide OS title bar; native controls float as an overlay
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#ffffff',
      symbolColor: '#374151',
      height: 46,
    },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: findPreloadPath(),
    },
  });

  // Keep overlay color in sync with OS dark/light mode
  const updateOverlay = (): void => {
    const dark = nativeTheme.shouldUseDarkColors;
    mainWindow?.setTitleBarOverlay?.({
      color: dark ? '#1e1e2e' : '#ffffff',
      symbolColor: dark ? '#cccccc' : '#374151',
    });
  };
  nativeTheme.on('updated', updateOverlay);

  mainWindow.on('closed', () => {
    serverProcess?.kill();
    mainWindow = null;
  });

  // HTML entities are ASCII-only → no charset/encoding issues in data URI
  await mainWindow.loadURL(
    `data:text/html;charset=UTF-8;base64,${Buffer.from(LOADING_HTML).toString('base64')}`,
  );

  const config = readConfig();
  let vaultPath =
    config.vaultPath && existsSync(config.vaultPath) ? config.vaultPath : undefined;
  if (!vaultPath) {
    vaultPath = await pickVault();
    if (!vaultPath) { app.quit(); return; }
    writeConfig({ vaultPath });
  }
  startServer(vaultPath);
});

app.on('window-all-closed', () => {
  serverProcess?.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  serverProcess?.kill();
});
