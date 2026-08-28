/**
 * Step 5 — handing scored, contacted leads to the email tool.
 *
 * Two paths, picked by whether INSTANTLY_API_KEY is set:
 *   1. API   — leads are pushed straight into an Instantly campaign.
 *   2. CSV   — a file in Instantly's import shape, for a manual upload.
 *
 * The CSV path is the default because it needs no account and no key, and the
 * same rows go out either way, so switching later changes nothing downstream.
 */

export type SendableLead = {
  leadId: number;
  /** Stable practice identity, used to suppress a second contact attempt. */
  leadKey: string | null;
  email: string;
  firstName: string;
  lastName: string;
  companyName: string;
  phone: string | null;
  title: string | null;
  website: string | null;
  city: string;
  state: string;
  score: number;
};

/** Columns Instantly maps on import. Keep the header text stable. */
const CSV_COLUMNS: { header: string; get: (lead: SendableLead) => string }[] = [
  { header: 'Email', get: (l) => l.email },
  { header: 'First Name', get: (l) => l.firstName },
  { header: 'Last Name', get: (l) => l.lastName },
  { header: 'Company Name', get: (l) => l.companyName },
  { header: 'Phone', get: (l) => l.phone ?? '' },
  { header: 'Title', get: (l) => l.title ?? '' },
  { header: 'Website', get: (l) => l.website ?? '' },
  { header: 'City', get: (l) => l.city },
  { header: 'State', get: (l) => l.state },
  { header: 'Lead Score', get: (l) => String(l.score) },
];

function csvCell(value: string): string {
  // Guard against a leading =, +, - or @ being run as a formula if the file is
  // opened in a spreadsheet before it reaches Instantly.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function buildCsv(leads: SendableLead[]): string {
  const header = CSV_COLUMNS.map((c) => csvCell(c.header)).join(',');
  const rows = leads.map((lead) => CSV_COLUMNS.map((c) => csvCell(c.get(lead))).join(','));
  return [header, ...rows].join('\r\n') + '\r\n';
}

/**
 * Splits a full name into first/last the way an email tool expects.
 * NPPES gives "Firstname Lastname"; anything longer keeps the middle with the first.
 */
export function splitName(fullName: string | null | undefined): { firstName: string; lastName: string } {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

export type InstantlyConfig = {
  apiKey: string;
  campaignId: string;
};

export function readInstantlyConfig(): InstantlyConfig | null {
  const apiKey = (process.env.INSTANTLY_API_KEY ?? '').trim();
  const campaignId = (process.env.INSTANTLY_CAMPAIGN_ID ?? '').trim();
  if (!apiKey || apiKey.startsWith('your_')) return null;
  if (!campaignId || campaignId.startsWith('your_')) return null;
  return { apiKey, campaignId };
}

export type PushResult = {
  ok: boolean;
  status?: number;
  error?: string;
};

/**
 * Adds one lead to an Instantly campaign (v2 API).
 * Returns rather than throws, so one rejected address cannot abort a batch.
 */
export async function pushToInstantly(
  lead: SendableLead,
  config: InstantlyConfig,
  timeoutMs = 20000
): Promise<PushResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch('https://api.instantly.ai/api/v2/leads', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        campaign: config.campaignId,
        email: lead.email,
        first_name: lead.firstName,
        last_name: lead.lastName,
        company_name: lead.companyName,
        phone: lead.phone ?? undefined,
        website: lead.website ?? undefined,
        personalization: lead.title ?? undefined,
        custom_variables: {
          city: lead.city,
          state: lead.state,
          lead_score: lead.score,
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: text.slice(0, 300) || res.statusText };
    }
    return { ok: true, status: res.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message === 'The operation was aborted.' ? 'timeout' : message };
  } finally {
    clearTimeout(timer);
  }
}

/** Stamps an export batch so a CSV can be traced back to the rows it carried. */
export function batchLabel(now = new Date()): string {
  const [date, time] = now.toISOString().slice(0, 19).split('T');
  return `export-${date.replace(/-/g, '')}-${time.replace(/:/g, '')}`;
}
