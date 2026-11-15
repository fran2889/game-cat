/**
 * A small, read-only Valve KeyValues (VDF/ACF) reader.
 *
 * The parser intentionally implements only what Steam's local files use: quoted
 * or unquoted names and values, nested objects, `//` comments, `\` escapes, and
 * `#` macros (ignored, never followed). Values are always strings, so callers
 * convert numbers explicitly and never lose 64-bit precision.
 */
export type VdfValue = string | VdfObject;

export interface VdfObject {
  [key: string]: VdfValue;
}

export class VdfParseError extends Error {
  constructor(message: string, line: number) {
    super(`${message} at line ${line}`);
    this.name = "VdfParseError";
  }
}

class Parser {
  private position = 0;

  constructor(private readonly text: string) {}

  parse(): VdfObject {
    return this.parseObject(false);
  }

  private get line(): number {
    let line = 1;
    for (let index = 0; index < this.position && index < this.text.length; index += 1) {
      if (this.text[index] === "\n") {
        line += 1;
      }
    }
    return line;
  }

  private parseObject(braced: boolean): VdfObject {
    if (braced) {
      this.skipIgnorable();
      this.expect("{");
    }

    const result: VdfObject = {};
    while (true) {
      this.skipIgnorable();
      if (this.position >= this.text.length) {
        if (braced) {
          throw new VdfParseError("Unterminated object", this.line);
        }
        return result;
      }
      if (this.peek() === "}") {
        if (!braced) {
          throw new VdfParseError("Unexpected closing brace", this.line);
        }
        this.position += 1;
        return result;
      }
      if (this.peek() === "#") {
        this.skipLine();
        continue;
      }

      const key = this.readValue("key");
      this.skipIgnorable();
      let value: VdfValue;
      if (this.peek() === "{") {
        value = this.parseObject(true);
      } else {
        value = this.readValue("value");
        this.skipIgnorable();
        if (this.peek() === "[") {
          this.skipConditional();
        }
      }
      assignLastWins(result, key, value);
    }
  }

  private readValue(kind: "key" | "value"): string {
    this.skipIgnorable();
    if (this.position >= this.text.length) {
      throw new VdfParseError(`Missing ${kind}`, this.line);
    }
    if (this.peek() === '"') {
      return this.readQuoted();
    }
    if (this.peek() === "{" || this.peek() === "}") {
      throw new VdfParseError(`Unexpected brace while reading ${kind}`, this.line);
    }

    const start = this.position;
    while (this.position < this.text.length) {
      const character = this.text[this.position];
      if (
        character === undefined ||
        /\s/.test(character) ||
        character === "{" ||
        character === "}"
      ) {
        break;
      }
      this.position += 1;
    }
    if (start === this.position) {
      throw new VdfParseError(`Missing ${kind}`, this.line);
    }
    return this.text.slice(start, this.position);
  }

  private readQuoted(): string {
    this.expect('"');
    let value = "";
    while (this.position < this.text.length) {
      const character = this.text[this.position];
      if (character === '"') {
        this.position += 1;
        return value;
      }
      if (character === "\\") {
        const next = this.text[this.position + 1];
        this.position += 2;
        if (next === undefined) {
          throw new VdfParseError("Unterminated escape", this.line);
        }
        if (next === "n") {
          value += "\n";
        } else if (next === "t") {
          value += "\t";
        } else if (next === "\\" || next === '"') {
          value += next;
        } else {
          // Valve treats an unknown escape as a literal backslash. Steam paths
          // are the common case (`C:\Games` in a non-escaped hand-written file).
          value += `\\${next}`;
        }
        continue;
      }
      if (character !== undefined) {
        value += character;
      }
      this.position += 1;
    }
    throw new VdfParseError("Unterminated quoted string", this.line);
  }

  private skipConditional(): void {
    const closing = this.text.indexOf("]", this.position);
    if (closing < 0) {
      throw new VdfParseError("Unterminated conditional", this.line);
    }
    this.position = closing + 1;
  }

  private skipIgnorable(): void {
    while (this.position < this.text.length) {
      const character = this.text[this.position];
      if (character !== undefined && (/\s/.test(character) || character === "\uFEFF")) {
        this.position += 1;
        continue;
      }
      if (character === "/" && this.text[this.position + 1] === "/") {
        this.skipLine();
        continue;
      }
      break;
    }
  }

  private skipLine(): void {
    const newline = this.text.indexOf("\n", this.position);
    this.position = newline < 0 ? this.text.length : newline + 1;
  }

  private peek(): string | undefined {
    return this.text[this.position];
  }

  private expect(character: string): void {
    if (this.peek() !== character) {
      throw new VdfParseError(`Expected ${character}`, this.line);
    }
    this.position += 1;
  }
}

/**
 * Valve's `FindKey` returns the first node, but its parser reuses an existing
 * key for a later assignment. We keep the last assignment (documented, tested)
 * and treat casing as part of key identity for replacement.
 */
function assignLastWins(target: VdfObject, key: string, value: VdfValue): void {
  const lowered = key.toLowerCase();
  for (const existing of Object.keys(target)) {
    if (existing !== key && existing.toLowerCase() === lowered) {
      delete target[existing];
    }
  }
  target[key] = value;
}

export function parseVdf(text: string): VdfObject {
  return new Parser(text).parse();
}

/** Case-insensitive lookup; the document order is preserved for diagnostics. */
export function findVdfKey(node: VdfObject, key: string): string | undefined {
  const lowered = key.toLowerCase();
  let found: string | undefined;
  for (const candidate of Object.keys(node)) {
    if (candidate.toLowerCase() === lowered) {
      found = candidate;
    }
  }
  return found;
}

export function getVdf(node: VdfObject, key: string): VdfValue | undefined {
  const found = findVdfKey(node, key);
  return found === undefined ? undefined : node[found];
}

export function getVdfObject(node: VdfObject, key: string): VdfObject | undefined {
  const value = getVdf(node, key);
  return typeof value === "object" && value !== null ? value : undefined;
}

export function getVdfString(node: VdfObject, key: string): string | undefined {
  const value = getVdf(node, key);
  return typeof value === "string" ? value : undefined;
}

/** Parse a numeric VDF string without accepting exponent or partial values. */
export function getVdfNumber(node: VdfObject, key: string): number | null {
  const raw = getVdfString(node, key);
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}
