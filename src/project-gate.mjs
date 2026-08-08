export function createProjectGate() {
  const queue = [];
  let readers = 0;
  let writer = false;

  function drain() {
    if (writer || !queue.length) return;
    if (queue[0].mode === "write") {
      if (readers) return;
      writer = true;
      const entry = queue.shift();
      entry.resolve(releaseWriter);
      return;
    }
    while (queue[0]?.mode === "read" && !writer) {
      readers += 1;
      const entry = queue.shift();
      entry.resolve(releaseReader);
    }
  }

  function releaseReader() {
    readers -= 1;
    drain();
  }

  function releaseWriter() {
    writer = false;
    drain();
  }

  function acquire(mode) {
    return new Promise((resolve) => {
      queue.push({ mode, resolve });
      drain();
    });
  }

  return Object.freeze({
    read: () => acquire("read"),
    write: () => acquire("write")
  });
}

export function withProjectGate(gate, mode, handler) {
  if (!["read", "write"].includes(mode) || typeof handler !== "function") {
    throw new TypeError("withProjectGate requires a gate mode and handler.");
  }
  return async (request, response, next) => {
    let release;
    try {
      release = await gate[mode]();
      if (request.aborted || response.destroyed) return;
      await handler(request, response, next);
    } catch (error) {
      next(error);
    } finally {
      release?.();
    }
  };
}
