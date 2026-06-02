ALTER TABLE "User" ADD COLUMN "lineUserId" TEXT;
ALTER TABLE "User" ADD COLUMN "lineLinkCode" TEXT;
CREATE UNIQUE INDEX "User_lineUserId_key" ON "User"("lineUserId");
