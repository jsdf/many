import React, { useState, useCallback, useRef } from 'react'

export interface Tile {
  id: string
  type: 'content' | 'terminal'
  title: string
  component: React.ReactNode
  width?: number
  height?: number
}

interface TilingLayoutProps {
  tiles: Tile[]
  onCloseTile?: (tileId: string) => void
  onSplitTile?: (tileId: string, direction: 'horizontal' | 'vertical') => void
}

interface TileComponentProps {
  tile: Tile
  onClose?: () => void
  onSplit?: (direction: 'horizontal' | 'vertical') => void
  isResizing: boolean
}

const TileComponent: React.FC<TileComponentProps> = ({ tile, onClose, onSplit, isResizing }) => {
  return (
    <div className={`tile ${isResizing ? 'resizing' : ''}`} data-tile-id={tile.id}>
      <div className="tile-header">
        <span className="tile-title">{tile.title}</span>
        <div className="tile-controls">
          {tile.type === 'terminal' && (
            <button 
              className="tile-control-btn" 
              onClick={onClose}
              title="Close terminal"
            >
              ×
            </button>
          )}
        </div>
      </div>
      <div className="tile-content">
        {tile.component}
      </div>
    </div>
  )
}

const TilingLayout: React.FC<TilingLayoutProps> = ({ tiles, onCloseTile, onSplitTile }) => {
  const [isResizing, setIsResizing] = useState(false)
  const [dragState, setDragState] = useState<{
    isDragging: boolean
    startX: number
    startY: number
    dividerIndex: number
    direction: 'horizontal' | 'vertical'
  } | null>(null)
  const layoutRef = useRef<HTMLDivElement>(null)

  const handleMouseDown = useCallback((e: React.MouseEvent, index: number, direction: 'horizontal' | 'vertical') => {
    e.preventDefault()
    setIsResizing(true)
    setDragState({
      isDragging: true,
      startX: e.clientX,
      startY: e.clientY,
      dividerIndex: index,
      direction
    })
  }, [])

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragState?.isDragging || !layoutRef.current) return

    const deltaX = e.clientX - dragState.startX
    const deltaY = e.clientY - dragState.startY
    
    // Apply the resize logic here based on direction and delta
    // This is a simplified version - you'd want more sophisticated grid management
    
  }, [dragState])

  const handleMouseUp = useCallback(() => {
    if (dragState?.isDragging) {
      setIsResizing(false)
      setDragState(null)
    }
  }, [dragState])

  React.useEffect(() => {
    if (dragState?.isDragging) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      
      return () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [dragState, handleMouseMove, handleMouseUp])

  if (tiles.length === 0) {
    return <div className="tiling-layout empty">No content to display</div>
  }

  if (tiles.length === 1) {
    const tile = tiles[0]
    return (
      <div className="tiling-layout single" ref={layoutRef}>
        <TileComponent 
          tile={tile}
          onClose={() => onCloseTile?.(tile.id)}
          onSplit={(direction) => onSplitTile?.(tile.id, direction)}
          isResizing={isResizing}
        />
      </div>
    )
  }

  // For multiple tiles, create a grid layout
  const gridCols = Math.ceil(Math.sqrt(tiles.length))
  const gridRows = Math.ceil(tiles.length / gridCols)

  return (
    <div 
      className="tiling-layout grid" 
      ref={layoutRef}
      style={{
        gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
        gridTemplateRows: `repeat(${gridRows}, 1fr)`
      }}
    >
      {tiles.map((tile, index) => (
        <React.Fragment key={tile.id}>
          <TileComponent 
            tile={tile}
            onClose={() => onCloseTile?.(tile.id)}
            onSplit={(direction) => onSplitTile?.(tile.id, direction)}
            isResizing={isResizing}
          />
          
          {/* Horizontal dividers */}
          {index % gridCols < gridCols - 1 && (
            <div 
              className="tile-divider horizontal"
              onMouseDown={(e) => handleMouseDown(e, index, 'vertical')}
            />
          )}
          
          {/* Vertical dividers */}
          {index < tiles.length - gridCols && (
            <div 
              className="tile-divider vertical"
              onMouseDown={(e) => handleMouseDown(e, index, 'horizontal')}
            />
          )}
        </React.Fragment>
      ))}
    </div>
  )
}

export default TilingLayout