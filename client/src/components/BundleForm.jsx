/**
 * BundleForm
 * Reusable form for creating and editing bundles.
 * Used by both CreateBundle and EditBundle pages.
 */
import React, { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Flex,
  FormGroup,
  Input,
  Textarea,
  Text,
  Message,
  Alert,
} from '@bigcommerce/big-design';
// Icon imports removed — using text labels to avoid version mismatches
import ProductPicker from './ProductPicker';
import CategoryPicker from './CategoryPicker';

const DEFAULT_FORM = {
  name: '',
  description: '',
  price: '',
  category_ids: [],
  products: [],
};

export default function BundleForm({
  initialValues,
  onSubmit,
  saving = false,
  submitLabel = 'Save',
}) {
  const [form, setForm] = useState(initialValues || DEFAULT_FORM);
  const [validationErrors, setValidationErrors] = useState({});

  // Sync when initialValues change (e.g. data loads async in EditBundle)
  useEffect(() => {
    if (initialValues) setForm(initialValues);
  }, [initialValues]);

  // Derived: suggested price from selected products
  const suggestedPrice = form.products.reduce((sum, p) => {
    // Products from picker may have a price field; fall back to 0
    return sum + (Number(p.price) || 0);
  }, 0);

  const validate = () => {
    const errors = {};
    if (!form.name.trim()) errors.name = 'Bundle name is required.';
    if (!form.price || isNaN(Number(form.price)) || Number(form.price) <= 0) {
      errors.price = 'Enter a valid price greater than 0.';
    }
    if (form.products.length < 2) {
      errors.products = 'A bundle must include at least 2 products.';
    }
    return errors;
  };

  const handleChange = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (validationErrors[field]) {
      setValidationErrors((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const errors = validate();
    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors);
      return;
    }

    onSubmit({
      name: form.name.trim(),
      description: form.description.trim(),
      price: Number(form.price),
      category_ids: form.category_ids,
      products: form.products.map((p) => ({
        product_id: p.product_id,
        qty: p.qty,
      })),
    });
  };

  // Show how many complete bundles can be built (qty-aware), mirroring the
  // backend calcAvailability: floor(stock / qty) per component, then the min.
  const buildableFor = (p) => {
    if (p.stock == null) return Infinity; // untracked / unknown — doesn't constrain
    const qty = p.qty && p.qty > 0 ? p.qty : 1;
    return Math.floor(p.stock / qty);
  };
  const minStock =
    form.products.length > 0
      ? Math.min(...form.products.map(buildableFor))
      : null;
  // "Out of stock" here means a selected product can't supply even one bundle.
  const hasOutOfStock = form.products.some(
    (p) => p.stock != null && buildableFor(p) === 0
  );

  return (
    <Box
      as="form"
      onSubmit={handleSubmit}
      style={{ maxWidth: 780 }}
    >
      {/* ── Bundle Details ── */}
      <Box
        padding="large"
        marginBottom="large"
        style={{
          background: '#fff',
          border: '1px solid #e8e9eb',
          borderRadius: 8,
        }}
      >
        <Text bold marginBottom="medium" style={{ fontSize: 16 }}>Bundle Details</Text>

        <FormGroup>
          <Input
            label="Bundle Name"
            placeholder="e.g. Starter Kit, Photography Bundle"
            value={form.name}
            onChange={(e) => handleChange('name', e.target.value)}
            error={validationErrors.name}
            required
          />
        </FormGroup>

        <FormGroup>
          <Textarea
            label="Description"
            description="Optional. Describe what's included in this bundle."
            placeholder="This bundle includes…"
            value={form.description}
            onChange={(e) => handleChange('description', e.target.value)}
            rows={3}
          />
        </FormGroup>

        <FormGroup>
          <Input
            label="Bundle Price (USD)"
            description={
              suggestedPrice > 0
                ? `Individual total: $${suggestedPrice.toFixed(2)} — bundle saves $${(suggestedPrice - Number(form.price || 0)).toFixed(2)}`
                : 'Set the price customers pay for the whole bundle.'
            }
            placeholder="e.g. 49.99"
            type="number"
            min="0.01"
            step="0.01"
            value={form.price}
            onChange={(e) => handleChange('price', e.target.value)}
            error={validationErrors.price}
            required
          />
        </FormGroup>
      </Box>

      {/* ── Products ── */}
      <Box
        padding="large"
        marginBottom="large"
        style={{
          background: '#fff',
          border: '1px solid #e8e9eb',
          borderRadius: 8,
        }}
      >
        <Text bold marginBottom="xSmall" style={{ fontSize: 16 }}>Bundle Products</Text>
        <Text color="secondary60" marginBottom="medium">
          Search and add products to include in this bundle. Set the quantity of
          each item included. Bundle stock will be set to the number of complete
          bundles you can build from current component stock and quantities.
        </Text>

        {hasOutOfStock && (
          <Alert
            type="warning"
            header="Out of stock items detected"
            messages={[
              {
                text: 'One or more selected products are currently out of stock. This bundle will be set to unavailable until all products have stock.',
              },
            ]}
            marginBottom="medium"
          />
        )}

        {minStock !== null && minStock !== Infinity && !hasOutOfStock && (
          <Message
            type="info"
            messages={[
              {
                text: `Bundle inventory will be set to ${minStock} (the number of complete bundles you can build from current component stock and quantities).`,
              },
            ]}
            marginBottom="medium"
          />
        )}

        <ProductPicker
          value={form.products}
          onChange={(products) => handleChange('products', products)}
        />

        {validationErrors.products && (
          <Text color="danger" marginTop="xSmall">
            {validationErrors.products}
          </Text>
        )}
      </Box>

      {/* ── Categories ── */}
      <Box
        padding="large"
        marginBottom="large"
        style={{
          background: '#fff',
          border: '1px solid #e8e9eb',
          borderRadius: 8,
        }}
      >
        <Text bold marginBottom="xSmall" style={{ fontSize: 16 }}>Categories</Text>
        <Text color="secondary60" marginBottom="medium">
          Choose which categories this bundle should appear in.
        </Text>
        <CategoryPicker
          value={form.category_ids}
          onChange={(ids) => handleChange('category_ids', ids)}
        />
        {form.category_ids.length > 0 && (
          <Text marginTop="xSmall" color="secondary60">
            {form.category_ids.length} categor
            {form.category_ids.length === 1 ? 'y' : 'ies'} selected
          </Text>
        )}
      </Box>

      {/* ── Submit ── */}
      <Flex justifyContent="flex-end" flexGap="0.75rem">
        <Button
          type="submit"
          
          isLoading={saving}
          disabled={saving}
        >
          {saving ? 'Saving…' : submitLabel}
        </Button>
      </Flex>
    </Box>
  );
}
