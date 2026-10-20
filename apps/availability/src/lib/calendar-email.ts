import { z } from "zod";

// A guide's calendar email (where Google Calendar invitations go). Optional: blank clears it,
// and the invitation then goes to their account email (lib/tour-calendar-sync).
export const calendarEmailInput = z.string().max(254).trim().refine((v) => v === "" || z.string().email().safeParse(v).success, "not an email");

/** What to store: null for blank, else the address in lower case. */
export const storedCalendarEmail = (v: string): string | null => (v.trim() ? v.trim().toLowerCase() : null);
