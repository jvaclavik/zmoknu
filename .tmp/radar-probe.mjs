import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdirSync } from "node:fs";

const CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9334;
const PAGE = "http://localhost:5173/?lat=50.0755&lon=14.4378&name=Praha";
const profile = `/tmp/zmoknu-radar-probe-${Date.now()}`;
mkdirSync(profile, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--use-angle=swiftshader",
    "--enable-webgl",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    PAGE,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let stderr = "";
chrome.stderr.on("data", (d) => {
  stderr += d.toString();
});

async function waitReady() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (r.ok) return r.json();
    } catch {}
    await delay(250);
  }
  throw new Error(`chrome debug not ready\n${stderr.slice(-500)}`);
}

function wsConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    import("node:http").then(({ request }) => {
      const u = new URL(wsUrl);
      const req = request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": Buffer.from("probe".padEnd(16, "x")).toString(
            "base64",
          ),
        },
      });
      req.on("upgrade", (_res, socket) => resolve(socket));
      req.on("error", reject);
      req.end();
    });
  });
}

function encodeFrame(data) {
  const json = Buffer.from(JSON.stringify(data));
  const len = json.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 + len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 + 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 + 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = Buffer.from([1, 2, 3, 4]);
  const payload = Buffer.alloc(len);
  for (let i = 0; i < len; i++) payload[i] = json[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, payload]);
}

function attachWs(socket) {
  let buf = Buffer.alloc(0);
  const pending = new Map();
  const logs = [];
  let id = 1;
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0xf;
      let n = buf[1] & 0x7f;
      let off = 2;
      if (n === 126) {
        if (buf.length < 4) return;
        n = buf.readUInt16BE(2);
        off = 4;
      } else if (n === 127) {
        if (buf.length < 10) return;
        n = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (buf.length < off + n) return;
      const payload = buf.subarray(off, off + n).toString("utf8");
      buf = buf.subarray(off + n);
      if (opcode !== 1) continue;
      let msg;
      try {
        msg = JSON.parse(payload);
      } catch {
        continue;
      }
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails ?? {};
        logs.push(
          `EXC: ${d.text} ${d.exception?.description ?? d.exception?.value ?? ""} ${d.url ?? ""}:${d.lineNumber ?? ""}`,
        );
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        const t = msg.params.type;
        const text = (msg.params.args ?? [])
          .map((a) => a.value ?? a.description ?? a.type)
          .join(" ");
        if (t === "error" || /error|crash|fail/i.test(String(text)))
          logs.push(`console.${t}: ${text}`);
      }
      if (msg.method === "Log.entryAdded") {
        const e = msg.params.entry ?? {};
        if (e.level === "error")
          logs.push(`log.error: ${e.text}`);
      }
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = id++;
      pending.set(mid, resolve);
      socket.write(encodeFrame({ id: mid, method, params }));
      setTimeout(() => {
        if (pending.has(mid)) {
          pending.delete(mid);
          resolve({ error: "timeout", method });
        }
      }, 15000);
    });
  return { send, logs };
}

const pages = await waitReady();
const page = pages.find((p) => p.type === "page") ?? pages[0];
const socket = await wsConnect(page.webSocketDebuggerUrl);
const { send, logs } = attachWs(socket);

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await delay(2500);

const click = await send("Runtime.evaluate", {
  expression: `(() => {
    const btn = [...document.querySelectorAll('button,[role=tab]')].find(b => /radar/i.test(b.textContent||''));
    if (!btn) return { ok:false, buttons: [...document.querySelectorAll('button,[role=tab]')].map(b=>b.textContent).slice(0,12) };
    btn.click();
    return { ok:true, label: btn.textContent };
  })()`,
  returnByValue: true,
});
console.log("click:", JSON.stringify(click.result?.result?.value ?? click));

await delay(18000);

const dump = await send("Runtime.evaluate", {
  expression: `(() => {
    const cells = [...document.querySelectorAll('.radar-scrub-cell')];
    const count = (cls) => cells.filter(c => c.classList.contains(cls)).length;
    const overlay = document.querySelector('.radar-loading')?.textContent?.trim() ?? null;
    const errRoot = document.querySelector('#root')?.innerText?.slice(0, 800) ?? '';
    return {
      radarCard: !!document.querySelector('.radar-card'),
      loadingText: overlay,
      timebadge: document.querySelector('.radar-timebadge')?.textContent ?? null,
      cells: cells.length,
      ok: count('ok'),
      pending: count('pending'),
      pred: count('pred'),
      hasMapCanvas: !!document.querySelector('.radar-canvas canvas, .maplibregl-canvas'),
      chmiApi: performance.getEntriesByType('resource').filter(e => /chmi-opendata/.test(e.name)).length,
      htmlCrash: /Something went wrong|Minified React error|Uncaught/i.test(errRoot),
      bodyStart: document.body.innerText.slice(0, 500),
    };
  })()`,
  returnByValue: true,
});
console.log("dump:", JSON.stringify(dump.result?.result?.value ?? dump, null, 2));
console.log("errs:", logs.join("\n"));
chrome.kill();
process.exit(0);
