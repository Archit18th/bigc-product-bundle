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
} from '@bigcommerce/big-design';
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
    <Box
      style={{
        maxHeight: 280,
        overflowY: 'auto',
        border: '1px solid #e8e9eb',
        borderRadius: 4,
        padding: '0.5rem',
      }}
    >
      {categories.map((cat) => (
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
  );
}
