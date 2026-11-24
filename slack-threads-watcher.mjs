// Waits for Slack's main-process inspector (Slack menu > View > Developer > Enable Main Process
// Inspector, which listens on 127.0.0.1:9229) and, as soon as it opens, installs
// slack-channel-threads.js into the normal Slack: into the open page now, and — through a hook in
// Slack's main process — into every page load after that, until Slack quits.
//
// Runs in the background at Windows sign-in (see install.ps1). One click per Slack start.
//   node slack-threads-watcher.mjs          keep watching
//   node slack-threads-watcher.mjs --once   inject once if the inspector is open, then exit
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SLACK_INSPECTOR_PORT || 9229);
const LOCK_PORT = 9239; // single-instance lock
// Installed copies live in <install>\app and log to <install>; a dev run logs to the default one.
const DATA = basename(HERE) === "app" ? dirname(HERE) : join(homedir(), ".slack-channel-threads");
const LOG = join(DATA, "watcher.log");
const SCRIPT = join(HERE, "slack-channel-threads.js");
const POLL_MS = 2000;
const once = process.argv.includes("--once");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(" ")}`;
  console.log(line);
  try { await appendFile(LOG, line + "\n"); } catch { /* best effort */ }
}

async function inspectorTarget() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1000) });
    const list = await res.json();
    return list.find((t) => t.webSocketDebuggerUrl) || null;
  } catch {
    return null;
  }
}

// Runs inside Slack's main (Node) process. Idempotent: re-running only refreshes the script text.
function mainProgram(source) {
  return `(() => {
  const req = typeof require === "function" ? require : process.mainModule.require.bind(process.mainModule);
  const { app, webContents } = req("electron");
  globalThis.__sctSource = ${JSON.stringify(source)};
  const isClient = (u) => /^https:\\/\\/app\\.slack\\.com\\/client\\//.test(u);
  const inject = (wc) => {
    if (wc.isDestroyed() || !isClient(wc.getURL())) return;
    wc.executeJavaScript(globalThis.__sctSource, true).catch(() => {});
  };
  const hooked = (globalThis.__sctHooked = globalThis.__sctHooked || new WeakSet());
  const hook = (wc) => {
    if (hooked.has(wc)) return;
    hooked.add(wc);
    wc.on("dom-ready", () => inject(wc)); // every reload / navigation to the client
  };
  if (!globalThis.__sctAppHook) {
    globalThis.__sctAppHook = true;
    app.on("web-contents-created", (_e, wc) => hook(wc));
  }
  const all = webContents.getAllWebContents();
  all.forEach(hook);
  all.forEach(inject);
  return all.filter((w) => isClient(w.getURL())).length;
})()`;
}

async function install(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("inspector websocket failed"));
    setTimeout(() => reject(new Error("inspector websocket timeout")), 5000);
  });
  try {
    const source = await readFile(SCRIPT, "utf8");
    const reply = await new Promise((resolve, reject) => {
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id === 1) resolve(msg);
      };
      ws.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression: mainProgram(source), returnByValue: true, includeCommandLineAPI: true },
      }));
      setTimeout(() => reject(new Error("evaluate timeout")), 15000);
    });
    if (reply.error) throw new Error(reply.error.message);
    const r = reply.result;
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
    return r.result.value;
  } finally {
    ws.close();
  }
}

function takeLock() {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(LOCK_PORT, "127.0.0.1", () => resolve(true));
  });
}

async function main() {
  await mkdir(DATA, { recursive: true });
  if (!once && !(await takeLock())) {
    await log(`another watcher already holds 127.0.0.1:${LOCK_PORT}, exiting`);
    return;
  }
  if (!once) await log("watching for Slack's main-process inspector on port", PORT);

  let handled = null; // inspector target id we already installed into
  for (;;) {
    const target = await inspectorTarget();
    if (target && target.id !== handled) {
      try {
        const pages = await install(target);
        handled = target.id;
        await log(`installed: ${pages} Slack page(s) injected, reload hook active`);
      } catch (e) {
        await log("install failed:", e.message);
      }
    } else if (!target && handled) {
      handled = null; // Slack restarted or inspector toggled off: next opening gets a fresh install
    }
    if (once) return;
    await sleep(POLL_MS);
  }
}

main().catch((e) => log("fatal:", e.message).then(() => process.exit(1)));
