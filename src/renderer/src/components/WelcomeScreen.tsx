import React from "react";

const WelcomeScreen: React.FC = () => {
  return (
    <div className="flex-1 min-w-0 flex items-center justify-center p-10">
      <div className="text-center max-w-xl">
        <h1 className="text-4xl mb-4">Many Worktree Manager</h1>
        <p className="text-lg text-base-content/60 mb-10">Manage git worktrees for parallel development with AI tools</p>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-5 mt-10">
          <div className="bg-base-200 border border-base-300 rounded-lg p-5">
            <h3 className="text-base mb-2">🌿 Multiple Worktrees</h3>
            <p className="text-sm text-base-content/60 leading-snug">Work on different features simultaneously</p>
          </div>
          <div className="bg-base-200 border border-base-300 rounded-lg p-5">
            <h3 className="text-base mb-2">🤖 AI Integration</h3>
            <p className="text-sm text-base-content/60 leading-snug">Generate branch names from prompts</p>
          </div>
          <div className="bg-base-200 border border-base-300 rounded-lg p-5">
            <h3 className="text-base mb-2">⚡ Quick Setup</h3>
            <p className="text-sm text-base-content/60 leading-snug">Create worktrees with a single click</p>
          </div>
          <div className="bg-base-200 border border-base-300 rounded-lg p-5">
            <h3 className="text-base mb-2">📂 External Tools</h3>
            <p className="text-sm text-base-content/60 leading-snug">Open worktrees in your editor or terminal</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WelcomeScreen;
