#!/usr/bin/env bash
# Ralph loop: iterates through CLAUDE.md improvement tasks using dclaude.
# Each iteration spawns a fresh Claude Code session that picks the next
# unchecked task, does it, commits, and checks the box.

set -euo pipefail

TASK_FILE="ralph.md"
MAX_ITERATIONS=10
ITERATION=0

PROMPT='You are working through a task list in ralph.md.

Instructions:
1. Read ralph.md
2. Find the FIRST unchecked task (line starting with "- [ ]")
3. If no unchecked tasks remain, say "ALL_TASKS_COMPLETE" and stop.
4. Otherwise, do the task:
   - Read the relevant files to verify current state
   - Make the fix/update in CLAUDE.md if needed
   - If nothing needs changing, just note that in the commit message
5. After completing the task, update ralph.md to check off that task (change "- [ ]" to "- [x]")
6. Commit any changes (CLAUDE.md changes + updated task file) together with a descriptive message.
7. Do NOT work on more than one task per iteration.'

echo "=== Ralph Loop: CLAUDE.md Improvements ==="
echo "Task file: $TASK_FILE"
echo "Max iterations: $MAX_ITERATIONS"
echo ""

while [ $ITERATION -lt $MAX_ITERATIONS ]; do
	ITERATION=$((ITERATION + 1))

	# Check if there are unchecked tasks remaining
	if ! grep -q '^\- \[ \]' "$TASK_FILE"; then
		echo "=== All tasks complete! ==="
		exit 0
	fi

	REMAINING=$(grep -c '^\- \[ \]' "$TASK_FILE")
	echo "=== Iteration $ITERATION/$MAX_ITERATIONS ($REMAINING tasks remaining) ==="

	# Run claude in non-interactive mode with the prompt
	OUTPUT=$(claude --dangerously-skip-permissions -p "$PROMPT" 2>&1) || true
	echo "$OUTPUT"

	# Check if all tasks are done
	if echo "$OUTPUT" | grep -q "ALL_TASKS_COMPLETE"; then
		echo "=== All tasks complete! ==="
		exit 0
	fi

	echo ""
	echo "--- Iteration $ITERATION done ---"
	echo ""
done

echo "=== Reached max iterations ($MAX_ITERATIONS) ==="
REMAINING=$(grep -c '^\- \[ \]' "$TASK_FILE" || true)
echo "$REMAINING tasks still unchecked."
