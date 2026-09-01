import { describe, expect, it } from "vitest";
import { openVerifiedRegularFile, portableFilesystemDevice } from "../server/helpers.js";

// openVerifiedRegularFile defends a TOCTOU race that a real-filesystem test
// cannot force reliably: the swap has to happen in the window between the lstat
// and the open. Injecting fsOps makes that window explicit, so the device/inode
// identity check and the O_NOFOLLOW-descriptor check are exercised rather than
// merely present. The path-handler suite covers the integrated behaviour; this
// covers the guard itself.

function regularFileStat({ dev, ino, size = 1024 }) {
  return {
    dev,
    ino,
    size,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

function fakeHandle(descriptorStat) {
  return {
    stat: async () => descriptorStat,
    close: async () => {},
  };
}

describe("openVerifiedRegularFile identity guard", () => {
  it("normalizes the unavailable Windows pathname device without weakening POSIX", () => {
    expect(portableFilesystemDevice({ dev: 0 }, "win32")).toBe("win32-unavailable");
    expect(portableFilesystemDevice({ dev: 2660852064 }, "win32"))
      .toBe("win32-unavailable");
    expect(portableFilesystemDevice({ dev: 41 }, "linux")).toBe("41");
  });
  it("rejects a file whose inode changed between lstat and open", async () => {
    // The name was inspected as inode 100 and opened as inode 200 — a
    // replacement that reused the path in the race window.
    const fsOps = {
      lstat: async () => regularFileStat({ dev: 1, ino: 100 }),
      open: async () => fakeHandle(regularFileStat({ dev: 1, ino: 200 })),
    };

    await expect(openVerifiedRegularFile(fsOps, "/allowed/doc.pdf"))
      .rejects.toThrow(/changed while it was being opened/);
  });

  it("rejects a file whose device changed between lstat and open", async () => {
    const fsOps = {
      lstat: async () => regularFileStat({ dev: 1, ino: 100 }),
      open: async () => fakeHandle(regularFileStat({ dev: 9, ino: 100 })),
    };

    await expect(openVerifiedRegularFile(fsOps, "/allowed/doc.pdf"))
      .rejects.toThrow(/changed while it was being opened/);
  });

  it("accepts only the Windows pathname-device-zero compatibility shape", async () => {
    const descriptorStat = regularFileStat({ dev: 2660852064, ino: 100 });
    const fsOps = {
      lstat: async () => regularFileStat({ dev: 0, ino: 100 }),
      open: async () => fakeHandle(descriptorStat),
    };

    await expect(openVerifiedRegularFile(
      fsOps,
      "C:\\allowed\\doc.pdf",
      { platform: "win32" },
    )).resolves.toMatchObject({ stat: descriptorStat });
    await expect(openVerifiedRegularFile(
      fsOps,
      "/allowed/doc.pdf",
      { platform: "linux" },
    )).rejects.toThrow(/changed while it was being opened/);
  });

  it("still rejects different nonzero Windows volumes", async () => {
    const fsOps = {
      lstat: async () => regularFileStat({ dev: 1, ino: 100 }),
      open: async () => fakeHandle(regularFileStat({ dev: 9, ino: 100 })),
    };

    await expect(openVerifiedRegularFile(
      fsOps,
      "C:\\allowed\\doc.pdf",
      { platform: "win32" },
    )).rejects.toThrow(/changed while it was being opened/);
  });

  it("closes the descriptor when the identity check fails", async () => {
    let closed = false;
    const fsOps = {
      lstat: async () => regularFileStat({ dev: 1, ino: 100 }),
      open: async () => ({
        stat: async () => regularFileStat({ dev: 1, ino: 200 }),
        close: async () => { closed = true; },
      }),
    };

    await expect(openVerifiedRegularFile(fsOps, "/allowed/doc.pdf")).rejects.toThrow();
    // A leaked descriptor on the rejection path is its own bug.
    expect(closed).toBe(true);
  });

  it("rejects a symlink at the final component before opening", async () => {
    let opened = false;
    const fsOps = {
      lstat: async () => ({
        isFile: () => false,
        isSymbolicLink: () => true,
      }),
      open: async () => { opened = true; return fakeHandle(regularFileStat({ dev: 1, ino: 1 })); },
    };

    await expect(openVerifiedRegularFile(fsOps, "/allowed/link.pdf"))
      .rejects.toThrow(/Not a regular file/);
    // The guard must refuse before it opens, not after.
    expect(opened).toBe(false);
  });

  it("rejects a descriptor that is no longer a regular file", async () => {
    // lstat saw a regular file; the descriptor reports otherwise.
    const fsOps = {
      lstat: async () => regularFileStat({ dev: 1, ino: 100 }),
      open: async () => fakeHandle({
        dev: 1,
        ino: 100,
        isFile: () => false,
      }),
    };

    await expect(openVerifiedRegularFile(fsOps, "/allowed/doc.pdf"))
      .rejects.toThrow(/changed while it was being opened/);
  });

  it("returns the handle and descriptor stat when identity holds", async () => {
    const descriptorStat = regularFileStat({ dev: 1, ino: 100, size: 4096 });
    const handle = fakeHandle(descriptorStat);
    const fsOps = {
      lstat: async () => regularFileStat({ dev: 1, ino: 100 }),
      open: async () => handle,
    };

    const result = await openVerifiedRegularFile(fsOps, "/allowed/doc.pdf");
    expect(result.handle).toBe(handle);
    expect(result.stat.size).toBe(4096);
  });
});
