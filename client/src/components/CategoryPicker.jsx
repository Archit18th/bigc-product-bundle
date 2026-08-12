/**
 * CategoryPicker
 * Multi-select category picker with tree indentation.
 * Loads category list from backend on mount.
 */
import React, { useEffect, useState } from 'react';
import {
  Box,
  Checkbox,
  Text,
  ProgressCircle,
  Flex,
  Input,
} from '@bigcommerce/big-design';
import { SearchIcon } from '@bigcommerce/big-design-icons';
import { getCategories } from '../api';

/**
 * Flatten a category tree into a sorted list with depth info.
 * BigCommerce returns a flat list, but includes parent_id.
 */
function buildTree(flatList) {
  const map = {};
  flatList.forEach((c) => (map[c.id] = { ...c, children: [] }));

  const roots = [];
  flatList.forEach((c) => {
    if (c.parent_id && map[c.parent_id]) {
      map[c.parent_id].children.push(map[c.id]);
    } else {
      roots.push(map[c.id]);
    }
  });

  // Flatten with depth
  const result = [];
  function walk(node, depth) {
    result.push({ ...node, depth });
    node.children
      .sort((a, b) => a.sort_order - b.sort_order)
      .forEach((child) => walk(child, depth + 1));
  }
  roots.sort((a, b) => a.sort_order - b.sort_order).forEach((r) => walk(r, 0));
  return result;
}

export default function CategoryPicker({ value = [], onChange }) {
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    async function load() {
      try {
        // BUG-11: filter system category by ID (not name) so renaming it in BC
        // admin doesn't make it suddenly appear in the picker for merchants.
        const { categories: data, systemCategoryId } = await getCategories();
        const visible = data.filter((c) => c.id !== systemCategoryId);
        setCategories(buildTree(visible));
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const toggle = (id) => {
    if (value.includes(id)) {
      onChange(value.filter((v) => v !== id));
    } else {
      onChange([...value, id]);
    }
  };

  // "All categories": selects/clears every category at once.
  const allIds = categories.map((c) => c.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => value.includes(id));
  const someSelected = value.length > 0 && !allSelected;
  const toggleAll = () => onChange(allSelected ? [] : allIds);

  // UI-only: filter the displayed tree by name. Selection/toggle logic is
  // unchanged — this only narrows what's rendered.
  const term = search.trim().toLowerCase();
  const visibleCategories = term
    ? categories.filter((c) => c.name.toLowerCase().includes(term))
    : categories;

  if (loading) {
    return (
      <Flex padding="medium">
        <ProgressCircle size="small" />
        <Text marginLeft="small" color="secondary60">
          Loading categories…
        </Text>
      </Flex>
    );
  }

  if (error) {
    return <Text color="danger">Failed to load categories: {error}</Text>;
  }

  return (
    <Box>
      {/* Search categories */}
      <Box marginBottom="small">
        <Input
          placeholder="Search categories…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          iconLeft={<SearchIcon />}
        />
      </Box>

      <Box
        style={{
    height: '280px',
    overflowY: 'auto',
    overflowX: 'hidden',
    border: '1px solid #e8e9eb',
    borderRadius: 8,
    padding: '0.5rem',
  }}
      >
      {/* Select-all option */}
      {allIds.length > 0 && (
        <Flex
          alignItems="center"
          padding="xSmall"
          style={{ borderBottom: '1px solid #e8e9eb', marginBottom: '0.25rem' }}
        >
          <Checkbox
            label="Select All"
            checked={allSelected}
            isIndeterminate={someSelected}
            onChange={toggleAll}
          />
        </Flex>
      )}

      {visibleCategories.length === 0 && (
        <Text color="secondary60" marginBottom="none" padding="xSmall">
          No categories match “{search}”.
        </Text>
      )}

      {visibleCategories.slice(0, 10).map((cat) => (
        <Flex
          key={cat.id}
          alignItems="center"
          padding="xSmall"
          style={{ paddingLeft: `${cat.depth * 20 + 8}px` }}
        >
          <Checkbox
            label={cat.name}
            checked={value.includes(cat.id)}
            onChange={() => toggle(cat.id)}
          />
        </Flex>
      ))}
      </Box>
    </Box>
  );
}
// {visibleCategories.map((cat) => (