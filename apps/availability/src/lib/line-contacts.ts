import { prisma } from "@/lib/db";
import { lineGetProfile } from "@/lib/line";
import { audit } from "@/lib/audit";
import { suggestGuide, type GuideName } from "@/lib/line-match";

// Record someone who added / messaged the OA but isn't a linked guide yet, so an
// operator can match them later. Skips anyone already linked to a User. Best-effort:
// a profile-fetch failure still stores the userId (name fills in on a later event).
export async function captureLineContact(lineUserId: string): Promise<void> {
  if (!lineUserId) return;
  const linked = await prisma.user.findFirst({ where: { lineUserId }, select: { id: true } });
  if (linked) return; // already a guide's LINE — nothing to match
  const profile = await lineGetProfile(lineUserId);
  await prisma.lineContact.upsert({
    where: { lineUserId },
    create: { lineUserId, displayName: profile?.displayName ?? null, pictureUrl: profile?.pictureUrl ?? null },
    // Refresh the name/photo if we learned them, but never resurrect a linked row.
    update: profile ? { displayName: profile.displayName, pictureUrl: profile.pictureUrl } : {},
  });
}

// A guide just linked their own LINE (via code or OAuth) — retire any pending
// contact row for that userId so it drops off the operator's "to match" list.
export async function markContactLinked(lineUserId: string, userId: string): Promise<void> {
  if (!lineUserId) return;
  await prisma.lineContact.updateMany({ where: { lineUserId }, data: { linkedUserId: userId } }).catch(() => {});
}

// Unlinked followers + a suggested guide for each, for the operator's match list.
// Never leaks raw lineUserId to the client — the operator acts on the contact id.
export async function listUnlinkedContacts(): Promise<Array<{ id: string; displayName: string | null; pictureUrl: string | null; suggestedGuideId: string | null }>> {
  const [contacts, guides] = await Promise.all([
    prisma.lineContact.findMany({ where: { linkedUserId: null }, orderBy: { createdAt: "desc" } }),
    prisma.user.findMany({ where: { role: "GUIDE", lineUserId: null }, select: { id: true, displayName: true, fullName: true } }),
  ]);
  const roster: GuideName[] = guides.map((g) => ({ userId: g.id, displayName: g.displayName, fullName: g.fullName }));
  return contacts.map((c) => ({
    id: c.id,
    displayName: c.displayName,
    pictureUrl: c.pictureUrl,
    suggestedGuideId: c.displayName ? suggestGuide(c.displayName, roster)?.userId ?? null : null,
  }));
}

// Operator links a captured follower to a guide — the one-click connect. Moves the
// LINE id off any other account first (mirrors the OAuth callback), then sets it on
// the guide and retires the contact. Returns false if either side is missing.
export async function linkContactToGuide(contactId: string, guideUserId: string, actor: { id: string | null; role: string | null }): Promise<boolean> {
  const [contact, guide] = await Promise.all([
    prisma.lineContact.findUnique({ where: { id: contactId } }),
    prisma.user.findUnique({ where: { id: guideUserId }, select: { id: true, role: true } }),
  ]);
  if (!contact || !guide || guide.role !== "GUIDE") return false;

  await prisma.user.updateMany({ where: { lineUserId: contact.lineUserId, NOT: { id: guide.id } }, data: { lineUserId: null } });
  await prisma.user.update({ where: { id: guide.id }, data: { lineUserId: contact.lineUserId, lineLinkCode: null } });
  await prisma.lineContact.update({ where: { id: contact.id }, data: { linkedUserId: guide.id } });
  await audit({ actorId: actor.id, actorRole: actor.role, action: "line.linked_by_operator", entityType: "User", entityId: guide.id, detail: { contactId } });
  return true;
}
