import { describe, it, expect } from "vitest";
import { jobFolderPath } from "@/lib/advance-slip";

describe("where an advance slip is filed", () => {
  it("in the job's own folder, by the tour's month, when it belongs to a job", () => {
    expect(jobFolderPath({ ref: "FOLK-BKK-20991106-01", date: "2099-11-06" })).toEqual(["Folkpaths Job Sheets", "2099", "11 November", "FOLK-BKK-20991106-01"]);
  });
  it("in the month's Advances folder when there is no job ref", () => {
    expect(jobFolderPath({ ref: null, date: "2099-11-06" })).toBeNull();
    expect(jobFolderPath(null)).toBeNull();
  });
});
