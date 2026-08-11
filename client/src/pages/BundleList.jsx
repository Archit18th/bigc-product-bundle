import React, { useEffect, useState, useCallback } from 'react';
import {
  Box,
  Button,
  Flex,
  Text,
  Table,
  TableFigure,
  Badge,
  ProgressCircle,
  Modal,
  Alert,
} from '@bigcommerce/big-design';
import { AddIcon, EditIcon, DeleteIcon } from '@bigcommerce/big-design-icons';
import { useNavigate } from 'react-router-dom';
import { listBundles, deleteBundle } from '../api';

export default function BundleList() {
  const navigate = useNavigate();
  const [bundles, setBundles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deleteModal, setDeleteModal] = useState(null); // { id, name }
  const [deleting, setDeleting] = useState(false);

  const fetchBundles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listBundles();
      setBundles(data.bundles || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBundles();
  }, [fetchBundles]);

  const handleDelete = async () => {
    if (!deleteModal) return;
    setDeleting(true);
    try {
      await deleteBundle(deleteModal.id);
      setDeleteModal(null);
      await fetchBundles();
    } catch (err) {
      setError(`Failed to delete: ${err.message}`);
    } finally {
      setDeleting(false);
    }
  };

  const columns = [
    {
      header: 'Bundle',
      hash: 'name',
      render: (row) => (
        <Flex alignItems="center" flexGap="0.75rem">
          {row.primary_image?.url_thumbnail ? (
            <img
              src={row.primary_image.url_thumbnail}
              alt={row.name}
              style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 4 }}
            />
          ) : (
            <Box
              style={{
                width: 40,
                height: 40,
                background: '#e8e9eb',
                borderRadius: 4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 18,
              }}
            >
              📦
            </Box>
          )}
          <Box>
            <Text bold>{row.name}</Text>
            <Text as="small" color="secondary60">
              ID: {row.id}
            </Text>
          </Box>
        </Flex>
      ),
    },
    {
      header: 'Price',
      hash: 'price',
      render: (row) => `$${Number(row.price).toFixed(2)}`,
    },
    {
      header: 'Products',
      hash: 'products',
      // BUG-19: when count is undefined, `undefined || '—'` gives '—' which is
      // not === 1, so "— items" was rendered. Use null-check instead.
      render: (row) => {
        const count = row.bundle_config?.products?.length;
        return (
          <Text>
            {count != null ? `${count} item${count !== 1 ? 's' : ''}` : '—'}
          </Text>
        );
      },
    },
    {
      header: 'Stock',
      hash: 'inventory_level',
      render: (row) => row.inventory_level ?? '—',
    },
    {
      header: 'Status',
      hash: 'availability',
      render: (row) =>
        row.availability === 'available' ? (
          <Badge label="Available" variant="success" />
        ) : (
          <Badge label="Unavailable" variant="danger" />
        ),
    },
    {
      header: 'Actions',
      hash: 'actions',
      render: (row) => (
        <Flex flexGap="0.5rem">
          <Button
            variant="subtle"
            iconOnly={<EditIcon />}
            onClick={() => navigate(`/bundles/${row.id}/edit`)}
            aria-label="Edit bundle"
          />
          <Button
            variant="subtle"
            iconOnly={<DeleteIcon />}
            onClick={() => setDeleteModal({ id: row.id, name: row.name })}
            aria-label="Delete bundle"
          />
        </Flex>
      ),
    },
  ];

  return (
    <Box padding="large">
      {/* Header */}
      <Flex justifyContent="space-between" alignItems="center" marginBottom="large">
        <Box>
          <Text bold style={{ fontSize: 24 }}>Bundle Manager</Text>
          <Text color="secondary60">
            Create and manage product bundles. Bundles are automatically disabled
            when any component goes out of stock.
          </Text>
        </Box>
        <Button
          iconLeft={<AddIcon />}
          onClick={() => navigate('/bundles/new')}
        >
          Create Bundle
        </Button>
      </Flex>

      {/* Error */}
      {error && (
        <Alert
          type="error"
          header="Error"
          messages={[{ text: error }]}
          marginBottom="medium"
          onClose={() => setError(null)}
        />
      )}

      {/* Loading */}
      {loading ? (
        <Flex justifyContent="center" padding="xxLarge">
          <ProgressCircle size="large" />
        </Flex>
      ) : bundles.length === 0 ? (
        <Box
          padding="xxLarge"
          style={{
            textAlign: 'center',
            background: '#fff',
            borderRadius: 8,
            border: '1px solid #e8e9eb',
          }}
        >
          <Text style={{ fontSize: 48, marginBottom: 16 }}>📦</Text>
          <Text bold style={{ fontSize: 18 }}>No bundles yet</Text>
          <Text color="secondary60" marginBottom="medium">
            Create your first bundle to offer discounted product groups to customers.
          </Text>
          <Button iconLeft={<AddIcon />} onClick={() => navigate('/bundles/new')}>
            Create your first bundle
          </Button>
        </Box>
      ) : (
        <TableFigure>
          <Table
            columns={columns}
            items={bundles}
            keyField="id"
          />
        </TableFigure>
      )}

      {/* Delete confirmation modal */}
      <Modal
        isOpen={!!deleteModal}
        onClose={() => setDeleteModal(null)}
        header="Delete Bundle"
        actions={[
          {
            text: 'Cancel',
            variant: 'subtle',
            onClick: () => setDeleteModal(null),
          },
          {
            text: deleting ? 'Deleting…' : 'Delete',
            variant: 'primary',
            actionType: 'destructive',
            onClick: handleDelete,
            disabled: deleting,
          },
        ]}
      >
        <Text>
          Are you sure you want to delete <strong>{deleteModal?.name}</strong>?
          This will remove the bundle product and unlink it from all component
          products. This action cannot be undone.
        </Text>
      </Modal>
    </Box>
  );
}
