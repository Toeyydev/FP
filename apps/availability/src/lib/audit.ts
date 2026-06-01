import { prisma } from "@/lib/db";

export async function audit(o: {
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  detail?: unknown;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: o.actorId ?? null,
        actorRole: o.actorRole ?? null,
        action: o.action,
        entityType: o.entityType,
        entityId: o.entityId,
        detail: (o.detail ?? undefined) as object | undefined,
      },
    });
  } catch {
    /* audit must never break the request */
  }
}
