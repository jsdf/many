import React, { useState, useEffect } from 'react'
import { Autocomplete } from '@base-ui-components/react/autocomplete'
import { getRpcClient } from '../rpc-client'

const BranchTypeahead: React.FC<{
  repoPath: string
  exclude: Set<string>
  disabled?: boolean
  onAdd: (value: string) => void
}> = ({ repoPath, exclude, disabled, onAdd }) => {
  const [allBranches, setAllBranches] = useState<string[]>([]);
  const [inputValue, setInputValue] = useState('');

  useEffect(() => {
    getRpcClient().query("branch.list", { repoPath }).then(setAllBranches).catch(() => {});
  }, [repoPath]);

  const filtered = React.useMemo(() => {
    const q = inputValue.trim().toLowerCase();
    if (!q) return [];
    return allBranches
      .filter((b) => b.toLowerCase().includes(q) && !exclude.has(b))
      .slice(0, 15);
  }, [inputValue, allBranches, exclude]);

  const submit = (value?: string) => {
    const v = (value ?? inputValue).trim();
    if (!v) return;
    onAdd(v);
    setInputValue('');
  };

  return (
    <Autocomplete.Root
      value={inputValue}
      onValueChange={(val) => setInputValue(val)}
      items={filtered}
    >
      <div className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Autocomplete.Input
            className="input input-bordered input-sm w-full"
            placeholder="Branch name, PR number, or PR URL..."
            disabled={disabled}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const highlighted = document.querySelector('[data-highlighted]');
                if (!highlighted) {
                  e.preventDefault();
                  submit();
                }
              }
            }}
          />
        </div>
        <button
          className="btn btn-sm btn-primary"
          onClick={() => submit()}
          disabled={!inputValue.trim() || disabled}
        >
          {disabled ? 'Adding...' : 'Add'}
        </button>
      </div>
      <Autocomplete.Portal>
        <Autocomplete.Positioner className="z-50" sideOffset={4}>
          <Autocomplete.Popup className="bg-base-100 border border-base-300 rounded-lg shadow-lg max-h-60 overflow-y-auto py-1">
            <Autocomplete.List>
              {(branch) => (
                <Autocomplete.Item
                  key={branch}
                  value={branch}
                  className="px-3 py-1.5 text-sm cursor-pointer truncate hover:bg-base-200 data-[highlighted]:bg-primary/15 data-[highlighted]:text-primary"
                  onClick={() => submit(branch)}
                >
                  {branch}
                </Autocomplete.Item>
              )}
            </Autocomplete.List>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  );
};

export default BranchTypeahead;
