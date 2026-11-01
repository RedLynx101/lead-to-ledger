export const CATEGORIES = ['sales_ready', 'needs_info', 'not_a_fit', 'existing_customer', 'vendor_pitch', 'job_seeker', 'spam'] as const;
export type Category = (typeof CATEGORIES)[number];

export const PRIORITIES = ['high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const INQUIRY_TYPES = ['new_project', 'existing_service', 'careers', 'vendor', 'other'] as const;
export type InquiryType = (typeof INQUIRY_TYPES)[number];

export const REGIONS = ['in_area', 'out_of_area', 'in_area_hq_elsewhere'] as const;
export const EMAIL_KINDS = ['company', 'freemail', 'disposable'] as const;
export const COMPANY_KINDS = ['property', 'business', 'institution', 'vendor', 'none'] as const;
export const TITLE_KINDS = ['facilities', 'owner', 'sales', 'student', 'none'] as const;

export interface LeadTemplate {
  id: string;
  category: Category;
  priority: Priority;
  difficulty: Difficulty;
  tags?: string[];
  form: {
    inquiry_type: InquiryType;
    region: (typeof REGIONS)[number];
    email_kind: (typeof EMAIL_KINDS)[number];
    company_kind: (typeof COMPANY_KINDS)[number];
    title_kind: (typeof TITLE_KINDS)[number];
    website?: boolean;
    honeypot?: boolean;
    customer_number?: boolean;
    /** False leaves the property city and state fields empty. Default true. */
    location_field?: boolean;
  };
  message: string;
}

/** What the web form collects. This is all the rules and the classifier ever see. */
export interface LeadForm {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  company: string;
  job_title: string;
  website: string;
  property_city: string;
  property_state: string;
  inquiry_type: InquiryType;
  customer_number: string;
  message: string;
  /** Hidden from people by CSS. Only bots fill it in. */
  hp_field: string;
}

export interface LabeledLead {
  id: string;
  /** Always true. These are generated, not collected. */
  synthetic: true;
  submitted_at: string;
  form: LeadForm;
  label: {
    category: Category;
    priority: Priority;
    difficulty: Difficulty;
    tags: string[];
  };
  generator: {
    version: number;
    seed: number;
    split: 'dev' | 'test';
    template_id: string;
    /** Set when this lead repeats an earlier form submission. */
    resubmission_of?: string;
  };
}
