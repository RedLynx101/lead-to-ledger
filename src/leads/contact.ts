// What a form submission sets on a contact, and how a submission gets its key. This
// file has no imports because the mapping also runs inside the n8n Code node.

export interface ContactForm {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  company: string;
  job_title: string;
  website: string;
  property_city: string;
  property_state: string;
  message: string;
}

/** The form's contact fields. Never lifecycle stage, lead status, owner or an ai_ field. */
export const CONTACT_FIELDS = ['firstname', 'lastname', 'phone', 'company', 'jobtitle', 'website', 'city', 'state', 'message'] as const;

export function contactProperties(form: ContactForm, synthetic: boolean): Record<string, string | boolean> {
  const properties: Record<string, string | boolean> = {};
  const set = (name: string, value: string | undefined) => {
    if (value) properties[name] = value;
  };
  set('firstname', form.first_name);
  set('lastname', form.last_name);
  set('phone', form.phone);
  set('company', form.company);
  set('jobtitle', form.job_title);
  set('website', form.website);
  set('city', form.property_city);
  set('state', form.property_state);
  set('message', form.message);
  if (synthetic) properties.ltl_synthetic = true;
  return properties;
}
