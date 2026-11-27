const crypto = require('node:crypto');
const { isDeepStrictEqual: equal } = require('node:util');
const cari = require('./cari-core');

const PIN = 'koc-admin-pin';
const RECOVERY = ['-shadow','-emergency','-emergency-ts'];
const PRODUCT = 'koc-prods';
const SALE = 'koc-sales';
const CARI = 'koc-cari-state';
const HELD = 'koc-held';
const BACKUPS = 'koc-backups';
const CATEGORY = 'koc-category-tree';
const STOCK = 'koc-operational-settings';
const MARKER = 'koc-atomic-last-operation';
const DATA_KEYS = new Set([PRODUCT, SALE, CARI, HELD, BACKUPS, CATEGORY, STOCK,'koc-business-settings','koc-user-settings']);
const ARRAY_KEYS = new Set([PRODUCT,SALE,HELD,BACKUPS]);
const ADMIN_REQUIRED = 'Yönetici yetkisi gerekli veya kayıt geçersiz.';

const pinKey = key => key === PIN || RECOVERY.some(suffix => key === PIN + suffix);
const validPin = pin => typeof pin === 'string' && /^\d{4}$/.test(pin);
const derivePin = (pin,salt) => crypto.pbkdf2Sync(pin,salt,210000,32,'sha256');
const isObject = value => value != null && typeof value === 'object' && !Array.isArray(value);
const parse = (raw,fallback = null) => raw === undefined ? fallback : JSON.parse(raw);

function pinOps(pin) {
  if (!validPin(pin)) throw new Error('PIN dört haneli olmalı.');
  const salt = crypto.randomBytes(16);
  const digest = derivePin(pin,salt);
  return [[PIN,`pbkdf2:${salt.toString('hex')}:${digest.toString('hex')}`],
    ...RECOVERY.map(suffix => [PIN + suffix,null])];
}

function createSession(clock = () => Number(process.hrtime.bigint() / 1000000n)) {
  let until = 0;
  let retryAt = 0;
  let failures = 0;
  const status = (ok = true) => ({ok, remainingMs:Math.max(0,until-clock()), retryMs:Math.max(0,retryAt-clock())});
  function check(mem,pin) {
    if (retryAt > clock()) return null;
    const raw = mem[PIN];
    const stored = raw?.startsWith('"') ? parse(raw) : raw;
    const protectedPin = stored?.startsWith('pbkdf2:');
    const fields = protectedPin ? /^pbkdf2:([a-f\d]{32}):([a-f\d]{64})$/i.exec(stored) : null;
    if (protectedPin && !fields) throw new Error('PIN kaydı geçersiz.');
    const ok = validPin(pin) && (fields
      ? crypto.timingSafeEqual(derivePin(pin,Buffer.from(fields[1],'hex')),Buffer.from(fields[2],'hex'))
      : pin === (stored ?? '1234'));
    if (!ok) {
      if (++failures >= 3) retryAt = clock() + 5000;
      return null;
    }
    failures = retryAt = 0;
    return fields ? RECOVERY.filter(suffix => Object.hasOwn(mem,PIN+suffix)).map(suffix => [PIN+suffix,null]) : pinOps(pin);
  }
  return {
    status,
    authenticated: () => until > clock(),
    lock() { until = 0; return status(); },
    unlock(mem,pin,apply) {
      const ops = check(mem,pin);
      if (!ops) return status(false);
      if (ops.length) apply(ops);
      until = clock() + 300000;
      return status();
    },
    changePin(mem,currentPin,newPin,apply) {
      if (!validPin(newPin)) throw new Error('PIN dört haneli olmalı.');
      if (!check(mem,currentPin)) return status(false);
      apply(pinOps(newPin));
      return this.lock();
    }
  };
}

function startupMigrations(mem,html,at = Date.now()) {
  const ops = [];
  function recovered(key, valid) {
    for (const candidate of [key,key+'-shadow',key+'-emergency']) {
      if (!Object.hasOwn(mem,candidate)) continue;
      try {
        const raw = mem[candidate];
        if (valid(JSON.parse(raw))) {
          if (candidate !== key) ops.push([key,raw]);
          return JSON.parse(raw);
        }
      } catch (_) { /* Try the next recovery copy. */ }
    }
    if ([key,key+'-shadow',key+'-emergency'].some(k => Object.hasOwn(mem,k))) {
      throw new Error('Kayıtlı veri okunamadı: ' + key);
    }
    return null;
  }
  const sales = recovered(SALE,Array.isArray);
  const held = recovered(HELD,Array.isArray);
  recovered(CARI,isObject);
  const existing = recovered(PRODUCT,Array.isArray);
  let products = existing == null ? [] : structuredClone(existing);
  if (existing == null && !Object.hasOwn(mem,'koc-ulker-v6-yuklendi') && sales == null && held == null) {
    const match = /const ULKER_URUNLER =(\[[\s\S]*?\n\]);/.exec(html);
    if (!match) throw new Error('Paketin başlangıç kataloğu bulunamadı.');
    products = JSON.parse(match[1]);
  }
  for (const key of ['koc-migrated-to-disk-v1','koc-ulker-v6-yuklendi','koc-kat-birlesim-v1',
    'koc-barcode-cleanup-v1','koc-kdv-migrated-v1','koc-kdv-sigara-fix-v10','koc-category-tree-native-v1']) {
    if (!Object.hasOwn(mem,key)) ops.push([key,'1']);
  }
  const joined = new Set(['Bisküvi','Çikolata','Kraker','Bar','Gofret','Kek','Şekerleme','Fırın','Süt','Gıda','Temizlik','Diğer']);
  const vatOne = new Set(['Temel Gıda','Ekmek','Süt','Süt Ürünleri','Sebze','Meyve']);
  const vatTen = new Set(['Atıştırmalık','Bar','Kraker','Bisküvi','Çikolata','Gofret','Kek','Kuruyemiş','Şekerleme','Dondurma','İçecek']);
  const settings = recovered(STOCK,isObject);
  const categories = recovered(CATEGORY,isObject);
  recovered('koc-business-settings',isObject);
  recovered('koc-user-settings',isObject);
  for (const p of products.filter(isObject)) {
    if (!mem['koc-barcode-cleanup-v1'] && typeof p.b === 'string') {
      p.b = p.b.trim().replace(/[\u200b-\u200f\ufeff\s]/g, '') || p.b;
    }
    if (!mem['koc-kat-birlesim-v1'] && joined.has(p.c)) p.c = 'Atıştırmalık';
    const tobacco = p.c === 'Sigara' || p.c === 'Tütün';
    if ((!mem['koc-kdv-sigara-fix-v10'] && tobacco) || (!mem['koc-kdv-migrated-v1'] && p.k == null)) {
      p.k = tobacco ? 0 : vatOne.has(p.c) ? 1 : vatTen.has(p.c) ? 10 : settings?.defaultVat ?? 20;
    }
  }
  if (!mem['koc-category-tree-native-v1']) {
    const rows = Array.isArray(categories?.categories) ? structuredClone(categories.categories) : [];
    const known = new Set(rows.map(c => c.id));
    const ids = new Map(rows.filter(c => c.active !== false).map(c => [c.name,c.id]));
    const names = ['Atıştırmalık','Sigara','Otomotiv Ürünleri','Muhtelif Ürünler','İçecek','Dondurma','Kuruyemiş',
      ...products.filter(isObject).map(p => p.c)];
    let serial = 0;
    for (const name of names) {
      if (typeof name !== 'string' || !name.trim() || ids.has(name.trim())) continue;
      let id;
      do { id = 'cat-native-' + ++serial; } while (known.has(id));
      known.add(id);
      ids.set(name.trim(),id);
      rows.push({id,name:name.trim(),parentId:null,active:true,createdAt:at});
    }
    for (const p of products.filter(isObject)) {
      if (!known.has(p.cid) && ids.has(p.c)) p.cid = ids.get(p.c);
    }
    const tree = {schemaVersion:1,categories:rows};
    if (!equal(tree,categories)) storeWithCopies(ops,CATEGORY,tree);
  }
  if (!equal(products,existing)) {
    storeWithCopies(ops,PRODUCT,products);
    if (existing) {
      const backups = parse(mem[BACKUPS],[]);
      const snapshot = {ts:at,reason:'Yerel başlangıç bakımı öncesi',products:existing,sales:sales ?? [],heldSales:held ?? [],v:4};
      if (categories) snapshot.categoryState = categories;
      ops.push([BACKUPS,JSON.stringify([snapshot,...backups].slice(0,10))]);
    }
  }
  return Array.from(new Map(ops));
}

function storeWithCopies(ops,key,value) {
  const raw = JSON.stringify(value);
  ops.push([key,raw],[key+'-shadow',raw],[key+'-emergency',raw]);
}

function validTrace(key,raw) {
  if (['koc-last-auto-backup-date','koc-son-acilis-gunu'].includes(key)) return /^\d{4}-\d{2}-\d{2}$/.test(raw);
  if (key === 'koc-son-yedek') return /^\d+$/.test(raw);
  if (key === 'koc-tauri-gecis-bildirildi') return /^\d{4}-\d{2}-\d{2}T/.test(raw) && Number.isFinite(Date.parse(raw));
  return false;
}

function assertAuthorized(mem, entries, admin) {
  let allowed = false;
  try { allowed = authorized(mem,entries,admin); }
  catch (_) { /* Invalid record format rejects the entire group. */ }
  if (!allowed) throw new Error(ADMIN_REQUIRED);
}

function authorized(mem,entries,admin) {
  const writes = new Map(entries);
  if (writes.size !== entries.length) return false;
  const records = new Map();
  for (const [key,raw] of writes) {
    if (raw === null && admin && DATA_KEYS.has(key)) continue;
    if (typeof raw !== 'string' || pinKey(key)) return false;
    if (DATA_KEYS.has(key)) {
      const value = parse(raw);
      if (ARRAY_KEYS.has(key) ? !Array.isArray(value) : !isObject(value)) return false;
      if (mem[key] !== raw) records.set(key,value);
    } else if (key === MARKER) {
      if (!/^[A-Za-z0-9-]{1,160}$/.test(raw) || !Array.from(writes.keys()).some(k => DATA_KEYS.has(k))) return false;
    } else if (!validTrace(key,raw)) {
      const suffix = RECOVERY.find(suffix => key.endsWith(suffix));
      const base = suffix ? key.slice(0,-suffix.length) : '';
      if (!DATA_KEYS.has(base) || base === BACKUPS || (suffix === '-emergency-ts'
        ? !/^\d+$/.test(raw) : raw !== (writes.get(base) ?? mem[base]))) return false;
    }
  }
  if (admin) return true;
  if (Array.from(records.keys()).some(key => ![PRODUCT,SALE,CARI,HELD,BACKUPS].includes(key))) return false;
  let sale;
  if (records.has(SALE)) {
    const old = parse(mem[SALE],[]);
    const [latest,...rest] = records.get(SALE);
    if (!validSale(latest) || !equal(rest,old) || old.some(row => String(row.id) === String(latest.id))) return false;
    const before = parse(mem[PRODUCT],[]);
    if (!equal(expectedStock(before,latest,parse(mem[STOCK],{})),records.get(PRODUCT) ?? before)) return false;
    sale = latest;
  } else if (records.has(PRODUCT)) return false;
  if (records.has(CARI)) {
    if (!validCari(parse(mem[CARI],cari.createState()),records.get(CARI),sale,parse(mem[PRODUCT],[]))) return false;
  } else if (sale?.paymentMethod === 'cari') return false;
  if (records.has(HELD) && !validHeld(parse(mem[HELD],[]),records.get(HELD))) return false;
  if (records.has(BACKUPS)) {
    const [added,...kept] = records.get(BACKUPS);
    const before = parse(mem[BACKUPS],[]);
    if (!added || !equal(kept,before.slice(0,kept.length))) return false;
    for (const [field,key] of [['products',PRODUCT],['sales',SALE],['heldSales',HELD]]) {
      if (!equal(added[field],parse(mem[key],[]))) return false;
    }
    if (mem[CARI] && !equal(added.cariState,parse(mem[CARI]))) return false;
  }
  return true;
}

function validSale(sale) {
  if (!isObject(sale) || !['string','number'].includes(typeof sale.id) || !String(sale.id) ||
      !Number.isSafeInteger(sale.at) || typeof sale.d !== 'string' || !Array.isArray(sale.items) || !sale.items.length) return false;
  let sum = 0;
  for (const item of sale.items) {
    if (typeof item.b !== 'string' || !item.b || !Number.isSafeInteger(item.q) || item.q <= 0 ||
        !Number.isFinite(item.k) || item.k < 0 || item.k > 100 || !Number.isFinite(item.p) || item.p < 0 ||
        item.totalCents !== Math.round(item.p*100)*item.q) return false;
    sum += item.totalCents;
  }
  if (!Number.isSafeInteger(sum) || Math.round(sale.total*100) !== sum || !Number.isFinite(sale.paid) ||
      !Number.isFinite(sale.change) || sale.paid < 0 || sale.change < 0) return false;
  const paid = Math.round(sale.paid*100);
  const change = Math.round(sale.change*100);
  if (sale.paymentMethod === 'cash') return paid >= sum && change === paid-sum && sale.customerId == null;
  if (sale.paymentMethod === 'card') return paid === sum && change === 0 && sale.customerId == null;
  return sale.paymentMethod === 'cari' && paid === 0 && change === 0 && typeof sale.customerId === 'string' && !!sale.customerId;
}

function expectedStock(catalog,sale,settings) {
  if (settings.trackStock === false) return catalog;
  const qty = new Map();
  for (const item of sale.items) qty.set(item.b,(qty.get(item.b)||0)+item.q);
  return catalog.map(p => {
    if (!qty.has(p.b) || !(p.stockTracked === true || (p.stockTracked == null && Number(p.s)>0))) return p;
    const s = Number(p.s)-qty.get(p.b);
    if (!Number.isSafeInteger(s) || (s < 0 && settings.allowNegativeStock !== true)) throw new Error(ADMIN_REQUIRED);
    return {...p,s,stockTracked:true};
  });
}

function validHeld(before,next) {
  const preserved = next.filter(row => before.some(old => equal(old,row)));
  return before.length-preserved.length <= 1 && next.length-preserved.length <= 1 &&
    equal(preserved,before.filter(old => next.some(row => equal(old,row)))) &&
    new Set(next.map(row => String(row.id))).size === next.length &&
    next.every(row => ['string','number'].includes(typeof row.id) && Array.isArray(row.cart));
}

function validCari(before,next,sale,catalog) {
  if (!Array.isArray(next.customers) || !Array.isArray(next.lots) || !Array.isArray(next.entries)) return false;
  const after = next.entries.at(-1);
  let expected;
  if (sale) {
    if (sale.paymentMethod !== 'cari' || after?.type !== 'credit_sale') return false;
    const customer = before.customers.find(row => row.id === sale.customerId);
    if (!customer || (customer.riskLimit > 0 && cari.customerBalance(before,customer.id)+sale.total > customer.riskLimit)) return false;
    expected = cari.addCreditSale(before,{customerId:sale.customerId,saleId:sale.id,at:sale.at,items:sale.items,description:after.description});
  } else if (next.customers.length === before.customers.length + 1 && next.entries.length === before.entries.length) {
    const {id,...customer} = next.customers.at(-1);
    expected = cari.addCustomer(before,customer);
    if (expected.customers.at(-1).id !== id) {
      // Imported entries can carry a caller-supplied unique ID.
      expected = cari.addCustomer(before,{...customer,id});
    }
  } else if (next.entries.length === before.entries.length+1 && after?.type === 'payment') {
    const fields = {customerId:after.customerId,amount:after.creditCents/100,at:after.at,method:after.details?.method,description:after.description};
    expected = cari.recordPayment(before,fields);
    if (expected.entries.at(-1).referenceId !== after.referenceId) {
      expected = cari.recordPayment(before,{...fields,paymentId:after.referenceId});
    }
  } else if (next.entries.length === before.entries.length+1 && after?.type === 'manual_product') {
    const lines = after.details?.items;
    if (!Array.isArray(lines) || lines.length !== 1 || lines[0].quantity !== 1) return false;
    const product = catalog.find(p => p.b === lines[0].barcode);
    if (!product) return false;
    const customer = before.customers.find(row => row.id === after.customerId);
    if (!customer || (customer.riskLimit > 0 && cari.customerBalance(before,customer.id)+product.p > customer.riskLimit)) return false;
    expected = cari.addCreditSale(before,{customerId:after.customerId,saleId:after.referenceId,
      at:after.at,type:'manual',items:[{...product,q:1}],description:after.description});
  } else return false;
  return equal(expected,next);
}

module.exports = {assertAuthorized,createSession,pinKey,startupMigrations};
