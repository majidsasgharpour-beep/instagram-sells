/**
 * Desktop shell for APEX-UI.
 *
 * Starts the Next.js server in the background, opens it in a native window and
 * stops the server when the window closes. The page itself is untouched - it is
 * the same app you get at http://localhost:3000, just without the browser.
 *
 *   npm run desktop        production server (builds once if there is no build yet)
 *   npm run desktop:dev    dev server (always compiles from the source)
 *   npm run desktop:build  rebuild first, then open
 */

const { app, BrowserWindow, session, shell } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DEV = process.argv.includes("--dev");
const REBUILD = process.argv.includes("--rebuild");

// A fixed port keeps the window's origin the same on every launch, so the saved
// Gemini API key (localStorage is per-origin) is still there next time.
const PREFERRED_PORT = 3817;

let server = null;
let win = null;
let origin = "";
let quitting = false;

const SPLASH = (text) =>
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;` +
      `background:#04080f;color:#a5f3fc;font:13px/1.6 Consolas,monospace;letter-spacing:.3em;text-transform:uppercase">` +
      `<div style="text-align:center">APEX<div style="margin-top:14px;opacity:.55;letter-spacing:.14em;font-size:11px">${text}</div></div></body>`
  );

function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

function anyFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => { res.resume(); resolve(); });
      req.on("error", () => {
        if (Date.now() > deadline) reject(new Error("The Apex server did not start in time."));
        else setTimeout(tick, 400);
      });
      req.setTimeout(2000, () => req.destroy());
    };
    tick();
  });
}

/** Run Next's CLI with Electron's own Node, so no separate Node install is needed. */
function runNext(args, port) {
  const nextBin = require.resolve("next/dist/bin/next", { paths: [ROOT] });
  return spawn(process.execPath, [nextBin, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: DEV ? "development" : "production",
      NEXT_TELEMETRY_DISABLED: "1",
      ...(port ? { PORT: String(port) } : {}),
    },
    stdio: "inherit",
    windowsHide: true,
  });
}

function build() {
  return new Promise((resolve, reject) => {
    const p = runNext(["build"]);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("next build failed (see the console)."))));
    p.on("error", reject);
  });
}

function stopServer() {
  if (!server) return;
  const pid = server.pid;
  server = null;
  try {
    if (process.platform === "win32" && pid) spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(pid);
  } catch { /* already gone */ }
}

function lockToOrigin(contents) {
  // Links to other sites open in the normal browser, not inside this window.
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (e, url) => {
    if (!url.startsWith(origin) && !url.startsWith("data:")) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
}

function allowMicrophone() {
  // Only this app's own page may use the microphone (the Gemini voice session).
  const ok = (wcUrl, permission) =>
    permission === "media" && !!origin && typeof wcUrl === "string" && wcUrl.startsWith(origin);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(ok(wc.getURL(), permission)));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => ok(wc ? wc.getURL() : "", permission));
}

function sendKeyAsHeader() {
  // Google's docs send the Gemini key in the x-goog-api-key header. A page cannot
  // set headers on a WebSocket, so mirror the ?key= value into that header for
  // Google's Generative Language host only - this lets the newer "AQ." keys
  // authenticate the same way the docs show.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["wss://generativelanguage.googleapis.com/*", "https://generativelanguage.googleapis.com/*"] },
    (details, callback) => {
      try {
        const key = new URL(details.url).searchParams.get("key");
        if (key) details.requestHeaders["x-goog-api-key"] = key;
      } catch { /* leave the request as it is */ }
      callback({ requestHeaders: details.requestHeaders });
    }
  );
}

async function launch() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 560,
    title: "Apex",
    backgroundColor: "#04080f",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.on("closed", () => { win = null; });
  win.webContents.setBackgroundThrottling?.(false);
  await win.loadURL(SPLASH("Starting"));

  try {
    const port = (await isPortFree(PREFERRED_PORT)) ? PREFERRED_PORT : await anyFreePort();
    origin = `http://127.0.0.1:${port}`;

    if (!DEV && (REBUILD || !fs.existsSync(path.join(ROOT, ".next", "BUILD_ID")))) {
      await win.loadURL(SPLASH("Building - first run takes a minute"));
      await build();
    }
    if (quitting || !win) return;

    server = runNext([DEV ? "dev" : "start", "-p", String(port), "-H", "127.0.0.1"], port);
    server.on("exit", (code) => {
      if (!quitting && win) win.loadURL(SPLASH(`Server stopped (code ${code})`));
    });

    await waitForServer(origin, 120000);
    if (quitting || !win) return;

    lockToOrigin(win.webContents);
    await win.loadURL(origin);
  } catch (err) {
    if (win) win.loadURL(SPLASH(String((err && err.message) || err)));
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    allowMicrophone();
    sendKeyAsHeader();
    launch();
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) launch(); });
  });

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => { quitting = true; stopServer(); });
  process.on("exit", stopServer);
}
