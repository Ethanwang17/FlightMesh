import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDestinationTables, type ParsedRow } from "./parse";

const fixture = (name: string) =>
  parseDestinationTables(
    readFileSync(join(__dirname, "../../test/fixtures", `${name}.html`), "utf8"),
  );
const row = (rows: ParsedRow[], airline: string) => rows.find((r) => r.airlineTitle === airline);
const ref = (n: number) => `<sup class="reference"><a href="#cite_note-${n}">[${n}]</a></sup>`;
const table = (body: string, heading = "") =>
  `${heading}<table class="wikitable"><tr><th>Airlines</th><th>Destinations</th><th>Refs</th></tr>${body}</table>`;

describe("parseDestinationTables: edge cases", () => {
  it("tracks Seasonal: and charter markers through a cell", () => {
    const [r] = parseDestinationTables(
      table(`<tr><td><a href="/wiki/Example_Air">Example Air</a></td><td>
        <a href="/wiki/A_Airport">A</a>,${ref(1)} <a href="/wiki/B_Airport">B</a><br/>
        <b>Seasonal:</b> <a href="/wiki/C_Airport">C</a><br/>
        <b>Seasonal charter:</b> <a href="/wiki/D_Airport">D</a></td><td></td></tr>`),
    );
    expect(r?.destinations.map((d) => [d.title, d.seasonal, d.charter])).toEqual([
      ["A Airport", false, false],
      ["B Airport", false, false],
      ["C Airport", true, false],
      ["D Airport", true, true],
    ]);
  });

  it("recognises markers written as plain text", () => {
    const [r] = parseDestinationTables(
      table(
        `<tr><td><a href="/wiki/X">X</a></td><td><a href="/wiki/A">A</a> Seasonal: <a href="/wiki/B">B</a></td></tr>`,
      ),
    );
    expect(r?.destinations.map((d) => d.seasonal)).toEqual([false, true]);
  });

  it("attaches parenthesised notes to the preceding destination, across footnotes", () => {
    const [r] = parseDestinationTables(
      table(`<tr><td><a href="/wiki/X">X</a></td><td>
        <a href="/wiki/A">A</a> (begins 29 March 2027),${ref(1)}
        <a href="/wiki/B">B</a> (resumes June 1, 2027)${ref(2)}, <a href="/wiki/C">C</a> (ends November 30, 2026), <a href="/wiki/D">D</a></td></tr>`),
    );
    expect(r?.destinations.map((d) => d.note)).toEqual([
      "begins 29 March 2027",
      "resumes June 1, 2027",
      "ends November 30, 2026",
      "",
    ]);
  });

  it("keeps links inside parentheses as part of the note, not as destinations", () => {
    const [r] = parseDestinationTables(
      table(`<tr><td><a href="/wiki/X">X</a></td><td>
        <a href="/wiki/Dubai_International_Airport">Dubai</a> (via <a href="/wiki/Muscat_International_Airport">Muscat</a>),
        <a href="/wiki/B">B</a> (suspended)</td></tr>`),
    );
    expect(r?.destinations.map((d) => [d.title, d.note])).toEqual([
      ["Dubai International Airport", "via Muscat"],
      ["B", "suspended"],
    ]);
  });

  it("treats Year-round: as resetting the mode", () => {
    const [r] = parseDestinationTables(
      table(
        `<tr><td><a href="/wiki/X">X</a></td><td><b>Seasonal:</b> <a href="/wiki/A">A</a><br/><b>Year-round:</b> <a href="/wiki/B">B</a></td></tr>`,
      ),
    );
    expect(r?.destinations.map((d) => d.mode)).toEqual(["seasonal", "scheduled"]);
  });

  it("skips tables under historical headings at any level", () => {
    const rows = parseDestinationTables(
      "<h2>Former airlines and destinations</h2><h3>Passenger</h3>" +
        table(`<tr><td><a href="/wiki/Old">Old</a></td><td><a href="/wiki/A">A</a></td></tr>`) +
        "<h2>Airlines and destinations</h2><h3>Passenger</h3>" +
        table(`<tr><td><a href="/wiki/New">New</a></td><td><a href="/wiki/A">A</a></td></tr>`),
    );
    expect(rows.map((r) => r.airlineTitle)).toEqual(["New"]);
  });

  it("skips red links, footnote links and non-article namespaces", () => {
    const [r] = parseDestinationTables(
      table(`<tr><td><a href="/wiki/X">X</a></td><td>
        <a href="/w/index.php?title=Nowhere&amp;action=edit&amp;redlink=1">Nowhere</a>
        <a href="/wiki/File:Plane.png">img</a> <a href="#cite_note-1">[1]</a> <a href="/wiki/Real_Airport">Real</a></td></tr>`),
    );
    expect(r?.destinations.map((d) => d.title)).toEqual(["Real Airport"]);
  });

  it("ignores tables under cargo headings and tables without airline/destination columns", () => {
    const rows = parseDestinationTables(
      table(
        `<tr><td><a href="/wiki/P">P</a></td><td><a href="/wiki/A">A</a></td></tr>`,
        "<h3>Passenger</h3>",
      ) +
        table(
          `<tr><td><a href="/wiki/C">C</a></td><td><a href="/wiki/B">B</a></td></tr>`,
          "<h3>Cargo</h3>",
        ) +
        `<h3>Statistics</h3><table class="wikitable"><tr><th>Rank</th><th>City</th></tr><tr><td>1</td><td><a href="/wiki/Z">Z</a></td></tr></table>`,
    );
    expect(rows.map((r) => r.airlineTitle)).toEqual(["P"]);
  });

  it("handles airline names in <th> cells and missing airline links", () => {
    const rows = parseDestinationTables(
      table(`<tr><th scope="row">Fly Oya</th><td><a href="/wiki/A">A</a></td></tr>`),
    );
    expect(rows).toEqual([
      {
        airlineTitle: null,
        airlineText: "Fly Oya",
        destinations: [expect.objectContaining({ title: "A" })],
      },
    ]);
  });
});

describe("parseDestinationTables: real Wikipedia sections", () => {
  it("SEA: counts, seasonal split and dated notes", () => {
    const rows = fixture("sea");
    const all = rows.flatMap((r) => r.destinations);
    expect(rows).toHaveLength(40);
    expect(all).toHaveLength(267);
    expect(all.filter((d) => d.seasonal)).toHaveLength(33);
    expect(all.filter((d) => /begins|resumes|ends/.test(d.note))).toHaveLength(14);

    const aeromexico = row(rows, "Aeroméxico")!;
    expect(aeromexico.destinations.map((d) => [d.title, d.seasonal])).toEqual([
      ["Mexico City International Airport", false],
      ["Guadalajara International Airport", true],
    ]);

    const charlotte = row(rows, "Alaska Airlines")!.destinations.find(
      (d) => d.text === "Charlotte",
    );
    expect(charlotte?.note).toBe("begins June 10, 2027");
  });

  it("SEA: keeps redirect titles as linked so they can be resolved later", () => {
    const ac = row(fixture("sea"), "Air Canada")!;
    expect(ac.destinations.map((d) => d.title)).toContain("Toronto–Pearson");
  });

  it("BZN: mostly seasonal small airport", () => {
    const rows = fixture("bzn");
    const all = rows.flatMap((r) => r.destinations);
    expect(rows).toHaveLength(11);
    expect(all).toHaveLength(45);
    expect(all.filter((d) => d.seasonal)).toHaveLength(28);
    const jfk = row(rows, "American Airlines")!.destinations.find(
      (d) => d.title === "John F. Kennedy International Airport",
    );
    expect(jfk).toMatchObject({ seasonal: true, note: "begins June 18, 2027" });
  });

  it("HNL: parses all rows", () => {
    const rows = fixture("hnl");
    expect(rows).toHaveLength(18);
    expect(rows.flatMap((r) => r.destinations)).toHaveLength(95);
  });

  it("AMS: large hub with one charter destination", () => {
    const rows = fixture("ams");
    const all = rows.flatMap((r) => r.destinations);
    expect(rows).toHaveLength(79);
    expect(all).toHaveLength(474);
    expect(all.filter((d) => d.charter).map((d) => d.title)).toEqual(["Antalya Airport"]);
    expect(row(rows, "KLM")?.destinations[0]?.title).toBe("Aalborg Airport");
  });
});
