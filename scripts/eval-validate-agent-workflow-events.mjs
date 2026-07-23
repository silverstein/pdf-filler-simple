#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_EVENT_TYPES = [
  "thread.started",
  "turn.started",
  "item.completed",
  "turn.completed",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateAgentWorkflowEvents(events) {
  const errors = [];
  const allowedTypes = new Set(EXPECTED_EVENT_TYPES);
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

  if (events.length !== EXPECTED_EVENT_TYPES.length) {
    errors.push(`event stream must contain exactly ${EXPECTED_EVENT_TYPES.length} events`);
  }
  for (const [index, type] of EXPECTED_EVENT_TYPES.entries()) {
    if (counts.get(type) !== 1) {
      errors.push(`event stream must contain exactly one ${type}`);
    }
    if (events[index]?.type !== type) {
      errors.push(`event ${index} must be ${type}`);
    }
  }

  if (!nonemptyString(events[0]?.thread_id)) {
    errors.push("thread.started must contain a non-empty thread_id");
  }
  if (!nonemptyString(events[2]?.item?.id)) {
    errors.push("agent_message must contain a non-empty item.id");
  }
  if (!nonemptyString(events[2]?.item?.text)) {
    errors.push("agent_message must contain non-empty text");
  }
  for (const tokenField of ["input_tokens", "output_tokens"]) {
    if (!Number.isFinite(events[3]?.usage?.[tokenField])) {
      errors.push(`turn.completed usage.${tokenField} must be a finite number`);
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
  const raw = await fs.readFile(filename);
  const lines = raw.toString("utf8")
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
    raw_bytes: raw.length,
    raw_sha256: sha256(raw),
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
