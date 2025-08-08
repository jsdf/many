import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { TerminalManager, TerminalConfig, WorktreeTerminals } from './terminal-manager';

// Context type for tRPC procedures
export interface Context {
  terminalManager: TerminalManager;
}

// Initialize tRPC with context - no transformer for simplicity
const t = initTRPC.context<Context>().create();

// Export procedure helpers
export const publicProcedure = t.procedure;

// Zod schemas for terminal management
const TerminalConfigSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.enum(['terminal', 'claude']),
  initialCommand: z.string().optional(),
});

const WorktreeTerminalsSchema = z.object({
  terminals: z.array(TerminalConfigSchema),
  nextTerminalId: z.number(),
});

// Create a minimal tRPC router for testing
export const router = t.router({
  hello: publicProcedure
    .input(z.object({ name: z.string().optional() }))
    .query(({ input }) => {
      console.log("=== tRPC hello query received ===", input);
      const name = input.name || "World";
      const result = `Hello ${name}!`;
      console.log("=== tRPC hello query result ===", result);
      return result;
    }),

  // Minimal terminal management procedures without complex serialization
  getWorktreeTerminals: publicProcedure
    .input(z.object({ worktreePath: z.string() }))
    .query(({ input, ctx }) => {
      const terminals = ctx.terminalManager.getWorktreeTerminals(input.worktreePath);
      // Return simple serializable object
      return {
        terminals: terminals.terminals || [],
        nextTerminalId: terminals.nextTerminalId || 1
      };
    }),

  addTerminalToWorktree: publicProcedure
    .input(z.object({
      worktreePath: z.string(),
      terminal: TerminalConfigSchema,
    }))
    .mutation(({ input, ctx }) => {
      ctx.terminalManager.addTerminalToWorktree(input.worktreePath, input.terminal);
      const terminals = ctx.terminalManager.getWorktreeTerminals(input.worktreePath);
      return {
        terminals: terminals.terminals || [],
        nextTerminalId: terminals.nextTerminalId || 1
      };
    }),

  removeTerminalFromWorktree: publicProcedure
    .input(z.object({
      worktreePath: z.string(),
      terminalId: z.string(),
    }))
    .mutation(({ input, ctx }) => {
      ctx.terminalManager.removeTerminalFromWorktree(input.worktreePath, input.terminalId);
      const terminals = ctx.terminalManager.getWorktreeTerminals(input.worktreePath);
      return {
        terminals: terminals.terminals || [],
        nextTerminalId: terminals.nextTerminalId || 1
      };
    }),
});

// Export the router type for client-side usage
export type AppRouter = typeof router;