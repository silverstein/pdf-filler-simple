#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function validateAgentWorkflowEvents(events) {
  const errors = [];
  const allowedTypes = new Set([
    "thread.started",
    "turn.started",
    "item.completed",
    "turn.completed",
  ]);
  const counts = new Map();

  for (const [index, event] of events.entries()) {
    counts.set(event?.type, (counts.get(event?.type) ?? 0) + 1);
    if (!allowedTypes.has(event?.type)) {
      errors.push(`event ${index} has prohibited type ${String(event?.type)}`);
    }
    if (event?.type === "item.completed" && event?.item?.type !== "agent_message") {
      errors.push(
        `event ${index} completed prohibited item type ${String(event?.item?.type)}`,
      );
    }
  }

  for (const type of allowedTypes) {
    if (counts.get(type) !== 1) {
      errors.push(`event stream must contain exactly one ${type}`);
    }
  }

  return {
    pass: errors.length === 0,
    errors,
    event_count: events.length,
    event_type_counts: Object.fromEntries([...counts].sort()),
    model_callable_tool_items: events.filter(
      event => event?.type === "item.completed" && event?.item?.type !== "agent_message",
    ).length,
  };
}

export async function validateAgentWorkflowEventFile(filename) {
  const lines = (await fs.readFile(filename, "utf8"))
    .split(/\r?\n/)
    .filter(line => line.trim());
  const events = [];
  const parseErrors = [];
  for (const [index, line] of lines.entries()) {
    try {
      events.push(JSON.parse(line));
    } catch {
      parseErrors.push(`line ${index + 1} is not valid JSON`);
    }
  }
  const validation = validateAgentWorkflowEvents(events);
  return {
    file: path.resolve(filename),
    ...validation,
    errors: [...parseErrors, ...validation.errors],
    pass: parseErrors.length === 0 && validation.pass,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length < 3) {
    throw new Error("Usage: eval-validate-agent-workflow-events.mjs <events.jsonl> [...]");
  }
  const results = await Promise.all(
    process.argv.slice(2).map(validateAgentWorkflowEventFile),
  );
  const report = {
    schema_version: "pdf-tools.agent-workflow-event-validation.v1",
    pass: results.every(result => result.pass),
    results,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.pass) process.exitCode = 1;
}
