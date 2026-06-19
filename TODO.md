* [x] remove the archive button from recyclable worktrees

* [x] remove the merge changes and rebase branch buttons

* [x] remove the worktree dir prefix from all the places that the worktree path is displayed

* [x] remove worktree overview, move quick actions and worktree management buttons into the header bar as a single row of buttons

* [x] move claim button to the header bar of the worktree pane and have the dialog auto select the worktree where the button was clicked from

* [x] add a feature in the repo config of a dir to write terminal logs to. the log should be named by the branch and have a max size

* [x] remove + from create worktree button and make it the same color as new task

* [x] remove achive button from base repo worktree view

* [x] make left nav resizable

* [x] make left nav collapsed state still have a narrow fixed width left sidebar

* [x] everywhere which outputs colored text needs a darker background in light mode or we need to make the text colors darker in the light theme

* [ ] trap usual window management commands like CMD+W, `CMD+[` or `CMD+]` and make them close terminals or cycle through the terminals respectively (or main pane tabs)

- [ ] replace markdown editor with tiptap and ensure undo works, checkboxes work

- allow project root dirs to be pinned like any other dir

- when unfilitering in the projects tree or changing selection in the active tree, make sure the selected item is in view afterwards. if its already in view don't do anything
