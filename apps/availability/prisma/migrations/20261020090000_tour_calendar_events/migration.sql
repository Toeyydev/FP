-- Google Calendar invitations for guides (owner, 2026-10-20). Additive only: one optional
-- column on User and one new table. Nothing existing is read differently.

-- Where a guide receives calendar invitations; blank = their account email.
ALTER TABLE "User" ADD COLUMN "calendarEmail" TEXT;

-- One company calendar event per guide on a departure (lib/tour-calendar-sync).
CREATE TABLE "TourCalendarEvent" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "slotIdx" INTEGER NOT NULL,
    "tourId" TEXT NOT NULL,
    "googleEventId" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "attendeeGuideId" TEXT NOT NULL,
    "attendeeEmail" TEXT,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "contentHash" TEXT,
    "createdInGoogle" BOOLEAN NOT NULL DEFAULT false,
    "fallbackSentAt" TIMESTAMP(3),
    "fallbackEmail" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TourCalendarEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TourCalendarEvent_googleEventId_key" ON "TourCalendarEvent"("googleEventId");
CREATE UNIQUE INDEX "TourCalendarEvent_date_slotIdx_attendeeGuideId_key" ON "TourCalendarEvent"("date", "slotIdx", "attendeeGuideId");
CREATE INDEX "TourCalendarEvent_syncStatus_nextAttemptAt_idx" ON "TourCalendarEvent"("syncStatus", "nextAttemptAt");
