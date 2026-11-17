// Dev tool: loads slack-channel-threads.js into the running Slack desktop app through Slack's own
// main-process inspector (Slack menu > View > Developer > Enable Main Process Inspector,
// shown once SLACK_DEVELOPER_MENU=true is set, see install.ps1). It listens on 127.0.0.1:9229.
//
//   node inject.mjs           inject (or re-inject) the script and print SCT.diag()
//   node inject.mjs diag      only print SCT.diag()
//   node inject.mjs stop      remove the script from Slack
//   node inject.mjs devtools  open the regular DevTools window for the Slack page
//   node inject.mjs list      list Slack's web contents
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = process.env.SLACK_INSPECTOR_PORT || 9229;
const mode = process.argv[2] || "inject";
const here = dirname(fileURLToPath(import.meta.url));

let targets;
try {
  targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
} catch {
  console.error(`Nothing on 127.0.0.1:${PORT}. In Slack: menu > View > Developer > Enable Main Process Inspector.`);
  process.exit(1);
}
const target = targets.find((t) => t.webSocketDebuggerUrl);
if (!target) {
  console.error("Inspector is up but exposes no debuggable target:", targets);
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok, fail) => {
  ws.onopen = ok;
  ws.onerror = () => fail(new Error("could not connect to the inspector websocket"));
});
let nextId = 1;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
function send(method, params) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((ok, fail) => {
    pending.set(id, ok);
    setTimeout(() => fail(new Error(`${method} timed out`)), 30000);
  });
}

async function evaluateMain(expression) {
  const res = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    includeCommandLineAPI: true, // gives us `require` in the main process
  });
  if (res.error) throw new Error(res.error.message);
  if (res.result.exceptionDetails) {
    const d = res.result.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text);
  }
  return res.result.result.value;
}

const source = mode === "inject" ? await readFile(join(here, "..", "slack-channel-threads.js"), "utf8") : "";

// Runs inside Slack's main (Node) process.
const mainProgram = `(async () => {
  const req = typeof require === "function" ? require : process.mainModule && process.mainModule.require.bind(process.mainModule);
  if (!req) throw new Error("no require() in the main process");
  const { webContents } = req("electron");
  const all = webContents.getAllWebContents();
  const list = all.map((w) => ({ id: w.id, type: w.getType(), url: w.getURL().replace(/\\?.*$/, "") }));
  const pages = all.filter((w) => /^https:\\/\\/app\\.slack\\.com\\//.test(w.getURL()));
  const mode = ${JSON.stringify(mode)};
  if (mode === "list") return { list };
  if (!pages.length) return { list, error: "no app.slack.com page" };
  const out = [];
  for (const w of pages) {
    const entry = { id: w.id, url: w.getURL().replace(/\\?.*$/, "") };
    if (mode === "devtools") { w.openDevTools({ mode: "detach" }); entry.result = "devtools opened"; out.push(entry); continue; }
    if (mode === "eval") { entry.result = await w.executeJavaScript(${JSON.stringify(process.argv[3] || "0")}, true); out.push(entry); continue; }
    if (mode === "shot") {
      // Capture only the channel sidebar, not the message pane.
      const r = await w.executeJavaScript('(() => { const el = document.querySelector(".p-channel_sidebar__list") || document.querySelector(".p-channel_sidebar"); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }; })()');
      if (!r) { entry.result = "sidebar not found"; out.push(entry); continue; }
      const img = await w.capturePage(r);
      req("fs").writeFileSync(${JSON.stringify(join(here, "sidebar-shot.png"))}, img.toPNG());
      entry.result = { saved: "sidebar-shot.png", rect: r };
      out.push(entry);
      continue;
    }
    if (mode === "stop") { entry.result = await w.executeJavaScript('window.SCT ? (SCT.stop(), "stopped") : "not running"'); out.push(entry); continue; }
    if (mode === "inject") {
      await w.executeJavaScript(${JSON.stringify(source)} + "\\n;0", true);
      await new Promise((r) => setTimeout(r, 4000));
    }
    entry.diag = await w.executeJavaScript('window.SCT ? JSON.stringify(SCT.diag()) : "null"');
    try { entry.diag = JSON.parse(entry.diag); } catch (_) {}
    out.push(entry);
  }
  return { list, out };
})()`;

try {
  const result = await evaluateMain(mainProgram);
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error("Failed:", e.message);
  process.exitCode = 1;
} finally {
  ws.close();
}
