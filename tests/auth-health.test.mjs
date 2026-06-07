import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { test } from "node:test";

test("health check stays public while protected APIs still require login", async () => {
  const port = await getFreePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      OPENAI_API_KEY: "test-key-for-health-check",
      PORT: String(port),
      YUANYE_HOST: "127.0.0.1",
      YUANYE_PASSWORD: "deploy-test-password",
      YUANYE_SESSION_SECRET: "deploy-test-session-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer(child);

    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    const payload = await health.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.auth, true);
    assert.equal(payload.version, "0.7.54-test");

    const protectedResponse = await fetch(`http://127.0.0.1:${port}/api/history`, {
      headers: { Accept: "application/json" },
    });
    assert.equal(protectedResponse.status, 401);
  } finally {
    child.kill();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
  }
});

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`server did not start in time: ${output}`));
    }, 5000);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("Seamless Studio running")) {
        clearTimeout(timer);
        resolve();
      }
    });

    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited before ready with code ${code}: ${output}`));
    });
  });
}
