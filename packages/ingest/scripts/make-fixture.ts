// Turn a cached Wikipedia section response into a small test fixture (headings + route tables).
// Usage: npx tsx scripts/make-fixture.ts ../../data/cache/wikipedia/SEA.section-12.json test/fixtures/sea.html
import * as cheerio from "cheerio";
import { readFileSync, writeFileSync } from "node:fs";

const [src, out] = process.argv.slice(2);
if (!src || !out) throw new Error("usage: make-fixture.ts <cached-section.json> <out.html>");

const body = JSON.parse(readFileSync(src, "utf8")).parse as { title: string; text: string };
const $ = cheerio.load(body.text);
const parts = $("h2, h3, h4, table.wikitable")
  .toArray()
  .map((el) => $.html(el));
const date = new Date().toISOString().slice(0, 10);
writeFileSync(
  out,
  `<!-- ${body.title}: passenger destinations section, retrieved ${date}. Headings and tables only. -->\n${parts.join("\n")}\n`,
);
console.log(`${out}: ${readFileSync(out).length} bytes`);
