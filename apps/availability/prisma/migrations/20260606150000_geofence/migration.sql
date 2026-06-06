-- Meeting-point coordinates (geofencing) + check-in distance
ALTER TABLE "Tour" ADD COLUMN "meetingLat" DOUBLE PRECISION;
ALTER TABLE "Tour" ADD COLUMN "meetingLng" DOUBLE PRECISION;
ALTER TABLE "Tour" ADD COLUMN "meetingRadiusM" INTEGER;
ALTER TABLE "Checkin" ADD COLUMN "distanceM" INTEGER;
ALTER TABLE "Checkin" ADD COLUMN "withinGeofence" BOOLEAN;
