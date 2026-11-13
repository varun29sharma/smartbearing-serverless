import { io, Socket } from 'socket.io-client';
import { SERVERLESS_MODE } from './serverless';

const API_URL = import.meta.env.VITE_API_URL || ''; // same-origin; Vite dev proxy forwards /socket.io to the backend

let socketInstance: Socket | null = null;
let socketToken: string | null = null;

// Serverless mode has no Socket.io server (Vercel functions are stateless),
// so getSocket() returns a no-op stub: every listener registration is a
// silent no-op and `connected` stays false. The live feeds poll the REST
// API instead — see useRealSensors / useLiveSensors / useHardwareStream.
const noopSocket = {
  connected: false,
  emit: () => {},
  on: () => {},
  off: () => {},
  disconnect: () => {},
} as unknown as Socket;

export const getSocket = (): Socket => {
  if (SERVERLESS_MODE) return noopSocket;
  const token = localStorage.getItem('token');
  if (!socketInstance || socketToken !== token) {
    socketInstance?.disconnect();
    socketToken = token;
    socketInstance = io(API_URL, {
      auth: {
        token
      },
      transports: ['websocket', 'polling']
    });
  }
  return socketInstance;
};

export const disconnectSocket = (): void => {
  if (socketInstance) {
    socketInstance.disconnect();
    socketInstance = null;
    socketToken = null;
  }
};
