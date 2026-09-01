function duplicateKeyError(label, key) {
  return new Error(`${label} contains duplicate object key ${JSON.stringify(key)}`);
}

function scanJsonStructure(text, label) {
  let index = 0;

  function skipWhitespace() {
    while (/[\t\n\r ]/.test(text[index] ?? "")) index += 1;
  }

  function scanString() {
    const start = index;
    if (text[index] !== "\"") throw new Error(`${label} is not valid JSON`);
    index += 1;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      if (text[index] === "\"") {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      index += 1;
    }
    throw new Error(`${label} is not valid JSON`);
  }

  function scanArray() {
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return;
    }
    while (index < text.length) {
      scanValue();
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      if (text[index] !== ",") throw new Error(`${label} is not valid JSON`);
      index += 1;
      skipWhitespace();
    }
    throw new Error(`${label} is not valid JSON`);
  }

  function scanObject() {
    index += 1;
    const keys = new Set();
    skipWhitespace();
    if (text[index] === "}") {
      index += 1;
      return;
    }
    while (index < text.length) {
      const key = scanString();
      if (keys.has(key)) throw duplicateKeyError(label, key);
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ":") throw new Error(`${label} is not valid JSON`);
      index += 1;
      scanValue();
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      if (text[index] !== ",") throw new Error(`${label} is not valid JSON`);
      index += 1;
      skipWhitespace();
    }
    throw new Error(`${label} is not valid JSON`);
  }

  function scanPrimitive() {
    const match = text.slice(index).match(
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/,
    );
    if (!match) throw new Error(`${label} is not valid JSON`);
    index += match[0].length;
  }

  function scanValue() {
    skipWhitespace();
    if (text[index] === "{") scanObject();
    else if (text[index] === "[") scanArray();
    else if (text[index] === "\"") scanString();
    else scanPrimitive();
  }

  scanValue();
  skipWhitespace();
  if (index !== text.length) throw new Error(`${label} is not valid JSON`);
}

export function parseStrictJson(value, label = "JSON") {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  scanJsonStructure(text, label);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}
