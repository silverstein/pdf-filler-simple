// Shared helpers for PDF Tools — extracted for testability

import fs from "fs/promises";
import path from "path";
import { homedir } from "os";
import { PDFDocument, StandardFonts, rgb, degrees as pdfDegrees } from "pdf-lib";

// Validate a signature name to prevent path traversal or weird filenames.
// Mirrors validateProfileName's contract.
export function validateSignatureName(name) {
  if (!name || typeof name !== "string") throw new Error("Signature name is required.");
  if (!/^[\w\-. ]+$/.test(name)) {
    throw new Error("Signature name may only contain letters, numbers, hyphens, underscores, spaces, and dots.");
  }
  return name.trim();
}

// Parse a data URL ("data:image/png;base64,...") into { mime, bytes }.
export function parseImageDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") {
    throw new Error("image_data_url must be a string.");
  }
  const match = dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) {
    throw new Error("image_data_url must be a base64 data URL (e.g. 'data:image/png;base64,...').");
  }
  const mime = match[1].toLowerCase();
  if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/jpg") {
    throw new Error(`Unsupported image type: ${mime}. Use image/png or image/jpeg.`);
  }
  const bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (bytes.length === 0) throw new Error("image_data_url is empty.");
  return { mime, bytes };
}

// Validate a user-supplied signing intent + confirmation timestamp.
// Returns the parsed confirmation Date on success. Throws on anything suspicious.
// The purpose is to make the agent-vs-human distinction visible in logs and metadata,
// not to be cryptographically unforgeable — that's Tier 2 (Lumin's job).
export function validateSigningIntent({ user_intent_statement, user_confirmed_at }, { now = Date.now() } = {}) {
  if (!user_intent_statement || typeof user_intent_statement !== "string") {
    throw new Error(
      "apply_signature requires 'user_intent_statement' — a short sentence " +
      "from the USER describing what they are signing (e.g. \"I, Mat Silverstein, sign this W-9 on 2026-04-16\"). " +
      "Agents must elicit this from the user before calling this tool; do not invent one."
    );
  }
  const statement = user_intent_statement.trim();
  if (statement.length < 8) {
    throw new Error("user_intent_statement is too short. Capture the user's actual statement of intent.");
  }
  if (statement.length > 500) {
    throw new Error("user_intent_statement is too long (>500 chars). Use a single sentence.");
  }

  if (!user_confirmed_at || typeof user_confirmed_at !== "string") {
    throw new Error(
      "apply_signature requires 'user_confirmed_at' — an ISO-8601 timestamp of when " +
      "the user confirmed signing. Agents must obtain this from the user, not fabricate it."
    );
  }
  const confirmedAt = new Date(user_confirmed_at);
  if (Number.isNaN(confirmedAt.getTime())) {
    throw new Error(`user_confirmed_at is not a valid ISO-8601 timestamp: "${user_confirmed_at}".`);
  }
  const driftMs = now - confirmedAt.getTime();
  if (driftMs < -5 * 60 * 1000) {
    throw new Error(`user_confirmed_at is more than 5 minutes in the future. Check the timestamp.`);
  }
  if (driftMs > 24 * 60 * 60 * 1000) {
    throw new Error(
      `user_confirmed_at is more than 24 hours old (${(driftMs / 3600000).toFixed(1)}h). ` +
      `Re-confirm with the user before signing.`
    );
  }
  return { statement, confirmedAt };
}

// Stamp a saved signature onto a PDF page at the given top-left coordinates.
// Coordinates are in PDF user-space points (72pt = 1 inch), using TOP-LEFT origin:
//   x: distance from left edge
//   y: distance from TOP edge (we convert to pdf-lib's bottom-left internally)
// Mutates pdfDoc in place.
export async function stampSignatureOnPage(pdfDoc, signature, {
  page,          // 1-indexed page number
  x, y,          // top-left origin, points
  width, height, // box dimensions, points
  drawAuditLine = false,
  auditText = "",
}) {
  const pages = pdfDoc.getPages();
  if (page < 1 || page > pages.length) {
    throw new Error(`Page ${page} is out of range (1-${pages.length}).`);
  }
  const pdfPage = pages[page - 1];
  const { width: pageW, height: pageH } = pdfPage.getSize();

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error("x, y, width, height must all be finite numbers.");
  }
  if (width <= 0 || height <= 0) {
    throw new Error(`width and height must be positive (got ${width} x ${height}).`);
  }
  if (x < 0 || y < 0 || x + width > pageW || y + height > pageH) {
    throw new Error(
      `Signature box (${x}, ${y}, ${width}x${height}) falls outside page bounds ` +
      `(page ${page} is ${pageW.toFixed(0)}x${pageH.toFixed(0)} pts). ` +
      `Use top-left origin coordinates in points.`
    );
  }

  // Convert top-left y to pdf-lib's bottom-left y
  const pdfY = pageH - y - height;

  if (signature.style === "image") {
    const imageBytes = Buffer.from(signature.image_data_b64, "base64");
    const image = signature.image_mime === "image/jpeg" || signature.image_mime === "image/jpg"
      ? await pdfDoc.embedJpg(imageBytes)
      : await pdfDoc.embedPng(imageBytes);
    // Preserve aspect ratio within the box (contain)
    const imgAspect = image.width / image.height;
    const boxAspect = width / height;
    let drawW, drawH, drawX, drawY;
    if (imgAspect > boxAspect) {
      drawW = width;
      drawH = width / imgAspect;
      drawX = x;
      drawY = pdfY + (height - drawH) / 2;
    } else {
      drawH = height;
      drawW = height * imgAspect;
      drawX = x + (width - drawW) / 2;
      drawY = pdfY;
    }
    pdfPage.drawImage(image, { x: drawX, y: drawY, width: drawW, height: drawH });
  } else if (signature.style === "typed") {
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
    const text = signature.display_name;
    // Fit text to box: find largest font size where text width fits 90% of box width
    let fontSize = height * 0.7;
    const maxWidth = width * 0.95;
    let textWidth = font.widthOfTextAtSize(text, fontSize);
    if (textWidth > maxWidth) {
      fontSize = fontSize * (maxWidth / textWidth);
      textWidth = font.widthOfTextAtSize(text, fontSize);
    }
    // Center text vertically in the box
    const textHeight = font.heightAtSize(fontSize);
    const textX = x + (width - textWidth) / 2;
    const textY = pdfY + (height - textHeight) / 2 + font.heightAtSize(fontSize) * 0.2;
    pdfPage.drawText(text, {
      x: textX,
      y: textY,
      size: fontSize,
      font,
      color: rgb(0.05, 0.05, 0.25), // dark navy
    });
  } else {
    throw new Error(`Unknown signature style: "${signature.style}". Must be 'typed' or 'image'.`);
  }

  // Optional: draw a small visible audit line below the signature
  if (drawAuditLine && auditText) {
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const auditSize = 6;
    const lineY = pdfY - 2 - auditSize;
    if (lineY > 2) {
      pdfPage.drawText(auditText, {
        x,
        y: lineY,
        size: auditSize,
        font,
        color: rgb(0.4, 0.4, 0.4),
      });
    }
  }
}

// Stamp a plain text string on a page — used for date zones and any other
// "just put these characters here" operation that isn't a signature.
// Same top-left coordinate convention as stampSignatureOnPage.
// No signature asset needed; no intent check required (text is not a signature).
export async function stampTextOnPage(pdfDoc, {
  page,
  x, y, width, height,
  text,
  fontStyle = "normal", // "normal" | "italic"
  color = { r: 0.05, g: 0.05, b: 0.15 },
}) {
  const pages = pdfDoc.getPages();
  if (page < 1 || page > pages.length) {
    throw new Error(`Page ${page} is out of range (1-${pages.length}).`);
  }
  const pdfPage = pages[page - 1];
  const { width: pageW, height: pageH } = pdfPage.getSize();

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error("x, y, width, height must all be finite numbers.");
  }
  if (width <= 0 || height <= 0) {
    throw new Error(`width and height must be positive (got ${width} x ${height}).`);
  }
  if (x < 0 || y < 0 || x + width > pageW || y + height > pageH) {
    throw new Error(
      `Text box (${x}, ${y}, ${width}x${height}) falls outside page bounds ` +
      `(page ${page} is ${pageW.toFixed(0)}x${pageH.toFixed(0)} pts).`
    );
  }
  const safeText = String(text ?? "");
  if (!safeText || safeText.length > 200) {
    throw new Error(`text must be a non-empty string no longer than 200 chars (got ${safeText.length}).`);
  }

  const pdfY = pageH - y - height;
  const font = await pdfDoc.embedFont(
    fontStyle === "italic" ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica
  );

  // Fit text to box: find largest font size whose width fits 95% of box width,
  // capped by 80% of box height so ascenders/descenders aren't clipped.
  let fontSize = Math.min(height * 0.7, 18);
  const maxWidth = width * 0.95;
  const measured = font.widthOfTextAtSize(safeText, fontSize);
  if (measured > maxWidth) {
    fontSize = Math.max(6, fontSize * (maxWidth / measured));
  }
  const textWidth = font.widthOfTextAtSize(safeText, fontSize);
  const textX = x + (width - textWidth) / 2;
  const textY = pdfY + (height - font.heightAtSize(fontSize)) / 2 + fontSize * 0.15;

  pdfPage.drawText(safeText, {
    x: textX,
    y: textY,
    size: fontSize,
    font,
    color: rgb(color.r, color.g, color.b),
  });
}

// Draw a visible "sign here" placeholder box on a page.
// Same top-left coordinate convention as stampSignatureOnPage.
export async function drawSignatureFieldOnPage(pdfDoc, {
  page,
  x, y, width, height,
  label = "Sign here",
}) {
  const pages = pdfDoc.getPages();
  if (page < 1 || page > pages.length) {
    throw new Error(`Page ${page} is out of range (1-${pages.length}).`);
  }
  const pdfPage = pages[page - 1];
  const { width: pageW, height: pageH } = pdfPage.getSize();
  if (x < 0 || y < 0 || x + width > pageW || y + height > pageH) {
    throw new Error(
      `Signature field (${x}, ${y}, ${width}x${height}) falls outside page bounds ` +
      `(page ${page} is ${pageW.toFixed(0)}x${pageH.toFixed(0)} pts).`
    );
  }
  const pdfY = pageH - y - height;

  // Light gray dashed rectangle outline
  pdfPage.drawRectangle({
    x, y: pdfY, width, height,
    borderColor: rgb(0.55, 0.55, 0.6),
    borderWidth: 0.75,
    borderOpacity: 0.9,
    color: rgb(0.97, 0.97, 0.99),
    opacity: 0.6,
  });

  // Label centered in the box
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const text = String(label || "Sign here");
  const labelSize = Math.min(height * 0.35, 10);
  const textWidth = font.widthOfTextAtSize(text, labelSize);
  pdfPage.drawText(text, {
    x: x + (width - textWidth) / 2,
    y: pdfY + height / 2 - labelSize * 0.35,
    size: labelSize,
    font,
    color: rgb(0.45, 0.45, 0.5),
  });
}

// Detect whether a PDF already has one or more cryptographic signature fields.
// If we modify such a PDF, pdf-lib's save() invalidates the existing signature —
// so every mutating tool should refuse (or require opt-in) when this returns true.
// Returns { present, fieldNames }.
export function detectExistingSignatures(pdfDoc) {
  try {
    const form = pdfDoc.getForm();
    const fields = form.getFields();
    const sigFields = fields.filter(f => {
      const typeName = f.constructor.name || "";
      return typeName.includes("Signature");
    });
    return {
      present: sigFields.length > 0,
      fieldNames: sigFields.map(f => {
        try { return f.getName(); } catch { return "(unnamed)"; }
      }),
    };
  } catch {
    // No form or error reading — treat as no signatures (don't block the tool).
    return { present: false, fieldNames: [] };
  }
}

// Heuristic: does this PDF use XFA forms?
// pdf-lib strips XFA data on save(), which silently guts government/IRS forms.
// We scan the raw bytes for the /XFA dict entry — fast and effective.
// Not 100% foolproof (won't catch heavily-obfuscated PDFs) but catches all
// real-world XFA forms we've tested.
export function detectXfaForm(pdfBytes) {
  if (!pdfBytes || pdfBytes.length < 10) return false;
  // Scan first 200KB — XFA refs are always in the catalog/AcroForm, near the
  // top of the file. Whole-file scan would be unnecessarily expensive.
  const searchLimit = Math.min(pdfBytes.length, 200 * 1024);
  const sample = pdfBytes.subarray(0, searchLimit).toString("latin1");
  // Match /XFA followed by whitespace, array start, or dict ref
  return /\/XFA[\s\[<\/]/.test(sample);
}

export function assertXfaMutationAllowed(pdfBytes, { forceXfa = false } = {}) {
  if (!forceXfa && detectXfaForm(pdfBytes)) {
    throw new Error(
      "This PDF uses XFA forms, which pdf-lib cannot preserve — saving it would destroy the form data. " +
      "Convert the form to AcroForm first (e.g. via Adobe Acrobat's 'Flatten Form'), or pass force_xfa=true " +
      "if you understand that the XFA layer will be stripped."
    );
  }
}

// ─── Signature zone detection ────────────────────────────────────────────────
// Finds "Sign here", initials, and date zones in a PDF so agents/viewers can
// place signatures at real locations instead of guessing coordinates.

// Compute intersection-over-union for two top-left-origin rectangles.
// Used for dedup and for the golden-set placement eval.
export function computeIoU(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  const intersection = (x2 - x1) * (y2 - y1);
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const union = areaA + areaB - intersection;
  return union > 0 ? intersection / union : 0;
}

// Extract text items from a PDF with top-left origin bounding boxes IN THE
// PAGE'S NATIVE (pre-rotation) COORDINATE SPACE. This matches how pdf-lib
// reads widget rectangles and how our apply_signature tool stamps — all three
// agree on native coords so rotated pages render stamps at the correct spot
// visually. Callers that consume zones in a viewer MUST apply the page's
// rotation when rendering clicks back into zone coords.
// Takes a loaded pdfjs module so helpers.js doesn't need its own init.
// Returns: [{ page, width, height, items: [{ text, x, y, width, height, fontSize }] }]
export async function extractPdfTextWithBounds(pdfjsLib, pdfBytes, { password, maxPages = 500 } = {}) {
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfBytes),
    password: password || undefined,
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  }).promise;

  const out = [];
  try {
    const numPages = Math.min(doc.numPages, maxPages);
    for (let i = 1; i <= numPages; i++) {
      const page = await doc.getPage(i);
      // Force rotation=0 so viewport.width/height are always native — otherwise
      // a /Rotate 90 page returns swapped axes and breaks our y-conversion math.
      const viewport = page.getViewport({ scale: 1, rotation: 0 });
      const pageW = viewport.width;
      const pageH = viewport.height;
      const textContent = await page.getTextContent();
      const items = [];
      for (const it of textContent.items) {
        if (!it || !it.str) continue;
        const str = it.str;
        // Skip pure-whitespace tokens — they don't help pattern matching
        if (!str.trim()) continue;
        const tr = it.transform || [1, 0, 0, 1, 0, 0];
        // transform = [a, b, c, d, e, f]; (e, f) = baseline origin in PDF coords
        const a = tr[0], d = tr[3], e = tr[4], f = tr[5];
        // fontSize ≈ hypot of the vertical-scale components, works for non-rotated text
        const fontSize = Math.abs(d) > 0.01 ? Math.abs(d) : Math.max(Math.hypot(tr[2], d), 8);
        const textWidth = typeof it.width === "number" && it.width > 0 ? it.width : fontSize * str.length * 0.5;
        // PDF baseline in bottom-left origin: baselineY_bl = f
        // Top of glyph in bottom-left: f + fontSize * 0.75 (ascent)
        // Convert to top-left origin: topY_tl = pageH - (f + fontSize * 0.75)
        const xTopLeft = e;
        const yTopLeft = pageH - f - fontSize * 0.75;
        items.push({
          text: str,
          x: xTopLeft,
          y: yTopLeft,
          width: textWidth,
          height: fontSize,
          fontSize,
        });
      }
      out.push({ page: i, width: pageW, height: pageH, items });
    }
  } finally {
    await doc.destroy();
  }
  return out;
}

// Text-heuristic patterns, ordered by confidence. First match wins per item.
// Zone starts to the RIGHT of the label text by default; initials/date boxes
// are smaller than signature boxes.
//
// IMPORTANT: these patterns are strict by design. "Signature requirements."
// should NOT match — that's instructional text, not a zone label. Only match
// labels that clearly precede a signing area: followed by "of", ":", end-of-string,
// or a standalone "Sign Here" / "X ______" style marker.
// `requiresRoom` means the bare-word match only counts if there's clear
// horizontal space to the right on the same baseline — suppresses false
// positives on section headers like Part II's "Signature of U.S. person"
// subheading or table column header "Date" where there's actual content
// immediately to the right.
// `placement`:
//   "right" — label is followed by a horizontal line on the same baseline;
//             zone sits to the right of the label (e.g. "Signature of X ____")
//   "above" — label is UNDER a horizontal line (the line is the signing surface);
//             zone sits above the label so a signature rests on the line.
//             Common on government forms where bare "Signature" / "Date" label
//             a line one row above.
const SIGNATURE_PATTERNS = [
  // Most "Signature of X" labels on legal/gov forms caption the signature
  // LINE ABOVE them (e.g. "___________\nSignature of Authorized Officer").
  // Place above by default; the existing fallback inside scanPageForLabels
  // switches to right-placement when the label is too close to the page top.
  { rx: /^Signature of\b/i,          type: "signature", confidence: 0.92, zoneWidth: 260, placement: "above" },
  { rx: /^Signature:/i,               type: "signature", confidence: 0.88, zoneWidth: 260, placement: "right" },
  { rx: /^Signed by\b/i,              type: "signature", confidence: 0.80, zoneWidth: 240, placement: "right" },
  { rx: /^Signature$/i,               type: "signature", confidence: 0.75, zoneWidth: 240, placement: "above", requiresRoom: 40 },
  // Qualifier + Signature — "Applicant Signature", "Employee Signature*",
  // "Borrower's Signature", "Witness Signature", "Authorized Officer Signature".
  // 1–3 qualifier words (letters, numbers, apostrophes) then the literal
  // "Signature" with optional "*" (common required-field marker).
  { rx: /^(?:[A-Za-z][A-Za-z'0-9]*\s+){1,3}Signature\*?$/,
                                        type: "signature", confidence: 0.80, zoneWidth: 240, placement: "above" },
  { rx: /^(?:[A-Za-z][A-Za-z'0-9]*\s+){1,3}Initials?\*?$/,
                                        type: "initials",  confidence: 0.75, zoneWidth: 60,  placement: "above" },
  { rx: /^Sign Here\b/i,              type: "signature", confidence: 0.85, zoneWidth: 260, placement: "right" },
  { rx: /^X[\s_]{3,}/,                type: "signature", confidence: 0.70, zoneWidth: 240, placement: "right" },
  { rx: /^Initials?:/i,               type: "initials",  confidence: 0.78, zoneWidth: 60,  placement: "right" },
  { rx: /^Init\.?:?$/i,               type: "initials",  confidence: 0.75, zoneWidth: 50,  placement: "above" },
  { rx: /^Initials?$/i,               type: "initials",  confidence: 0.72, zoneWidth: 60,  placement: "above", requiresRoom: 30 },
  { rx: /^Date:/i,                    type: "date",      confidence: 0.75, zoneWidth: 110, placement: "right" },
  { rx: /^Date$/i,                    type: "date",      confidence: 0.65, zoneWidth: 110, placement: "above", requiresRoom: 30 },
];

// Check whether there's empty space to the right of this item within `minPts`
// on roughly the same baseline. Used to gate bare-word pattern matches so
// section headers / column labels don't false-positive.
// Ignores single-character decorative glyphs (arrows, bullets, check marks)
// that forms use to point at the signing area — those don't fill the space.
function isDecorativeGlyph(text) {
  if (text.length !== 1) return false;
  // Not a letter, digit, or common punctuation — almost certainly a form glyph
  return !/[A-Za-z0-9.,;:!?@#$%&*()\[\]{}\-_+=<>\/\\]/.test(text);
}

function hasRoomToRight(item, allItems, minPts) {
  const labelRightEdge = item.x + item.width;
  for (const other of allItems) {
    if (other === item) continue;
    const sameBaseline = Math.abs(other.y - item.y) < item.height * 0.7;
    if (!sameBaseline) continue;
    if (other.x <= labelRightEdge) continue;
    if (isDecorativeGlyph(other.text)) continue;
    const gap = other.x - labelRightEdge;
    if (gap < minPts) return false;
  }
  return true;
}

// Scan one page's text items for signature/initials/date labels.
// Zone begins right after the label; width comes from the pattern config.
function scanPageForLabels(page) {
  const zones = [];
  for (const item of page.items) {
    const text = item.text.trim();
    for (const pat of SIGNATURE_PATTERNS) {
      if (!pat.rx.test(text)) continue;
      // Bare-word patterns (e.g. /^Signature$/) require empty space to their
      // right — otherwise they fire on section headings and column labels.
      if (pat.requiresRoom && !hasRoomToRight(item, page.items, pat.requiresRoom)) {
        break; // matched but suppressed — don't fall through to other patterns
      }
      const gap = 6;
      const zoneHeight = Math.max(item.height * 1.3, 18);
      const rightBound = page.width - 18;
      let zoneX, zoneY, zoneWidth;

      if (pat.placement === "above") {
        // Line sits above the label; the zone rests on the line with its
        // bottom roughly at the label's top edge. Shift up by (zoneHeight + 2)
        // so the zone's bottom ≈ line's y.
        zoneX = item.x;
        zoneY = item.y - zoneHeight - 2;
        // If the label is too close to the page top there's no line above —
        // fall back to right-placement so we don't emit a zone off-page.
        if (zoneY < 4) {
          zoneX = item.x + item.width + gap;
          zoneY = item.y - (zoneHeight - item.height) / 2;
          zoneWidth = Math.min(pat.zoneWidth, Math.max(rightBound - zoneX, 0));
        } else {
          zoneWidth = Math.min(pat.zoneWidth, Math.max(rightBound - zoneX, 0));
        }
      } else {
        zoneX = item.x + item.width + gap;
        zoneY = item.y - (zoneHeight - item.height) / 2;
        zoneWidth = Math.min(pat.zoneWidth, Math.max(rightBound - zoneX, 0));
      }

      if (zoneWidth < 24) break; // too squeezed — label with no room
      zones.push({
        type: pat.type,
        label: text,
        page: page.page,
        x: Math.round(zoneX * 10) / 10,
        y: Math.round(zoneY * 10) / 10,
        width: Math.round(zoneWidth * 10) / 10,
        height: Math.round(zoneHeight * 10) / 10,
        confidence: pat.confidence,
        source: "text-heuristic",
      });
      break; // one pattern per item
    }
  }
  return zones;
}

// Look up AcroForm signature-typed fields and signature-named text fields.
// Uses pdf-lib to read field types + widget rectangles.
// Returns zones in top-left origin.
function scanAcroFormForZones(pdfDoc) {
  const zones = [];
  let fields;
  try {
    fields = pdfDoc.getForm().getFields();
  } catch {
    return zones;
  }
  const pages = pdfDoc.getPages();
  const pageHeights = pages.map(p => p.getSize().height);

  for (const field of fields) {
    const typeName = field.constructor.name || "";
    let widgets;
    try { widgets = field.acroField.getWidgets(); } catch { continue; }
    if (!widgets || widgets.length === 0) continue;

    const isSignature = typeName.includes("Signature");
    const fieldName = (() => { try { return field.getName(); } catch { return ""; } })();
    // Match signature-like field names that are clearly *about* signing:
    //   "Signature", "Signature1", "sig_date", "Name_Sig", "form_signature"
    // Reject substrings inside unrelated words: "assignment", "design", "resignation", "Initialize"
    // Leading `(^|[^a-z])` demands a non-letter boundary before the keyword (rejects camelCase
    // midwords like "DocumentSignature" too — minor false-negative, acceptable for v0.8.0).
    // Trailing `(?![a-z])` rejects continuations: "signature" vs "signatures_optional" (match)
    // but "signaturelookup" (continues with letter — reject).
    const looksLikeSig = !isSignature && typeName.includes("TextField") &&
      /(^|[^a-z])(sig|signature)s?(?![a-z])/i.test(fieldName);
    const looksLikeInitials = !isSignature && typeName.includes("TextField") &&
      /(^|[^a-z])initials?(?![a-z])/i.test(fieldName);
    if (!isSignature && !looksLikeSig && !looksLikeInitials) continue;

    for (const widget of widgets) {
      let rect;
      try { rect = widget.getRectangle(); } catch { continue; }
      // Find the page index for this widget
      let pageIdx = -1;
      try {
        const pRef = widget.P && widget.P();
        if (pRef) {
          for (let i = 0; i < pages.length; i++) {
            if (pages[i].ref === pRef) { pageIdx = i; break; }
          }
        }
      } catch { /* fall through */ }
      if (pageIdx === -1) {
        // Fallback: find which page's Annots contains this widget's ref
        for (let i = 0; i < pages.length; i++) {
          try {
            const annots = pages[i].node.Annots();
            if (!annots) continue;
            const array = annots.array ? annots.array : annots;
            const list = array.asArray ? array.asArray() : [];
            if (list.some(ref => ref === widget.ref)) { pageIdx = i; break; }
          } catch { /* skip */ }
        }
      }
      if (pageIdx === -1) pageIdx = 0; // fallback — put on page 1

      const pageH = pageHeights[pageIdx];
      const zone = {
        type: isSignature || looksLikeSig ? "signature" : "initials",
        label: fieldName || (isSignature ? "Signature" : "Initials"),
        page: pageIdx + 1,
        x: Math.round(rect.x * 10) / 10,
        y: Math.round((pageH - rect.y - rect.height) * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
        confidence: isSignature ? 0.99 : 0.85,
        source: isSignature ? "acroform-signature" : "acroform-named-field",
      };
      zones.push(zone);
    }
  }
  return zones;
}

// Remove overlapping zones — keep the higher-confidence one.
function dedupeOverlappingZones(zones, iouThreshold = 0.4) {
  const sorted = [...zones].sort((a, b) => b.confidence - a.confidence);
  const kept = [];
  for (const z of sorted) {
    const dup = kept.some(k => k.page === z.page && computeIoU(k, z) >= iouThreshold);
    if (!dup) kept.push(z);
  }
  // Final sort: by page then by y-coordinate (top to bottom)
  kept.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  return kept;
}

// Main entry: returns a typed zone array for the given PDF.
// Caller supplies the loaded pdfjs module (helpers.js stays pure-import).
export async function detectSignatureZones({ pdfDoc, pdfBytes, pdfjsLib, password }) {
  const zones = [];

  // Layer 1+2: AcroForm signature fields and signature-named text fields
  zones.push(...scanAcroFormForZones(pdfDoc));

  // Layer 3: Text-heuristic pattern matching
  if (pdfjsLib && pdfBytes) {
    try {
      const pages = await extractPdfTextWithBounds(pdfjsLib, pdfBytes, { password });
      for (const page of pages) {
        zones.push(...scanPageForLabels(page));
      }
    } catch (err) {
      // Text extraction failure is non-fatal — return AcroForm-only zones.
      // Surface via the zone list's metadata once we start returning a richer shape.
    }
  }

  return dedupeOverlappingZones(zones);
}

// Build a compact one-line audit trail to store in PDF metadata.
export function formatSigningAuditLine({ display_name, statement, confirmedAt, action = "signed" }) {
  const iso = confirmedAt.toISOString();
  // Sanitize statement — metadata should be single-line
  const flat = statement.replace(/\s+/g, " ").trim();
  return `${action} via pdf-toolkit; signer="${display_name}"; at=${iso}; intent="${flat}"`;
}

// Parse page range strings like "1-5,6-10" or "every 5"

// Sanitize a filename for safe filesystem use. Always ends with .pdf.
export function sanitizePdfFilename(name) {
  let safe = path.basename(String(name || ""));
  safe = safe.replace(/[\x00-\x1f\x7f]/g, "");
  safe = safe.replace(/[\/\\:*?"<>|]/g, "_");
  safe = safe.replace(/^\.+/, "").trim();
  if (!safe) safe = "download.pdf";
  if (!safe.toLowerCase().endsWith(".pdf")) safe += ".pdf";
  return safe;
}

// Find an unused filesystem path by appending " (2)", " (3)", etc.
export async function findUniquePath(target) {
  try {
    await fs.access(target);
  } catch {
    return target;
  }
  const ext = path.extname(target);
  const base = target.slice(0, target.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})${ext}`;
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error(`Could not find a unique filename for ${target}`);
}

// Detect loopback, link-local, and RFC1918 private hostnames/IPs.
export function isPrivateHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0.0.0.0") return true;
  if (h.endsWith(".localhost") || h.endsWith(".local")) return true;
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:")) return true;
  return false;
}

// Validate a URL for fetch: must be http/https, must not be a private host
// (unless allowPrivateHosts). Returns the parsed URL or throws.
function validateFetchTarget(urlString, allowPrivateHosts) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Only http and https URLs are supported (got ${parsed.protocol}).`);
  }
  if (!allowPrivateHosts && isPrivateHost(parsed.hostname)) {
    throw new Error(
      `Refusing to download from private/loopback host "${parsed.hostname}". ` +
      `Set allow_private_hosts=true if this is intentional.`
    );
  }
  return parsed;
}

// Download a PDF from a URL to a local file.
// Returns { path, bytes, contentType, sourceUrl, finalUrl, redirectHops }.
// Rejects: non-http(s), private hosts (unless allowPrivateHosts), non-PDF content, oversize,
// redirects to private hosts (each redirect is re-validated — prevents redirect-based SSRF).
export async function downloadPdfFromUrl(url, {
  filename = null,
  destinationDir = null,
  overwrite = false,
  maxSizeMb = 100,
  headers = {},
  allowPrivateHosts = false,
  maxRedirects = 5,
  fetchFn = fetch,
} = {}) {
  // Initial validation — defends against the naive SSRF case.
  validateFetchTarget(url, allowPrivateHosts);

  // Manual redirect loop — re-validates each hop so a public URL cannot 302
  // to a private host (AWS metadata endpoint, localhost, RFC1918, etc.).
  let currentUrl = url;
  let response;
  let hops = 0;
  while (true) {
    let parsed;
    try {
      response = await fetchFn(currentUrl, { headers, redirect: "manual" });
    } catch (err) {
      parsed = new URL(currentUrl);
      throw new Error(`Could not reach ${parsed.hostname}: ${err.message}`);
    }
    const status = response.status;
    const isRedirect = [301, 302, 303, 307, 308].includes(status);
    if (!isRedirect) break;

    if (hops >= maxRedirects) {
      throw new Error(`Too many redirects (>${maxRedirects}) starting from ${url}.`);
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`HTTP ${status} redirect from ${currentUrl} with no Location header.`);
    }
    // Resolve relative Location against current URL; absolute URLs pass through.
    const nextUrl = new URL(location, currentUrl).toString();
    // Re-validate the target of every hop — blocks redirect-based SSRF.
    validateFetchTarget(nextUrl, allowPrivateHosts);
    currentUrl = nextUrl;
    hops++;
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} from ${currentUrl}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const contentLengthHeader = response.headers.get("content-length");
  const advertisedLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;
  const maxBytes = maxSizeMb * 1024 * 1024;
  if (advertisedLength && advertisedLength > maxBytes) {
    throw new Error(
      `PDF is ${(advertisedLength / 1048576).toFixed(1)} MB, exceeds ${maxSizeMb} MB limit. ` +
      `Increase max_size_mb to override.`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new Error(
      `PDF is ${(buffer.length / 1048576).toFixed(1)} MB, exceeds ${maxSizeMb} MB limit.`
    );
  }

  const magic = buffer.subarray(0, 5).toString("ascii");
  if (magic !== "%PDF-") {
    const preview = buffer.subarray(0, 80).toString("utf-8")
      .replace(/[^\x20-\x7e]/g, "?").slice(0, 60);
    throw new Error(
      `URL did not return a PDF. Content-Type: "${contentType || "unknown"}". ` +
      `First bytes: "${preview}". ` +
      `The URL may point to an HTML page — confirm it is a direct PDF link.`
    );
  }

  // Destination dir + filename resolution deferred until after validation
  // so we don't create empty files on rejection paths.
  // Default to the user's standard Downloads folder — a hidden dotfile dir is
  // invisible in Finder and users can't find their files. ~/Downloads works
  // on macOS, Windows, and most Linux setups.
  const destDir = destinationDir || path.join(homedir(), "Downloads");
  await fs.mkdir(destDir, { recursive: true });
  const finalParsed = new URL(currentUrl);
  const urlName = decodeURIComponent(path.basename(finalParsed.pathname) || "");
  const finalName = sanitizePdfFilename(filename || urlName || "download.pdf");
  let target = path.join(destDir, finalName);
  if (!overwrite) target = await findUniquePath(target);

  await fs.writeFile(target, buffer);
  return {
    path: target,
    bytes: buffer.length,
    contentType,
    sourceUrl: url,
    finalUrl: currentUrl,
    redirectHops: hops,
  };
}

// Parse page range strings like "1-5,6-10" or "every 5"
export function parsePageRanges(rangeString, totalPages) {
  const trimmed = rangeString.trim();

  // Handle "every N" shorthand
  const everyMatch = trimmed.match(/^every\s+(\d+)$/i);
  if (everyMatch) {
    const n = parseInt(everyMatch[1], 10);
    if (n <= 0) throw new Error("'every N' requires N > 0.");
    const ranges = [];
    for (let start = 1; start <= totalPages; start += n) {
      const end = Math.min(start + n - 1, totalPages);
      ranges.push([start, end]);
    }
    return ranges;
  }

  // Handle comma-separated dash ranges: "1-5,6-10,11-15"
  const parts = trimmed.split(",").map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("Empty page range string.");

  const ranges = [];
  for (const part of parts) {
    const dashMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!dashMatch) {
      // Try single page number
      const singleMatch = part.match(/^(\d+)$/);
      if (singleMatch) {
        const page = parseInt(singleMatch[1], 10);
        if (page < 1 || page > totalPages) throw new Error(`Page ${page} is out of range (1-${totalPages}).`);
        ranges.push([page, page]);
        continue;
      }
      throw new Error(`Invalid page range: "${part}". Use "1-5" or "every 5" format.`);
    }
    const start = parseInt(dashMatch[1], 10);
    const end = parseInt(dashMatch[2], 10);
    if (start < 1 || end < 1) throw new Error(`Page numbers must be >= 1, got "${part}".`);
    if (start > end) throw new Error(`Invalid range "${part}": start (${start}) > end (${end}).`);
    if (end > totalPages) throw new Error(`Page ${end} is out of range (1-${totalPages}).`);
    ranges.push([start, end]);
  }
  return ranges;
}

export function normalizeRotation(rotation) {
  const normalized = rotation % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

export function getPageDisplayMetrics({ width, height, rotation = 0 }) {
  const normalizedRotation = normalizeRotation(rotation);
  const swapsAxes = normalizedRotation === 90 || normalizedRotation === 270;
  const displayWidth = swapsAxes ? height : width;
  const displayHeight = swapsAxes ? width : height;

  return {
    width: Math.round(width),
    height: Math.round(height),
    rotation: normalizedRotation,
    display_width: Math.round(displayWidth),
    display_height: Math.round(displayHeight),
    orientation: displayWidth > displayHeight ? "landscape" : "portrait",
  };
}

export function getPageRenderScale({
  width,
  height,
  maxDimensionPx = 1800,
  minScale = 1,
  maxScale = 2.5,
}) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("width and height must be positive numbers.");
  }
  if (!Number.isFinite(maxDimensionPx) || maxDimensionPx <= 0) {
    throw new Error("maxDimensionPx must be a positive number.");
  }
  const dominantSide = Math.max(width, height);
  const scaleFromDimension = maxDimensionPx / dominantSide;
  const boundedScale = Math.min(Math.max(scaleFromDimension, minScale), maxScale);
  return Math.round(boundedScale * 100) / 100;
}

export function validatePdfRegionBox({
  pageWidth,
  pageHeight,
  x,
  y,
  width,
  height,
}) {
  if (![pageWidth, pageHeight, x, y, width, height].every(Number.isFinite)) {
    throw new Error("pageWidth, pageHeight, x, y, width, and height must all be finite numbers.");
  }
  if (pageWidth <= 0 || pageHeight <= 0) {
    throw new Error("pageWidth and pageHeight must be positive numbers.");
  }
  if (width <= 0 || height <= 0) {
    throw new Error("width and height must be positive numbers.");
  }
  if (x < 0 || y < 0 || x + width > pageWidth || y + height > pageHeight) {
    throw new Error(
      `Region (${x}, ${y}, ${width}x${height}) falls outside page bounds ` +
      `(${pageWidth.toFixed(0)}x${pageHeight.toFixed(0)} pts).`
    );
  }
}

export function getRegionPixelRect({
  x,
  y,
  width,
  height,
  scale,
}) {
  if (![x, y, width, height, scale].every(Number.isFinite)) {
    throw new Error("x, y, width, height, and scale must all be finite numbers.");
  }
  if (scale <= 0) {
    throw new Error("scale must be a positive number.");
  }

  return {
    left: Math.round(x * scale),
    top: Math.round(y * scale),
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function normalizeExtractedText(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildPageTextSegments(pageTexts, {
  startPage = 1,
  endPage = pageTexts.length,
  maxCharsPerPage = 4000,
  maxTotalChars = 16000,
} = {}) {
  if (!Array.isArray(pageTexts)) {
    throw new Error("pageTexts must be an array.");
  }
  if (!Number.isInteger(startPage) || startPage < 1) {
    throw new Error("startPage must be an integer >= 1.");
  }
  if (!Number.isInteger(endPage) || endPage < startPage) {
    throw new Error("endPage must be an integer >= startPage.");
  }
  if (!Number.isInteger(maxCharsPerPage) || maxCharsPerPage < 1) {
    throw new Error("maxCharsPerPage must be an integer >= 1.");
  }
  if (!Number.isInteger(maxTotalChars) || maxTotalChars < 1) {
    throw new Error("maxTotalChars must be an integer >= 1.");
  }
  if (pageTexts.length === 0) {
    return {
      totalPages: 0,
      startPage,
      endPage,
      totalSourceChars: 0,
      totalReturnedChars: 0,
      truncated: false,
      pages: [],
    };
  }
  if (endPage > pageTexts.length) {
    throw new Error(`endPage ${endPage} is out of range (1-${pageTexts.length}).`);
  }

  const selectedPages = pageTexts.slice(startPage - 1, endPage);
  const pages = [];
  let remainingChars = maxTotalChars;
  let totalSourceChars = 0;
  let totalReturnedChars = 0;
  let truncated = false;

  for (const rawPage of selectedPages) {
    const normalizedText = normalizeExtractedText(rawPage?.text);
    totalSourceChars += normalizedText.length;

    const charsAvailable = Math.max(Math.min(remainingChars, maxCharsPerPage), 0);
    const returnedText = normalizedText.slice(0, charsAvailable);
    const pageTruncated = normalizedText.length > returnedText.length;
    if (pageTruncated) truncated = true;

    pages.push({
      page: rawPage?.page,
      char_count: normalizedText.length,
      returned_chars: returnedText.length,
      truncated: pageTruncated,
      text: returnedText,
    });

    totalReturnedChars += returnedText.length;
    remainingChars -= returnedText.length;
  }

  return {
    totalPages: pageTexts.length,
    startPage,
    endPage,
    totalSourceChars,
    totalReturnedChars,
    truncated,
    pages,
  };
}

function buildMatchSnippet(text, matchIndex, matchLength, contextChars) {
  const start = Math.max(0, matchIndex - contextChars);
  const end = Math.min(text.length, matchIndex + matchLength + contextChars);
  let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = `...${snippet}`;
  if (end < text.length) snippet = `${snippet}...`;
  return snippet;
}

export function searchPageTexts(pageTexts, query, {
  maxResults = 10,
  contextChars = 160,
} = {}) {
  if (!Array.isArray(pageTexts)) {
    throw new Error("pageTexts must be an array.");
  }
  const normalizedQuery = String(query ?? "").trim();
  if (!normalizedQuery) {
    throw new Error("query must be a non-empty string.");
  }
  if (!Number.isInteger(maxResults) || maxResults < 1) {
    throw new Error("maxResults must be an integer >= 1.");
  }
  if (!Number.isInteger(contextChars) || contextChars < 10) {
    throw new Error("contextChars must be an integer >= 10.");
  }

  const loweredQuery = normalizedQuery.toLowerCase();
  const matches = [];

  for (const rawPage of pageTexts) {
    const normalizedText = normalizeExtractedText(rawPage?.text);
    if (!normalizedText) continue;

    const loweredText = normalizedText.toLowerCase();
    let fromIndex = 0;
    while (matches.length < maxResults) {
      const matchIndex = loweredText.indexOf(loweredQuery, fromIndex);
      if (matchIndex === -1) break;

      matches.push({
        page: rawPage?.page,
        char_index: matchIndex,
        match_text: normalizedText.slice(matchIndex, matchIndex + normalizedQuery.length),
        snippet: buildMatchSnippet(normalizedText, matchIndex, normalizedQuery.length, contextChars),
      });

      fromIndex = matchIndex + normalizedQuery.length;
    }

    if (matches.length >= maxResults) break;
  }

  return {
    query: normalizedQuery,
    matchCount: matches.length,
    truncated: matches.length >= maxResults,
    matches,
  };
}
