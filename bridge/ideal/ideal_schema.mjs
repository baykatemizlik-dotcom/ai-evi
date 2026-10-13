// Expand only the quotes source CHECK. Transaction preserves rows, indexes, triggers.
export function migrateIdealQuotes(sql){
 const row=sql.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='strategy_quotes'").get();
 if(!row)throw Error('STRATEGY_QUOTES_TABLE_MISSING');
 if(row.sql.includes("'IDEAL_LIVE'"))return;
 const old="source IN('YAHOO_INDICATIVE','MATRIKSIQ_DELAYED_DEMO')";
 if(!row.sql.includes(old))throw Error('UNKNOWN_QUOTES_SCHEMA_NO_CHANGE');
 const ddl=row.sql.replace(old,"source IN('YAHOO_INDICATIVE','MATRIKSIQ_DELAYED_DEMO','IDEAL_LIVE')").replace(/CREATE TABLE\s+strategy_quotes\s*\(/i,'CREATE TABLE ideal_quotes_migration(');
 const extras=sql.prepare("SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL AND ((tbl_name='strategy_quotes' AND type IN('index','trigger')) OR (type='trigger' AND instr(sql,'strategy_quotes')>0))").all();
 sql.exec('BEGIN IMMEDIATE');
 try{
  sql.exec(ddl);sql.exec('INSERT INTO ideal_quotes_migration SELECT * FROM strategy_quotes');
  const diff=sql.prepare('SELECT * FROM strategy_quotes EXCEPT SELECT * FROM ideal_quotes_migration').get();
  if(diff)throw Error('QUOTES_MIGRATION_ROW_MISMATCH');
  for(const x of extras)if(x.type==='trigger')sql.exec('DROP TRIGGER '+JSON.stringify(x.name));
  sql.exec('DROP TABLE strategy_quotes; ALTER TABLE ideal_quotes_migration RENAME TO strategy_quotes;');
  for(const x of extras)sql.exec(x.sql);
  sql.exec('COMMIT');
 }catch(e){sql.exec('ROLLBACK');throw e;}
}
