# Many - Worktree Manager

A modern Electron desktop application for managing Git worktrees, designed for parallel development workflows with AI tools like Claude Code.

## Features

- **Multiple Repository Management** - Add and switch between different Git repositories
- **Worktree Creation & Management** - Create new worktrees with automatic branch creation
- **AI-Friendly Branch Naming** - Converts natural language prompts into clean branch names
- **Integrated Workflow** - Designed to work seamlessly with AI development tools
- **Cross-Platform** - Works on macOS, Windows, and Linux

## Screenshots

![Many Worktree Manager Interface](docs/screenshot.png)

## Getting Started

### Prerequisites

- Node.js 18 or higher
- Git installed and configured
- An existing Git repository to manage

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/your-username/many.git
   cd many
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run in development mode:
   ```bash
   npm run dev
   ```

4. Build for production:
   ```bash
   npm run build
   ```

## Usage

### Adding a Repository

1. Click "Add Repo" in the sidebar
2. Browse to or enter the path of your Git repository
3. Click "Add Repository"

### Creating Worktrees

1. Select a repository from the dropdown
2. Click "Create Worktree"
3. Enter a branch name (e.g., "fix-login-bug", "add-dark-mode")
4. The app will create both the branch and worktree automatically

### Working with Worktrees

- Click on any worktree in the sidebar to view its details
- Each worktree is created in a parallel directory structure
- Perfect for running multiple instances of development tools simultaneously

## Development

### Technology Stack

- **Frontend**: React 19 + TypeScript
- **Build Tool**: Electron Vite
- **Desktop Framework**: Electron
- **Git Operations**: simple-git

### Project Structure

```
src/
├── main/           # Electron main process
├── preload/        # Preload scripts for security
└── renderer/       # React frontend application
    ├── src/
    │   ├── components/  # React components
    │   ├── types.ts     # TypeScript definitions
    │   └── App.tsx      # Main application component
    └── index.html       # HTML entry point
```

### Available Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build the application for production
- `npm run dist` - Create distributable packages
- `npm start` - Run the production build

### Building for Distribution

```bash
npm run build
npm run dist
```

This will create platform-specific packages in the `dist/` directory.

## Use Cases

### AI-Powered Development

Many is designed for developers working with AI coding assistants:

- Create separate worktrees for different features being developed with AI
- Run multiple Claude Code instances in parallel without conflicts
- Organize experiments and iterations in isolated environments

### Team Collaboration

- Quickly switch between different feature branches
- Test multiple versions simultaneously
- Keep your main development environment clean

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built with [Electron](https://electronjs.org/)
- Uses [simple-git](https://github.com/steveukx/git-js) for Git operations
- Inspired by the need for better AI-assisted development workflows