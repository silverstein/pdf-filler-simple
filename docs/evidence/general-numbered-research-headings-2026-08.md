# General numbered research headings evidence

Date: 2026-08-04 (America/Los_Angeles)

## Decision

The candidate is safe to merge as a general extraction improvement, but it is
not a release by itself. It recovers numbered research-paper headings only when
the PDF supplies consistent geometric evidence, and it rejects narrow vertical
labels such as the arXiv margin stamp.

## Public sources

### Attention Is All You Need

- Source: `https://arxiv.org/pdf/1706.03762`
- PDF SHA-256:
  `bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697`
- Pages: 15
- Visually checked rendered pages: 1, 3, and 6
- v0.9.4: 0 of 22 numbered headings; the vertical arXiv label was falsely a
  heading
- Candidate: 22 of 22 numbered headings with the correct hierarchy; the real
  title is H1; the vertical arXiv label is not a heading
- Candidate Markdown SHA-256:
  `afd64c7ce130a75f306a02e9f273da0c265e768c7ba061f961a7688c2619d819`

### Adam: A Method for Stochastic Optimization

- Source: `https://arxiv.org/pdf/1412.6980`
- PDF SHA-256:
  `eab9c73ae2ceda884b94830bda99312254bac4806f6c9f045cbab90721ecda31`
- Pages: 15
- Visually checked rendered pages: 1, 2, and 9
- v0.9.4: 0 of 18 labeled numbered headings; the vertical arXiv label was
  falsely a heading
- Candidate: 9 of 18 numbered headings, covering only the proven single-line
  small-caps main sections; the vertical arXiv label is not a heading
- Candidate Markdown SHA-256:
  `503c3471ae7f1c4c408d8ea9158741c11c66bb6eaa1eca40646440e3d6676215`

Across the two papers, numbered-heading recall moves from 0 of 40 to 31 of 40,
and false arXiv-label headings move from two to zero.

## Content preservation

After removing only Markdown heading markers and the expected renderer
limitation-line revision, baseline and candidate source text is byte-equivalent
for Attention, Adam, and Shannon. The normalized SHA-256 values are:

- Attention:
  `321ebc620438e1b8fe4763d15ba67f04d66f02cdc97c14e8851f7e66343b79fc`
- Adam:
  `37226c85fe338632824facd2e8fd26d7cf29cc40e25772503f5080e7b3`
- Shannon:
  `e1df3b1ac9a8d35d205905a0e3c6252fb23f0f2e3790c68a28a59c16a6094521`

The candidate does not change the existing gap or replacement-character
counts in either new paper.

## Shannon regression

Three complete 55-page Shannon runs are byte-identical at Markdown SHA-256
`2c4773511afe32d99ef44311406dbfeac42f4b3923696ef0fc59da56088eabe9`.
Existing quality remains unchanged: headings 14/14, reading order 24/24,
paragraphs 3/4, equations 4/4, footnotes 4/4, one qualifying table, and zero
false equation or malformed headings. The only content change from v0.9.4 is
the expected renderer limitation-line revision.

## Fail-closed boundary

The numbered-heading path accepts one to three numeric hierarchy levels and an
uppercase-leading title. It requires body-left alignment, a section break,
bounded width and height, and either a consistent distinct font or exact
same-font small-caps geometry. It rejects terminal punctuation and narrow,
tall vertical labels.

Adam's nine remaining numbered subsections stay plain text because their
numbers and titles are split into separate source lines or blocks. Joining
those fragments needs separate evidence and is not guessed here. Tables,
figures, equations, and complete mathematical reconstruction are outside this
claim.

## Verification

- Exact implementation commit reviewed: `b74d110f2faad440c24915bb4f62546d6b5221da`
- Independent result: ACCEPT with the real hash-locked Attention and Adam
  sources, the full Shannon replay, focused checks, schema/archive checks, and
  source/share byte identity
- Focused comparison check: 12/12 passed when rerun alone; the earlier
  full-suite metadata mismatch did not reproduce
- Refreshed extraction-layout oracle checks: 21 passed, 6 skipped

No public release or Kepano reply is authorized by this evidence alone.
