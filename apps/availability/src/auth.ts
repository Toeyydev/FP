import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { loginLocked, recordLoginFail, recordLoginSuccess } from "@/lib/ratelimit";
import { z } from "zod";
import { authConfig } from "@/auth.config";
import { prisma } from "@/lib/db";

const credsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: async (raw) => {
        const parsed = credsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const email = parsed.data.email.toLowerCase().trim();
        // Brute-force protection: lock an account after too many wrong attempts.
        if (loginLocked(email)) return null;
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || !user.passwordHash) { recordLoginFail(email); return null; } // unclaimed accounts have no password
        if (user.state !== "ACTIVE") return null; // invited / pending / suspended cannot log in
        if (!bcrypt.compareSync(parsed.data.password, user.passwordHash)) { recordLoginFail(email); return null; }
        recordLoginSuccess(email);
        return {
          id: user.id,
          email: user.email,
          name: user.displayName,
          role: user.role,
          guideId: user.guideId,
        } as { id: string; email: string; name: string; role: string; guideId: string | null };
      },
    }),
  ],
});
