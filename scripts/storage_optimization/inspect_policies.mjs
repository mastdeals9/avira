import pg from 'pg';

const client = new pg.Client({
  connectionString: (process.env.READONLY_AUDIT_DB_URL || ''),
  ssl: { rejectUnauthorized: false }
});

async function main() {
  await client.connect();
  const res = await client.query(`
    SELECT polname, polcmd, pg_get_expr(polqual, polrelid) as qual, pg_get_expr(polwithcheck, polrelid) as with_check
    FROM pg_policy
    WHERE polrelid = 'storage.objects'::regclass;
  `);
  res.rows.forEach(r => {
    console.log(`[${r.polcmd}] ${r.polname}\n  qual: ${r.qual}\n  check: ${r.with_check}\n`);
  });
  await client.end();
}

main().catch(console.error);

