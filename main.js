const { app, BrowserWindow } = require('electron');
const path = require('path');
const { SERVER_URL } = require('./config');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    fullscreen: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'host', 'index.html'));

  mainWindow.on('closed', () => { mainWindow = null; });
}

async function maybeStartLocalServer() {
  if (!SERVER_URL.includes('localhost')) return;
  const { startServer } = require('./server/gameServer');
  const port = parseInt(new URL(SERVER_URL).port) || 3000;
  try {
    await startServer(port);
    console.log(`Local game server running on port ${port}`);
  } catch (err) {
    console.error('Failed to start local server:', err);
  }
}

app.whenReady().then(async () => {
  await maybeStartLocalServer();
  createWindow();
});

app.on('window-all-closed', () => {
  if (SERVER_URL.includes('localhost')) {
    const { stopServer } = require('./server/gameServer');
    stopServer();
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
