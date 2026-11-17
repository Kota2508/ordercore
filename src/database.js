import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const schema=readFileSync(new URL('../database/schema.sql',import.meta.url),'utf8');
const products=[['SKU-101','Wireless Mouse',89900,45],['SKU-102','Mechanical Keyboard',349900,18],['SKU-103','USB-C Hub',159900,32],['SKU-104','Laptop Stand',129900,21],['SKU-105','Webcam 1080p',229900,12]];
export function createDatabase(dbPath=process.env.DB_PATH||'./data/ordercore.sqlite'){
  if(dbPath!==':memory:')mkdirSync(dirname(resolve(dbPath)),{recursive:true});
  const db=new DatabaseSync(dbPath);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');db.exec(schema);
  if(db.prepare('SELECT COUNT(*) AS count FROM products').get().count===0){const insert=db.prepare('INSERT INTO products(id,sku,name,price_paise,stock_on_hand,reserved,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)');const now=new Date().toISOString();for(const [sku,name,price,stock] of products)insert.run(randomUUID(),sku,name,price,stock,now,now);}
  return db;
}
