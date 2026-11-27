const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {assertAuthorized,createSession,pinKey,startupMigrations} = require('../native-authorization');
const cari = require('../cari-core');

const catalog = [{ b:'83000001', n:'Örnek', c:'İçecek', p:12.8, k:20, s:10, stockTracked:true }];
const customer = cari.addCustomer(cari.createState(), {name:'Örnek müşteri',createdAt:100});
const receipt = {
  id:'synthetic-sale', at:100, d:'26.11.2026 15:00', paymentMethod:'cari',
  customerId:customer.customers[0].id, customerName:'Örnek müşteri',
  items:[{b:'83000001',n:'Örnek',p:12.8,q:1,k:20,totalCents:1280}],
  total:12.8, paid:0, change:0
};
const encoded = records => Object.entries(records).map(([key,value]) => [key,JSON.stringify(value)]);

function syntheticSale() {
  const memory = Object.fromEntries(encoded({'koc-prods':catalog,'koc-sales':[], 'koc-cari-state':customer}));
  const next = cari.addCreditSale(customer, {
    customerId:receipt.customerId,saleId:receipt.id,at:receipt.at,items:receipt.items,description:'Veresiye satış'
  });
  const records = encoded({'koc-prods':[{...catalog[0],s:9}],'koc-sales':[receipt],'koc-cari-state':next});
  return {memory,next,records};
}

test('native cashier can append a receipt, its stock movement and the matching cari record', () => {
  const {memory,records} = syntheticSale();
  assert.doesNotThrow(() => assertAuthorized(memory, records, false));
  assert.throws(() => assertAuthorized(memory, encoded({'koc-prods':[{...catalog[0],p:54}]}), false), /Yönetici yetkisi/);
  assert.throws(() => assertAuthorized(memory, encoded({'koc-operational-settings':{trackStock:false}}), false), /Yönetici yetkisi/);
  assert.doesNotThrow(() => assertAuthorized(memory, encoded({'koc-prods':[{...catalog[0],p:54}]}), true));
});

test('native cashier can add a customer and collect a payment against the persisted lots', () => {
  const {memory,next} = syntheticSale();
  const another = cari.addCustomer(customer,{name:'Yeni cari',createdAt:101});
  assert.doesNotThrow(() => assertAuthorized(memory, encoded({'koc-cari-state':another}), false));
  memory['koc-cari-state'] = JSON.stringify(next);
  const payment = cari.recordPayment(next,{customerId:receipt.customerId,amount:2,at:102});
  assert.doesNotThrow(() => assertAuthorized(memory, encoded({'koc-cari-state':payment}), false));
});

test('cashier can retain a consistent before or after backup in a transaction that holds a cart and adds a customer', () => {
  const previous = {products:catalog,sales:[],heldSales:[],cariState:customer};
  const after = {
    ...previous,
    heldSales:[{id:101,cart:receipt.items}],
    cariState:cari.addCustomer(customer,{name:'Yeni örnek müşteri',createdAt:102})
  };
  const memory = Object.fromEntries(encoded({
    'koc-prods':previous.products,'koc-sales':previous.sales,
    'koc-held':previous.heldSales,'koc-cari-state':previous.cariState,'koc-backups':[previous]
  }));
  const group = snapshot => encoded({
    'koc-held':after.heldSales,'koc-cari-state':after.cariState,'koc-backups':[snapshot,previous]
  });

  assert.doesNotThrow(() => assertAuthorized(memory, group(after), false));
  assert.doesNotThrow(() => assertAuthorized(memory, group(previous), false));
  assert.throws(() => assertAuthorized(memory, group({...after,cariState:previous.cariState}), false), /Yönetici yetkisi/);
  assert.throws(() => assertAuthorized(memory, [...group(after),...encoded({
    'koc-prods':[{...catalog[0],p:54}]
  })], false), /Yönetici yetkisi/);
});

test('a cashier backup cannot introduce cari records absent from the persisted or proposed snapshot', () => {
  const {lastId,...legacyEmpty} = cari.createState();
  const snapshot = {products:catalog,sales:[],heldSales:[]};
  const memory = Object.fromEntries(encoded({'koc-prods':catalog,'koc-sales':[],'koc-held':[]}));
  const backupOnly = state => encoded({'koc-backups':[{...snapshot,cariState:state}]});

  for (const empty of [undefined,null,legacyEmpty,{...legacyEmpty,lastId}]) {
    assert.doesNotThrow(() => assertAuthorized(memory, backupOnly(empty), false));
  }
  assert.throws(() => assertAuthorized(memory, backupOnly(customer), false), /Yönetici yetkisi/);

  const after = {...snapshot,cariState:customer,heldSales:[{id:101,cart:receipt.items}]};
  const group = candidate => encoded({
    'koc-held':after.heldSales,'koc-cari-state':after.cariState,'koc-backups':[candidate]
  });
  assert.doesNotThrow(() => assertAuthorized(memory, group(after), false));
  assert.throws(() => assertAuthorized(memory, group({...snapshot,cariState:customer}), false), /Yönetici yetkisi/);
});

test('native PIN sessions migrate plaintext only on success, enforce cooldown and expire', () => {
  let time = 10;
  const auth = createSession(() => time);
  const memory = {'koc-admin-pin':'0642','koc-admin-pin-shadow':'0642'};
  const apply = changes => changes.forEach(([key,value]) => {
    if (value === null) delete memory[key];
    else memory[key] = value;
  });
  for (let i=0;i<3;i++) assert.equal(auth.unlock(memory,'1234',apply).ok,false);
  assert.equal(auth.unlock(memory,'0642',apply).retryMs,5000);
  assert.equal(memory['koc-admin-pin'],'0642');
  time += 5000;
  assert.equal(auth.unlock(memory,'0642',apply).remainingMs,300000);
  assert.match(memory['koc-admin-pin'],/^pbkdf2:[a-f\d]{32}:[a-f\d]{64}$/);
  assert.equal(memory['koc-admin-pin-shadow'],undefined);
  assert.equal(pinKey('koc-admin-pin-emergency'),true);
  time += 300000;
  assert.equal(auth.authenticated(),false);
  assert.equal(auth.changePin(memory,'0642','7592',apply).ok,true);
  assert.equal(auth.authenticated(),false);
  assert.equal(auth.unlock(memory,'7592',apply).ok,true);
  assert.equal(auth.lock().remainingMs,0);
});

test('native startup normalizes existing data once and recovers stored values without a renderer write', () => {
  const html = fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const original = {b:' 83000001 ',n:'Örnek',p:23,s:7,c:'Tütün',k:20};
  const disk = Object.fromEntries(encoded({'koc-prods':[original],'koc-sales-shadow':[receipt],'koc-held':[]}));
  const ops = startupMigrations(disk,html,200);
  for (const [key,value] of ops) disk[key] = value;
  const [product] = JSON.parse(disk['koc-prods']);
  assert.equal(product.b,'83000001');
  assert.equal(product.k,0);
  assert.equal(product.p,23);
  assert.equal(product.s,7);
  assert.equal(JSON.parse(disk['koc-backups'])[0].products[0].k,20);
  assert.equal(JSON.parse(disk['koc-sales'])[0].id,receipt.id);
  assert.deepEqual(startupMigrations(disk,html,400),[]);
  assert.ok(JSON.parse(Object.fromEntries(startupMigrations({},html,50))['koc-prods']).length > 200);
});
