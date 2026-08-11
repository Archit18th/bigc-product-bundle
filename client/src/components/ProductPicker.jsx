/**
 * ProductPicker
 * Search-and-select UI for choosing products to include in a bundle.
 * Displays selected products with quantity spinners.
 */
import React, { useState, useCallback, useRef } from 'react';
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
import { searchProducts } from '../api';

export default function ProductPicker({ value = [], onChange }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const debounceRef = useRef(null);

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
        // Filter out already-selected products
        const selectedIds = value.map((p) => p.product_id);
        setResults(products.filter((p) => !selectedIds.includes(p.id)));
      } catch (err) {
        setSearchError(err.message);
      } finally {
        setSearching(false);
      }
    }, 350);
  }, [value]);

  const addProduct = (product) => {
    onChange([
      ...value,
      {
        product_id: product.id,
        name: product.name,
        sku: product.sku,
        thumbnail: product.thumbnail,
        qty: 1,
        stock: product.inventory_level,
        availability: product.availability, // needed so the selected table shows disabled state
      },
    ]);
    setResults((prev) => prev.filter((p) => p.id !== product.id));
    setQuery('');
  };

  const removeProduct = (productId) => {
    onChange(value.filter((p) => p.product_id !== productId));
  };

  const updateQty = (productId, qty) => {
    onChange(
      value.map((p) =>
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
            <Text bold>{row.name}</Text>
            {row.sku && (
              <Text as="small" color="secondary60">
                SKU: {row.sku}
              </Text>
            )}
          </Box>
        </Flex>
      ),
    },
    {
      header: 'Status',
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
      header: 'Qty in Bundle',
      hash: 'qty',
      // BUG-09: stock=0 is falsy so `stock || 999` gave max=999 for out-of-stock.
      // Use a null-check so an out-of-stock product correctly caps qty at 1.
      render: (row) => (
        <Counter
          value={row.qty}
          min={1}
          max={row.stock != null ? Math.max(1, row.stock) : 999}
          onCountChange={(val) => updateQty(row.product_id, val)}
          style={{ width: 120 }}
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

  return (
    <Box>
      {/* Search box */}
      <Box marginBottom="medium" style={{ position: 'relative' }}>
        <Input
          placeholder="Search products by name or SKU…"
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          iconLeft={<SearchIcon />}
        />

        {/* Search results dropdown */}
        {(results.length > 0 || searching) && (
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
            {searching ? (
              <Flex justifyContent="center" padding="medium">
                <ProgressCircle size="small" />
              </Flex>
            ) : (
              results.map((product) => (
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
                          SKU: {product.sku} · ${Number(product.price).toFixed(2)}
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
