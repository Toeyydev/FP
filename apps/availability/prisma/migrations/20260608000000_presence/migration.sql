-- Presence: track when a user was last active
ALTER TABLE "User" ADD COLUMN "lastSeenAt" TIMESTAMP(3);
