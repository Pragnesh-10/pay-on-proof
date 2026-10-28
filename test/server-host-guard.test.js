"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");

test("server refuses non-loopback binding while auth is not implemented", { timeout: 5000 }, async (t) => {
  const child = spawn(process.execPath, [require.resolve("../server.js")], {
    env: {
      ...process.env,
      HOST: "0.0.0.0",
      PORT: "0",
      PAYPAL_CLIENT_ID: "test-client",
      PAYPAL_CLIENT_SECRET: "test-secret",
      PAYPAL_BASE_URL: "http://127.0.0.1:1",
      PAYONPROOF_STATE_FILE: "/tmp/pay-on-proof-host-guard-test-state.json",
      PAYONPROOF_TEMP_FILE: "/tmp/pay-on-proof-host-guard-test-temp.json",
      GROQ_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });

  const result = await Promise.race([
    new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 2000)),
  ]);

  if (result.timeout) {
    child.kill("SIGTERM");
  }
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  });

  assert.equal(result.timeout, undefined, "server unexpectedly continued running on a non-loopback interface");
  assert.notEqual(result.code, 0, "server should reject a non-loopback host");
  assert.match(output, /may bind only to loopback/i);
});
