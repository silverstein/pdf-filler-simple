import { AsyncLocalStorage } from "node:async_hooks";

function acknowledgeSuppressedWrite(encoding, callback) {
  if (typeof encoding === "function") {
    encoding();
  } else if (typeof callback === "function") {
    callback();
  }
}

export function createScopedStderrSuppressor(stderrStream = process.stderr) {
  const suppressionStore = new AsyncLocalStorage();
  const originalWrite = stderrStream.write.bind(stderrStream);

  stderrStream.write = function patchedWrite(chunk, encoding, callback) {
    if (suppressionStore.getStore()) {
      acknowledgeSuppressedWrite(encoding, callback);
      return true;
    }

    return originalWrite(chunk, encoding, callback);
  };

  return {
    async run(action) {
      return await suppressionStore.run(true, action);
    },
    restore() {
      stderrStream.write = originalWrite;
    }
  };
}
