// Generates intake-sheet.docx — the clean one-page Claim Intake Sheet that
// Tessa fills when an intake arrives as a CALL RECORDING (photo/PDF intakes
// already ARE the sheet). Tokens are docxtemplater {placeholders}; each token
// is emitted as a single run so it can never be split. Run once:
//   node server/templates/build-intake-sheet.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import PizZip from 'pizzip';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const P = (text, { bold = false, size = 22, center = false, color = '000000', spaceAfter = 120 } = {}) =>
  `<w:p><w:pPr>${center ? '<w:jc w:val="center"/>' : ''}<w:spacing w:after="${spaceAfter}"/></w:pPr>` +
  `<w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:color w:val="${color}"/></w:rPr>` +
  `<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;

const CELL_BORDERS =
  '<w:tcBorders><w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/>' +
  '<w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/></w:tcBorders>';

const cell = (text, { bold = false, width, fill = 'auto' } = {}) =>
  `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${CELL_BORDERS}<w:shd w:val="clear" w:fill="${fill}"/>` +
  `<w:vAlign w:val="center"/></w:tcPr>` +
  `<w:p><w:pPr><w:spacing w:before="60" w:after="60"/></w:pPr><w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>` +
  `<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p></w:tc>`;

const row = (label, token) => `<w:tr>${cell(label, { bold: true, width: 2600, fill: 'F2EFE9' })}${cell(`{${token}}`, { width: 6800 })}</w:tr>`;

const FIELDS = [
  ['Insured Name(s)', 'insured'],
  ['Loss Address', 'loss_address'],
  ['Phone', 'phone'],
  ['Email', 'email'],
  ['Insurance Carrier', 'carrier'],
  ['Policy Number', 'policy_number'],
  ['Claim Number', 'claim_number'],
  ['Date of Loss', 'date_of_loss'],
  ['Cause of Loss', 'cause_of_loss'],
];

const documentXml =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
  P('ARMADA PUBLIC ADJUSTING', { bold: true, size: 32, center: true, spaceAfter: 40 }) +
  P('Claim Intake Sheet', { bold: true, size: 26, center: true, spaceAfter: 60 }) +
  P('Prepared {intake_date} — transcribed from a recorded intake call ({source_note})', { size: 18, center: true, color: '777777', spaceAfter: 240 }) +
  `<w:tbl><w:tblPr><w:tblW w:w="9400" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr>` +
  `<w:tblGrid><w:gridCol w:w="2600"/><w:gridCol w:w="6800"/></w:tblGrid>` +
  FIELDS.map(([label, token]) => row(label, token)).join('') +
  '</w:tbl>' +
  P('', { spaceAfter: 120 }) +
  P('Call Notes', { bold: true, size: 24, spaceAfter: 80 }) +
  P('{call_notes}', { size: 22, spaceAfter: 240 }) +
  P('Verify every field against the recording before sending anything to the carrier.', { size: 16, color: '999999' }) +
  '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1260" w:bottom="1080" w:left="1260"/></w:sectPr>' +
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
