import { runNodeTestSuites } from "../../scripts/run-node-test-suites.mjs";

process.exitCode = await runNodeTestSuites({
  suiteFiles: ["test/fixtures/node-runner-stubborn-fixture.mjs"],
  arguments_: ["--reporter=tap"],
  standardInputOutput: "ignore",
  escalationMs: 200,
});
