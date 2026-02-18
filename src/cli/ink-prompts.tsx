import React, { useState, useMemo } from "react";
import { render, Box, Text, useInput, useApp } from "ink";

// --- Helper to run an Ink component and return a promise ---

function renderPrompt<T>(
  Component: React.FC<{ onResult: (value: T) => void }>,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let resolved = false;

    const onResult = (value: T) => {
      if (!resolved) {
        resolved = true;
        resolve(value);
      }
    };

    const instance = render(<Component onResult={onResult} />);

    instance.waitUntilExit().then(() => {
      if (!resolved) {
        resolved = true;
        // Component exited without calling onResult - treat as cancel
        resolve(undefined as T);
      }
    });
  });
}

// --- Select Menu ---

interface SelectItem<T> {
  label: string;
  value: T;
}

function SelectMenu<T>({
  items,
  title,
  defaultIndex,
  onResult,
}: {
  items: SelectItem<T>[];
  title?: string;
  defaultIndex?: number;
  onResult: (value: T | null) => void;
}) {
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

  const clampedCursor = Math.min(cursor, Math.max(0, filtered.length - 1));
  if (clampedCursor !== cursor) {
    setCursor(clampedCursor);
  }

  useInput((input, key) => {
    if (key.escape) {
      onResult(null);
      exit();
      return;
    }

    if (key.return) {
      if (filtered.length > 0) {
        onResult(filtered[clampedCursor].value);
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

    if (input && !key.ctrl && !key.meta) {
      setFilter((prev) => prev + input);
      setCursor(0);
    }
  });

  return (
    <Box flexDirection="column">
      {title && <Text bold>{title}</Text>}
      {filter && (
        <Text>
          Filter: <Text color="cyan">{filter}</Text>
        </Text>
      )}
      {filtered.length === 0 && <Text color="yellow">No matches</Text>}
      {filtered.map((item, i) => {
        const isSelected = i === clampedCursor;
        return (
          <Text key={item.originalIndex}>
            {isSelected ? (
              <Text color="cyan" bold>
                {"> "}
                {item.label}
              </Text>
            ) : (
              <Text>
                {"  "}
                {item.label}
              </Text>
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

  return renderPrompt<T | null>((props) => (
    <SelectMenu
      items={items}
      title={options?.title}
      defaultIndex={options?.defaultIndex}
      onResult={props.onResult}
    />
  ));
}

// --- Confirm Prompt ---

function ConfirmPrompt({
  message,
  onResult,
}: {
  message: string;
  onResult: (value: boolean) => void;
}) {
  const { exit } = useApp();

  useInput((input, key) => {
    if (key.escape || input === "n" || input === "N") {
      onResult(false);
      exit();
      return;
    }
    if (input === "y" || input === "Y") {
      onResult(true);
      exit();
      return;
    }
  });

  return (
    <Text>
      {message} <Text dimColor>(y/n)</Text>
    </Text>
  );
}

export async function confirm(message: string): Promise<boolean> {
  const result = await renderPrompt<boolean>((props) => (
    <ConfirmPrompt message={message} onResult={props.onResult} />
  ));
  return result ?? false;
}

// --- Text Input Prompt ---

function TextInputPrompt({
  message,
  onResult,
}: {
  message: string;
  onResult: (value: string | null) => void;
}) {
  const [value, setValue] = useState("");
  const { exit } = useApp();

  useInput((input, key) => {
    if (key.escape) {
      onResult(null);
      exit();
      return;
    }

    if (key.return) {
      onResult(value);
      exit();
      return;
    }

    if (key.backspace || key.delete) {
      setValue((prev) => prev.slice(0, -1));
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      setValue((prev) => prev + input);
    }
  });

  return (
    <Box>
      <Text>{message}</Text>
      <Text color="cyan">{value}</Text>
      <Text dimColor>▌</Text>
    </Box>
  );
}

export async function textInput(message: string): Promise<string | null> {
  return renderPrompt<string | null>((props) => (
    <TextInputPrompt message={message} onResult={props.onResult} />
  ));
}
