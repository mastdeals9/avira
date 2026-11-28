import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const translationsSource = fs.readFileSync(path.resolve('src/i18n/translations.ts'), 'utf8');
const match = translationsSource.match(/export const translations\s*=\s*([\s\S]*);\s*$/);
assert.ok(match, 'Could not parse translations object from src/i18n/translations.ts');
const translations = new Function(`return ${match[1]}`)();

function flattenKeys(obj, prefix = '') {
  const keys = new Set();
  for (const [k, v] of Object.entries(obj || {})) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const child of flattenKeys(v, full)) keys.add(child);
    } else {
      keys.add(full);
    }
  }
  return keys;
}

function collectSourceFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

test('English and Bahasa Indonesia translation dictionaries have 100% key parity', () => {
  const enKeys = flattenKeys(translations.en);
  const idKeys = flattenKeys(translations.id);

  const missingInId = [...enKeys].filter((k) => !idKeys.has(k));
  const missingInEn = [...idKeys].filter((k) => !enKeys.has(k));

  assert.deepEqual(missingInId, [], `Keys present in EN but missing in ID: ${missingInId.join(', ')}`);
  assert.deepEqual(missingInEn, [], `Keys present in ID but missing in EN: ${missingInEn.join(', ')}`);
});

test('All static t(...) keys used in src/ exist in both EN and ID dictionaries', () => {
  const enKeys = flattenKeys(translations.en);
  const idKeys = flattenKeys(translations.id);
  const usedKeys = new Set();

  for (const file of collectSourceFiles(path.resolve('src'))) {
    const content = fs.readFileSync(file, 'utf8');
    for (const m of content.matchAll(/\bt\(\s*['"]([a-zA-Z0-9_.-]+)['"]/g)) {
      usedKeys.add(m[1]);
    }
  }

  const missingEn = [...usedKeys].filter((k) => !enKeys.has(k));
  const missingId = [...usedKeys].filter((k) => !idKeys.has(k));

  assert.deepEqual(missingEn, [], `Used t(...) keys missing from EN: ${missingEn.join(', ')}`);
  assert.deepEqual(missingId, [], `Used t(...) keys missing from ID: ${missingId.join(', ')}`);
});
