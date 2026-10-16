'use strict';

const path = require('node:path');
const Model = require('../file-renamer/model');
const data = require('../file-renamer/concepts.json');

function validateFilename(filename) {
  const ext = path.extname(filename);
  if (!/^\.html?$/i.test(ext)) {
    return { valid: false, errors: ['The file must end in .html or .htm.'] };
  }

  const base = filename.slice(0, -ext.length);
  const fields = base.split('_');
  if (fields.length !== 11) {
    return {
      valid: false,
      errors: [
        'Expected 11 underscore-separated parts: brand_acslanot_type_YYYYMMDD_version_creator_concept1_concept2_concept3_subconcept_theme.html.',
      ],
    };
  }

  const [brand, fixed, creativeType, compactDate, version, creator,
    concept1, concept2, concept3, subconcept, theme] = fields;
  const errors = [];

  const issue = (label, value, requirement) => {
    errors.push(`${label}: "${value || '(empty)'}" ${requirement}`);
  };
  const formatOptions = (options) => {
    const formatted = options.map((option) => `\`${option}\``);
    if (formatted.length < 2) return formatted[0] || '';
    return `${formatted.slice(0, -1).join(', ')}, or ${formatted.at(-1)}`;
  };

  if (!/^[a-z0-9-]+$/.test(brand)) issue('brand', brand, 'may contain only lowercase letters, digits, and hyphens.');
  if (fixed !== 'acslanot') issue('fixed segment', fixed, 'must be `acslanot`.');
  if (!['mip', 'sip'].includes(creativeType)) issue('creativeType', creativeType, 'must be `mip` or `sip`.');

  let dateValid = false;
  if (/^\d{8}$/.test(compactDate) && !compactDate.startsWith('0000')) {
    const isoDate = `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6, 8)}`;
    const parsedDate = new Date(isoDate);
    dateValid = Number.isFinite(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === isoDate;
  }
  if (!dateValid) issue('date', compactDate, 'must be a real calendar date in YYYYMMDD format.');

  const validVersion = /^[0-9]+$/.test(version) && /[1-9]/.test(version);
  if (!validVersion) issue('version', version, 'must be a positive integer.');
  else if (version.length < 2 || version.startsWith('0') && version.length > 2) {
    issue('version', version, 'must use File Renamer padding (for example, `01`, not `1` or `001`).');
  }

  const builtInCreators = ['emily', 'haley', 'lingyun', 'charlotte', 'ecomm'];
  if (!/^[a-z0-9-]+$/.test(creator)) issue('creator', creator, 'may contain only lowercase letters, digits, and hyphens.');

  if (!Object.hasOwn(data.concepts, concept1)) {
    issue('concept1', concept1, `must be one of: ${formatOptions(Object.keys(data.concepts))}.`);
  }
  const possibleConcept2 = Object.hasOwn(data.concepts, concept1)
    ? data.concepts[concept1].children
    : Object.assign({}, ...Object.values(data.concepts).map((concept) => concept.children));
  if (concept2 !== 'unknown' && !Object.hasOwn(possibleConcept2, concept2)) {
    issue('concept2', concept2, 'is not a supported value for the selected concept.');
  }
  if (!Object.hasOwn(data.concept3, concept3)) issue('concept3', concept3, 'must be `ai`, `human`, or `aiassisted`.');
  if (!Object.hasOwn(data.subconcept, subconcept)) {
    issue('subconcept', subconcept, `must be one of: ${formatOptions(Object.keys(data.subconcept))}.`);
  }
  if (!Object.hasOwn(data.theme, theme)) {
    issue('theme', theme, 'is not a supported value for theme.');
  }

  if (errors.length) return { valid: false, errors };

  const values = {
    brand,
    creativeType,
    date: `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6, 8)}`,
    version,
    creator: builtInCreators.includes(creator) ? creator : 'custom',
    customCreator: creator,
    concept1,
    concept2,
    concept3,
    subconcept,
    theme,
  };

  try {
    // `unknown` is a valid checker value for concept2 across all concept1 values.
    const filenameData = concept2 === 'unknown'
      ? {
        ...data,
        concepts: Object.fromEntries(Object.entries(data.concepts).map(([key, concept]) => [
          key,
          { ...concept, children: { ...concept.children, unknown: 'Unknown concept2' } },
        ])),
      }
      : data;
    const expected = Model.filename(values, ext, filenameData);
    if (expected !== filename) {
      errors.push('The filename is not in the canonical File Renamer format. Use lowercase values and the standard two-digit version.');
    }
  } catch (error) {
    errors.push(error.message);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validateFilename };
