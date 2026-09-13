-- Reserve numbers independently of sheet writes. Existing references stay intact.
CREATE TABLE "JobRefCounter" (
  "date" TEXT NOT NULL PRIMARY KEY,
  "lastSeq" BIGINT NOT NULL
);
