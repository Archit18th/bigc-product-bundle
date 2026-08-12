# Bundle Manager — Changes Report

_Last updated: 2026-06-30_

This report explains, in plain language, what the app did before and what we have changed and added now.

---

## Pricing

Earlier the merchant had to type the bundle price by hand. Now we changed it so the price is calculated automatically — we add up the prices of all the products in the bundle and apply a discount percentage the merchant sets. So the merchant only chooses a discount, and the bundle price is worked out for them.

## Stock and availability

Earlier the bundle stock had to be managed manually. Now we made the stock automatic — the app looks at every product inside the bundle and works out how many full bundles can be built. If any product goes out of stock, the bundle is disabled on its own, and when stock comes back the bundle is enabled again.

## Storefront product page

We added a "Available in N bundles" link on the product page, so when a customer is looking at a product they can see which bundles it belongs to and open them. We also added a "this bundle includes" list on the bundle page, so customers can see exactly which products are inside the bundle.

## Cart page

We changed the cart so that a bundle shows as a proper bundle. Earlier the components would have shown as separate ₹0 lines, which looked messy. Now we hide those rows and show a clean breakdown of the products inside the bundle under the bundle line. So the cart UI now behaves like a bundle UI.

## Add to cart

We added the ability to add a bundle to the cart as a single item. Earlier there was no real cart/checkout handling; now the customer can add the whole bundle in one click and it goes through checkout as one line.

## Order confirmation page

We added a bundle breakdown on the order confirmation (thank-you) page and on the customer's order detail page, so after buying, the customer can see which products were inside each bundle they ordered.

## Orders behind the scenes

This is completely new. When an order with a bundle is placed, we now:
- write the bundle's product breakdown into the order's staff notes, so the store team can see what to pack, and
- automatically reduce the stock of each component product.

And if the order is later cancelled, refunded or declined, we automatically add that stock back. None of this existed before.

## Admin bundle list

Earlier this was a simple table. We have improved it a lot — it now has tabs (all, out of stock, low stock, visible, hidden), a search box, sortable columns, a quick-view popup to preview a bundle, and a duplicate button to copy a bundle. We also added a "re-index products" button to refresh the product data.

## Create / edit bundle screen

Earlier it was a single long form. We changed it into a clean 3-step process — first the details (name, description, discount), then choosing the products, then the categories. On the side there is now a live preview that shows the price, the savings, and how many bundles can be built, updated as the merchant types.

## Currency

Earlier prices were shown only in US dollars. Now the app reads the store's own currency and shows prices correctly (for example ₹, $, €), so it matches whatever currency the store uses.

## Speed and database

Earlier the app called BigCommerce every single time it needed product or bundle information, which was slow. We added our own database (MySQL) that keeps a fast local copy of the products and bundles. Now the storefront and admin pages load quickly because they read from our database instead of waiting on BigCommerce each time. The database also keeps the store login safely, so the automatic stock updates keep working even after the server restarts.

---

## Summary in one line

We turned a basic "create a bundle product" tool into a complete bundle system — automatic pricing and stock, a proper bundle experience on the product page, cart and order pages, full order handling (packing notes, stock deduction, and refunds), a richer admin screen, correct currency, and a fast database behind everything.
