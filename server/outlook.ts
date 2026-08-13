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
  /** Outlook free/busy status; "tentative" renders hatched (used for unconfirmed). */
  showAs?: 'free' | 'tentative' | 'busy' | 'oof' | 'workingElsewhere';
}

export interface EventResult {
  ok: boolean;
  id?: string;
  webLink?: string;
  reason?: string;
}

export interface OutlookEventInfo {
  id: string;
  subject: string;
  /** Local wall-clock "YYYY-MM-DDTHH:MM:SS…" in MIRA_TIMEZONE (Prefer header). */
  start: string;
  end: string;
  showAs: string;
  location: string;
  webLink: string;
}

export function defaultCalendarUser(): string {
  return process.env.MS_CALENDAR_USER?.trim() || '';
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
  return createEventFor(defaultCalendarUser(), ev);
}

/** Create an event on ANY mailbox in the tenant (app-only Calendars.ReadWrite). */
export async function createEventFor(user: string, ev: CalendarEvent): Promise<EventResult> {
  if (!outlookConfigured()) return { ok: false, reason: 'Outlook not configured (MS_* env vars missing)' };
  if (!user) return { ok: false, reason: 'no calendar mailbox given' };
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
        ...(ev.showAs ? { showAs: ev.showAs } : {}),
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

/** List a mailbox's events for one local calendar day (YYYY-MM-DD). The query
 *  window is padded in UTC to cover EST/EDT, then filtered by the local date
 *  Graph returns under the Prefer-timezone header. */
export async function listEventsOn(
  user: string,
  date: string,
): Promise<{ ok: boolean; events?: OutlookEventInfo[]; reason?: string }> {
  if (!outlookConfigured()) return { ok: false, reason: 'Outlook not configured (MS_* env vars missing)' };
  if (!user) return { ok: false, reason: 'no calendar mailbox given' };
  const tz = calendarTimeZone();
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextDate = next.toISOString().slice(0, 10);
  const url =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(user)}/calendarView` +
    `?startDateTime=${date}T00:00:00Z&endDateTime=${nextDate}T12:00:00Z` +
    `&$top=50&$orderby=start/dateTime&$select=id,subject,start,end,showAs,location,webLink`;
  try {
    const token = await getToken();
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Prefer: `outlook.timezone="${tz}"` },
    });
    const json = (await res.json()) as Record<string, any>;
    if (!res.ok || json.error) {
      return { ok: false, reason: json?.error?.message || `Graph HTTP ${res.status}` };
    }
    const events: OutlookEventInfo[] = ((json.value as any[]) || [])
      .map((e) => ({
        id: String(e.id || ''),
        subject: String(e.subject || ''),
        start: String(e.start?.dateTime || ''),
        end: String(e.end?.dateTime || ''),
        showAs: String(e.showAs || ''),
        location: String(e.location?.displayName || ''),
        webLink: String(e.webLink || ''),
      }))
      .filter((e) => e.start.startsWith(date)); // keep only the local day
    return { ok: true, events };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** Patch an event (reschedule, retitle, flip tentative/busy). Only the fields
 *  given are changed. */
export async function patchEventFor(
  user: string,
  eventId: string,
  patch: { subject?: string; start?: string; end?: string; showAs?: string; bodyHtml?: string },
): Promise<EventResult> {
  if (!outlookConfigured()) return { ok: false, reason: 'Outlook not configured (MS_* env vars missing)' };
  const tz = calendarTimeZone();
  const body: Record<string, unknown> = {};
  if (patch.subject !== undefined) body.subject = patch.subject;
  if (patch.start) body.start = { dateTime: patch.start, timeZone: tz };
  if (patch.end) body.end = { dateTime: patch.end, timeZone: tz };
  if (patch.showAs) body.showAs = patch.showAs;
  if (patch.bodyHtml !== undefined) body.body = { contentType: 'HTML', content: patch.bodyHtml };
  try {
    const token = await getToken();
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(user)}/events/${encodeURIComponent(eventId)}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    const json = (await res.json()) as Record<string, any>;
    if (!res.ok || json.error) {
      return { ok: false, reason: json?.error?.message || `Graph HTTP ${res.status}` };
    }
    return { ok: true, id: json.id, webLink: json.webLink };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** Delete (cancel) an event outright. */
export async function deleteEventFor(user: string, eventId: string): Promise<{ ok: boolean; reason?: string }> {
  if (!outlookConfigured()) return { ok: false, reason: 'Outlook not configured (MS_* env vars missing)' };
  try {
    const token = await getToken();
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(user)}/events/${encodeURIComponent(eventId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 204) return { ok: true };
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    return { ok: false, reason: json?.error?.message || `Graph HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
