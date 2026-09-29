import { PrismaClient } from "@prisma/client";
import { withApplicationName } from "@/lib/advances/build";

// Reuse the client across hot reloads in dev to avoid exhausting connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Each connection carries this build's name (pg_stat_activity.application_name).
    datasourceUrl: withApplicationName(process.env.DATABASE_URL),
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
