# Fixed raster source images

These synthetic PNGs are the canonical raster inputs for the Phase 0 extraction
fixtures. The generator verifies their exact SHA-256 identities before embedding
them:

- `raster-clean.png`: `82fa870df9c515554c9f2a22db017b94e8d2d022cef95a4b1842b99bc0538413`
- `raster-degraded.png`: `f0a79f7ee2b009f85b10b28582dad6258bb0544055bb99c7377f71ce34aec4d1`

The images contain only fixed fictional receipt text. They were losslessly
recovered from the committed synthetic PDFs after the original
`@napi-rs/canvas` 0.1.99 generation. Re-embedding either image with pdf-lib
1.17.1 reproduces the corresponding committed PDF byte for byte.

Keeping the source pixels in Git removes operating-system font lookup and native
canvas text rasterization from regeneration. Do not replace these files from a
host render. Any intentional visual revision requires new source hashes, PDF
hashes, structural inspection, and independent visual review.
