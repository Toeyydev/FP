-- People who added the LINE Official Account but aren't linked to a guide yet.
-- Lets an operator match a follower -> guide in one click (hybrid follower-match)
-- instead of the guide sending a code. Purely additive; nothing else changes.
CREATE TABLE "LineContact" (
    "id" TEXT NOT NULL,
    "lineUserId" TEXT NOT NULL,
    "displayName" TEXT,
    "pictureUrl" TEXT,
    "linkedUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LineContact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LineContact_lineUserId_key" ON "LineContact"("lineUserId");

CREATE INDEX "LineContact_linkedUserId_idx" ON "LineContact"("linkedUserId");
