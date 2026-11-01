// Fails if a tracked or staged file holds something that shouldn't be in a public repo:
// a real email address, a real phone number, or one of the owner's domains.
//
// The forbidden domains are compared as SHA-256 hashes so this file doesn't contain
// the very strings it looks for. gitleaks covers credentials; this covers the rest.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const FORBIDDEN_DOMAIN_HASHES = new Set([
  '0e72a491898d564590e24682170258b8e0eec3d207c0372a5ab9c232b714d370',
  'd4ace259a23fcbcf91efe6fa44ffa4b71ae3dd17f076ebe33d25cd0f171ae775',
]);

/** Reserved for documentation (RFC 2606), or a no-reply address that reaches nobody. */
const ALLOWED_EMAIL_DOMAIN = /(^|\.)(example\.(com|net|org)|example|test|invalid|localhost|users\.noreply\.github\.com)$/;
const ALLOWED_EMAILS = new Set(['noreply@anthropic.com']);

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const DOMAIN = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/gi;
// A North American number, written with separators so hashes and timestamps don't match.
const PHONE = /(?<![\d-])(?:\+?1[-. ])?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}(?![\d-])/g;
const FICTIONAL_PHONE = /555[-. ]01\d{2}$/;

const sha256 = (text: string) => createHash('sha256').update(text.toLowerCase()).digest('hex');

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((file) => file !== 'package-lock.json');

const problems: string[] = [];
for (const file of files) {
  let text: string;
  try {
    text = readFileSync(path.join(ROOT, file), 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\0')) continue;
  text.split('\n').forEach((line, index) => {
    const where = `${file}:${index + 1}`;
    for (const match of line.matchAll(EMAIL)) {
      if (ALLOWED_EMAILS.has(match[0].toLowerCase())) continue;
      if (!ALLOWED_EMAIL_DOMAIN.test(match[1].toLowerCase())) problems.push(`${where}: email on a non-reserved domain (${match[1]})`);
    }
    for (const match of line.matchAll(DOMAIN)) {
      if (FORBIDDEN_DOMAIN_HASHES.has(sha256(match[1]))) problems.push(`${where}: forbidden domain`);
    }
    for (const match of line.matchAll(PHONE)) {
      if (!FICTIONAL_PHONE.test(match[0])) problems.push(`${where}: phone number outside the 555-01xx block (${match[0]})`);
    }
  });
}

if (problems.length > 0) {
  console.error(`${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`scanned ${files.length} files: clean`);
