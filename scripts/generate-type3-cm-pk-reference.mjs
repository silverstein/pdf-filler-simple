#!/usr/bin/env node

/*
 * Generated Computer Modern PK ground truth for the Type-3 recovery mask lane.
 *
 * `scripts/generate-type3-cm-reference.mjs` pins the official CTAN *metrics*
 * and builds a labeled *outline* fixture. That fixture cannot key the mask
 * lane at all: `cm/ps-type3` is a set of cubic-Bézier outline programs, so
 * every one of its glyph programs takes the exact-operator lane. The bitmap
 * digests currently enrolled for the mask lane were instead read off one real
 * document's own rasters and reviewed by hand, which is sound evidence but is
 * evidence about that document.
 *
 * This script produces the other kind. It runs METAFONT over the pinned CTAN
 * `cm/mf.zip` sources at a pinned rasterisation setting, converts the result
 * with `gftopk`, decodes the PK bitmaps here, and keys each glyph with the
 * shipped mask-lane key. What comes out is not a reviewed sample of one
 * producer's output; it is the raster Knuth's own sources define at that
 * setting, and dvips-era producers pass those rasters into the PDF bit for
 * bit. The evidence class is therefore different from — and stronger than —
 * the reviewed-raster lane, and is qualified under its own string
 * (`ctan-cm-metafont-generated-pk-v1`) so the two can never be confused in a
 * report.
 *
 * WHAT IS PINNED, AND WHY IT IS THE THREE SCALARS RATHER THAN A MODE NAME
 *
 * A METAFONT rasterisation is decided by the resolution and by three device
 * parameters: `blacker`, `fillin`, `o_correction`. Real documents record
 * neither the mode name nor the parameters, so the settings below were located
 * by sweeping the 83 distinct parameter triples that `modes.mf` defines and
 * keeping the ones that reproduce real documents' rasters EXACTLY — never by a
 * similarity score. Two settings survive that test on the documents available
 * here, and both are pinned below.
 *
 * The pin is the four numbers, not the mode name. Mode names are entries in
 * `modes.mf`, which is a TeX Live component this repository does not pin and
 * whose contents change between releases; the numbers are what METAFONT
 * actually consumes. `equivalent_mode_name` below is recorded for readers, and
 * `assertModeNameIsNotTheEvidence` proves at generation time that it is only a
 * label: the same face generated from two different base modes with the same
 * four numbers has to decode to identical rasters or the run fails.
 *
 * MFINPUTS, not TEXINPUTS. METAFONT resolves `input cmr10` through MFINPUTS.
 * Pointing TEXINPUTS at the extracted archive instead leaves MFINPUTS at its
 * default, TeX Live's own bundled Computer Modern sources get used, and the
 * run silently produces digests that are not the pinned archive's.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type3MaskGridSha256 } from "../server/layout-extraction.js";
import { CM_CODEPOINTS } from "../server/type3-cm-reference.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The same pinned archive scripts/generate-type3-cm-reference.mjs verifies.
const MF_ARCHIVE_URL = "https://mirrors.ctan.org/fonts/cm/mf.zip";
const MF_ARCHIVE_SHA256 = "b22c69034d9f3f7a9bf22673544bdeaace5656973cf7fb1a395a857148943076";
const OUTPUT_MODULE = path.join(REPO_ROOT, "server/type3-cm-pk-reference.js");
const OUTPUT_SHARE_MODULE = path.join(REPO_ROOT, "pdf-toolkit-mcp-share/server/type3-cm-pk-reference.js");
const OUTPUT_PROVENANCE = path.join(REPO_ROOT, "test/fixtures/eval/extraction/type3-cm-pk-reference.provenance.json");

/*
 * Every rasterisation setting whose output has been shown to reproduce a real
 * document's Type-3 bitmaps exactly, under the shipped mask key, with no
 * tolerance anywhere. Adding a profile is a deliberate act: it widens the
 * reference, so it must be justified by an exact reproduction on a real
 * document rather than by a nearest-neighbour score.
 */
const PROFILES = Object.freeze([
  Object.freeze({
    id: "600-b25-f0-o1",
    resolution: 600,
    blacker: 0.25,
    fillin: 0,
    o_correction: 1,
    equivalent_mode_name: "ljfour",
    evidence: "Reproduces the Shannon reference document's Computer Modern rasters exactly.",
  }),
  Object.freeze({
    id: "300-b0-f20-o60",
    resolution: 300,
    blacker: 0,
    fillin: 0.2,
    o_correction: 0.6,
    equivalent_mode_name: "cx",
    evidence: "Reproduces astro-ph/9402001's Computer Modern rasters exactly.",
  }),
]);

/*
 * Base modes used only to prove the mode name is not part of the evidence.
 * They differ in every parameter that is not overridden below.
 */
const BASE_MODE = "ljfour";
const CONTROL_BASE_MODE = "cx";
const MODE_INDEPENDENCE_FACE = "cmmi10";

const FAMILY_BY_FACE = Object.freeze([
  Object.freeze([/^(?:cmmi|cmmib)\d+$/u, "computer-modern-math-italic"]),
  Object.freeze([/^(?:cmsy|cmbsy)\d+$/u, "computer-modern-math-symbol"]),
  Object.freeze([/^cmex\d+$/u, "computer-modern-math-extension"]),
]);

function encodingFamily(face) {
  for (const [pattern, family] of FAMILY_BY_FACE) if (pattern.test(face)) return family;
  return null;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function download(url, destination) {
  execFileSync("curl", ["-L", "--fail", "--silent", "--show-error", url, "-o", destination]);
}

function requireDigest(filename, expected) {
  const actual = sha256(fs.readFileSync(filename));
  if (actual !== expected) throw new Error(`${path.basename(filename)} SHA-256 ${actual} != ${expected}`);
}

function unzip(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  execFileSync("unzip", ["-q", archive, "-d", destination]);
}

/**
 * One METAFONT run. Returns the generic-font bytes, or null when the face
 * produced none. Every face in the pinned archive builds at both pinned
 * profiles today, so this path is a guard rather than an observed outcome; a
 * face that stopped building would be recorded in
 * `metafont.rasterisations_failed` rather than silently dropped, and the gate
 * asserts that array is empty.
 */
function runMetafont(mfRoot, face, profile, baseMode) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-tools-cm-mf-"));
  try {
    const command = `\\mode=${baseMode};`
      + ` mode_param(pixels_per_inch,${profile.resolution});`
      + ` mode_param(blacker,${profile.blacker});`
      + ` mode_param(fillin,${profile.fillin});`
      + ` mode_param(o_correction,${profile.o_correction});`
      + ` mag=1; batchmode; input ${face}`;
    try {
      execFileSync("mf", [command], {
        cwd: workspace,
        env: { ...process.env, MFINPUTS: `${mfRoot}:` },
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      // METAFONT exits non-zero on any error in batchmode. Whether it still
      // produced a usable generic font is decided by the directory listing.
    }
    const generic = fs.readdirSync(workspace).filter(name => new RegExp(`^${face}\\.\\d+gf$`, "u").test(name));
    if (generic.length !== 1) return null;
    return fs.readFileSync(path.join(workspace, generic[0]));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function genericFontToPk(genericBytes, face, profile) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-tools-cm-pk-"));
  try {
    const genericFile = path.join(workspace, `${face}.${profile.resolution}gf`);
    const pkFile = path.join(workspace, `${face}.${profile.resolution}pk`);
    fs.writeFileSync(genericFile, genericBytes);
    execFileSync("gftopk", [genericFile, pkFile], { stdio: ["ignore", "ignore", "ignore"] });
    return fs.readFileSync(pkFile);
  } catch {
    return null;
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

/**
 * Spec-faithful PK decoder (`pktype.web` / `pktopx` run-length scheme),
 * returning one row-major 1-bit grid per character. Written out here rather
 * than shelled out to `pktype` because the digest has to be taken from the
 * decoded samples in this process; the decoder was validated against `pktype`
 * during the investigation that located the settings above.
 */
function decodePk(buffer) {
  let cursor = 0;
  const u8 = () => buffer[cursor++];
  const u16 = () => { const value = buffer.readUInt16BE(cursor); cursor += 2; return value; };
  const u24 = () => { const value = (buffer[cursor] << 16) | (buffer[cursor + 1] << 8) | buffer[cursor + 2]; cursor += 3; return value; };
  const u32 = () => { const value = buffer.readUInt32BE(cursor); cursor += 4; return value; };
  const i8 = () => { const value = buffer.readInt8(cursor); cursor += 1; return value; };
  const i16 = () => { const value = buffer.readInt16BE(cursor); cursor += 2; return value; };
  const i32 = () => { const value = buffer.readInt32BE(cursor); cursor += 4; return value; };
  if (u8() !== 247 || u8() !== 89) throw new Error("Not a PK file");
  const commentLength = u8();
  cursor += commentLength;
  const designSize = u32();
  const checksum = u32();
  const horizontalPixelsPerPoint = u32();
  const verticalPixelsPerPoint = u32();
  const characters = new Map();
  let sawPostamble = false;
  while (cursor < buffer.length) {
    const flag = u8();
    if (flag === 245) { sawPostamble = true; break; }
    if (flag >= 240) {
      if (flag === 240) { cursor += u8(); continue; }
      if (flag === 241) { cursor += u16(); continue; }
      if (flag === 242) { cursor += u24(); continue; }
      if (flag === 243) { cursor += u32(); continue; }
      if (flag === 244) { cursor += 4; continue; }
      if (flag === 246) continue;
      throw new Error(`Unexpected PK command ${flag}`);
    }
    const dynamicF = flag >> 4;
    const firstBlack = (flag & 8) !== 0;
    const flagPosition = cursor - 1;
    let packetLength;
    let characterCode;
    let width;
    let height;
    let rasterEnd;
    if ((flag & 7) === 7) {
      packetLength = u32(); characterCode = u32(); u32(); i32(); i32();
      width = u32(); height = u32(); i32(); i32();
      rasterEnd = flagPosition + packetLength + 9;
    } else if ((flag & 4) === 4) {
      packetLength = ((flag & 3) << 16) | u16(); characterCode = u8(); u24(); u16();
      width = u16(); height = u16(); i16(); i16();
      rasterEnd = flagPosition + packetLength + 4;
    } else {
      packetLength = ((flag & 3) << 8) | u8(); characterCode = u8(); u24(); u8();
      width = u8(); height = u8(); i8(); i8();
      rasterEnd = flagPosition + packetLength + 3;
    }
    const rasterStart = cursor;
    const bits = new Uint8Array(width * height);
    if (width > 0 && height > 0) {
      if (dynamicF === 14) {
        let bitPosition = 0;
        for (let row = 0; row < height; row += 1) {
          for (let column = 0; column < width; column += 1) {
            const byte = buffer[rasterStart + (bitPosition >> 3)];
            bits[row * width + column] = (byte >> (7 - (bitPosition & 7))) & 1;
            bitPosition += 1;
          }
        }
      } else {
        let nybblePosition = 0;
        const nybble = () => {
          const byte = buffer[rasterStart + (nybblePosition >> 1)];
          const value = (nybblePosition & 1) ? (byte & 15) : (byte >> 4);
          nybblePosition += 1;
          return value;
        };
        let repeatCount = 0;
        const packedNumber = () => {
          const lead = nybble();
          if (lead === 0) {
            let digit;
            let length = 0;
            do { digit = nybble(); length += 1; } while (digit === 0);
            while (length > 0) { digit = digit * 16 + nybble(); length -= 1; }
            return digit - 15 + (13 - dynamicF) * 16 + dynamicF;
          }
          if (lead <= dynamicF) return lead;
          if (lead < 14) return (lead - dynamicF - 1) * 16 + nybble() + dynamicF + 1;
          repeatCount = (lead === 14) ? packedNumber() : 1;
          return packedNumber();
        };
        let rowsLeft = height;
        let remaining = width;
        let column = 0;
        let turnOn = firstBlack;
        let row = new Uint8Array(width);
        let guard = 0;
        while (rowsLeft > 0) {
          if ((guard += 1) > 4 * (width * height + 16)) throw new Error(`PK raster desync at character ${characterCode}`);
          if (nybblePosition > 2 * (rasterEnd - rasterStart) + 4) throw new Error(`PK nybble overrun at character ${characterCode}`);
          let count = packedNumber();
          while (count > 0 && rowsLeft > 0) {
            if (count < remaining) {
              if (turnOn) row.fill(1, column, column + count);
              column += count; remaining -= count; count = 0;
            } else {
              if (turnOn) row.fill(1, column, width);
              count -= remaining;
              const copies = repeatCount + 1;
              for (let copy = 0; copy < copies && rowsLeft > 0; copy += 1) {
                bits.set(row, (height - rowsLeft) * width);
                rowsLeft -= 1;
              }
              repeatCount = 0; row = new Uint8Array(width); column = 0; remaining = width;
            }
          }
          turnOn = !turnOn;
        }
      }
    }
    characters.set(characterCode, { characterCode, width, height, bits });
    cursor = rasterEnd;
  }
  /*
   * Structural proof that the walk stayed in step with the file. A single
   * mis-sized header silently reinterprets every later byte as a character
   * packet, and the result is a short table of plausible-looking rasters
   * rather than an error. GFtoPK ends every file with a `pk_post` command
   * followed only by `pk_no_op` padding, so requiring both is a cheap check
   * that the cursor arrived exactly where the writer left it.
   */
  if (!sawPostamble) throw new Error("PK file ended without a postamble");
  for (let index = cursor; index < buffer.length; index += 1) {
    if (buffer[index] !== 246) throw new Error("PK postamble padding is not intact");
  }
  return { designSize, checksum, horizontalPixelsPerPoint, verticalPixelsPerPoint, characters };
}

/**
 * True when every pixel of a decoded raster is set, i.e. the glyph is a
 * featureless filled rectangle.
 *
 * These exist in Computer Modern — the math minus, the vertical bar, the
 * fraction rules — and they are the one shape a digest cannot really vouch
 * for: two integers decide the whole raster, so any producer that happens to
 * draw a rule of the same pixel size produces the same digest. The reference
 * still enrols them, because inside a font that has already been pinned by its
 * TFM widths and corroborated by a shaped sibling they are correct. What is
 * recorded here is which ones they are, so the consumer can refuse to rest a
 * recovery on rectangles alone.
 */
function isSolidRectangle(glyph) {
  for (let index = 0; index < glyph.bits.length; index += 1) if (!glyph.bits[index]) return false;
  return true;
}

/**
 * True when an outer edge of the raster carries no ink.
 *
 * GFtoPK writes the glyph's ink box as the character's bounding box, so its
 * output never has one. Asserted rather than assumed because the mask key
 * canonicalises to the ink box: if GFtoPK ever padded a raster, the digest
 * taken here would still be the ink box's while `solid` above was computed
 * over the padded grid, and the two would disagree about the same glyph.
 */
function hasBlankBorder(glyph) {
  const { width, height, bits } = glyph;
  const rowBlank = row => {
    for (let column = 0; column < width; column += 1) if (bits[row * width + column]) return false;
    return true;
  };
  const columnBlank = column => {
    for (let row = 0; row < height; row += 1) if (bits[row * width + column]) return false;
    return true;
  };
  return rowBlank(0) || rowBlank(height - 1) || columnBlank(0) || columnBlank(width - 1);
}

/**
 * A face's whole raster content as one digest: every character's dimensions
 * and mask key, in character-code order.
 *
 * Deliberately not a digest of the GF or PK bytes. METAFONT stamps the run's
 * date and time into the generic font's preamble and GFtoPK carries it
 * through, so a byte digest of either is different on every run and would
 * make both the comparison below and this record irreproducible. The decoded
 * rasters are the thing the reference is actually built from and they carry
 * no clock.
 */
function faceRasterDigest(pk) {
  const lines = [...pk.characters.values()]
    .sort((left, right) => left.characterCode - right.characterCode)
    .map(glyph => `${glyph.characterCode}:${glyph.width}x${glyph.height}:`
      + `${glyph.width > 0 && glyph.height > 0 ? type3MaskGridSha256(glyph.width, glyph.height, glyph.bits) : "blank"}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * Proves the pin is the four numbers rather than the mode name they happen to
 * coincide with. If two unrelated base modes carrying the same four overrides
 * ever disagreed, the mode name would be silently part of the evidence and
 * this reference would be a `modes.mf` version dependency.
 */
function assertModeNameIsNotTheEvidence(mfRoot, profile) {
  const digests = [BASE_MODE, CONTROL_BASE_MODE].map(baseMode => {
    const generic = runMetafont(mfRoot, MODE_INDEPENDENCE_FACE, profile, baseMode);
    if (!generic) throw new Error(`Mode independence probe produced no generic font at ${profile.id}`);
    const pk = genericFontToPk(generic, MODE_INDEPENDENCE_FACE, profile);
    if (!pk) throw new Error(`Mode independence probe produced no PK font at ${profile.id}`);
    return faceRasterDigest(decodePk(pk));
  });
  if (digests[0] !== digests[1]) {
    throw new Error(
      `${MODE_INDEPENDENCE_FACE} differs between base modes ${BASE_MODE} and ${CONTROL_BASE_MODE}`
      + ` at ${profile.id}: the pinned scalars do not determine the raster`,
    );
  }
  return digests[0];
}

function toolVersion(command, argument) {
  try {
    const output = execFileSync(command, [argument], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return output.split("\n")[0].trim();
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.split("\n").find(line => line.trim().length > 0);
    if (!output) throw new Error(`Could not read the version of ${command}`);
    return output.trim();
  }
}

function generateModule(records, digestCount, faceCount, crossFamilyDigests, solidDigests) {
  const payload = JSON.stringify(records);
  return "// Generated by scripts/generate-type3-cm-pk-reference.mjs. Do not edit by hand.\n"
    + `// Official CTAN cm/mf.zip SHA-256: ${MF_ARCHIVE_SHA256}\n`
    + "//\n"
    + "// Each record is one Computer Modern face rasterised by METAFONT from the\n"
    + "// pinned CTAN sources at one pinned setting, keyed with the shipped Type-3\n"
    + "// mask-lane key.\n"
    + "//\n"
    + "// `codes` holds only officially enrolled slots of the face's family whose\n"
    + "// digest identifies exactly one slot OF THAT FAMILY across the whole\n"
    + "// reference. Within a family a digest therefore names one character.\n"
    + "//\n"
    + "// It does NOT name one character across families, and that is deliberate\n"
    + `// rather than an oversight: ${crossFamilyDigests} digests here stand at a slot in each of two\n`
    + "// families — the math-italic period at code 58 and the math-symbol centred\n"
    + "// dot at code 1 are the same square blob at several design sizes. Nothing\n"
    + "// disambiguates them by shape and nothing tries to. The matcher pins one\n"
    + "// family from the font's TFM width fingerprint before it looks at any\n"
    + "// raster, so only one family's slots are ever in play for a given font and\n"
    + "// the pair cannot be confused at match time. Collapsing them would throw\n"
    + "// away two correct recoveries to solve a problem the family pin already\n"
    + "// solves.\n"
    + "//\n"
    + "// `solid` lists the codes of the face whose raster is a featureless filled\n"
    + `// rectangle — every pixel of the ink box set. ${solidDigests} of the digests below are\n`
    + "// of that kind (Computer Modern's rules and bars), and they carry no shape\n"
    + "// information at all beyond two integers. The consumer in\n"
    + "// `server/layout-extraction.js` refuses to build an enrollment record whose\n"
    + "// own raster AND every corroborating witness are drawn from this list.\n\n"
    + `export const CM_PK_REFERENCE_VERSION = "ctan-cm-metafont-pk-${MF_ARCHIVE_SHA256.slice(0, 12)}";\n\n`
    + `export const CM_PK_REFERENCE_QUALIFICATION = "ctan-cm-metafont-generated-pk-v1";\n\n`
    + `export const CM_PK_REFERENCE_FACE_COUNT = ${faceCount};\n\n`
    + `export const CM_PK_REFERENCE_DIGEST_COUNT = ${digestCount};\n\n`
    + `export const CM_PK_REFERENCE_FACES = Object.freeze(${payload});\n`;
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-tools-type3-cm-pk-"));
try {
  const archive = path.join(temporaryRoot, "cm-mf.zip");
  download(MF_ARCHIVE_URL, archive);
  requireDigest(archive, MF_ARCHIVE_SHA256);
  const extracted = path.join(temporaryRoot, "mf");
  unzip(archive, extracted);
  const mfRoot = path.join(extracted, "mf");

  const faces = fs.readdirSync(mfRoot)
    .filter(name => /^cm.*\.mf$/u.test(name) && name !== "cmbase.mf")
    .map(name => name.replace(/\.mf$/u, ""))
    .sort();
  if (faces.length === 0) throw new Error("The pinned archive contains no Computer Modern face sources");

  const faceSources = Object.fromEntries(faces.map(face => [
    face,
    sha256(fs.readFileSync(path.join(mfRoot, `${face}.mf`))),
  ]));

  const modeIndependence = {};
  for (const profile of PROFILES) modeIndependence[profile.id] = assertModeNameIsNotTheEvidence(mfRoot, profile);

  // Pass one: rasterise everything and key every glyph of the three supported
  // families at its officially enrolled slots.
  const raw = [];
  const built = { faces: 0, attempted: 0, failed: [] };
  const rasters = { decoded: 0, blank_bordered: 0 };
  for (const profile of PROFILES) {
    for (const face of faces) {
      built.attempted += 1;
      process.stderr.write(`${profile.id} ${face}\n`);
      const generic = runMetafont(mfRoot, face, profile, BASE_MODE);
      if (!generic) { built.failed.push(`${face}@${profile.id}`); continue; }
      const pk = genericFontToPk(generic, face, profile);
      if (!pk) { built.failed.push(`${face}@${profile.id}`); continue; }
      built.faces += 1;
      const family = encodingFamily(face);
      if (!family) continue;
      const enrolled = CM_CODEPOINTS[family] ?? {};
      let decoded;
      try {
        decoded = decodePk(pk);
      } catch (error) {
        throw new Error(`PK decode failed for ${face} at ${profile.id}: ${error.message}`);
      }
      const codes = {};
      const solid = [];
      for (const glyph of decoded.characters.values()) {
        if (glyph.width <= 0 || glyph.height <= 0) continue;
        rasters.decoded += 1;
        if (hasBlankBorder(glyph)) {
          rasters.blank_bordered += 1;
          throw new Error(
            `${face}@${profile.id} character ${glyph.characterCode} has a blank border:`
            + " GFtoPK no longer writes the ink box and the solid-rectangle census would be wrong",
          );
        }
        if (enrolled[glyph.characterCode] === undefined) continue;
        const digest = type3MaskGridSha256(glyph.width, glyph.height, glyph.bits);
        if (digest === null) continue;
        codes[glyph.characterCode] = digest;
        if (isSolidRectangle(glyph)) solid.push(glyph.characterCode);
      }
      if (Object.keys(codes).length === 0) continue;
      raw.push({ face, family, profile: profile.id, resolution: profile.resolution, codes, solid });
    }
  }

  /*
   * Pass two: drop every digest that does not identify one slot.
   *
   * A digest that stands at two different codes of the same family is
   * ambiguous ground truth — a document carrying it could be either character
   * — so it is removed from both. Small Computer Modern shapes genuinely
   * collide this way across design sizes, and this is the only place the
   * collision can be seen, because at match time the runtime only ever sees
   * one font's worth of slots. Collisions ACROSS families are left alone: the
   * matcher pins a family from the TFM fingerprint before it looks at a shape
   * at all, and the shipped registry already carries one such pair (the math
   * italic period and the math symbol centred dot are the same blob).
   */
  const slotsByDigest = new Map();
  for (const record of raw) {
    for (const [code, digest] of Object.entries(record.codes)) {
      const key = `${record.family}:${digest}`;
      if (!slotsByDigest.has(key)) slotsByDigest.set(key, new Set());
      slotsByDigest.get(key).add(Number(code));
    }
  }
  const ambiguous = { digests: 0, slot_pairs: [] };
  for (const [key, codes] of slotsByDigest) {
    if (codes.size < 2) continue;
    ambiguous.digests += 1;
    const [family] = key.split(":");
    ambiguous.slot_pairs.push(`${family}:${[...codes].sort((left, right) => left - right).join("+")}`);
  }
  const records = [];
  let digestCount = 0;
  for (const record of raw) {
    const codes = {};
    for (const [code, digest] of Object.entries(record.codes)) {
      if (slotsByDigest.get(`${record.family}:${digest}`).size !== 1) continue;
      codes[code] = digest;
      digestCount += 1;
    }
    // Two surviving slots are the floor: a face carrying one is unusable,
    // because the matcher's two-independent-glyph rule can never be met from
    // it and enrolling it would only widen the table.
    if (Object.keys(codes).length < 2) continue;
    records.push({
      face: record.face,
      family: record.family,
      profile: record.profile,
      resolution: record.resolution,
      codes,
      solid: record.solid.filter(code => codes[code] !== undefined).sort((left, right) => left - right),
    });
  }
  records.sort((left, right) => (left.profile.localeCompare(right.profile))
    || left.family.localeCompare(right.family)
    || left.face.localeCompare(right.face));

  /*
   * Two censuses the emitted header states as fact, computed here so the
   * header cannot claim something the table does not contain.
   *
   * `crossFamilyDigests` is the number of distinct digests that stand at a
   * slot in more than one family. They are kept on purpose — see the header —
   * and an earlier revision of this file asserted the opposite.
   *
   * `solidDigests` is the number of distinct digests whose raster is a
   * featureless filled rectangle.
   */
  const familiesByDigest = new Map();
  const solidDigestSet = new Set();
  for (const record of records) {
    for (const [code, digest] of Object.entries(record.codes)) {
      if (!familiesByDigest.has(digest)) familiesByDigest.set(digest, new Set());
      familiesByDigest.get(digest).add(record.family);
      if (record.solid.includes(Number(code))) solidDigestSet.add(digest);
    }
  }
  const crossFamilyDigests = [...familiesByDigest.values()].filter(families => families.size > 1).length;
  const solidDigests = solidDigestSet.size;

  const module = generateModule(records, digestCount, records.length, crossFamilyDigests, solidDigests);
  fs.writeFileSync(OUTPUT_MODULE, module);
  fs.writeFileSync(OUTPUT_SHARE_MODULE, module);

  const provenance = {
    schema_version: 1,
    generated_by: "scripts/generate-type3-cm-pk-reference.mjs",
    sources: [{ url: MF_ARCHIVE_URL, sha256: MF_ARCHIVE_SHA256 }],
    generator: {
      metafont: toolVersion("mf", "--version"),
      gftopk: toolVersion("gftopk", "--version"),
    },
    qualification: "ctan-cm-metafont-generated-pk-v1",
    // The pin is these numbers. `equivalent_mode_name` names the modes.mf
    // entry that carries them today and is not itself evidence;
    // `mode_independence_face_raster_sha256` is the proof, one digest per
    // profile that two different base modes both produced. It covers the
    // probe face's decoded rasters rather than its file bytes, because
    // METAFONT stamps the run clock into the generic font and a byte digest
    // would differ on every run.
    profiles: PROFILES.map(profile => ({
      id: profile.id,
      resolution: profile.resolution,
      blacker: profile.blacker,
      fillin: profile.fillin,
      o_correction: profile.o_correction,
      equivalent_mode_name: profile.equivalent_mode_name,
      evidence: profile.evidence,
      mode_independence_probe_face: MODE_INDEPENDENCE_FACE,
      mode_independence_base_modes: [BASE_MODE, CONTROL_BASE_MODE],
      mode_independence_face_raster_sha256: modeIndependence[profile.id],
    })),
    metafont: {
      face_count: faces.length,
      rasterisation_attempts: built.attempted,
      rasterisations_completed: built.faces,
      rasterisations_failed: built.failed.sort(),
      // Every decoded PK character of every rasterised face, and how many of
      // them carry a blank outer edge. GFtoPK writes the ink box, so the
      // second number is zero and the generator aborts if it ever is not.
      // Recorded because the four GNU Ghostscript 6.52 corpus documents are
      // told apart from PK passthrough by exactly this property.
      decoded_pk_rasters: rasters.decoded,
      decoded_pk_rasters_with_blank_border: rasters.blank_bordered,
      face_source_sha256: faceSources,
    },
    reference: {
      enrolled_face_records: records.length,
      emitted_digest_count: digestCount,
      slot_ambiguous_digests_removed: ambiguous.digests,
      slot_ambiguous_slot_groups: [...new Set(ambiguous.slot_pairs)].sort(),
      // Kept on purpose: the family pin separates them. See the module header.
      cross_family_digests: crossFamilyDigests,
      // Featureless filled rectangles. `server/layout-extraction.js` refuses to
      // rest an enrollment record on these alone.
      solid_rectangle_digests: solidDigests,
    },
    outputs: {
      "server/type3-cm-pk-reference.js": sha256(fs.readFileSync(OUTPUT_MODULE)),
      "pdf-toolkit-mcp-share/server/type3-cm-pk-reference.js": sha256(fs.readFileSync(OUTPUT_SHARE_MODULE)),
    },
  };
  fs.writeFileSync(OUTPUT_PROVENANCE, `${JSON.stringify(provenance, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...provenance, metafont: { ...provenance.metafont, face_source_sha256: `${faces.length} faces` } }, null, 2)}\n`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
