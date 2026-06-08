-- Google Calendar OAuth connection + event ids on assignments
ALTER TABLE "Assignment" ADD COLUMN "googleEventId" TEXT;
ALTER TABLE "Assignment" ADD COLUMN "opsGoogleEventId" TEXT;

CREATE TABLE "GoogleCalendar" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL DEFAULT 'primary',
    "email" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GoogleCalendar_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GoogleCalendar_userId_key" ON "GoogleCalendar"("userId");
