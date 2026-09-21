import { scoreLead, DEFAULT_THRESHOLDS, DEFAULT_SIZE_POLICY } from '../lib/scoring';

const NOW = new Date('2026-08-22T00:00:00Z');
const yearsAgo = (n: number) => new Date(NOW.getTime() - n * 365.25 * 24 * 3600 * 1000);

let pass = 0, fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  expected ${expected}, got ${actual}`}`);
}

// 1. Ideal buyer: 2-location practice, owner named, fresh record
const ideal = scoreLead({
  entityType: '2', n_locations_detected: 2, n_providers_at_location: 6,
  authorizedOfficialTitle: 'OWNER', authorizedOfficialName: 'JANE DOE',
  phone: '8015551234', lastUpdateDate: yearsAgo(1),
}, DEFAULT_THRESHOLDS, NOW);
check('ideal practice is HOT', ideal.tag, 'HOT');
check('ideal practice scores 100', ideal.score, 100);

// 2. Entity Type 1 is never a lead, full stop — not employed, not a sole
// proprietor with an otherwise perfect record. Individuals are kept only as
// the Step 1 fallback-phone lookup for a facility's own Authorized Official,
// never scored as a lead in their own right.
const employed = scoreLead({
  entityType: '1', n_locations_detected: 1, n_providers_at_location: 1,
  isSoleProprietor: 'N', phone: '8015550000', lastUpdateDate: yearsAgo(14),
}, DEFAULT_THRESHOLDS, NOW);
check('employed individual is EXCLUDE', employed.tag, 'EXCLUDE');
check('employed individual scores 0', employed.score, 0);

const sole = scoreLead({
  entityType: '1', n_locations_detected: 1, n_providers_at_location: 1,
  isSoleProprietor: 'Y', authorizedOfficialTitle: 'OWNER', authorizedOfficialName: 'JANE DOE',
  phone: '8015550000', lastUpdateDate: yearsAgo(1),
}, DEFAULT_THRESHOLDS, NOW);
check('an otherwise-ideal sole proprietor is still EXCLUDE — entity type overrides everything else', sole.tag, 'EXCLUDE');
check('sole proprietor scores 0 too, not just lower', sole.score, 0);

// 2b. A search result naming an acquirer excludes just as hard as the
// blocklist does — this is what makes the online independence check an
// actual gate instead of a handful of extra scoring points.
const acquired = scoreLead({
  entityType: '2', n_locations_detected: 2, n_providers_at_location: 6,
  authorizedOfficialTitle: 'OWNER', authorizedOfficialName: 'JANE DOE',
  phone: '8015551234', lastUpdateDate: yearsAgo(1), possibleAcquisition: true,
}, DEFAULT_THRESHOLDS, NOW);
check('a Step-3-discovered acquisition excludes an otherwise-ideal practice', acquired.tag, 'EXCLUDE');
check('acquisition-excluded score is 0', acquired.score, 0);
check('acquisition flag carries through to the result', acquired.possibleAcquisition, true);

// 4. Hospital chain — hard size cap excludes before soft scoring
const chain = scoreLead({
  entityType: '2', n_locations_detected: 88, n_providers_at_location: 2,
  authorizedOfficialTitle: 'CEO', authorizedOfficialName: 'BIG BOSS',
  phone: '8015559999', lastUpdateDate: yearsAgo(1),
}, DEFAULT_THRESHOLDS, NOW);
check('88-location chain is EXCLUDE', chain.tag, 'EXCLUDE');
check('88-location chain scores 0', chain.score, 0);
check('88-location reason names the branch cap', chain.reason.includes('max of 2 branches'), true);

// 4b. Three branches is already over the hard max of 2
const threeBranches = scoreLead({
  entityType: '2', n_locations_detected: 3, n_providers_at_location: 6,
  authorizedOfficialTitle: 'OWNER', authorizedOfficialName: 'JANE DOE',
  phone: '8015551234', lastUpdateDate: yearsAgo(1),
}, DEFAULT_THRESHOLDS, NOW);
check('3-location practice is EXCLUDE under max 2 branches', threeBranches.tag, 'EXCLUDE');
check('3-location score is 0', threeBranches.score, 0);

// 4c. Too many providers at one site
const tooManyProviders = scoreLead({
  entityType: '2', n_locations_detected: 1, n_providers_at_location: 16,
  authorizedOfficialTitle: 'OWNER', authorizedOfficialName: 'JANE DOE',
  phone: '8015551234', lastUpdateDate: yearsAgo(1),
}, DEFAULT_THRESHOLDS, NOW);
check('16-provider site is EXCLUDE under max 15', tooManyProviders.tag, 'EXCLUDE');
check('16-provider reason names the provider cap', tooManyProviders.reason.includes('max of 15'), true);

const atProviderCap = scoreLead({
  entityType: '2', n_locations_detected: 1, n_providers_at_location: 15,
  authorizedOfficialTitle: 'OWNER', authorizedOfficialName: 'JANE DOE',
  phone: '8015551234', lastUpdateDate: yearsAgo(1),
}, DEFAULT_THRESHOLDS, NOW);
check('15 providers is still allowed', atProviderCap.tag !== 'EXCLUDE' || atProviderCap.score > 0, true);
check('15-provider lead is not hard-excluded', atProviderCap.reason.includes('max of 15'), false);

// 5. Subsidiary — decisions happen at HQ
const sub = scoreLead({
  entityType: '2', n_locations_detected: 2, n_providers_at_location: 4,
  authorizedOfficialTitle: 'OWNER', authorizedOfficialName: 'X',
  phone: '1', lastUpdateDate: yearsAgo(1),
  isOrganizationSubpart: 'Y', parentOrganizationLbn: 'BIG HEALTH INC',
}, DEFAULT_THRESHOLDS, NOW);
check('subsidiary flagged as possible acquisition', sub.possibleAcquisition, true);
check('subsidiary scores below the same practice standalone', sub.score < ideal.score, true);

// 6. Score is clamped and reason is populated — an org that clears the hard
// size caps but stacks every soft negative signal.
const extreme = scoreLead({
  entityType: '2', n_locations_detected: 1, n_providers_at_location: 1,
  isOrganizationSubpart: 'Y', parentOrganizationLbn: 'BIG HEALTH INC',
  lastUpdateDate: yearsAgo(30), phone: null,
}, DEFAULT_THRESHOLDS, NOW);
check('score never goes negative', extreme.score >= 0, true);
check('reason is populated', extreme.reason.length > 0, true);

// 7. Thresholds are respected
const custom = scoreLead({
  entityType: '2', n_locations_detected: 1, n_providers_at_location: 1,
  phone: '1', lastUpdateDate: yearsAgo(1),
}, { hot: 10, verify: 5 }, NOW);
check('custom low threshold promotes to HOT', custom.tag, 'HOT');

// 8. Hard caps are data — raising maxBranches lets a 3-location practice through.
const threeLocInput = {
  entityType: '2' as const, n_locations_detected: 3, n_providers_at_location: 6,
  authorizedOfficialTitle: 'OWNER', authorizedOfficialName: 'JANE DOE',
  phone: '8015551234', lastUpdateDate: yearsAgo(1),
};
const withRaisedBranchCap = scoreLead(
  threeLocInput, DEFAULT_THRESHOLDS, NOW, undefined,
  { ...DEFAULT_SIZE_POLICY, maxBranches: 3 }
);
check('raising maxBranches to 3 lets a 3-location practice score', withRaisedBranchCap.tag, 'HOT');

const withRaisedProviderCap = scoreLead(
  { ...threeLocInput, n_locations_detected: 1, n_providers_at_location: 20 },
  DEFAULT_THRESHOLDS, NOW, undefined,
  { ...DEFAULT_SIZE_POLICY, maxProviders: 20 }
);
check('raising maxProviders to 20 lets a 20-provider site score', withRaisedProviderCap.tag, 'HOT');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
