/**
 * The location codes NPPES actually uses in
 * "Provider Business Practice Location Address State Name".
 *
 * Codes only — the file stores two-letter abbreviations, not full names, so the
 * label here is purely for the picker.
 */

export type UsState = {
  code: string;
  name: string;
  group: 'State' | 'District & Territory' | 'Military';
};

export const US_STATES: UsState[] = [
  { code: 'AL', name: 'Alabama', group: 'State' },
  { code: 'AK', name: 'Alaska', group: 'State' },
  { code: 'AZ', name: 'Arizona', group: 'State' },
  { code: 'AR', name: 'Arkansas', group: 'State' },
  { code: 'CA', name: 'California', group: 'State' },
  { code: 'CO', name: 'Colorado', group: 'State' },
  { code: 'CT', name: 'Connecticut', group: 'State' },
  { code: 'DE', name: 'Delaware', group: 'State' },
  { code: 'FL', name: 'Florida', group: 'State' },
  { code: 'GA', name: 'Georgia', group: 'State' },
  { code: 'HI', name: 'Hawaii', group: 'State' },
  { code: 'ID', name: 'Idaho', group: 'State' },
  { code: 'IL', name: 'Illinois', group: 'State' },
  { code: 'IN', name: 'Indiana', group: 'State' },
  { code: 'IA', name: 'Iowa', group: 'State' },
  { code: 'KS', name: 'Kansas', group: 'State' },
  { code: 'KY', name: 'Kentucky', group: 'State' },
  { code: 'LA', name: 'Louisiana', group: 'State' },
  { code: 'ME', name: 'Maine', group: 'State' },
  { code: 'MD', name: 'Maryland', group: 'State' },
  { code: 'MA', name: 'Massachusetts', group: 'State' },
  { code: 'MI', name: 'Michigan', group: 'State' },
  { code: 'MN', name: 'Minnesota', group: 'State' },
  { code: 'MS', name: 'Mississippi', group: 'State' },
  { code: 'MO', name: 'Missouri', group: 'State' },
  { code: 'MT', name: 'Montana', group: 'State' },
  { code: 'NE', name: 'Nebraska', group: 'State' },
  { code: 'NV', name: 'Nevada', group: 'State' },
  { code: 'NH', name: 'New Hampshire', group: 'State' },
  { code: 'NJ', name: 'New Jersey', group: 'State' },
  { code: 'NM', name: 'New Mexico', group: 'State' },
  { code: 'NY', name: 'New York', group: 'State' },
  { code: 'NC', name: 'North Carolina', group: 'State' },
  { code: 'ND', name: 'North Dakota', group: 'State' },
  { code: 'OH', name: 'Ohio', group: 'State' },
  { code: 'OK', name: 'Oklahoma', group: 'State' },
  { code: 'OR', name: 'Oregon', group: 'State' },
  { code: 'PA', name: 'Pennsylvania', group: 'State' },
  { code: 'RI', name: 'Rhode Island', group: 'State' },
  { code: 'SC', name: 'South Carolina', group: 'State' },
  { code: 'SD', name: 'South Dakota', group: 'State' },
  { code: 'TN', name: 'Tennessee', group: 'State' },
  { code: 'TX', name: 'Texas', group: 'State' },
  { code: 'UT', name: 'Utah', group: 'State' },
  { code: 'VT', name: 'Vermont', group: 'State' },
  { code: 'VA', name: 'Virginia', group: 'State' },
  { code: 'WA', name: 'Washington', group: 'State' },
  { code: 'WV', name: 'West Virginia', group: 'State' },
  { code: 'WI', name: 'Wisconsin', group: 'State' },
  { code: 'WY', name: 'Wyoming', group: 'State' },

  { code: 'DC', name: 'District of Columbia', group: 'District & Territory' },
  { code: 'PR', name: 'Puerto Rico', group: 'District & Territory' },
  { code: 'VI', name: 'U.S. Virgin Islands', group: 'District & Territory' },
  { code: 'GU', name: 'Guam', group: 'District & Territory' },
  { code: 'AS', name: 'American Samoa', group: 'District & Territory' },
  { code: 'MP', name: 'Northern Mariana Islands', group: 'District & Territory' },

  { code: 'AA', name: 'Armed Forces Americas', group: 'Military' },
  { code: 'AE', name: 'Armed Forces Europe', group: 'Military' },
  { code: 'AP', name: 'Armed Forces Pacific', group: 'Military' },
];

export const STATE_CODES = new Set(US_STATES.map((s) => s.code));

/**
 * The ten states carrying the most providers, measured on the August 2026 file
 * for chiropractic / optometry / family medicine. Handy as a starting market list.
 */
export const TOP_MARKETS = ['CA', 'TX', 'FL', 'NY', 'PA', 'IL', 'MI', 'OH', 'NC', 'WA'];

/** Parses the comma-separated form the API still expects. */
export function parseStates(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => STATE_CODES.has(s));
}

export function formatStates(codes: string[]): string {
  return codes.join(',');
}

export function stateName(code: string): string {
  return US_STATES.find((s) => s.code === code)?.name ?? code;
}
