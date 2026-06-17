// Microsoft Graph (Outlook calendar) for Mira, using the app-only
// client-credentials flow: the Azure app authenticates as itself and writes
// events to a target mailbox. Needs MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET,
// MS_CALENDAR_USER, and the Calendars.ReadWrite *Application* permission with
// admin consent granted. MIRA_TIMEZONE sets the event time zone (Windows name).

export interface CalendarEvent {
  subject: string;
  /** Local wall-clock start "YYYY-MM-DDTHH:MM:SS" (interpreted in MIRA_TIMEZONE). */
  start: string;
  end: string;
  location: string;
  bodyHtml: string;
}

export interface EventResult {
  ok: boolean;
  id?: string;
  webLink?: string;
  reason?: string;
}

export function outlookConfigured(): boolean {
  return Boolean(
    process.env.MS_TENANT_ID?.trim() &&
      process.env.MS_CLIENT_ID?.trim() &&
      process.env.MS_CLIENT_SECRET?.trim() &&
      process.env.MS_CALENDAR_USER?.trim(),
  );
}

export function calendarTimeZone(): string {
  return process.env.MIRA_TIMEZONE?.trim() || 'Eastern Standard Time';
}

let cached: { token: string; exp: number } | null = null;

async function getToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const tenant = process.env.MS_TENANT_ID!.trim();
  const body = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID!.trim(),
    client_secret: process.env.MS_CLIENT_SECRET!.trim(),
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json()) as Record<string, any>;
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description?.split('\n')[0] || json.error || `token HTTP ${res.status}`);
  }
  cached = { token: json.access_token, exp: Date.now() + (Number(json.expires_in) || 3600) * 1000 };
  return cached.token;
}

/** Create one calendar event on the configured mailbox. Never throws — returns a
 *  reason string on failure (e.g. missing admin consent shows as Access denied). */
export async function createCalendarEvent(ev: CalendarEvent): Promise<EventResult> {
  if (!outlookConfigured()) return { ok: false, reason: 'Outlook not configured (MS_* env vars missing)' };
  const user = process.env.MS_CALENDAR_USER!.trim();
  const tz = calendarTimeZone();
  try {
    const token = await getToken();
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(user)}/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: ev.subject,
        body: { contentType: 'HTML', content: ev.bodyHtml },
        start: { dateTime: ev.start, timeZone: tz },
        end: { dateTime: ev.end, timeZone: tz },
        location: { displayName: ev.location },
      }),
    });
    const json = (await res.json()) as Record<string, any>;
    if (!res.ok || json.error) {
      return { ok: false, reason: json?.error?.message || `Graph HTTP ${res.status}` };
    }
    return { ok: true, id: json.id, webLink: json.webLink };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
