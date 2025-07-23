import { shell } from "electron";
import { spawn } from "child_process";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Utility function to safely extract error message
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const openInFileManager = async (folderPath: string) => {
  try {
    await shell.openPath(folderPath);
    return true;
  } catch (error) {
    console.error("Failed to open in file manager:", error);
    throw new Error(`Failed to open folder: ${getErrorMessage(error)}`);
  }
};

export const openInEditor = async (folderPath: string) => {
  try {
    // Try to open with VS Code first, then fall back to default editor
    const editors = ["code", "cursor", "subl", "atom"];

    for (const editor of editors) {
      try {
        spawn(editor, [folderPath], { detached: true, stdio: "ignore" });
        return true;
      } catch (error) {
        // Continue to next editor
        continue;
      }
    }

    // Fallback to system default
    await shell.openPath(folderPath);
    return true;
  } catch (error) {
    console.error("Failed to open in editor:", error);
    throw new Error(`Failed to open in editor: ${getErrorMessage(error)}`);
  }
};

export const openInTerminal = async (folderPath: string) => {
  try {
    const platform = process.platform;

    if (platform === "darwin") {
      // macOS - open Terminal.app
      spawn("open", ["-a", "Terminal", folderPath], {
        detached: true,
        stdio: "ignore",
      });
    } else if (platform === "win32") {
      // Windows - open Command Prompt
      spawn("cmd", ["/c", "start", "cmd", "/k", `cd /d "${folderPath}"`], {
        detached: true,
        stdio: "ignore",
      });
    } else {
      // Linux - try common terminals
      const terminals = ["gnome-terminal", "konsole", "xterm"];
      for (const terminal of terminals) {
        try {
          if (terminal === "gnome-terminal") {
            spawn(terminal, ["--working-directory", folderPath], {
              detached: true,
              stdio: "ignore",
            });
          } else {
            spawn(terminal, ["-e", "bash"], {
              cwd: folderPath,
              detached: true,
              stdio: "ignore",
            });
          }
          break;
        } catch (error) {
          continue;
        }
      }
    }
    return true;
  } catch (error) {
    console.error("Failed to open in terminal:", error);
    throw new Error(`Failed to open terminal: ${getErrorMessage(error)}`);
  }
};

export const openDirectory = async (dirPath: string) => {
  try {
    await shell.openPath(dirPath);
    return true;
  } catch (error) {
    console.error("Failed to open directory:", error);
    throw new Error(`Failed to open directory: ${getErrorMessage(error)}`);
  }
};

export const openTerminalInDirectory = async (dirPath: string) => {
  try {
    const platform = process.platform;

    if (platform === "darwin") {
      // macOS - open Terminal.app
      await execAsync(`open -a Terminal "${dirPath}"`);
    } else if (platform === "win32") {
      // Windows - open Command Prompt
      await execAsync(`start cmd /K cd /d "${dirPath}"`);
    } else {
      // Linux - try common terminal emulators
      try {
        await execAsync(`gnome-terminal --working-directory="${dirPath}"`);
      } catch {
        try {
          await execAsync(`xfce4-terminal --working-directory="${dirPath}"`);
        } catch {
          await execAsync(`konsole --workdir "${dirPath}"`);
        }
      }
    }
    return true;
  } catch (error) {
    console.error("Failed to open terminal:", error);
    throw new Error(`Failed to open terminal: ${getErrorMessage(error)}`);
  }
};

export const openVSCode = async (dirPath: string) => {
  try {
    await execAsync(`code "${dirPath}"`);
    return true;
  } catch (error) {
    console.error("Failed to open VS Code:", error);
    throw new Error(
      `Failed to open VS Code. Make sure 'code' command is installed: ${getErrorMessage(
        error
      )}`
    );
  }
};