#!/usr/bin/env node
/**
 * Fail if any source file exceeds the line limit.
 * Usage: node scripts/check-max-lines.js [--max-lines=1000]
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_MAX = 1000;
const EXTENSIONS = new Set([".js", ".css", ".html"]);
const IGNORE_DIRS = new Set([".git", "node_modules", ".cursor"]);

function parseMaxLines() {
  const arg = process.argv.find((a) => a.startsWith("--max-lines="));
  if (!arg) return DEFAULT_MAX;
  const n = Number(arg.split("=")[1]);
  if (!Number.isInteger(n) || n < 1) {
    console.error("Invalid --max-lines value");
    process.exit(2);
  }
  return n;
}

function countLines(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).length;
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

const maxLines = parseMaxLines();
const violations = [];

for (const file of walk(ROOT)) {
  const lines = countLines(file);
  if (lines > maxLines) {
    violations.push({
      file: path.relative(ROOT, file),
      lines,
    });
  }
}

if (violations.length === 0) {
  console.log(`OK — all files are at or below ${maxLines} lines.`);
  process.exit(0);
}

console.error(`Found ${violations.length} file(s) over ${maxLines} lines:\n`);
for (const { file, lines } of violations.sort((a, b) => b.lines - a.lines)) {
  console.error(`  ${lines.toString().padStart(5)}  ${file}`);
}
console.error(`\nSplit large files or raise the limit with --max-lines=N.`);
process.exit(1);
