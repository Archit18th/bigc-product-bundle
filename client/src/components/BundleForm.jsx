/**
 * BundleForm
 * Reusable form for creating and editing bundles.
 * Used by both CreateBundle and EditBundle pages.
 *
 * NOTE: This file is UI/layout only — all pricing, inventory and validation
 * logic is unchanged from the original implementation.
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
  Badge,
  H1,
  H2,
} from '@bigcommerce/big-design';
import ProductPicker from './ProductPicker';
import CategoryPicker from './CategoryPicker';
import { useCurrency } from '../currency';

const DEFAULT_FORM = {
  name: '',
  description: '',
  discount_percent: 0,
  category_ids: [],
  products: [],
};

/* ── Small presentational helpers (UI only) ───────────────────────────── */

// A white, rounded section card with a title + optional helper subtitle.
function Card({ title, subtitle, children, ...rest }) {
  return (
    <Box
      padding="medium"
      marginBottom="medium"
      style={{
        background: '#fff',
        border: '1px solid #e8e9eb',
        borderRadius: 12,
        boxShadow: '0 1px 2px rgba(43,46,56,0.06)',
      }}
      {...rest}
    >
      {title && (
        <H2 marginBottom={subtitle ? 'xSmall' : 'medium'} style={{ fontSize: 18 }}>
          {title}
        </H2>
      )}
      {subtitle && (
        <Text color="secondary60" marginBottom="medium">
          {subtitle}
        </Text>
      )}
      {children}
    </Box>
  );
}

function SummaryRow({ label, value, valueColor, bold }) {
  return (
    <Flex justifyContent="space-between" alignItems="center" marginBottom="xSmall">
      <Text color="secondary60" bold={bold} marginBottom="none">
        {label}
      </Text>
      <Text color={valueColor} bold={bold} marginBottom="none">
        {value}
      </Text>
    </Flex>
  );
}

// Three-step progress indicator (Details → Products → Categories). Purely a
// navigation affordance — clicking a pill only lets you jump BACK to an already
// completed/visited step; advancing forward goes through the Next buttons so
// per-step validation still runs.
const WIZARD_STEPS = [
  { n: 1, label: 'Details' },
  { n: 2, label: 'Products' },
  { n: 3, label: 'Categories' },
];

function StepNav({ step, setStep }) {
  return (
    <Flex alignItems="center" flexGap="0.5rem" marginBottom="medium" style={{ flexWrap: 'wrap' }}>
      {WIZARD_STEPS.map((s, i) => {
        const active = s.n === step;
        const done = s.n < step;
        const canClick = s.n <= step;
        return (
          <React.Fragment key={s.n}>
            <Box
              onClick={() => canClick && setStep(s.n)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 16px',
                borderRadius: 6,
                fontWeight: 600,
                cursor: canClick ? 'pointer' : 'default',
                background: active ? '#2b2e38' : done ? '#e6f0fb' : '#f0f1f3',
                color: active ? '#fff' : done ? '#1c6ee0' : '#8a8f99',
              }}
            >
              <Box
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 13,
                  color: '#fff',
                  background: active
                    ? 'rgba(255,255,255,0.25)'
                    : done
                    ? '#1c6ee0'
                    : '#c2c6cf',
                }}
              >
                {s.n}
              </Box>
              {s.label}
            </Box>
            {i < WIZARD_STEPS.length - 1 && (
              <Box style={{ width: 24, height: 2, background: '#d9dce0' }} />
            )}
          </React.Fragment>
        );
      })}
    </Flex>
  );
}

export default function BundleForm({
  initialValues,
  onSubmit,
  onCancel,
  saving = false,
  submitLabel = 'Save',
  isEdit = false,
  currentInventory = null,
  title = 'Create Product Bundle',
  subtitle = 'Combine multiple products into a bundle and offer customers a discounted price.',
}) {
  const [form, setForm] = useState(initialValues || DEFAULT_FORM);
  const [validationErrors, setValidationErrors] = useState({});
  const [dirty, setDirty] = useState(false);
  const [step, setStep] = useState(1); // wizard step: 1 Details · 2 Products · 3 Categories
  const { format } = useCurrency();

  // Sync when initialValues change (e.g. data loads async in EditBundle)
  useEffect(() => {
    if (initialValues) setForm(initialValues);
  }, [initialValues]);

  // Derived pricing: subtotal = Σ(unit price × qty), then apply the % discount.
  // Mirrors the backend calcPrice so the form preview matches what gets saved.
  const subtotal = form.products.reduce((sum, p) => {
    const qty = p.qty && p.qty > 0 ? p.qty : 1;
    return sum + (Number(p.price) || 0) * qty;
  }, 0);
  const discountPct = Math.min(100, Math.max(0, Number(form.discount_percent) || 0));
  const finalPrice = Math.round(subtotal * (1 - discountPct / 100) * 100) / 100;
  const savings = Math.round((subtotal - finalPrice) * 100) / 100;

  const validate = () => {
    const errors = {};
    if (!form.name.trim()) errors.name = 'Bundle name is required.';
    const pct = Number(form.discount_percent);
    if (form.discount_percent !== '' && (isNaN(pct) || pct < 0 || pct > 100)) {
      errors.discount_percent = 'Discount must be between 0 and 100.';
    }
    if (form.products.length < 2) {
      errors.products = 'A bundle must include at least 2 products.';
    }
    return errors;
  };

  // Per-step validation — a subset of the same rules in validate(), so advancing
  // through the wizard can't skip the checks. Logic is identical, just scoped to
  // the fields shown on that step.
  const validateStep = (s) => {
    const all = validate();
    if (s === 1) {
      const { name, discount_percent } = all;
      return { ...(name && { name }), ...(discount_percent && { discount_percent }) };
    }
    if (s === 2) {
      return all.products ? { products: all.products } : {};
    }
    return {};
  };

  const goToStep = (s) => {
    setValidationErrors({});
    setStep(s);
  };

  const goNext = () => {
    const errors = validateStep(step);
    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors);
      return;
    }
    setValidationErrors({});
    setStep((s) => Math.min(3, s + 1));
  };

  const goBack = () => {
    setValidationErrors({});
    setStep((s) => Math.max(1, s - 1));
  };

  const handleChange = (field, value) => {
    // `value` may be a plain value OR a functional updater (prevFieldValue) =>
    // newFieldValue. The functional form lets children like ProductPicker append
    // to the LATEST array instead of a stale prop snapshot, which previously
    // caused added products to overwrite each other when added in quick
    // succession from the still-open search dropdown.
    setForm((prev) => ({
      ...prev,
      [field]: typeof value === 'function' ? value(prev[field]) : value,
    }));
    setDirty(true);
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
    // On steps 1–2 (e.g. Enter key in a field) advance instead of submitting;
    // only the final step actually saves.
    if (step < WIZARD_STEPS.length) {
      goNext();
      return;
    }
    const errors = validate();
    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors);
      return;
    }

    onSubmit({
      name: form.name.trim(),
      description: form.description.trim(),
      discount_percent: Number(form.discount_percent) || 0,
      category_ids: form.category_ids,
      products: form.products.map((p) => ({
        product_id: p.product_id,
        qty: p.qty,
      })),
    });
  };

  // Show how many complete bundles can be built (qty-aware), mirroring the
  // backend calcAvailability: floor((stock - 1) / qty) per component, then the
  // min. The -1 reserves stock while always leaving 1 unit of each component.
  const buildableFor = (p) => {
    if (p.stock == null) return Infinity; // untracked / unknown — doesn't constrain
    const qty = p.qty && p.qty > 0 ? p.qty : 1;
    // Add back the stock this bundle already reserves (p.reserved, set on edit)
    // so the preview shows true capacity instead of leftover-only stock.
    const trueStock = p.stock + (p.reserved || 0);
    return Math.max(0, Math.floor((trueStock - 1) / qty));
  };
  const minStock =
    form.products.length > 0
      ? Math.min(...form.products.map(buildableFor))
      : null;
  // "Out of stock" here means a selected product can't supply even one bundle.
  const outOfStockProducts = form.products.filter(
    (p) => p.stock != null && buildableFor(p) === 0
  );
  const hasOutOfStock = outOfStockProducts.length > 0;
  // The product that caps the bundle count (the smallest buildable), so the
  // summary block can name it — the merchant doesn't have to find it themselves.
  const limitingProduct =
    minStock !== null && minStock !== Infinity
      ? form.products.find((p) => buildableFor(p) === minStock)
      : null;

  // Friendly label for the "available bundle stock" figure shown in a few places.
  const bundleStockText =
    minStock === null
      ? '—'
      : minStock === Infinity
      ? 'Unlimited'
      : `${minStock} bundle${minStock === 1 ? '' : 's'}`;

  return (
    <Box
      as="form"
      onSubmit={handleSubmit}
      noValidate
      style={{ maxWidth: 1200, width: '100%', margin: '0 auto' }}
    >
      {/* ── Page header ── */}
      <Box marginBottom="medium">
        <H1 marginBottom="xSmall" style={{ fontSize: 26 }}>
          {title}
        </H1>
        <Text color="secondary60" marginBottom="none">
          {subtitle}
        </Text>
      </Box>

      {/* ── Wizard progress indicator (Details → Products → Categories) ── */}
      <StepNav step={step} setStep={goToStep} />

      {/* ── Two-column layout: ~70% form / ~30% preview ──
          A plain flex row with align-items:flex-start so neither column is
          stretched to the other's height (which would add empty scrollable
          space). flexWrap lets the preview drop below the form on narrow
          widths. */}
      <Box
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        {/* ───────────────────── LEFT COLUMN ───────────────────── */}
        <Box style={{ flex: '1 1 480px', minWidth: 0 }}>
          {/* ───────── STEP 1 — Details ───────── */}
          {step === 1 && (
          /* Section 1 — Bundle Information */
          <Card title="Bundle Information">
            <FormGroup>
              <Input
                label="Bundle Name"
                description="This name will appear to customers."
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
                description="Describe what customers receive in this bundle."
                placeholder="This bundle includes…"
                value={form.description}
                onChange={(e) => handleChange('description', e.target.value)}
                rows={3}
              />
            </FormGroup>

            <FormGroup>
              <Input
                label="Discount Percentage"
                description="Customers save this percentage compared to purchasing products individually."
                placeholder="e.g. 10"
                type="number"
                min="0"
                max="100"
                step="0.25"
                iconRight={<Text color="secondary60" marginBottom="none">%</Text>}
                value={form.discount_percent}
                onChange={(e) => handleChange('discount_percent', e.target.value)}
                error={validationErrors.discount_percent}
              />
            </FormGroup>
          </Card>
          )}

          {/* ───────── STEP 2 — Products (search, pricing, inventory) ───────── */}
          {step === 2 && (
          <>
          {/* Section 2 — Add Products */}
          <Card
            title="Add Products"
            subtitle="Search and add the products that make up this bundle, then set how many of each a customer receives."
          >
            <ProductPicker
              value={form.products}
              onChange={(products) => handleChange('products', products)}
              showTotalStock={isEdit}
              limitingProductId={limitingProduct?.product_id}
              limitingOutOfStock={minStock === 0}
              bundleCount={minStock}
            />
            {validationErrors.products && (
              <Text color="danger" marginTop="small" marginBottom="none">
                {validationErrors.products}
              </Text>
            )}
          </Card>

          {/* Section 3 — Pricing Summary */}
          <Card title="Pricing Summary">
            <Box
              padding="medium"
              style={{ background: '#f6f7f9', borderRadius: 8 }}
            >
              <SummaryRow label="Products Total" value={format(subtotal)} />
              <SummaryRow
                label="Discount Percentage"
                value={`${discountPct}%`}
              />
              <SummaryRow label="Bundle Price" value={format(finalPrice)} bold />

              <Box
                marginTop="small"
                paddingTop="small"
                style={{ borderTop: '1px dashed #d9dce0' }}
              >
                <Flex
                  justifyContent="space-between"
                  alignItems="center"
                  padding="small"
                  style={{ background: '#e7f6ee', borderRadius: 8 }}
                >
                  <Text bold color="success" marginBottom="none">
                    Customer Saves
                  </Text>
                  <Text bold color="success" marginBottom="none" style={{ fontSize: 18 }}>
                    {format(savings)}
                  </Text>
                </Flex>
              </Box>
            </Box>
          </Card>

          {/* Section 4 — Bundle Inventory */}
          <Card title="Bundle Inventory">
            {minStock !== null && hasOutOfStock ? (
              // Warning style ONLY when inventory reaches zero.
              <Box
                padding="medium"
                style={{
                  background: '#fdecea',
                  border: '1px solid #d14343',
                  borderRadius: 8,
                }}
              >
                <Text bold color="danger" marginBottom="xSmall">
                  This bundle can’t be created — these products don’t have enough
                  stock for even 1 bundle:
                </Text>
                {outOfStockProducts.map((p) => (
                  <Text key={p.product_id} bold color="danger" marginBottom="none">
                    • {p.name}
                  </Text>
                ))}
              </Box>
            ) : (
              <Box
                padding="medium"
                style={{
                  background: '#f0f7ff',
                  border: '1px solid #cfe4fb',
                  borderRadius: 8,
                }}
              >
                {isEdit && currentInventory != null && minStock !== Infinity && minStock !== null && currentInventory !== minStock ? (
                  <>
                    <Text color="secondary60" marginBottom="none">
                      Available Bundle Stock
                    </Text>
                    <Text bold marginBottom="xSmall" style={{ fontSize: 22 }}>
                      {currentInventory} → {minStock} bundles
                    </Text>
                    <Text
                      color={minStock > currentInventory ? 'success' : 'danger'}
                      marginBottom="none"
                    >
                      Your changes will{' '}
                      {minStock > currentInventory ? 'increase' : 'decrease'} this
                      bundle from {currentInventory} to {minStock} units.
                    </Text>
                  </>
                ) : (
                  <>
                    <Text color="secondary60" marginBottom="none">
                      Available Bundle Stock
                    </Text>
                    <Text bold marginBottom="xSmall" style={{ fontSize: 22 }}>
                      {bundleStockText}
                    </Text>
                  </>
                )}

                {limitingProduct && (
                  <Text color="secondary60" marginBottom="none" marginTop="xSmall">
                    Limited by{' '}
                    <Text as="span" bold>
                      {limitingProduct.name}
                    </Text>
                  </Text>
                )}

                <Text as="small" color="secondary60" marginTop="small" marginBottom="none">
                  Bundle inventory is automatically calculated based on the product
                  with the lowest available stock. At least 1 unit of each product
                  always stays in your catalog
                  {limitingProduct?.sku ? ` (e.g. ${limitingProduct.sku})` : ''}.
                </Text>
              </Box>
            )}
          </Card>
          </>
          )}

          {/* ───────── STEP 3 — Categories ───────── */}
          {step === 3 && (
          /* Section 5 — Categories */
          <Card
            title="Bundle Categories (Optional)"
            subtitle="Select categories where this bundle should appear."
          >
            <CategoryPicker
              value={form.category_ids}
              onChange={(ids) => handleChange('category_ids', ids)}
            />
            {form.category_ids.length > 0 && (
              <Text marginTop="small" marginBottom="none" color="secondary60">
                {form.category_ids.length} categor
                {form.category_ids.length === 1 ? 'y' : 'ies'} selected
              </Text>
            )}
          </Card>
          )}
        </Box>

        {/* ───────────────────── RIGHT COLUMN (preview) ─────────────────────
            Sticky preview: it follows the scroll so the merchant always sees the
            running price/availability while editing the (taller) left column.
            Two things make this work safely:
              1. alignSelf:'stretch' makes this flex item match the row height
                 (the left column), giving the inner box room to travel — without
                 it the item is only as tall as the card and can't stick.
              2. The iframe height is computed with 'bodyOffset' (see index.html),
                 which reads document.body.offsetHeight. A sticky element only
                 shifts visually within its normal flow, so it does NOT grow the
                 reported height — no blank scroll area below the content. */}
        <Box style={{ flex: '0 1 320px', minWidth: 0, alignSelf: 'stretch' }}>
          <Box style={{ position: 'sticky', top: '1rem' }}>
            <Box
              style={{
                background: '#fff',
                border: '1px solid #e8e9eb',
                borderRadius: 12,
                boxShadow: '0 1px 2px rgba(43,46,56,0.06)',
                overflow: 'hidden',
              }}
            >
              {/* Preview header */}
              <Flex
                justifyContent="space-between"
                alignItems="center"
                padding="medium"
                style={{ borderBottom: '1px solid #f0f1f3' }}
              >
                <Text bold marginBottom="none">
                  Bundle Preview
                </Text>
                <Badge label="Preview" variant="secondary" />
              </Flex>

              <Box padding="medium">
                {/* Bundle name */}
                <Text bold marginBottom="medium" style={{ fontSize: 18 }}>
                  {form.name.trim() || 'Untitled bundle'}
                </Text>

                {/* Included products */}
                <Text bold color="secondary60" marginBottom="xSmall" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  Included Products
                </Text>
                {form.products.length === 0 ? (
                  <Text color="secondary60" marginBottom="medium">
                    No products added yet.
                  </Text>
                ) : (
                  <Box marginBottom="medium">
                    {form.products.map((p) => (
                      <Flex
                        key={p.product_id}
                        justifyContent="space-between"
                        marginBottom="xSmall"
                      >
                        <Text marginBottom="none">{p.name}</Text>
                        <Text color="secondary60" marginBottom="none">
                          × {p.qty || 1}
                        </Text>
                      </Flex>
                    ))}
                  </Box>
                )}

                {/* Pricing */}
                <Box
                  padding="small"
                  marginBottom="medium"
                  style={{ background: '#f6f7f9', borderRadius: 8 }}
                >
                  <SummaryRow label="Regular Price" value={format(subtotal)} />
                  <SummaryRow label="Bundle Price" value={format(finalPrice)} bold />
                  <Flex justifyContent="space-between" alignItems="center">
                    <Text color="success" bold marginBottom="none">
                      Customer Saves
                    </Text>
                    <Text color="success" bold marginBottom="none">
                      {format(savings)}
                    </Text>
                  </Flex>
                </Box>

                {/* Availability */}
                <Text bold color="secondary60" marginBottom="xSmall" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  Availability
                </Text>
                <Badge
                  label={
                    minStock === null
                      ? 'No products yet'
                      : minStock === Infinity
                      ? 'Unlimited bundles available'
                      : hasOutOfStock
                      ? 'Out of stock'
                      : `${minStock} bundle${minStock === 1 ? '' : 's'} available`
                  }
                  variant={hasOutOfStock ? 'danger' : 'success'}
                />
              </Box>
            </Box>
          </Box>
        </Box>
      </Box>

      {/* ── Action bar ── a normal block at the very end of the content, so the
          document height equals the content height and the page stops scrolling
          exactly where the content ends (same behaviour as the Bundle list). */}
      <Box
        marginTop="medium"
        style={{
          background: '#fff',
          border: '1px solid #e8e9eb',
          borderRadius: 12,
          boxShadow: '0 -2px 8px rgba(43,46,56,0.06)',
        }}
      >
        <Flex
          justifyContent="space-between"
          alignItems="center"
          flexGap="1rem"
          padding="medium"
        >
          {/* Left side: Back button (from step 2 onward) */}
          <Flex flexGap="0.75rem" alignItems="center">
            {step > 1 && (
              <Button type="button" variant="subtle" onClick={goBack} disabled={saving}>
                ← Back
              </Button>
            )}
            <Text color="secondary60" marginBottom="none">
              Step {step} of {WIZARD_STEPS.length}
            </Text>
          </Flex>

          {/* Right side: Continue on steps 1–2, Submit on the final step */}
          <Flex flexGap="0.75rem" alignItems="center">
            <Text color="secondary60" marginBottom="none">
              {dirty ? 'Unsaved changes' : 'All changes saved'}
            </Text>
            {step < WIZARD_STEPS.length ? (
              // Distinct `key` from the submit button below: forces React to
              // mount a SEPARATE DOM node per step instead of reusing one button
              // and flipping it to type="submit" — which let the click that
              // advanced to step 3 carry over and auto-submit the form.
              <Button key="wizard-next" type="button" onClick={goNext}>
                {step === 1 ? 'Continue to Products →' : 'Continue to Categories →'}
              </Button>
            ) : (
              <Button key="wizard-submit" type="submit" isLoading={saving} disabled={saving}>
                {saving ? 'Saving…' : submitLabel}
              </Button>
            )}
          </Flex>
        </Flex>
      </Box>
    </Box>
  );
}
