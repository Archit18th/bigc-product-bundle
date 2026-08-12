import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Box,
  Button,
  Flex,
  Text,
  Table,
  Badge,
  ProgressCircle,
  Modal,
  Alert,
  Search,
  Dropdown,
  H1,
  Input,
  OffsetPagination,
} from '@bigcommerce/big-design';
import {
  AddIcon,
  EditIcon,
  DeleteIcon,
  VisibilityIcon,
  RefreshIcon,
  MoreHorizIcon,
  FileCopyIcon,
  CloseIcon,
} from '@bigcommerce/big-design-icons';
import { useNavigate } from 'react-router-dom';
import {
  listBundles,
  deleteBundle,
  createBundle,
  updateBundleSku,
  reindexProducts,
  getCategories,
  getStoreInfo,
  setBundleModify,
} from '../api';
import { useCurrency } from '../currency';

// ─── Helpers ────────────────────────────────────────────────────────────────

// Price the customer pays: sale_price when discounted, else the regular price.
const bundlePriceOf = (b) =>
  b.sale_price && Number(b.sale_price) > 0 ? Number(b.sale_price) : Number(b.price) || 0;

const discountOf = (b) => Number(b.bundle_config?.discount_percent) || 0;

// 'out' | 'low' | 'ok' from stock + availability.
const stockStateOf = (b) => {
  const stock = b.inventory_level ?? 0;
  if (b.availability !== 'available' || stock === 0) return 'out';
  if (stock < 10) return 'low';
  return 'ok';
};

// Bundle thumbnail: the bundle's own image, else a collage of component images.
function BundleThumb({ row }) {
  if (row.primary_image?.url_thumbnail) {
    return (
      <img
        src={row.primary_image.url_thumbnail}
        alt={row.name}
        style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 4 }}
      />
    );
  }

  const thumbs = (row.bundle_config?.products || [])
    .map((p) => p.thumbnail)
    .filter(Boolean)
    .slice(0, 4);

  if (thumbs.length === 0) {
    return (
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
          flexShrink: 0,
        }}
      >
        📦
      </Box>
    );
  }

  return (
    <Box
      style={{
        width: 40,
        height: 40,
        borderRadius: 4,
        overflow: 'hidden',
        background: '#e8e9eb',
        flexShrink: 0,
        display: 'grid',
        gridTemplateColumns: thumbs.length === 1 ? '1fr' : '1fr 1fr',
        gridTemplateRows: thumbs.length <= 2 ? '1fr' : '1fr 1fr',
        gap: '1px',
      }}
    >
      {thumbs.map((src, i) => (
        <img
          key={i}
          src={src}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ))}
    </Box>
  );
}

// Inline SKU editor for a bundle-list row: shows the SKU with a pencil; clicking
// it swaps in an input + Save button. Saving PUTs the new SKU and, on success,
// asks the parent to update its row state. Surfaces backend errors (e.g. a
// duplicate SKU) inline beneath the input.
function EditableSku({ row, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.sku || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Keep the draft in sync if the row's SKU changes from elsewhere.
  useEffect(() => {
    if (!editing) setValue(row.sku || '');
  }, [row.sku, editing]);

  const cancel = () => {
    setEditing(false);
    setValue(row.sku || '');
    setError(null);
  };

  const save = async () => {
    const clean = value.trim();
    if (!clean) {
      setError('SKU is required.');
      return;
    }
    if (clean === (row.sku || '')) {
      cancel();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await updateBundleSku(row.id, clean);
      onSaved(row.id, res.sku);
      setEditing(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <Flex alignItems="center" flexGap="0.25rem">
        <Text marginBottom="none">{row.sku || '—'}</Text>
        {/* Pencil is hidden until the row is hovered (see .bcb-sku-edit CSS). */}
        <span className="bcb-sku-edit">
          <Button
            variant="subtle"
            iconOnly={<EditIcon />}
            onClick={() => setEditing(true)}
            aria-label="Edit SKU"
          />
        </span>
      </Flex>
    );
  }

  return (
    <Box style={{ minWidth: 0 }}>
      <Flex alignItems="center" flexGap="0.25rem">
        <Box style={{ width: 110 }}>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={saving}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') cancel();
            }}
          />
        </Box>
        <Button variant="primary" onClick={save} isLoading={saving} disabled={saving}>
          Save
        </Button>
        <Button
          variant="subtle"
          iconOnly={<CloseIcon />}
          onClick={cancel}
          disabled={saving}
          aria-label="Cancel"
        />
      </Flex>
      {error && (
        <Text as="small" color="danger" marginBottom="none">
          {error}
        </Text>
      )}
    </Box>
  );
}

// Tab definitions: id, label, and the predicate used to filter.
const TABS = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'out', label: 'Out of Stock', match: (b) => stockStateOf(b) === 'out' },
  { id: 'low', label: 'Inventory Low', match: (b) => stockStateOf(b) === 'low' },
  { id: 'visible', label: 'Visible', match: (b) => b.is_visible === true },
  { id: 'hidden', label: 'Hidden', match: (b) => b.is_visible === false },
];

const PAGE_SIZES = [25, 50, 100];

// Total of all column widths — the table never shrinks below this, so the
// container scrolls horizontally instead of squishing the columns. The first
// seven columns (through Bundle price) fit on screen; Discount onward scroll.
// SKU column is wide (250) to fit the inline editor (input + Save + cancel).
const TABLE_MIN_WIDTH = 1700;

export default function BundleList() {
  const navigate = useNavigate();
  const { format } = useCurrency();

  const [bundles, setBundles] = useState([]);
  const [categoryMap, setCategoryMap] = useState({}); // id → name
  const [storeHash, setStoreHash] = useState(null); // for control-panel links
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [deleteModal, setDeleteModal] = useState(null); // { id, name }
  const [deleting, setDeleting] = useState(false);
  const [quickView, setQuickView] = useState(null);

  // "Modify" popup: toggles whether a bundle expands into $0 product lines on
  // orders when purchased. { id, name, enabled } — enabled = current flag state.
  const [modifyModal, setModifyModal] = useState(null);
  const [modifying, setModifying] = useState(false);
  const [modifyError, setModifyError] = useState(null);

  const [reindexing, setReindexing] = useState(false);
  const [actionMsg, setActionMsg] = useState(null); // success banner
  const [selectedItems, setSelectedItems] = useState([]); // row selection

  // List controls
  const [activeTab, setActiveTab] = useState('all');
  const [searchValue, setSearchValue] = useState('');
  // Default to newest-created first (not alphabetical), so a freshly created
  // bundle shows at the top. 'created' isn't a visible column — clicking any
  // sortable header switches to that column's sort.
  const [sort, setSort] = useState({ columnHash: 'created', direction: 'DESC' });
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(25);

  // ── Data loading ──
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

  const fetchCategories = useCallback(async () => {
    try {
      const { categories } = await getCategories();
      const map = {};
      (categories || []).forEach((c) => {
        map[c.id] = c.name;
      });
      setCategoryMap(map);
    } catch {
      /* non-fatal — category column just shows dashes */
    }
  }, []);

  useEffect(() => {
    fetchBundles();
    fetchCategories();
    getStoreInfo()
      .then((info) => setStoreHash(info.storeHash))
      .catch(() => {});
  }, [fetchBundles, fetchCategories]);

  // Open the bundle's native BigCommerce product-edit page in the control panel.
  const openProductEdit = (id) => {
    if (!storeHash) return;
    const url = `https://store-${storeHash}.mybigcommerce.com/manage/products/${id}/edit`;
    // '_top' breaks out of the app iframe and navigates the whole control panel.
    window.open(url, '_top');
  };

  // ── Actions ──
  const handleReindex = useCallback(async () => {
    setReindexing(true);
    setError(null);
    setActionMsg(null);
    try {
      const res = await reindexProducts();
      setActionMsg(
        `Synced ${res.synced} product${res.synced !== 1 ? 's' : ''} in ${(res.durationMs / 1000).toFixed(1)}s.`
      );
    } catch (err) {
      setError(`Re-index failed: ${err.message}`);
    } finally {
      setReindexing(false);
    }
  }, []);

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

  // Open the "Modify" popup for a bundle row, seeded with its current flag state.
  const openModify = (row) => {
    setModifyModal({
      id: row.id,
      name: row.name,
      enabled: !!row.bundle_config?.expand_on_order,
    });
    setModifyError(null);
  };

  // Confirm: flip this bundle's "expand on order" flag.
  const handleModify = async () => {
    if (!modifyModal) return;
    const next = !modifyModal.enabled;
    setModifying(true);
    setModifyError(null);
    try {
      await setBundleModify(modifyModal.id, next);
      // Reflect the new flag in the row so the list stays in sync.
      setBundles((prev) =>
        prev.map((b) =>
          b.id === modifyModal.id
            ? { ...b, bundle_config: { ...(b.bundle_config || {}), expand_on_order: next } }
            : b
        )
      );
      setModifyModal(null);
      setActionMsg(
        next
          ? `"${modifyModal.name}" will now show its products on orders when purchased.`
          : `"${modifyModal.name}" will no longer show its products on orders.`
      );
    } catch (e) {
      setModifyError(e.message);
    } finally {
      setModifying(false);
    }
  };

  // Update a row's SKU in place after a successful inline edit (no full refetch).
  const handleSkuSaved = useCallback((id, sku) => {
    setBundles((prev) => prev.map((b) => (b.id === id ? { ...b, sku } : b)));
  }, []);

  const handleDuplicate = async (row) => {
    const cfg = row.bundle_config;
    if (!cfg?.products?.length) {
      setError('Cannot duplicate: bundle has no products.');
      return;
    }
    setActionMsg(null);
    try {
      await createBundle({
        name: `${row.name} (Copy)`,
        description: row.description || '',
        discount_percent: cfg.discount_percent || 0,
        category_ids: row.categories || [],
        products: cfg.products.map((p) => ({ product_id: p.product_id, qty: p.qty })),
      });
      setActionMsg(`Duplicated "${row.name}".`);
      await fetchBundles();
    } catch (err) {
      setError(`Duplicate failed: ${err.message}`);
    }
  };

  // ── Derived list: filter → search → sort → paginate ──
  const tabMatch = useMemo(
    () => TABS.find((t) => t.id === activeTab)?.match || (() => true),
    [activeTab]
  );

  const searched = useMemo(() => {
    const q = searchValue.trim().toLowerCase();
    const base = bundles.filter(tabMatch);
    if (!q) return base;
    return base.filter((b) => {
      if (b.name?.toLowerCase().includes(q)) return true;
      if (b.sku?.toLowerCase().includes(q)) return true;
      return (b.bundle_config?.products || []).some(
        (p) => p.name?.toLowerCase().includes(q) || p.sku?.toLowerCase().includes(q)
      );
    });
  }, [bundles, tabMatch, searchValue]);

  const sorted = useMemo(() => {
    const val = (b) => {
      switch (sort.columnHash) {
        // Newest first by creation date; fall back to product id (higher id =
        // created later) when date_created is missing.
        case 'created': return Date.parse(b.date_created) || b.id || 0;
        case 'name': return (b.name || '').toLowerCase();
        case 'inventory_level': return b.inventory_level ?? 0;
        case 'price': return Number(b.price) || 0;
        case 'bundle_price': return bundlePriceOf(b);
        case 'discount': return discountOf(b);
        default: return 0;
      }
    };
    const dir = sort.direction === 'ASC' ? 1 : -1;
    return [...searched].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [searched, sort]);

  const totalItems = sorted.length;
  const pageItems = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return sorted.slice(start, start + itemsPerPage);
  }, [sorted, currentPage, itemsPerPage]);

  // Keep currentPage valid when filters shrink the list.
  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(totalItems / itemsPerPage));
    if (currentPage > maxPage) setCurrentPage(maxPage);
  }, [totalItems, itemsPerPage, currentPage]);

  // ── Columns (fixed widths so the table scrolls instead of squishing) ──
  const columns = [
    {
      header: 'Name',
      hash: 'name',
      isSortable: true,
      width: 300,
      render: (row) => (
        <Flex alignItems="center" flexGap="0.75rem">
          <BundleThumb row={row} />
          <Box style={{ minWidth: 0 }}>
            <Text
              color="primary"
              marginBottom="none"
              onClick={() => openProductEdit(row.id)}
              style={{ cursor: 'pointer', userSelect: 'none' }}
            >
              {row.name}
            </Text>
            <Text as="small" color="secondary60" marginBottom="none">
              ID: {row.id}
            </Text>
          </Box>
        </Flex>
      ),
    },
    {
      header: 'SKU',
      hash: 'sku',
      width: 250,
      render: (row) => <EditableSku row={row} onSaved={handleSkuSaved} />,
    },
    {
      header: 'Categories',
      hash: 'category',
      width: 200,
      render: (row) => {
        const names = (row.categories || []).map((id) => categoryMap[id]).filter(Boolean);
        if (!names.length) return <Text marginBottom="none">—</Text>;
        return (
          <Dropdown
            placement="bottom-start"
            maxHeight={300}
            toggle={
              <Box
                style={{
                  cursor: 'pointer',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                <Text marginBottom="none">{names.join(', ')}</Text>
              </Box>
            }
            items={names.map((n, i) => ({
              content: n,
              hash: `${row.id}-cat-${i}`,
              onItemClick: () => {},
            }))}
          />
        );
      },
    },
    {
      header: 'Current stock',
      hash: 'inventory_level',
      isSortable: true,
      width: 130,
      // A red dot flags an out-of-stock (0) bundle, matching BigCommerce's own
      // product-list indicator.
      render: (row) => {
          const stock = row.inventory_level ?? 0;
         return (
  <Flex
    alignItems="center"
    flexGap="0.4rem"
    style={{
      width: '100%',
      justifyContent: 'center', // or 'flex-start'
      boxSizing: 'border-box',
    }}
  >
    {stock === 0 && (
      <Box
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: '#d14343',
          flexShrink: 0,
        }}
      />
    )}
    <Text marginBottom="none">{stock}</Text>
  </Flex>
);
      },
    },
    {
      header: 'Original price',
      hash: 'price',
      isSortable: true,
      width: 140,
      render: (row) => <Text marginBottom="none">{format(Number(row.price) || 0)}</Text>,
    },
    {
      header: 'Bundle price',
      hash: 'bundle_price',
      isSortable: true,
      width: 140,
      render: (row) => <Text marginBottom="none">{format(bundlePriceOf(row))}</Text>,
    },
    {
      header: 'Discount',
      hash: 'discount',
      isSortable: true,
      width: 110,
      render: (row) => {
        const d = discountOf(row);
        if (!d) return <Text color="secondary60" marginBottom="none">—</Text>;
        return <Badge label={`${d}%`} variant={d > 20 ? 'success' : 'primary'} />;
      },
    },
    {
      header: 'Visibility',
      hash: 'is_visible',
      width: 110,
      // Effective storefront visibility: an out-of-stock bundle is not shown on
      // the storefront even if is_visible hasn't been flipped yet, so surface it
      // as Hidden rather than reporting the raw is_visible flag.
      render: (row) =>
        row.is_visible && stockStateOf(row) !== 'out' ? (
          <Badge label="Visible" variant="success" />
        ) : (
          <Badge label="Hidden" variant="secondary" />
        ),
    },
    {
      header: 'Status',
      hash: 'status',
      width: 120,
      render: (row) => {
        const st = stockStateOf(row);
        if (st === 'out') return <Badge label="Out of stock" variant="danger" />;
        if (st === 'low') return <Badge label="Low stock" variant="warning" />;
        return <Badge label="Available" variant="success" />;
      },
    },
    {
      header: 'Actions',
      hash: 'actions',
      width: 80,
      render: (row) => (
        <Dropdown
          placement="bottom-end"
          toggle={
            <Button variant="subtle" iconOnly={<MoreHorizIcon />} aria-label="Bundle actions" />
          }
          items={[
            { content: 'View bundle', icon: <VisibilityIcon />, onItemClick: () => setQuickView(row) },
            { content: 'Edit bundle', icon: <EditIcon />, onItemClick: () => navigate(`/bundles/${row.id}/edit`) },
            {
              content: row.bundle_config?.expand_on_order ? 'Modify (on)' : 'Modify',
              icon: <EditIcon />,
              onItemClick: () => openModify(row),
            },
            { content: 'Duplicate bundle', icon: <FileCopyIcon />, onItemClick: () => handleDuplicate(row) },
            {
              content: 'Delete bundle',
              icon: <DeleteIcon />,
              actionType: 'destructive',
              onItemClick: () => setDeleteModal({ id: row.id, name: row.name }),
            },
          ]}
        />
      ),
    },
  ];

  const emptyComponent = (
    <Box padding="xxLarge" style={{ textAlign: 'center' }}>
      <Text style={{ fontSize: 48, marginBottom: 8 }}>📦</Text>
      <Text bold style={{ fontSize: 18 }}>No bundles created yet</Text>
      <Text color="secondary60" marginBottom="medium">
        Create your first bundle to start selling grouped products.
      </Text>
      <Button iconLeft={<AddIcon />} onClick={() => navigate('/bundles/new')}>
        Create Bundle
      </Button>
    </Box>
  );

  return (
    <Box padding="large">
      {/* Header */}
      <Box marginBottom="medium">
        <span style={{ fontSize: '32px', fontWeight: 20, display: 'block', marginBottom: '8px' ,
          
        }}>Bundle Manager</span>

        {/* Re-index on the left, Create Bundle on the right — both solid blue */}
        <Flex justifyContent="space-between" alignItems="center">
          <Button
            iconLeft={<RefreshIcon />}
            onClick={handleReindex}
            isLoading={reindexing}
            disabled={reindexing}
          >
            {reindexing ? 'Syncing…' : 'Re-index products'}
          </Button>
          <Button iconLeft={<AddIcon />} onClick={() => navigate('/bundles/new')}>
            Create Bundle
          </Button>
        </Flex>
      </Box>

      {/* Banners */}
      {actionMsg && (
        <Alert type="success" messages={[{ text: actionMsg }]} marginBottom="medium" onClose={() => setActionMsg(null)} />
      )}
      {error && (
        <Alert type="error" header="Error" messages={[{ text: error }]} marginBottom="medium" onClose={() => setError(null)} />
      )}

      {loading ? (
        <Flex justifyContent="center" padding="xxLarge">
          <ProgressCircle size="medium" />
        </Flex>
      ) : (
        <Box style={{ background: '#fff', border: '1px solid #e8e9eb', borderRadius: 8 }}>
          {/* Tabs — native-style filter pills; active tab gets a blue pill */}
          <Flex
            alignItems="center"
            flexGap="0.25rem"
            style={{ padding: '8px 12px', borderBottom: '1px solid #e8e9eb', flexWrap: 'wrap' }}
          >
            {TABS.map((t) => {
              const active = t.id === activeTab;
              return (
                <Box
                  key={t.id}
                  onClick={() => {
                    setActiveTab(t.id);
                    setCurrentPage(1);
                  }}
                  style={{
                    padding: '8px 16px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontWeight: 400,
                    fontSize: 14,
                    whiteSpace: 'nowrap',
                    color: '#1c6ee0',
                    background: active ? '#e6f0fb' : 'transparent',
                  }}
                >
                  {t.label}
                </Box>
              );
            })}
          </Flex>

          {/* Search */}
          <Box padding="medium">
            <Search
              value={searchValue}
              onChange={(e) => {
                setSearchValue(e.target.value);
                setCurrentPage(1);
              }}
              onSubmit={(e) => e.preventDefault()}
              placeholder="Search bundle name, SKU, or product..."
            />
          </Box>

          {/* Table area — top pagination pinned to the same row as the
              "N bundles" count bar (absolute, so it doesn't scroll away) */}
          <Box style={{ position: 'relative' }}>
            {totalItems > 0 && (
              <Box style={{ position: 'absolute', top: 8, right: 16, zIndex: 1 }}>
                <OffsetPagination
                  currentPage={currentPage}
                  totalItems={totalItems}
                  itemsPerPage={itemsPerPage}
                  itemsPerPageOptions={PAGE_SIZES}
                  onPageChange={setCurrentPage}
                  onItemsPerPageChange={(n) => {
                    setItemsPerPage(n);
                    setCurrentPage(1);
                  }}
                />
              </Box>
            )}

            <Box className="bcb-bundle-table" style={{ overflowX: 'auto' }}>
              {/* Hand cursor anywhere over a data row (name, SKU, etc.) —
                  hovering the row reads as clickable. Skips the header row. */}
              <style>{`
                .bcb-bundle-table tbody tr td { cursor: pointer; }
                .bcb-bundle-table tbody tr td:first-child { cursor: default; }
                /* Show the SKU edit pencil only on row hover (opacity keeps
                   layout stable so the SKU text doesn't shift). Keep it visible
                   while focused for keyboard access. */
                .bcb-bundle-table tbody tr .bcb-sku-edit { opacity: 0; transition: opacity .12s ease; display: inline-flex; }
                .bcb-bundle-table tbody tr:hover .bcb-sku-edit,
                .bcb-bundle-table tbody tr .bcb-sku-edit:focus-within { opacity: 1; }
                /* Smaller, muted pencil; turns blue on hover. */
                .bcb-sku-edit button { padding: 2px !important; height: auto !important; min-height: 0 !important; }
                .bcb-sku-edit svg { width: 14px; height: 14px; color: #9aa3b2; fill: currentColor; }
                .bcb-sku-edit button:hover svg { color: #3c64f4; }
              `}</style>
              <Box style={{ minWidth: TABLE_MIN_WIDTH }}>
              <Table
                columns={columns}
                items={pageItems}
                keyField="id"
                itemName="bundles"
                emptyComponent={emptyComponent}
                selectable={{ selectedItems, onSelectionChange: setSelectedItems }}
                sortable={{
                  columnHash: sort.columnHash,
                  direction: sort.direction,
                  onSort: (columnHash, direction) => setSort({ columnHash, direction }),
                }}
              />
            </Box>
            </Box>
          </Box>

          {/* Bottom pagination — outside the horizontal scroll area, stays put */}
          {totalItems > 0 && (
            <Flex
              justifyContent="flex-end"
              style={{ borderTop: '1px solid #e8e9eb', padding: '8px 16px' }}
            >
              <OffsetPagination
                currentPage={currentPage}
                totalItems={totalItems}
                itemsPerPage={itemsPerPage}
                itemsPerPageOptions={PAGE_SIZES}
                onPageChange={setCurrentPage}
                onItemsPerPageChange={(n) => {
                  setItemsPerPage(n);
                  setCurrentPage(1);
                }}
              />
            </Flex>
          )}
        </Box>
      )}

      {/* Delete confirmation modal */}
      <Modal
        isOpen={!!deleteModal}
        onClose={() => setDeleteModal(null)}
        header="Delete Bundle"
        actions={[
          { text: 'Cancel', variant: 'subtle', onClick: () => setDeleteModal(null) },
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
          Are you sure you want to delete <strong>{deleteModal?.name}</strong>? This will
          remove the bundle product and unlink it from all component products. This action
          cannot be undone.
        </Text>
      </Modal>

      {/* Modify modal — toggle whether this bundle shows its products on orders */}
      <Modal
        isOpen={!!modifyModal}
        onClose={() => { if (!modifying) setModifyModal(null); }}
        header="Modify"
        actions={[
          { text: 'Cancel', variant: 'subtle', onClick: () => setModifyModal(null), disabled: modifying },
          {
            text: modifying ? 'Saving…' : (modifyModal?.enabled ? 'Turn off' : 'Modify'),
            variant: 'primary',
            actionType: modifyModal?.enabled ? 'destructive' : undefined,
            onClick: handleModify,
            disabled: modifying,
          },
        ]}
      >
        {modifyModal?.enabled ? (
          <Text>
            <strong>{modifyModal?.name}</strong> currently shows its products on the order page
            when purchased. Turn this off so future orders show only the bundle?
          </Text>
        ) : (
          <Text>
            When a customer purchases <strong>{modifyModal?.name}</strong>, show the products it
            contains on the admin order page (added as $0 line items). Bundles without this stay
            as a single line. Apply this?
          </Text>
        )}
        {modifyError && (
          <Text as="small" color="danger" marginBottom="none" style={{ marginTop: 8, display: 'block' }}>
            {modifyError}
          </Text>
        )}
      </Modal>

      {/* Quick view modal */}
      <QuickViewModal
        bundle={quickView}
        format={format}
        onClose={() => setQuickView(null)}
        onEdit={(id) => navigate(`/bundles/${id}/edit`)}
      />
    </Box>
  );
}

// Read-only preview of a bundle: the products it includes + the pricing summary.
function QuickViewModal({ bundle, format, onClose, onEdit }) {
  if (!bundle) return null;

  const products = bundle.bundle_config?.products || [];
  const discountPct = Number(bundle.bundle_config?.discount_percent) || 0;
  const subtotal = products.reduce(
    (sum, p) => sum + (Number(p.price) || 0) * (p.qty && p.qty > 0 ? p.qty : 1),
    0
  );
  const finalPrice =
    bundle.sale_price && Number(bundle.sale_price) > 0
      ? Number(bundle.sale_price)
      : Math.round(subtotal * (1 - discountPct / 100) * 100) / 100;
  const savings = Math.round((subtotal - finalPrice) * 100) / 100;

  return (
    <Modal
      isOpen={!!bundle}
      onClose={onClose}
      header={bundle.name}
      actions={[
        { text: 'Close', variant: 'subtle', onClick: onClose },
        { text: 'Edit bundle', variant: 'primary', onClick: () => onEdit(bundle.id) },
      ]}
    >
      <Flex justifyContent="space-between" alignItems="center" marginBottom="medium">
        <Text color="secondary60">Bundle ID: {bundle.id}</Text>
        {bundle.availability === 'available' ? (
          <Badge label="Available" variant="success" />
        ) : (
          <Badge label="Unavailable" variant="danger" />
        )}
      </Flex>

      <Text bold marginBottom="xSmall">
        Products in this bundle ({products.length})
      </Text>
      {products.length === 0 ? (
        <Text color="secondary60">No products in this bundle.</Text>
      ) : (
        <Box marginBottom="medium">
          {products.map((p) => {
            const qty = p.qty && p.qty > 0 ? p.qty : 1;
            const unit = Number(p.price) || 0;
            return (
              <Flex
                key={p.product_id}
                alignItems="center"
                flexGap="0.75rem"
                style={{ padding: '8px 0', borderBottom: '1px solid #f0f1f3' }}
              >
                {p.thumbnail ? (
                  <img
                    src={p.thumbnail}
                    alt={p.name}
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
                      fontSize: 16,
                    }}
                  >
                    📦
                  </Box>
                )}
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Text bold marginBottom="none">{p.name}</Text>
                  {p.sku && (
                    <Text as="small" color="secondary60" marginBottom="none">
                      SKU: {p.sku}
                    </Text>
                  )}
                </Box>
                <Box style={{ textAlign: 'right' }}>
                  <Text marginBottom="none">
                    {qty} × {format(unit)}
                  </Text>
                  <Text as="small" color="secondary60" marginBottom="none">
                    {format(unit * qty)}
                  </Text>
                </Box>
              </Flex>
            );
          })}
        </Box>
      )}

      <Box padding="medium" style={{ background: '#f5f7fa', borderRadius: 6 }}>
        <Flex justifyContent="space-between" marginBottom="xSmall">
          <Text marginBottom="none">Products total</Text>
          <Text marginBottom="none">{format(subtotal)}</Text>
        </Flex>
        <Flex justifyContent="space-between" marginBottom="xSmall">
          <Text marginBottom="none">Discount</Text>
          <Text marginBottom="none">{discountPct}%</Text>
        </Flex>
        <Flex justifyContent="space-between" marginBottom="xSmall">
          <Text bold marginBottom="none">Bundle price (after discount)</Text>
          <Text bold marginBottom="none">{format(finalPrice)}</Text>
        </Flex>
        <Flex justifyContent="space-between">
          <Text color="success" marginBottom="none">Customer saves</Text>
          <Text color="success" marginBottom="none">{format(savings)}</Text>
        </Flex>
      </Box>
    </Modal>
  );
}
