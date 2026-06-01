-- AlterTable
ALTER TABLE "AccessRequest" ADD COLUMN     "nickname" TEXT,
ADD COLUMN     "passwordHash" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "fullName" TEXT;
