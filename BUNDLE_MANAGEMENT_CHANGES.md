# Bundle Management: Changes

---

## 1. Inventory Management

### 1.1  Before — How Stock Worked

**Product stock on bundle create:**
Creating a bundle did not touch product stock at all. Product quantities remained unchanged.

**Bundle stock formula:**
floor(product_stock ÷ qty_in_bundle), then take the minimum across all products.
Example: Product A = 20 units, Product B = 30 units, qty = 2 each
    min(floor(20 / 2), floor(30 / 2))  =  min(10, 15)  =  10

**What the number meant:**
A calculated display only — "how many bundles you could theoretically build." No units were set aside or reserved in BigCommerce.

**Webhook role:**
On any product stock or availability change, the webhook re-derived bundle stock from the live product quantities. Product stock was the sole source of truth.

**Selling a bundle:**
Bundle's own stock counter dropped, but product stock never decreased. This created a risk of overselling because the same product units could simultaneously satisfy individual product orders and bundle orders.

### 1.2  Now — How Stock Works

**Product stock on bundle create:**
Units are physically reserved in BigCommerce at the moment the bundle is created.
Example: Product A = 20 units, Product B = 30 units, qty = 2 each
    A is set to 18  (20 - 2),  B is set to 28  (30 - 2)

**Bundle stock formula:**
min floor((product_stock - 1) ÷ qty), then take the minimum.
The subtraction of 1 ensures at least one unit of each product is always preserved in the catalogue.
Example (using the already-reserved stock of 18 and 28):
    min(floor(19 / 2), floor(29 / 2))  =  min(9, 14)  =  9

**What the number means:**
A real reserved count. Those units are physically set aside in BigCommerce for the bundle and are not available for individual product sales.

**Webhook role:**
The webhook no longer re-derives bundle stock (doing so would corrupt the reservation). Its only responsibility now is: if a product is manually disabled by the merchant, disable the corresponding bundle.

**Selling a bundle:**
Products were already deducted at bundle creation, so there is no risk of overselling. When a bundle is deleted or edited, the unsold reserved units are returned to the product stock.

**Leftover guarantee:**
The formula always leaves at least 1 unit of each product remaining in the product listing, preserving individual product availability.

---

## 2. Price Management

### 2.1  Before — How Pricing Worked

**Where the price came from:**
The merchant manually typed a Bundle Price in the creation form (for example, "49.99").

**Relationship to product prices:**
None. Product prices were entirely ignored. The form showed an informational hint ("individual total: $X") but did not enforce or calculate anything from it.

**Discount concept:**
No discount mechanism existed. The merchant simply typed whatever final number they wanted as the bundle price.

**What was saved to BigCommerce:**
price = the typed number. sale_price was never set.

**On edit:**
Whatever new number the merchant typed was saved as-is, with no recalculation.

### 2.2  Now — How Pricing Works

**Where the price comes from:**
Calculated automatically from the selected products. The merchant no longer types a price manually.

**Subtotal formula:**
Subtotal = sum of (each product's unit_price x its qty in the bundle).
Example: Product A = $30 (qty 1), Product B = $20 (qty 1)  =>  subtotal = $50.

**Discount:**
The merchant enters a discount percentage (0 to 100).
Final price = subtotal x (1 - discount / 100).
Example: 5% discount on $50  =>  final price = $47.50.

**What gets saved to BigCommerce:**
price = subtotal (the full / regular price, e.g. $50).
sale_price = the discounted amount (e.g. $47.50). If discount = 0, sale_price is set to 0, meaning no sale price is shown.

**On edit:**
Price is recomputed from current product prices plus the saved discount percentage. If the merchant does not change the discount, the previously saved value is retained.

**Validation:**
There is no free-text price field. The system validates only that the discount is a number between 0 and 100.

**Stored configuration:**
The metafield stores discount_percent and each product's price at the time of creation. This allows the Edit screen to accurately reconstruct the pricing preview.

---

## 3. Bundle Management UI

### 3.1  Before — Bundle Creation & Editing

- The bundle creation and editing process was presented on a single page.
- All configuration fields were displayed together.
- Merchants had to complete the entire form at once.
- The interface became difficult to navigate for bundles containing many products.
- No guided workflow existed, making the process more prone to configuration mistakes.

### 3.2  Now — Step-by-Step Bundle Wizard

The bundle creation and editing experience has been redesigned into a guided multi-step workflow.

**New workflow**

- **Step 1 — Bundle Information:** Bundle Name, Categories, Images, Description
- **Step 2 — Product Selection:** Product Quantities, Inventory Preview
- **Step 3 — Pricing:** Automatic Subtotal Calculation, Discount Percentage, Final Bundle Price Preview
- **Step 4 — Review & Create Bundle**

**Benefits**

- Easier for merchants to understand.
- Reduces configuration errors.
- Improves navigation through large bundle configurations.
- Provides a cleaner and more user-friendly interface.
- Allows merchants to review settings before publishing.

---

## 4. Storefront Enhancements

### 4.1  Before — Product Detail Page

Individual product pages had no indication that the product was part of any bundle.
Customers could not:

- Discover bundles containing the product.
- Navigate from a product to its related bundles.
- See additional purchasing opportunities.

### 4.2  Now — Available Bundles Section

A new Available Bundles section has been added to the Product Detail Page (PDP).

**How it works**

- When a product belongs to one or more bundles, the storefront displays an Available Bundles section.
- Customers can click the section to view every bundle containing the selected product.
- Each bundle links directly to its Bundle Product Page.

---

## 5. Bundle Product Page

### 5.1  Before

- The bundle product page only displayed the bundle itself.
- Customers could not see which products were included in the bundle.

### 5.2  Now — Bundle Contents

A Bundle Contents section has been added to every bundle product page.

**Features**

- Displays all products included in the bundle.
- Shows the quantity of each product.
- Clearly communicates what customers receive when purchasing the bundle.
- Updates automatically based on the bundle configuration.
