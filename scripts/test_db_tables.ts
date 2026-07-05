import { createClient } from '@libsql/client';
import path from 'path';

const dbUrl = 'file:' + path.resolve('dev.db').replace(/\\/g, '/');
console.log('Opening database at:', dbUrl);

const client = createClient({ url: dbUrl });

async function main() {
  try {
    const rs = await client.execute("SELECT name FROM sqlite_master WHERE type='table';");
    console.log('Tables found in database:');
    console.log(JSON.stringify(rs.rows, null, 2));
  } catch (err) {
    console.error('Error querying database:', err);
  } finally {
    client.close();
  }
}

main();
