// configure_allowed_directories widens a security boundary, so these tests are
// written against the guards rather than the happy path. The property that
// matters most is the last one: writing the file must not change what the
// running session is allowed to touch.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, linkSync, realpathSync, existsSync } from "fs";
import { tmpdir, homedir } from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "index.js");

// Holds one server process open across several calls. The first version of
// this file killed the server after a single call, which made the property that
// matters untestable: you cannot show that configuring did not widen access
// without then asking the SAME process to read something.
function openSession(pluginData, extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH ?? "", PLUGIN_DATA: pluginData, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const waiting = new Map();
  child.stdout.on("data", chunk => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message.id && waiting.has(message.id)) {
          waiting.get(message.id)(message);
          waiting.delete(message.id);
        }
      } catch { /* the server may log non-JSON; ignore */ }
    }
  });

  let nextId = 1;
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 25000);
    waiting.set(id, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

  const ready = (async () => {
    await send("initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  })();

  return {
    async call(name, args) {
      await ready;
      return send("tools/call", { name, arguments: args });
    },
    close() { child.kill("SIGKILL"); },
  };
}

// Single-call convenience for the rejection cases.
async function callTool(pluginData, name, args, extraEnv = {}) {
  const session = openSession(pluginData, extraEnv);
  try {
    return await session.call(name, args);
  } finally {
    session.close();
  }
}

const nowIso = () => new Date().toISOString();

describe("configure_allowed_directories", () => {
  let pluginData;
  let target;

  beforeEach(() => {
    pluginData = mkdtempSync(path.join(tmpdir(), "pdf-plugin-data-"));
    target = mkdtempSync(path.join(tmpdir(), "pdf-target-"));
  });
  afterEach(() => {
    rmSync(pluginData, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  const configPath = () => path.join(pluginData, "config.json");
  const readConfig = () => JSON.parse(readFileSync(configPath(), "utf8"));

  // The property this whole design rests on. Asserting the handler's own
  // `active_directories_unchanged` boolean proves nothing: it is hard-coded
  // true, so it would keep saying true while access widened underneath it. An
  // adversarial review named that as the central weakness of the first version
  // of this test. So configure, then ask the SAME process to read a file in the
  // folder just granted, and require it to still refuse.
  it("does not widen the running session: a real read still refuses after configuring", async () => {
    const pdf = path.join(target, "probe.pdf");
    writeFileSync(pdf, "%PDF-1.4\n%%EOF\n");
    const session = openSession(pluginData);
    try {
      const before = await session.call("list_pdfs", { directory: target });
      expect(JSON.stringify(before)).toMatch(/allowed|not permitted|access/i);

      const configured = await session.call("configure_allowed_directories", {
        directories: [target],
        user_intent_statement: `Please allow ${target} so you can read my files there.`,
        user_confirmed_at: nowIso(),
      });
      expect(configured.error).toBeUndefined();
      expect(configured.result.structuredContent.restart_required).toBe(true);
      expect(readConfig().allowedDirectories).toContain(target);

      // The file is on disk and readable; only the boundary should stop this.
      const after = await session.call("list_pdfs", { directory: target });
      expect(JSON.stringify(after)).toMatch(/allowed|not permitted|access/i);
      expect(JSON.stringify(after)).not.toContain("probe.pdf");
    } finally {
      session.close();
    }
  });

  it("stores the resolved target so retargeting the symlink later cannot widen it", async () => {
    const benign = path.join(target, "benign");
    const forbidden = path.join(target, "forbidden");
    mkdirSync(benign); mkdirSync(forbidden);
    const link = path.join(target, "link");
    symlinkSync(benign, link);

    const result = await callTool(pluginData, "configure_allowed_directories", {
      directories: [link],
      user_intent_statement: `Please allow ${link} for me.`,
      user_confirmed_at: nowIso(),
    });
    expect(result.error).toBeUndefined();

    // Repointing the name must not move the grant.
    rmSync(link); symlinkSync(forbidden, link);
    const stored = readConfig().allowedDirectories.map(entry => realpathSync(entry));
    expect(stored).toContain(realpathSync(benign));
    expect(stored).not.toContain(realpathSync(forbidden));
  });

  it("refuses a parent of the folder the user named", async () => {
    const child = path.join(target, "taxes", "2025");
    mkdirSync(child, { recursive: true });
    const result = await callTool(pluginData, "configure_allowed_directories", {
      directories: [target],
      user_intent_statement: `Please allow ${child} so you can read my return.`,
      user_confirmed_at: nowIso(),
    });
    expect(JSON.stringify(result)).toMatch(/must name each folder/i);
    expect(existsSync(configPath()) ? readConfig().allowedDirectories : []).not.toContain(target);
  });

  it("refuses shallow system directories, not just root and home", async () => {
    for (const directory of ["/etc", "/var", "/usr"]) {
      const result = await callTool(pluginData, "configure_allowed_directories", {
        directories: [directory],
        user_intent_statement: `Please allow ${directory} for me.`,
        user_confirmed_at: nowIso(),
      });
      expect(JSON.stringify(result)).toMatch(/too broad|system or multi-user|filesystem root/i);
    }
  });

  it("refuses a folder holding a second hard link to its own config file", async () => {
    const result0 = await callTool(pluginData, "configure_allowed_directories", {
      directories: [target],
      user_intent_statement: `Please allow ${target} for me.`,
      user_confirmed_at: nowIso(),
    });
    expect(result0.error).toBeUndefined();
    linkSync(configPath(), path.join(target, "alias.json"));
    const result = await callTool(pluginData, "configure_allowed_directories", {
      directories: [target],
      user_intent_statement: `Please allow ${target} again for me.`,
      user_confirmed_at: nowIso(),
    });
    expect(JSON.stringify(result)).toMatch(/another name for this server's own configuration/i);
  });

  it("rejects a non-ISO timestamp that Date.parse would otherwise accept", async () => {
    const result = await callTool(pluginData, "configure_allowed_directories", {
      directories: [target],
      user_intent_statement: `Please allow ${target} for me.`,
      user_confirmed_at: "August 9, 2026 16:20 UTC",
    });
    expect(JSON.stringify(result)).toMatch(/ISO-8601/i);
  });

  it("refuses when the intent statement does not name the folder", async () => {
    const result = await callTool(pluginData, "configure_allowed_directories", {
      directories: [target],
      user_intent_statement: "Yes, go ahead and allow that folder, that is fine by me.",
      user_confirmed_at: nowIso(),
    });
    expect(JSON.stringify(result)).toMatch(/must name each folder/i);
  });

  it("refuses a confirmation older than a day, and one from the future", async () => {
    const stale = await callTool(pluginData, "configure_allowed_directories", {
      directories: [target],
      user_intent_statement: `Allow ${target} please.`,
      user_confirmed_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    expect(JSON.stringify(stale)).toMatch(/24 hours/i);

    const future = await callTool(pluginData, "configure_allowed_directories", {
      directories: [target],
      user_intent_statement: `Allow ${target} please.`,
      user_confirmed_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    expect(JSON.stringify(future)).toMatch(/future/i);
  });

  it("refuses the home folder and the filesystem root", async () => {
    const home = await callTool(pluginData, "configure_allowed_directories", {
      directories: [homedir()],
      user_intent_statement: `Allow ${homedir()} please.`,
      user_confirmed_at: nowIso(),
    });
    expect(JSON.stringify(home)).toMatch(/home folder/i);

    const root = path.parse(process.cwd()).root;
    const rootResult = await callTool(pluginData, "configure_allowed_directories", {
      directories: [root],
      user_intent_statement: `Allow ${root} please.`,
      user_confirmed_at: nowIso(),
    });
    expect(JSON.stringify(rootResult)).toMatch(/filesystem root/i);
  });

  it("refuses a folder that contains its own configuration file", async () => {
    const result = await callTool(pluginData, "configure_allowed_directories", {
      directories: [pluginData],
      user_intent_statement: `Allow ${pluginData} please.`,
      user_confirmed_at: nowIso(),
    });
    expect(JSON.stringify(result)).toMatch(/own configuration file/i);
  });

  it("refuses a folder that does not exist rather than creating one", async () => {
    const missing = path.join(target, "not-here");
    const result = await callTool(pluginData, "configure_allowed_directories", {
      directories: [missing],
      user_intent_statement: `Allow ${missing} please.`,
      user_confirmed_at: nowIso(),
    });
    expect(JSON.stringify(result)).toMatch(/does not exist/i);
  });

  it("keeps folders the user configured by hand instead of replacing them", async () => {
    const handWritten = mkdtempSync(path.join(tmpdir(), "pdf-hand-"));
    try {
      mkdirSync(pluginData, { recursive: true });
      writeFileSync(configPath(), JSON.stringify({ allowedDirectories: [handWritten] }, null, 2));
      await callTool(pluginData, "configure_allowed_directories", {
        directories: [target],
        user_intent_statement: `Also allow ${target} please.`,
        user_confirmed_at: nowIso(),
      });
      const stored = readConfig().allowedDirectories;
      expect(stored).toContain(handWritten);
      expect(stored).toContain(target);
    } finally {
      rmSync(handWritten, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite a configuration file it cannot parse", async () => {
    mkdirSync(pluginData, { recursive: true });
    writeFileSync(configPath(), "{ this is not json");
    const result = await callTool(pluginData, "configure_allowed_directories", {
      directories: [target],
      user_intent_statement: `Allow ${target} please.`,
      user_confirmed_at: nowIso(),
    });
    expect(JSON.stringify(result)).toMatch(/not valid JSON/i);
    expect(readFileSync(configPath(), "utf8")).toBe("{ this is not json");
  });

  it("appends consent history rather than overwriting it", async () => {
    const second = mkdtempSync(path.join(tmpdir(), "pdf-second-"));
    try {
      const first = `I want you to be able to read ${target}, please allow it.`;
      await callTool(pluginData, "configure_allowed_directories", {
        directories: [target], user_intent_statement: first, user_confirmed_at: nowIso(),
      });
      await callTool(pluginData, "configure_allowed_directories", {
        directories: [second],
        user_intent_statement: `Also allow ${second} please.`,
        user_confirmed_at: nowIso(),
      });
      const history = readConfig()._configurationHistory;
      expect(history).toHaveLength(2);
      // The consent that granted the first folder must survive the second call.
      expect(history[0].user_intent_statement).toBe(first);
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("records nothing when a call adds nothing", async () => {
    const statement = `Please allow ${target} for me.`;
    await callTool(pluginData, "configure_allowed_directories", {
      directories: [target], user_intent_statement: statement, user_confirmed_at: nowIso(),
    });
    await callTool(pluginData, "configure_allowed_directories", {
      directories: [target],
      user_intent_statement: `Something bland about ${target}.`,
      user_confirmed_at: nowIso(),
    });
    const history = readConfig()._configurationHistory;
    expect(history).toHaveLength(1);
    expect(history[0].user_intent_statement).toBe(statement);
  });

  it("refuses entirely where the host owns the settings, writing nothing", async () => {
    const result = await callTool("", "configure_allowed_directories", {
      directories: [target],
      user_intent_statement: `Allow ${target} please.`,
      user_confirmed_at: nowIso(),
    }, { ALLOWED_DIRECTORIES: target });
    expect(JSON.stringify(result)).toMatch(/no stored configuration file/i);
  });
});
