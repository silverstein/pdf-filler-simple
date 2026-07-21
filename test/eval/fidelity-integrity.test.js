import { describe, expect, it } from "vitest";
import {
  FIDELITY_INTEGRITY_DOMAINS,
  canonicalJson,
  digestCanonical,
  digestCell,
  digestReport,
  digestRunIndex,
  digestScore,
  verifyCanonicalJsonBytes,
} from "./fidelity-integrity.js";

describe("fidelity canonical JSON", () => {
  it("canonicalizes JSON primitives and normalizes negative zero", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson("line\n\"quoted\"")).toBe('"line\\n\\"quoted\\""');
    expect(canonicalJson(42.5)).toBe("42.5");
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson(1e21)).toBe("1e+21");
  });

  it("sorts object keys recursively and preserves array order", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 }, list: [{ d: 4, c: 5 }, 6] }))
      .toBe('{"a":{"b":3,"y":2},"list":[{"c":5,"d":4},6],"z":1}');
    expect(canonicalJson(["second", "first"])).toBe('["second","first"]');
  });

  it("sorts non-ASCII keys by JavaScript UTF-16 code units", () => {
    expect(canonicalJson({ "\ud83d\ude00": 3, "\ufffd": 2, "a": 1 }))
      .toBe('{"a":1,"😀":3,"�":2}');
  });

  it("accepts null-prototype records with the same canonical identity", () => {
    const nullPrototype = Object.create(null);
    nullPrototype.z = 2;
    nullPrototype.a = 1;
    expect(canonicalJson(nullPrototype)).toBe(canonicalJson({ a: 1, z: 2 }));
  });

  it("is invariant to object insertion order but not array order", () => {
    const first = { alpha: 1, nested: { beta: 2, gamma: 3 } };
    const second = { nested: { gamma: 3, beta: 2 }, alpha: 1 };
    expect(digestCanonical("report", first)).toBe(digestCanonical("report", second));
    expect(digestCanonical("report", [1, 2])).not.toBe(digestCanonical("report", [2, 1]));
  });

  it.each([
    ["undefined", undefined],
    ["function", () => {}],
    ["symbol", Symbol("value")],
    ["bigint", 1n],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ])("rejects unsupported %s values", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(/Cannot canonicalize/);
    expect(() => canonicalJson({ value })).toThrow(/Cannot canonicalize/);
    expect(() => canonicalJson([value])).toThrow(/Cannot canonicalize/);
  });

  it("rejects sparse and customized arrays", () => {
    const sparse = [];
    sparse.length = 2;
    sparse[1] = "present";
    expect(() => canonicalJson(sparse)).toThrow(/sparse arrays/);

    const customized = [1];
    customized.extra = true;
    expect(() => canonicalJson(customized)).toThrow(/custom properties/);

    const customPrototype = [1];
    Object.setPrototypeOf(customPrototype, Object.create(Array.prototype));
    expect(() => canonicalJson(customPrototype)).toThrow(/Array\.prototype/);
  });

  it("rejects non-plain objects and unsafe property descriptors", () => {
    class Candidate { constructor() { this.value = 1; } }
    for (const value of [new Date(0), new Map(), new Set(), new Uint8Array([1]), new Candidate()]) {
      expect(() => canonicalJson(value)).toThrow(/Object\.prototype or a null prototype/);
    }

    let getterCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, "value", { enumerable: true, get: () => { getterCalls += 1; return 1; } });
    expect(() => canonicalJson(accessor)).toThrow(/accessor properties/);
    expect(getterCalls).toBe(0);

    const hidden = {};
    Object.defineProperty(hidden, "value", { enumerable: false, value: 1 });
    expect(() => canonicalJson(hidden)).toThrow(/non-enumerable properties/);

    const symbolKey = { visible: true };
    symbolKey[Symbol("hidden")] = 1;
    expect(() => canonicalJson(symbolKey)).toThrow(/symbol keys/);
  });

  it("rejects cycles while permitting repeated acyclic references", () => {
    const cyclicObject = {};
    cyclicObject.self = cyclicObject;
    expect(() => canonicalJson(cyclicObject)).toThrow(/cyclic references/);

    const cyclicArray = [];
    cyclicArray.push(cyclicArray);
    expect(() => canonicalJson(cyclicArray)).toThrow(/cyclic references/);

    const shared = { value: 1 };
    expect(canonicalJson({ left: shared, right: shared }))
      .toBe('{"left":{"value":1},"right":{"value":1}}');
  });
});

describe("fidelity domain-separated digests", () => {
  it("supports only the declared integrity domains", () => {
    expect(FIDELITY_INTEGRITY_DOMAINS).toEqual([
      "manifest", "case", "tool-arguments", "cell", "report", "score", "run-index",
    ]);
    const digests = FIDELITY_INTEGRITY_DOMAINS.map(domain => digestCanonical(domain, { same: true }));
    expect(new Set(digests).size).toBe(FIDELITY_INTEGRITY_DOMAINS.length);
    expect(digests.every(value => /^[a-f0-9]{64}$/.test(value))).toBe(true);
    expect(() => digestCanonical("unknown", { same: true })).toThrow(/Unsupported fidelity integrity domain/);
  });

  it("matches a fixed digest vector", () => {
    expect(digestCanonical("case", { z: [3, 2, 1], a: "PDF Tools" }))
      .toBe("ffc7c4b7643845050ef38e03937840d17529128f3719b86ba73e71c317727ced");
  });

  it("omits only each record's own digest field", () => {
    const cases = [
      [digestCell, "cell_content_sha256"],
      [digestReport, "report_content_sha256"],
      [digestScore, "score_content_sha256"],
      [digestRunIndex, "run_sha256"],
    ];
    for (const [digestRecord, field] of cases) {
      const original = { z: 2, a: 1, [field]: "0".repeat(64) };
      const before = structuredClone(original);
      const first = digestRecord(original);
      original[field] = "f".repeat(64);
      expect(digestRecord(original)).toBe(first);
      original.a = 9;
      expect(digestRecord(original)).not.toBe(first);
      expect(before[field]).toBe("0".repeat(64));
    }
  });

  it("keeps nested fields with digest-like names inside the record identity", () => {
    const cell = {
      case_id: "case.one",
      nested: { cell_content_sha256: "0".repeat(64) },
      cell_content_sha256: "f".repeat(64),
    };
    const snapshot = structuredClone(cell);
    const first = digestCell(cell);
    cell.nested.cell_content_sha256 = "1".repeat(64);
    expect(digestCell(cell)).not.toBe(first);
    expect(snapshot.cell_content_sha256).toBe("f".repeat(64));
  });

  it.each([
    ["cell", digestCell],
    ["report", digestReport],
    ["score", digestScore],
    ["run index", digestRunIndex],
  ])("requires the %s record to be an object", (_label, digestRecord) => {
    expect(() => digestRecord(null)).toThrow(/must be an object/);
    expect(() => digestRecord([])).toThrow(/must be an object/);
  });
});

describe("canonical persisted JSON", () => {
  const canonicalDocument = Buffer.from(`{\n  "a": {\n    "c": 3,\n    "d": 4\n  },\n  "list": [\n    2,\n    1\n  ],\n  "z": true\n}\n`);

  it("accepts canonical Buffer and Uint8Array input and returns parsed content", () => {
    expect(verifyCanonicalJsonBytes(canonicalDocument)).toEqual({ a: { c: 3, d: 4 }, list: [2, 1], z: true });
    const view = new Uint8Array(canonicalDocument.buffer, canonicalDocument.byteOffset, canonicalDocument.byteLength);
    expect(verifyCanonicalJsonBytes(view)).toEqual({ a: { c: 3, d: 4 }, list: [2, 1], z: true });
  });

  it.each([
    ["unsorted keys", Buffer.from('{\n  "z": 1,\n  "a": 2\n}\n')],
    ["compact encoding", Buffer.from('{"a":2,"z":1}')],
    ["missing trailing newline", Buffer.from('{\n  "a": 1\n}')],
    ["extra trailing newline", Buffer.from('{\n  "a": 1\n}\n\n')],
    ["CRLF", Buffer.from('{\r\n  "a": 1\r\n}\r\n')],
    ["duplicate key", Buffer.from('{\n  "a": 1,\n  "a": 2\n}\n')],
    ["byte-order mark", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{\n  "a": 1\n}\n')])],
  ])("rejects %s", (_label, bytes) => {
    expect(() => verifyCanonicalJsonBytes(bytes)).toThrow(/Canonical JSON/);
  });

  it("rejects invalid UTF-8 and invalid JSON", () => {
    expect(() => verifyCanonicalJsonBytes(Buffer.from([0xc3, 0x28]))).toThrow(/valid UTF-8/);
    expect(() => verifyCanonicalJsonBytes(Buffer.from("not json\n"))).toThrow(/valid JSON/);
  });

  it("requires byte-oriented input", () => {
    expect(() => verifyCanonicalJsonBytes('{\n  "a": 1\n}\n')).toThrow(/Buffer or Uint8Array/);
  });
});
