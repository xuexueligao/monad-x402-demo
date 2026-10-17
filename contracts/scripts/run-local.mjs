import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compile, ROOT } from "./compile.mjs";

const task = process.argv[2];
if (!["test", "arena", "demo"].includes(task)) throw new Error("Usage: node scripts/run-local.mjs test|arena|demo");
const tempDirectory = path.resolve(ROOT, "..", ".local", "tmp");
await fs.mkdir(tempDirectory, { recursive: true });
process.env.TEMP = tempDirectory;
process.env.TMP = tempDirectory;
await compile();
await fs.mkdir(path.join(ROOT, ".local"), { recursive: true });

// Each run owns its node and selects a free loopback port. Never reset or reuse
// a node that might belong to the app, the user, or another test process.
const socket = net.createServer();
await new Promise((resolve, reject) => socket.listen(0, "127.0.0.1", resolve).once("error", reject));
const port = socket.address().port;
await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
const rpcUrl = `http://127.0.0.1:${port}`;
const cli = fileURLToPath(new URL("../node_modules/hardhat/dist/src/cli.js", import.meta.url));
const node = spawn(process.execPath, [cli, "node", "--network", "local", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, HARDHAT_DISABLE_TELEMETRY_PROMPT: "true", DO_NOT_TRACK: "1" },
});
let startupError;
node.on("error", (error) => { startupError = error; });
let log = "";
for (const stream of [node.stdout, node.stderr]) stream.on("data", (data) => { log += data.toString(); });
let child;
const stop = () => { child?.kill(); node.kill(); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (startupError || node.exitCode !== null) throw startupError ?? new Error(`Local EVM exited: ${log.slice(-3000)}`);
    try {
      const result = await fetch(rpcUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        signal: AbortSignal.timeout(500),
      }).then((response) => response.json());
      if (result.result === "0x7a69") { ready = true; break; }
    } catch { /* Wait for this run's child node to bind its port. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`Local EVM startup timed out: ${log.slice(-3000)}`);
  const args = task === "demo" ? ["scripts/demo.mjs", ...process.argv.slice(3)] :
    ["--test", "--test-concurrency=1", ...(task === "arena" ? ["test/arena.test.mjs"] :
      ["test/vaults.test.mjs", "test/integration.test.mjs", "test/arena.test.mjs"])];
  child = spawn(process.execPath, args, {
    cwd: ROOT, windowsHide: true, stdio: "inherit",
    env: { ...process.env, DRAGONBAIT_LOCAL_RPC: rpcUrl },
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
} finally {
  stop();
  await fs.writeFile(path.join(ROOT, ".local", `hardhat-${task}.log`), log);
}
