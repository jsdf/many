import { useState, useCallback, useEffect } from "react";
import { Worktree, TerminalConfig, WorktreeTerminals } from "../types";
import { client } from "../main";

// Function to clean up worktree from global state (kept for compatibility)
export const cleanupWorktreeState = (worktreePath: string) => {
  // No-op for now, cleanup handled by backend
};

interface UseWorktreeTerminalsProps {
  selectedWorktree: Worktree | null;
}

export interface TileData {
  id: string;
  type: "terminal";
  title: string;
  terminalConfig: TerminalConfig;
}

export const useWorktreeTerminals = ({
  selectedWorktree,
}: UseWorktreeTerminalsProps) => {
  const [terminalConfig, setTerminalConfig] = useState<WorktreeTerminals>({
    terminals: [],
    nextTerminalId: 1,
  });
  const [isLoadingTerminals, setIsLoadingTerminals] = useState(false);

  // Function to update tile title
  const updateTileTitle = useCallback(
    (tileId: string, newTitle: string) => {
      if (!selectedWorktree) return;

      // Update local config
      setTerminalConfig((prev) => ({
        ...prev,
        terminals: prev.terminals.map((terminal) =>
          terminal.id === tileId ? { ...terminal, title: newTitle } : terminal
        ),
      }));

      // TODO: Implement title update via tRPC
      // For now, just update local state
    },
    [selectedWorktree]
  );

  // Load terminal configuration for the selected worktree
  useEffect(() => {
    const loadWorktreeTerminals = async () => {
      if (!selectedWorktree) {
        setTerminalConfig({ terminals: [], nextTerminalId: 1 });
        return;
      }

      setIsLoadingTerminals(true);
      try {
        // Load terminals from backend via tRPC
        const config = await client.getWorktreeTerminals.query({
          worktreePath: selectedWorktree.path!
        });

        // Just use whatever terminals exist (don't create default ones)
        setTerminalConfig(config);
      } catch (error) {
        console.error("Failed to load worktree terminals:", error);
        // Fallback to basic setup
        setTerminalConfig({ terminals: [], nextTerminalId: 1 });
      } finally {
        setIsLoadingTerminals(false);
      }
    };

    loadWorktreeTerminals();
  }, [selectedWorktree]);

  // Generate terminal tile data only
  const terminalTileData: TileData[] = [];

  if (selectedWorktree) {
    // Add terminal tile data
    for (const terminal of terminalConfig.terminals) {
      terminalTileData.push({
        id: terminal.id,
        type: "terminal",
        title: terminal.title,
        terminalConfig: terminal,
      });
    }
  }

  const handleCloseTile = useCallback(
    async (tileId: string) => {
      if (!selectedWorktree) return;

      // If it's a terminal, clean up the session and update configuration
      if (tileId.includes("terminal-") || tileId.includes("claude-")) {
        try {
          await client.closeTerminal.mutate({ terminalId: tileId });
        } catch (error) {
          console.error("Error closing terminal:", error);
        }

        // Remove terminal via tRPC
        if (selectedWorktree.path) {
          const updatedConfig = await client.removeTerminalFromWorktree.mutate({
            worktreePath: selectedWorktree.path,
            terminalId: tileId
          });
          setTerminalConfig(updatedConfig);
        }
      }
    },
    [selectedWorktree, terminalConfig]
  );

  const handleSplitTile = useCallback(
    async (_tileId: string, _direction: "horizontal" | "vertical") => {
      if (!selectedWorktree) return;

      const newTerminalId = `${selectedWorktree.path}-terminal-${terminalConfig.nextTerminalId}`;
      const newTerminal: TerminalConfig = {
        id: newTerminalId,
        title: `Terminal ${terminalConfig.nextTerminalId}`,
        type: "terminal",
        autoFocus: true, // User-created terminal should auto-focus
      };

      // Add terminal via tRPC
      if (selectedWorktree.path) {
        const updatedConfig = await client.addTerminalToWorktree.mutate({
          worktreePath: selectedWorktree.path,
          terminal: newTerminal
        });
        setTerminalConfig(updatedConfig);
      }
    },
    [selectedWorktree, terminalConfig]
  );

  const handleAddClaudeTerminal = useCallback(async () => {
    if (!selectedWorktree) return;

    const claudeTerminalId = `${selectedWorktree.path}-claude-${terminalConfig.nextTerminalId}`;
    const claudeTerminal: TerminalConfig = {
      id: claudeTerminalId,
      title: "Claude Terminal",
      type: "claude",
      initialCommand: "claude",
      autoFocus: true, // User-created terminal should auto-focus
    };

    // Add Claude terminal via tRPC
    if (selectedWorktree.path) {
      const updatedConfig = await client.addTerminalToWorktree.mutate({
        worktreePath: selectedWorktree.path,
        terminal: claudeTerminal
      });
      setTerminalConfig(updatedConfig);
    }
  }, [selectedWorktree, terminalConfig]);

  return {
    terminalTileData,
    selectedWorktree,
    isLoadingTerminals,
    handleCloseTile,
    handleSplitTile,
    handleAddClaudeTerminal,
    updateTileTitle,
  };
};
