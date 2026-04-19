import "socket.io";

declare module "socket.io" {
  interface SocketData {
    roomCode?: string;
    /** Set while the socket is seated in a room (for per-viewer state). */
    playerId?: string;
  }
}

export {};
