import { createHash, randomUUID } from 'node:crypto';
import { HttpError, nowIso } from './http.js';
const mapProduct=r=>({id:r.id,sku:r.sku,name:r.name,pricePaise:r.price_paise,priceRupees:r.price_paise/100,stockOnHand:r.stock_on_hand,reserved:r.reserved,available:r.stock_on_hand-r.reserved});
const mapOrder=r=>({id:r.id,customerName:r.customer_name,status:r.status,totalPaise:r.total_paise,totalRupees:r.total_paise/100,createdAt:r.created_at,updatedAt:r.updated_at});
function integer(value,field,min=1,max=10000){if(!Number.isInteger(value)||value<min||value>max)throw new HttpError(422,`${field} must be an integer between ${min} and ${max}`);return value;}
function rollback(db,error){try{db.exec('ROLLBACK');}catch{}throw error;}
export function listProducts(db){return db.prepare('SELECT * FROM products ORDER BY name').all().map(mapProduct);}
export function listOrders(db){return db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 50').all().map(mapOrder);}
export function getOrder(db,id){const row=db.prepare('SELECT * FROM orders WHERE id=?').get(id);if(!row)throw new HttpError(404,'Order not found');const items=db.prepare('SELECT sku,product_name AS productName,unit_price_paise AS unitPricePaise,quantity,line_total_paise AS lineTotalPaise FROM order_items WHERE order_id=?').all(id);return {...mapOrder(row),items,events:db.prepare('SELECT event_type AS type,details,created_at AS createdAt FROM order_events WHERE order_id=? ORDER BY created_at').all(id)};}
export function createOrder(db,input,idempotencyKey){
  if(typeof idempotencyKey!=='string'||idempotencyKey.length<8||idempotencyKey.length>128)throw new HttpError(400,'Idempotency-Key header (8–128 characters) is required');
  const customerName=typeof input.customerName==='string'?input.customerName.trim():'';
  if(!customerName||customerName.length>120)throw new HttpError(422,'customerName is required (maximum 120 characters)');
  if(!Array.isArray(input.items)||input.items.length<1||input.items.length>30)throw new HttpError(422,'items must contain between 1 and 30 products');
  const normalized=input.items.map((item)=>({sku:typeof item.sku==='string'?item.sku.trim():'',quantity:integer(item.quantity,'quantity')}));
  if(normalized.some(x=>!x.sku)||new Set(normalized.map(x=>x.sku)).size!==normalized.length)throw new HttpError(422,'Each item must have a unique, non-empty SKU');
  normalized.sort((a,b)=>a.sku.localeCompare(b.sku));
  const requestHash=createHash('sha256').update(JSON.stringify({customerName,items:normalized})).digest('hex');
  db.exec('BEGIN IMMEDIATE');
  try{
    const prior=db.prepare('SELECT * FROM orders WHERE idempotency_key=?').get(idempotencyKey);
    if(prior){if(prior.request_hash!==requestHash)throw new HttpError(409,'Idempotency key was already used with a different request');db.exec('COMMIT');return {order:getOrder(db,prior.id),replayed:true};}
    const lines=[];let total=0;
    for(const item of normalized){const product=db.prepare('SELECT * FROM products WHERE sku=?').get(item.sku);if(!product)throw new HttpError(404,`Unknown SKU: ${item.sku}`);const available=product.stock_on_hand-product.reserved;if(available<item.quantity)throw new HttpError(409,`Insufficient stock for ${item.sku}`,{available,requested:item.quantity});const lineTotal=product.price_paise*item.quantity;total+=lineTotal;lines.push({product,quantity:item.quantity,lineTotal});}
    const id=randomUUID(),stamp=nowIso();
    db.prepare(`INSERT INTO orders(id,idempotency_key,request_hash,customer_name,status,total_paise,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?,?)`).run(id,idempotencyKey,requestHash,customerName,total,stamp,stamp);
    const update=db.prepare('UPDATE products SET reserved=reserved+?,updated_at=? WHERE id=? AND stock_on_hand-reserved>=?');
    const lineInsert=db.prepare('INSERT INTO order_items(id,order_id,product_id,sku,product_name,unit_price_paise,quantity,line_total_paise) VALUES(?,?,?,?,?,?,?,?)');
    for(const line of lines){const result=update.run(line.quantity,stamp,line.product.id,line.quantity);if(result.changes!==1)throw new HttpError(409,`Stock changed while reserving ${line.product.sku}`);lineInsert.run(randomUUID(),id,line.product.id,line.product.sku,line.product.name,line.product.price_paise,line.quantity,line.lineTotal);}
    db.prepare('INSERT INTO order_events(id,order_id,event_type,details,created_at) VALUES(?,?,\'created\',?,?)').run(randomUUID(),id,'Stock reserved; awaiting confirmation',stamp);
    db.exec('COMMIT');return {order:getOrder(db,id),replayed:false};
  }catch(error){return rollback(db,error);}
}
export function transitionOrder(db,id,target){
  if(!['confirmed','cancelled'].includes(target))throw new HttpError(422,'Target status must be confirmed or cancelled');
  db.exec('BEGIN IMMEDIATE');
  try{
    const order=db.prepare('SELECT * FROM orders WHERE id=?').get(id);if(!order)throw new HttpError(404,'Order not found');
    if(order.status!=='pending')throw new HttpError(409,`Only pending orders can be changed; current status is ${order.status}`);
    const lines=db.prepare('SELECT * FROM order_items WHERE order_id=?').all(id);const stamp=nowIso();
    for(const line of lines){if(target==='confirmed'){
      const result=db.prepare('UPDATE products SET stock_on_hand=stock_on_hand-?,reserved=reserved-?,updated_at=? WHERE id=? AND reserved>=? AND stock_on_hand>=?').run(line.quantity,line.quantity,stamp,line.product_id,line.quantity,line.quantity);
      if(result.changes!==1)throw new HttpError(409,`Inventory invariant failed for ${line.sku}`);
    }else{
      db.prepare('UPDATE products SET reserved=reserved-?,updated_at=? WHERE id=? AND reserved>=?').run(line.quantity,stamp,line.product_id,line.quantity);
    }}
    db.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=?').run(target,stamp,id);
    db.prepare('INSERT INTO order_events(id,order_id,event_type,details,created_at) VALUES(?,?,?,?,?)').run(randomUUID(),id,target,`Order ${target}`,stamp);
    db.exec('COMMIT');return getOrder(db,id);
  }catch(error){return rollback(db,error);}
}
export function inventorySummary(db){const row=db.prepare('SELECT COUNT(*) AS sku_count,SUM(stock_on_hand) AS units,SUM(reserved) AS reserved FROM products').get();return {...row,available:row.units-row.reserved,openOrders:db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status='pending'").get().count};}
