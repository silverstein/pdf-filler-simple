import { afterEach, describe, expect, it, vi } from "vitest";
import { createScopedStderrSuppressor } from "../server/stderr-suppression.js";

function createMockStderr() {
  const writes = [];
  return {
    writes,
    write: vi.fn((chunk, encoding, callback) => {
      writes.push(String(chunk));
      if (typeof encoding === "function") {
        encoding();
      } else if (typeof callback === "function") {
        callback();
      }
      return true;
    }),
  };
}

describe("createScopedStderrSuppressor", () => {
  let suppressor;

  afterEach(() => {
    suppressor?.restore();
    suppressor = undefined;
  });

  it("suppresses writes inside the wrapped async context", async () => {
    const mockStderr = createMockStderr();
    suppressor = createScopedStderrSuppressor(mockStderr);

    await suppressor.run(async () => {
      mockStderr.write("hidden warning\n");
    });

    expect(mockStderr.writes).toEqual([]);
  });

  it("does not suppress unrelated concurrent writes", async () => {
    const mockStderr = createMockStderr();
    suppressor = createScopedStderrSuppressor(mockStderr);

    await Promise.all([
      suppressor.run(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      }),
      (async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        mockStderr.write("unrelated warning\n");
      })(),
    ]);

    expect(mockStderr.writes).toEqual(["unrelated warning\n"]);
  });
});
