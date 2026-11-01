// Plain rules that run before any model. If a rule sorts a lead, the model isn't
// called: that's cheaper, and a person can read why it happened.
//
// This file has no imports because it runs in two places: here, and pasted into the
// n8n Code node by scripts/build-workflow.ts. Only erasable TypeScript, so Node can
// strip the types without changing behaviour. Each rule's precision is measured by
// scripts/score.ts on the labeled sets.
//
// Only two rules skip the CRM, and both rest on signals a person never produces.
// Everything else still creates a contact, because a wrong rule should cost sales a
// glance, not a lost lead.

export interface RulesConfig {
  service_states: string[];
  out_of_area_cities: string[];
  disposable_email_domains: string[];
  free_email_domains: string[];
}

export interface RuleForm {
  email: string;
  property_city: string;
  property_state: string;
  inquiry_type: string;
  customer_number: string;
  message: string;
  hp_field: string;
}

export interface RuleDecision {
  rule_id: string;
  category: string;
  priority: string;
  reason: string;
  skip_crm: boolean;
}

export const RULES_VERSION = 'r1';

const LINK = /https?:\/\/\S+/gi;
const JUNK_TERMS = /\b(casino|crypto|bitcoin|viagra|payday|forex|betting|followers)\b/i;
const NEW_WORK = /\b(new (site|space|location|building|project)|second location|another location|additional (site|location|building)|quote|bid)\b/i;
const OUTAGE = /\b(down|no (heat|cooling|ac|a\/c|air)|not (cooling|heating|working)|out again|tripped|won'?t (start|fire|run))\b/i;
const HOME = /\b(my|our) (house|home)\b(?! office)|\bbedroom\b|\bsingle[- ]family\b/i;

function emailDomain(email: string): string {
  return String(email ?? '').toLowerCase().split('@')[1] ?? '';
}

export function sortLead(form: RuleForm, cfg: RulesConfig): RuleDecision | null {
  const message = String(form.message ?? '');
  const links = message.match(LINK) ?? [];
  const state = String(form.property_state ?? '').trim().toUpperCase();
  const city = String(form.property_city ?? '').trim().toLowerCase();
  const domain = emailDomain(form.email);

  if (String(form.hp_field ?? '').trim() !== '') {
    return { rule_id: 'honeypot', category: 'spam', priority: 'low', reason: 'Hidden form field was filled in.', skip_crm: true };
  }
  if (cfg.disposable_email_domains.includes(domain)) {
    return { rule_id: 'disposable_email', category: 'spam', priority: 'low', reason: 'Throwaway email domain.', skip_crm: true };
  }
  if (links.length >= 3) {
    return { rule_id: 'link_stuffed', category: 'spam', priority: 'low', reason: 'Three or more links in the message.', skip_crm: false };
  }
  if (JUNK_TERMS.test(message) && links.length >= 1) {
    return { rule_id: 'junk_terms_with_link', category: 'spam', priority: 'low', reason: 'Junk terms alongside a link.', skip_crm: false };
  }
  if (form.inquiry_type === 'careers') {
    return { rule_id: 'careers_dropdown', category: 'job_seeker', priority: 'low', reason: 'Chose Careers on the form.', skip_crm: false };
  }
  if (form.inquiry_type === 'vendor') {
    return { rule_id: 'vendor_dropdown', category: 'vendor_pitch', priority: 'low', reason: 'Chose Vendor on the form.', skip_crm: false };
  }
  if (state !== '' && !cfg.service_states.includes(state)) {
    return { rule_id: 'state_out_of_area', category: 'not_a_fit', priority: 'low', reason: `Property is in ${state}, outside the service area.`, skip_crm: false };
  }
  if (cfg.out_of_area_cities.includes(city)) {
    return { rule_id: 'city_out_of_area', category: 'not_a_fit', priority: 'low', reason: 'Property city is outside the service area.', skip_crm: false };
  }
  if (HOME.test(message)) {
    return { rule_id: 'residential_words', category: 'not_a_fit', priority: 'low', reason: 'Message describes a home.', skip_crm: false };
  }
  if (String(form.customer_number ?? '').trim() !== '' && form.inquiry_type === 'existing_service' && !NEW_WORK.test(message)) {
    return {
      rule_id: 'customer_number',
      category: 'existing_customer',
      priority: OUTAGE.test(message) ? 'high' : 'normal',
      reason: 'Customer number given, asking about existing service.',
      skip_crm: false,
    };
  }
  return null;
}
