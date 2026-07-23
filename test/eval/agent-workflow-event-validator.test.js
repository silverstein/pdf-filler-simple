import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  validateAgentWorkflowEventFile,
  validateAgentWorkflowEvents,
} from "../../scripts/eval-validate-agent-workflow-events.mjs";

function validEvents() {
  return [
    { type: "thread.started", thread_id: "synthetic" },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: {
        id: "item_1",
        type: "agent_message",
        text: "{\"case_id\":\"synthetic\"}",
      },
    },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
  ];
}

describe("agent workflow event validation", () => {
  it("accepts exactly one tool-free planning turn", () => {
    expect(validateAgentWorkflowEvents(validEvents())).toMatchObject({
      pass: true,
      event_count: 4,
      model_callable_tool_items: 0,
      thread_id: "synthetic",
      agent_message_item_id: "item_1",
      input_tokens: 1,
      output_tokens: 1,
    });
  });

  it("rejects command, tool, unknown, duplicate, and missing events", () => {
    const withCommand = validEvents();
    withCommand.splice(2, 0, {
      type: "item.completed",
      item: { type: "command_execution", command: "sed -n 1,20p SKILL.md" },
    });
    expect(validateAgentWorkflowEvents(withCommand)).toMatchObject({
      pass: false,
      model_callable_tool_items: 1,
    });

    expect(validateAgentWorkflowEvents([
      { type: "thread.started" },
      { type: "turn.started" },
      { type: "unexpected" },
    ])).toMatchObject({ pass: false });
  });

  it("rejects shuffled lifecycle events and incomplete required fields", () => {
    const shuffled = validEvents();
    [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
    expect(validateAgentWorkflowEvents(shuffled)).toMatchObject({ pass: false });

    const missingMessageId = validEvents();
    delete missingMessageId[2].item.id;
    expect(validateAgentWorkflowEvents(missingMessageId)).toMatchObject({ pass: false });

    const missingMessageText = validEvents();
    missingMessageText[2].item.text = "";
    expect(validateAgentWorkflowEvents(missingMessageText)).toMatchObject({ pass: false });

    const missingUsage = validEvents();
    delete missingUsage[3].usage;
    expect(validateAgentWorkflowEvents(missingUsage)).toMatchObject({ pass: false });
  });

  it("binds validation to the raw event file and rejects malformed JSONL", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-workflow-events-"));
    try {
      const filename = path.join(root, "events.jsonl");
      const raw = `${validEvents().map(event => JSON.stringify(event)).join("\n")}\n`;
      await fs.writeFile(filename, raw);
      expect(await validateAgentWorkflowEventFile(filename)).toMatchObject({
        pass: true,
        raw_bytes: Buffer.byteLength(raw),
        raw_sha256: createHash("sha256").update(raw).digest("hex"),
      });

      const malformed = `${raw}{not-json}\n`;
      await fs.writeFile(filename, malformed);
      expect(await validateAgentWorkflowEventFile(filename)).toMatchObject({
        pass: false,
        raw_bytes: Buffer.byteLength(malformed),
        raw_sha256: createHash("sha256").update(malformed).digest("hex"),
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
