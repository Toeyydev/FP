-- A departure that already has a guide is offered only as a replacement of that guide
-- (owner, 2026-10-15: one booking on 16 Oct ended up with two guides because a staffed
-- departure could be offered again). Additive and nullable: existing offers are unchanged.
ALTER TABLE "JobOffer" ADD COLUMN "replacesGuideId" TEXT;
