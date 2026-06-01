import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id?: string;
      role?: "GUIDE" | "OPERATOR" | "ADMIN";
      guideId?: string | null;
      displayName?: string | null;
    } & DefaultSession["user"];
  }
}
