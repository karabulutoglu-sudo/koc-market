(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KocCari = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const cents = (value) => Math.round(Number(value || 0) * 100);
  const money = (valueInCents) => Number(valueInCents || 0) / 100;

  function createState() {
    return { schemaVersion: 1, customers: [], lots: [], entries: [] };
  }

  function nextId(state, prefix) {
    return prefix + '-' + (state.entries.length + state.lots.length + state.customers.length + 1);
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
    const id = String(customer.id || nextId(state, 'customer'));
    if (state.customers.some(item => item.id === id)) throw new Error('Cari kimliği zaten kayıtlı.');
    state.customers.push({
      id,
      name,
      phone: String(customer.phone || ''),
      note: String(customer.note || ''),
      createdAt: customer.createdAt || Date.now(),
      active: true
    });
    return state;
  }

  function requireCustomer(state, customerId) {
    if (!state.customers.some(customer => customer.id === customerId && customer.active !== false)) {
      throw new Error('Cari bulunamadı.');
    }
  }

  function addCreditSale(inputState, sale) {
    const state = clone(inputState);
    requireCustomer(state, sale.customerId);
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
      if (!(quantity > 0) || !(unitPriceCents >= 0) || !barcode) {
        throw new Error('Cari satış ürün bilgisi geçersiz.');
      }
      const lineCents = Math.round(quantity * unitPriceCents);
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
    return state;
  }

  function recordPayment(inputState, payment) {
    const state = clone(inputState);
    requireCustomer(state, payment.customerId);
    const amountCents = cents(payment.amount);
    if (!(amountCents > 0)) throw new Error('Ödeme tutarı sıfırdan büyük olmalıdır.');
    let remainingCents = amountCents;
    const allocations = [];
    const openLots = state.lots
      .filter(lot => lot.customerId === payment.customerId && lot.outstandingCents > 0)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

    for (const lot of openLots) {
      if (remainingCents <= 0) break;
      const appliedCents = Math.min(remainingCents, lot.outstandingCents);
      lot.outstandingCents -= appliedCents;
      remainingCents -= appliedCents;
      if (lot.outstandingCents === 0) lot.closedAt = payment.at || Date.now();
      allocations.push({
        lotId: lot.id,
        saleId: lot.saleId,
        barcode: lot.barcode,
        appliedCents,
        remainingLotCents: lot.outstandingCents
      });
    }

    appendEntry(state, {
      customerId: payment.customerId,
      type: 'payment',
      at: payment.at || Date.now(),
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
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
      .map(entry => Object.assign({}, entry, {
        debit: money(entry.debitCents),
        credit: money(entry.creditCents),
        balance: money(entry.balanceCents)
      }));
  }

  return {
    createState,
    addCustomer,
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
