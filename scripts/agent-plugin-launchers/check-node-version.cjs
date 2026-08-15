"use strict";

function isSupportedNodeVersion(version) {
  const parts = String(version).split(".");
  if (parts.length < 2 || parts.some(part => !/^\d+$/.test(part))) return false;
  const [major, minor] = parts.map(Number);
  return (
    (major === 20 && minor >= 19) ||
    (major === 22 && minor >= 12) ||
    major > 22
  );
}

if (require.main === module) {
  process.exitCode = isSupportedNodeVersion(process.versions.node) ? 0 : 1;
}

module.exports = { isSupportedNodeVersion };
