// ESLint only parses JavaScript, but the release audits are text scans over
// every tracked file: Markdown, JSON, lockfiles, dotfiles, and source. This
// processor turns each line into a `//` comment so ESLint can carry the text
// through its normal reporting pipeline, and the rules rebuild the original
// lines. It is deliberately lossless: one output line per input line, so
// reported line and column numbers match the file on disk.
const PREFIX = "// ";

export const textProcessor = {
  meta: {
    name: "game-cat-text",
    version: "1.0.0",
  },
  preprocess(text) {
    // The audits skip binary files: a NUL byte marks them, and text-derived
    // rules cannot say anything useful about their contents.
    if (text.includes("\u0000")) {
      return [""];
    }
    // A lone CR, U+2028, or U+2029 would end the comment and shift the lines
    // that follow. None of the audited patterns depends on those characters,
    // so replace them with a space to keep line numbers exact.
    const normalized = text.replace(/\r(?!\n)/g, " ").replace(/[\u2028\u2029]/g, " ");
    return [
      normalized
        .split("\n")
        .map((line) => `${PREFIX}${line}`)
        .join("\n"),
    ];
  },
  postprocess(messageLists) {
    return messageLists.flat();
  },
};

/**
 * Rebuilds the original file lines from the comment-wrapped text ESLint sees.
 * @param {string} text
 * @returns {string[]}
 */
export function originalLines(text) {
  return text
    .split("\n")
    .map((line) => (line.startsWith(PREFIX) ? line.slice(PREFIX.length) : line));
}
