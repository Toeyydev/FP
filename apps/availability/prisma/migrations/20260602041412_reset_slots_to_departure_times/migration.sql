-- Availability slots changed from 10 hourly blocks to 8 departure-time slots.
-- Existing rows are length-10 and slot-index-misaligned; clear them so guides re-mark.
DELETE FROM "Assignment";
DELETE FROM "Availability";
