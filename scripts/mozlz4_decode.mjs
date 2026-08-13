// Decode a Mozilla .jsonlz4 file (mozLz4: 8-byte magic + one LZ4 block).
// Usage: node scripts/mozlz4_decode.mjs <file>
// Useful for inspecting Zen's zen-live-folders.jsonlz4 to verify the RSS Sync engine.
import { readFileSync } from "node:fs";

function decodeLz4Block(input, offset, output) {
  let ip = offset;
  let op = 0;
  const srcEnd = input.length;

  while (ip < srcEnd) {
    const token = input[ip++];
    // Literals
    let litLen = token >> 4;
    if (litLen === 15) {
      let b;
      do {
        b = input[ip++];
        litLen += b;
      } while (b === 255);
    }
    for (let i = 0; i < litLen; i++) {
      output[op++] = input[ip++];
    }
    if (ip >= srcEnd) {
      break; // end of block after literals
    }
    // Match
    const offset16 = input[ip] | (input[ip + 1] << 8);
    ip += 2;
    if (offset16 === 0) {
      throw new Error("Invalid LZ4 block: zero offset");
    }
    let matchLen = (token & 0xf) + 4;
    if ((token & 0xf) === 15) {
      let b;
      do {
        b = input[ip++];
        matchLen += b;
      } while (b === 255);
    }
    const matchPos = op - offset16;
    for (let i = 0; i < matchLen; i++) {
      output[op++] = output[matchPos + i];
    }
  }
  return op;
}

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/mozlz4_decode.mjs <file.jsonlz4>");
  process.exit(1);
}

const data = readFileSync(file);
const magic = data.subarray(0, 8).toString("latin1");
// Standard Firefox writes "mozLz4\0"; Zen writes "mozLz40\0". Either way the
// payload starts at byte 8.
if (!magic.startsWith("mozLz4")) {
  console.error(`Not a mozLz4 file (magic: ${JSON.stringify(magic)})`);
  process.exit(1);
}

const out = Buffer.alloc(data.length * 4);
const size = decodeLz4Block(data, 8, out);
process.stdout.write(out.subarray(0, size));
process.stdout.write("\n");
