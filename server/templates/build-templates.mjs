// Regenerates the token-merged Word templates from the firm's originals in
// ./sources. The boilerplate is left byte-for-byte intact — we only insert
// docxtemplater {tokens} after the blank labels (Insured, Policy #, Claim #,
// Date of Loss, Loss Address / Insured Location, Cause of Loss, and the
// "Dear ___," salutation). Each replacement is an exact match verified against
// the source document.xml; a missing match throws (so a template revision can't
// silently produce an un-tokenized file).
//
//   Run:  node server/templates/build-templates.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import PizZip from 'pizzip';

const here = dirname(fileURLToPath(import.meta.url));
const src = (n) => join(here, 'sources', n);
const out = (n) => join(here, n);

const JOBS = [
  {
    source: 'welcome-letter.docx',
    target: 'welcome-letter.docx',
    replacements: [
      ['<w:t>Insured:</w:t>', '<w:t xml:space="preserve">Insured: {insured}</w:t>'],
      ['<w:t>Policy Number:</w:t>', '<w:t xml:space="preserve">Policy Number: {policy_number}</w:t>'],
      ['<w:t>Claim Number:</w:t>', '<w:t xml:space="preserve">Claim Number: {claim_number}</w:t>'],
      ['<w:t>Date of Loss:</w:t>', '<w:t xml:space="preserve">Date of Loss: {date_of_loss}</w:t>'],
      ['<w:t>Insured Location:</w:t>', '<w:t xml:space="preserve">Insured Location: {loss_address}</w:t>'],
      ['<w:t>Dear ____,</w:t>', '<w:t xml:space="preserve">Dear {salutation},</w:t>'],
    ],
  },
  {
    source: 'notice-to-insurance.docx',
    target: 'notice-to-insurance.docx',
    replacements: [
      ['<w:t>Insured:</w:t>', '<w:t xml:space="preserve">Insured: {insured}</w:t>'],
      ['<w:t xml:space="preserve">Loss Address: </w:t>', '<w:t xml:space="preserve">Loss Address: {loss_address}</w:t>'],
      ['<w:t>Claim #:</w:t>', '<w:t xml:space="preserve">Claim #: {claim_number}</w:t>'],
      ['<w:t xml:space="preserve">Policy #: </w:t>', '<w:t xml:space="preserve">Policy #: {policy_number}</w:t>'],
      ['<w:t xml:space="preserve">Date of Loss: </w:t>', '<w:t xml:space="preserve">Date of Loss: {date_of_loss}</w:t>'],
      ['<w:t xml:space="preserve">Cause of loss: </w:t>', '<w:t xml:space="preserve">Cause of loss: {cause_of_loss}</w:t>'],
    ],
  },
];

for (const job of JOBS) {
  const zip = new PizZip(readFileSync(src(job.source)));
  let xml = zip.file('word/document.xml').asText();
  for (const [from, to] of job.replacements) {
    if (!xml.includes(from)) throw new Error(`[${job.source}] expected text not found: ${from}`);
    xml = xml.split(from).join(to);
  }
  zip.file('word/document.xml', xml);
  writeFileSync(out(job.target), zip.generate({ type: 'nodebuffer' }));
  console.log(`wrote ${job.target}`);
}
