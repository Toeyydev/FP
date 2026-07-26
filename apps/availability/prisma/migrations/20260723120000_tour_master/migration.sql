-- Canonical tour catalogue ("TourMaster"), shared with the external Bokun→Master
-- writer (n8n Flow A). IF NOT EXISTS so it is safe whether the app or the external
-- flow creates it first — the app only reads these rows.
CREATE TABLE IF NOT EXISTS "tour_master" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tour_code" TEXT NOT NULL,
    "tour_name" TEXT NOT NULL,
    "tour_time" TIME(6) NOT NULL,
    "duration_minutes" INTEGER NOT NULL DEFAULT 180,
    "meeting_point_id" UUID,
    "guide_fee" DECIMAL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "tour_master_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tour_master_tour_code_key" ON "tour_master"("tour_code");

-- Link an internal tour to its master row. Nullable → tours with no link keep
-- showing their existing name (safe fallback while the master is being populated).
ALTER TABLE "Tour" ADD COLUMN "tourCode" TEXT;
