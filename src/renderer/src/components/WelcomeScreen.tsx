import React from "react";

const WelcomeScreen: React.FC = () => {
  return (
    <div className="main-content">
      <div className="welcome">
        <h1>Many Worktree Manager</h1>
        <p>Manage git worktrees for parallel development with AI tools</p>
        <div className="features">
          <div className="feature">
            <h3>🌿 Multiple Worktrees</h3>
            <p>Work on different features simultaneously</p>
          </div>
          <div className="feature">
            <h3>🤖 AI Integration</h3>
            <p>Generate branch names from prompts</p>
          </div>
          <div className="feature">
            <h3>⚡ Quick Setup</h3>
            <p>Create worktrees with a single click</p>
          </div>
          <div className="feature">
            <h3>📂 External Tools</h3>
            <p>Open worktrees in your editor or terminal</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WelcomeScreen;