import { describe, expect, it } from "vitest";
import {
  validateAgentWorkflowEvents,
} from "../../scripts/eval-validate-agent-workflow-events.mjs";

function validEvents() {
  return [
    { type: "thread.started", thread_id: "synthetic" },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: { type: "agent_message", text: "{\"case_id\":\"synthetic\"}" },
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
});
