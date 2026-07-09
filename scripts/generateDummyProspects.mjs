/**
 * Generate ~200 dummy prospects that mimic the tsplus-outreach CRM at various
 * stages of engagement. Output shape is a superset of the `Prospect` interface
 * in src/crm/client.ts (the extra engagement fields — created_at,
 * last_activity_at, emails_sent, opens, replies, sequence — are the kind of
 * metadata a real outreach CRM tracks alongside the core prospect record).
 *
 * Deterministic: a fixed seed makes the output reproducible run-to-run, so the
 * fixture is stable in git. Re-run with `node scripts/generateDummyProspects.mjs`.
 *
 * Writes:
 *   fixtures/prospects.json  — array of 200 prospect objects
 *   fixtures/prospects.csv   — same data, flat CSV for spreadsheet import
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TOTAL = 200;
// Fixed "today" so relative dates are reproducible (matches the project's current date).
const TODAY = new Date('2026-07-09T09:00:00Z');

// --- deterministic PRNG (mulberry32) ------------------------------------------
let seedState = 0x1c3100b; // "IC(E)looP" vibe seed
function rand() {
  seedState |= 0;
  seedState = (seedState + 0x6d2b79f5) | 0;
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
const chance = (p) => rand() < p;

// --- reference pools ----------------------------------------------------------
const FIRST_NAMES = [
  'Julien', 'Camille', 'Thomas', 'Léa', 'Nicolas', 'Sophie', 'Antoine', 'Marie',
  'Alexandre', 'Chloé', 'Maxime', 'Emma', 'Guillaume', 'Sarah', 'Pierre', 'Laura',
  'David', 'Élise', 'Sébastien', 'Manon', 'Olivier', 'James', 'Emily', 'Michael',
  'Jessica', 'Daniel', 'Ashley', 'Christopher', 'Amanda', 'Matthew', 'Lukas',
  'Anna', 'Marco', 'Giulia', 'Miguel', 'Sofía', 'Lars', 'Sanne', 'Piotr', 'Ewa',
];
const LAST_NAMES = [
  'Martin', 'Bernard', 'Dubois', 'Thomas', 'Robert', 'Petit', 'Durand', 'Leroy',
  'Moreau', 'Simon', 'Laurent', 'Lefebvre', 'Michel', 'Garcia', 'Roux', 'Fontaine',
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis', 'Wilson',
  'Anderson', 'Taylor', 'Schneider', 'Müller', 'Rossi', 'Ferrari', 'García',
  'Fernández', 'Jansen', 'De Vries', 'Kowalski', 'Nowak', 'Andersen', 'Nielsen',
];
// TSplus sells remote-access / app-delivery software — its audience skews IT:
// MSPs, VARs, IT departments, hosting providers.
const COMPANY_CORES = [
  'Nexler', 'Aventis IT', 'CloudHaven', 'Orbit Systems', 'BlueCedar', 'Nordtech',
  'Meridian Software', 'Delta Networks', 'Kappa Hosting', 'Vantage MSP', 'Ironwood IT',
  'Silverline Solutions', 'Praxis Digital', 'Quantic Labs', 'Helvetia Systems',
  'Brightpath IT', 'Corvus Cloud', 'Stratum Consulting', 'Vertexa', 'Lumen Réseaux',
  'Atlas Managed Services', 'Northgate Technologies', 'Pixel Forge', 'Redwood Data',
  'Solstice IT', 'Terrasoft', 'Umbra Systems', 'Voltaic Cloud', 'Willow Networks',
  'Zephyr Hosting', 'Alpine Digital', 'Cobalt Consulting', 'Everest IT Group',
  'Fjord Software', 'Granite Systems', 'Horizon Réseaux', 'Inertia Labs', 'Juno MSP',
];
const COMPANY_SUFFIXES = ['', '', '', ' SARL', ' GmbH', ' Ltd', ' Inc', ' SAS', ' BV', ' AB'];
const TITLES = [
  'IT Director', 'Head of Infrastructure', 'System Administrator', 'CTO',
  'IT Manager', 'MSP Owner', 'Network Engineer', 'Head of IT', 'DevOps Lead',
  'IT Operations Manager', 'Cloud Architect', 'Managing Director', 'CIO',
  'Technical Director', 'Sysadmin', 'Head of Managed Services', 'IT Consultant',
  'Infrastructure Engineer', 'VP Engineering', 'IT Support Lead',
];
const COUNTRIES = [
  ['France', 'FR', ['Paris', 'Lyon', 'Toulouse', 'Nantes', 'Lille', 'Bordeaux']],
  ['Germany', 'DE', ['Berlin', 'Munich', 'Hamburg', 'Cologne', 'Frankfurt']],
  ['United Kingdom', 'UK', ['London', 'Manchester', 'Bristol', 'Leeds']],
  ['United States', 'US', ['Austin', 'Denver', 'Chicago', 'Atlanta', 'Boston']],
  ['Netherlands', 'NL', ['Amsterdam', 'Rotterdam', 'Utrecht']],
  ['Spain', 'ES', ['Madrid', 'Barcelona', 'Valencia']],
  ['Italy', 'IT', ['Milan', 'Rome', 'Turin']],
  ['Belgium', 'BE', ['Brussels', 'Antwerp']],
];
const SOURCE_LISTS = [
  'IC(E)looP', 'IC(E)looP', 'IC(E)looP', // over-represent our own signal source
  'LinkedIn Sales Navigator', 'Webinar — Secure Remote Access 2026',
  'Inbound — Trial signup', 'Trade show — IT Partners', 'Partner referral',
  'Cold list — MSP EMEA',
];
const OWNERS = ['Daniel F.', 'Sophie M.', 'Karim B.', 'Elena V.', 'Unassigned'];
const SEQUENCES = [
  { id: 101, name: 'MSP Outbound — EMEA' },
  { id: 102, name: 'IT Director — Remote Access' },
  { id: 103, name: 'Trial no-activation nurture' },
  { id: 104, name: 'Reseller re-engagement' },
];
// Sillage-style signals that IC(E)looP would attach in the notes.
const SIGNALS = [
  'Hiring 3 sysadmins (LinkedIn job posts) — infra team scaling',
  'Posted about Citrix licensing costs on LinkedIn',
  'Mentioned migrating away from legacy RDS gateway',
  'Champion changed roles — new Head of IT onboarding',
  'Competitor (Parallels RAS) contract renewal window in Q3',
  'Published article on secure remote work for hybrid teams',
  'Funding round announced — likely IT tooling budget',
  'Attended "Zero Trust for SMBs" webinar',
  'Opened a new branch office — remote access need',
  'GitHub activity around RDP automation scripts',
];

// --- engagement funnel: status -> share of the 200 ----------------------------
// Ordered new -> customer, with two terminal "off-ramp" states (lost/bounced).
const FUNNEL = [
  { status: 'new', n: 40 },
  { status: 'enriched', n: 25 },
  { status: 'contacted', n: 30 },
  { status: 'opened', n: 22 },
  { status: 'replied', n: 18 },
  { status: 'meeting_booked', n: 15 },
  { status: 'qualified', n: 14 },
  { status: 'customer', n: 10 },
  { status: 'not_interested', n: 14 },
  { status: 'bounced', n: 6 },
  { status: 'unsubscribed', n: 6 },
];
// how "deep" each status is (drives which activity fields are populated)
const STAGE_DEPTH = {
  new: 0, enriched: 1, contacted: 2, opened: 3, replied: 4,
  meeting_booked: 5, qualified: 6, customer: 7,
  not_interested: 4, bounced: 2, unsubscribed: 3,
};

function slug(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}
function daysAgo(n) {
  const d = new Date(TODAY.getTime() - n * 86400000);
  return d.toISOString();
}

// build the flat list of statuses, then shuffle so IDs aren't grouped by stage
const statusBag = [];
for (const { status, n } of FUNNEL) for (let i = 0; i < n; i++) statusBag.push(status);
for (let i = statusBag.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [statusBag[i], statusBag[j]] = [statusBag[j], statusBag[i]];
}

const prospects = [];
for (let i = 0; i < TOTAL; i++) {
  const status = statusBag[i];
  const depth = STAGE_DEPTH[status];

  const firstName = pick(FIRST_NAMES);
  const lastName = pick(LAST_NAMES);
  const company = pick(COMPANY_CORES) + pick(COMPANY_SUFFIXES);
  const [country, cc, cities] = pick(COUNTRIES);
  const city = pick(cities);
  const domain = `${slug(company).slice(0, 18)}.${cc === 'US' ? 'com' : cc === 'UK' ? 'co.uk' : cc.toLowerCase()}`;
  const emailLocal = `${slug(firstName)}.${slug(lastName)}`;
  const bounced = status === 'bounced';
  const email = bounced && chance(0.5)
    ? `${emailLocal}@${slug(company).slice(0, 18)}-old.${cc.toLowerCase()}` // stale/invalid-looking
    : `${emailLocal}@${domain}`;
  const title = pick(TITLES);
  const sourceList = pick(SOURCE_LISTS);

  // Enrichment (FullEnrich) only kicks in from "enriched" onward.
  const enriched = depth >= 1;
  const phone = enriched && chance(0.7)
    ? `+${cc === 'US' ? '1' : cc === 'UK' ? '44' : cc === 'DE' ? '49' : '33'} ${int(1, 9)}${int(10, 99)} ${int(100, 999)} ${int(100, 999)}`
    : null;
  const linkedin = chance(0.85)
    ? `https://www.linkedin.com/in/${slug(firstName)}-${slug(lastName)}-${int(10, 99)}${int(10, 99)}`
    : null;

  // Timeline: created first, activity follows stage depth.
  const createdDaysAgo = int(3, 120);
  const contacted = depth >= 2;
  const emailsSent = contacted ? int(1, Math.min(5, depth)) : 0;
  const opens = depth >= 3 ? int(1, 8) : 0;
  const replies = depth >= 4 && status !== 'not_interested' ? int(1, 4)
    : status === 'not_interested' ? int(1, 2) : 0;
  const lastActivityDaysAgo = contacted ? int(0, Math.min(createdDaysAgo, 45)) : createdDaysAgo;

  // sequence enrollment: prospects that have been contacted are usually in one
  const inSequence = contacted && status !== 'unsubscribed' && chance(0.8);
  const sequence = inSequence ? pick(SEQUENCES) : null;

  // notes follow the pipeline.ts convention (Sillage signal + optional phone)
  const noteLines = [`Signal source (Sillage): ${pick(SIGNALS)}`];
  if (phone) noteLines.push(`Tél: ${phone}`);
  if (status === 'meeting_booked') noteLines.push(`Meeting booked for ${daysAgo(-int(1, 10)).slice(0, 10)}.`);
  if (status === 'qualified') noteLines.push('BANT confirmed — evaluating 25-seat TSplus Remote Access + Advanced Security.');
  if (status === 'customer') noteLines.push(`Closed-won — ${int(10, 250)} seats. Onboarding scheduled.`);
  if (status === 'not_interested') noteLines.push(pick(['Using Parallels RAS, happy for now.', 'No budget this fiscal year.', 'Went with in-house VPN.', 'Not a decision maker — asked to stop.']));
  if (status === 'unsubscribed') noteLines.push('Unsubscribed via email link — do not contact.');
  if (bounced) noteLines.push('Hard bounce — email invalid. Needs re-enrichment.');

  prospects.push({
    id: 1000 + i,
    first_name: firstName,
    last_name: lastName,
    email,
    phone,
    title,
    company,
    website: `https://${domain}`,
    linkedin_url: linkedin,
    country,
    location: `${city}, ${country}`,
    prospect_type: pick(['MSP', 'VAR / Reseller', 'End customer', 'Hosting provider']),
    status,
    source_list: sourceList,
    owner: pick(OWNERS),
    sequence_id: sequence?.id ?? null,
    sequence_name: sequence?.name ?? null,
    emails_sent: emailsSent,
    opens,
    replies,
    created_at: daysAgo(createdDaysAgo),
    last_activity_at: daysAgo(lastActivityDaysAgo),
    notes: noteLines.join('\n'),
  });
}

// --- write JSON ---------------------------------------------------------------
mkdirSync(join(ROOT, 'fixtures'), { recursive: true });
const jsonPath = join(ROOT, 'fixtures', 'prospects.json');
writeFileSync(jsonPath, JSON.stringify(prospects, null, 2) + '\n');

// --- write CSV ----------------------------------------------------------------
const cols = [
  'id', 'first_name', 'last_name', 'email', 'phone', 'title', 'company', 'website',
  'linkedin_url', 'country', 'location', 'prospect_type', 'status', 'source_list',
  'owner', 'sequence_name', 'emails_sent', 'opens', 'replies', 'created_at',
  'last_activity_at', 'notes',
];
const esc = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/\n/g, ' | ');
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = [cols.join(',')]
  .concat(prospects.map((p) => cols.map((c) => esc(p[c])).join(',')))
  .join('\n') + '\n';
writeFileSync(join(ROOT, 'fixtures', 'prospects.csv'), csv);

// --- summary ------------------------------------------------------------------
const counts = {};
for (const p of prospects) counts[p.status] = (counts[p.status] || 0) + 1;
console.log(`Wrote ${prospects.length} prospects -> fixtures/prospects.json + fixtures/prospects.csv\n`);
console.log('Engagement funnel:');
for (const { status } of FUNNEL) {
  console.log(`  ${status.padEnd(16)} ${String(counts[status]).padStart(3)}`);
}
