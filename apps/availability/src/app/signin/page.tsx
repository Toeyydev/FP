import { redirect } from "next/navigation";

// The login form now lives on the unified /start auth card.
export default function SignInRedirect() {
  redirect("/start");
}
