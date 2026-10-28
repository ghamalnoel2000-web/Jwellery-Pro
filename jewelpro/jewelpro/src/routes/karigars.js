'use strict';
const { toPaisa, toMg, text, id } = require('../units');
const { badRequest, notFound, rule } = require('../errors');
const { requirePermission: perm } = require('../auth');
const { allocate } = require('../billing');
const ledger = require('../ledger');
const metal = require('../metal');
const { readProduct, insertProduct, fineOf } = require('../products');
const { nowIso, readPayment, dueDate, dateRange } = require('./common');
const { payParty, partyStatement } = require('./purchases');

const { A } = ledger;

/*
 * How karigar work is valued:
 * - Gold issued leaves metal stock at its average cost and becomes "Gold with karigars".
 * - When pieces come back, the gold they used (plus any wastage allowed) is taken out of
 *   "Gold with karigars" at the job's average cost. Pieces are costed at that gold value plus labour,
 *   shared between pieces by their fine weight. Metal returned unused goes back to metal stock.
 * - Gold not yet returned or accounted for stays as the karigar's balance.
 */

function registerKarigarRoutes(r, store) {
  const payableId = () => ledger.accountId(store, A.KARIGAR_PAYABLE);

  r.get('/karigars', perm('karigars.manage'), (req, res) => {
    res.json(store.all(
      `SELECT k.*,
         COALESCE((SELECT SUM(credit_paisa - debit_paisa) FROM journal_lines l
                   WHERE l.account_id = ? AND l.party_type = 'karigar' AND l.party_id = k.id), 0) AS payable_paisa,
         COALESCE((SELECT SUM(issued_fine_mg - consumed_fine_mg) FROM karigar_jobs j WHERE j.karigar_id = k.id), 0) AS gold_balance_mg,
         (SELECT COUNT(*) FROM karigar_jobs j WHERE j.karigar_id = k.id AND j.status = 'open') AS open_jobs,
         (SELECT COUNT(*) FROM karigar_jobs j WHERE j.karigar_id = k.id AND j.status = 'open' AND j.due_date < ?) AS overdue_jobs
       FROM karigars k ORDER BY k.is_active DESC, k.name`, payableId(), ledger.localDateText(nowIso())));
  });

  const readKarigar = (b) => ({
    name: text(b.name, 'Karigar name', { max: 100, required: true }),
    phone: text(b.phone, 'Phone', { max: 20 }),
    address: text(b.address, 'Address', { max: 200 }),
    notes: text(b.notes, 'Notes', { max: 300 }),
    is_active: b.is_active === false || b.is_active === 'false' ? 0 : 1
  });

  r.post('/karigars', perm('karigars.manage'), (req, res) => {
    const k = readKarigar(req.body);
    const newId = store.tx(() => {
      const rowId = store.run('INSERT INTO karigars (name, phone, address, notes, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        k.name, k.phone, k.address, k.notes, k.is_active, nowIso()).lastInsertRowid;
      store.audit(req.user, 'create', 'karigar', rowId, k);
      return rowId;
    });
    res.status(201).json(store.get('SELECT * FROM karigars WHERE id = ?', newId));
  });

  r.put('/karigars/:id', perm('karigars.manage'), (req, res) => {
    const rowId = id(req.params.id);
    const k = readKarigar(req.body);
    store.tx(() => {
      const old = store.get('SELECT * FROM karigars WHERE id = ?', rowId);
      if (!old) throw notFound('Karigar not found.');
      store.run('UPDATE karigars SET name = ?, phone = ?, address = ?, notes = ?, is_active = ? WHERE id = ?',
        k.name, k.phone, k.address, k.notes, k.is_active, rowId);
      store.audit(req.user, 'update', 'karigar', rowId, { before: old, after: k });
    });
    res.json(store.get('SELECT * FROM karigars WHERE id = ?', rowId));
  });

  r.get('/karigars/:id/statement', perm('karigars.manage'), (req, res) => {
    const karigar = store.get('SELECT * FROM karigars WHERE id = ?', id(req.params.id));
    if (!karigar) throw notFound('Karigar not found.');
    res.json({ karigar, lines: partyStatement(store, A.KARIGAR_PAYABLE, 'karigar', karigar.id) });
  });

  /**
   * What a karigar made for the shop, by weight: every piece received (with its weights) and a gold account
   * (gold given, gold back in pieces, metal returned, wastage allowed, and the balance with the karigar).
   */
  r.get('/karigars/:id/work', perm('karigars.manage'), (req, res) => {
    const karigar = store.get('SELECT * FROM karigars WHERE id = ?', id(req.params.id));
    if (!karigar) throw notFound('Karigar not found.');
    const { fromIso, toIso } = dateRange({ from: req.query.from || '2000-01-01', to: req.query.to });
    const pieces = store.all(
      `SELECT p.id, p.item_code, p.name, c.name AS category_name, pu.name AS purity_name, m.name AS metal_name, pu.purity,
              p.gross_mg, p.stone_mg, p.other_less_mg, p.status, r.received_at, j.job_no, j.id AS job_id
       FROM products p JOIN karigar_receipts r ON r.id = p.source_id JOIN karigar_jobs j ON j.id = r.job_id
       JOIN categories c ON c.id = p.category_id JOIN purities pu ON pu.id = p.purity_id JOIN metals m ON m.id = pu.metal_id
       WHERE p.source = 'karigar' AND j.karigar_id = ? AND r.received_at >= ? AND r.received_at < ?
       ORDER BY r.received_at, p.id`, karigar.id, fromIso, toIso)
      .map((p) => {
        const net = p.gross_mg - p.stone_mg - p.other_less_mg;
        return { ...p, net_mg: net, fine_mg: Math.round(net * p.purity) };
      });
    const byCategory = {};
    for (const p of pieces) {
      const c = byCategory[p.category_name] || (byCategory[p.category_name] = { category: p.category_name, pieces: 0, gross_mg: 0, net_mg: 0, fine_mg: 0 });
      c.pieces += 1; c.gross_mg += p.gross_mg; c.net_mg += p.net_mg; c.fine_mg += p.fine_mg;
    }

    // Gold account, fine weight: + given to the karigar, − came back (in pieces, as metal, or wastage allowed).
    const entries = [
      ...store.all(
        `SELECT i.issued_at AS at, j.job_no, 'Gold given' AS what, pu.name AS purity_name, i.gross_mg, i.fine_mg AS given_mg
         FROM karigar_issues i JOIN karigar_jobs j ON j.id = i.job_id JOIN purities pu ON pu.id = i.purity_id WHERE j.karigar_id = ?`, karigar.id),
      ...store.all(
        `SELECT r.received_at AS at, j.job_no, 'Received' AS what, r.pieces_fine_mg, r.returned_fine_mg, r.wastage_fine_mg,
                (SELECT COUNT(*) FROM products p WHERE p.source = 'karigar' AND p.source_id = r.id) AS pieces
         FROM karigar_receipts r JOIN karigar_jobs j ON j.id = r.job_id WHERE j.karigar_id = ?`, karigar.id)
    ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    let balance = 0;
    let opening = 0;
    const account = [];
    for (const e of entries) {
      const change = (e.given_mg || 0) - (e.pieces_fine_mg || 0) - (e.returned_fine_mg || 0) - (e.wastage_fine_mg || 0);
      balance += change;
      if (e.at < fromIso) { opening = balance; continue; }
      if (e.at >= toIso) continue;
      account.push({ ...e, balance_mg: balance });
    }
    const totals = account.reduce((t, e) => ({
      given_mg: t.given_mg + (e.given_mg || 0), pieces_fine_mg: t.pieces_fine_mg + (e.pieces_fine_mg || 0),
      returned_fine_mg: t.returned_fine_mg + (e.returned_fine_mg || 0), wastage_fine_mg: t.wastage_fine_mg + (e.wastage_fine_mg || 0)
    }), { given_mg: 0, pieces_fine_mg: 0, returned_fine_mg: 0, wastage_fine_mg: 0 });
    res.json({
      karigar, pieces, by_category: Object.values(byCategory),
      piece_totals: {
        pieces: pieces.length, gross_mg: pieces.reduce((a, p) => a + p.gross_mg, 0),
        net_mg: pieces.reduce((a, p) => a + p.net_mg, 0), fine_mg: pieces.reduce((a, p) => a + p.fine_mg, 0)
      },
      gold: { opening_mg: opening, entries: account, totals, closing_mg: account.length ? account[account.length - 1].balance_mg : opening }
    });
  });

  r.post('/karigars/:id/payments', perm('payments.make'), (req, res) => {
    const karigarId = id(req.params.id);
    const payment = readPayment(req.body, 'Payment', { required: true });
    const note = text(req.body.note, 'Note', { max: 200 });
    const result = store.tx(() => {
      const karigar = store.get('SELECT * FROM karigars WHERE id = ?', karigarId);
      if (!karigar) throw notFound('Karigar not found.');
      return payParty(store, req.user, {
        partyType: 'karigar', partyId: karigarId, partyName: karigar.name, payableAccount: A.KARIGAR_PAYABLE, payment, note
      });
    });
    res.status(201).json(result);
  });

  // ------------------------------------------------ Jobs

  const JOB_SELECT = `
    SELECT j.*, k.name AS karigar_name, k.phone AS karigar_phone, m.name AS metal_name, o.order_no
    FROM karigar_jobs j JOIN karigars k ON k.id = j.karigar_id JOIN metals m ON m.id = j.metal_id
    LEFT JOIN orders o ON o.id = j.order_id`;

  r.get('/karigar-jobs', perm('karigars.manage'), (req, res) => {
    const status = req.query.status || 'open';
    const karigarId = req.query.karigar_id ? id(req.query.karigar_id) : null;
    res.json(store.all(
      `${JOB_SELECT} WHERE (? = 'all' OR j.status = ?) AND (? IS NULL OR j.karigar_id = ?)
       ORDER BY CASE WHEN j.due_date IS NULL THEN 1 ELSE 0 END, j.due_date, j.id DESC LIMIT 500`,
      status, status, karigarId, karigarId));
  });

  const getJob = (jobId) => {
    const job = store.get(`${JOB_SELECT} WHERE j.id = ?`, jobId);
    if (!job) throw notFound('Job not found.');
    job.issues = store.all(
      `SELECT i.*, pu.name AS purity_name FROM karigar_issues i JOIN purities pu ON pu.id = i.purity_id WHERE i.job_id = ? ORDER BY i.id`, jobId);
    job.receipts = store.all('SELECT * FROM karigar_receipts WHERE job_id = ? ORDER BY id', jobId);
    job.pieces = store.all(
      `SELECT p.id, p.item_code, p.name, p.gross_mg, p.stone_mg, p.other_less_mg, p.cost_paisa, p.status, p.source_id AS receipt_id
       FROM products p JOIN karigar_receipts r ON r.id = p.source_id WHERE p.source = 'karigar' AND r.job_id = ? ORDER BY p.id`, jobId);
    return job;
  };

  r.get('/karigar-jobs/:id', perm('karigars.manage'), (req, res) => res.json(getJob(id(req.params.id))));

  /** Gives gold from metal stock to the karigar for a job. */
  function issueGold(user, job, line, label) {
    const purity = store.get('SELECT * FROM purities WHERE id = ?', id(line.purity_id, `${label}: purity`));
    if (!purity) throw badRequest(`${label}: choose a purity.`);
    if (purity.metal_id !== job.metal_id) throw rule(`${label}: all gold on one job must be the same metal.`);
    const grossMg = toMg(line.gross_g, `${label}: weight`, { allowEmpty: false });
    if (grossMg <= 0) throw badRequest(`${label}: weight must be more than zero.`);
    const fineMg = Math.round(grossMg * purity.purity);
    const value = metal.valueOut(store, job.metal_id, fineMg);
    const now = nowIso();
    store.run(
      'INSERT INTO karigar_issues (job_id, issued_at, purity_id, gross_mg, fine_mg, value_paisa, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      job.id, now, purity.id, grossMg, fineMg, value, text(line.note, `${label}: note`, { max: 200 }), user.id);
    store.run('UPDATE karigar_jobs SET issued_fine_mg = issued_fine_mg + ?, issued_value_paisa = issued_value_paisa + ? WHERE id = ?',
      fineMg, value, job.id);
    metal.add(store, user, {
      date: now, metalId: job.metal_id, fineMg: -fineMg, grossMg: -grossMg, purity: purity.purity, valuePaisa: -value,
      source: 'karigar_issue', refType: 'karigar_job', refId: job.id, note: `${job.job_no}: issued to ${job.karigar_name}`
    });
    ledger.post(store, user, {
      date: now, narration: `${job.job_no}: ${(fineMg / 1000).toFixed(3)} g fine issued to ${job.karigar_name}`,
      refType: 'karigar_job', refId: job.id,
      lines: [
        { account: A.KARIGAR_WIP, debit: value, party_type: 'karigar', party_id: job.karigar_id },
        { account: A.METAL, credit: value }
      ]
    });
  }

  r.post('/karigar-jobs', perm('karigars.manage'), (req, res) => {
    const body = req.body || {};
    const issues = Array.isArray(body.issues) ? body.issues : [];
    if (!issues.length) throw badRequest('Enter the gold being given to the karigar.');
    const jobId = store.tx(() => {
      const karigar = store.get('SELECT * FROM karigars WHERE id = ? AND is_active = 1', id(body.karigar_id, 'Karigar'));
      if (!karigar) throw badRequest('Choose a karigar.');
      const firstPurity = store.get('SELECT metal_id FROM purities WHERE id = ?', id(issues[0].purity_id, 'Purity'));
      if (!firstPurity) throw badRequest('Choose a purity.');
      let orderId = null;
      if (body.order_id) {
        const order = store.get('SELECT * FROM orders WHERE id = ?', id(body.order_id, 'Order'));
        if (!order || !['open', 'ready'].includes(order.status)) throw rule('That order is not open.');
        orderId = order.id;
      }
      const jobNo = ledger.nextNumber(store, 'karigar_job', 'KJ-', 5);
      const rowId = store.run(
        `INSERT INTO karigar_jobs (job_no, karigar_id, metal_id, description, order_id, due_date, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        jobNo, karigar.id, firstPurity.metal_id, text(body.description, 'Work description', { max: 200, required: true }),
        orderId, dueDate(body.due_date), nowIso(), req.user.id
      ).lastInsertRowid;
      const job = store.get(`${JOB_SELECT} WHERE j.id = ?`, rowId);
      issues.forEach((line, i) => issueGold(req.user, job, line, `Gold ${i + 1}`));
      store.audit(req.user, 'create', 'karigar_job', rowId, { job_no: jobNo, karigar: karigar.name });
      return rowId;
    });
    res.status(201).json(getJob(jobId));
  });

  r.post('/karigar-jobs/:id/issue', perm('karigars.manage'), (req, res) => {
    const jobId = id(req.params.id);
    store.tx(() => {
      const job = store.get(`${JOB_SELECT} WHERE j.id = ?`, jobId);
      if (!job) throw notFound('Job not found.');
      if (job.status !== 'open') throw rule('This job is closed.');
      issueGold(req.user, job, req.body, 'Gold');
      store.audit(req.user, 'issue', 'karigar_job', jobId, req.body);
    });
    res.json(getJob(jobId));
  });

  r.post('/karigar-jobs/:id/receive', perm('karigars.manage'), (req, res) => {
    const jobId = id(req.params.id);
    const body = req.body || {};
    store.tx(() => {
      const job = store.get(`${JOB_SELECT} WHERE j.id = ?`, jobId);
      if (!job) throw notFound('Job not found.');
      if (job.status !== 'open') throw rule('This job is closed.');

      const pieces = (Array.isArray(body.pieces) ? body.pieces : []).map((p, i) => {
        const product = readProduct({ ...p, cost: 0 }, `Piece ${i + 1}`);
        const purity = store.get('SELECT * FROM purities WHERE id = ?', product.purity_id);
        if (!purity || purity.metal_id !== job.metal_id) throw rule(`Piece ${i + 1}: purity must be ${job.metal_name.toLowerCase()}.`);
        return { product, fine: fineOf(product, purity.purity) };
      });
      const returned = (Array.isArray(body.returned) ? body.returned : [])
        .filter((x) => x && x.gross_g !== '' && x.gross_g !== undefined && Number(x.gross_g) !== 0)
        .map((x, i) => {
          const purity = store.get('SELECT * FROM purities WHERE id = ?', id(x.purity_id, `Returned metal ${i + 1}: purity`));
          if (!purity || purity.metal_id !== job.metal_id) throw rule(`Returned metal ${i + 1}: purity must be ${job.metal_name.toLowerCase()}.`);
          const grossMg = toMg(x.gross_g, `Returned metal ${i + 1}: weight`);
          return { purity, grossMg, fine: Math.round(grossMg * purity.purity) };
        });
      const wastageMg = toMg(body.wastage_g, 'Wastage allowed');
      const labour = toPaisa(body.labour, 'Labour charge');

      const piecesFine = pieces.reduce((a, p) => a + p.fine, 0);
      const returnedFine = returned.reduce((a, x) => a + x.fine, 0);
      const consumedFine = piecesFine + returnedFine + wastageMg;
      const remainingFine = job.issued_fine_mg - job.consumed_fine_mg;
      const remainingValue = job.issued_value_paisa - job.consumed_value_paisa;
      if (consumedFine === 0 && labour === 0) throw rule('Enter the pieces or metal received.');
      if (labour > 0 && !pieces.length) throw rule('Labour is charged on pieces. Add the pieces received.');
      if (consumedFine > remainingFine) {
        throw rule(`This is ${(consumedFine / 1000).toFixed(3)} g fine, but only ${(remainingFine / 1000).toFixed(3)} g fine is left with the karigar on this job. Issue more gold first, or check the weights.`);
      }

      const consumedValue = consumedFine === remainingFine ? remainingValue : Math.round((remainingValue * consumedFine) / remainingFine);
      const returnedValue = consumedFine ? Math.round((consumedValue * returnedFine) / consumedFine) : 0;
      const piecesValue = consumedValue - returnedValue; // includes the wastage allowed
      const now = nowIso();

      const receiptId = store.run(
        `INSERT INTO karigar_receipts (job_id, received_at, pieces_fine_mg, returned_fine_mg, wastage_fine_mg, labour_paisa, consumed_value_paisa, note, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        jobId, now, piecesFine, returnedFine, wastageMg, labour, consumedValue, text(body.note, 'Note', { max: 200 }), req.user.id
      ).lastInsertRowid;

      const costs = allocate(piecesValue + labour, pieces.map((p) => p.fine));
      const created = pieces.map((p, i) => insertProduct(store, req.user, { ...p.product, cost_paisa: costs[i] }, { source: 'karigar', sourceId: receiptId }));

      const returnedValues = allocate(returnedValue, returned.map((x) => x.fine));
      returned.forEach((x, i) => {
        metal.add(store, req.user, {
          date: now, metalId: job.metal_id, fineMg: x.fine, grossMg: x.grossMg, purity: x.purity.purity, valuePaisa: returnedValues[i],
          source: 'karigar_return', refType: 'karigar_job', refId: jobId, note: `${job.job_no}: returned by ${job.karigar_name}`
        });
      });

      store.run('UPDATE karigar_jobs SET consumed_fine_mg = consumed_fine_mg + ?, consumed_value_paisa = consumed_value_paisa + ? WHERE id = ?',
        consumedFine, consumedValue, jobId);
      if (body.close === true || body.close === 'true') {
        store.run("UPDATE karigar_jobs SET status = 'closed', closed_at = ? WHERE id = ?", now, jobId);
      }

      const party = { party_type: 'karigar', party_id: job.karigar_id };
      ledger.post(store, req.user, {
        date: now, narration: `${job.job_no}: received from ${job.karigar_name}${created.length ? ` (${created.map((c) => c.item_code).join(', ')})` : ''}`,
        refType: 'karigar_job', refId: jobId,
        lines: [
          { account: A.METAL, debit: returnedValue, memo: 'Metal returned' },
          pieces.length
            ? { account: A.STOCK, debit: piecesValue + labour, memo: 'Pieces made' }
            : { account: A.METAL_LOSS, debit: piecesValue, memo: 'Wastage allowed' },
          { account: A.KARIGAR_WIP, credit: consumedValue, ...party },
          { account: A.KARIGAR_PAYABLE, credit: labour, ...party }
        ]
      });
      store.audit(req.user, 'receive', 'karigar_job', jobId, {
        job_no: job.job_no, pieces: created.map((c) => c.item_code), returned_fine_mg: returnedFine, wastage_fine_mg: wastageMg, labour
      });
    });
    res.json(getJob(jobId));
  });

  r.post('/karigar-jobs/:id/close', perm('karigars.manage'), (req, res) => {
    const jobId = id(req.params.id);
    store.tx(() => {
      const job = store.get('SELECT * FROM karigar_jobs WHERE id = ?', jobId);
      if (!job) throw notFound('Job not found.');
      if (job.status !== 'open') throw rule('This job is already closed.');
      store.run("UPDATE karigar_jobs SET status = 'closed', closed_at = ? WHERE id = ?", nowIso(), jobId);
      store.audit(req.user, 'close', 'karigar_job', jobId, { job_no: job.job_no, gold_left_mg: job.issued_fine_mg - job.consumed_fine_mg });
    });
    res.json(getJob(jobId));
  });
}

module.exports = { registerKarigarRoutes };
