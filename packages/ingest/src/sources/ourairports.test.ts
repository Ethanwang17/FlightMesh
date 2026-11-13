import { describe, expect, it } from "vitest";
import { selectAirports } from "./ourairports";

const HEADER =
  '"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","icao_code","iata_code","gps_code","local_code","home_link","wikipedia_link","keywords"';

const csv = [
  HEADER,
  '2513,"EHAM","large_airport","Amsterdam Airport Schiphol",52.308601,4.76389,-11,"EU","NL","NL-NH","Amsterdam","yes","EHAM","AMS","EHAM",,,"https://en.wikipedia.org/wiki/Amsterdam_Airport_Schiphol",',
  // Same IATA code, but no scheduled service: dropped.
  '334869,"MX-1202","small_airport","Las Americas Airport",25.59,-108.31,98,"NA","MX","MX-SIN","Guasave","no",,"AMS",,,,,',
  // Heliport with scheduled service: dropped.
  '1,"XHEL","heliport","Some Heliport",1,1,0,"EU","NL","NL-NH","X","yes",,"XHL",,,,,',
  // Encoded wiki title.
  '3875,"KSEA","large_airport","Seattle–Tacoma International Airport",47.447943,-122.310276,433,"NA","US","US-WA","Seattle","yes","KSEA","SEA","KSEA","SEA",,"https://en.wikipedia.org/wiki/Seattle%E2%80%93Tacoma_International_Airport",',
  // Duplicate IATA: the larger airport type wins.
  '9,"AAAA","small_airport","Small Dup",10,10,0,"EU","FR","FR-X","Dupville","yes",,"DUP",,,,,',
  '10,"BBBB","medium_airport","Medium Dup",11,11,0,"EU","FR","FR-X","Dupville","yes","BBBB","DUP",,,,,',
].join("\n");

describe("selectAirports", () => {
  const airports = selectAirports(csv);
  const byCode = Object.fromEntries(airports.map((a) => [a.iata, a]));

  it("keeps only scheduled, non-heliport airports with IATA codes", () => {
    expect(airports.map((a) => a.iata)).toEqual(["AMS", "DUP", "SEA"]);
  });

  it("keeps the scheduled Schiphol row for AMS", () => {
    expect(byCode.AMS?.name).toBe("Amsterdam Airport Schiphol");
    expect(byCode.AMS?.wikipediaTitle).toBe("Amsterdam Airport Schiphol");
  });

  it("decodes percent-encoded Wikipedia titles", () => {
    expect(byCode.SEA?.wikipediaTitle).toBe("Seattle–Tacoma International Airport");
  });

  it("prefers the larger airport when IATA codes collide", () => {
    expect(byCode.DUP?.name).toBe("Medium Dup");
  });
});
