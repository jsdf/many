#!/bin/bash
set -e

APP_NAME="Many.app"
BUILD_DIR="dist/mac-arm64"
INSTALL_DIR="/Applications"

# Check if build exists (try both arm64 and universal paths)
if [ -d "dist/mac-arm64/$APP_NAME" ]; then
  BUILD_DIR="dist/mac-arm64"
elif [ -d "dist/mac/$APP_NAME" ]; then
  BUILD_DIR="dist/mac"
elif [ -d "dist/mac-universal/$APP_NAME" ]; then
  BUILD_DIR="dist/mac-universal"
else
  echo "Error: Built app not found in dist/. Run 'npm run electron:build' first."
  exit 1
fi

echo "Installing $APP_NAME to $INSTALL_DIR..."

# Remove existing installation if present
if [ -d "$INSTALL_DIR/$APP_NAME" ]; then
  echo "Removing existing installation..."
  rm -rf "$INSTALL_DIR/$APP_NAME"
fi

# Copy the app
cp -R "$BUILD_DIR/$APP_NAME" "$INSTALL_DIR/$APP_NAME"

echo "Installed $APP_NAME to $INSTALL_DIR/$APP_NAME"
echo "You can now launch Many from Applications or Spotlight."
