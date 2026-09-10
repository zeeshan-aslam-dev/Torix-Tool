import prisma from '../../../../lib/prisma';
import { resolveScope, scopeWhere, describeScope, ScopeInput } from '../../../../lib/scope';
import { zipCount } from '../../../../lib/geo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Resolves a geographic filter and says what it would actually select.
 *
 * A radius is entered as two numbers and expands into dozens of ZIPs, so without
 * this the user is choosing a scope they cannot see. Reads only — it runs on
 * every keystroke from the UI and must stay cheap and free of side effects.
 */
export async function POST(req: Request) {
  let body: ScopeInput = {};
  try {
    body = await req.json();
  } catch {
    // an empty scope is a valid question — it means "everything"
  }

  const scope = resolveScope(body);

  // Only counts what Step 1 has already imported. A scope can be perfectly valid
  // and still show zero here, which means "not imported yet", not "no such place".
  let leads = 0;
  let scored = 0;
  try {
    const where = scopeWhere(scope);
    leads = await prisma.lead.count({ where });
    scored = await prisma.lead.count({ where: { ...where, tag: 'HOT' } });
  } catch {
    // A malformed filter should show as an empty preview, not a 500.
  }

  return Response.json({
    description: describeScope(scope),
    states: scope.states,
    cities: scope.cities,
    zipCount: scope.zips.length,
    zipPrefixes: scope.zipPrefixes,
    radius: scope.radius,
    warnings: scope.warnings,
    leadsImported: leads,
    hotLeads: scored,
    zipsKnown: zipCount(),
  });
}
