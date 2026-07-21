import path from "path";

const PDF_RESOURCE_AUTHORITY = "local";
const UNAVAILABLE_RESOURCE_ERROR_CODES = new Set([
  "EACCES",
  "EISDIR",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
]);

function isAbsoluteFilesystemPath(candidate) {
  return path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate);
}

/**
 * Encode a resolved local path as one unambiguous RFC 3986 path segment.
 *
 * A fixed authority keeps POSIX leading slashes, Windows drive letters, UNC
 * paths, and reserved characters out of the URI's structural components. The
 * original platform path can therefore be recovered exactly before the normal
 * filesystem allowlist is applied.
 */
export function pathToPdfResourceUri(absolutePath) {
  if (typeof absolutePath !== "string" || !isAbsoluteFilesystemPath(absolutePath)) {
    throw new TypeError("PDF resource paths must be absolute filesystem paths");
  }
  if (absolutePath.includes("\0")) {
    throw new TypeError("PDF resource paths cannot contain NUL characters");
  }
  return `pdf://${PDF_RESOURCE_AUTHORITY}/${encodeURIComponent(absolutePath)}`;
}

/**
 * Decode only canonical PDF Tools resource URIs. Callers must still resolve
 * the resulting path through the server's filesystem allowlist.
 */
export function pdfResourceUriToPath(uri) {
  if (typeof uri !== "string") {
    throw new TypeError("PDF resource URI must be a string");
  }

  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new TypeError("PDF resource URI is not a valid URI");
  }

  if (
    parsed.protocol !== "pdf:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hostname !== PDF_RESOURCE_AUTHORITY ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError("PDF resource URI must use the canonical pdf://local/ form");
  }

  const encodedPath = parsed.pathname.slice(1);
  if (!encodedPath || encodedPath.includes("/")) {
    throw new TypeError("PDF resource URI must contain one encoded path segment");
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    throw new TypeError("PDF resource URI contains invalid percent encoding");
  }

  if (!isAbsoluteFilesystemPath(decodedPath) || decodedPath.includes("\0")) {
    throw new TypeError("PDF resource URI does not contain an absolute filesystem path");
  }
  return decodedPath;
}

export function isUnavailableResourceError(error) {
  return UNAVAILABLE_RESOURCE_ERROR_CODES.has(error?.code);
}
