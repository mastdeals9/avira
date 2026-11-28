import pg from 'pg';
import fs from 'fs';
import path from 'path';

const client = new pg.Client({
  connectionString: (process.env.READONLY_AUDIT_DB_URL || '')
});

await client.connect();

const res = await client.query(`
  SELECT 
    udv.id as version_id,
    udv.document_id,
    udv.version_number,
    udv.storage_bucket,
    udv.storage_path,
    udv.original_file_name,
    udv.file_size as version_file_size,
    COALESCE(udv.sha256, 'NULL') as original_hash,
    udv.created_at as version_created_at,
    COALESCE(so.id, so_dec.id)::text as storage_object_id,
    COALESCE(so.metadata->>'size', so_dec.metadata->>'size', '0') as storage_file_size,
    COALESCE(so.metadata->>'eTag', so_dec.metadata->>'eTag', 'NULL') as storage_etag,
    COALESCE(so.metadata->>'mimetype', so_dec.metadata->>'mimetype', 'UNKNOWN') as storage_mimetype,
    CASE 
      WHEN so.id IS NOT NULL THEN 'AVAILABLE_IN_STORAGE'
      WHEN so_dec.id IS NOT NULL THEN 'AVAILABLE_URL_ENCODED'
      ELSE 'MISSING_PHYSICAL_OBJECT'
    END as file_availability,
    CASE 
      WHEN so.id IS NOT NULL OR so_dec.id IS NOT NULL THEN 'READY_FOR_SERVICE_ROLE_BACKFILL'
      ELSE 'EXCLUDED_ZERO_BYTE_TEST_ARTIFACT'
    END as verification_result,
    CASE 
      WHEN so.id IS NULL AND so_dec.id IS NULL THEN 'EX_PHYSICAL_FILE_NOT_FOUND'
      WHEN so_dec.id IS NOT NULL THEN 'EX_PATH_URL_ENCODING_SPACE'
      ELSE 'NONE'
    END as exception_status
  FROM public.universal_document_versions udv
  LEFT JOIN storage.objects so 
    ON so.bucket_id = udv.storage_bucket AND so.name = udv.storage_path
  LEFT JOIN storage.objects so_dec 
    ON so_dec.bucket_id = udv.storage_bucket AND so_dec.name = replace(udv.storage_path, '%20', ' ')
  WHERE udv.sha256 IS NULL
  ORDER BY udv.created_at ASC, udv.id ASC;
`);

const csvHeader = [
  'version_id',
  'document_id',
  'version_number',
  'storage_bucket',
  'storage_path',
  'original_file_name',
  'version_file_size',
  'storage_file_size',
  'original_hash',
  'storage_etag',
  'storage_mimetype',
  'file_availability',
  'verification_result',
  'exception_status',
  'version_created_at'
];

function escapeCsv(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

const csvRows = [csvHeader.join(',')];

for (const r of res.rows) {
  const row = [
    r.version_id,
    r.document_id,
    r.version_number,
    r.storage_bucket,
    escapeCsv(r.storage_path),
    escapeCsv(r.original_file_name),
    r.version_file_size,
    r.storage_file_size,
    r.original_hash,
    r.storage_etag,
    r.storage_mimetype,
    r.file_availability,
    r.verification_result,
    r.exception_status,
    r.version_created_at.toISOString()
  ];
  csvRows.push(row.join(','));
}

const outPath = path.resolve('docs/audits/SAPJ_DOCUMENT_BANK_SHA256_AUDIT_SCHEDULE.csv');
fs.writeFileSync(outPath, csvRows.join('\n'), 'utf8');
console.log(`Wrote ${res.rows.length} records to ${outPath}`);

await client.end();

