// Shared helpers for PDF Tools — extracted for testability

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
