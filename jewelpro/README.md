# JewelPro

Billing, stock, rates, purchases, karigars, orders, repairs and accounts for one jewellery shop. It runs on one shop computer; other computers and phones on the same Wi-Fi can use it through a web browser.

## 1. Install and start (Windows)

1. Install **Node.js 22 LTS** from https://nodejs.org (version 22.13 or newer), with the default options. Restart the computer.
2. Right-click **jewelpro.zip** → **Extract All** → type `C:\` as the folder → **Extract**. You now have the folder **`C:\jewelpro`**, with `start.bat` inside it.
   Do not extract it into `C:\jewelpro` itself (that gives `C:\jewelpro\jewelpro`), and do not run it from the Downloads folder or from inside the zip.
3. Double-click **`C:\jewelpro\start.bat`**. A black window opens and shows:
   ```
   JewelPro 2.6.0 is running.
   On this computer:    http://localhost:3000
   On the shop network: http://192.168.x.x:3000
   ```
4. Open **http://localhost:3000** in Chrome or Edge.
5. If Windows Firewall asks, choose **Allow** for **Private networks** only.

Keep the black window open while the shop is working. To stop JewelPro, close that window.

To start it automatically when the computer starts: press `Win+R`, type `shell:startup`, press Enter, and put a shortcut to `start.bat` in that folder.

**Which version am I running?** The black window says it ("JewelPro 2.2.0 is running"), and so does the bottom of the menu in the browser.

**Help inside JewelPro:** the **Help** page in the menu explains everyday jobs, with separate instructions for staff and the owner.

## 2. First-time setup (do these in order)

1. **Create the owner account** on the first screen. Remember this password; nobody can recover it for you.
2. **Settings → Shop and invoice**: shop name, address, phone, PAN, VAT details, invoice title.
3. **Settings → Billing rules**: check *grams in one tola* (set to 11.664; confirm the figure your shop uses), how you enter rates (per tola, per 10 g or per gram), rounding, and the staff discount limit.
4. **Settings → Charge profiles**: the "Standard" profile starts with a making charge of Rs 0. Edit it to match how you price, and add more profiles if different items are priced differently (for example "Chain – 8% wastage", "Plain bangle – Rs 900/g making").
5. **Settings → Categories**: link each category to its usual charge profile. The code prefix (RG, CH, …) starts each item code. (Names can also be changed from Stock → Categories.)
6. **Settings → Taxes**: no tax is set up. Add each tax only after your accountant confirms the rate and what it applies to (see section 7).
7. **Today's rates**: enter selling and buying rates.
8. **Stock → Add item**: enter your pieces (category, purity, net weight, and the karigar who made each) and print their tags.
9. **Staff accounts**: add a login for each staff member with the role **Staff**. They choose their own password the first time.
10. **Categories**: rename or add categories any time from **Stock → Categories**.

### Nepali (BS) dates

Dates are shown in BS with AD beside them. Change this in **Settings → Billing rules → Show dates as** (BS with AD, BS only, AD only). Date filters in Invoices and Reports use BS year, month and day pickers, and Reports has a **Fiscal year** button (from 1 Shrawan).

BS month lengths are fixed each year by the official calendar committee and cannot be calculated. JewelPro has them built in and verified up to **2083**. Later years are best guesses (marked "Not confirmed"). When the official patro for a new year is published:

1. Open **Settings → Nepali calendar**.
2. Choose the year, type the number of days in each month from the patro, note where you checked it, and press **Save this year**.

The dashboard reminds the owner about two months before an unconfirmed year starts. Invoices are stored with their exact date and time, so correcting a year only changes how dates are shown, never the records.

## 3. Daily use

- **Morning:** enter today's rates. The dashboard shows rates that are out of date, overdue karigar jobs, orders and repairs due or ready, and cash in hand.
- **Billing:** New bill → choose or add the customer → scan each tag (or type its code and press Enter) → add old gold if the customer brings any → enter discount and payment → **Save and print**.
  - A walk-in customer must pay in full. To leave a balance due, choose or add the customer by name.
  - If the customer has an order with an advance, choose it under **Use order advance**; the advance is taken off the bill.
- **Customer pays a balance later:** Invoices → open the invoice → Receive payment.
- **Buying stock:** Purchases → New purchase. Add **ready pieces** (each gets an item code and goes into stock at the price paid) or **metal / bullion** (goes into metal stock by weight). Pay now or later; the supplier's page shows what you owe and lets you record payments.
- **Karigar work:** Karigars → **Give gold for a job** (the gold comes out of metal stock). When the work comes back, open the job → **Receive work**: enter the pieces, any metal returned, the wastage you allow and the labour charge. Pieces get item codes and a cost price automatically (gold used + wastage + labour). What is still with the karigar is shown on every job and on the karigar's page. Overdue jobs have a **Remind on WhatsApp** button.
- **Buying old gold from a customer (no sale):** Metal and old gold → **Buy old gold**. Choose or add the customer (their name and phone are recorded), print the voucher and have them sign it.
- **Customer orders:** Orders → New order, with any advance. Mark it **Ready** when made (a WhatsApp button then tells the customer), and use **Bill this order** to make the bill with the advance deducted. Cancelling refunds the unused advance.
- **Repairs:** Repairs → New repair. Weigh the piece in front of the customer; the job card prints with that weight. Mark **Ready**, tell the customer on WhatsApp, and **Deliver** with the weight back and the charge.
- **Expenses:** Accounts → Record expense (rent, salaries, electricity, …).
- **End of day:** Reports and Accounts → Day book. Check cash against the drawer and bank / QR against statements.

**WhatsApp:** the buttons open WhatsApp (on the phone or computer) with the message already typed. You check it and press Send. Nothing is sent automatically, so it costs nothing and needs no account setup. Phone numbers of 10 digits get 977 added in front.

### Stock sheet

**Stock** in the menu is a sheet like Excel: a **tab for each category** (with how many pieces), and one row per piece with **date in stock, code, category, item, purity, gross, stone and net weight, karigar or supplier, status, and the date, invoice and customer when sold**.

- **Search** by code, item, karigar or HUID, and choose In stock, Sold, Removed or All. Click a column heading to sort.
- **Double-click a row** to open that piece's window: where it came from (karigar and job, or supplier and purchase), when it came into stock, its weights, and its full history, including when and to whom it was sold.
- **Edit cells:** press **Edit cells**, **double-click a cell**, change it and press **Enter** (Esc cancels). Category, item name, purity, gross, net, karigar and HUID can be changed for pieces in stock. Arrow keys move between cells. Every change is recorded in the audit log and the stock register.
- **Download for Excel** saves the current sheet as a CSV file that Excel opens.
- Click a **karigar's name** to open that karigar's window.

**Entering stock:** the **category** and **net weight** are required. **Gross weight** is only for pieces with stones (empty means the same as net; stone weight = gross − net). The **item name** is optional; the category name is used. Choose **Made by karigar** so the piece is added to that karigar's account, and set **Came into stock on** when entering older stock.

**Grams or tola:** the **Gram / Tola** switch (bottom of the menu, and on the Stock page) shows and takes every weight in grams or in tola, everywhere in JewelPro. **1 tola = 11.664 g** (the figure in Settings → Billing rules). Weights are always stored in milligrams, so switching never changes them; tola is shown to 4 decimals and typed to 6, so saving a weight unchanged in tola keeps it exactly.

### Karigar window

Press **Items made** next to any karigar on the **Karigars** page, click a karigar's name in the Stock sheet, or open the karigar and press **Everything made (window)**: every piece that karigar made, from jobs or entered directly, with **date, code, category, purity, gross and net weight, whether it is still in stock, and the date, invoice and customer if sold**. Choose all time, this fiscal year or this month, and print it.

### Stock register (owner)

**Stock register** works like the shop's register book, and opens at today's page:

- Each **category is a row** (Ring, Chain, Jhumka, …) and each **day has two boxes**: **M** (morning) and **E** (evening).
- **Count the pieces and type the number in the box.** It saves by itself; there is no save button. Press **Enter** to go down to the next item (like writing down a column in the book), **Tab** to go right, **Esc** to undo a box.
- The **grey number** in an empty box is what the system says should be there. What you type turns **green** if it matches and **red** if it does not; point at the box to see the system's number. Empty a box to clear it.
- If you counted a column and everything matched, press the small **✓** above it to fill its empty boxes with the system numbers.
- **7 / 15 / 30 days** chooses how many days you see; **◀ Earlier** and **Later ▶** turn the pages; scroll sideways to move through the days.
- A small **+1** or **−1** in a box shows a change during that day. The **Checked by** row at the bottom shows who typed the counts, like signing the book.
- **Double-click a category name** to open its window: every piece remaining, with item code, weight, the karigar or supplier it came from, and the date it came into stock.
- Click a **date** to see that day in full: every piece that came in or went out, when, who did it, and from or to whom.
- **Arrange rows** moves rows up or down, removes a row (it can be shown again), adds a new category row, or deletes a category that never had items. Categories with no stock are left out until you need them.

The register covers shop stock only (not owner-only stock kept outside), and its history is never deleted.

### Karigar account by weight

Open a karigar to see, for any period, **every item they made for the shop** (item code, category, gross, net and fine weight, whether it is still in stock, and when it was sold) with totals per category. The **gold account** lists gold given, gold that came back in pieces, metal returned and wastage allowed, with the balance still with the karigar. Labour charges are optional; if you don't track them, leave labour empty.

### Accounts

Every bill, payment, purchase, karigar receipt, old gold voucher, order advance, repair and expense is posted to the accounts automatically, using proper double entry. Under **Accounts** you have the day book, ledger for any account, trial balance, profit and loss, balance sheet and chart of accounts. Posted entries can never be edited; a mistake is undone with a reversing entry, so the history is always complete.

- Cash goes to the **Cash** account. Bank transfer, card, QR and cheque go to **Bank and digital payments**.
- Stock is valued at cost price. Items with no cost price show zero profit on the profit and loss (a warning says how many). Pieces from Purchases and Karigars always have a cost.
- Metal stock is tracked by fine weight and valued at average cost per gram.

**Audit lock:** in Settings, the owner can lock the books up to a date (for example once your accountant has closed a year). After that, nothing dated on or before that day can be added, cancelled or reversed.

### Owner and staff logins

| Login | Can do |
|---|---|
| **Owner** | Everything |
| **Staff** | Dashboard, today's gold rates, stock (add and edit items, add and rename categories), bills and invoices (including taking payments of balances), purchases and suppliers, customers. Discounts only up to the staff limit in Settings |

Staff **never see**: owner-only stock, cost prices, profit, what you owe suppliers, accounts, reports, metal stock, karigars, orders, repairs, settings, staff accounts or the audit log. Staff **cannot** cancel bills or purchases, or remove items from stock. Everything staff do is recorded in the audit log, which only the owner can read. Managers and cashiers from earlier versions become Staff automatically, with the same passwords.

**Owner-only stock (kept outside the shop):** open an item and, under *Owner only*, tick *Keep this item outside the shop stock* and write where it is kept (for example *Bank locker*). Staff then cannot see it, search for it, scan it or bill it, and it is not counted in their stock totals. The owner sees it with an *Owner only* badge and can filter Stock by *In the shop* or *Owner-only stock*. Untick it when the piece comes back into the shop.

**Categories:** Stock → **Categories** to add a new category or rename one. Renaming never changes item codes already printed on tags. When adding an item you can also press **New** next to the category to create one on the spot. Only the owner can change a category's code prefix or pricing (Settings).

## 4. Using it from other computers and phones

On any device connected to the **same shop Wi-Fi or network**, open the "On the shop network" address shown in the black window, for example `http://192.168.1.10:3000`.

If that address changes after the router restarts, ask whoever manages your router to give the shop computer a fixed (reserved) IP address.

**Do not make JewelPro reachable from the internet** (no port forwarding on the router). It is built for a trusted shop network.

## 5. Starting the accounts (opening balances)

Do this once, on the day you start using the accounts, so the balance sheet matches reality:

1. **Tagged stock:** enter each piece with its cost price (Stock → Add item). Its cost is added to the stock account automatically.
2. **Old gold and bullion in the shop:** Metal and old gold → *Opening stock* → fine weight and its value.
3. **Cash, bank, money customers owe you (from before JewelPro), money you owe suppliers and karigars:** Accounts → Journal voucher, against **3200 Opening balances**. Example for cash in the drawer: debit *1000 Cash*, credit *3200 Opening balances*.

Your accountant can help with the opening figures. After that, use Purchases and Karigars for new stock rather than adding items by hand, so costs are correct.

## 6. Backups

- JewelPro makes an automatic backup when it starts and then once a day, and keeps the latest 30 (change this in Settings).
- **Backup → Back up now** makes one immediately, and each backup can be downloaded from that page.
- Backups are in `data\backups` inside the JewelPro folder.
- **Daily cloud copy:** install *Google Drive for desktop* or use *OneDrive* on the shop computer, then on the Backup page enter a folder they sync (for example `C:\Users\Shop\Google Drive\JewelPro backups`). Every backup is then copied there as well and goes to the cloud automatically. A USB drive folder works too while the drive is plugged in. The backup file holds all your shop's data, so protect that cloud account with a strong password and two-step login.
- **All your data is in the `data` folder.** Copying that folder while JewelPro is stopped also makes a complete backup.

**Restore a backup:**

1. Close the JewelPro window.
2. In the `data` folder, rename `jewelpro.db` to `jewelpro-old.db`, and delete `jewelpro.db-wal` and `jewelpro.db-shm` if they exist.
3. Copy the backup file into `data` and rename it to `jewelpro.db`.
4. Start JewelPro again.

Test a restore once on a spare computer, so you know it works before you need it.

## 7. Updating JewelPro

Your shop's data is only in the **`data`** folder. Updates never contain a `data` folder, so they cannot overwrite it.

1. Close the black JewelPro window (every one, if more than one is open).
2. **Back up:** copy the folder `C:\jewelpro\data` to a USB drive or another safe place.
3. Right-click the update zip (for example `jewelpro-update-2.6.zip`) → **Extract All** → type `C:\` → **Extract**. When Windows asks, choose **Replace the files in the destination**.
   - If your JewelPro is in a different folder, extract the zip somewhere else first, then copy everything inside its `jewelpro` folder into your JewelPro folder and replace all.
4. Double-click `start.bat`. Check the black window shows the new version number. On the first start after an update, the database is upgraded automatically; this takes a few seconds and keeps all your data.
5. In the browser press **Ctrl+F5** (on a phone, close the tab and open the address again), then log in.

You can also use the full **jewelpro.zip** to update in the same way; it is bigger but contains everything.

**Moving to a new computer:** install Node.js, copy the whole `C:\jewelpro` folder (including `data`) to the same place on the new computer, and run `start.bat`.

**What happens once when upgrading from older versions:** from 1.x, your items, bills and payments are posted into the accounts; managers and cashiers become Staff with the same passwords; and the daily stock register is built from your existing records.

## 8. Before using it for real bills

JewelPro calculates exactly what it is configured to calculate. It does not know Nepal's tax rules and does not assume any. With your accountant, confirm and then enter:

- which taxes apply to jewellery sales, and their current rates;
- whether each tax is on the metal value, making charge, stone charges or the whole amount;
- whether tax applies before or after discount (JewelPro applies it **after** discount);
- how old gold taken in exchange is treated (JewelPro deducts it **after** tax);
- whether your bills must be called "Tax invoice" and what must be printed on them;
- whether you need an IRD-approved billing system (CBMS). **JewelPro is not IRD-certified**, so if your business requires a certified system, keep issuing your official bills from it;
- the grams-per-tola figure you use;
- whether your invoice numbers must restart each fiscal year (Settings → Invoice numbers);
- how VAT on purchases (input VAT) should be recorded. JewelPro records purchases at the full amount paid and does not track input VAT;
- whether repair charges are taxable (JewelPro records them without tax);
- what records you must keep when buying old gold from the public. JewelPro records the seller's name and phone on the voucher; keep any ID copy the law requires.

Run JewelPro alongside your current bill book for at least two weeks and compare the totals every day before relying on it.

## 9. Common problems

| Problem | What to do |
|---|---|
| `start.bat` says Node.js is not installed | Install Node.js 22 LTS, then restart the computer. |
| "JewelPro needs Node.js 22.13 or newer" | Install the latest Node.js 22 LTS from nodejs.org. |
| `EADDRINUSE` / port 3000 is in use | JewelPro is already running in another window, or another program uses port 3000. Close the other window. To use another port, run `set PORT=3100` then `node --no-warnings server.js` in Command Prompt in the JewelPro folder. |
| Phone cannot open the address | Same Wi-Fi as the shop computer? Did you allow the firewall for private networks? Try the address from the black window, not `localhost`. |
| "Enter today's selling rate for Gold 22K first" | Enter that purity's rate on Today's rates. |
| "Discounts above 2% need the owner" | The owner must make that bill, or the owner can change the staff limit in Settings. |
| Account locked | Wait 15 minutes, or the owner sets a new password in Staff accounts (this also unlocks it). |
| Owner forgot the password | Another owner can set a new one in Staff accounts. There is no other reset, so create a second owner account for emergencies and keep its password sealed. |
| Tags print at the wrong size | In the print dialog choose your label printer, set paper to 50 × 25 mm, margins "None", scale 100%. |
| "Not enough gold in metal stock" when giving gold to a karigar | The gold must be in metal stock first: buy it (Purchases), buy old gold, or enter opening stock. |
| "The books are locked up to …" | That date is inside the audit lock. The owner can change the lock in Settings. |
| Backup page says the second copy failed | The cloud or USB folder is missing or not writable. Check the folder exists and Google Drive / OneDrive is running. |
| After updating, the new menus are missing | Check the black window shows the new version. If not, you updated a different folder or the old window is still open: close every JewelPro window and start `start.bat` from the folder you updated. Then press Ctrl+F5 in the browser. |
| Screen shows "Something went wrong" | Read the error in the black window, and send it along with what you were doing. |

## 10. What is not included yet

Input VAT on purchases, tax-inclusive pricing, sending SMS or WhatsApp automatically (messages are click-to-send), bank reconciliation, payroll, Nepali numerals, multiple branches, and IRD (CBMS) certification.

## 11. For developers

- Requirements: Node.js 22.13+ (uses the built-in `node:sqlite`, so no database server is needed).
- Run: `npm start`; tests: `npm test` (billing engine unit tests, end-to-end API workflows, and a full business cycle that checks the trial balance and balance sheet balance after every step).
- Environment variables: `PORT` (default 3000), `HOST` (default 0.0.0.0), `JEWELPRO_DATA_DIR` (default `./data`).
- Money is stored in paisa and weight in milligrams as integers; rates per gram are stored in paisa with decimals.
- Structure: `server.js` (start-up, backups), `src/db.js` (schema, seed, upgrades), `src/bsdate.js` (BS calendar, shared with the browser), `src/billing.js` (pure pricing engine), `src/sales.js` (bills), `src/ledger.js` (double-entry posting, numbering, audit lock), `src/metal.js` (metal stock by fine weight and average cost), `src/backfill.js` (one-time posting of pre-2.0 data), `src/stock.js` (stock register book, category windows), `src/api.js` and `src/routes/*.js` (routes), `src/auth.js` (logins, roles), `public/` (browser app, no build step: `app.js` core, `sheet.js` stock sheet and windows, `business.js` purchases/metal, `workshop.js` karigars/orders/repairs, `accounts.js`, `stockreg.js`, `help.js`; fonts in `public/fonts` are IBM Plex under the SIL Open Font License).
- Posted journal entries are protected by database triggers (no update or delete); corrections are reversing entries.
