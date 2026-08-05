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
- v0.9.4: 0 of 17 genuinely numbered headings; the vertical arXiv label was
  falsely a heading
- First candidate: 9 of 17 numbered headings
- Follow-up candidate: 17 of 17, using the same exact two-size small-caps
  relationship already present in the first nine; the unnumbered References
  title remains unnumbered and the vertical arXiv label is not a heading
- Candidate Markdown SHA-256:
  `b015c3a552e428e649f1f6fd5445f2490fc8deb95d9efdabe261ee9a44bfb11a`

Across the two papers, numbered-heading recall moves from 0 of 39 to 39 of 39,
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

Adam's eight previously missed subsections use the same source line, font, left
edge, section break, and exact two-level small-caps geometry as the already
recognized sections. The follow-up accepts that exact relationship without
joining fragments or guessing text. Tables, figures, equations, and complete
mathematical reconstruction are outside this claim.

## Chart and diagram heading guard

Exact follow-up implementation
`e90e0ed57f308e46a7ca6507c13b0d1bc7172890`, with exact compatibility repair
tip `bec9fb4683aca1384391e7d8b3b43aaa7eef326d`, fixes a separate generic-heading
failure exposed by the cross-paper review:

- Adam page 7: eleven ordinary chart captions or prose lines falsely emitted as
  H1 become plain text
- Attention pages 13 through 15: three `Input-Input Layer5` diagram labels
  falsely emitted as H1 become plain text
- Both true paper titles remain H1
- Attention remains 22/22 and Adam remains 17/17 for genuinely numbered
  headings, with no other content headings

The guard estimates ordinary body height from wide prose when a page contains
many tiny chart labels. A generic enlarged-font heading must also be followed
by a normal text line. The numbered-heading path remains independent. A bounded
first-page title scan preserves centered title-case titles that appear after a
short attribution preamble.

The live tests now pin every content heading in both papers, not only the
numbered subset, so a new chart or diagram false heading fails the test.
The compatibility repair preserves the exact first-page structural title
`CONTENTS`; it does not reopen generic chart-label promotion.

## Verification

- Exact implementation commit reviewed: `b74d110f2faad440c24915bb4f62546d6b5221da`
- Independent result: ACCEPT with the real hash-locked Attention and Adam
  sources, the full Shannon replay, focused checks, schema/archive checks, and
  source/share byte identity
- Focused comparison check: 12/12 passed when rerun alone; the earlier
  full-suite metadata mismatch did not reproduce
- Refreshed extraction-layout oracle checks: 21 passed, 6 skipped
- Follow-up exact implementation commit:
  `fbf5db638360f2e511950ef03e5b6332a39ee972`
- Follow-up focused checks: 156 passed, 6 skipped; real-paper checks 2/2;
  reproducible share contract passed with 41 tools, 14 prompts, and 112 SBOM
  components
- Follow-up Shannon report SHA-256:
  `3c067c231ac77f4a5d0c7cfae6d3d8b55c880cc5f217d6d6bba8d3a1ac3fb1ec`;
  all three Markdown runs remain byte-identical at the previously recorded
  SHA-256 and all sampled quality scores remain unchanged
- Chart-guard focused checks: 157 passed, 6 skipped; real-paper checks 2/2;
  reproducible share contract passed with SHA-256
  `30b320f8cca0b2a95a06671c75bc37961b3bb6f2cae408b88b763dc714b96e13`
- Final focused bank after the contents-title repair: 166 passed, 6 skipped;
  the aggregate suite passed 1,998 checks and exposed one real contents-title
  regression plus three resource-load timeouts. After the repair, the exact
  heading/baseline bank passed 77/77, the worker file 13/13, and the malformed
  campaign 114/114 in isolated runs.
- Chart-guard Shannon report SHA-256:
  `6cf36e04778c9baf04f309c08954c1910434f2a0588b91f57fc93804a26f8171`;
  all three 55-page Markdown outputs remain byte-identical at SHA-256
  `2c4773511afe32d99ef44311406dbfeac42f4b3923696ef0fc59da56088eabe9`

No public release or Kepano reply is authorized by this evidence alone.
