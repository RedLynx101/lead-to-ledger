// Generates labeled synthetic leads from templates and a seed. Same seed, same
// templates, same bytes. Nothing in here uses Math.random or the clock.
//
// All email addresses use domains reserved for documentation (RFC 2606) and all
// phone numbers use the 555-01xx block reserved for fiction, so no generated lead
// can reach a real person.

import { CATEGORIES, COMPANY_KINDS, DIFFICULTIES, EMAIL_KINDS, INQUIRY_TYPES, PRIORITIES, REGIONS, TITLE_KINDS } from './types.ts';
import type { Category, LabeledLead, LeadTemplate } from './types.ts';

export const GENERATOR_VERSION = 1;

/**
 * Share of each category in a generated set. Chosen so every category has enough
 * examples to score. This is not a claim about what a real inbox looks like.
 */
export const CATEGORY_WEIGHTS: Record<Category, number> = {
  sales_ready: 0.22,
  needs_info: 0.14,
  not_a_fit: 0.14,
  existing_customer: 0.12,
  vendor_pitch: 0.14,
  job_seeker: 0.08,
  spam: 0.16,
};

const RESUBMISSION_RATE = 0.03;

export const FREEMAIL_DOMAINS = ['freemail.example.net', 'mailbox.example.net', 'postbox.example.org'];
export const DISPOSABLE_DOMAINS = ['tempinbox.example.net', 'throwaway.example.org', 'burnermail.example.net'];

const IN_AREA: Array<[string, string, string]> = [
  ['Columbus', 'OH', '614'],
  ['Columbus', 'OH', '614'],
  ['Dayton', 'OH', '937'],
  ['Dayton', 'OH', '937'],
  ['Cincinnati', 'OH', '513'],
  ['Cincinnati', 'OH', '513'],
  ['Springfield', 'OH', '937'],
  ['Lancaster', 'OH', '740'],
  ['Newark', 'OH', '740'],
  ['Hamilton', 'OH', '513'],
  ['Middletown', 'OH', '513'],
  ['Covington', 'KY', '859'],
  ['Florence', 'KY', '859'],
  ['Newport', 'KY', '859'],
];

const OUT_OF_AREA: Array<[string, string, string]> = [
  ['Cleveland', 'OH', '216'],
  ['Toledo', 'OH', '419'],
  ['Akron', 'OH', '330'],
  ['Youngstown', 'OH', '330'],
  ['Louisville', 'KY', '502'],
  ['Lexington', 'KY', '859'],
  ['Pittsburgh', 'PA', '412'],
  ['Indianapolis', 'IN', '317'],
  ['Nashville', 'TN', '615'],
  ['Tampa', 'FL', '813'],
  ['Phoenix', 'AZ', '602'],
  ['Detroit', 'MI', '313'],
];

const HQ_ELSEWHERE: Array<[string, string]> = [
  ['Chicago', 'IL'],
  ['Atlanta', 'GA'],
  ['Dallas', 'TX'],
  ['Boston', 'MA'],
  ['Denver', 'CO'],
  ['Charlotte', 'NC'],
];

const FIRST_NAMES = [
  'Dana', 'Marcus', 'Priya', 'Tomas', 'Alicia', 'Devon', 'Grace', 'Hector', 'Imani', 'Jonas', 'Kara', 'Liam', 'Mei', 'Nadia', 'Owen',
  'Paula', 'Quinn', 'Rosa', 'Samir', 'Tessa', 'Umar', 'Vera', 'Wes', 'Yara', 'Zane', 'Brenda', 'Calvin', 'Delia', 'Ethan', 'Farah',
  'Gus', 'Helen', 'Ivan', 'Joan', 'Kevin', 'Lena', 'Miguel', 'Nora', 'Oscar', 'Rita', 'Sean', 'Tina', 'Victor', 'Wendy', 'Xavier',
];

const LAST_NAMES = [
  'Ruiz', 'Okafor', 'Lindqvist', 'Nguyen', 'Haddad', 'Kowalski', 'Mercer', 'Tanaka', 'Oyelaran', 'Fischer', 'Delgado', 'Brandt', 'Sato',
  'Marsh', 'Petrov', 'Castillo', 'Whitfield', 'Novak', 'Ibrahim', 'Harlan', 'Vance', 'Ferro', 'Quigley', 'Stroud', 'Pruitt', 'Yoder',
  'Abbott', 'Baptiste', 'Cho', 'Dunn', 'Ellison', 'Farrow', 'Gentry', 'Hollis', 'Iyer', 'Jensen', 'Keller', 'Lowry', 'Moss', 'Nash',
];

const NAME_WORDS = [
  'Cedar', 'Harbor', 'Ridgeline', 'Copper', 'Lantern', 'Fieldcrest', 'Stonebrook', 'Ironwood', 'Bluestem', 'Kestrel', 'Granite', 'Alder',
  'Birchwood', 'Quarry', 'Foxglove', 'Millrace', 'Wexford', 'Tamarack', 'Oakhaven', 'Larkspur', 'Sycamore', 'Thistle', 'Marlowe', 'Fennel',
  'Brightwater', 'Hollowell', 'Pinecrest', 'Elmgate', 'Redwing', 'Silverton', 'Whitlock', 'Ashbury',
];

const COMPANY_SUFFIXES: Record<string, string[]> = {
  property: ['Property Management', 'Properties', 'Realty Group', 'Commercial Realty', 'Management Co.', 'Holdings', 'Residential', 'Apartments'],
  business: ['Brewing Co.', 'Dental Group', 'Logistics', 'Manufacturing', 'Foods', 'Fitness', 'Medical Partners', 'Auto Group', 'Hotel Group', 'Printing', 'Tool & Die', 'Credit Union'],
  institution: ['Christian Academy', 'Public Library', 'Community Church', 'Charter School', 'Senior Living', 'Community Center', 'Montessori School'],
  vendor: ['Digital', 'Growth Partners', 'Staffing', 'Supply', 'Capital', 'Lead Solutions', 'Software', 'Marketing', 'Insurance Group', 'Fleet Tech'],
};

const TITLES: Record<string, string[]> = {
  facilities: ['Facilities Manager', 'Property Manager', 'Building Engineer', 'Director of Operations', 'Maintenance Supervisor', 'Regional Manager'],
  owner: ['Owner', 'President', 'General Manager', 'Partner', 'Office Manager'],
  sales: ['Account Executive', 'Business Development Rep', 'Partnership Manager', 'Sales Director', 'Founder'],
  student: ['Student', 'Apprentice', 'HVAC Student'],
};

const EQUIPMENT = ['rooftop unit', 'chiller', 'boiler', 'air handler', 'makeup air unit', 'cooling tower', 'gas pack', 'split system'];
const BRANDS = ['Trane', 'Carrier', 'Lennox', 'York', 'Daikin', 'Rheem'];
const BUILDINGS = ['medical office building', 'office building', 'retail center', 'warehouse', 'manufacturing plant', 'hotel', 'school building', 'distribution center'];
const TIMELINES = ['by the end of next quarter', 'before next summer', 'sometime this fall', 'in the next few months', 'early next year', 'before our lease renewal'];
const URGENT_TIMES = ['since this morning', 'since last night', 'as of an hour ago', 'since yesterday afternoon', 'overnight'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const VENDOR_PRODUCTS = ['SEO retainer', 'dispatch software', 'pay-per-lead program', 'Google Ads package', 'review management tool', 'answering service', 'website redesign', 'field service app'];
const SCHOOLS = ['the county career center', 'the regional technical college', 'our local trade school', 'the community college', 'a union training program'];
const CERTS = ['EPA 608 Universal', 'NATE', 'EPA 608 Type II', 'state journeyman', 'BAS controls'];
const TRADE_YEARS = ['first-year', 'second-year', 'final-year'];

export interface Rng {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
  shuffle<T>(items: readonly T[]): T[];
}

/** mulberry32. Small, fast and fine for sampling; not for anything secret. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (p) => next() < p,
    shuffle: (items) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
  return rng;
}

const money = (n: number) => `$${n.toLocaleString('en-US')}`;
const thousands = (n: number) => n.toLocaleString('en-US');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

export const KNOWN_SLOTS = new Set([
  'first', 'last', 'full', 'title', 'company', 'city', 'state', 'hq_city', 'hq_state', 'sqft_small', 'sqft', 'sqft_large', 'units_small', 'units',
  'units_large', 'budget', 'phone', 'url', 'spam_url', 'tonnage', 'rtu_count', 'sites', 'equipment', 'brand', 'building', 'timeline', 'urgent_time',
  'month', 'weekday', 'contract_no', 'ticket_no', 'invoice_no', 'tech', 'vendor_product', 'school', 'cert', 'years', 'trade_school_year',
]);

export function slotsIn(message: string): string[] {
  return [...message.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
}

/** Returns problems by template ID and field name. Never includes message text. */
export function validateTemplates(templates: LeadTemplate[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const inList = (value: unknown, list: readonly string[]) => list.includes(value as string);
  for (const t of templates) {
    const where = t.id ?? '(no id)';
    if (!t.id) problems.push(`${where}: missing id`);
    if (seen.has(t.id)) problems.push(`${where}: duplicate id`);
    seen.add(t.id);
    if (!inList(t.category, CATEGORIES)) problems.push(`${where}: bad category`);
    if (!inList(t.priority, PRIORITIES)) problems.push(`${where}: bad priority`);
    if (!inList(t.difficulty, DIFFICULTIES)) problems.push(`${where}: bad difficulty`);
    if (typeof t.message !== 'string' || !t.message.trim()) problems.push(`${where}: empty message`);
    const form = t.form ?? ({} as LeadTemplate['form']);
    if (!inList(form.inquiry_type, INQUIRY_TYPES)) problems.push(`${where}: bad inquiry_type`);
    if (!inList(form.region, REGIONS)) problems.push(`${where}: bad region`);
    if (!inList(form.email_kind, EMAIL_KINDS)) problems.push(`${where}: bad email_kind`);
    if (!inList(form.company_kind, COMPANY_KINDS)) problems.push(`${where}: bad company_kind`);
    if (!inList(form.title_kind, TITLE_KINDS)) problems.push(`${where}: bad title_kind`);

    for (const slot of slotsIn(t.message ?? '')) {
      if (!KNOWN_SLOTS.has(slot)) problems.push(`${where}: unknown slot "${slot}"`);
      if (slot === 'company' && form.company_kind === 'none') problems.push(`${where}: uses {company} with company_kind none`);
      if (slot === 'title' && form.title_kind === 'none') problems.push(`${where}: uses {title} with title_kind none`);
      if ((slot === 'hq_city' || slot === 'hq_state') && form.region !== 'in_area_hq_elsewhere') problems.push(`${where}: uses {${slot}} outside region in_area_hq_elsewhere`);
    }

    // Priority rules from the labeling guide that hold for every template in a category.
    const lowOnly: Category[] = ['not_a_fit', 'vendor_pitch', 'job_seeker', 'spam'];
    if (lowOnly.includes(t.category) && t.priority !== 'low') problems.push(`${where}: ${t.category} must be low priority`);
    if (t.category === 'sales_ready' && t.priority === 'low') problems.push(`${where}: sales_ready cannot be low priority`);
    if (t.category === 'existing_customer' && t.priority === 'low') problems.push(`${where}: existing_customer cannot be low priority`);
    if (t.category === 'needs_info' && t.priority === 'high') problems.push(`${where}: needs_info cannot be high priority`);
  }
  return problems;
}

function fillSlots(t: LeadTemplate, rng: Rng, ctx: {
  first: string; last: string; company: string; jobTitle: string; city: string; state: string; hqCity: string; hqState: string; phone: string; url: string;
}): string {
  const values: Record<string, () => string> = {
    first: () => ctx.first,
    last: () => ctx.last,
    full: () => `${ctx.first} ${ctx.last}`,
    title: () => ctx.jobTitle,
    company: () => ctx.company,
    city: () => ctx.city,
    state: () => ctx.state,
    hq_city: () => ctx.hqCity,
    hq_state: () => ctx.hqState,
    sqft_small: () => thousands(rng.int(25, 95) * 100),
    sqft: () => thousands(rng.int(10, 45) * 1000),
    sqft_large: () => thousands(rng.int(55, 240) * 1000),
    units_small: () => String(rng.int(4, 18)),
    units: () => String(rng.int(20, 90)),
    units_large: () => String(rng.int(100, 320)),
    budget: () => money(rng.int(8, 90) * 1000),
    phone: () => ctx.phone || `+1-614-555-01${String(rng.int(0, 99)).padStart(2, '0')}`,
    url: () => ctx.url || `https://${slug(ctx.company || `${ctx.first}${ctx.last}`)}.example.com/drawings`,
    spam_url: () => `https://${rng.pick(['win-now', 'bonus-city', 'free-coins', 'cheap-likes', 'prize-desk'])}.example.net/${rng.pick(['x7', 'go', 'promo', 'r/2931', 'claim'])}`,
    tonnage: () => String(rng.int(5, 40) * 5),
    rtu_count: () => String(rng.int(2, 14)),
    sites: () => String(rng.int(3, 11)),
    equipment: () => rng.pick(EQUIPMENT),
    brand: () => rng.pick(BRANDS),
    building: () => rng.pick(BUILDINGS),
    timeline: () => rng.pick(TIMELINES),
    urgent_time: () => rng.pick(URGENT_TIMES),
    month: () => rng.pick(MONTHS),
    weekday: () => rng.pick(WEEKDAYS),
    contract_no: () => `MA-${rng.int(10000, 99999)}`,
    ticket_no: () => `T-${rng.int(10000, 99999)}`,
    invoice_no: () => `INV-${rng.int(10000, 99999)}`,
    tech: () => rng.pick(FIRST_NAMES),
    vendor_product: () => rng.pick(VENDOR_PRODUCTS),
    school: () => rng.pick(SCHOOLS),
    cert: () => rng.pick(CERTS),
    years: () => String(rng.int(2, 22)),
    trade_school_year: () => rng.pick(TRADE_YEARS),
  };
  return t.message.replace(/\{([a-z_]+)\}/g, (_, slot: string) => {
    const fill = values[slot];
    if (!fill) throw new Error(`template ${t.id}: unknown slot ${slot}`);
    return fill();
  });
}

function addTypos(text: string, rng: Rng, rate: number): string {
  return text.replace(/\b[a-zA-Z]{4,}\b/g, (word) => {
    if (!rng.chance(rate)) return word;
    const i = rng.int(1, word.length - 3);
    return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
  });
}

const TYPO_ODDS = { easy: 0.08, medium: 0.15, hard: 0.25 };

function addNoise(message: string, t: LeadTemplate, rng: Rng, ctx: { first: string; last: string; jobTitle: string; phone: string }): string {
  // Spam text is left as written: it has its own style, and its links must survive.
  if (t.category === 'spam' || (t.tags ?? []).includes('injection')) return message;
  let text = message;
  if (rng.chance(TYPO_ODDS[t.difficulty])) text = addTypos(text, rng, 0.06);
  if (rng.chance(0.1)) text = text.toLowerCase();
  if (rng.chance(0.06)) text = text.replace(/[,.;:]/g, '');
  if (rng.chance(0.15)) text = `${rng.pick(['Hi,', 'Hello,', 'Good morning,', 'Hi there,', 'To whom it may concern,'])} ${text}`;
  if (rng.chance(0.08)) {
    text = `${text}\n\n${rng.pick(['Sent from my iPhone', 'Sent from my phone', 'Please excuse typos'])}`;
  } else if (rng.chance(0.15)) {
    const signature = [`${ctx.first} ${ctx.last}`, ctx.jobTitle, ctx.phone].filter(Boolean).join('\n');
    text = `${text}\n\n${rng.pick(['Thanks,', 'Regards,', 'Thank you,'])}\n${signature}`;
  }
  return text;
}

export interface GenerateOptions {
  seed: number;
  count: number;
  split: 'dev' | 'test';
  templates: LeadTemplate[];
}

export function generateLeads({ seed, count, split, templates }: GenerateOptions): LabeledLead[] {
  const problems = validateTemplates(templates);
  if (problems.length > 0) throw new Error(`invalid templates:\n${problems.join('\n')}`);

  const rng = createRng(seed);
  const resubmissions = Math.round(count * RESUBMISSION_RATE);
  const base = count - resubmissions;

  // Largest-remainder allocation, so the counts always add up.
  const shares = CATEGORIES.map((category) => ({ category, exact: CATEGORY_WEIGHTS[category] * base }));
  const allocated = new Map(shares.map((s) => [s.category, Math.floor(s.exact)]));
  const leftover = base - [...allocated.values()].reduce((a, b) => a + b, 0);
  [...shares]
    .sort((a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)))
    .slice(0, leftover)
    .forEach((s) => allocated.set(s.category, allocated.get(s.category)! + 1));

  const chosen: LeadTemplate[] = [];
  for (const category of CATEGORIES) {
    const pool = templates.filter((t) => t.category === category);
    if (pool.length === 0) throw new Error(`no templates for category ${category}`);
    let deck: LeadTemplate[] = [];
    for (let i = 0; i < allocated.get(category)!; i += 1) {
      if (deck.length === 0) deck = rng.shuffle(pool);
      chosen.push(deck.pop()!);
    }
  }

  const start = Date.UTC(2026, 8, 1);
  const windowMs = 60 * 24 * 3600 * 1000;
  const leads: LabeledLead[] = [];

  for (const t of rng.shuffle(chosen)) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);

    const companyKind = t.form.company_kind;
    const company = companyKind === 'none' ? '' : `${rng.pick(NAME_WORDS)} ${rng.pick(COMPANY_SUFFIXES[companyKind])}`;
    const domain = `${slug(company || `${first}${last}`)}.example.com`;

    let email: string;
    if (t.form.email_kind === 'company') {
      const local = rng.pick([`${first}.${last}`, `${first[0]}${last}`, first, 'info', 'office']).toLowerCase();
      email = `${local}@${domain}`;
    } else if (t.form.email_kind === 'freemail') {
      const local = rng.pick([`${first}.${last}${rng.int(1, 99)}`, `${first}${last}`, `${first[0]}.${last}${rng.int(1, 9)}`]).toLowerCase();
      email = `${local}@${rng.pick(FREEMAIL_DOMAINS)}`;
    } else {
      email = `${rng.pick(['x7f2k', 'qq9921', 'promo88', 'user4471', 'zzkt3'])}${rng.int(100, 999)}@${rng.pick(DISPOSABLE_DOMAINS)}`;
    }

    let city: string;
    let state: string;
    let areaCode: string;
    if (t.form.region === 'out_of_area') [city, state, areaCode] = rng.pick(OUT_OF_AREA);
    else [city, state, areaCode] = rng.pick(IN_AREA);
    const [hqCity, hqState] = rng.pick(HQ_ELSEWHERE);

    const phone = rng.chance(0.25) ? '' : `+1-${areaCode}-555-01${String(rng.int(0, 99)).padStart(2, '0')}`;
    const jobTitle = t.form.title_kind === 'none' ? '' : rng.pick(TITLES[t.form.title_kind]);
    const url = t.form.website ? `https://www.${domain}` : '';

    const ctx = { first, last, company, jobTitle, city, state, hqCity, hqState, phone, url };
    const filled = fillSlots(t, rng, ctx);
    const message = addNoise(filled, t, rng, ctx);
    const showLocation = t.form.location_field !== false;

    leads.push({
      id: '',
      synthetic: true,
      submitted_at: '',
      form: {
        first_name: first,
        last_name: last,
        email,
        phone,
        company,
        job_title: jobTitle,
        website: url,
        property_city: showLocation ? city : '',
        property_state: showLocation ? state : '',
        inquiry_type: t.form.inquiry_type,
        customer_number: t.form.customer_number ? `MA-${rng.int(10000, 99999)}` : '',
        message,
        hp_field: t.form.honeypot ? rng.pick(['1', 'yes', 'on', 'http://bot.example.net']) : '',
      },
      label: {
        category: t.category,
        priority: t.priority,
        difficulty: t.difficulty,
        tags: [...(t.tags ?? [])],
      },
      generator: { version: GENERATOR_VERSION, seed, split, template_id: t.id },
    });
  }

  // Someone double-clicks or comes back later: same person, same text, a new submission.
  const original = rng.shuffle(leads.map((_, i) => i)).slice(0, resubmissions);
  const copies = original.map((index) => {
    const source = leads[index];
    return {
      lead: structuredClone(source),
      after: index,
    };
  });

  const stamps = Array.from({ length: base }, () => start + Math.floor(rng.next() * windowMs)).sort((a, b) => a - b);
  leads.forEach((lead, i) => {
    lead.submitted_at = new Date(stamps[i]).toISOString();
  });

  const prefix = split === 'dev' ? 'L-DEV' : 'L-TEST';
  const pad = (n: number) => String(n).padStart(4, '0');
  leads.forEach((lead, i) => {
    lead.id = `${prefix}-${pad(i + 1)}`;
  });
  copies.forEach(({ lead, after }, i) => {
    const source = leads[after];
    lead.id = `${prefix}-${pad(base + i + 1)}`;
    lead.submitted_at = new Date(Date.parse(source.submitted_at) + rng.int(1, 240) * 60_000).toISOString();
    lead.generator.resubmission_of = source.id;
    lead.label.tags = [...lead.label.tags, 'resubmission'];
    leads.push(lead);
  });

  return leads;
}

export function toJsonl(leads: LabeledLead[]): string {
  return `${leads.map((lead) => JSON.stringify(lead)).join('\n')}\n`;
}
