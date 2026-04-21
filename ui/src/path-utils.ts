export function splitHostPath(filePath: string) {
  const lastSeparator = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));

  if (lastSeparator === -1) {
    return { dir: "", base: filePath };
  }

  return {
    dir: filePath.slice(0, lastSeparator),
    base: filePath.slice(lastSeparator + 1),
  };
}

export function getHostBaseName(filePath: string) {
  return splitHostPath(filePath).base || filePath;
}

export function stripPdfExtension(fileName: string) {
  return fileName.replace(/\.pdf$/i, "");
}

export function joinHostPath(dir: string, fileName: string) {
  if (!dir) return fileName;

  const separator = dir.lastIndexOf("\\") > dir.lastIndexOf("/") ? "\\" : "/";
  if (dir.endsWith("/") || dir.endsWith("\\")) {
    return `${dir}${fileName}`;
  }

  return `${dir}${separator}${fileName}`;
}

export function buildManagedPdfPath(pdfPath: string) {
  const { dir, base } = splitHostPath(pdfPath);
  return joinHostPath(dir, `${stripPdfExtension(base)}_managed.pdf`);
}

export function stripSignedPdfSuffix(fileName: string) {
  return fileName.replace(/-signed(?=\.pdf$)/i, "");
}

export function buildSignedWorkingPdfPath(pdfPath: string) {
  const { dir, base } = splitHostPath(pdfPath);
  const canonicalBase = stripSignedPdfSuffix(base);
  return joinHostPath(dir, `${stripPdfExtension(canonicalBase)}-signed.pdf`);
}
