import React, { useState } from 'react';
import {
  Box,
  Button,
  Flex,
  Text,
  Alert,
} from '@bigcommerce/big-design';
// ArrowBackIcon — use a plain text arrow to avoid icon package version mismatch
import { useNavigate } from 'react-router-dom';
import BundleForm from '../components/BundleForm';
import { createBundle } from '../api';

export default function CreateBundle() {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (formData) => {
    setSaving(true);
    setError(null);
    try {
      await createBundle(formData);
      navigate('/');
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Box padding="large">
      <Button
        variant="subtle"
        onClick={() => navigate('/')}
        marginBottom="medium"
      >
        ← Back to Bundles
      </Button>

      {error && (
        <Box style={{ maxWidth: 1180, margin: '0 auto' }}>
          <Alert
            type="error"
            header="Failed to create bundle"
            messages={[{ text: error }]}
            marginBottom="medium"
            onClose={() => setError(null)}
          />
        </Box>
      )}

      <BundleForm
        onSubmit={handleSubmit}
        onCancel={() => navigate('/')}
        saving={saving}
        submitLabel="Save Bundle"
        title="Create Product Bundle"
        subtitle="Combine multiple products into a bundle and offer customers a discounted price."
      />
    </Box>
  );
}
