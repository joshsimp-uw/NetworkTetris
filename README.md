# Networking Tetris — VLSM Block Boundary Visualizer

Networking Tetris is an interactive visualization tool for learning subnetting using the **4B (Block Boundary) Method**.

Instead of performing subnet math abstractly, the address space is represented as a **64-cell grid**, where each cell represents a fixed portion of the base network.

Subnets must be placed as **aligned contiguous blocks**, enforcing the natural boundaries required by VLSM.

## Features

- IPv4 and IPv6 CIDR support
- VLSM-aware subnet placement
- Boundary snapping
- Drag-and-drop subnet blocks
- Visual subnet boundaries
- Sortable allocation table
- Mobile-compatible interface

## Live Tool

https://joshsimp-uw.github.io/network-tetris.html

## Method

This tool demonstrates the **4B (Block Boundary) subnetting method**:

1. Represent the base network as a fixed block.
2. Divide the block into uniform visual units.
3. Place subnets as contiguous aligned blocks.
4. Enforce boundary alignment rules visually.

## License

MIT
