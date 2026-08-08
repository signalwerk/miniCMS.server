import test from "node:test";
import assert from "node:assert/strict";
import {
  createProjectGate,
  withProjectGate
} from "../src/project-gate.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test("holds the project gate until route work ends after a disconnect", async () => {
  const gate = createProjectGate();
  const started = deferred();
  const finish = deferred();
  const response = { destroyed: false };
  const route = withProjectGate(gate, "read", async () => {
    started.resolve();
    await finish.promise;
  });

  const routePromise = route(
    { aborted: false },
    response,
    (error) => {
      throw error;
    }
  );
  await started.promise;

  let writerEntered = false;
  const writerPromise = gate.write().then((release) => {
    writerEntered = true;
    release();
  });
  response.destroyed = true;
  await Promise.resolve();
  assert.equal(writerEntered, false);

  finish.resolve();
  await routePromise;
  await writerPromise;
  assert.equal(writerEntered, true);
});

test("skips and releases queued work whose connection has closed", async () => {
  const gate = createProjectGate();
  const releaseWriter = await gate.write();
  const response = { destroyed: false };
  let called = false;
  const route = withProjectGate(gate, "read", async () => {
    called = true;
  });
  const routePromise = route(
    { aborted: false },
    response,
    (error) => {
      throw error;
    }
  );

  response.destroyed = true;
  releaseWriter();
  await routePromise;
  assert.equal(called, false);

  const releaseAfter = await gate.write();
  releaseAfter();
});
