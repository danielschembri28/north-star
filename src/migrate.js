import { migrate, pool } from './db.js';

migrate()
  .then(() => console.log('Database is up to date.'))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
