// Writes the Mantine theme variables to a stylesheet so the client never
// injects them at runtime (the CSP blocks <style> elements). Run before Vite
// in build and dev. The output is generated, not committed.
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderThemeCss } from "../src/client/theme.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "src", "client", "theme.generated.css");

writeFileSync(target, renderThemeCss());
console.log("[theme] wrote src/client/theme.generated.css");
