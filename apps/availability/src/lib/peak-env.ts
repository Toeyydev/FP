// Which PEAK environment a base URL points at.
//
// Classified by HOSTNAME against known hosts — never by a loose substring. The old
// /dev|sandbox/ test ran against the whole URL, so it would call any host
// containing "dev" a sandbox, and would miss a sandbox host that happened not to
// contain the word.
//
// UNKNOWN is a real answer, not a failure: an unrecognised host must never be
// presented as production, because that is the reading that gets someone to trust
// sandbox figures as their real books.

export const PEAK_HOSTS = {
  sandbox: "peakengineapidev.azurewebsites.net",
  production: "api.peakaccount.com",
} as const;

export type PeakEnvironment = "SANDBOX" | "PRODUCTION" | "UNKNOWN";

export type PeakEnvInfo = { environment: PeakEnvironment; host: string; label: string };

export function classifyPeakHost(baseUrl: string | null | undefined): PeakEnvInfo {
  let host = "";
  try {
    host = new URL(String(baseUrl ?? "")).hostname.toLowerCase();
  } catch {
    host = "";
  }
  if (!host) return { environment: "UNKNOWN", host: "", label: "Unknown" };
  if (host === PEAK_HOSTS.sandbox) return { environment: "SANDBOX", host, label: "UAT / Sandbox" };
  if (host === PEAK_HOSTS.production) return { environment: "PRODUCTION", host, label: "Production" };
  return { environment: "UNKNOWN", host, label: "Unknown host" };
}

// Which environment variable actually supplied the endpoint. PEAK_API_BASE_URL
// wins over PEAK_BASE_URL, so a stale value in the winner is otherwise invisible —
// the ignored variable can look correct while doing nothing at all.
export function endpointSource(env: { PEAK_API_BASE_URL?: string; PEAK_BASE_URL?: string }): {
  source: string; overridden: string | null;
} {
  const api = (env.PEAK_API_BASE_URL ?? "").trim();
  const base = (env.PEAK_BASE_URL ?? "").trim();
  if (api) return { source: "PEAK_API_BASE_URL", overridden: base ? "PEAK_BASE_URL" : null };
  if (base) return { source: "PEAK_BASE_URL", overridden: null };
  return { source: "built-in default (UAT sandbox)", overridden: null };
}
