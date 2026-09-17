import { describe, it, expect } from "vitest";
import { withApplicationName, DB_APPLICATION_NAME } from "./build";

describe("database connections name the build", () => {
  it("adds application_name, keeping every other part of the URL", () => {
    const out = withApplicationName("postgresql://u:p%40ss@db.internal:5432/app?schema=public&connection_limit=5")!;
    const u = new URL(out);
    expect(u.searchParams.get("application_name")).toBe(DB_APPLICATION_NAME);
    expect(u.searchParams.get("schema")).toBe("public");
    expect(u.searchParams.get("connection_limit")).toBe("5");
    expect(u.password).toBe("p%40ss");
    expect(u.host).toBe("db.internal:5432");
  });
  it("leaves a URL that already names itself alone", () => {
    expect(withApplicationName("postgresql://u@h/db?application_name=ops-tool")).toBe("postgresql://u@h/db?application_name=ops-tool");
  });
  it("leaves a missing or unreadable URL as it was", () => {
    expect(withApplicationName(undefined)).toBeUndefined();
    expect(withApplicationName("not a url")).toBe("not a url");
  });
});
