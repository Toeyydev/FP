import { describe, expect, it } from "vitest";
import { ticketsFromRate } from "./rate-kind";

describe("ticketsFromRate", () => {
  it("maps only explicit ticket inclusion and exclusion", () => {
    for (const title of ["Tour with all entrance tickets", "Entrance tickets included", "Including entrance tickets"]) expect(ticketsFromRate(title)).toBe("included");
    for (const title of ["Tour without tickets", "No tickets included", "Tickets not included"]) expect(ticketsFromRate(title)).toBe("not");
  });

  it("never guesses from generic or missing titles", () => {
    for (const title of ["Standard rate", "Bangkok Grand Palace Wat Pho and Wat Arun Guided Tour", "", null, undefined]) expect(ticketsFromRate(title)).toBe("");
  });
});
