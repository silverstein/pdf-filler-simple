# Security Policy

PDF Tools parses, mutates, and re-serializes untrusted PDF documents on a
user's own machine, and exposes those operations to an AI agent over MCP. Both
halves of that sentence carry security weight, and we would rather hear about a
problem early than discover it in the wild.

## Reporting a vulnerability

**Please report privately. Do not open a public issue for a suspected
vulnerability.**

Use GitHub's private vulnerability reporting on this repository:

1. Go to the [Security tab](https://github.com/Open-Document-Alliance/PDF-Tools/security)
2. Choose **Report a vulnerability**

That channel is monitored by the maintainers and keeps the report private until
a fix is available. If you are unable to use it, open a public issue that says
only that you need a private security contact, with no technical detail, and a
maintainer will open a private channel with you.

A useful report usually includes the affected version or commit, the host
(Claude Desktop, Cursor, or a direct MCP client), the platform, a minimal
reproducing document or input where one exists, and what an attacker gains.
Please do not include real personal data in a reproducer.

## Response targets

This project is maintained by a small team, so these are commitments we can
actually keep rather than aspirational numbers:

| Stage | Target |
|---|---|
| Acknowledge receipt | 3 business days |
| Initial assessment and severity | 7 business days |
| Fix or documented mitigation for critical and high severity | 30 days from assessment |
| Public advisory after a fix ships | Within 7 days, credited unless you prefer otherwise |

If a report is valid but a fix will take longer, we will say so and explain why
rather than let the thread go quiet.

## Supported versions

Security fixes land on `master` and ship in the next release. Only the latest
released version is supported. There are no long-term support branches, so
please upgrade before reporting an issue against an older build.

## Scope

The following are in scope and genuinely interesting to us:

- **Untrusted document parsing.** Memory-safety, denial-of-service, infinite
  loops, or unbounded allocation reachable from a malformed PDF, including
  through `pdf-lib`, `pdfjs-dist`, and the native Skia rasterizer bundled via
  `@napi-rs/canvas`.
- **Filesystem boundary escapes.** Any path that reads or writes outside the
  configured allowed directories, including traversal, symlink following, race
  conditions between validation and use, or the output transaction and recovery
  machinery restoring a file to an unintended location.
- **Agent trust-boundary failures.** This is an MCP server, so text extracted
  from a document flows into a model's context while that same model holds
  tools that fill, merge, split, delete pages, and stamp signatures. Reports
  showing that document content can induce an agent to take a file-mutating
  action the user did not ask for are especially welcome. So are bypasses of
  the human-intent requirement on `apply_signature`.
- **Supply chain.** Anything that lets an attacker influence what ends up in a
  published `.mcpb` artifact or share bundle, or that breaks the reproducibility
  of those builds.
- **Information disclosure.** Passwords for encrypted documents, file contents,
  or local paths travelling beyond the caller that supplied them, or persisting
  after the request: into logs, saved PDF metadata, build artifacts, or a
  response to a different requester. Passwords are never echoed anywhere.
  A refusal that names the configured allowed directories and the path just
  requested is deliberate rather than a leak — the caller supplied one and
  configured the other, so neither is new to them, and a boundary a user cannot
  see is a boundary they cannot correct.

## Out of scope

These are known and documented design boundaries, not vulnerabilities:

- **Tier 1 signatures are visible stamps, not cryptographic signatures.** They
  are deliberately not legally binding and make no cryptographic claim. See
  `CLAUDE.md` for the two-tier model.
- **No bundled OCR.** Raster-only pages are reported as unrecognized rather
  than silently returned as empty text. That is intended behavior.
- **Accessibility output is not a compliance claim.** The accessibility
  evaluation gate deliberately reports `not_established` and is not PDF/UA,
  WCAG, or legal-compliance certification.
- Vulnerabilities in Claude Desktop, Cursor, or another host application.
  Please report those to the host's vendor.
- A user deliberately granting the agent access to a directory and the agent
  then operating on files in it.
- Missing hardening with no demonstrated impact, or automated scanner output
  without a working reproducer.

## Disclosure

We follow coordinated disclosure. Please give us the response window above
before publishing. We will credit you in the advisory and the release notes
unless you ask us not to, and we will not pursue legal action against good
faith research that respects user privacy, avoids data destruction, and does
not access accounts or data that are not yours.

## Supporting practices

- Production dependencies are deliberately few, and `pdfjs-dist` is pinned to
  an exact version for host-compatibility reasons documented in `CLAUDE.md`.
- Dependabot is enabled for version updates and security alerts.
- Released artifacts are built reproducibly and ship a CycloneDX SBOM. It
  covers the locked npm graph and the QPDF WebAssembly runtime's native
  components, and it is generated rather than maintained by hand.
- Mutating tools enforce input size limits before parser allocation and write
  output through staged, journaled, hash-verified transactions.
- Malformed-document behavior is covered by an adversarial test campaign in
  `test/fuzz-malformed-pdfs.test.js`.

None of the above has been reviewed by anyone outside the project. If you are
that outside reviewer, we would like to hear from you.
