// Mira's scheduling pipeline. Given the appointments parsed from the user's
// pasted text, it: groups stops by date, asks Google for the optimal driving
// order + leg times, assigns a clock time to each visit, creates the events on
// Outlook (Microsoft Graph), and emails the firm the finished route + status.
//
// Graceful degradation: a stop with no concrete (YYYY-MM-DD) date is still routed
// but not put on the calendar; if Maps/Outlook/Resend aren't configured, the
// corresponding step is skipped and reported rather than throwing.

import { Resend } from 'resend';
import { mapsConfigured, optimizeRoute } from './maps.js';
import { calendarTimeZone, createCalendarEvent, outlookConfigured, type EventResult } from './outlook.js';
import type { Appointment } from './types.js';

const DAY_START_MIN = 9 * 60; // 09:00 if no fixed time given
const DEFAULT_VISIT_MIN = 60;

export interface ScheduledStop {
  title: string;
  address: string;
  startLabel: string; // "9:00 AM"
  driveInMin: number; // drive time to reach this stop from the previous point
  event: EventResult;
}
export interface ScheduledDay {
  date: string;
  origin: string;
  stops: ScheduledStop[];
  totalDriveMin: number;
  totalDistanceKm: number;
  optimized: boolean;
  note?: string;
}
export interface ScheduleResult {
  days: ScheduledDay[];
  appointmentCount: number;
  eventsCreated: number;
  eventsFailed: number;
  email: { sent: boolean; to: string; reason?: string; id?: string };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function hhmmss(min: number): string {
  return `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}:00`;
}
function label12(min: number): string {
  let h = Math.floor(min / 60) % 24;
  const m = min % 60;
  const ap = h < 12 ? 'AM' : 'PM';
  h = h % 12 || 12;
  return `${h}:${pad(m)} ${ap}`;
}

/** Schedule + route a parsed appointment list. */
export async function scheduleAppointments(appts: Appointment[]): Promise<ScheduleResult> {
  const origin = process.env.MIRA_ROUTE_ORIGIN?.trim() || '';

  // group by date (keep insertion order of first appearance)
  const groups = new Map<string, Appointment[]>();
  for (const a of appts) {
    const key = a.date || '(no date)';
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(a);
  }

  const days: ScheduledDay[] = [];
  let eventsCreated = 0;
  let eventsFailed = 0;

  for (const [date, group] of groups) {
    const addresses = group.map((a) => a.address);
    const dayOrigin = origin || addresses[0];

    // optimal driving order + leg times
    let order = group.map((_, i) => i);
    let legs: Array<{ durationSec: number; distanceMeters: number }> = [];
    let totalDistanceMeters = 0;
    let optimized = false;
    let note: string | undefined;
    if (mapsConfigured() && addresses.length > 0) {
      try {
        const r = await optimizeRoute(dayOrigin, addresses);
        if (r.order.length === addresses.length) order = r.order;
        legs = r.legs;
        totalDistanceMeters = r.totalDistanceMeters;
        optimized = true;
      } catch (err) {
        note = `route optimization failed (${(err as Error).message}); kept the order as given`;
      }
    } else if (!mapsConfigured()) {
      note = 'GOOGLE_MAPS_API_KEY not set — kept the order as given, no drive times';
    }
    if (!origin) note = (note ? note + '. ' : '') + 'No MIRA_ROUTE_ORIGIN — started the route from the first stop';

    const ordered = order.map((i) => group[i]);
    const isIso = ISO.test(date);

    // assign clock times in visit order. The day starts at 09:00 by default;
    // an earlier fixed appointment pulls the start earlier, but a later one
    // (e.g. a 2pm) does NOT push the whole morning back — it's honored per-stop.
    const earliestFixed = group
      .map((a) => parseHHMM(a.time))
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b)[0];
    let cursor = earliestFixed != null ? Math.min(DAY_START_MIN, earliestFixed) : DAY_START_MIN;
    let totalDriveMin = 0;

    const stops: ScheduledStop[] = [];
    for (let idx = 0; idx < ordered.length; idx++) {
      const a = ordered[idx];
      // leg into this stop: legs[idx] is origin→first, then prev→this; legs[0] is the office drive we don't time against.
      const driveInMin = idx === 0 ? 0 : Math.round((legs[idx]?.durationSec ?? 0) / 60);
      totalDriveMin += idx === 0 ? 0 : driveInMin;
      const fixed = parseHHMM(a.time);
      const arrival = idx === 0 ? cursor : cursor + driveInMin;
      const startMin = fixed != null ? Math.max(arrival, fixed) : arrival;
      const dur = a.durationMin > 0 ? a.durationMin : DEFAULT_VISIT_MIN;
      const endMin = startMin + dur;
      cursor = endMin;

      let event: EventResult;
      if (!isIso) {
        event = { ok: false, reason: 'no concrete date — routed but not added to the calendar' };
      } else if (!outlookConfigured()) {
        event = { ok: false, reason: 'Outlook not configured' };
      } else {
        event = await createCalendarEvent({
          subject: a.title || a.address,
          start: `${date}T${hhmmss(startMin)}`,
          end: `${date}T${hhmmss(endMin)}`,
          location: a.address,
          bodyHtml: `Field visit routed by Mira.<br>Stop ${idx + 1} of ${ordered.length}.<br>${a.address}`,
        });
      }
      if (event.ok) eventsCreated++;
      else if (isIso) eventsFailed++;

      stops.push({ title: a.title, address: a.address, startLabel: label12(startMin), driveInMin, event });
    }

    days.push({
      date,
      origin: dayOrigin,
      stops,
      totalDriveMin,
      totalDistanceKm: Math.round(totalDistanceMeters / 100) / 10,
      optimized,
      note,
    });
  }

  const email = await emailRoute(days, eventsCreated, eventsFailed);
  return { days, appointmentCount: appts.length, eventsCreated, eventsFailed, email };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function routeHtml(days: ScheduledDay[]): string {
  const tz = calendarTimeZone();
  const blocks = days
    .map((d) => {
      const rows = d.stops
        .map(
          (s, i) =>
            `<tr><td style="padding:3px 10px 3px 0;color:#888;white-space:nowrap">${i + 1}.</td>` +
            `<td style="padding:3px 10px 3px 0;font-weight:600;white-space:nowrap">${esc(s.startLabel)}</td>` +
            `<td style="padding:3px 10px 3px 0">${esc(s.title || s.address)}<div style="color:#777;font-size:12px">${esc(s.address)}</div></td>` +
            `<td style="padding:3px 0;color:#777;font-size:12px;white-space:nowrap">${s.driveInMin ? `+${s.driveInMin} min drive` : ''}</td>` +
            `<td style="padding:3px 0 3px 10px;font-size:12px">${s.event.ok ? '✅ on Outlook' : '⚠️ ' + esc(s.event.reason || 'not scheduled')}</td></tr>`,
        )
        .join('');
      const head = `${esc(d.date)} — ${d.stops.length} stop${d.stops.length === 1 ? '' : 's'}` +
        (d.optimized ? ` · optimized route, ~${d.totalDriveMin} min driving${d.totalDistanceKm ? `, ${d.totalDistanceKm} km` : ''}` : '');
      return `<h3 style="margin:18px 0 6px">${head}</h3>` +
        (d.note ? `<div style="color:#a06b00;font-size:12px;margin-bottom:6px">${esc(d.note)}</div>` : '') +
        `<table style="border-collapse:collapse;font-size:14px">${rows}</table>` +
        `<div style="color:#999;font-size:12px;margin-top:4px">Start: ${esc(d.origin)}</div>`;
    })
    .join('');
  return `<div style="font-family:Segoe UI,Arial,sans-serif;color:#1f1a13">
    <p>Mira optimized your field route and scheduled the visits below (times in ${esc(tz)}).</p>
    ${blocks}
    <p style="color:#888;font-size:12px;margin-top:18px">Generated by Agent World · Mira the scheduling agent. Review before driving — confirm addresses and times.</p>
  </div>`;
}

async function emailRoute(
  days: ScheduledDay[],
  created: number,
  failed: number,
): Promise<{ sent: boolean; to: string; reason?: string; id?: string }> {
  const to = process.env.MIRA_TO_EMAIL?.trim() || process.env.INTAKE_TO_EMAIL?.trim() || 'marketing@armadapa.com';
  const from = process.env.INTAKE_FROM_EMAIL?.trim() || 'Armada Routing <onboarding@resend.dev>';
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return { sent: false, to, reason: 'RESEND_API_KEY not set' };
  const stops = days.reduce((n, d) => n + d.stops.length, 0);
  const subject = `Route scheduled: ${stops} stop${stops === 1 ? '' : 's'}${created ? ` · ${created} on Outlook` : ''}${failed ? ` · ${failed} not scheduled` : ''}`;
  try {
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send({ from, to: [to], subject, html: routeHtml(days) });
    if (error) return { sent: false, to, reason: error.message || String(error) };
    return { sent: true, to, id: data?.id };
  } catch (err) {
    return { sent: false, to, reason: (err as Error).message };
  }
}
