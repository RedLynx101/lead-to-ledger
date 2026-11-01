import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { rulesConfig } from '../src/config.ts';
import { sortLead } from '../src/rules/rules.ts';
import type { RuleForm } from '../src/rules/rules.ts';

const form = (over: Partial<RuleForm> = {}): RuleForm => ({
  email: 'dana@cedarsquare.example.com',
  property_city: 'Dayton',
  property_state: 'OH',
  inquiry_type: 'new_project',
  customer_number: '',
  message: 'Need a quote on maintenance for 6 rooftop units at our office.',
  hp_field: '',
  ...over,
});

const sort = (over: Partial<RuleForm>) => sortLead(form(over), rulesConfig);

describe('rules', () => {
  test('an ordinary in-area lead goes to the model', () => {
    assert.equal(sort({}), null);
  });

  test('a filled honeypot is spam and skips the CRM', () => {
    const rule = sort({ hp_field: 'yes' });
    assert.equal(rule?.rule_id, 'honeypot');
    assert.equal(rule?.category, 'spam');
    assert.equal(rule?.skip_crm, true);
  });

  test('a throwaway domain is spam and skips the CRM', () => {
    const rule = sort({ email: 'a@tempinbox.example.net' });
    assert.equal(rule?.rule_id, 'disposable_email');
    assert.equal(rule?.skip_crm, true);
  });

  test('only the two signals a person never produces skip the CRM', () => {
    const others = [
      sort({ message: 'x https://a.example.net/1 https://a.example.net/2 https://a.example.net/3' }),
      sort({ message: 'casino bonus https://a.example.net/1' }),
      sort({ inquiry_type: 'careers' }),
      sort({ inquiry_type: 'vendor' }),
      sort({ property_state: 'FL' }),
      sort({ property_city: 'Toledo' }),
      sort({ message: 'the furnace in my house is out' }),
      sort({ customer_number: 'MA-1', inquiry_type: 'existing_service', message: 'please move our visit' }),
    ];
    assert.ok(others.every((rule) => rule !== null && rule.skip_crm === false));
  });

  test('three links is spam; one or two is not', () => {
    assert.equal(sort({ message: 'see https://a.example.net/1 and https://a.example.net/2' }), null);
    assert.equal(sort({ message: 'https://a.example.net/1 https://a.example.net/2 https://a.example.net/3' })?.rule_id, 'link_stuffed');
  });

  test('junk terms need a link, so a mention alone is not enough', () => {
    assert.equal(sort({ message: 'We run a casino and need HVAC service on our rooftop units.' }), null);
    assert.equal(sort({ message: 'best casino bonus https://a.example.net/1' })?.rule_id, 'junk_terms_with_link');
  });

  test('the careers and vendor dropdowns sort directly', () => {
    assert.equal(sort({ inquiry_type: 'careers' })?.category, 'job_seeker');
    assert.equal(sort({ inquiry_type: 'vendor' })?.category, 'vendor_pitch');
  });

  test('a property state outside the service area is not a fit; case does not matter', () => {
    assert.equal(sort({ property_state: 'fl' })?.rule_id, 'state_out_of_area');
    assert.equal(sort({ property_state: 'KY', property_city: 'Covington' }), null);
  });

  test('an out-of-area city in a service state is not a fit', () => {
    assert.equal(sort({ property_city: 'cleveland' })?.rule_id, 'city_out_of_area');
    assert.equal(sort({ property_state: 'KY', property_city: 'Louisville' })?.rule_id, 'city_out_of_area');
  });

  test('blank location fields do not trigger the area rules', () => {
    assert.equal(sort({ property_city: '', property_state: '' }), null);
  });

  test('words describing a home sort as not a fit; a home office or warehouse does not', () => {
    assert.equal(sort({ message: 'Our home needs a new furnace' })?.rule_id, 'residential_words');
    assert.equal(sort({ message: 'a 3 bedroom place' })?.rule_id, 'residential_words');
    assert.equal(sort({ message: 'our home office building needs an RTU' }), null);
    assert.equal(sort({ message: 'our warehouse needs an RTU' }), null);
  });

  test('a customer number on existing service is a customer, high priority only if something is down', () => {
    const base = { customer_number: 'MA-10001', inquiry_type: 'existing_service' as const };
    assert.deepEqual([sort({ ...base, message: 'Can we move our visit?' })?.category, sort({ ...base, message: 'Can we move our visit?' })?.priority], ['existing_customer', 'normal']);
    assert.equal(sort({ ...base, message: 'RTU 3 is down' })?.priority, 'high');
    assert.equal(sort({ ...base, message: 'We have no heat' })?.priority, 'high');
  });

  test('a customer asking for new work is left to the model', () => {
    assert.equal(sort({ customer_number: 'MA-1', inquiry_type: 'existing_service', message: 'Can you quote our new location?' }), null);
  });

  test('a customer number with a different dropdown is left to the model', () => {
    assert.equal(sort({ customer_number: 'MA-1', inquiry_type: 'new_project', message: 'hello' }), null);
  });

  test('missing fields do not throw', () => {
    assert.equal(sortLead({ email: '', property_city: '', property_state: '', inquiry_type: '', customer_number: '', message: '', hp_field: '' }, rulesConfig), null);
    assert.equal(sortLead({} as RuleForm, rulesConfig), null);
  });
});
