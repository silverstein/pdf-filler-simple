import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface PdfToolLoadData {
  pdfPath: string;
  activePath?: string;
  backupPath?: string | null;
  totalBytes: number;
  initialPage: number;
  fields: unknown[];
  fieldCount: number;
  hasFormFields: boolean;
  viewUUID?: string;
  key: string;
}

export function getPdfToolLoadData(result: CallToolResult | null | undefined): PdfToolLoadData | null {
  const structured = result?.structuredContent as any;
  const meta = result?._meta as any;
  const data = (structured?.pdfPath && structured?.totalBytes)
    ? structured
    : (meta?.pdfPath && meta?.totalBytes)
      ? meta
      : null;

  if (!data) return null;

  const fields = (Array.isArray(data.fields) && data.fields.length > 0) ? data.fields
    : (Array.isArray(meta?.fields) && meta.fields.length > 0) ? meta.fields
      : (Array.isArray(structured?.fields) && structured.fields.length > 0) ? structured.fields
        : [];

  const initialPage = data.initialPage || 1;
  const viewUUID = meta?.viewUUID ? String(meta.viewUUID) : undefined;

  return {
    pdfPath: data.pdfPath,
    activePath: data.active_path ?? structured?.active_path ?? meta?.active_path,
    backupPath: data.backup_path ?? structured?.backup_path ?? meta?.backup_path ?? null,
    totalBytes: data.totalBytes,
    initialPage,
    fields,
    fieldCount: data.fieldCount ?? meta?.fieldCount ?? structured?.fieldCount ?? 0,
    hasFormFields: Boolean(data.hasFormFields ?? meta?.hasFormFields ?? structured?.hasFormFields),
    viewUUID,
    key: `${data.pdfPath}:${data.totalBytes}:${initialPage}:${viewUUID || ""}`,
  };
}
