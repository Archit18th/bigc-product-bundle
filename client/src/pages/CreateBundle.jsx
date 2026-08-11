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

      <Text bold marginBottom="large" style={{ fontSize: 24 }}>Create Bundle</Text>

      {error && (
        <Alert
          type="error"
          header="Failed to create bundle"
          messages={[{ text: error }]}
          marginBottom="medium"
          onClose={() => setError(null)}
        />
      )}

      <BundleForm
        onSubmit={handleSubmit}
        saving={saving}
        submitLabel="Create Bundle"
      />
    </Box>
  );
}
