import pg from 'pg';

const client = new pg.Client({
  connectionString: 'postgresql://postgres.dkrtsqienlhpouohmfki:Kunallunkad%40123@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres'
});

await client.connect();

console.log('=== 1. Batch BDM/2609056 Details ===');
const batchId = '34d352ef-26a9-482f-81a4-b83f11ad6a7d';
const bRes = await client.query('SELECT * FROM batches WHERE id = $1', [batchId]);
console.log('Batch row:', bRes.rows[0]);

// Check ledger / movements
const moveRes = await client.query(`
  SELECT * FROM inventory_operational_physical_ledger 
  WHERE batch_id = $1 
  ORDER BY event_timestamp ASC;
`, [batchId]).catch(() => ({ rows: [] }));
console.log('Operational ledger rows for BDM/2609056:', moveRes.rows);

console.log('\n=== 2. Delivery Challans Table Columns ===');
const dcCols = await client.query(`
  SELECT column_name FROM information_schema.columns WHERE table_name = 'delivery_challans';
`);
console.log('DC Columns:', dcCols.rows.map(r => r.column_name));

const dcRes = await client.query(`
  SELECT dc.*
  FROM delivery_challans dc
  WHERE dc.challan_number IN ('DO-26-0079', 'DO-26-0080');
`);
console.log('DO-26-0079 & DO-26-0080 rows:');
for (const r of dcRes.rows) {
  console.log(r);
}

await client.end();
