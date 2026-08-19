// Generates intake-sheet.docx — a filled-in replica of the firm's real Claim
// Intake Sheet (the 27-field form the front desk uses), used when an intake
// arrives as a CALL RECORDING. Field order and wording mirror the paper form;
// unheard fields render blank so Brielle can hand-fill them. Tokens are
// docxtemplater {placeholders}, one run each so they can never split. Run:
//   node server/templates/build-intake-sheet.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import PizZip from 'pizzip';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const run = (text, { bold = false, size = 21, color = '000000' } = {}) =>
  `<w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:color w:val="${color}"/></w:rPr>` +
  `<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;

const P = (runs, { center = false, spaceAfter = 110 } = {}) =>
  `<w:p><w:pPr>${center ? '<w:jc w:val="center"/>' : ''}<w:spacing w:after="${spaceAfter}"/>` +
  `<w:pBdr><w:bottom w:val="none" w:sz="0" w:space="0" w:color="auto"/></w:pBdr></w:pPr>${runs}</w:p>`;

// One form line: bold label + answer token (+ optional second label/token pair on the same line).
const line = (label, token, label2, token2) =>
  P(
    run(`${label} `, { bold: true }) +
      run(`{${token}}`) +
      (label2 ? run(`    ${label2} `, { bold: true }) + run(`{${token2}}`) : ''),
  );

const FORM = [
  ['Insured Name:', 'insured'],
  ['Phone:', 'phone'],
  ['E-mail:', 'email'],
  ['Policy Address:', 'policy_address'],
  ['Loss Address (If different):', 'loss_address_diff'],
  ['Type of/ Describe Damage:', 'damage_description'],
  ['Any interior damage? If so, where:', 'interior_damage'],
  ['Date of Loss:', 'date_of_loss'],
  ['Who discovered the loss:', 'who_discovered'],
  ['Gated or Non-gated Community:', 'gated_community', 'Code:', 'gate_code'],
  ['Insurance Company:', 'carrier'],
  ['Policy # and Claim #:', 'policy_claim'],
  ['Did you buy your insurance, or did your mortgage provide it for you?', 'insurance_source'],
  ['Any prior claims in the last 5 years:', 'prior_claims'],
  ['Mortgage:', 'mortgage'],
];

const FORM2 = [
  ['How many stories:', 'stories'],
  ['Type of Roof/Age:', 'roof_type_age'],
  ['Slope/Pitch of the roof:', 'roof_slope'],
  ['Is a tarp needed/Installed:', 'tarp'],
  ['Anything need to be removed:', 'removal_needed'],
  ['Is it habitable/livable:', 'habitable'],
  ['Any emergency service called:', 'emergency_services'],
  ['Have any repairs been made:', 'repairs_made'],
  ['Who is the source/inspector/title:', 'source_inspector'],
  ['How did you hear about us:', 'referral'],
];

const claimStyleLine = P(
  run('Claim Style:   ', { bold: true }) +
    run('{emergency_box}') +
    run(' Emergency      ') +
    run('{non_emergency_box}') +
    run(' Non-Emergency      ') +
    run('{supplemental_box}') +
    run(' Supplemental'),
);

const documentXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
  P(run('ARMADA PUBLIC ADJUSTING', { bold: true, size: 30 }), { center: true, spaceAfter: 30 }) +
  P(run('Claim Intake Sheet', { bold: true, size: 25 }), { center: true, spaceAfter: 40 }) +
  P(run('Prepared {intake_date} — transcribed from a recorded intake call ({source_note})', { size: 16, color: '777777' }), { center: true, spaceAfter: 200 }) +
  FORM.map(([l, t, l2, t2]) => line(l, t, l2, t2)).join('') +
  claimStyleLine +
  FORM2.map(([l, t]) => line(l, t)).join('') +
  P(run('Notes:', { bold: true, size: 22 }), { spaceAfter: 60 }) +
  P(run('{call_notes}'), { spaceAfter: 200 }) +
  P(run('Verify every field against the recording before sending anything to the carrier.', { size: 15, color: '999999' })) +
  '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="900" w:right="1100" w:bottom="900" w:left="1100"/></w:sectPr>' +
  '</w:body></w:document>';

const contentTypes =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';

const rels =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

const zip = new PizZip();
zip.file('[Content_Types].xml', contentTypes);
zip.file('_rels/.rels', rels);
zip.file('word/document.xml', documentXml);

const out = join(dirname(fileURLToPath(import.meta.url)), 'intake-sheet.docx');
writeFileSync(out, zip.generate({ type: 'nodebuffer' }));
console.log(`wrote ${out}`);
