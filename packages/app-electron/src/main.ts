import { app, BrowserWindow, dialog, Menu, nativeTheme } from 'electron';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PORT = 57312;

let serverProcess: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;

// ── config ──────────────────────────────────────────────────────────────────

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
  mkdirSync(join(app.getPath('userData')), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

// ── server ───────────────────────────────────────────────────────────────────

function findServerEntry(): { runner: string; args: string[] } {
  const resourcesPath = process.resourcesPath ?? '';

  // 本番パッケージ内: bun compile 済みのサーバーバイナリを直接実行する
  const serverBinName = process.platform === 'win32' ? 'loamium-server.exe' : 'loamium-server';
  const packagedBin = join(resourcesPath, serverBinName);
  if (existsSync(packagedBin)) {
    return { runner: packagedBin, args: [] };
  }

  // 開発時: tsx でサーバーソースを直接実行する
  const devServer = resolve(__dirname, '../../server/src/index.ts');
  const tsx = resolve(__dirname, '../../../node_modules/.bin/tsx');
  return { runner: tsx, args: [devServer] };
}

function startServer(vaultPath: string): void {
  serverProcess?.kill();

  const { runner, args } = findServerEntry();

  serverProcess = spawn(runner, args, {
    env: {
      ...process.env,
      LOAMIUM_VAULT: vaultPath,
      PORT: String(PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    process.stdout.write(`[server] ${text}`);
    if (text.includes('listening on')) {
      mainWindow?.loadURL(`http://127.0.0.1:${PORT}`);
    }
  });

  serverProcess.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[server:err] ${chunk.toString()}`);
  });

  serverProcess.on('exit', (code) => {
    console.log(`[server] exited with code ${code}`);
  });
}

// ── vault selection ──────────────────────────────────────────────────────────

async function pickVault(): Promise<string | undefined> {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Loamium vault フォルダを選択',
    buttonLabel: 'この場所を vault にする',
  });
  return result.canceled ? undefined : result.filePaths[0];
}

async function changeVault(): Promise<void> {
  const vaultPath = await pickVault();
  if (!vaultPath) return;
  writeConfig({ vaultPath });
  mainWindow?.loadURL('about:blank');
  startServer(vaultPath);
}

// ── menu ─────────────────────────────────────────────────────────────────────

function setupMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Vault を変更...',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => { void changeVault(); },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── app lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'system';

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Loamium',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  setupMenu();

  // 起動中の簡易ローディング表示
  await mainWindow.loadURL('data:text/html,<style>body{background:#1a1a1a;color:#ccc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}</style><body>Loamium を起動中...</body>');

  const config = readConfig();
  if (config.vaultPath && existsSync(config.vaultPath)) {
    startServer(config.vaultPath);
  } else {
    const vaultPath = await pickVault();
    if (vaultPath) {
      writeConfig({ vaultPath });
      startServer(vaultPath);
    } else {
      app.quit();
    }
  }

  mainWindow.on('closed', () => {
    serverProcess?.kill();
    mainWindow = null;
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      app.emit('ready');
    }
  });
});

app.on('window-all-closed', () => {
  serverProcess?.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  serverProcess?.kill();
});
