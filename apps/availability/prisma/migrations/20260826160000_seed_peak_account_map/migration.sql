-- Seed Folkpaths' confirmed PEAK account mapping.
--
-- These codes were read from Folkpaths' own PEAK chart of accounts and confirmed
-- by the owner on 2026-08-26. They are NOT guessed and NOT derived from an
-- account name — each was quoted directly from PEAK's account picker, where all
-- three appear as selectable (postable) leaf accounts rather than parent headings:
--
--   510111  ค่าจ้างมัคคุเทศก์      -> GUIDE_FEE
--   510110  ค่ารีวิวลูกค้า          -> REVIEW_REWARD
--   510104  ต้นทุนการให้บริการ     -> ENTRANCE_TICKET, TRANSPORTATION, MEAL_REFRESHMENT
--
-- Three categories deliberately share 510104. They stay separate FolkOPS keys so
-- operational reporting still distinguishes a boat fare from a temple ticket.
--
-- OTHER_TOUR_COST is intentionally absent: it has no standing account and is
-- resolved per expense row on the Job Sheet.
--
-- Conflict handling has to satisfy two things at once, and DO NOTHING only gets one:
--   · it must NEVER overwrite a code an operator chose in the app, and
--   · it MUST still fill a row that exists with no code yet.
-- The second case is the common one: opening the mapping page and saving creates a
-- row per category with a NULL code, so a plain DO NOTHING would skip every one of
-- them and the chart would stay unconfigured. Hence DO UPDATE guarded by
-- "peakAccountCode" IS NULL — fill the blanks, touch nothing that is already set.
--
-- updatedById is left NULL: no operator made this choice in the UI, and attributing
-- it to one would put a false name in the audit trail.
INSERT INTO "PeakAccountMapping" ("id", "folkopsCategory", "peakAccountCode", "peakAccountName", "isActive", "createdAt", "updatedAt")
VALUES
  ('seed_peakmap_guide_fee',        'GUIDE_FEE',        '510111', 'ค่าจ้างมัคคุเทศก์',  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('seed_peakmap_entrance_ticket',  'ENTRANCE_TICKET',  '510104', 'ต้นทุนการให้บริการ', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('seed_peakmap_transportation',   'TRANSPORTATION',   '510104', 'ต้นทุนการให้บริการ', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('seed_peakmap_meal_refreshment', 'MEAL_REFRESHMENT', '510104', 'ต้นทุนการให้บริการ', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('seed_peakmap_review_reward',    'REVIEW_REWARD',    '510110', 'ค่ารีวิวลูกค้า',      true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("folkopsCategory") DO UPDATE
  SET "peakAccountCode" = EXCLUDED."peakAccountCode",
      "peakAccountName" = EXCLUDED."peakAccountName",
      "isActive"        = true,
      "updatedAt"       = CURRENT_TIMESTAMP
  WHERE "PeakAccountMapping"."peakAccountCode" IS NULL;
