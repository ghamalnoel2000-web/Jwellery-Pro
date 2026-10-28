'use strict';

/* ======================================================================
   Help: how to do everyday jobs, written separately for staff and owner.
   ====================================================================== */

async function pageHelp(main) {
  const owner = can('settings.manage');
  const section = (title, body) => `<section class="panel"><h2>${esc(title)}</h2>${body}</section>`;
  const staffPart = `
    ${section('Make a bill', `<ol>
      <li>Press <strong>New bill</strong>. Choose the customer, or keep <em>Walk-in customer</em> if they pay in full now.</li>
      <li>Scan each tag, or type the item code and press <kbd>Enter</kbd>. The price is worked out from today's rate.</li>
      <li>If the customer gives old gold, press <strong>Add old gold</strong> and enter its weight and purity.</li>
      <li>Enter the payment (cash, bank, card, QR or cheque). Press <strong>Paid in full</strong> to fill the amount.</li>
      <li>Press <strong>Save and print</strong>.</li></ol>
      <p class="muted">To keep a balance due, the customer must be chosen by name, not walk-in. Discounts above the limit need the owner.</p>`)}
    ${section('Take a payment on an old bill', `<ol><li>Open <strong>Invoices</strong> and find the bill (search by number, name or phone).</li>
      <li>Under <strong>Receive payment</strong>, enter the amount and press the button. The receipt prints from the invoice.</li></ol>`)}
    ${section("Enter today's rates", `<ol><li>Open <strong>Today's rates</strong> each morning.</li>
      <li>Enter the selling and buying rate for each purity and press <strong>Save rates</strong>. The dashboard shows the rates to everyone.</li></ol>`)}
    ${section('Add stock and print tags', `<ol><li>Open <strong>Stock</strong> and press <strong>Add item</strong>.</li>
      <li>Choose the <strong>category</strong> (or press <strong>New</strong> to make one) and the purity, and enter the <strong>net weight</strong>. Net weight is required.</li>
      <li><strong>Gross weight</strong> is only needed for pieces with stones; leave it empty otherwise. The item name is optional; the category name is used.</li>
      <li>Choose the <strong>karigar</strong> who made it, if you know. The piece then appears in that karigar's account. Change <strong>Came into stock on</strong> for old stock.</li>
      <li>Press <strong>Add and print tag</strong>. To print tags again later, tick items in the Stock sheet and press <strong>Print tags</strong>.</li></ol>
      <p class="muted">Rename or add categories from <strong>Stock → Categories</strong>. Tags already printed keep their codes.</p>`)}
    ${section('The stock sheet', `<ul>
      <li><strong>Stock</strong> is a sheet like Excel: one tab for each category, with date in stock, code, purity, gross, stone and net weight, karigar, status, and when it was sold.</li>
      <li>Click a column heading to sort. <strong>Double-click a row</strong> to see everything about that piece: where it came from, when, its weights, and when and to whom it was sold.</li>
      <li>Press <strong>Edit cells</strong>, then <strong>double-click a cell</strong> to change it (category, item, purity, gross, net, karigar, HUID). Press <kbd>Enter</kbd> to save or <kbd>Esc</kbd> to cancel. Arrow keys move between cells.</li>
      <li><strong>Download for Excel</strong> saves the sheet you are looking at as a file Excel opens.</li></ul>`)}
    ${section('Grams or tola', `<p>Use the <strong>Gram / Tola</strong> switch at the bottom of the menu (or on the Stock page) to show and type every weight in grams or in tola.
      1 tola = ${gramsPerTola()} g. Weights are always stored exactly in milligrams, so switching never changes them.</p>`)}
    ${section('Record a purchase from a supplier', `<ol><li>Open <strong>Purchases</strong> and press <strong>New purchase</strong>.</li>
      <li>Choose the supplier and enter their bill number.</li>
      <li>Add each <strong>ready piece</strong> (it gets its own item code) or <strong>metal / bullion</strong> by weight, with the price on their bill.</li>
      <li>Press <strong>Save purchase</strong>, then <strong>Print tags</strong> for the new pieces.</li></ol>`)}
    ${section('Customers', `<p>Add customers from <strong>Customers</strong> or straight from a bill with <strong>New customer</strong>. A phone number lets you send bills and reminders on WhatsApp.</p>`)}`;

  const ownerPart = `
    ${section('Staff logins', `<ul>
      <li>Add a login for each staff member in <strong>Staff accounts</strong>, with the role <strong>Staff</strong>. They choose their own password the first time.</li>
      <li>Staff can use the dashboard, rates, stock, bills, purchases and customers. They cannot see owner-only stock, cost prices, profit, accounts, reports, settings or the audit log, and cannot cancel bills or purchases.</li>
      <li>To stop someone logging in, untick <strong>Active</strong> for them. Everything each person does is in the <strong>Audit log</strong>.</li></ul>`)}
    ${section('Stock kept outside the shop', `<ol><li>Open the item in <strong>Stock</strong>.</li>
      <li>Under <strong>Owner only</strong>, tick <em>Keep this item outside the shop stock</em> and write where it is (for example Bank locker). Save.</li>
      <li>Staff can no longer see or bill it. Untick it when the piece comes back to the shop.</li></ol>`)}
    ${section('Stock register (the register book)', `<ol><li>Open <strong>Stock register</strong>. It opens at today, like the register book: each category is a row, and each day has an <strong>M</strong> (morning) and <strong>E</strong> (evening) box.</li>
      <li>Count the pieces on the shelf and <strong>type the number in the box</strong>. It saves by itself. Press <kbd>Enter</kbd> to go down to the next item, <kbd>Tab</kbd> to go right.</li>
      <li>The grey number in an empty box is what the system says. Your number turns <strong>green</strong> when it matches and <strong>red</strong> when it does not; point at the box to see the system's number.</li>
      <li>If everything in a column matched, press the small <strong>✓</strong> above it to fill the empty boxes with the system numbers.</li>
      <li>Use <strong>7 / 15 / 30 days</strong> to see more days, and <strong>◀ Earlier</strong> to go back. Scroll sideways like turning pages.</li>
      <li><strong>Double-click a category name</strong> to see every piece with its code, karigar and date. Click a date to see everything that came in and went out that day.</li>
      <li><strong>Arrange rows</strong> lets you move, remove or add rows.</li></ol>`)}
    ${section('Karigars', `<ol><li>Open <strong>Karigars</strong>, add the karigar, then <strong>Give gold for a job</strong>. The gold must be in metal stock first.</li>
      <li>When pieces come back, open the job and use <strong>Receive work</strong>: enter each piece, any metal returned and the wastage you allow. Pieces get item codes and go into stock.</li>
      <li>Press <strong>Items made</strong> next to a karigar on the Karigars page, click a karigar's name in the Stock sheet, or press <strong>Everything made (window)</strong> on their page, to see every piece they made: code, category, weight, date, and when it was sold.</li>
      <li>Pieces entered in Stock with the karigar's name are included too.</li></ol>`)}
    ${section('Orders, repairs and old gold', `<ul>
      <li><strong>Orders:</strong> take the advance, mark <strong>Ready</strong>, then <strong>Bill this order</strong> so the advance comes off the bill.</li>
      <li><strong>Repairs:</strong> weigh the piece in front of the customer, print the job card, and weigh it again on delivery.</li>
      <li><strong>Buying old gold:</strong> Metal and old gold → <strong>Buy old gold</strong>. Print the voucher for the seller to sign.</li></ul>`)}
    ${section('Accounts and end of day', `<ul>
      <li>Every bill, payment, purchase and expense goes into <strong>Accounts</strong> automatically. Record rent, salaries and other costs with <strong>Record expense</strong>.</li>
      <li>At the end of the day, compare cash in the drawer with the <strong>Cash</strong> ledger, and bank or QR with your statements.</li>
      <li>Once your accountant has closed a period, lock it in <strong>Settings → Audit lock</strong>.</li></ul>`)}
    ${section('Backups', `<ul>
      <li>JewelPro backs up automatically every day. On the <strong>Backup</strong> page, set a Google Drive or OneDrive folder so each backup is also copied to the cloud.</li>
      <li>Before updating JewelPro, copy the <strong>data</strong> folder to a USB drive.</li></ul>`)}`;

  main.innerHTML = `<div class="help">
    <h1>Help</h1>
    <p class="muted">You are logged in as <strong>${esc(ROLE_LABELS[state.user.role])}</strong>. JewelPro version ${esc(state.status.version || '')}.
      The full guide, including installing and updating, is the README file in the JewelPro folder.</p>
    ${owner ? '<h2 style="margin-top:1.5rem">Everyday work</h2>' : ''}
    ${staffPart}
    ${owner ? `<h2 style="margin-top:1.5rem">For the owner</h2>${ownerPart}` : ''}
    ${section('If something goes wrong', `<ul>
      <li><strong>Screens look old after an update:</strong> press <kbd>Ctrl</kbd>+<kbd>F5</kbd>.</li>
      <li><strong>"Cannot be reached":</strong> check the black JewelPro window is still open on the shop computer.</li>
      <li><strong>"Enter today's selling rate first":</strong> enter that purity on Today's rates.</li>
      <li><strong>Locked out after wrong passwords:</strong> wait 15 minutes, or ask the owner to set a new password.</li></ul>`)}
  </div>`;
}
