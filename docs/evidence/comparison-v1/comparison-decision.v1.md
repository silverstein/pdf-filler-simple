# PDF comparison v1 measurement decision

Status: **measurement blocked**. Benchmark/public claim readiness is **false**. No product architecture or release is approved.

The provisional shared-library reference passed 7/7 pair-level gates, while current published MCP primitives passed 1/7. Neither report passed the global isolation gate. Current event F1 is 0.133 and evidence completeness is 7.4%. The shared result is an implementation reference, not independent confirmation. Poppler status is `completed` and remains an unscored external sensor.

## Provisional direction

First version the generic render observation and add read-only metadata, annotation, and field-geometry observations. Then measure a deterministic local `compare_pdfs` prototype, host-agent explanations, and a source-linked side-by-side viewer. Do not upgrade the protected PDF.js pin or bundle Poppler in this tranche.

## Measured gaps

- Current visual facets: 0 TP / 5 FN. Encoded PNGs are useful to a model but are not canonical retained region evidence.
- Current metadata: 2 FN; actual Info/XMP values are not exposed.
- Current annotations: 1 FN; annotation enumeration is absent.
- Current form fields: 0 FN; values lack widget page/geometry evidence.
- Agent pass rate and variance remain null until three predeclared measured trials cross the generic observation trust boundary.

## Evidence boundary

The source tree was clean at revision `16d46ab649fcd39e5980189602e98064c14570cc` except generated evidence and the shared dependency symlink. Evidence files are hash-bound, but the controller registry is unsigned. Truth, shell, and network isolation were not OS-enforced, so the reports are descriptive and cannot support a benchmark claim.

## Release boundary

This benchmark changed no runtime, package, manifest, UI, or MCPB bytes. The frozen candidate remains `b586221595cc3095d43f73daf3b66c6cc9695bddcd98365f46c445a597d9a1b4`. Native Claude Desktop, Windows, and human approval remain release gates.
