ObjC.import("Foundation");
ObjC.import("PDFKit");

function run(argv) {
  const results = argv.map(filename => {
    const url = $.NSURL.fileURLWithPath(filename);
    const document = $.PDFDocument.alloc.initWithURL(url);
    if (!document) throw new Error(`PDFKit could not open ${filename}`);

    const pageCount = Number(document.pageCount);
    const firstPage = pageCount > 0 ? document.pageAtIndex(0) : null;
    const pageText = firstPage ? (ObjC.unwrap(firstPage.string) || "") : "";
    return {
      file: ObjC.unwrap($(filename).lastPathComponent),
      page_count: pageCount,
      first_page_rotation: firstPage ? Number(firstPage.rotation) : null,
      has_blueharbor_marker: pageText.includes("BLUEHARBOR"),
    };
  });

  return JSON.stringify(results, null, 2);
}
