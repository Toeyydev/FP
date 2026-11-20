import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TicketBadge from "./TicketBadge";
import { ticketsFromRate } from "@/lib/rate-kind";

const html = (tickets: string | null | undefined) => renderToStaticMarkup(createElement(TicketBadge, { tickets }));

describe("TicketBadge", () => {
  it("shows ✓ Included for an included booking", () => {
    expect(html("included")).toContain("✓ Included");
    expect(html("included")).toContain("var(--green)");
  });
  it("shows ✕ Not included for a booking without tickets", () => {
    expect(html("not")).toContain("✕ Not included");
  });
  it("renders nothing when the status is not known (Option A)", () => {
    for (const t of ["", null, undefined, "maybe"]) expect(html(t)).toBe("");
  });
  it("Viator's all-tickets Rate, as it reaches Bókun, shows Included", () => {
    expect(html(ticketsFromRate("Tour with all entrance tickets"))).toContain("✓ Included");
    expect(html(ticketsFromRate("All Entrance Tickets Included"))).toContain("✓ Included");
    expect(html(ticketsFromRate("Standard rate"))).toBe("");
  });
});
