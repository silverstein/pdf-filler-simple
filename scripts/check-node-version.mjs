#!/usr/bin/env node

import { verifyBuildNodeVersion } from "./build-toolchain.mjs";

try {
  verifyBuildNodeVersion();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
