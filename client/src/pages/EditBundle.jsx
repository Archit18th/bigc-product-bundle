import React, { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Flex,
  Text,
  Alert,
  ProgressCircle,
  Badge,
} from '@bigcommerce/big-design';
import { useNavigate, useParams } from 'react-router-dom';
import BundleForm from '../components/BundleForm';
import { getBundle, updateBundle } from '../api';

export default function EditBundle() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [bundle, setBundle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        const data = await getBundle(id);
        setBundle(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  const handleSubmit = async (formData) => {
    setSaving(true);
    setError(null);
    try {
      await updateBundle(id, formData);
      navigate('/');
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  const initialValues = bundle
    ? {
        name: bundle.name,
        description: bundle.description || '',
        price: bundle.price,
        // BUG-02: BC v3 returns categories as an array of integers, not objects.
        // The backend also strips the hidden system category before sending,
        // so this array is already clean and can be used directly.
        category_ids: bundle.categories || [],
        products: (bundle.bundle_config?.products || []).map((p) => ({
          product_id: p.product_id,
          qty: p.qty,
          name: p.name,
          sku: p.sku,
          thumbnail: p.thumbnail,
          // Live stock/availability enriched by the backend getBundle response,
          // so the picker shows current status instead of '—'.
          stock: p.stock,
          availability: p.availability,
        })),
      }
    : null;

  return (
    <Box padding="large">
      <Button
        variant="subtle"
        onClick={() => navigate('/')}
        marginBottom="medium"
      >
        ← Back to Bundles
      </Button>

      <Flex alignItems="center" flexGap="1rem" marginBottom="large">
        <Text bold style={{ fontSize: 24 }}>Edit Bundle</Text>
        {bundle && (
          <Badge
            label={bundle.availability === 'available' ? 'Available' : 'Unavailable'}
            variant={bundle.availability === 'available' ? 'success' : 'danger'}
          />
        )}
      </Flex>

      {bundle?.availability === 'disabled' && (
        <Alert
          type="warning"
          header="Bundle is currently unavailable"
          messages={[
            {
              text: 'One or more products in this bundle are out of stock. The bundle will automatically become available when all products are back in stock.',
            },
          ]}
          marginBottom="medium"
        />
      )}

      {error && (
        <Alert
          type="error"
          header="Error"
          messages={[{ text: error }]}
          marginBottom="medium"
          onClose={() => setError(null)}
        />
      )}

      {loading ? (
        <Flex justifyContent="center" padding="xxLarge">
          <ProgressCircle size="large" />
        </Flex>
      ) : (
        <BundleForm
          initialValues={initialValues}
          onSubmit={handleSubmit}
          saving={saving}
          submitLabel="Save Changes"
        />
      )}
    </Box>
  );
}
