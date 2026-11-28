import pg from 'pg';

const client = new pg.Client({
  connectionString: (process.env.READONLY_AUDIT_DB_URL || ''),
  ssl: { rejectUnauthorized: false }
});

async function main() {
  await client.connect();

  const res = await client.query(`
    SELECT bucket_id, name, (metadata->>'size')::bigint as size, metadata->>'mimetype' as mime
    FROM storage.objects
    WHERE bucket_id IN ('petty-cash-receipts', 'expense-documents', 'batch-documents')
    ORDER BY (metadata->>'size')::bigint DESC
    LIMIT 30;
  `);

  console.table(res.rows.map(r => ({
    bucket: r.bucket_id,
    name: r.name.length > 40 ? r.name.slice(0, 37) + '...' : r.name,
    size_mb: (r.size / 1024 / 1024).toFixed(2),
    mime: r.mime
  })));

  // File types breakdown in top 3 buckets
  const typesRes = await client.query(`
    SELECT 
      bucket_id,
      metadata->>'mimetype' as mime,
      count(*) as count,
      round(sum((metadata->>'size')::bigint) / 1024.0 / 1024.0, 2) as total_mb
    FROM storage.objects
    WHERE bucket_id IN ('petty-cash-receipts', 'expense-documents', 'batch-documents')
    GROUP BY bucket_id, metadata->>'mimetype'
    ORDER BY total_mb DESC;
  `);
  console.log('\n=== File Types Breakdown ===');
  console.table(typesRes.rows);

  await client.end();
}

main().catch(console.error);

