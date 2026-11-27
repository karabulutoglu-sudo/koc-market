(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KocCari = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const cents = (value) => Math.round(Number(value || 0) * 100);
  const money = (valueInCents) => Number(valueInCents || 0) / 100;

  function createState() {
    return { schemaVersion: 1, lastId: 0, customers: [], lots: [], entries: [] };
  }

  function idNumber(id) {
    const match = /^(?:customer|sale|lot|entry|payment|price-update)-(\d+)$/.exec(id);
    const number = match ? Number(match[1]) : 0;
    return Number.isSafeInteger(number) ? number : 0;
  }

  function initIdSequence(state) {
    if (Number.isSafeInteger(state.lastId) && state.lastId >= 0) return;
    state.lastId = state.customers.length + state.lots.length + state.entries.length;
    for (const customer of state.customers) {
      state.lastId = Math.max(state.lastId, idNumber(customer.id));
    }
    for (const lot of state.lots) {
      state.lastId = Math.max(state.lastId, idNumber(lot.id), idNumber(lot.saleId));
    }
    for (const entry of state.entries) {
      state.lastId = Math.max(state.lastId, idNumber(entry.id), idNumber(entry.referenceId));
    }
  }

  function nextId(state, prefix) {
    initIdSequence(state);
    if (state.lastId === Number.MAX_SAFE_INTEGER) throw new Error('Cari kimlik sınırına ulaşıldı.');
    return prefix + '-' + (++state.lastId);
  }

  function customerBalanceCents(state, customerId) {
    return state.entries
      .filter(entry => entry.customerId === customerId)
      .reduce((sum, entry) => sum + entry.debitCents - entry.creditCents, 0);
  }

  function customerBalance(state, customerId) {
    return money(customerBalanceCents(state, customerId));
  }

  function appendEntry(state, entry) {
    const debitCents = Math.max(0, Math.round(entry.debitCents || 0));
    const creditCents = Math.max(0, Math.round(entry.creditCents || 0));
    const balanceCents = customerBalanceCents(state, entry.customerId) + debitCents - creditCents;
    state.entries.push(Object.assign({}, entry, {
      id: entry.id || nextId(state, 'entry'),
      debitCents,
      creditCents,
      balanceCents
    }));
  }

  function addCustomer(inputState, customer) {
    const state = clone(inputState);
    const name = String(customer && customer.name || '').trim();
    if (!name) throw new Error('Cari adı zorunludur.');
    initIdSequence(state);
    const id = String(customer.id || nextId(state, 'customer'));
    if (state.customers.some(item => item.id === id)) throw new Error('Cari kimliği zaten kayıtlı.');
    state.lastId = Math.max(state.lastId, idNumber(id));
    state.customers.push({
      id,
      name,
      phone: String(customer.phone || ''),
      email: String(customer.email || ''),
      type: String(customer.type || 'customer'),
      contactPerson: String(customer.contactPerson || ''),
      address: String(customer.address || ''),
      city: String(customer.city || ''),
      district: String(customer.district || ''),
      postalCode: String(customer.postalCode || ''),
      taxOffice: String(customer.taxOffice || ''),
      taxNo: String(customer.taxNo || ''),
      riskLimit: Number(customer.riskLimit || 0),
      note: String(customer.note || ''),
      createdAt: customer.createdAt || Date.now(),
      active: true
    });
    return state;
  }

  function updateCustomer(inputState, customerId, changes = {}) {
    const state = clone(inputState);
    const customer = state.customers.find(item => item.id === customerId);
    if (!customer) throw new Error('Cari bulunamadı.');
    changes = changes ?? {};
    if (changes.name !== undefined) {
      const name = String(changes.name || '').trim();
      if (!name) throw new Error('Cari adı zorunludur.');
      customer.name = name;
    }
    const fields = ['phone','email','type','contactPerson','address','city','district','postalCode','taxOffice','taxNo','note'];
    fields.forEach(field => {
      if (changes[field] !== undefined) customer[field] = String(changes[field] || '');
    });
    if (changes.riskLimit !== undefined) customer.riskLimit = Number(changes.riskLimit || 0);
    customer.updatedAt = changes.updatedAt || Date.now();
    return state;
  }

  function deactivateCustomer(inputState, customerId) {
    const state = clone(inputState);
    const customer = state.customers.find(item => item.id === customerId);
    if (!customer) throw new Error('Cari bulunamadı.');
    customer.active = false;
    customer.deactivatedAt = Date.now();
    return state;
  }

  function deleteCustomer(inputState, customerId) {
    const state = clone(inputState);
    if (state.entries.some(entry => entry.customerId === customerId) ||
        state.lots.some(lot => lot.customerId === customerId)) {
      throw new Error('Hareketi olan cari silinemez; pasife alınmalıdır.');
    }
    initIdSequence(state);
    const before = state.customers.length;
    state.customers = state.customers.filter(customer => customer.id !== customerId);
    if (state.customers.length === before) throw new Error('Cari bulunamadı.');
    return state;
  }

  function requireCustomer(state, customerId) {
    const customer = state.customers.find(customer => customer.id === customerId);
    if (!customer) throw new Error('Cari bulunamadı.');
    return customer;
  }

  function openLotsFor(state, customerId) {
    return state.lots
      .filter(lot => lot.customerId === customerId && lot.outstandingCents > 0)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  function allocatePayment(lots, amountCents, at) {
    let remainingCents = amountCents;
    const allocations = [];
    for (const lot of lots) {
      if (remainingCents <= 0) break;
      if (lot.outstandingCents <= 0) continue;
      const appliedCents = Math.min(remainingCents, lot.outstandingCents);
      lot.outstandingCents -= appliedCents;
      remainingCents -= appliedCents;
      if (lot.outstandingCents === 0) lot.closedAt = Math.max(at, lot.createdAt);
      allocations.push({
        lotId: lot.id,
        saleId: lot.saleId,
        barcode: lot.barcode,
        appliedCents,
        remainingLotCents: lot.outstandingCents
      });
    }
    return { remainingCents, allocations };
  }

  function applyUnallocatedCredit(state, customerId, at) {
    const advances = state.entries
      .filter(entry => entry.customerId === customerId && entry.type === 'payment' &&
        entry.details?.unallocatedCreditCents > 0)
      .sort((a, b) => a.at - b.at);
    if (!advances.length) return;
    const openLots = openLotsFor(state, customerId);
    for (const payment of advances) {
      const { remainingCents, allocations } = allocatePayment(
        openLots, payment.details.unallocatedCreditCents, Math.max(at, payment.at)
      );
      if (!allocations.length) break;
      payment.details.allocations = [...(payment.details.allocations || []), ...allocations];
      payment.details.unallocatedCreditCents = remainingCents;
    }
  }

  function addCreditSale(inputState, sale) {
    const state = clone(inputState);
    const customer = requireCustomer(state, sale.customerId);
    if (customer.active === false) throw new Error('Pasif cariye yeni borç yazılamaz.');
    const items = Array.isArray(sale.items) ? sale.items : [];
    if (!items.length) throw new Error('Cari satışta en az bir ürün olmalıdır.');
    const at = sale.at || Date.now();
    const saleId = String(sale.saleId || nextId(state, 'sale'));
    let totalCents = 0;
    const entryItems = [];

    for (const item of items) {
      const quantity = Number(item.quantity || item.q || 0);
      const unitPriceCents = cents(item.unitPrice != null ? item.unitPrice : item.p);
      const barcode = String(item.barcode != null ? item.barcode : item.b || '');
      const lineCents = Math.round(quantity * unitPriceCents);
      if (!Number.isFinite(quantity) || quantity <= 0 || unitPriceCents < 0 ||
          !Number.isSafeInteger(lineCents) || !Number.isSafeInteger(totalCents + lineCents) || !barcode) {
        throw new Error('Cari satış ürün bilgisi geçersiz.');
      }
      totalCents += lineCents;
      const lotId = nextId(state, 'lot');
      state.lots.push({
        id: lotId,
        customerId: sale.customerId,
        saleId,
        barcode,
        productName: String(item.productName != null ? item.productName : item.n || ''),
        originalQuantity: quantity,
        originalUnitPriceCents: unitPriceCents,
        highestAppliedUnitPriceCents: unitPriceCents,
        outstandingCents: lineCents,
        createdAt: at,
        closedAt: null
      });
      entryItems.push({ lotId, barcode, quantity, unitPriceCents, lineCents });
    }

    appendEntry(state, {
      customerId: sale.customerId,
      type: sale.type === 'manual' ? 'manual_product' : 'credit_sale',
      at,
      debitCents: totalCents,
      creditCents: 0,
      description: String(sale.description || 'Cari satış'),
      referenceId: saleId,
      details: { items: entryItems }
    });
    applyUnallocatedCredit(state, sale.customerId, at);
    return state;
  }

  function recordPayment(inputState, payment) {
    const state = clone(inputState);
    const customer = requireCustomer(state, payment.customerId);
    const amountCents = cents(payment.amount);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw new Error('Ödeme tutarı sıfırdan büyük olmalıdır.');
    }
    if (customer.active === false && amountCents > customerBalanceCents(state, customer.id)) {
      throw new Error('Pasif caride tahsilat mevcut borcu aşamaz.');
    }
    const at = payment.at || Date.now();
    applyUnallocatedCredit(state, payment.customerId, at);
    const { remainingCents, allocations } = allocatePayment(openLotsFor(state, payment.customerId), amountCents, at);

    appendEntry(state, {
      customerId: payment.customerId,
      type: 'payment',
      at,
      debitCents: 0,
      creditCents: amountCents,
      description: String(payment.description || 'Cari tahsilat'),
      referenceId: String(payment.paymentId || nextId(state, 'payment')),
      details: {
        method: payment.method || 'cash',
        allocations,
        unallocatedCreditCents: remainingCents
      }
    });
    return state;
  }

  function applyPriceIncrease(inputState, update) {
    const state = clone(inputState);
    const barcode = String(update.barcode || '');
    const newPriceCents = cents(update.newPrice);
    if (!barcode || !(newPriceCents >= 0)) throw new Error('Fiyat güncelleme bilgisi geçersiz.');
    const at = update.at || Date.now();
    const byCustomer = new Map();

    const affectedCustomers = new Set(state.lots
      .filter(lot => lot.barcode === barcode && lot.outstandingCents > 0 &&
        lot.highestAppliedUnitPriceCents > 0 && newPriceCents > lot.highestAppliedUnitPriceCents)
      .map(lot => lot.customerId));
    for (const customerId of affectedCustomers) applyUnallocatedCredit(state, customerId, at);

    for (const lot of state.lots) {
      if (lot.barcode !== barcode || lot.outstandingCents <= 0) continue;
      const oldHighCents = lot.highestAppliedUnitPriceCents;
      // ALTIN KURAL: aşağı yönlü fiyat cariyi asla azaltmaz. Önceki en yüksek
      // uygulanmış fiyat aşılmadıkça hiçbir cari hareketi oluşmaz.
      if (newPriceCents <= oldHighCents || oldHighCents <= 0) continue;
      const openQuantity = lot.outstandingCents / oldHighCents;
      const differenceCents = Math.round((newPriceCents - oldHighCents) * openQuantity);
      if (differenceCents <= 0) continue;

      lot.outstandingCents += differenceCents;
      lot.highestAppliedUnitPriceCents = newPriceCents;
      const group = byCustomer.get(lot.customerId) || [];
      group.push({
        lotId: lot.id,
        saleId: lot.saleId,
        barcode,
        productName: lot.productName,
        openQuantity,
        oldHighCents,
        newPriceCents,
        differenceCents
      });
      byCustomer.set(lot.customerId, group);
    }

    for (const [customerId, adjustments] of byCustomer.entries()) {
      const totalDifferenceCents = adjustments.reduce((sum, item) => sum + item.differenceCents, 0);
      appendEntry(state, {
        customerId,
        type: 'price_adjustment',
        at,
        debitCents: totalDifferenceCents,
        creditCents: 0,
        description: String(update.description || 'Ürün fiyat artış farkı'),
        referenceId: String(update.updateId || nextId(state, 'price-update')),
        details: { barcode, adjustments }
      });
    }

    return state;
  }

  function statement(state, customerId) {
    return state.entries
      .filter(entry => entry.customerId === customerId)
      .slice()
      .sort((a, b) => a.at - b.at)
      .map(entry => Object.assign({}, entry, {
        debit: money(entry.debitCents),
        credit: money(entry.creditCents),
        balance: money(entry.balanceCents)
      }));
  }

  return {
    createState,
    addCustomer,
    updateCustomer,
    deactivateCustomer,
    deleteCustomer,
    addCreditSale,
    recordPayment,
    applyPriceIncrease,
    customerBalance,
    customerBalanceCents,
    statement,
    cents,
    money
  };
});
