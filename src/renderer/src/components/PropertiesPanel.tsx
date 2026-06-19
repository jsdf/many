import React, { useRef, useState } from "react";
import { X } from "lucide-react";
import { PropertyValue } from "../frontmatter";

type PropType = "text" | "number" | "checkbox" | "list";

interface Row {
  id: number;
  key: string;
  type: PropType;
  // Editor-native value: text/number -> string, checkbox -> boolean, list -> string[]
  text: string;
  bool: boolean;
  list: string[];
}

function detectType(value: PropertyValue): PropType {
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "list";
  return "text";
}

function toRow(id: number, key: string, value: PropertyValue): Row {
  const type = detectType(value);
  return {
    id,
    key,
    type,
    text: type === "text" || type === "number" ? (value == null ? "" : String(value)) : "",
    bool: type === "checkbox" ? Boolean(value) : false,
    list: type === "list" ? (value as Array<string | number>).map(String) : [],
  };
}

function rowValue(row: Row): PropertyValue {
  switch (row.type) {
    case "checkbox":
      return row.bool;
    case "number": {
      if (row.text.trim() === "") return null;
      const n = Number(row.text);
      return Number.isFinite(n) ? n : row.text;
    }
    case "list":
      return row.list.filter((s) => s.trim() !== "");
    default:
      return row.text;
  }
}

function rowsToProperties(rows: Row[]): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key === "") continue;
    out[key] = rowValue(row);
  }
  return out;
}

const TYPE_OPTIONS: { value: PropType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "checkbox", label: "Checkbox" },
  { value: "list", label: "List" },
];

function ListEditor({ values, onChange }: { values: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const v = draft.trim();
    if (v === "") return;
    onChange([...values, v]);
    setDraft("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      {values.map((v, i) => (
        <span key={i} className="badge badge-sm badge-neutral gap-1">
          {v}
          <button
            className="text-base-content/60 hover:text-error"
            title="Remove"
            onClick={() => onChange(values.filter((_, j) => j !== i))}
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        className="input input-xs flex-1 min-w-[80px]"
        placeholder="Add..."
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}

interface PropertiesPanelProps {
  initialProperties: Record<string, PropertyValue>;
  onChange: (properties: Record<string, PropertyValue>) => void;
}

const PropertiesPanel: React.FC<PropertiesPanelProps> = ({ initialProperties, onChange }) => {
  const idRef = useRef(0);
  const [rows, setRows] = useState<Row[]>(() =>
    Object.entries(initialProperties).map(([key, value]) => toRow(idRef.current++, key, value))
  );

  const commit = (next: Row[]) => {
    setRows(next);
    onChange(rowsToProperties(next));
  };

  const update = (id: number, patch: Partial<Row>) =>
    commit(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const addRow = () =>
    commit([...rows, { id: idRef.current++, key: "", type: "text", text: "", bool: false, list: [] }]);

  const removeRow = (id: number) => commit(rows.filter((r) => r.id !== id));

  return (
    <div className="border-b border-base-300 bg-base-200/40 px-4 py-2 text-[13px]">
      {rows.length > 0 && (
        <div className="flex flex-col gap-1">
          {rows.map((row) => (
            <div key={row.id} className="flex items-center gap-2">
              <select
                className="select select-xs w-24 shrink-0"
                value={row.type}
                title="Property type"
                onChange={(e) => update(row.id, { type: e.target.value as PropType })}
              >
                {TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <input
                className="input input-xs w-40 shrink-0 font-medium"
                placeholder="Property"
                value={row.key}
                onChange={(e) => update(row.id, { key: e.target.value })}
              />
              <div className="flex-1 min-w-0">
                {row.type === "checkbox" ? (
                  <input
                    type="checkbox"
                    className="checkbox checkbox-sm"
                    checked={row.bool}
                    onChange={(e) => update(row.id, { bool: e.target.checked })}
                  />
                ) : row.type === "list" ? (
                  <ListEditor values={row.list} onChange={(list) => update(row.id, { list })} />
                ) : (
                  <input
                    className="input input-xs w-full"
                    type={row.type === "number" ? "number" : "text"}
                    value={row.text}
                    onChange={(e) => update(row.id, { text: e.target.value })}
                  />
                )}
              </div>
              <button
                className="btn btn-ghost btn-xs text-base-content/50 hover:text-error shrink-0"
                title="Remove property"
                onClick={() => removeRow(row.id)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <button className="btn btn-ghost btn-xs mt-1 text-base-content/60" onClick={addRow}>
        + Add property
      </button>
    </div>
  );
};

export default PropertiesPanel;
