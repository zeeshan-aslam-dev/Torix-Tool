/**
 * Lead scoring for Step 2.
 *
 * Every rule is explicit and carries a label, so each lead ends up with a `reason`
 * string a human can read and argue with. Nothing here calls out to an API — it
 * runs purely on the NPPES fields captured during Step 1.
 *
 * The target buyer is a practice that (a) is a real business, (b) has someone
 * reachable who can say yes, and (c) is big enough to have a budget but small
 * enough not to have an in-house marketing team.
 */

export type ScoreInput = {
  organization?: string | null;
  entityType?: string | null;
  n_locations_detected?: number | null;
  n_providers_at_location?: number | null;
  authorizedOfficialTitle?: string | null;
  authorizedOfficialName?: string | null;
  phone?: string | null;
  lastUpdateDate?: Date | null;
  isSoleProprietor?: string | null;
  isOrganizationSubpart?: string | null;
  parentOrganizationLbn?: string | null;
  /** Set by Step 3 from the Google Business Profile listing, when one matched. */
  gbpStatus?: string | null;
  /**
   * Set by Step 3 when its own site or a search result stated, in so many
   * words, that the practice is "part of" / "acquired by" another
   * organisation. A hard exclude at the same tier as the blocklist below —
   * the objection is who actually decides, not how the rest of the record
   * scores.
   */
  possibleAcquisition?: boolean | null;
};

export type ScoreResult = {
  score: number;
  tag: 'HOT' | 'VERIFY' | 'EXCLUDE';
  reason: string;
  possibleAcquisition: boolean;
};

export type Thresholds = {
  hot: number;
  verify: number;
};

/**
 * The location-count boundaries that separate "needs a web presence" from
 * "already has in-house marketing." Kept as data the caller can override
 * rather than numbers buried in the function body, so the ideal-customer size
 * can be dialled in over time without a code change — Step 2 exposes
 * `maxLocations` in the UI as exactly this cutoff.
 */
export type SizePolicy = {
  /** At or above this many locations, the multi-location bonus starts. */
  idealMin: number;
  /** At or above this many locations, the bonus shrinks — likely has internal resources. */
  midMin: number;
  /** At or above this many locations, treated as a chain and penalised outright. */
  chainCutoff: number;
};

export const DEFAULT_SIZE_POLICY: SizePolicy = { idealMin: 2, midMin: 11, chainCutoff: 21 };

export const DEFAULT_THRESHOLDS: Thresholds = { hot: 55, verify: 30 };

/** Titles that indicate the person named on the NPI record can sign a contract. */
const OWNER_TITLES = [
  'OWNER', 'PRESIDENT', 'CEO', 'CHIEF EXECUTIVE', 'PARTNER', 'PRINCIPAL',
  'FOUNDER', 'PROPRIETOR', 'MEMBER', 'DIRECTOR OF OPERATIONS',
];

/** Titles that can usually get you to the decision maker but cannot decide alone. */
const GATEKEEPER_TITLES = [
  'MANAGER', 'ADMINISTRATOR', 'DIRECTOR', 'SUPERVISOR', 'COORDINATOR', 'CFO', 'COO',
];

function yearsSince(date: Date | null | undefined, now: Date): number | null {
  if (!date || Number.isNaN(date.getTime())) return null;
  return (now.getTime() - date.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
}

export function scoreLead(
  lead: ScoreInput,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
  now: Date = new Date(),
  /** Injected so the scorer stays pure and testable without touching the disk. */
  blocklistMatch: (organization: string) => { entry: string } | null = () => null,
  sizePolicy: SizePolicy = DEFAULT_SIZE_POLICY
): ScoreResult {
  // Entity Type 1 is an individual provider, not a facility — never a lead,
  // regardless of anything else on the record. Step 1 already keeps a fresh
  // import from creating one; this is what makes the same rule take effect on
  // a lead that was imported before that existed, on nothing more than a
  // re-run of this step.
  if (lead.entityType === '1') {
    return {
      score: 0,
      tag: 'EXCLUDE',
      reason: 'Entity Type 1 — an individual provider, not a facility. Kept only as a fallback contact, never a lead.',
      possibleAcquisition: false,
    };
  }

  // A named health system is disqualified outright — no points can rescue it,
  // because the objection is who decides, not how big the practice looks.
  const blocked = lead.organization ? blocklistMatch(lead.organization) : null;
  if (blocked) {
    return {
      score: 0,
      tag: 'EXCLUDE',
      reason: `blocklisted: part of ${blocked.entry}`,
      possibleAcquisition: true,
    };
  }

  // Step 3 read it in so many words on the practice's own site or in a search
  // result — the same hard exclude as the blocklist above, just discovered
  // online instead of from a static list. Only takes effect once Step 3 has
  // actually run and this field is set; re-run this step afterward to apply it.
  if (lead.possibleAcquisition) {
    return {
      score: 0,
      tag: 'EXCLUDE',
      reason: "a search result or the practice's own site described it as part of another organisation",
      possibleAcquisition: true,
    };
  }

  // Google says the practice has shut. Nothing else about the record matters, and
  // NPPES will not say so itself — 41% of records have not been touched in ten
  // years, so a closed clinic looks identical to an open one in the source file.
  if ((lead.gbpStatus || '').toUpperCase() === 'CLOSED_PERMANENTLY') {
    return {
      score: 0,
      tag: 'EXCLUDE',
      reason: 'Google Business Profile reports this practice permanently closed',
      possibleAcquisition: false,
    };
  }

  let score = 0;
  const reasons: string[] = [];

  const add = (points: number, label: string) => {
    score += points;
    reasons.push(`${points > 0 ? '+' : ''}${points} ${label}`);
  };

  const isOrg = lead.entityType === '2';
  const soleProprietor = (lead.isSoleProprietor || '').toUpperCase() === 'Y';
  const subpart = (lead.isOrganizationSubpart || '').toUpperCase() === 'Y';
  const parent = (lead.parentOrganizationLbn || '').trim();
  const locations = lead.n_locations_detected ?? 0;
  const providers = lead.n_providers_at_location ?? 0;
  const title = (lead.authorizedOfficialTitle || '').toUpperCase();

  // --- Business type -------------------------------------------------------
  if (isOrg) {
    add(25, 'registered organization');
  } else if (soleProprietor) {
    add(10, 'sole proprietor (owns the practice)');
  } else {
    add(-15, 'individual provider, likely employed');
  }

  // --- Decision maker ------------------------------------------------------
  if (title && OWNER_TITLES.some((t) => title.includes(t))) {
    add(20, `decision maker on file (${title})`);
  } else if (title && GATEKEEPER_TITLES.some((t) => title.includes(t))) {
    add(10, `contact on file (${title})`);
  } else if (lead.authorizedOfficialName) {
    add(5, 'named contact on file');
  }

  // --- Size ------------------------------------------------------------------
  if (locations >= sizePolicy.chainCutoff) {
    add(-30, `${locations} locations, large chain with in-house marketing`);
  } else if (locations >= sizePolicy.midMin) {
    add(5, `${locations} locations, likely has internal resources`);
  } else if (locations >= sizePolicy.idealMin) {
    add(20, `${locations} locations, needs multi-location web presence`);
  }

  if (providers >= 5) {
    add(15, `${providers} providers at this location`);
  } else if (providers >= 2) {
    add(8, `${providers} providers at this location`);
  }

  // --- Data freshness ------------------------------------------------------
  const age = yearsSince(lead.lastUpdateDate ?? null, now);
  if (age === null) {
    add(-10, 'no update date on record');
  } else if (age <= 2) {
    add(15, 'record updated within 2 years');
  } else if (age <= 5) {
    add(5, `record ${Math.round(age)} years old`);
  } else if (age <= 10) {
    add(-5, `record ${Math.round(age)} years old`);
  } else {
    add(-20, `record ${Math.round(age)} years stale`);
  }

  // --- Reachability --------------------------------------------------------
  if (lead.phone) {
    add(5, 'phone on file');
  } else {
    add(-10, 'no phone on file');
  }

  // --- Ownership -----------------------------------------------------------
  if (subpart || parent) {
    add(-20, parent ? `subsidiary of ${parent}` : 'organization subpart, HQ decides');
  }

  const clamped = Math.max(0, Math.min(100, score));

  const tag: ScoreResult['tag'] =
    clamped >= thresholds.hot ? 'HOT' : clamped >= thresholds.verify ? 'VERIFY' : 'EXCLUDE';

  return {
    score: clamped,
    tag,
    reason: reasons.join('; '),
    possibleAcquisition: Boolean(subpart || parent),
  };
}
