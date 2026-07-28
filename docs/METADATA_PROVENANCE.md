# Metadata provenance through merge and split

Decision record for bead `pdf-toolkit-mcp-igr.17`. Written 2026-07-25.

The bead asked whether PDF Tools should preserve per-input document metadata
through `merge_pdfs` and recover it when splitting source-aligned ranges, and
required the standards, privacy, and interoperability options to be researched
before any implementation. This is that evaluation and the resulting decision.
The default correctness portion was implemented in
`pdf-toolkit-mcp-igr.17.1` on 2026-07-28.

## What the tools did before correction, measured

Built two documents with distinct Info dictionaries, merged them, then split the
merged file back along the original source boundaries, all through the MCP
boundary rather than through `pdf-lib` directly.

| Artifact | Pages from | Title | Author |
|---|---|---|---|
| input A | A | `Title A` | `Author A` |
| input B | B | `Title B` | `Author B` |
| merged | A + B | `Title A` | `Author A` |
| split `pages_1-2` | A | `Title A` | `Author A` |
| split `pages_3-4` | **B** | `Title A` | **`Author A`** |

Merge inherits the first input's Info dictionary and discards the rest. Split
copies the input document's Info onto every output regardless of which pages it
contains.

The last row is the finding that matters. This is not simply lossy. The file
containing B's pages positively asserts that its author is Author A. A user who
merges a counterparty's document with their own, splits it, and sends a range
back is shipping a file whose stated authorship is wrong. For a tool used on
contracts and forms, misattribution is a worse failure than absence.

The same applies to `Subject`, `Keywords`, and `Creator`, and it compounds:
nothing marks the claim as inherited, so a downstream reader cannot tell an
asserted author from a copied one.

## Options considered

### 1. Status quo

Standard document-level semantics, no new formats, no privacy surface. Rejected
as an end state solely because it produces the false assertion above. Its
simplicity is otherwise correct and worth preserving.

### 2. Private page dictionaries (`PieceInfo`)

Attach per-page source metadata via the page-piece dictionary so split can
recover it exactly.

**Rejected.** `PieceInfo` holds private application data that general-purpose
viewers ignore, so the provenance would be invisible to every consumer except
this tool. Acrobat ships a preflight fixup that discards private data from other
applications, so the data is not merely ignored but actively removed in ordinary
workflows. It would also silently carry one party's metadata inside a file
delivered to another, which is the privacy failure mode this decision most wants
to avoid. The bead's instruction not to add hidden private page dictionaries by
default is correct and is adopted permanently, not just as a default.

### 3. XMP media-management provenance

Record contributing sources with `xmpMM:Ingredients` and `xmpMM:DerivedFrom`,
which is the standards-based vocabulary for exactly this: a composed asset
referencing the components it was built from, each identified by `DocumentID`
and `InstanceID`.

**Accepted as the opt-in mechanism**, with one hard constraint. Source XMP must
never be copied wholesale. Many XMP properties assert something true only of the
document that carried them, including standards-conformance claims such as
PDF/A. A merged or rebuilt document almost certainly does not satisfy a
conformance claim it inherited, so copying the block forward manufactures a
false claim of exactly the kind this project's evaluation contract exists to
prevent. Only explicit ingredient references may be written.

### 4. Sidecar provenance file

Emit a companion JSON describing which output pages came from which input.

**Accepted as the default for the recovery case.** It cannot corrupt the PDF,
cannot leak into a delivered document, is trivially inspectable, and requires no
new in-file format. Its weakness is real: a sidecar separated from its PDF is
useless, and no other tool understands it. That is acceptable for a mapping
artifact whose job is to inform a later split rather than to travel with the
document.

## Decision

**Do not** preserve per-input metadata inside merged PDFs by default, in any
form. The default output must remain a plain, standards-ordinary document with
no private dictionaries and no inherited claims.

**Do** stop asserting metadata that is not known to describe the artifact. This
is the priority change and it needs no new format:

- `merge_pdfs` should not present one input's `Title`, `Author`, `Subject`, or
  `Keywords` as though it described the whole. Where inputs disagree, omit the
  field rather than pick a winner.
- `split_pdf` should not copy document metadata onto ranges whose provenance it
  cannot establish.

Omission over false assertion is the same rule already applied elsewhere in this
codebase: incomplete page analysis reports `unknown` rather than `likely_blank`,
and form validation refuses to claim whole-form readiness it cannot support.

**Offer**, never impose, two opt-in provenance surfaces:

- An XMP `xmpMM:Ingredients` / `DerivedFrom` record on merge, for users who want
  interoperable provenance in the file. Explicit references only.
- A sidecar page-to-source map on merge, for users who intend to split later and
  want the mapping without touching the document.

Both are off by default, because moving metadata between documents belonging to
different parties is a disclosure, and a disclosure must be a choice.

## Implemented default behavior

For a merge with two or more inputs, `Title`, `Author`, `Subject`, and
`Keywords` are evaluated independently. A field is preserved only when every
input positively asserts the exact same value. A disagreement, a value missing
from any input, or an invalid value causes that field to be omitted. The tool
result lists the fields it omitted so the loss is visible rather than silent.

A single-input merge retains the source Info dictionary. Splitting an ordinary
unmerged document also retains its document metadata. This preserves the
unambiguous cases while ensuring that a later split of output from a conflicting
merge cannot reassert one input's author as the author of another input's pages.

No source `Creator`, creation timestamp, private page dictionary, or source XMP
block is copied into a multi-input merge. The output keeps truthful
output-creation metadata written by the PDF library.

## Privacy boundary

Merging is frequently cross-party: a user combines their document with one they
received. Author, Creator, and Producer strings routinely name individuals,
internal tooling, and organizations. Preserving them by default would take
information the sender never chose to publish and place it in a file that
travels onward.

The default therefore carries less metadata than the inputs, not more, and any
mechanism that carries more must be explicitly requested and visible in the tool
result.

## Follow-up work

Implementation is deliberately not part of this bead. Tracked separately:

- `pdf-toolkit-mcp-igr.17.1` — stop asserting unverified metadata through merge
  and split. This is the correctness fix and carries the measured misattribution
  case as its regression test.
- `pdf-toolkit-mcp-igr.17.2` — optional XMP ingredient provenance and the
  sidecar map, both opt-in, gated behind the first.

## Sources

- Adobe, *Introduction to XMP Asset Relationships* — `xmpMM:Ingredients`,
  `xmpMM:DerivedFrom`, `DocumentID` / `InstanceID` semantics.
- XMP Specification Part 2, *Standard Schemas* — media-management schema.
- PDF Association, *Understanding Private Data in PDF/A* (2024-06) and
  *Including custom metadata structures in PDF* (2025-10).
- ISO 32000-1 §14.5, page-piece dictionaries.
