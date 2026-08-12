/**
 * ProductPicker
 * Search-and-select UI for choosing products to include in a bundle.
 * Displays selected products with quantity spinners.
 */
import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  Box,
  Button,
  Flex,
  Input,
  Text,
  Table,
  TableFigure,
  Badge,
  ProgressCircle,
  Counter,
} from '@bigcommerce/big-design';
import { AddIcon, DeleteIcon, SearchIcon } from '@bigcommerce/big-design-icons';
import { searchProducts, getRecommendedProducts } from '../api';
import { useCurrency } from '../currency';

export default function ProductPicker({
  value = [],
  onChange,
  showTotalStock = false,
  limitingProductId = null,
  limitingOutOfStock = false,
  bundleCount = 0,
}) {
  const { format } = useCurrency();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  // Recommendations: recently-synced products shown when the empty search box is
  // focused, before the merchant types. Fetched lazily once, then reused.
  const [recommended, setRecommended] = useState([]);
  const [recsLoading, setRecsLoading] = useState(false);
  const [focused, setFocused] = useState(false);
  const recsLoadedRef = useRef(false);
  const debounceRef = useRef(null);
  const searchRef = useRef(null);

  // Close the results dropdown when the user clicks anywhere outside the search
  // area. This lets them add multiple products in a row (the list stays open on
  // select) and only dismisses when they click elsewhere on the page.
  useEffect(() => {
    function handleClickOutside(e) {
      if (searchRef.current && !searchRef.current.contains(e.target)) {
        // Functional updates that return the SAME reference when there's nothing
        // to close — this avoids a needless re-render on every page click, which
        // would otherwise re-create row buttons mid-click and swallow their
        // onClick (e.g. the remove-product trash button).
        setResults((prev) => (prev.length ? [] : prev));
        setQuery((prev) => (prev ? '' : prev));
        setFocused((prev) => (prev ? false : prev)); // hide the recommendations dropdown
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // On first focus of the empty search box, lazily load the recommended
  // (recently-synced) products. Best-effort: failures leave the dropdown empty
  // and the merchant can still search normally.
  const handleFocus = useCallback(() => {
    setFocused(true);
    if (recsLoadedRef.current) return;
    recsLoadedRef.current = true;
    setRecsLoading(true);
    getRecommendedProducts(8)
      .then((products) => setRecommended(products || []))
      .catch(() => {
        recsLoadedRef.current = false; // allow a retry on the next focus
      })
      .finally(() => setRecsLoading(false));
  }, []);

  // Debounced search
  const handleSearch = useCallback((q) => {
    setQuery(q);
    clearTimeout(debounceRef.current);
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      try {
        const products = await searchProducts(q.trim());
        // Filter out already-selected products and any that are out of stock.
        // Untracked products (inventory_tracking === 'none') have unlimited stock
        // and always qualify; tracked products must have at least 1 unit.
        const selectedIds = value.map((p) => p.product_id);
        const hasStock = (p) =>
          p.inventory_tracking === 'none' || (p.inventory_level ?? 0) > 0;
        setResults(
          products.filter((p) => !selectedIds.includes(p.id) && hasStock(p))
        );
      } catch (err) {
        setSearchError(err.message);
      } finally {
        setSearching(false);
      }
    }, 350);
  }, [value]);

  const addProduct = (product) => {
    // Functional update so we always append to the LATEST selection, never a
    // stale `value` snapshot. Without this, adding products in quick succession
    // from the still-open dropdown could overwrite previously-added items.
    onChange((prev) => {
      // Guard against double-add (e.g. a second click before the row re-renders).
      if (prev.some((p) => p.product_id === product.id)) return prev;
      return [
        ...prev,
        {
          product_id: product.id,
          name: product.name,
          sku: product.sku,
          price: Number(product.price) || 0, // unit price — feeds the bundle subtotal
          thumbnail: product.thumbnail,
          qty: 1,
          stock: product.inventory_level,
          availability: product.availability, // needed so the selected table shows disabled state
        },
      ];
    });
    // Keep the dropdown open (minus the just-added item) so the merchant can
    // add several products in a row. It closes on click-outside (see useEffect).
    setResults((prev) => prev.filter((p) => p.id !== product.id));
  };

  const removeProduct = (productId) => {
    onChange((prev) => prev.filter((p) => p.product_id !== productId));
  };

  const updateQty = (productId, qty) => {
    onChange((prev) =>
      prev.map((p) =>
        p.product_id === productId ? { ...p, qty: Math.max(1, qty) } : p
      )
    );
  };

  const selectedColumns = [
    {
      header: 'Product',
      hash: 'product',
      render: (row) => (
        <Flex alignItems="center" flexGap="0.75rem">
          {row.thumbnail ? (
            <img
              src={row.thumbnail}
              alt={row.name}
              style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 4 }}
            />
          ) : (
            <Box
              style={{
                width: 36,
                height: 36,
                background: '#e8e9eb',
                borderRadius: 4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              🛍
            </Box>
          )}
          <Box>
            <Text bold>
              {row.product_id === limitingProductId && (
                <Text
                  as="span"
                  bold
                  color={limitingOutOfStock ? 'danger' : 'warning'}
                  title={
                    limitingOutOfStock
                      ? 'Out of stock — blocks this bundle'
                      : 'Limits the bundle'
                  }
                >
                  ⚠️{' '}
                </Text>
              )}
              {row.name}
            </Text>
            {row.sku && (
              <Text as="small" color="secondary60">
                SKU: {row.sku}
              </Text>
            )}
          </Box>
        </Flex>
      ),
    },
    // Reservation disabled: bundles no longer deduct/reserve component
    // inventory in BigCommerce, so the "Reserved" column is hidden. Kept
    // commented for reference in case reservation is re-enabled later.
    // ...(showTotalStock
    //   ? [
    //       {
    //         header: 'Reserved',
    //         hash: 'reserved',
    //         // Units THIS bundle will reserve from the product = projected bundle
    //         // count × this row's qty. Recomputes live as the merchant edits any
    //         // quantity (bundleCount is the min across all rows), so it matches
    //         // what saving actually reserves — not the stale saved value.
    //         render: (row) => {
    //           if (row.stock == null) {
    //             return <Text color="secondary60">Untracked</Text>;
    //           }
    //           const qty = row.qty && row.qty > 0 ? row.qty : 1;
    //           const reserved = Number.isFinite(bundleCount) ? bundleCount * qty : 0;
    //           return <Badge label={`${reserved} reserved`} variant="secondary" />;
    //         },
    //       },
    //     ]
    //   : []),
    {
      header: 'Available Stock',
      hash: 'stock',
      render: (row) => {
        // A disabled product will make the bundle disabled regardless of stock.
        // Show both signals so merchants understand the bundle impact.
        if (row.availability === 'disabled') {
          return (
            <Flex flexDirection="column" flexGap="0.25rem">
              <Badge label="Product disabled" variant="danger" />
              <Text as="small" color="danger">Bundle will be disabled</Text>
            </Flex>
          );
        }
        if (row.stock != null) {
          // On edit, show the stock that WILL remain in the catalog after this
          // bundle reserves bundleCount × qty — updates live as quantities change
          // (trueStock = current stock + what this bundle already reserves).
          // On create, show the plain current stock (nothing reserved yet).
          if (showTotalStock) {
            const qty = row.qty && row.qty > 0 ? row.qty : 1;
            const trueStock = row.stock + (row.reserved || 0);
            const count = Number.isFinite(bundleCount) ? bundleCount : 0;
            const remaining = Math.max(0, trueStock - count * qty);
            return (
              <Badge
                label={remaining > 0 ? `${remaining} left` : 'Out of stock'}
                variant={remaining > 0 ? 'success' : 'danger'}
              />
            );
          }
          return (
            <Badge
              label={row.stock > 0 ? `${row.stock} in stock` : 'Out of stock'}
              variant={row.stock > 0 ? 'success' : 'danger'}
            />
          );
        }
        return <Text>—</Text>;
      },
    },
    {
      header: 'Quantity per Bundle',
      hash: 'qty',
      // Qty is the number of this product required per bundle. It is NOT capped
      // at current stock — the merchant can type any quantity (e.g. 234), even
      // for products they plan to restock. The Counter's input accepts typed
      // values directly; the high max just allows large manual entries.
      render: (row) => (
        <Counter
          value={row.qty}
          min={1}
          max={1000000}
          onCountChange={(val) => updateQty(row.product_id, val)}
          style={{ width: 140 }}
        />
      ),
    },
    {
      header: '',
      hash: 'remove',
      render: (row) => (
        <Button
          variant="subtle"
          iconOnly={<DeleteIcon />}
          onClick={() => removeProduct(row.product_id)}
          aria-label={`Remove ${row.name}`}
        />
      ),
    },
  ];

  // Typing (2+ chars) shows live search results; an empty, focused box shows
  // the recommended (recently-synced) products instead.
  const typing = query.trim().length >= 2;
  const showingRecs = !typing && focused;
  // Recommendations are filtered live so already-added / out-of-stock products
  // drop out as the merchant builds the bundle (search results are pre-filtered
  // in handleSearch, so only recs need this here).
  const selectedIds = value.map((p) => p.product_id);
  const visibleRecs = recommended.filter(
    (p) =>
      !selectedIds.includes(p.id) &&
      (p.inventory_tracking === 'none' || (p.inventory_level ?? 0) > 0)
  );
  const displayItems = typing ? results : visibleRecs;
  const dropdownLoading = typing ? searching : recsLoading;
  const dropdownOpen =
    (typing && (results.length > 0 || searching)) ||
    (showingRecs && (visibleRecs.length > 0 || recsLoading));

  return (
    <Box>
      {/* Search box */}
      <Box ref={searchRef} marginBottom="medium" style={{ position: 'relative' }}>
        <Input
          placeholder="Search and add products to this bundle…"
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          onFocus={handleFocus}
          iconLeft={<SearchIcon />}
        />

        {/* Search results / recommendations dropdown */}
        {dropdownOpen && (
          <Box
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              right: 0,
              zIndex: 100,
              background: '#fff',
              border: '1px solid #e8e9eb',
              borderRadius: 4,
              boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
              maxHeight: 320,
              overflowY: 'auto',
            }}
          >
            {/* Header shown only for the recommendations list, so the merchant
                knows these aren't search matches. */}
            {showingRecs && !recsLoading && visibleRecs.length > 0 && (
              <Box
                padding="xSmall"
                style={{ borderBottom: '1px solid #f4f5f6', background: '#fafbfc' }}
              >
                <Text
                  as="small"
                  bold
                  color="secondary60"
                  marginBottom="none"
                  style={{ textTransform: 'uppercase', letterSpacing: 0.4 }}
                >
                  Recommended products
                </Text>
              </Box>
            )}
            {dropdownLoading ? (
              <Flex justifyContent="center" padding="medium">
                <ProgressCircle size="small" />
              </Flex>
            ) : (
              displayItems.map((product) => (
                <Flex
                  key={product.id}
                  alignItems="center"
                  justifyContent="space-between"
                  padding="small"
                  style={{
                    cursor: 'pointer',
                    borderBottom: '1px solid #f4f5f6',
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = '#f4f5f6')
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = 'transparent')
                  }
                >
                  <Flex alignItems="center" flexGap="0.75rem">
                    {product.thumbnail ? (
                      <img
                        src={product.thumbnail}
                        alt={product.name}
                        style={{
                          width: 32,
                          height: 32,
                          objectFit: 'cover',
                          borderRadius: 4,
                        }}
                      />
                    ) : (
                      <Box
                        style={{
                          width: 32,
                          height: 32,
                          background: '#e8e9eb',
                          borderRadius: 4,
                        }}
                      />
                    )}
                    <Box>
                      <Flex alignItems="center" flexGap="0.4rem">
                        <Text>{product.name}</Text>
                        {product.availability === 'disabled' && (
                          <Badge label="Disabled" variant="danger" />
                        )}
                      </Flex>
                      {product.sku && (
                        <Text as="small" color="secondary60">
                          SKU: {product.sku} · {format(product.price)}
                          {product.availability === 'disabled' && ' · Will disable bundle'}
                        </Text>
                      )}
                    </Box>
                  </Flex>
                  <Button
                    variant="secondary"
                    size="small"
                    iconLeft={<AddIcon />}
                    onClick={() => addProduct(product)}
                  >
                    Add
                  </Button>
                </Flex>
              ))
            )}
          </Box>
        )}

        {searchError && (
          <Text color="danger" marginTop="xSmall">
            {searchError}
          </Text>
        )}
      </Box>

      {/* Selected products table */}
      {value.length > 0 ? (
        <TableFigure>
          <Table columns={selectedColumns} items={value} keyField="product_id" />
        </TableFigure>
      ) : (
        <Box
          padding="large"
          style={{
            textAlign: 'center',
            border: '2px dashed #e8e9eb',
            borderRadius: 8,
          }}
        >
          <Text color="secondary60">
            Search and add at least 2 products to this bundle.
          </Text>
        </Box>
      )}
    </Box>
  );
}
