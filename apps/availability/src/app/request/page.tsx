import { redirect } from "next/navigation";

// Sign-up now lives on the unified /start auth card (Sign up tab).
export default function RequestRedirect() {
  redirect("/start");
}
