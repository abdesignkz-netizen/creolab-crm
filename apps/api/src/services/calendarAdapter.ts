/**
 * Calendar adapter — architecture ready for Google/Outlook/internal CRM calendar.
 * Current stage: no OAuth required; sync is recorded as intent and no-ops unless configured.
 */

export type CalendarEventInput = {
  externalKey: string;
  title: string;
  description?: string | null;
  startsAt: Date;
  endsAt?: Date | null;
  location?: string | null;
  meetingUrl?: string | null;
  attendees?: string[];
};

export type CalendarSyncResult = {
  provider: string;
  status: "skipped" | "queued" | "synced" | "failed";
  externalEventId?: string | null;
  reason?: string | null;
};

export interface CalendarAdapter {
  readonly provider: string;
  isConfigured(): boolean;
  upsertEvent(input: CalendarEventInput): Promise<CalendarSyncResult>;
  deleteEvent(externalKey: string): Promise<CalendarSyncResult>;
}

export class NullCalendarAdapter implements CalendarAdapter {
  readonly provider = "none";
  isConfigured() {
    return false;
  }
  async upsertEvent(): Promise<CalendarSyncResult> {
    return { provider: this.provider, status: "skipped", reason: "calendar_not_configured" };
  }
  async deleteEvent(): Promise<CalendarSyncResult> {
    return { provider: this.provider, status: "skipped", reason: "calendar_not_configured" };
  }
}

/** Google Calendar — activates when GOOGLE_CALENDAR_ACCESS_TOKEN is set (service/user token). */
export class GoogleCalendarAdapter implements CalendarAdapter {
  readonly provider = "google";
  isConfigured() {
    return Boolean(process.env.GOOGLE_CALENDAR_ACCESS_TOKEN && process.env.GOOGLE_CALENDAR_ID);
  }
  async upsertEvent(input: CalendarEventInput): Promise<CalendarSyncResult> {
    if (!this.isConfigured()) {
      return { provider: this.provider, status: "skipped", reason: "google_calendar_env_missing" };
    }
    const calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";
    const token = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN!;
    try {
      const body = {
        summary: input.title,
        description: input.description || undefined,
        location: input.location || undefined,
        start: { dateTime: input.startsAt.toISOString() },
        end: { dateTime: (input.endsAt || new Date(input.startsAt.getTime() + 60 * 60_000)).toISOString() },
        conferenceData: input.meetingUrl
          ? undefined
          : undefined,
        extendedProperties: { private: { creolabKey: input.externalKey } },
        source: input.meetingUrl ? { url: input.meetingUrl, title: "Встреча" } : undefined,
      };
      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?conferenceDataVersion=1`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(12000),
        },
      );
      if (!response.ok) {
        const err = await response.text();
        return { provider: this.provider, status: "failed", reason: err.slice(0, 300) };
      }
      const data = (await response.json()) as { id?: string };
      return { provider: this.provider, status: "synced", externalEventId: data.id || null };
    } catch (error) {
      return {
        provider: this.provider,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  async deleteEvent(externalKey: string): Promise<CalendarSyncResult> {
    if (!this.isConfigured()) {
      return { provider: this.provider, status: "skipped", reason: "google_calendar_env_missing" };
    }
    return { provider: this.provider, status: "skipped", reason: `delete_not_wired:${externalKey}` };
  }
}

export function getCalendarAdapter(): CalendarAdapter {
  const google = new GoogleCalendarAdapter();
  if (google.isConfigured()) return google;
  return new NullCalendarAdapter();
}

export async function syncAgreementToCalendar(agreement: {
  id: string;
  title: string;
  summary?: string | null;
  scheduledAt: Date | null;
  scheduledEndAt?: Date | null;
  locationName?: string | null;
  address?: string | null;
  meetingUrl?: string | null;
  status: string;
}) {
  if (!agreement.scheduledAt) {
    return { provider: "none", status: "skipped" as const, reason: "no_schedule" };
  }
  if (["CANCELLED", "COMPLETED", "MISSED"].includes(agreement.status)) {
    return getCalendarAdapter().deleteEvent(`agreement:${agreement.id}`);
  }
  return getCalendarAdapter().upsertEvent({
    externalKey: `agreement:${agreement.id}`,
    title: agreement.title,
    description: agreement.summary,
    startsAt: agreement.scheduledAt,
    endsAt: agreement.scheduledEndAt || new Date(agreement.scheduledAt.getTime() + 60 * 60_000),
    location: [agreement.locationName, agreement.address].filter(Boolean).join(" · ") || null,
    meetingUrl: agreement.meetingUrl,
  });
}
