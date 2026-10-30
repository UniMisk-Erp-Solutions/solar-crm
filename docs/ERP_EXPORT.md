# ERP export — Tally and SAP Business One column layouts

`GET /api/v1/exports/erp?doc=pi|so|invoice&layout=tally|sap&format=csv|xlsx&from=YYYY-MM-DD&to=YYYY-MM-DD` (roles `accounts`, `management`, `sales_manager`, `admin`). Defined in `apps/api/src/services/erpExport.ts`
(`TALLY_COLUMNS`, `SAP_COLUMNS`, `ERP_DEFAULTS`). Endpoint reference: `docs/api/orders.md` §6.

Both layouts are **flat, one row per document line**; the document header columns repeat on every row of the document. Header names are the first row of the CSV / the first row (navy, frozen) of the XLSX sheet. CSV is UTF-8, comma-separated,
CRLF line ends, fields containing `,` `"` or a line break are quoted (`"` doubled); no BOM, no thousands separators, amounts with a `.` decimal point. In the XLSX the numeric columns are real numbers formatted `#,##0.00`.
The layouts follow the shape of each ERP's voucher / marketing-document import, but every company's ledger and item masters differ: **map the first export once in the ERP's import wizard** (Tally: *Import Data → Excel* column mapping;
SAP B1: *Data Transfer Workbench*, documents template with repeated header) and keep the mapping for later runs. Ledger / warehouse names the ERP must already know are the constants in `ERP_DEFAULTS` (`Solar Sales`, `WH01`, `INR`).

## Which documents, which dates

| `doc` | one document is | included when | date filter (`from`/`to`, inclusive) |
|---|---|---|---|
| `pi` | an issued proforma invoice | status `issued`, `partially_paid` or `paid` | `issue_date` |
| `so` | a sales order | status not `draft` / `cancelled` | `order_date` |
| `invoice` | one **shipped dispatch** (the tax invoice for that consignment) | dispatch status `dispatched` / `delivered` | the IST calendar date of `dispatched_at` |

Rows for `invoice` carry what actually shipped on that dispatch: serial-tracked lines with the quantity of serials on the dispatch (amount pro-rated from the order line), and the bulk (non-serialised) lines — structures, cables — on the order's first shipped dispatch only. External users cannot export; internal users restricted by territory get only the sales orders / dispatches of their territories.

## Tax and money rules (both layouts)

* `Amount` / `LineTotal` = the line's net taxable value (line total after any line discount; for `invoice` pro-rated by quantity shipped). `Discount %` = `1 − amount ÷ (qty × rate)` when positive, else 0.
* GST per line = `amount × GST rate ÷ 100`, rounded to 2 decimals. **Intra-state** (place of supply state = the organisation's state): CGST = SGST = half, IGST 0. **Inter-state**: IGST = full, CGST/SGST 0. Place of supply = the shipping address state (billing as fallback).
* Freight (`Freight Amount` / `FreightExpense`) is a header-level amount, written **on the first line of the document only** (0 on the others) so a column sum is not double counted. Its GST is part of the document's `tax_total` on the PI, not split here.
* A customer billed as an unregistered individual has an empty GSTIN column (the `UNREGISTERED` flag is not exported).

## Layout 1 — Tally (`layout=tally`)

| # | Column | Content |
|---|---|---|
| 1 | `Voucher Date` | `DD-MM-YYYY` — PI issue date / SO order date / dispatch date |
| 2 | `Voucher Type Name` | `Proforma Invoice` · `Sales Order` · `Sales` (create the first two as voucher types in Tally if absent) |
| 3 | `Voucher Number` | PI no `FS/PI/yy/nnnn` · SO no `FS/SO/yy/nnnn` · dispatch invoice no `FS/INV/yy/nnnn` (dispatch no if no invoice no) |
| 4 | `Reference No` | PI: quotation no · SO: customer PO no · invoice: sales order no |
| 5 | `Reference Date` | PI: empty · SO: customer PO date · invoice: order date (`DD-MM-YYYY`) |
| 6 | `Party Ledger Name` | the bill-to customer's legal name |
| 7 | `Party GSTIN` | customer GSTIN, empty when unregistered |
| 8 | `Place of Supply` | state name |
| 9 | `Billing Address` | `line1, line2, city, State - pincode` on one line |
| 10 | `Shipping Address` | same format |
| 11 | `Sales Ledger` | constant `Solar Sales` |
| 12 | `Line No` | 1, 2, 3 … within the voucher |
| 13 | `Stock Item Name` | line description |
| 14 | `HSN/SAC` | line HSN (SKU HSN as fallback) |
| 15 | `Quantity` | quantity |
| 16 | `UOM` | SKU unit of measure, `NOS` when the line has no SKU |
| 17 | `Rate` | unit price |
| 18 | `Discount %` | derived discount percentage |
| 19 | `Amount` | net taxable line value |
| 20 | `GST Rate %` | line GST rate (empty when unknown) |
| 21 | `CGST Amount` | intra-state half of the line GST |
| 22 | `SGST Amount` | intra-state half of the line GST |
| 23 | `IGST Amount` | inter-state line GST |
| 24 | `Freight Amount` | freight, first line of the voucher only |
| 25 | `Serial Numbers` | `invoice` only: serials shipped on this line, space-separated, sorted; empty otherwise |
| 26 | `Narration` | PI: funding split (consumer / loan / subsidy receivable) · SO: PI and PO reference · invoice: dispatch no, order no, vehicle, e-way bill |

Example (PI, first row): `26-10-2026,Proforma Invoice,FS/PI/26/0001,FS/Q/26/0001,,Patel Textiles Pvt Ltd,24ABCDE1234F1Z5,Gujarat,"12 Satellite Road, Ahmedabad, Gujarat - 380015",…,Solar Sales,1,Waaree 545 Wp DCR module,85414200,10,NOS,30000,0,300000,5,7500,7500,0,8000,,"Proforma invoice FS/PI/26/0001; funding: consumer 322000, loan 100000, subsidy receivable 78000"`

## Layout 2 — SAP Business One (`layout=sap`)

Marketing-document style (`ORDR`/`OPCH`-like header fields repeated with the `RDR1`-like row fields), Data Transfer Workbench friendly: dates are `YYYYMMDD`, row numbering starts at 0.

| # | Column | Content |
|---|---|---|
| 1 | `DocNum` | same document number as Tally's `Voucher Number` |
| 2 | `DocDate` | `YYYYMMDD` |
| 3 | `DocDueDate` | PI: `valid_till` · otherwise the document date |
| 4 | `TaxDate` | = `DocDate` |
| 5 | `CardCode` | stable surrogate for the customer: `CUST-` + first 8 characters of the CRM customer id, upper case — map it to your BP codes once |
| 6 | `CardName` | customer legal name |
| 7 | `NumAtCard` | PI: quotation no · SO: customer PO no · invoice: sales order no |
| 8 | `GSTIN` | customer GSTIN, empty when unregistered |
| 9 | `BillToAddress` | one-line address |
| 10 | `ShipToAddress` | one-line address |
| 11 | `PlaceOfSupply` | state name |
| 12 | `PaymentTerms` | PI payment terms text |
| 13 | `Comments` | same text as Tally's `Narration` |
| 14 | `DocCurrency` | constant `INR` |
| 15 | `LineNum` | 0-based row number |
| 16 | `ItemCode` | `MAKE-MODEL[-VARIANT]` of the SKU, upper case, spaces → `-` (`ITEM-<n>` when the line has no SKU) |
| 17 | `ItemDescription` | line description |
| 18 | `HSNCode` | line HSN |
| 19 | `Quantity` | quantity |
| 20 | `UoMCode` | SKU unit of measure (`NOS` default) |
| 21 | `UnitPrice` | unit price |
| 22 | `DiscountPercent` | derived discount percentage |
| 23 | `TaxCode` | `GST<rate>` e.g. `GST5`, `GST18` (empty when the rate is unknown) |
| 24 | `LineTotal` | net taxable line value |
| 25 | `CGSTAmount` | intra-state half |
| 26 | `SGSTAmount` | intra-state half |
| 27 | `IGSTAmount` | inter-state |
| 28 | `FreightExpense` | freight, first row of the document only |
| 29 | `WarehouseCode` | constant `WH01` |
| 30 | `SerialNumbers` | `invoice` only, space-separated |
| 31 | `U_CRM_Ref` | CRM record id (PI id / sales-order id / dispatch id) — user-defined field to keep the link back to the CRM |

## Operating notes
* Re-exporting a range produces the same file; deduplicate on `Voucher Number` / `DocNum` + line number in the ERP import (the CRM does not track what has been imported).
* The exporter never changes CRM data; each call writes an `erp.export` audit entry (`doc`, `layout`, `format`, range, voucher and row counts).
* To change ledger / warehouse names, edit `ERP_DEFAULTS` in `erpExport.ts` (they are chart-of-accounts constants of the books, not regulatory values, so they are not in `rule_config`).
