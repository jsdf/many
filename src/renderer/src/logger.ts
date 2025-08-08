// Client-side logger that forwards errors to main process

let isInitialized = false;

export function initializeClientLogging() {
  if (isInitialized) return;
  isInitialized = true;

  // Store original console methods
  const originalError = console.error;
  const originalWarn = console.warn;

  // Override console.error to also log to main process
  console.error = (...args: any[]) => {
    // Call original console.error first
    originalError.apply(console, args);
    
    // Forward to main process logger
    try {
      const errorMessage = args.map(arg => 
        arg instanceof Error ? arg.stack || arg.message : String(arg)
      ).join(' ');
      
      window.electronAPI.logRendererError(errorMessage, 'CONSOLE_ERROR');
    } catch (e) {
      // Fallback if logging fails
      originalError('Failed to forward error to main process:', e);
    }
  };

  // Override console.warn to also log warnings
  console.warn = (...args: any[]) => {
    // Call original console.warn first
    originalWarn.apply(console, args);
    
    // Forward to main process logger
    try {
      const warnMessage = args.map(arg => 
        arg instanceof Error ? arg.stack || arg.message : String(arg)
      ).join(' ');
      
      window.electronAPI.logRendererError(warnMessage, 'CONSOLE_WARN');
    } catch (e) {
      // Fallback if logging fails
      originalError('Failed to forward warning to main process:', e);
    }
  };

  // Capture unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    const error = event.reason;
    const errorMessage = error instanceof Error ? error.stack || error.message : String(error);
    
    try {
      window.electronAPI.logRendererError(errorMessage, 'UNHANDLED_PROMISE_REJECTION');
    } catch (e) {
      originalError('Failed to log unhandled promise rejection:', e);
    }
  });

  // Capture global errors
  window.addEventListener('error', (event) => {
    const errorMessage = event.error ? 
      (event.error.stack || event.error.message) : 
      `${event.message} at ${event.filename}:${event.lineno}:${event.colno}`;
    
    try {
      window.electronAPI.logRendererError(errorMessage, 'GLOBAL_ERROR');
    } catch (e) {
      originalError('Failed to log global error:', e);
    }
  });
}

// Utility function to manually log errors
export async function logError(error: any, source: string = 'MANUAL') {
  try {
    const errorMessage = error instanceof Error ? error.stack || error.message : String(error);
    await window.electronAPI.logRendererError(errorMessage, source);
  } catch (e) {
    console.error('Failed to log error to main process:', e);
  }
}