import React, { useState, useMemo } from "react";
import { render, Box, Text, useInput, useApp } from "ink";

interface SelectItem<T> {
  label: string;
  value: T;
}

interface SelectMenuProps<T> {
  items: SelectItem<T>[];
  title?: string;
  defaultIndex?: number;
  onSelect: (value: T) => void;
  onCancel: () => void;
}

function SelectMenu<T>({
  items,
  title,
  defaultIndex,
  onSelect,
  onCancel,
}: SelectMenuProps<T>) {
  const [cursor, setCursor] = useState(defaultIndex ?? 0);
  const [filter, setFilter] = useState("");
  const { exit } = useApp();

  const filtered = useMemo(() => {
    if (!filter) return items.map((item, i) => ({ ...item, originalIndex: i }));
    const lower = filter.toLowerCase();
    return items
      .map((item, i) => ({ ...item, originalIndex: i }))
      .filter((item) => item.label.toLowerCase().includes(lower));
  }, [items, filter]);

  // Clamp cursor when filtered list changes
  const clampedCursor = Math.min(cursor, Math.max(0, filtered.length - 1));
  if (clampedCursor !== cursor) {
    setCursor(clampedCursor);
  }

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      exit();
      return;
    }

    if (key.return) {
      if (filtered.length > 0) {
        onSelect(filtered[clampedCursor].value);
        exit();
      }
      return;
    }

    if (key.upArrow) {
      setCursor((prev) => (prev <= 0 ? filtered.length - 1 : prev - 1));
      return;
    }

    if (key.downArrow) {
      setCursor((prev) => (prev >= filtered.length - 1 ? 0 : prev + 1));
      return;
    }

    if (key.backspace || key.delete) {
      setFilter((prev) => prev.slice(0, -1));
      setCursor(0);
      return;
    }

    // Printable character
    if (input && !key.ctrl && !key.meta) {
      setFilter((prev) => prev + input);
      setCursor(0);
    }
  });

  return (
    <Box flexDirection="column">
      {title && (
        <Text bold>{title}</Text>
      )}
      {filter && (
        <Text>
          Filter: <Text color="cyan">{filter}</Text>
        </Text>
      )}
      {filtered.length === 0 && (
        <Text color="yellow">No matches</Text>
      )}
      {filtered.map((item, i) => {
        const isSelected = i === clampedCursor;
        return (
          <Text key={item.originalIndex}>
            {isSelected ? (
              <Text color="cyan" bold>{"> "}{item.label}</Text>
            ) : (
              <Text>{"  "}{item.label}</Text>
            )}
          </Text>
        );
      })}
      <Text dimColor>
        {"\n"}↑↓ navigate · type to filter · enter select · esc cancel
      </Text>
    </Box>
  );
}

export async function selectFromList<T>(
  items: Array<{ label: string; value: T }>,
  options?: { title?: string; defaultIndex?: number },
): Promise<T | null> {
  if (items.length === 0) return null;

  return new Promise<T | null>((resolve) => {
    let resolved = false;

    const onSelect = (value: T) => {
      if (!resolved) {
        resolved = true;
        resolve(value);
      }
    };

    const onCancel = () => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    };

    const instance = render(
      <SelectMenu
        items={items}
        title={options?.title}
        defaultIndex={options?.defaultIndex}
        onSelect={onSelect}
        onCancel={onCancel}
      />,
    );

    instance.waitUntilExit().then(() => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    });
  });
}
